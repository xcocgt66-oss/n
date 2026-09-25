# S-Power 1.4.0

Railway portal with an AI studio, remote browser service, session-based public/private messaging and a visible Windows host utility.

See REMOTE-AR.md for the new desktop host and UPDATE-AR.md for portal deployment steps. DEPLOY-AR.md covers the separate streaming browser.

## Layout

- server.js: Express, authentication, provider routes, streaming proxy and remote relay
- ai.js: provider catalog, selected models, accuracy policy and bounded retries
- chat.js: presence, private message authorization, persistence and 24-hour retention
- public/: UI, preferences, Markdown renderer, notifications and animated stickers
- desktop.js: authenticated enrollment, device leases and loopback-engine relay
- agent/: visible Windows bridge, pinned installer and launchers
- downloads/S-Power-Host.zip: authenticated host download, included in Docker
- browser/: separate Falkon/Selkies service
- test/: automated provider, chat and streaming tests

## Run

Node.js 22 or newer. Install with npm ci. Set SPOWER_PASSWORD, then npm start. The server binds to 0.0.0.0 and Railway's PORT. Use HTTPS in production; authentication cookies are Secure. A blank white screen is intentional. Press Y five times or tap the bottom-right corner three times to open login. Gestures are not a security boundary and frontend code is inspectable.

Use one server replica. Set DATA_DIR=/data with a Railway Volume for message persistence. Sessions last eight hours and remain in memory. Restarting ends login identities, private-message access, live device connections and push subscriptions. Messages expire after 24 hours; deletion runs every ten seconds. Public history survives restarts on a volume, while private history requires the same session identity. This is a small private workspace, not a multi-tenant account system.

AI history and images are stored in sessionStorage in the current browser tab, up to twenty conversations subject to browser storage limits. The server does not persist AI history. Providers receive the submitted history and image. Accuracy instructions cannot guarantee correctness. Gemini and NVIDIA trials remain subject to their provider limits. No API provider is made unlimited by this application.

Optional AI_DAILY_REQUEST_LIMIT defaults to 100 successful cloud requests per session per UTC day; 0 removes the portal cap. It is not a provider billing guard. Failed requests are refunded locally; retries can still consume provider quota. OpenRouter requests set prompt/completion maximum prices to zero. OpenAI remains optional and may incur charges.

Windows host: the new visible Python bridge uses Sunshine and Moonlight Web 2.10.0. Read REMOTE-AR.md or agent/README.txt before setup. Screen/audio/input hardware encoding comes from these engines. Sunshine runs as its official Windows service; the bridge remains visible and must stay open. UAC stays enabled. Windows 10 uses a pinned older compatibility release, Windows 11 a newer release. Actual GPU/audio/UAC behavior is not validated on Windows in this environment. Browser-reserved shortcuts, Ctrl+Alt+Del, pre-login access and zero latency are not guaranteed. No file transfer. Device credentials and engine keys are in the extracted host folder; never upload that configured folder. The portal remembers IDs, not passwords.

WebRTC attempts direct media. WebSocket fallback carries media through Railway and consumes relay bandwidth. NAT may require TURN. No unrestricted free relay is included. Old /agent and /remote screenshot transport endpoints have been removed. Existing legacy host utilities must be replaced with the new download.

Run npm test. Provider tests use mocked responses; they do not establish live account access. Docker and Windows runtime validation must be performed on the intended deployment.
