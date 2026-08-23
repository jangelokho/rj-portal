// RJ Portal frontend. Plain JS, no build step. Talks only to /api/*.
// The password is kept in localStorage (so the installed PWA stays logged in)
// and sent as x-portal-password on every call.

const PW_KEY = "rj_portal_pw";
const SORT_KEY = "rj_sort";   // 'newest' | 'oldest'
const SNAP_KEY = "rj_snapshot"; // last view {lists, listId, items} for instant paint
const THEME_KEY = "rj_theme";   // 'light' | 'dark'; absent = follow the OS

// Fallback accent for lists with no colour set in the DB.
const DEFAULT_LIST_COLOR = "#0d9488";

// Map Telegram user ids -> display names for attribution (ids from the bot's allowlist).
const USER_NAMES = {
  140522338: "Jangelo",
  200711792: "Ria",
};

function isFav(it) { return !!(it.enriched && it.enriched.favorite); }

// Country is derived from the Places-enriched address (restaurant/place kinds only) — no
// separate field to keep in sync. Items added in bulk (colon shortcuts, "Add to X:") skip
// enrichment entirely and have no address, so they fall into "Unspecified" until re-added
// singly or edited with a real address.
function itemCountry(item) {
  const addr = (item.enriched && item.enriched.address) || "";
  if (/singapore/i.test(addr)) return "SG";
  if (/philippines/i.test(addr)) return "PH";
  return null;
}

// Active items show their own due_date (the plain "set a date" field); done/archived
// items show when that happened instead — status_changed_at, stamped by a DB trigger only
// on an actual status change, so editing a note later never overwrites it.
function dateChip(item) {
  if (item.status === "active") {
    if (!item.due_date) return "";
    const overdue = item.due_date < todayIso();
    return `<span class="date-chip${overdue ? " overdue" : ""}">${fmtDueDate(item.due_date)}</span>`;
  }
  if (!item.status_changed_at) return "";
  const label = item.status === "done" ? "Done" : "Archived";
  return `<span class="date-chip">${label} ${fmtDateShort(item.status_changed_at)}</span>`;
}

function itemKind(item) { return (state.lists.find((l) => l.id === item.list_id) || {}).kind; }

// The couple's own rating of a restaurant/place visit — separate from Google's crowd
// rating shown in the detail modal.
function ratingChip(item) {
  const kind = itemKind(item);
  if (kind !== "restaurant" && kind !== "place") return "";
  const n = item.enriched && item.enriched.my_rating;
  if (!n) return "";
  return `<span class="date-chip">${"★".repeat(n)}${"☆".repeat(5 - n)}</span>`;
}

const BUYABLE_CATEGORIES = ["Grocery", "Medicine", "Personal", "Wants", "Work"];

function categoryChip(item) {
  if (itemKind(item) !== "buyable") return "";
  const cat = item.enriched && item.enriched.category;
  return cat ? `<span class="date-chip">${esc(cat)}</span>` : "";
}

const state = {
  lists: [],
  currentListId: null,
  items: [],
  itemsCache: {},            // listId -> items, for instant list switching
  allItems: null,            // cache for global search
  statusFilter: "active", // 'active' | 'done' | 'archived' | 'all' | 'starred'
  countryFilter: "all", // 'all' | 'SG' | 'PH' | 'other' — restaurant/place lists only
  categoryFilter: "all", // 'all' | 'Grocery' | 'Medicine' | 'Personal' | 'Wants' | 'Work' | 'none' — buyable lists only
  search: "",
  allLists: false,
  sortOrder: localStorage.getItem(SORT_KEY) || "newest",
  formImageUrl: null,        // image chosen in the add form
  lastFetchedUrl: "",        // dedupe auto-preview fetches
};

let pendingWrites = 0;       // in-flight background saves; revalidate waits for zero

// ---------- API ----------
function pw() { return localStorage.getItem(PW_KEY) || sessionStorage.getItem(PW_KEY) || ""; }

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", "x-portal-password": pw(), ...(opts.headers || {}) },
  });
  if (res.status === 401) { localStorage.removeItem(PW_KEY); sessionStorage.removeItem(PW_KEY); showLogin(); throw new Error("Unauthorized"); }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.status === 200 || res.status === 201 ? res.json() : null;
}

