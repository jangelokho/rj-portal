// GET /api/preview?url=...  -> { title, description, image }
// OG-tag scrape with a Microlink fallback for social sites that block scrapers.
// Mirrors the bot's fetchOgPreview (darth-mitbot .../telegram-bot/index.ts ~210-240).

import { requireAuth, withErrors } from "./_supabase.js";

function decodeEntities(s) {
  return s
    ? s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim()
    : undefined;
}

async function fetchOgPreview(url) {
  const social = /(instagram\.com|tiktok\.com|x\.com|twitter\.com|facebook\.com|threads\.net)/i.test(url);
  if (!social) {
    try {
      const html = await (await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; RJPortal/1.0)" },
      })).text();
      const meta = (prop) => {
        const a = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, "i");
        const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, "i");
        return html.match(a)?.[1] ?? html.match(b)?.[1];
      };
      const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
      const preview = {
        title: decodeEntities(meta("og:title") ?? titleTag),
        description: decodeEntities(meta("og:description") ?? meta("description")),
        image: meta("og:image"),
      };
      if (preview.title || preview.image) return preview;
    } catch { /* fall through to Microlink */ }
  }
  try {
    const data = await (await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}`)).json();
    if (data?.status === "success") {
      return {
        title: data.data.title,
        description: data.data.description,
        image: data.data.image?.url ?? data.data.logo?.url,
      };
    }
  } catch { /* ignore */ }
  return {};
}

export default withErrors(async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const url = req.query.url;
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: "Valid http(s) url required" });
  }
  const preview = await fetchOgPreview(url);
  return res.status(200).json(preview);
});
