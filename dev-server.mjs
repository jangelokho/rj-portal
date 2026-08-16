// Local dev server for the RJ Portal. NOT used in production — Vercel runs the
// api/*.js handlers directly. This just lets us run the REAL handlers locally
// against real Supabase, with a Vercel-compatible req/res shim, plus static files.
//
//   node dev-server.mjs        -> http://localhost:3000

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// --- load .env.local into process.env (no dependency) ---
const envPath = join(__dirname, ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) {
      const v = m[2].replace(/^["']|["']$/g, "");
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  }
}

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

// Vercel-style res shim over Node's ServerResponse.
function wrapRes(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    const body = JSON.stringify(obj);
    res.setHeader("Content-Type", "application/json");
    res.end(body);
    return res;
  };
  Object.defineProperty(res, "headersSent", {
    get() { return res.writableEnded || res._header != null; },
  });
  return res;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return undefined;
  const buf = Buffer.concat(chunks);
  const ct = req.headers["content-type"] || "";
  if (ct.includes("application/json")) {
    try { return JSON.parse(buf.toString("utf8")); } catch { return undefined; }
  }
  // Non-JSON (e.g. image upload): hand the raw Buffer to the handler.
  return buf;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  wrapRes(res);

  // --- API routes -> import real handler ---
  if (path.startsWith("/api/")) {
    const name = path.slice("/api/".length).replace(/\/$/, "");
    const file = join(__dirname, "api", `${name}.js`);
    if (!existsSync(file)) { res.status(404).json({ error: "Not found" }); return; }
    req.query = Object.fromEntries(url.searchParams.entries());
    req.body = await readBody(req);
    try {
      const mod = await import(`file://${file}?t=${Date.now()}`); // bust cache for hot reload
      await mod.default(req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.status(500).json({ error: "Server error" });
    }
    return;
  }

  // --- static files ---
  let fsPath = path === "/" ? "/index.html" : path;
  // cleanUrls: allow /foo -> /foo.html
  if (!extname(fsPath) && existsSync(join(__dirname, fsPath + ".html"))) fsPath += ".html";
  const full = join(__dirname, fsPath);
  if (!full.startsWith(__dirname) || !existsSync(full)) {
    res.status(404).end("Not found");
    return;
  }
  try {
    const data = await readFile(full);
    res.setHeader("Content-Type", MIME[extname(full)] || "application/octet-stream");
    res.end(data);
  } catch {
    res.status(500).end("Error");
  }
});

server.listen(PORT, () => {
  console.log(`RJ Portal dev server: http://localhost:${PORT}`);
  console.log(`Supabase: ${process.env.SUPABASE_URL ? "configured" : "MISSING"}`);
});
