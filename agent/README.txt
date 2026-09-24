S-Power Host for your own Windows computer

1. Install Python 3.11+ with Tkinter and the Python launcher from python.org.
2. Extract the entire ZIP into a folder. Open Start-Host.cmd.
3. Enter your portal HTTPS URL and choose a device password (12+ characters).
4. Press Start host. Copy Device ID into Remote Access in your portal and enter the password you chose.
5. Keep the host window open. Stop access or close the window to disconnect.

Setup installs the pinned Python packages in a local .venv folder. No administrator rights or inbound port opening are needed. The host reconnects to the configured portal while it is running. It does not install a hidden service or enable startup persistence.

Device identity and a salted password hash are saved in %APPDATA%\SPowerAgent\config.json. Protect this file: it contains the host registration secret. The chosen password is not stored as plain text. Change it by stopping the host, entering a new password and starting again.

The portal saves device ID and label, not your password. This version provides screen viewing, pointer dragging, clicking, scrolling and basic keyboard input. It does not provide audio, file transfer, Ctrl+Alt+Del, UAC secure desktop access or reliable non-Latin text input. It is not a native RDP replacement. Moving the host mouse to a screen corner triggers PyAutoGUI's safety stop.
