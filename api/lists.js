// /api/lists
//   GET                      -> [{...list, count}]  (count = active items)
//   POST   { name, kind }    -> created list
//   PATCH  ?id=123 { name }  -> {ok}  (rename; rejects standard lists — bot shortcuts route by their names)
//   DELETE ?id=123           -> {ok}  (rejects standard lists)

import { sb, requireAuth, withErrors } from "./_supabase.js";

const KINDS = ["buyable", "place", "todo", "restaurant", "watch", "generic"];

export default withErrors(async (req, res) => {
  if (!requireAuth(req, res)) return;

  if (req.method === "GET") {
    const lists = await sb("lists?select=*&order=sort_order.asc,created_at.asc");
    // Active-item counts, aggregated client-side from one cheap select.
    const rows = await sb("items?select=list_id,status");
    const counts = {};
    for (const r of rows || []) {
      if (r.status === "active") counts[r.list_id] = (counts[r.list_id] || 0) + 1;
    }
    const withCounts = (lists || []).map((l) => ({ ...l, count: counts[l.id] || 0 }));
    return res.status(200).json(withCounts);
  }

  if (req.method === "POST") {
    const { name, kind } = req.body || {};
    const cleanName = (name || "").trim();
    if (!cleanName) return res.status(400).json({ error: "Name required" });
    const cleanKind = KINDS.includes(kind) ? kind : "generic";
    const created = await sb("lists", {
      method: "POST",
      prefer: "return=representation",
      body: { name: cleanName, kind: cleanKind, is_standard: false },
    });
    return res.status(201).json(Array.isArray(created) ? created[0] : created);
  }

  if (req.method === "PATCH") {
    const id = req.query.id;
    const name = ((req.body || {}).name || "").trim();
    if (!id) return res.status(400).json({ error: "id required" });
    if (!name) return res.status(400).json({ error: "Name required" });
    const found = await sb(`lists?id=eq.${encodeURIComponent(id)}&select=id,is_standard`);
    const list = found && found[0];
    if (!list) return res.status(404).json({ error: "List not found" });
    if (list.is_standard) {
      return res.status(403).json({ error: "Standard lists cannot be renamed" });
    }
    try {
      await sb(`lists?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: { name },
      });
    } catch (e) {
      if (String(e.message || e).includes("409") || /duplicate|unique/i.test(String(e.message || e))) {
        return res.status(409).json({ error: `A list named "${name}" already exists` });
      }
      throw e;
    }
    return res.status(200).json({ ok: true });
  }

  if (req.method === "DELETE") {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "id required" });
    const found = await sb(`lists?id=eq.${encodeURIComponent(id)}&select=id,is_standard`);
    const list = found && found[0];
    if (!list) return res.status(404).json({ error: "List not found" });
    if (list.is_standard) {
      return res.status(403).json({ error: "Standard lists cannot be deleted" });
    }
    // ON DELETE CASCADE removes the list's items.
    await sb(`lists?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      prefer: "return=minimal",
    });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
});
