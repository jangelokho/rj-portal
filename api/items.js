// /api/items
//   GET    ?list_id=123        -> items for a list (all statuses, newest first)
//   GET    ?all=true           -> every item across all lists (global search)
//   POST   { list_id, ... }    -> create item (portal-added; source_message_id stays null)
//   PATCH  ?id=123  { status?, list_id?, image?, due_date? } -> updated item
//   DELETE ?id=123             -> {ok}
//
// due_date is a plain user-settable date (YYYY-MM-DD or null); status_changed_at is NOT
// settable here — a DB trigger stamps it automatically whenever status actually changes.

import { sb, requireAuth, withErrors } from "./_supabase.js";

const STATUSES = ["active", "done", "archived"];
const TYPES = ["link", "image", "file", "text", "video"];

function cleanDueDate(v) {
  if (v === null || v === "") return null;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return undefined; // signals "invalid" to callers, vs. undefined meaning "field absent"
}

export default withErrors(async (req, res) => {
  if (!requireAuth(req, res)) return;

  if (req.method === "GET") {
    if (req.query.all === "true") {
      const items = await sb("items?select=*&order=created_at.desc");
      return res.status(200).json(items || []);
    }
    const listId = req.query.list_id;
    if (!listId) return res.status(400).json({ error: "list_id required" });
    const items = await sb(
      `items?list_id=eq.${encodeURIComponent(listId)}&select=*&order=created_at.desc`
    );
    return res.status(200).json(items || []);
  }

  if (req.method === "POST") {
    const b = req.body || {};
    if (b.list_id === undefined || b.list_id === null) {
      return res.status(400).json({ error: "list_id required" });
    }
    // Confirm the list exists.
    const list = await sb(`lists?id=eq.${encodeURIComponent(b.list_id)}&select=id`);
    if (!list || !list[0]) return res.status(404).json({ error: "List not found" });

    const type = TYPES.includes(b.type) ? b.type : (b.url ? "link" : "text");
    if (!b.title && !b.url && !b.raw_text) {
      return res.status(400).json({ error: "Provide a title, url, or text" });
    }
    let dueDate = null;
    if (b.due_date !== undefined) {
      dueDate = cleanDueDate(b.due_date);
      if (dueDate === undefined) return res.status(400).json({ error: "due_date must be YYYY-MM-DD or null" });
    }
    const row = {
      list_id: b.list_id,
      type,
      url: b.url ?? null,
      title: b.title ?? null,
      description: b.description ?? null,
      image: b.image ?? null,
      raw_text: b.raw_text ?? null,
      status: STATUSES.includes(b.status) ? b.status : "active",
      enriched: b.enriched && typeof b.enriched === "object" ? b.enriched : {},
      due_date: dueDate,
      // source_message_id null = created in the portal; added_by null = no Telegram identity.
    };
    const created = await sb("items", {
      method: "POST",
      prefer: "return=representation",
      body: row,
    });
    return res.status(201).json(Array.isArray(created) ? created[0] : created);
  }

  if (req.method === "PATCH") {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "id required" });
    const { status, list_id, image, title, description, url, enriched, due_date } = req.body || {};
    const patch = {};
    if (status !== undefined) {
      if (!STATUSES.includes(status)) return res.status(400).json({ error: "Bad status" });
      patch.status = status;
    }
    if (list_id !== undefined) patch.list_id = list_id;
    if (image !== undefined) patch.image = image;
    if (title !== undefined) patch.title = title;
    if (description !== undefined) patch.description = description;
    if (url !== undefined) patch.url = url;
    if (enriched !== undefined && typeof enriched === "object") patch.enriched = enriched;
    if (due_date !== undefined) {
      const cleaned = cleanDueDate(due_date);
      if (cleaned === undefined) return res.status(400).json({ error: "due_date must be YYYY-MM-DD or null" });
      patch.due_date = cleaned;
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "Nothing to update" });
    }
    const updated = await sb(`items?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      prefer: "return=representation",
      body: patch,
    });
    return res.status(200).json(Array.isArray(updated) ? updated[0] : updated);
  }

  if (req.method === "DELETE") {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "id required" });
    await sb(`items?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      prefer: "return=minimal",
    });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
});
