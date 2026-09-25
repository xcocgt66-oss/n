S-Power Host 2 / Portal 1.4.0

Windows 10 22H2 x64 or Windows 11 x64. Python 3.11+ with Tkinter and Python Launcher is required. Python 3.12 is a suitable choice. This ZIP contains a visible Python bridge and an installer helper, not a signed S-Power executable.

1. Extract this folder into a private folder on your Windows PC. Do not run it inside the ZIP.
2. Run Setup.cmd. It downloads fixed official Sunshine and Moonlight Web packages, checks SHA-256, and launches the Sunshine installer interactively. Approve the Windows installation prompt and keep the Sunshine Windows service enabled. Existing Sunshine installations are retained.
3. Open https://localhost:47990 ON THE HOST PC. Create the Sunshine administrator credentials. They are separate from the S-Power device password. Leave the encoder on Auto. Leave UAC and the secure desktop enabled.
4. In S-Power > Remote Access > Connect a new Windows PC, create a pairing code. It expires in 10 minutes and is used once.
5. Run Start-Host.cmd. Enter the HTTPS portal URL without a page path, the pairing code, and a new device password of 12-128 characters. Save the password in your password manager. Press Start access.
6. Enter the displayed Device ID and the same device password in the website. The website opens Moonlight Web already authenticated.
7. In Moonlight Web, add a host at 127.0.0.1. Use Pair and enter its displayed PIN in Sunshine's PIN page on the PC. This local engine pairing is needed once. Select Desktop to stream the existing Windows desktop.
8. In Moonlight settings choose H.264, 1080p, 60 FPS, 20000 Kbps, data transport Auto. Adjust bitrate to your connection; these values are a starting point, not a performance guarantee. Enable full screen and interact with the stream to allow audio and keyboard capture.

NEXT CONNECTIONS
Keep Start-Host.cmd / S-Power Host open. Choose your saved Device ID in the website and enter the device password. The PC does not ask for approval each time after setup. Stop access or closing the host window closes the relay and terminates this app's Moonlight process tree. The separately installed Sunshine service remains installed; its previously paired clients are managed in Sunshine.

WINDOWS 10 / 11
The helper selects Sunshine 2025.924.154138 for Windows 10 because that release documents Windows 10 support. This is an older compatibility build, not a promise of current upstream support or future security fixes. Windows 11 uses 2026.914.233613. Neither path has been run on physical Windows hardware in this development environment. The hashes are pinned in versions.json. Existing Sunshine is never silently downgraded.

GPU AND CAPTURE
Sunshine Auto selects a compatible encoder: NVIDIA NVENC, AMD AMF, Intel Quick Sync, or software if available. RTX 3070 Ti should use NVENC. This is not support for every card or driver ever made. Keep graphics drivers current and use an active display attached to the capture GPU. A disconnected monitor, headless output, HDR, display-driver resets and protected video can affect capture. This package does not install a virtual display driver.

UAC AND INPUT
The Sunshine service is the mechanism used for elevated windows and secure-desktop capture/input. Keep it running through the official service installation. Do not disable UAC to work around a black screen. Test a Run as administrator prompt on your PC after initial pairing. Browser/OS-reserved key combinations, Ctrl+Alt+Del, pre-login access, reboot recovery and DRM screens are not guaranteed. The visible bridge must be started after Windows login; this is not a pre-login management agent. Audio, keyboard layout and secure desktop require validation on your actual machine. File transfer is not included.

NETWORK
Railway carries authenticated signaling and web requests. WebRTC attempts a direct media path from your PC to the viewing device. Approve appropriate Windows Firewall access for the official Moonlight streamer if prompted; do not disable the firewall. Restrictive networks may need TURN configuration in vendor/moonlight/server/config.json or WebSocket transport. WebSocket fallback passes media through Railway, consumes its traffic quota, and usually has more latency. There is no guaranteed zero delay or unlimited free relay. Do not publish ports 8099 or 47990 to the internet.

PERSISTENCE AND CREDENTIALS
host-config.json stores the device identity secret and password hash, not the plaintext device password. vendor/moonlight/server stores engine accounts and pairing keys. Keep the whole extracted folder private; do not upload it to GitHub or share it. The portal needs DATA_DIR on a persistent volume to retain registrations. If a deployment loses its registry, create a new portal pairing code and enter it in the existing host app with the original device password used in the website. Do not change the device password by editing its hash: Moonlight has the original password too. For a complete reset, stop access, back up the folder, then start from a fresh extraction and re-pair. Remove obsolete pairings in Sunshine.

TROUBLESHOOTING
- Host engine could not start: inspect engine.log and verify Setup.cmd completed.
- Port 8099 in use: close the other host instance; do not run two copies.
- Host offline: check portal HTTPS URL, a fresh enrollment code for new registrations, and Start access status.
- No image/audio/UAC: inspect Sunshine logs and service status. This is different from portal authentication.
- Stream stalls on another network: try WebSocket transport; for consistently low latency configure an appropriate TURN relay or direct connectivity.
- No new Railway service is needed for this desktop host.

Official upstreams and pinned sources are in THIRD-PARTY.txt. This integration is an initial release. Automated relay/auth/UI checks pass, but end-to-end Windows GPU/audio/UAC validation is still required.
