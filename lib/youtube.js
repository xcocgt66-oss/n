// Shared YouTube Engine: Direct Innertube + Piped/Invidious Fallbacks (Pure HTTPS, Zero Dependencies)

const DEFAULT_PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://api.piped.yt",
  "https://pipedapi.leptons.xyz",
  "https://pipedapi.darkness.services"
];

const DEFAULT_INVIDIOUS_INSTANCES = [
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://yewtu.be",
  "https://iv.datura.network"
];

const UA_WEB =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const UA_IOS =
  "com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)";

const UA_ANDROID =
  "com.google.android.youtube/19.29.37 (Linux; U; Android 14) gzip";

// In-memory TTL cache (persists across warm Vercel lambda invocations)
const streamCache = new Map();
const STREAM_TTL_MS = 12 * 60 * 1000; // 12 minutes

export function isValidVideoId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{11}$/.test(id);
}

export function extractVideoId(input) {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  if (isValidVideoId(trimmed)) return trimmed;
  try {
    const u = new URL(trimmed);
    if (u.hostname.includes("youtu.be")) {
      const seg = u.pathname.replace("/", "").split("/")[0];
      return isValidVideoId(seg) ? seg : null;
    }
    if (u.searchParams.get("v") && isValidVideoId(u.searchParams.get("v"))) {
      return u.searchParams.get("v");
    }
    const shortsMatch = u.pathname.match(/\/(shorts|embed|live)\/([a-zA-Z0-9_-]{11})/);
    if (shortsMatch) return shortsMatch[2];
  } catch {
    // Not a URL
  }
  return null;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function getText(obj) {
  if (!obj) return "";
  if (typeof obj === "string") return obj;
  if (obj.simpleText) return obj.simpleText;
  if (Array.isArray(obj.runs)) return obj.runs.map((r) => r.text || "").join("");
  return "";
}

function collectRenderers(node, targetKey, results = []) {
  if (!node || typeof node !== "object") return results;
  if (Array.isArray(node)) {
    for (const item of node) collectRenderers(item, targetKey, results);
    return results;
  }
  if (node[targetKey]) {
    results.push(node[targetKey]);
  }
  for (const key of Object.keys(node)) {
    if (key !== targetKey) {
      collectRenderers(node[key], targetKey, results);
    }
  }
  return results;
}

function formatDurationSeconds(sec) {
  const total = Number(sec);
  if (!Number.isFinite(total) || total <= 0) return "";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function normalizeVideoItem(item) {
  if (!item || !isValidVideoId(item.id)) return null;
  return {
    id: item.id,
    title: item.title || "فيديو بدون عنوان",
    author: item.author || "قناة يوتيوب",
    duration: item.duration || "",
    views: item.views || "",
    published: item.published || "",
    thumbnail: `/api/thumb?id=${item.id}&q=mqdefault`
  };
}

// ======================================================
// 1. SEARCH (Direct Innertube -> Piped -> Invidious)
// ======================================================
async function searchInnertube(query) {
  const res = await fetchWithTimeout(
    "https://www.youtube.com/youtubei/v1/search?prettyPrint=false",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA_WEB,
        "Accept-Language": "ar,en;q=0.9"
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "WEB",
            clientVersion: "2.20240826.01.00",
            hl: "ar",
            gl: "SA"
          }
        },
        query
      })
    },
    6500
  );
  if (!res.ok) throw new Error(`Innertube search HTTP ${res.status}`);
  const data = await res.json();
  const renderers = collectRenderers(data, "videoRenderer");
  const seen = new Set();
  const items = [];
  for (const r of renderers) {
    const id = r.videoId;
    if (!isValidVideoId(id) || seen.has(id)) continue;
    seen.add(id);
    items.push(
      normalizeVideoItem({
        id,
        title: getText(r.title),
        author: getText(r.ownerText) || getText(r.longBylineText),
        duration: getText(r.lengthText) || "مباشر",
        views: getText(r.shortViewCountText) || getText(r.viewCountText),
        published: getText(r.publishedTimeText)
      })
    );
    if (items.length >= 24) break;
  }
  return items.filter(Boolean);
}

