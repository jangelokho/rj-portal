# RJ Portal — the Manager

Web portal for the Darth Mitbot household Kanban (Ria + Jangelo). Reads/writes the **same
Supabase Postgres** the bot captures into. This portal only *manages* — it never talks to
Telegram and never polls.

Sibling repo: the Darth Mitbot edge function (capture lives there).

## Stack
- Static frontend: `index.html` / `style.css` / `app.js` — no framework, no build step.
- API: Vercel serverless functions under `api/*` (ESM, Node ≥ 18, global `fetch`).
- Data: Supabase via raw PostgREST using the **service key, server-side only**.
- Auth: shared `PORTAL_PASSWORD` gate, checked in every function; the browser sends it as the
  `x-portal-password` header.

## Features
- **Two views**: a Kanban **Board** (default; drag cards between Active / Done / Archived) and a
  **List** view with status tabs. Choice is remembered in `localStorage`.
- **Add items in-portal**: "+ Add item" → Title + URL (with a "Fetch" that OG-scrapes the link to
  prefill title/description/image) + optional image upload.
- **Sort** by create date (newest / oldest), remembered.
- **Per-item image upload** to Supabase Storage (public `item-images` bucket).
- **Quick-actions** on each card (done checkbox + archive) and a **kind-aware detail modal**.
- **Toasts with Undo** on status/move/archive changes.
- **Global search** across all lists (toggle "All lists" beside the search box).
- **Keyboard shortcuts**: `/` focus search, `n` new item, `Esc` close.

## Endpoints
- `POST /api/login` — validate password.
- `GET/POST/DELETE /api/lists` — list boards (with active-item counts), create, delete (custom only).
- `GET/POST/PATCH/DELETE /api/items` — list items (`?list_id=` or `?all=true`), create, update
  (status / move / image), delete.
- `GET /api/preview?url=` — OG-scrape a URL → `{ title, description, image }` (Microlink fallback).
- `POST /api/upload?ext=` — raw image bytes → uploads to Storage, returns `{ url }`.

## Environment variables (set in the Vercel dashboard — never commit)
| Var | Notes |
|---|---|
| `SUPABASE_URL` | same project as the bot (`pzgmhdqpruncgstwuzeo`) |
| `SUPABASE_SERVICE_KEY` | **server-side only.** The bot uses `SUPABASE_SERVICE_ROLE_KEY`; this portal uses `SUPABASE_SERVICE_KEY` per spec — set the same service-role secret value here. |
| `PORTAL_PASSWORD` | shared gate for the two users |

## Deploy
```bash
cd rj-portal
vercel login          # first time only
vercel                # preview deploy
vercel --prod         # production
```
Set the three env vars in the Vercel project (Settings → Environment Variables) before the
production deploy. Make sure the **migration** (`supabase/migrations/20260618000000_shared_boards.sql`
in the bot repo) has been pushed so `lists` / `items` exist, and the public **`item-images`**
Storage bucket exists (already created on project `pzgmhdqpruncgstwuzeo`).

## Local development
```bash
node dev-server.mjs   # http://localhost:3000  — runs the real api/*.js handlers
```
Reads `.env.local` (gitignored) for `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `PORTAL_PASSWORD`.
The dev server shims Vercel's req/res so the same handler files run locally and in production.

## Notes
- Standard lists (`is_standard = true`) hide the delete control and are rejected server-side.
- `enriched` JSONB drives the kind-aware detail modal (restaurant / place / watch / buyable /
  todo / generic).
- To show real names instead of "User <id>" for attribution, fill in `USER_NAMES` at the top of
  `app.js` with the two Telegram user ids.
