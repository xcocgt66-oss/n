export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    protocol: "HTTPS Only (Zero WebSockets)",
    runtime: "Vercel Serverless Node.js",
    timestamp: new Date().toISOString()
  });
}
