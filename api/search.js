import { searchVideos } from "../lib/youtube.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  const q = (req.query.q || "").toString().trim();
  if (!q) {
    return res.status(400).json({ error: "اكتب كلمة بحث أو رابط يوتيوب." });
  }

  try {
    const data = await searchVideos(q, {
      customPiped: req.query.piped ? String(req.query.piped) : "",
      customInvidious: req.query.invidious ? String(req.query.invidious) : ""
    });

    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message || "فشل البحث" });
  }
}
