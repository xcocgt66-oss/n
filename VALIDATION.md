# Validation — S-Power 1.5.1

Current checks on Windows, 2026-10-01:

- npm test: AI catalog/provider mocked tests, chat privacy/retention, real HTTP chat endpoints and replay/receipt behavior, and authenticated desktop relay integration.
- Browser UI smoke with every WebSocket explicitly blocked: original white gate and login, AI rendering/history/errors, preferences, two-user private messaging, presence, host ZIP download, single-field SP2 connection flow, invalid-code rejection, preserved code on server failure, credential decoding and clearing after success, absent Browser tab, desktop/mobile layout.
- Windows x64 executable built with PyInstaller 6.16.0, bundled Python 3.11, aiohttp 3.13.3 and websockets 14.2. Hidden --self-test passed for Tkinter/runtime imports. No screen capture or remote connection is started by this test.

Not validated: live AI keys, Railway deployment/container build, the company network, Sunshine installation, real Windows video/audio/input/UAC streaming or end-to-end latency. Existing engine versions/hashes were retained from the input project; they were not re-downloaded or installed in this run. The host EXE is unsigned.
