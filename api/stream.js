import { getVideoDetails, isValidVideoId } from "../lib/youtube.js";

// Keep each proxied chunk <= 2 MB so it stays well under Vercel's 4.5 MB Serverless payload limit
// while allowing HTML5 <video> to stream arbitrarily long videos and seek smoothly via HTTP 206.
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = (req.query.id || "").toString().trim();
  const fid = (req.query.fid || "").toString().trim();
  const isDownload = req.query.download === "1";

  if (!isValidVideoId(id)) {
    return res.status(400).send("Invalid video ID");
  }

  try {
    const details = await getVideoDetails(id, {
      customPiped: req.query.piped ? String(req.query.piped) : "",
      customInvidious: req.query.invidious ? String(req.query.invidious) : ""
    });

    const chosen =
      details.formats.find((f) => f.id === fid) ||
      details.formats.find((f) => f.type === "video") ||
      details.formats[0];

    if (!chosen || !chosen.url) {
      return res.status(404).send("Stream format not found");
    }

    // Parse client Range header
    const rangeHeader = req.headers.range || "";
    let start = 0;
    let end = MAX_CHUNK_BYTES - 1;

    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      start = parseInt(match[1], 10);
      const requestedEnd = match[2] ? parseInt(match[2], 10) : start + MAX_CHUNK_BYTES - 1;
      end = Math.min(requestedEnd, start + MAX_CHUNK_BYTES - 1);
    }

    const upstreamRes = await fetch(chosen.url, {
      headers: {
        "User-Agent": chosen.ua || "Mozilla/5.0",
        "Range": `bytes=${start}-${end}`,
        "Accept": "*/*"
      }
    });

    if (!upstreamRes.ok && upstreamRes.status !== 206) {
      return res.status(upstreamRes.status).send("Upstream stream error");
    }

    const arrayBuf = await upstreamRes.arrayBuffer();
    const buf = Buffer.from(arrayBuf);

    const contentType =
      upstreamRes.headers.get("content-type") ||
      (chosen.mimeType ? chosen.mimeType.split(";")[0] : "video/mp4");
    const contentRange = upstreamRes.headers.get("content-range");

    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Cache-Control", "public, max-age=300");

    if (isDownload) {
      const ext = chosen.type === "audio" ? "m4a" : "mp4";
      res.setHeader("Content-Disposition", `attachment; filename="${id}.${ext}"`);
    }

    if (contentRange) {
      res.setHeader("Content-Range", contentRange);
      return res.status(206).send(buf);
    }

    return res.status(upstreamRes.status).send(buf);
  } catch (err) {
    return res.status(502).send(err.message || "Proxy stream failed");
  }
}
