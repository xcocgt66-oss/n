import { getVideoDetails, isValidVideoId } from "../lib/youtube.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = (req.query.id || "").toString().trim();
  if (!isValidVideoId(id)) {
    return res.status(400).json({ error: "معرّف الفيديو غير صحيح" });
  }

  try {
    const details = await getVideoDetails(id, {
      customPiped: req.query.piped ? String(req.query.piped) : "",
      customInvidious: req.query.invidious ? String(req.query.invidious) : ""
    });

    // Return sanitized metadata + proxied format links (never exposing raw googlevideo URLs to client)
    const safeFormats = details.formats.map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type,
      mimeType: f.mimeType,
      proxyUrl: `/api/stream?id=${encodeURIComponent(id)}&fid=${encodeURIComponent(f.id)}`
    }));

    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=240");
    return res.status(200).json({
      id: details.id,
      title: details.title,
      author: details.author,
      description: details.description,
      duration: details.duration,
      views: details.views,
      published: details.published,
      source: details.source,
      thumbnail: `/api/thumb?id=${details.id}&q=hqdefault`,
      formats: safeFormats,
      related: details.related || []
    });
  } catch (err) {
    return res.status(502).json({ error: err.message || "تعذر تشغيل الفيديو" });
  }
}