async function uploadImage(file) {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const buf = await file.arrayBuffer();
  const res = await fetch(`/api/upload?ext=${encodeURIComponent(ext)}`, {
    method: "POST",
    headers: { "x-portal-password": pw(), "Content-Type": file.type || "application/octet-stream" },
    body: buf,
  });
  if (!res.ok) {
    let msg = "Upload failed";
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return (await res.json()).url;
}

// ---------- Auth ----------
function showLogin() { $("#app").classList.add("hidden"); $("#login").classList.remove("hidden"); }
function showApp() { $("#login").classList.add("hidden"); $("#app").classList.remove("hidden"); init(); }

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = $("#login-pw").value;
  const err = $("#login-error");
  err.classList.add("hidden");
  try {
    const res = await fetch("/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
    });
    if (!res.ok) throw new Error("Wrong password");
    localStorage.setItem(PW_KEY, password);
    showApp();
  } catch (e2) { err.textContent = e2.message; err.classList.remove("hidden"); }
});
$("#logout-btn").addEventListener("click", () => { localStorage.removeItem(PW_KEY); sessionStorage.removeItem(PW_KEY); showLogin(); });

// ---------- Theme ----------
// index.html has already resolved and applied a theme before first paint; this only
// keeps the button in sync and handles switching.
const THEME_META = { dark: "#0e1014", light: "#f4f6f8" };

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function applyTheme(theme, persist) {
  document.documentElement.setAttribute("data-theme", theme);
  // Tints the iOS status bar and Android task-switcher chrome in the installed PWA.
  const meta = document.getElementById("theme-color-meta");
  if (meta) meta.setAttribute("content", THEME_META[theme]);
  // The button advertises what you'd switch TO, which is what people expect of a toggle.
  const next = theme === "dark" ? "light" : "dark";
  $("#theme-label").textContent = next === "dark" ? "Dark" : "Light";
  $("#theme-btn").title = `Switch to ${next} mode`;
  if (persist) { try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* private mode */ } }
}

$("#theme-btn").addEventListener("click", () => {
  applyTheme(currentTheme() === "dark" ? "light" : "dark", true);
});

// Follow the OS only while the user hasn't picked a side themselves.
if (window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", (e) => {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (err) { /* private mode */ }
    if (saved !== "light" && saved !== "dark") applyTheme(e.matches ? "light" : "dark", false);
  });
}

applyTheme(currentTheme(), false); // sync the button with what the bootstrap chose

// ---------- Init / data ----------
async function init() {
  // reflect persisted sort in the controls
  $("#sort-select").value = state.sortOrder;

  // Instant paint from the last session's snapshot, then refresh from the network.
  let snap = null;
  try { snap = JSON.parse(localStorage.getItem(SNAP_KEY) || "null"); } catch {}
  if (snap && Array.isArray(snap.lists) && snap.lists.length) {
    state.lists = snap.lists;
    if (snap.listId != null && snap.lists.some((l) => l.id === snap.listId)) {
      state.currentListId = snap.listId;
      state.items = Array.isArray(snap.items) ? snap.items : [];
      state.itemsCache[snap.listId] = state.items;
    }
    renderSidebar();
    applyListHeader();
    renderMain();
  }

  await revalidate();
  // First run (no snapshot) or the snapshot's list no longer exists.
  if (state.lists.length && (state.currentListId == null || !currentList())) {
    await selectList(state.lists[0].id);
  }
}

async function loadLists() { state.lists = await api("/api/lists"); renderSidebar(); }

function applyListHeader() {
  const list = currentList();
  $("#current-list-name").textContent = list ? list.name : "—";
  $("#delete-list-btn").classList.toggle("hidden", !list || list.is_standard);
  $("#rename-list-btn").classList.toggle("hidden", !list || list.is_standard);
  document.documentElement.style.setProperty("--list-accent", list ? (list.color || DEFAULT_LIST_COLOR) : DEFAULT_LIST_COLOR);
}

async function selectList(id) {
  state.currentListId = id;
  state.allLists = false; $("#all-lists-toggle").checked = false;
  state.countryFilter = "all"; $("#country-filter").value = "all";
  state.categoryFilter = "all"; $("#category-filter").value = "all";
  renderSidebar();
  applyListHeader();
  const cached = state.itemsCache[id];
  if (cached) {
    // Paint instantly from cache; freshen quietly in the background.
    state.items = cached;
    renderMain();
    revalidate();
  } else {
    state.items = await api(`/api/items?list_id=${encodeURIComponent(id)}`);
    state.itemsCache[id] = state.items;
    renderMain();
  }
  saveSnapshot();
}

function currentList() { return state.lists.find((l) => l.id === state.currentListId); }
function listNameOf(id) { return state.lists.find((l) => l.id === id)?.name || ""; }

function saveSnapshot() {
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify({
      lists: state.lists, listId: state.currentListId, items: state.items,
    }));
  } catch { /* quota — fine, snapshot is a bonus */ }
}

