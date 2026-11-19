import { searchVideos } from "../lib/youtube.js";

const CATEGORY_QUERIES = {
  all: "مقاطع رائجة السعودية يوتيوب",
  gaming: "قيمنق العاب عربية جديدة",
  tech: "مراجعات تقنية حديثة",
  coding: "برمجة وتطوير مواقع",
  cars: "تجربة سيارات جديدة",
  podcast: "بودكاست عربي ممتع",
  music: "اغاني خليجية عربية جديدة",
  sports: "ملخصات مباريات كرة قدم"
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  const cat = (req.query.cat || "all").toString();
  const query = CATEGORY_QUERIES[cat] || CATEGORY_QUERIES.all;

  try {
    const data = await searchVideos(query, {
      customPiped: req.query.piped ? String(req.query.piped) : "",
      customInvidious: req.query.invidious ? String(req.query.invidious) : ""
    });

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message || "تعذر تحميل المقترحات" });
  }
}
