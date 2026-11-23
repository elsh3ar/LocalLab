import json, os, secrets, threading, time
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
(ROOT / "logs").mkdir(exist_ok=True)

BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
CHAT_ID = os.getenv("CHAT_ID", "").strip()
app = Flask(__name__, static_folder="static", template_folder="templates")

# In-memory session/command store for a small local lab. Use a database for production.
SESSIONS = {}
LOCK = threading.Lock()
ALLOWED_COMMANDS = {"camera", "microphone", "screen", "location", "stop"}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def telegram_send(text, reply_markup=None):
    if not BOT_TOKEN or not CHAT_ID:
        app.logger.warning("Telegram is not configured; skipping notification.")
        return False
    payload = {"chat_id": CHAT_ID, "text": text}
    if reply_markup:
        payload["reply_markup"] = reply_markup
    try:
        response = requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            json=payload, timeout=10
        )
        response.raise_for_status()
        return bool(response.json().get("ok"))
    except requests.RequestException:
        app.logger.exception("Telegram send failed")
        return False


def save_event(event):
    with (ROOT / "logs" / "events.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")


def enqueue_command(session_id, command):
    if command not in ALLOWED_COMMANDS:
        return False
    with LOCK:
        session = SESSIONS.get(session_id)
        if not session or not session.get("active"):
            return False
        session["commands"].append({"id": secrets.token_urlsafe(8), "command": command, "created_at": now()})
    return True


@app.get("/")
def home():
    return render_template("index.html")


@app.get("/health")
def health():
    return jsonify(ok=True, service="LocalLab", time=now())


@app.post("/api/session")
def create_session():
    data = request.get_json(silent=True) or {}
    if data.get("consent") is not True:
        return jsonify(ok=False, error="Explicit session consent is required"), 400

    session_id = secrets.token_urlsafe(6)
    record = {
        "session_id": session_id,
        "created_at": now(),
        "browser": str(data.get("browser", ""))[:300],
        "platform": str(data.get("platform", ""))[:100],
        "language": str(data.get("language", ""))[:30],
        "timezone": str(data.get("timezone", ""))[:60],
        "screen": str(data.get("screen", ""))[:40],
        "active": True,
        "commands": [],
        "last_seen": now()
    }
    with LOCK:
        SESSIONS[session_id] = record
    save_event({"type": "session_created", **{k: v for k, v in record.items() if k != "commands"}})
    telegram_send(
        "🧪 LocalLab: new consented session\n"
        f"ID: {session_id}\nBrowser: {record['browser']}\n"
        f"Platform: {record['platform']}\nScreen: {record['screen']}\n"
        f"Time: {record['created_at']}\n\n"
        "Tests require the participant to approve each request on the webpage.\n"
        f"Commands: /camera {session_id}, /microphone {session_id}, "
        f"/screen {session_id}, /location {session_id}, /stop {session_id}"
    )
    return jsonify(ok=True, session_id=session_id)


@app.post("/api/heartbeat")
def heartbeat():
    data = request.get_json(silent=True) or {}
    sid = str(data.get("session_id", ""))
    with LOCK:
        session = SESSIONS.get(sid)
        if not session or not session["active"]:
            return jsonify(ok=False), 404
        session["last_seen"] = now()
    return jsonify(ok=True)


@app.get("/api/commands/<session_id>")
def get_commands(session_id):
    with LOCK:
        session = SESSIONS.get(session_id)
        if not session or not session["active"]:
            return jsonify(ok=False, commands=[]), 404
        commands = list(session["commands"])
        session["commands"].clear()
    return jsonify(ok=True, commands=commands)


@app.post("/api/result")
def result():
    data = request.get_json(silent=True) or {}
    sid = str(data.get("session_id", ""))
    action = str(data.get("action", ""))[:30]
    status = str(data.get("status", ""))[:50]
    # Do not accept or store media blobs, coordinates, passwords, or OTPs.
    event = {"type": "test_result", "session_id": sid, "action": action,
             "status": status, "time": now()}
    save_event(event)
    telegram_send(f"LocalLab test result\nSession: {sid}\nAction: {action}\nStatus: {status}")
    return jsonify(ok=True)


@app.post("/api/stop")
def stop_session():
    data = request.get_json(silent=True) or {}
    sid = str(data.get("session_id", ""))
    with LOCK:
        session = SESSIONS.get(sid)
        if session:
            session["active"] = False
            session["commands"].clear()
    save_event({"type": "session_stopped", "session_id": sid, "time": now()})
    telegram_send(f"LocalLab session stopped: {sid}")
    return jsonify(ok=True)


def telegram_polling():
    """Minimal Telegram long-poll command handler; only configured chat can control sessions."""
    if not BOT_TOKEN or not CHAT_ID:
        app.logger.warning("Set BOT_TOKEN and CHAT_ID in .env to enable Telegram.")
        return
    offset = 0
    while True:
        try:
            response = requests.get(
                f"https://api.telegram.org/bot{BOT_TOKEN}/getUpdates",
                params={"timeout": 25, "offset": offset}, timeout=30
            )
            response.raise_for_status()
            for update in response.json().get("result", []):
                offset = update["update_id"] + 1
                message = update.get("message", {})
                chat_id = str(message.get("chat", {}).get("id", ""))
                if chat_id != CHAT_ID:
                    continue
                parts = (message.get("text") or "").strip().split()
                if not parts:
                    continue
                command = parts[0].lower().split("@")[0]
                if command == "/sessions":
                    with LOCK:
                        active = [s for s in SESSIONS.values() if s["active"]]
                    summary = "\n".join(
                        f"{s['session_id']} — {s['browser']} — last seen {s['last_seen']}"
                        for s in active
                    ) or "No active sessions."
                    telegram_send("Active sessions:\n" + summary)
                elif command in {"/camera", "/microphone", "/screen", "/location", "/stop"} and len(parts) == 2:
                    action = command[1:]
                    sid = parts[1]
                    if action == "stop":
                        with LOCK:
                            session = SESSIONS.get(sid)
                            if session:
                                session["active"] = False
                                session["commands"].clear()
                        telegram_send(f"Stopped session {sid}" if session else "Unknown session.")
                    else:
                        ok = enqueue_command(sid, action)
                        telegram_send(
                            f"Request queued: {action} for {sid}.\n"
                            "The webpage will show a request; the participant must click Approve."
                            if ok else "Unknown or inactive session."
                        )
                elif command == "/help":
                    telegram_send(
                        "Commands:\n/sessions\n/camera SESSION_ID\n/microphone SESSION_ID\n"
                        "/screen SESSION_ID\n/location SESSION_ID\n/stop SESSION_ID\n/help\n\n"
                        "Every test requires an explicit approval click on the webpage."
                    )
        except Exception:
            app.logger.exception("Telegram polling error")
            time.sleep(3)


if __name__ == "__main__":
    if BOT_TOKEN and CHAT_ID:
        threading.Thread(target=telegram_polling, daemon=True).start()
    app.run(host="127.0.0.1", port=5000, debug=False)
