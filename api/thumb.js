import { isValidVideoId } from "../lib/youtube.js";

const ALLOWED_QUALITIES = new Set([
  "default",
  "mqdefault",
  "hqdefault",
  "sddefault",
  "maxresdefault"
]);

export default async function handler(req, res) {
  const id = (req.query.id || "").toString().trim();
  const q = (req.query.q || "mqdefault").toString().trim();

  if (!isValidVideoId(id)) {
    return res.status(400).send("Invalid ID");
  }

  const quality = ALLOWED_QUALITIES.has(q) ? q : "mqdefault";
  const targetUrl = `https://i.ytimg.com/vi/${id}/${quality}.jpg`;

  try {
    const upstream = await fetch(targetUrl, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    if (!upstream.ok) {
      return res.status(404).send("Thumbnail not found");
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
    return res.status(200).send(buf);
  } catch {
    return res.status(502).send("Thumbnail fetch error");
  }
}
