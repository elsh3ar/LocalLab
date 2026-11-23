let sessionId = null;
let pendingRequest = null;
let activeStream = null;
let activeRecorder = null;
let pollTimer = null;

const $ = id => document.getElementById(id);
const metadata = {
  browser: navigator.userAgent,
  platform: navigator.platform || "Unknown",
  screen: `${screen.width}x${screen.height}`,
  language: navigator.language,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
};

for (const key of Object.keys(metadata)) $(key).textContent = metadata[key];

async function permissionState(name) {
  try {
    return (await navigator.permissions.query({ name })).state.toUpperCase();
  } catch {
    return "UNSUPPORTED";
  }
}

async function refreshPermissions() {
  $("cameraPermission").textContent = await permissionState("camera");
  $("micPermission").textContent = await permissionState("microphone");
  $("geoPermission").textContent = await permissionState("geolocation");
}

$("refreshPermissions").addEventListener("click", refreshPermissions);
refreshPermissions();

$("joinBtn").addEventListener("click", async () => {
  if (!$("consent").checked) {
    $("sessionStatus").textContent = "Please agree before joining.";
    return;
  }
  try {
    const response = await fetch("/api/session", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({...metadata, consent: true})
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "Could not create session");
    sessionId = data.session_id;
    $("sessionStatus").textContent = `Connected. Session ID: ${sessionId}`;
    $("stopBtn").disabled = false;
    startPolling();
  } catch (error) {
    $("sessionStatus").textContent = error.message;
  }
});

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!sessionId) return;
    try {
      await fetch("/api/heartbeat", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({session_id: sessionId})
      });
      const response = await fetch(`/api/commands/${encodeURIComponent(sessionId)}`);
      const data = await response.json();
      if (data.commands && data.commands.length) {
        // Show one request at a time; additional requests remain queued server-side only
        // after being fetched, so re-display remaining items locally.
        for (const command of data.commands) showRequest(command);
      }
    } catch {}
  }, 1800);
}

function showRequest(command) {
  if (pendingRequest) {
    $("requestBox").textContent = "A request is already waiting. Resolve it before another request.";
    return;
  }
  pendingRequest = command;
  const labels = {
    camera: "Camera preview",
    microphone: "5-second microphone test (saved locally)",
    screen: "5-second screen-share test (saved locally)",
    location: "Show your current location on this page"
  };
  $("requestBox").textContent = `Operator requested: ${labels[command.command] || command.command}. Nothing happens until you approve.`;
  $("approveBtn").disabled = false;
  $("rejectBtn").disabled = false;
}

async function report(action, status) {
  if (!sessionId) return;
  await fetch("/api/result", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({session_id: sessionId, action, status})
  });
}

$("approveBtn").addEventListener("click", async () => {
  if (!pendingRequest) return;
  const command = pendingRequest.command;
  pendingRequest = null;
  $("approveBtn").disabled = true;
  $("rejectBtn").disabled = true;
  try {
    if (command === "camera") await runCamera();
    if (command === "microphone") await runMicrophone();
    if (command === "screen") await runScreen();
    if (command === "location") await runLocation();
  } catch (error) {
    $("testStatus").textContent = `Test failed: ${error.message}`;
    await report(command, "failed or permission denied");
  }
  $("requestBox").textContent = "No pending requests.";
});

$("rejectBtn").addEventListener("click", async () => {
  if (!pendingRequest) return;
  const command = pendingRequest.command;
  pendingRequest = null;
  $("requestBox").textContent = "Request rejected.";
  $("approveBtn").disabled = true;
  $("rejectBtn").disabled = true;
  await report(command, "rejected by participant");
});

async function runCamera() {
  activeStream = await navigator.mediaDevices.getUserMedia({video: true, audio: false});
  $("preview").srcObject = activeStream;
  $("testStatus").textContent = "Camera preview is active locally. Press Stop active test when finished.";
  await report("camera", "approved; local preview active");
}

async function runMicrophone() {
  const stream = await navigator.mediaDevices.getUserMedia({audio: true});
  const recorder = new MediaRecorder(stream);
  activeRecorder = recorder;
  const chunks = [];
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  recorder.start();
  $("testStatus").textContent = "Recording audio for 5 seconds locally…";
  await new Promise(resolve => setTimeout(resolve, 5000));
  if (recorder.state !== "inactive") recorder.stop();
  await new Promise(resolve => { recorder.onstop = resolve; });
  stream.getTracks().forEach(track => track.stop());
  const blob = new Blob(chunks, {type: recorder.mimeType || "audio/webm"});
  downloadBlob(blob, "locallab-audio-test.webm");
  activeRecorder = null;
  $("testStatus").textContent = "Audio test saved on this device. It was not uploaded.";
  await report("microphone", "approved; local file created; not uploaded");
}

async function runScreen() {
  activeStream = await navigator.mediaDevices.getDisplayMedia({video: true, audio: false});
  const recorder = new MediaRecorder(activeStream);
  activeRecorder = recorder;
  const chunks = [];
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  recorder.start();
  $("testStatus").textContent = "Screen sharing is active. Recording for 5 seconds locally…";
  await new Promise(resolve => setTimeout(resolve, 5000));
  if (recorder.state !== "inactive") recorder.stop();
  await new Promise(resolve => { recorder.onstop = resolve; });
  activeStream.getTracks().forEach(track => track.stop());
  const blob = new Blob(chunks, {type: recorder.mimeType || "video/webm"});
  downloadBlob(blob, "locallab-screen-test.webm");
  activeStream = null;
  activeRecorder = null;
  $("testStatus").textContent = "Screen test saved on this device. It was not uploaded.";
  await report("screen", "approved; local file created; not uploaded");
}

async function runLocation() {
  const position = await new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {timeout: 10000});
  });
  // Coordinates are displayed locally only and deliberately not sent to the server.
  $("testStatus").textContent =
    `Location available locally: ${position.coords.latitude.toFixed(5)}, ${position.coords.longitude.toFixed(5)}. Not uploaded.`;
  await report("location", "approved; location displayed locally; coordinates not uploaded");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("stopBtn").addEventListener("click", async () => {
  if (activeRecorder && activeRecorder.state !== "inactive") activeRecorder.stop();
  if (activeStream) activeStream.getTracks().forEach(track => track.stop());
  activeStream = null;
  activeRecorder = null;
  $("preview").srcObject = null;
  $("testStatus").textContent = "Active local test stopped.";
  if (sessionId) {
    await fetch("/api/stop", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({session_id: sessionId})
    });
  }
  sessionId = null;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  $("stopBtn").disabled = true;
  $("approveBtn").disabled = true;
  $("rejectBtn").disabled = true;
  $("requestBox").textContent = "Session ended.";
});
