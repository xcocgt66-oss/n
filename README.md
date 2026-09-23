# S-Power

Private Railway portal with a blank entry screen, server-side password check, screenshot browser, chat and optional Web Push, plus a Windows remote access agent.

## Repository layout

```
s-power/
  Dockerfile
  .dockerignore
  .env.example
  .gitignore
  package.json
  server.js
  ai.js
  public/
    index.html
    style.css
    app.js
    sw.js
  agent/
    agent.py
    requirements.txt
```

## Railway

1. Push the files inside `s-power` to the root of a GitHub repository. Railway detects the Dockerfile and binds the server to its injected `PORT` on `0.0.0.0`.
2. Set `SPOWER_PASSWORD` to your portal password and `SESSION_SECRET` to a random string of at least 32 characters. If you specifically need the requested demo PIN, enter `1010` as the Railway `SPOWER_PASSWORD` variable. A long unique password is strongly recommended. Never commit an `.env` file.
3. Set `ALLOWED_BROWSER_HOSTS` to comma-separated trusted HTTPS domains. Each embedded page, image, and CDN domain must be listed separately. Only approved domains can be loaded in the screenshot browser.
4. For push alerts, generate VAPID keys with `npx web-push generate-vapid-keys` and set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (for example `mailto:admin@example.com`).
5. Attach a Railway public domain. Press Y five times in sequence or tap the lower-right corner rapidly three times to show the portal login.

## Windows agent installation

1. On a Windows PC that you own or administer, install Python 3.11 or newer and ensure the PC has outbound WSS access to your Railway domain.
2. Copy the `agent` directory to the PC. In PowerShell from that directory run `py -m pip install -r requirements.txt`, then `py agent.py`.
3. On first run enter the portal's HTTPS URL and choose a unique device password of at least 12 characters. The agent prints its device code and stores its configuration in `%APPDATA%\SPowerAgent\config.json`.
4. Keep its console window running. To have it start after you sign in to Windows, create a Windows Task Scheduler task for `py` with the full path to `agent.py` as argument, running under your own user account with an interactive desktop. This setup is an explicit owner action. Close the agent window or stop the task to end remote availability.
5. In the portal open `remote access rdp`, type the device code and device password, then click Connect. After the one-time local installation, no approval dialog appears on each connection. Only one controller can connect at a time.

The agent communicates outbound over WSS; it does not need an inbound port on the PC. It transmits a compressed screen approximately every 600 ms and receives mouse clicks, scrolling, and key presses. This is a custom remote desktop agent, not the Windows RDP protocol. It does not implement audio, clipboard, file transfer, multi-monitor selection, UAC secure-desktop interaction, or full-motion video. Windows must be signed in on an interactive desktop for input capture to work. The agent must remain visible and running on the authorized PC.

## Operational limits

Remote screenshots use substantial bandwidth. The browser engine also sends screenshots rather than site audio or smooth video. Some external websites require more CDN domains or reject automation. The ad filter can block approved known ad hosts, but is not a complete blocker. Chat, sessions, device connections, and push subscriptions are in process memory; a redeploy disconnects everyone. Run one replica; add a durable database and pub/sub before scaling. The hidden gesture is a UI choice, not a security boundary. Use strong portal and device passwords. Browser scripts and gestures can always be inspected by someone with DevTools; only the server checks the portal password.

## AI chat, photos, and usage

The **AI** tab supports normal conversation, pasted images with Ctrl+V, image uploads on mobile, and questions about the image. The browser compresses the image before sending it; accepted file types are PNG, JPEG, and WebP. Images are sent to the selected model. The server does not persist AI conversations or images.

- `gemini-3.8-flash`: set `GEMINI_API_KEY` in Railway.
- `gemini-3.1-pro-preview`: uses the same Gemini API key; your provider account must have access.
- `gpt-5.6-sol`: set `OPENAI_API_KEY` in Railway. ChatGPT Plus does not supply API credits for this key.
- `qwen3-vl:32b`: local text and image model. Install Ollama on the authorized Windows PC, run `ollama pull qwen3-vl:32b`, then run the updated Windows agent. In the AI tab select this model and enter the device code and its password. The agent calls Ollama on `127.0.0.1:11434` and forwards the answer through the existing outbound WSS connection. Do not publish Ollama's port. The model download is approximately 21 GB; inference needs enough memory and will be slow on modest PCs. Ollama 0.12.7 or newer is required.

Local inference has no provider-side daily request quota, but available hardware, electricity, and internet bandwidth still constrain usage. Gemini and OpenAI set their own rate limits, quotas, and charges; the portal cannot make their paid models unlimited. Optional `AI_DAILY_REQUEST_LIMIT` defaults to 100 cloud requests per portal session in UTC days; `0` disables the portal cap. It never limits the local model. This cap is in process memory and is not a provider quota or billing guard. For public deployment, use a proper user account system and billing limits at each provider.