// Quiet background refresh of lists + the current list's items.
// Skipped while optimistic writes are in flight (their state is newer than the server's).
let revalidating = false;
async function revalidate() {
  if (revalidating || pendingWrites > 0) return;
  revalidating = true;
  try {
    const [lists, items] = await Promise.all([
      api("/api/lists"),
      state.currentListId != null
        ? api(`/api/items?list_id=${encodeURIComponent(state.currentListId)}`)
        : Promise.resolve(null),
    ]);
    if (pendingWrites > 0) return; // a write started mid-flight; server data is stale
    state.lists = lists;
    renderSidebar();
    applyListHeader();
    if (items) {
      state.items = items;
      state.itemsCache[state.currentListId] = items;
      renderMainPreservingScroll();
    }
    if (state.allItems) state.allItems = await api("/api/items?all=true");
    saveSnapshot();
  } catch { /* offline / transient — keep showing local state */ }
  finally { revalidating = false; }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && pw() && !$("#app").classList.contains("hidden")) revalidate();
});

// ---------- Sidebar ----------
function renderSidebar() {
  const nav = $("#list-nav");
  nav.innerHTML = "";
  for (const l of state.lists) {
    const btn = document.createElement("button");
    btn.className = "list-item" + (l.id === state.currentListId ? " selected" : "");
    btn.style.setProperty("--list-accent", l.color || "#64748b");
    btn.innerHTML = `
      <span class="list-name">${esc(l.name)}</span>
      <span class="list-count">${l.count ?? 0}</span>`;
    btn.addEventListener("click", () => selectList(l.id));
    nav.appendChild(btn);
  }
}

$("#new-list-btn").addEventListener("click", async () => {
  const name = prompt("New list name:");
  if (!name || !name.trim()) return;
  const kind = (prompt("Kind? (buyable / place / todo / restaurant / watch / generic)", "generic") || "generic").trim();
  try {
    const created = await api("/api/lists", { method: "POST", body: JSON.stringify({ name: name.trim(), kind }) });
    await loadLists(); selectList(created.id);
  } catch (e) { alert(e.message); }
});

$("#rename-list-btn").addEventListener("click", async () => {
  const list = currentList();
  if (!list || list.is_standard) return;
  const name = prompt("Rename list:", list.name);
  if (!name || !name.trim() || name.trim() === list.name) return;
  try {
    await api(`/api/lists?id=${encodeURIComponent(list.id)}`, {
      method: "PATCH", body: JSON.stringify({ name: name.trim() }),
    });
    await loadLists();
    selectList(list.id);
    showToast("List renamed");
  } catch (e) { alert(e.message); }
});

$("#delete-list-btn").addEventListener("click", async () => {
  const list = currentList();
  if (!list) return;
  if (!confirm(`Delete "${list.name}" and all its items? This cannot be undone.`)) return;
  try {
    await api(`/api/lists?id=${encodeURIComponent(list.id)}`, { method: "DELETE" });
    state.currentListId = null;
    await loadLists();
    if (state.lists.length) selectList(state.lists[0].id);
  } catch (e) { alert(e.message); }
});

// ---------- Toolbar controls ----------
$("#sort-select").addEventListener("change", (e) => {
  state.sortOrder = e.target.value; localStorage.setItem(SORT_KEY, state.sortOrder); renderMain();
});
$("#search").addEventListener("input", async (e) => {
  state.search = e.target.value;
  if (state.allLists && !state.allItems) state.allItems = await api("/api/items?all=true");
  renderMain();
});
$("#all-lists-toggle").addEventListener("change", async (e) => {
  state.allLists = e.target.checked;
  if (state.allLists && !state.allItems) state.allItems = await api("/api/items?all=true");
  renderMain();
});
$("#status-filter").addEventListener("change", (e) => { state.statusFilter = e.target.value; renderMain(); });
$("#country-filter").addEventListener("change", (e) => { state.countryFilter = e.target.value; renderMain(); });
$("#category-filter").addEventListener("change", (e) => { state.categoryFilter = e.target.value; renderMain(); });

// ---------- Render dispatch ----------
function globalMode() { return state.allLists && state.search.trim().length > 0; }

function renderMain() {
  const g = globalMode();
  $("#status-filter").style.display = g ? "none" : "";
  $("#country-filter").style.display = (!g && currentList()?.kind === "restaurant") ? "" : "none";
  $("#category-filter").style.display = (!g && currentList()?.kind === "buyable") ? "" : "none";
  if (g) { renderGlobalResults(); return; }
  renderList();
}

// Re-render without losing the user's place — used for mutations (tick, star, move…)
// so checking items one by one deep in a long list doesn't bounce back to the top.
function renderMainPreservingScroll() {
  const cardsTop = $("#cards").scrollTop;
  renderMain();
  $("#cards").scrollTop = cardsTop;
}

function sortItems(arr) {
  const s = [...arr].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const byDate = state.sortOrder === "newest" ? s.reverse() : s;
  // favorites pinned to top (stable sort preserves date order within each group)
  return byDate.sort((a, b) => (isFav(b) ? 1 : 0) - (isFav(a) ? 1 : 0));
}
function matches(it, q) {
  return `${it.title || ""} ${it.description || ""} ${it.raw_text || ""}`.toLowerCase().includes(q);
}