async function searchPiped(query, customInstance) {
  const list = customInstance
    ? [customInstance, ...DEFAULT_PIPED_INSTANCES]
    : process.env.CUSTOM_PIPED_API
      ? [process.env.CUSTOM_PIPED_API, ...DEFAULT_PIPED_INSTANCES]
      : DEFAULT_PIPED_INSTANCES;

  for (const base of list) {
    try {
      const cleanBase = base.replace(/\/+$/, "");
      const res = await fetchWithTimeout(
        `${cleanBase}/search?q=${encodeURIComponent(query)}&filter=videos`,
        { headers: { "User-Agent": UA_WEB } },
        4500
      );
      if (!res.ok) continue;
      const data = await res.json();
      const rawItems = Array.isArray(data.items) ? data.items : [];
      const items = rawItems
        .map((it) => {
          const id = extractVideoId(
            it.url ? `https://youtube.com${it.url}` : it.id
          );
          return normalizeVideoItem({
            id,
            title: it.title,
            author: it.uploaderName,
            duration: formatDurationSeconds(it.duration),
            views: it.views ? `${Number(it.views).toLocaleString("en-US")} مشاهدة` : "",
            published: it.uploadedDate || ""
          });
        })
        .filter(Boolean);
      if (items.length > 0) return { items, source: cleanBase };
    } catch {
      // try next instance
    }
  }
  return null;
}

async function searchInvidious(query, customInstance) {
  const list = customInstance
    ? [customInstance, ...DEFAULT_INVIDIOUS_INSTANCES]
    : process.env.CUSTOM_INVIDIOUS_API
      ? [process.env.CUSTOM_INVIDIOUS_API, ...DEFAULT_INVIDIOUS_INSTANCES]
      : DEFAULT_INVIDIOUS_INSTANCES;

  for (const base of list) {
    try {
      const cleanBase = base.replace(/\/+$/, "");
      const res = await fetchWithTimeout(
        `${cleanBase}/api/v1/search?q=${encodeURIComponent(query)}&type=video`,
        { headers: { "User-Agent": UA_WEB } },
        4500
      );
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data)) continue;
      const items = data
        .map((it) =>
          normalizeVideoItem({
            id: it.videoId,
            title: it.title,
            author: it.author,
            duration: formatDurationSeconds(it.lengthSeconds),
            views: it.viewCountText || "",
            published: it.publishedText || ""
          })
        )
        .filter(Boolean);
      if (items.length > 0) return { items, source: cleanBase };
    } catch {
      // try next
    }
  }
  return null;
}

export async function searchVideos(query, options = {}) {
  // If user pasted a direct YouTube link or ID, return it immediately
  const directId = extractVideoId(query);
  if (directId) {
    try {
      const info = await getVideoDetails(directId, options);
      return {
        source: info.source || "direct",
        items: [
          normalizeVideoItem({
            id: directId,
            title: info.title,
            author: info.author,
            duration: info.duration,
            views: info.views,
            published: info.published
          })
        ].filter(Boolean)
      };
    } catch {
      return {
        source: "direct-id",
        items: [normalizeVideoItem({ id: directId, title: `فيديو يوتيوب (${directId})` })]
      };
    }
  }

  try {
    const items = await searchInnertube(query);
    if (items.length > 0) return { items, source: "youtube-innertube" };
  } catch {
    // fallback below
  }

  const piped = await searchPiped(query, options.customPiped);
  if (piped) return piped;

  const inv = await searchInvidious(query, options.customInvidious);
  if (inv) return inv;

  throw new Error("تعذر جلب نتائج البحث حالياً. جرب إضافة سيرفر Piped أو Invidious في الإعدادات.");
}

