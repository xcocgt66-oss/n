#!/usr/bin/env bash
# S-Power — one-shot setup for an Oracle Cloud "Always Free" Ubuntu VM.
# Usage (as the default 'ubuntu' user on the VM):
#     curl -fsSL https://raw.githubusercontent.com/xcocgt66-oss/n/main/scripts/oracle-setup.sh | bash
# Password gate opens with Y x5, then the password below (default 1010).
set -euo pipefail

PASSWORD="${SPOWER_PASSWORD:-1010}"
REPO="https://github.com/xcocgt66-oss/n"
APP_DIR="$HOME/s-power"

echo "== 1/5 System packages =="
sudo apt-get update -y
sudo apt-get install -y curl git ca-certificates

echo "== 2/5 Node.js 22 =="
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v//;s/\..*//')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "== 3/5 Get the code =="
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone --depth 1 "$REPO" "$APP_DIR"; fi
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund

echo "== 4/5 Run as a systemd service (auto-start, auto-restart) =="
sudo tee /etc/systemd/system/s-power.service >/dev/null <<UNIT
[Unit]
Description=S-Power
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=SPOWER_PASSWORD=$PASSWORD
Environment=PORT=3000
Environment=DATA_DIR=$APP_DIR/data
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=always
RestartSec=3
User=$(whoami)
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now s-power
sleep 2
curl -fsS http://127.0.0.1:3000/health >/dev/null && echo "   app is UP on :3000"

echo "== 5/5 Cloudflare Tunnel (free HTTPS, no domain, no open ports) =="
if ! command -v cloudflared >/dev/null 2>&1; then
  ARCH="$(dpkg --print-architecture)"   # arm64 or amd64
  curl -fsSL -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb"
  sudo dpkg -i /tmp/cloudflared.deb
fi

cat <<DONE

============================================================
 DONE. The app runs 24/7 as a service (SPOWER_PASSWORD=$PASSWORD).

 Get your HTTPS link now (quick tunnel, URL changes each run):
     cloudflared tunnel --url http://localhost:3000

 It prints  https://<something>.trycloudflare.com
 Open it  ->  press Y five times  ->  password: $PASSWORD  ->  Browser tab.

 For a PERMANENT link that survives reboots you need a domain on
 Cloudflare (named tunnel) or a domain pointed at this VM (Caddy).
 Ask me and I'll wire whichever you pick.
============================================================
DONE