function renderList() {
  const q = state.search.trim().toLowerCase();
  const list = currentList();
  let items = state.items.filter((it) => {
    if (state.statusFilter === "all") return true;
    if (state.statusFilter === "starred") return isFav(it);
    return it.status === state.statusFilter;
  });
  if (q) items = items.filter((it) => matches(it, q));
  if (list?.kind === "restaurant" && state.countryFilter !== "all") {
    items = items.filter((it) => (itemCountry(it) || "other") === state.countryFilter);
  }
  if (list?.kind === "buyable" && state.categoryFilter !== "all") {
    items = items.filter((it) => (it.enriched?.category || "none") === state.categoryFilter);
  }
  items = sortItems(items);
  $("#empty").innerHTML = state.statusFilter === "starred"
    ? emptyHTML("No starred items here.", "Tap a card's Fav button to pin it to the top.")
    : emptyHTML(`Nothing in ${list ? list.name : "this list"} yet.`,
        'Add one with "+ Add item" — or send it to Darth Mitbot.');
  $("#empty").classList.toggle("hidden", items.length > 0);
  const wrap = $("#cards"); wrap.innerHTML = "";
  items.forEach((it) => wrap.appendChild(renderRow(it, {})));
}

function renderGlobalResults() {
  const q = state.search.trim().toLowerCase();
  let items = (state.allItems || []).filter((it) => matches(it, q));
  items = sortItems(items);
  $("#empty").innerHTML = emptyHTML("No matches.", "Try a different search.");
  $("#empty").classList.toggle("hidden", items.length > 0);
  const wrap = $("#cards"); wrap.innerHTML = "";
  items.forEach((it) => wrap.appendChild(renderRow(it, { showListName: true })));
}

// click-anywhere opens the detail modal; the three action buttons do their thing
// without also triggering that click.
function wireItemActions(el, item) {
  el.addEventListener("click", () => openModal(item));
  el.querySelector(".row-check").addEventListener("click", async (e) => {
    e.stopPropagation();
    const toDone = item.status !== "done";
    await applyPatch(item, { status: toDone ? "done" : "active" }, toDone ? "Marked done" : "Marked active");
  });
  el.querySelector(".card-archive").addEventListener("click", async (e) => {
    e.stopPropagation();
    const to = item.status === "archived" ? "active" : "archived";
    await applyPatch(item, { status: to }, to === "archived" ? "Archived" : "Unarchived");
  });
  el.querySelector(".card-star").addEventListener("click", async (e) => { e.stopPropagation(); await toggleFav(item); });
}

// ---------- Compact list rows ----------
function renderRow(item, opts = {}) {
  const row = document.createElement("div");
  row.className = `row ${item.status}`;
  const listBadge = opts.showListName ? `<span class="list-badge">${esc(listNameOf(item.list_id))}</span>` : "";
  row.innerHTML = `
    <button class="row-check ${item.status === "done" ? "done" : ""}" title="${item.status === "done" ? "Mark active" : "Mark done"}">✓</button>
    <div class="row-main">
      <div class="row-title">${esc(item.title || item.raw_text || "(untitled)")}</div>
      ${item.enriched?.address ? `<div class="row-address">${esc(item.enriched.address)}</div>` : ""}
    </div>
    <div class="row-meta">${listBadge}${dateChip(item)}${ratingChip(item)}${categoryChip(item)}</div>
    <div class="row-actions">
      <button class="card-star ${isFav(item) ? "faved" : ""}" title="Favorite">${isFav(item) ? "★" : "☆"}</button>
      <button class="card-archive">${item.status === "archived" ? "Unarchive" : "Archive"}</button>
    </div>`;
  wireItemActions(row, item);
  return row;
}

// Favorite is stored in enriched.favorite; merge client-side (PostgREST replaces the whole jsonb).
async function toggleFav(item) {
  const fav = !isFav(item);
  const prevEnriched = item.enriched;
  item.enriched = { ...(item.enriched || {}), favorite: fav };
  renderMainPreservingScroll();
  saveSnapshot();
  showToast(fav ? "Starred" : "Unstarred");
  syncPatch(item.id, { enriched: item.enriched }, () => {
    item.enriched = prevEnriched;
    renderMainPreservingScroll();
  });
}

// ---------- Mutations: optimistic local update + background save ----------
function bumpCount(listId, delta) {
  const l = state.lists.find((x) => x.id === listId);
  if (l) l.count = Math.max(0, (l.count || 0) + delta);
}