// ======================================================
// 2. VIDEO DETAILS & STREAMS (Multi-Client + Fallbacks)
// ======================================================
async function fetchInnertubePlayer(videoId, clientType) {
  const clients = {
    IOS: {
      ua: UA_IOS,
      body: {
        videoId,
        context: {
          client: {
            clientName: "IOS",
            clientVersion: "19.29.1",
            deviceModel: "iPhone16,2",
            hl: "ar",
            gl: "SA"
          }
        },
        contentCheckOk: true,
        racyCheckOk: true
      }
    },
    ANDROID: {
      ua: UA_ANDROID,
      body: {
        videoId,
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: "19.29.37",
            androidSdkVersion: 34,
            hl: "ar",
            gl: "SA"
          }
        },
        contentCheckOk: true,
        racyCheckOk: true
      }
    },
    TV_EMBED: {
      ua: UA_WEB,
      body: {
        videoId,
        context: {
          client: {
            clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
            clientVersion: "2.0",
            hl: "ar",
            gl: "SA"
          },
          thirdParty: {
            embedUrl: "https://www.youtube.com/"
          }
        },
        contentCheckOk: true,
        racyCheckOk: true
      }
    }
  };

  const cfg = clients[clientType];
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": cfg.ua
  };
  if (process.env.YT_COOKIE) {
    headers["Cookie"] = process.env.YT_COOKIE;
  }

  const res = await fetchWithTimeout(
    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
    {
      method: "POST",
      headers,
      body: JSON.stringify(cfg.body)
    },
    5500
  );
  if (!res.ok) return null;
  const data = await res.json();
  if (data?.playabilityStatus?.status !== "OK") return null;

  const formats = [];
  const rawFormats = data?.streamingData?.formats || [];
  const rawAdaptive = data?.streamingData?.adaptiveFormats || [];

  for (const f of rawFormats) {
    if (!f.url) continue;
    formats.push({
      id: `yt-${f.itag}`,
      label: f.qualityLabel || `${f.height || 360}p`,
      mimeType: f.mimeType || "video/mp4",
      type: "video",
      url: f.url,
      ua: cfg.ua
    });
  }

  // Add best direct audio stream (m4a/mp4 or webm)
  const audioCandidates = rawAdaptive
    .filter((f) => f.url && f.mimeType && f.mimeType.startsWith("audio/"))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  if (audioCandidates.length > 0) {
    const bestAudio =
      audioCandidates.find((a) => a.mimeType.includes("mp4")) || audioCandidates[0];
    formats.push({
      id: `yt-audio-${bestAudio.itag}`,
      label: "صوت فقط",
      mimeType: bestAudio.mimeType,
      type: "audio",
      url: bestAudio.url,
      ua: cfg.ua
    });
  }

  if (formats.length === 0) return null;

  const details = data.videoDetails || {};
  return {
    id: videoId,
    title: details.title || "فيديو يوتيوب",
    author: details.author || "",
    description: details.shortDescription || "",
    duration: formatDurationSeconds(details.lengthSeconds),
    views: details.viewCount
      ? `${Number(details.viewCount).toLocaleString("en-US")} مشاهدة`
      : "",
    published: "",
    source: `innertube-${clientType.toLowerCase()}`,
    formats,
    related: []
  };
}

async function fetchPipedVideo(videoId, customInstance) {
  const list = customInstance
    ? [customInstance, ...DEFAULT_PIPED_INSTANCES]
    : process.env.CUSTOM_PIPED_API
      ? [process.env.CUSTOM_PIPED_API, ...DEFAULT_PIPED_INSTANCES]
      : DEFAULT_PIPED_INSTANCES;

  for (const base of list) {
    try {
      const cleanBase = base.replace(/\/+$/, "");
      const res = await fetchWithTimeout(
        `${cleanBase}/streams/${videoId}`,
        { headers: { "User-Agent": UA_WEB } },
        4500
      );
      if (!res.ok) continue;
      const data = await res.json();
      const formats = [];

      const muxed = (data.videoStreams || []).filter((s) => !s.videoOnly && s.url);
      for (let i = 0; i < muxed.length; i++) {
        const s = muxed[i];
        formats.push({
          id: `piped-v-${i}`,
          label: s.quality || "360p",
          mimeType: s.mimeType || "video/mp4",
          type: "video",
          url: s.url,
          ua: UA_WEB
        });
      }

      const audioList = (data.audioStreams || [])
        .filter((a) => a.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (audioList.length > 0) {
        const best = audioList.find((a) => (a.mimeType || "").includes("mp4")) || audioList[0];
        formats.push({
          id: "piped-audio",
          label: "صوت فقط",
          mimeType: best.mimeType || "audio/mp4",
          type: "audio",
          url: best.url,
          ua: UA_WEB
        });
      }

      if (formats.length === 0) continue;

      const related = (data.relatedStreams || [])
        .map((r) => {
          const rid = extractVideoId(r.url ? `https://youtube.com${r.url}` : r.id);
          return normalizeVideoItem({
            id: rid,
            title: r.title,
            author: r.uploaderName,
            duration: formatDurationSeconds(r.duration),
            views: r.views ? `${Number(r.views).toLocaleString("en-US")} مشاهدة` : "",
            published: r.uploadedDate || ""
          });
        })
        .filter(Boolean)
        .slice(0, 12);

      return {
        id: videoId,
        title: data.title || "فيديو يوتيوب",
        author: data.uploader || "",
        description: data.description || "",
        duration: formatDurationSeconds(data.duration),
        views: data.views ? `${Number(data.views).toLocaleString("en-US")} مشاهدة` : "",
        published: data.uploadDate || "",
        source: cleanBase,
        formats,
        related
      };
    } catch {
      // next instance
    }
  }
  return null;
}

async function fetchInvidiousVideo(videoId, customInstance) {
  const list = customInstance
    ? [customInstance, ...DEFAULT_INVIDIOUS_INSTANCES]
    : process.env.CUSTOM_INVIDIOUS_API
      ? [process.env.CUSTOM_INVIDIOUS_API, ...DEFAULT_INVIDIOUS_INSTANCES]
      : DEFAULT_INVIDIOUS_INSTANCES;

  for (const base of list) {
    try {
      const cleanBase = base.replace(/\/+$/, "");
      const res = await fetchWithTimeout(
        `${cleanBase}/api/v1/videos/${videoId}`,
        { headers: { "User-Agent": UA_WEB } },
        4500
      );
      if (!res.ok) continue;
      const data = await res.json();
      const formats = [];

      for (const f of data.formatStreams || []) {
        if (!f.url) continue;
        formats.push({
          id: `inv-${f.itag || formats.length}`,
          label: f.qualityLabel || f.resolution || "360p",
          mimeType: f.type || "video/mp4",
          type: "video",
          url: f.url,
          ua: UA_WEB
        });
      }

      const audioList = (data.adaptiveFormats || [])
        .filter((f) => f.url && (f.type || "").startsWith("audio/"))
        .sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0));
      if (audioList.length > 0) {
        const best = audioList.find((a) => (a.type || "").includes("mp4")) || audioList[0];
        formats.push({
          id: "inv-audio",
          label: "صوت فقط",
          mimeType: best.type || "audio/mp4",
          type: "audio",
          url: best.url,
          ua: UA_WEB
        });
      }

      if (formats.length === 0) continue;

      const related = (data.recommendedVideos || [])
        .map((r) =>
          normalizeVideoItem({
            id: r.videoId,
            title: r.title,
            author: r.author,
            duration: formatDurationSeconds(r.lengthSeconds),
            views: r.viewCountText || ""
          })
        )
        .filter(Boolean)
        .slice(0, 12);

      return {
        id: videoId,
        title: data.title || "فيديو يوتيوب",
        author: data.author || "",
        description: data.description || "",
        duration: formatDurationSeconds(data.lengthSeconds),
        views: data.viewCount ? `${Number(data.viewCount).toLocaleString("en-US")} مشاهدة` : "",
        published: data.publishedText || "",
        source: cleanBase,
        formats,
        related
      };
    } catch {
      // next instance
    }
  }
  return null;
}

