S-Power Host 1.5.0 — Windows x64

Extract the ZIP first. Run Setup.cmd to install the pinned Sunshine/Moonlight engines, then S-Power-Host.exe or Start-Host.cmd. The EXE bundles Python and Tkinter; no Python installation is needed. It is unsigned.

Configure Sunshine at https://localhost:47990 on this PC. In the portal's Remote Access section create a pairing code. Enter the portal HTTPS origin and that pairing code in the host. Choose a device password (12-128 characters), or leave it blank on FIRST setup to generate one securely. Start access and copy the connection code. Save this private code and paste it into Device ID in the portal. Click Connect.

In Moonlight add 127.0.0.1, pair its PIN through Sunshine once, then open Desktop. Capture, encoding, audio and input run on this PC. Railway relays authenticated traffic; WebSocket media consumes Railway bandwidth. Restricted corporate networks must permit remote control, WSS and the selected media transport. HTTPS-only chat does not make the desktop stream firewall-proof.

Next time, start this app and use your saved connection code in the portal. The full code/password is not saved on disk by this app. To copy it again, enter the original device password before starting access. Existing Device ID + password connections still work. Keep the window open. Stop access ends this portal's session and Moonlight process tree. Sunshine remains an independently installed service.

Keep UAC enabled and use Sunshine Auto encoding. GPU, active display, audio and secure-desktop behavior require hardware validation. No file transfer, pre-login agent, guaranteed reserved shortcuts or unrestricted connectivity. Windows 10 uses the pinned compatibility build; Windows 11 the version in versions.json. Do not expose 8099 or 47990 publicly.

Keep this folder private: host-config.json and vendor/moonlight/server contain device identity and pairing secrets. Do not upload the configured folder. The portal needs persistent DATA_DIR storage. Third-party details are in THIRD-PARTY.txt and licenses/. Arabic setup instructions are in REMOTE-AR.md.