// Apply a patch to local state: item fields, sidebar counts (count = ACTIVE items),
// and membership in the currently viewed list's array.
function applyLocal(item, patch) {
  const wasActive = item.status === "active";
  const willBeActive = ("status" in patch ? patch.status : item.status) === "active";
  const toList = "list_id" in patch ? patch.list_id : item.list_id;
  if (wasActive) bumpCount(item.list_id, -1);
  if (willBeActive) bumpCount(toList, +1);
  if ("list_id" in patch && patch.list_id !== state.currentListId) {
    delete state.itemsCache[patch.list_id]; // target list's cache is now stale
  }
  Object.assign(item, patch);
  const inView = state.items.includes(item);
  if (item.list_id === state.currentListId && !inView) state.items.push(item);
  if (item.list_id !== state.currentListId && inView) {
    state.items = state.items.filter((x) => x !== item);
    state.itemsCache[state.currentListId] = state.items;
  }
}

// Background PATCH; on failure run onFail (revert) and tell the user.
// Writes are serialized per item id — a quick tick→undo must reach the server in order.
const writeQueues = {};
function syncPatch(id, patch, onFail) {
  pendingWrites++;
  const run = async () => {
    try {
      await api(`/api/items?id=${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
    } catch (e) {
      if (onFail) onFail();
      showToast("Save failed — reverted");
    } finally { pendingWrites--; }
  };
  writeQueues[id] = (writeQueues[id] || Promise.resolve()).then(run);
  return writeQueues[id];
}

async function applyPatch(item, patch, label) {
  const prev = {};
  for (const k of Object.keys(patch)) prev[k] = item[k];

  applyLocal(item, patch);
  closeModal();
  renderSidebar();
  renderMainPreservingScroll();
  saveSnapshot();

  const undoable = "status" in patch || "list_id" in patch;
  showToast(label, undoable ? () => {
    applyLocal(item, prev);
    renderSidebar();
    renderMainPreservingScroll();
    saveSnapshot();
    showToast("Undone");
    syncPatch(item.id, prev, null);
  } : null);

  syncPatch(item.id, patch, () => {
    applyLocal(item, prev);
    renderSidebar();
    renderMainPreservingScroll();
    saveSnapshot();
  });
}

// ---------- Detail modal (kind-aware) ----------
function openModal(item) {
  const list = state.lists.find((l) => l.id === item.list_id) || currentList();
  const kind = list ? list.kind : "generic";
  const e = item.enriched || {};
  const hero = item.image ? `<img class="modal-hero" src="${esc(item.image)}" alt="" onerror="this.remove()">` : "";

  const field = (label, value) =>
    value ? `<div class="field"><span class="field-label">${label}</span><span class="field-value">${value}</span></div>` : "";
  const link = (url, text) => url ? `<a class="modal-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(text || url)}</a>` : "";
  const badges = (a) => a && a.length ? `<div class="badges">${a.map((b) => `<span class="badge">${esc(b)}</span>`).join("")}</div>` : "";
  const openNow = e.open_now === true ? `<span class="open-now">● Open now</span>`
    : e.open_now === false ? `<span class="closed-now">● Closed</span>` : "";

  let fields = "";
  switch (kind) {
    case "restaurant":
    case "place":
      fields += field("Address", e.address);
      fields += field("Map", link(e.map_url, "Open in Maps"));
      fields += field(kind === "restaurant" ? "Cuisine" : "Type", arr(e.cuisine || e.types));
      fields += field("Price", priceLevel(e.price_level));
      fields += field("Rating", e.rating ? String(e.rating) : "");
      fields += field("Hours", e.hours ? esc(e.hours) + (openNow ? " " + openNow : "") : openNow);
      fields += field("Phone", e.phone);
      if (e.why) fields += field("Why", esc(e.why));
      if (e.tags) fields += field("Good for", badges(e.tags));
      break;
    case "watch":
      fields += field("Year", e.year);
      fields += field("Type", e.media_type);
      fields += field("Runtime", e.runtime ? `${e.runtime} min` : (e.seasons ? `${e.seasons} seasons` : ""));
      fields += field("Genres", arr(e.genres));
      fields += field("Rating", e.vote_average ? String(e.vote_average) : "");
      if (e.overview) fields += field("Synopsis", esc(e.overview));
      if (e.watch_providers) fields += field("Streaming", badges(e.watch_providers));
      break;
    case "buyable":
      fields += field("Price", e.price ? `${e.currency ? e.currency + " " : ""}${e.price}` : "");
      fields += field("Retailer", e.retailer);
      fields += field("In stock", e.in_stock === true ? "Yes" : e.in_stock === false ? "No" : "");
      break;
  }
  const moveOptions = state.lists
    .map((l) => `<option value="${l.id}" ${l.id === item.list_id ? "selected" : ""}>${esc(l.name)}</option>`).join("");
  const isDone = item.status === "done";
  const isArchived = item.status === "archived";
  const isVisitKind = kind === "restaurant" || kind === "place";

  const myRating = (e.my_rating | 0);
  const ratingRow = isVisitKind ? `
      <div class="modal-edit-date-row" id="modal-rating-row">
        <label>Our rating</label>
        <div class="star-rating" id="modal-my-rating">
          ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="star-btn" data-n="${n}">${n <= myRating ? "★" : "☆"}</button>`).join("")}
        </div>
      </div>` : "";

  const categoryRow = kind === "buyable" ? `
      <div class="modal-edit-date-row">
        <label for="modal-edit-category">Category</label>
        <select class="modal-edit-date" id="modal-edit-category">
          <option value="" ${!e.category ? "selected" : ""}>None</option>
          ${BUYABLE_CATEGORIES.map((c) => `<option value="${c}" ${e.category === c ? "selected" : ""}>${c}</option>`).join("")}
        </select>
      </div>` : "";

  $("#modal-body").innerHTML = `
    ${hero}
    <div class="modal-content">
      <input class="modal-edit-title" id="modal-edit-title" value="${esc(item.title || item.raw_text || "")}" placeholder="Title" />
      ${item.url ? `<p>${link(item.url, "Open original")}</p>` : ""}
      <div class="modal-fields">${fields}</div>
      <textarea class="modal-edit-note" id="modal-edit-note" rows="2" placeholder="${isVisitKind ? "What did you think? Notes on your visit…" : "Add a note…"}">${esc(item.description || "")}</textarea>
      ${ratingRow}
      ${categoryRow}
      <div class="modal-edit-date-row">
        <label for="modal-edit-date">Date</label>
        <input type="date" class="modal-edit-date" id="modal-edit-date" value="${esc(item.due_date || "")}" />
      </div>
      <div class="modal-edit-row">
        <button class="modal-star ${isFav(item) ? "faved" : ""}" id="modal-star">${isFav(item) ? "★ Starred" : "☆ Star"}</button>
        <button id="modal-save-edit" disabled>Save</button>
        <span id="modal-edit-msg" class="muted"></span>
      </div>
      <div class="upload-row">
        <label class="btn-ghost" style="cursor:pointer;padding:6px 12px;border-radius:8px;">
          ${item.image ? "Replace photo" : (isVisitKind ? "Add a photo from your visit" : "Upload image")}
          <input type="file" id="modal-upload" accept="image/*" style="display:none">
        </label>
        <span id="modal-upload-msg" class="muted"></span>
      </div>
    </div>
    <p class="attribution">${attributionLine(item)} · ${fmtDate(item.created_at)}${
      item.status !== "active" && item.status_changed_at
        ? ` · ${item.status === "done" ? "Done" : "Archived"} ${fmtDate(item.status_changed_at)}`
        : ""}</p>
    <div class="modal-actions">
      <button class="btn-ghost" id="act-done">${isDone ? "Mark active" : "Mark done"}</button>
      <button class="btn-ghost" id="act-archive">${isArchived ? "Unarchive" : "Archive"}</button>
      <select class="move-select" id="act-move">${moveOptions}</select>
      <span class="spacer"></span>
      <button class="btn-danger" id="act-delete">Delete</button>
    </div>`;

  $("#act-done").onclick = () => applyPatch(item, { status: isDone ? "active" : "done" }, isDone ? "Marked active" : "Marked done");
  $("#act-archive").onclick = () => applyPatch(item, { status: isArchived ? "active" : "archived" }, isArchived ? "Unarchived" : "Archived");
  $("#act-move").onchange = (ev) => {
    const newId = Number(ev.target.value);
    if (newId !== item.list_id) applyPatch(item, { list_id: newId }, `Moved to ${listNameOf(newId)}`);
  };
  $("#act-delete").onclick = async () => {
    if (!confirm("Delete this item?")) return;
    // optimistic removal
    if (item.status === "active") bumpCount(item.list_id, -1);
    state.items = state.items.filter((x) => x.id !== item.id);
    state.itemsCache[state.currentListId] = state.items;
    closeModal(); renderSidebar(); renderMainPreservingScroll(); saveSnapshot(); showToast("Deleted");
    pendingWrites++;
    try {
      await api(`/api/items?id=${encodeURIComponent(item.id)}`, { method: "DELETE" });
    } catch (e) {
      showToast("Delete failed"); revalidate();
    } finally { pendingWrites--; }
  };
  $("#modal-upload").addEventListener("change", async (ev) => {
    const file = ev.target.files[0]; if (!file) return;
    $("#modal-upload-msg").textContent = "Uploading…";
    try {
      const url = await uploadImage(file);
      const prevImage = item.image;
      item.image = url;
      openModal(item); renderMainPreservingScroll(); saveSnapshot(); showToast("Image updated");
      syncPatch(item.id, { image: url }, () => { item.image = prevImage; renderMainPreservingScroll(); });
    } catch (err) { $("#modal-upload-msg").textContent = err.message; }
  });

  // Editable title + note + date + (buyable only) category
  const titleEl = $("#modal-edit-title"), noteEl = $("#modal-edit-note"), dateEl = $("#modal-edit-date"), saveBtn = $("#modal-save-edit");
  const categoryEl = $("#modal-edit-category");
  const origT = titleEl.value, origN = noteEl.value, origD = dateEl.value, origC = categoryEl ? categoryEl.value : null;
  const onEdit = () => {
    saveBtn.disabled = titleEl.value === origT && noteEl.value === origN && dateEl.value === origD
      && (!categoryEl || categoryEl.value === origC);
  };
  titleEl.addEventListener("input", onEdit);
  noteEl.addEventListener("input", onEdit);
  dateEl.addEventListener("input", onEdit);
  if (categoryEl) categoryEl.addEventListener("change", onEdit);
  saveBtn.onclick = () => {
    saveBtn.disabled = true;
    const patch = { title: titleEl.value.trim() || null, description: noteEl.value.trim() || null, due_date: dateEl.value || null };
    const prev = { title: item.title, description: item.description, due_date: item.due_date };
    item.title = patch.title; item.description = patch.description; item.due_date = patch.due_date;
    if (categoryEl) {
      prev.enriched = item.enriched;
      item.enriched = { ...(item.enriched || {}) };
      if (categoryEl.value) item.enriched.category = categoryEl.value; else delete item.enriched.category;
      patch.enriched = item.enriched;
    }
    renderMainPreservingScroll(); saveSnapshot(); showToast("Saved"); openModal(item);
    syncPatch(item.id, patch, () => { Object.assign(item, prev); renderMainPreservingScroll(); openModal(item); });
  };
  $("#modal-star").onclick = () => {
    const fav = !isFav(item);
    const prevEnriched = item.enriched;
    item.enriched = { ...(item.enriched || {}), favorite: fav };
    openModal(item); renderMainPreservingScroll(); saveSnapshot(); showToast(fav ? "Starred" : "Unstarred");
    syncPatch(item.id, { enriched: item.enriched }, () => { item.enriched = prevEnriched; renderMainPreservingScroll(); openModal(item); });
  };
  $$("#modal-my-rating .star-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const n = Number(btn.dataset.n);
      const current = (item.enriched && item.enriched.my_rating) || 0;
      const next = current === n ? 0 : n; // clicking the current rating again clears it
      const prevEnriched = item.enriched;
      item.enriched = { ...(item.enriched || {}) };
      if (next) item.enriched.my_rating = next; else delete item.enriched.my_rating;
      openModal(item); renderMainPreservingScroll(); saveSnapshot();
      showToast(next ? `Rated ${next} ${next === 1 ? "star" : "stars"}` : "Rating cleared");
      syncPatch(item.id, { enriched: item.enriched }, () => { item.enriched = prevEnriched; renderMainPreservingScroll(); openModal(item); });
    });
  });

  $("#modal").classList.remove("hidden");
}

function closeModal() { $("#modal").classList.add("hidden"); }
$("#modal-close").addEventListener("click", closeModal);
$("#modal .modal-backdrop").addEventListener("click", closeModal);

// ---------- Add-item form ----------
function openAddForm() {
  const list = currentList();
  if (!list) { alert("Select a list first."); return; }
  state.formImageUrl = null;
  state.lastFetchedUrl = "";
  $("#form-title").textContent = `Add to ${list.name}`;
  $("#f-title").value = ""; $("#f-url").value = ""; $("#f-desc").value = ""; $("#f-date").value = "";
  $("#f-category").value = "";
  $("#f-category-row").classList.toggle("hidden", list.kind !== "buyable");
  $("#f-image-file").value = "";
  $("#f-image-preview").classList.add("hidden"); $("#f-image-preview").src = "";
  $("#f-status-msg").textContent = "";
  $("#form-modal").classList.remove("hidden");
  $("#f-title").focus();
}
function closeForm() { $("#form-modal").classList.add("hidden"); }
$("#add-item-btn").addEventListener("click", openAddForm);
$$("[data-close-form]").forEach((el) => el.addEventListener("click", closeForm));

// Auto-fetch the OG preview when the URL field loses focus (valid + changed).
$("#f-url").addEventListener("blur", async () => {
  const url = $("#f-url").value.trim();
  if (!/^https?:\/\//i.test(url) || url === state.lastFetchedUrl) return;
  state.lastFetchedUrl = url;
  $("#f-status-msg").textContent = "Fetching preview…";
  try {
    const p = await api(`/api/preview?url=${encodeURIComponent(url)}`);
    if (!$("#f-title").value && p.title) $("#f-title").value = p.title;
    if (!$("#f-desc").value && p.description) $("#f-desc").value = p.description;
    if (p.image && !state.formImageUrl) {
      $("#f-image-preview").src = p.image; $("#f-image-preview").classList.remove("hidden");
      state.formImageUrl = p.image;
    }
    $("#f-status-msg").textContent = (p.title || p.image) ? "Preview loaded." : "No preview found.";
  } catch (e) { $("#f-status-msg").textContent = e.message; }
});

$("#f-image-file").addEventListener("change", async (ev) => {
  const file = ev.target.files[0]; if (!file) return;
  $("#f-status-msg").textContent = "Uploading image…";
  try {
    const url = await uploadImage(file);
    state.formImageUrl = url;
    $("#f-image-preview").src = url; $("#f-image-preview").classList.remove("hidden");
    $("#f-status-msg").textContent = "Image uploaded.";
  } catch (e) { $("#f-status-msg").textContent = e.message; }
});

$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const list = currentList(); if (!list) return;
  const title = $("#f-title").value.trim();
  const url = $("#f-url").value.trim();
  const description = $("#f-desc").value.trim();
  if (!title && !url) { $("#f-status-msg").textContent = "Give it a title or a link."; return; }
  const body = {
    list_id: list.id,
    type: url ? "link" : "text",
    title: title || null,
    url: url || null,
    description: description || null,
    image: state.formImageUrl || null,
    raw_text: (!title && !url) ? description || null : null,
    due_date: $("#f-date").value || null,
  };
  if (list.kind === "buyable" && $("#f-category").value) {
    body.enriched = { category: $("#f-category").value };
  }
  $("#f-save").disabled = true;
  try {
    const created = await api("/api/items", { method: "POST", body: JSON.stringify(body) });
    closeForm(); showToast("Added");
    if (created && created.id) {
      // slot the new row in locally — no full refetch
      state.items.unshift(created);
      state.itemsCache[state.currentListId] = state.items;
      if (created.status === "active") bumpCount(created.list_id, +1);
      renderSidebar(); renderMainPreservingScroll(); saveSnapshot();
    } else { revalidate(); }
  } catch (err) { $("#f-status-msg").textContent = err.message; }
  finally { $("#f-save").disabled = false; }
});

// ---------- Toasts ----------
function showToast(msg, undoFn) {
  const wrap = $("#toasts");
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = `<span>${esc(msg)}</span>`;
  if (undoFn) {
    const b = document.createElement("button");
    b.textContent = "Undo";
    b.onclick = async () => { clearTimeout(timer); t.remove(); await undoFn(); };
    t.appendChild(b);
  }
  wrap.appendChild(t);
  const timer = setTimeout(() => t.remove(), undoFn ? 6000 : 2500);
}

// ---------- Keyboard shortcuts ----------
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeModal(); closeForm(); return; }
  if ($("#app").classList.contains("hidden")) return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  if (e.key === "/") { e.preventDefault(); $("#search").focus(); }
  else if (e.key === "n") { e.preventDefault(); openAddForm(); }
});

// ---------- helpers ----------
function $(s) { return document.querySelector(s); }
function $$(s) { return Array.from(document.querySelectorAll(s)); }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function arr(v) { return Array.isArray(v) ? esc(v.join(", ")) : esc(v); }
function emptyHTML(msg, hint) {
  return `<div class="empty-msg">${esc(msg)}</div>` +
    (hint ? `<div class="empty-hint">${esc(hint)}</div>` : "");
}
function priceLevel(n) { return n ? "$".repeat(Math.max(1, Math.min(4, Number(n)))) : ""; }
function attributionLine(item) {
  if (item.source_message_id == null && item.added_by == null) return "Added in portal";
  if (item.added_by == null) return "Added via bot";
  return "Added by " + (USER_NAMES[item.added_by] ? esc(USER_NAMES[item.added_by]) : `User ${esc(item.added_by)}`);
}
function fmtDate(s) {
  if (!s) return "";
  try { return new Date(s).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
  catch { return ""; }
}
// Short form for card chips — no year, since these are near-term dates in practice.
function fmtDateShort(s) {
  if (!s) return "";
  try { return new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
  catch { return ""; }
}
// due_date is a plain YYYY-MM-DD (no time, no zone). Parsing that through `new Date(s)`
// reads it as UTC midnight, which `toLocaleDateString` can then shift back a day in any
// negative-UTC-offset timezone — build the display string from the parts directly instead.
function fmtDueDate(s) {
  if (!s) return "";
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return "";
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function todayIso() { return new Date().toLocaleDateString("en-CA"); } // en-CA gives YYYY-MM-DD

// ---------- boot ----------
if (pw()) showApp(); else showLogin();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
