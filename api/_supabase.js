// Shared server-side helpers for the RJ Portal serverless functions.
// The Supabase service key lives ONLY here (server-side) — never shipped to the browser.
// Mirrors the bot's raw PostgREST access pattern (apikey + Bearer service key).

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY; // server-side only

// Shared password gate for the two users. Returns true if authorised, else
// writes a 401 and returns false (caller should `return`).
export function requireAuth(req, res) {
  const pw = req.headers["x-portal-password"];
  if (!pw || pw !== process.env.PORTAL_PASSWORD) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// Thin PostgREST wrapper. `path` is everything after /rest/v1/ (incl. query string).
export async function sb(path, { method = "GET", body, prefer } = {}) {
  if (!SB_URL || !SB_KEY) {
    throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY env vars");
  }
  const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers["Prefer"] = prefer;

  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${path} -> ${res.status}: ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Wrap a handler so thrown errors become clean 500s (and never leak the key).
export function withErrors(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: "Server error" });
    }
  };
}