async function fetchInnertubeRelated(videoId) {
  try {
    const res = await fetchWithTimeout(
      "https://www.youtube.com/youtubei/v1/next?prettyPrint=false",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": UA_WEB
        },
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              clientName: "WEB",
              clientVersion: "2.20240826.01.00",
              hl: "ar",
              gl: "SA"
            }
          }
        })
      },
      4500
    );
    if (!res.ok) return [];
    const data = await res.json();
    const renderers = collectRenderers(data, "compactVideoRenderer");
    const seen = new Set([videoId]);
    const items = [];
    for (const r of renderers) {
      if (!isValidVideoId(r.videoId) || seen.has(r.videoId)) continue;
      seen.add(r.videoId);
      items.push(
        normalizeVideoItem({
          id: r.videoId,
          title: getText(r.title),
          author: getText(r.longBylineText) || getText(r.shortBylineText),
          duration: getText(r.lengthText),
          views: getText(r.shortViewCountText),
          published: getText(r.publishedTimeText)
        })
      );
      if (items.length >= 12) break;
    }
    return items.filter(Boolean);
  } catch {
    return [];
  }
}

export async function getVideoDetails(videoId, options = {}) {
  if (!isValidVideoId(videoId)) {
    throw new Error("معرّف الفيديو غير صالح.");
  }

  const cacheKey = `${videoId}|${options.customPiped || ""}|${options.customInvidious || ""}`;
  const cached = streamCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  let result = null;

  // 1) Try Direct Innertube clients first (fastest when not blocked)
  for (const client of ["IOS", "ANDROID", "TV_EMBED"]) {
    try {
      result = await fetchInnertubePlayer(videoId, client);
      if (result) break;
    } catch {
      // continue
    }
  }

  // 2) Fallback to Piped public instances (or user's custom instance)
  if (!result) {
    result = await fetchPipedVideo(videoId, options.customPiped);
  }

  // 3) Fallback to Invidious public instances
  if (!result) {
    result = await fetchInvidiousVideo(videoId, options.customInvidious);
  }

  if (!result) {
    throw new Error(
      "تعذر استخراج رابط البث لهذا الفيديو حالياً. قد يكون السيرفر محظور مؤقتاً من يوتيوب — جرب إضافة رابط Piped أو Invidious مخصص في الإعدادات."
    );
  }

  if (!result.related || result.related.length === 0) {
    result.related = await fetchInnertubeRelated(videoId);
  }

  streamCache.set(cacheKey, {
    data: result,
    expiresAt: Date.now() + STREAM_TTL_MS
  });

  return result;
}
