LocalLab — consent-based remote browser test lab
================================================

WHAT THIS DOES
- Hosts a browser test page.
- Creates a session only after the participant checks the consent box.
- Sends basic session metadata to your configured Telegram chat.
- Telegram commands can request a test for a session.
- The webpage shows each request; the participant must click Approve or Reject.
- Camera preview stays in the browser.
- Microphone and screen test files are downloaded locally to the participant's device.
- Location coordinates are displayed locally only.
- No media, location coordinates, passwords, or OTPs are uploaded.

SETUP (Windows / PowerShell)
1. Extract this folder.
2. Open it in VS Code.
3. Create a virtual environment (recommended):
   py -m venv .venv
   .venv\Scripts\activate
4. Install:
   py -m pip install -r requirements.txt
5. Copy .env.example to .env.
6. Edit .env locally and set BOT_TOKEN and CHAT_ID.
   Never paste your bot token into chat or commit .env to GitHub.
7. Run:
   py app.py
8. Open:
   http://127.0.0.1:5000

TELEGRAM COMMANDS
/sessions
/help
/camera SESSION_ID
/microphone SESSION_ID
/screen SESSION_ID
/location SESSION_ID
/stop SESSION_ID

IMPORTANT
- The bot accepts commands only from CHAT_ID in .env.
- The webpage must be open and joined to a session.
- Every requested test requires an explicit approval click on the webpage.
- Camera/microphone/screen APIs require HTTPS on public sites (localhost is treated as secure).
- For a public HTTPS deployment, use a reputable hosting provider and configure HTTPS.
- This starter stores active sessions in memory; restarting Flask clears them.
  It is for a small lab, not production use.
- For a real deployment, add authentication, HTTPS, rate limiting, persistent storage,
  CSRF protections, access controls, and a clear privacy notice.
