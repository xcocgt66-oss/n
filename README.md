# S-Power 1.5.1

Railway portal with the existing AI studio, session-based messages and a visible Windows desktop host. The Browser feature and its server-side engines were removed at the owner's request. UI styles, the login gesture/password flow, and AI provider code are unchanged.

Node.js 22+: `npm ci`, set `SPOWER_PASSWORD`, then `npm start`. Production uses HTTPS and Secure cookies. The white gate still opens with five Y presses or three taps in the bottom-right corner.

Use one replica and a persistent Railway volume: `DATA_DIR=/data`. Sessions stay in memory for eight hours; a server restart requires login again and changes private-chat identity. Public messages and device registrations persist on the volume. Messages expire after 24 hours. AI keys and provider requests remain on Railway. AI history stays in the browser tab. Existing provider limits and AI_DAILY_REQUEST_LIMIT are unchanged.

Chat uses short authenticated same-origin HTTPS POST requests, polling every 1.5 seconds. It does not need WebSocket, SSE, UDP, third-party assets or external browser API calls. Unacknowledged events replay, retries use receipt IDs, and failed sends preserve the draft. Inactive tabs expire after 90 seconds and reconnect with history. Up to eight active chat tabs per login. The legacy authenticated /ws transport remains compatible.

Remote Access runs Sunshine capture/encoding and Moonlight Web on the Windows PC. Railway forwards authenticated requests; relayed media still consumes network traffic and bounded buffers. downloads/S-Power-Host.zip includes a built Windows x64 EXE with Python/Tkinter bundled, source, installer helpers and notices. Sunshine/Moonlight are separately installed using Setup.cmd. Read REMOTE-AR.md. The EXE is unsigned. Remote Access has one Connection code field and a Connect button. Paste the full private SP2 code; credentials are decoded internally. First-time registration is in a collapsed setup section. No remote-access connection code is saved in browser storage.

A site's domain or remote-control protocols can still be blocked by a managed network. Chat's HTTPS transport does not override company policy. Remote Access still requires allowed WSS and WebRTC or the engine's WebSocket media transport. No public proxy or firewall bypass is included.

Run `npm test`. For browser checks run `node scripts/ui-smoke.mjs`; PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH may point to an installed Chromium/Edge executable. That check deliberately blocks every WebSocket. Build the downloadable host with scripts/build-host.ps1. See VALIDATION.md for verified behavior and remaining hardware/deployment checks.
