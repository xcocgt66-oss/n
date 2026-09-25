# Validation — S-Power 1.4.0

Validated in the Linux development environment on 2026-09-25:

- Node test suite: AI provider recovery and catalog rules with mocks, chat privacy/expiry/persistence, browser proxy authentication, desktop registration/passwords/lease isolation/HTTP and WebSocket relay/disconnect.
- Chromium UI checks: existing blank login, AI Markdown safety/history/timers/errors, settings, private-message tabs, authenticated host download and mobile layout.
- Real Moonlight Web 2.10.0 Linux binary: SHA-256 verified, first-user login and authenticated API, HTML/JS loading through the Python bridge.
- End-to-end UI integration: real Node portal + Python bridge + real Moonlight engine. Created a pairing code in the UI, registered a device, authenticated the embedded client, opened actual stream settings, checked CSP and mobile overflow, and disconnected.
- Official Windows Moonlight archive: SHA-256, executable layout and inline-script CSP hashes verified against the downloaded bytes.
- Python syntax compilation. PowerShell installer reviewed, not executed on Windows.

The browser integration harness uses loopback HTTP/WebSocket inside the test process. The production host requires HTTPS/WSS. No real user API keys, physical Windows host, Sunshine GPU capture, microphone/output devices, UAC desktop, external NAT/TURN path or Railway deployment were exercised. Real-time desktop latency and frame rate are not established by these tests.

Windows process lifetime control uses an owned Job Object with KILL_ON_JOB_CLOSE so the owned engine processes should terminate if the bridge exits. This Windows-only behavior is source-reviewed against Microsoft API documentation and still requires runtime verification on Windows.

Reproduce portal checks:

    npm ci
    npm test
    npx playwright install chromium
    node scripts/ui-smoke.mjs

With the verified Linux Moonlight package extracted and executable permissions set:

    python3 -m pip install -r agent/requirements.txt
    python3 scripts/engine-smoke.py /absolute/path/to/package
    node scripts/desktop-ui-smoke.mjs /absolute/path/to/package

The separate browser service and AI provider configuration were preserved from 1.3.0. This update does not establish that any provider quota is unlimited or that every selected model remains available to every key.
