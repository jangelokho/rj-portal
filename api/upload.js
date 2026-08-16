// POST /api/upload?ext=jpg   (raw image bytes in the body)  -> { url }
// Uploads to the public Supabase Storage bucket `item-images` with the service key and
// returns the public URL. Decoupled from items — the add-form and the detail modal both use it.

import { requireAuth, withErrors } from "./_supabase.js";

// Disable Vercel's body parser so we receive the raw binary stream.
export const config = { api: { bodyParser: false } };

const BUCKET = "item-images";
const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif"]);
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB

function readRaw(req) {
  // dev-server passes a Buffer through as req.body; on Vercel we read the stream.
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BYTES) reject(new Error("too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default withErrors(async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ext = String(req.query.ext || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!ALLOWED_EXT.has(ext)) return res.status(400).json({ error: "Unsupported image type" });

  let bytes;
  try {
    bytes = await readRaw(req);
  } catch {
    return res.status(413).json({ error: "Image too large (max 8 MB)" });
  }
  if (!bytes || bytes.length === 0) return res.status(400).json({ error: "Empty body" });

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  const contentType = req.headers["content-type"] && req.headers["content-type"] !== "application/octet-stream"
    ? req.headers["content-type"]
    : `image/${ext === "jpg" ? "jpeg" : ext}`;

  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const up = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${name}`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": contentType },
    body: bytes,
  });
  if (!up.ok) {
    const text = await up.text();
    throw new Error(`Storage upload failed ${up.status}: ${text}`);
  }
  const url = `${SB_URL}/storage/v1/object/public/${BUCKET}/${name}`;
  return res.status(200).json({ url });
});
