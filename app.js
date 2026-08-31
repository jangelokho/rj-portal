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
function showApp() { $("#login").classList.add("hidden"); $("#app").classList.remove("hidden"); init().then(applyMode); }

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

  const categoryField = kind === "buyable" ? `
      <div class="modal-field-group">
        <label for="modal-edit-category">Category</label>
        <select class="modal-edit-date" id="modal-edit-category">
          <option value="" ${!e.category ? "selected" : ""}>None</option>
          ${BUYABLE_CATEGORIES.map((c) => `<option value="${c}" ${e.category === c ? "selected" : ""}>${c}</option>`).join("")}
        </select>
      </div>` : "";

  $("#modal-body").innerHTML = `
    ${hero}
    <div class="modal-content">
      <div class="modal-title-row">
        <input class="modal-edit-title" id="modal-edit-title" value="${esc(item.title || item.raw_text || "")}" placeholder="Title" />
        <button class="modal-star ${isFav(item) ? "faved" : ""}" id="modal-star" title="Favorite">${isFav(item) ? "★" : "☆"}</button>
      </div>
      ${item.url ? `<p>${link(item.url, "Open original")}</p>` : ""}
      ${fields ? `<div class="modal-fields">${fields}</div>` : ""}
      <textarea class="modal-edit-note" id="modal-edit-note" rows="2" placeholder="${isVisitKind ? "What did you think? Notes on your visit…" : "Add a note…"}">${esc(item.description || "")}</textarea>
      ${ratingRow}
      <div class="modal-meta-row">
        ${categoryField}
        <div class="modal-field-group">
          <label for="modal-edit-date">Date</label>
          <input type="date" class="modal-edit-date" id="modal-edit-date" value="${esc(item.due_date || "")}" />
        </div>
      </div>
      <div class="upload-row">
        <label class="btn-ghost upload-label">
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
      <button class="btn-danger" id="act-delete">Delete</button>
      <select class="move-select" id="act-move">${moveOptions}</select>
      <span class="spacer"></span>
      <button id="modal-save-edit" disabled>Save</button>
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

// ---------- Finances ("Bigger RJ Portal"'s second top-level mode) ----------
const MODE_KEY = "rj_mode"; // 'list' | 'finance'
state.mode = localStorage.getItem(MODE_KEY) === "finance" ? "finance" : "list";
state.finSearch = "";
state.finCategory = "all";
state.finMonth = "all";
state.finAccount = "all"; // 'all' | 'Citibank' | 'DBS' | 'Wise'
state.finSort = "date-desc"; // 'date-desc' | 'date-asc' | 'cost-desc' | 'cost-asc' | 'item-asc'
state.finShowSource = false; // whether the "· Jangelo"/"· Ria" tag is shown
state.finShowStatement = false; // whether the "· Citibank"/"· DBS"/"· Wise" tag is shown

const FIN_CATEGORY_ORDER = [
  "Food", "Groceries/Supplies", "Transportation", "Shopping",
  "Rent", "Utilities", "Entertainment", "Medicine/Health", "Other",
];
const FIN_CATEGORY_COLOR = {
  "Food": "--fin-c-food",
  "Groceries/Supplies": "--fin-c-groceries",
  "Transportation": "--fin-c-transport",
  "Shopping": "--fin-c-shopping",
  "Rent": "--fin-c-rent",
  "Utilities": "--fin-c-utilities",
  "Entertainment": "--fin-c-entertainment",
  "Medicine/Health": "--fin-c-medicine",
  "Other": "--fin-c-other",
};

function applyMode() {
  document.body.classList.toggle("mode-finance", state.mode === "finance");
  $$("#mode-switch .mode-btn").forEach((b) => b.classList.toggle("selected", b.dataset.mode === state.mode));
  if (state.mode === "finance") renderFinance(); else renderMain();
}
$$("#mode-switch .mode-btn").forEach((b) => {
  b.addEventListener("click", () => {
    if (b.dataset.mode === state.mode) return;
    state.mode = b.dataset.mode;
    localStorage.setItem(MODE_KEY, state.mode);
    applyMode();
  });
});

// idx is FINANCE_TXNS's own array position — stable across calls (unlike object
// identity, since this maps a fresh array every time) so it can key an enrichment
// lookup built from a separate finReconcile() call.
// state.finOverrides (set up further below, alongside the other Finances
// localStorage state) lets Ria correct a statement row's item text/category herself
// — e.g. a "PayLah! top-up" she knows wasn't actually food — without editing the
// source file. Merged in here so every reader of finRows() sees the correction.
function finRows() {
  const cardCount = window.FINANCE_CARD_COUNT || 0;
  return (window.FINANCE_TXNS || []).map(([date, item, category, sgd], idx) => {
    const ov = (state.finOverrides || {})[`ria:${idx}`];
    const account = idx < cardCount ? "Citibank" : "DBS";
    return { date, item: (ov && ov.item) || item, category: (ov && ov.category) || category, sgd, idx, edited: !!ov, source: "ria", account };
  });
}
// A handful of real expenses that only ever existed in the manual log — paid
// before either statement's coverage window starts, so no bank/Wise line will
// ever represent them. Ria confirmed these are genuine (e.g. the Mar 30 rent
// deposit, refundable at the end of the lease but a real cash-out expense while
// it's held) and wants them counted in Overview like any other real spend.
// Given a household-row shape + tagged source: "manual" so it's clear in the
// table that this one didn't come from a bank statement. Paired to its manual
// log row via CONFIRMED_PAIRS below so it isn't ALSO shown as "only in the log".
const MANUAL_LOG_INCLUSIONS = [
  { date: "2026-03-30", item: "Rent Deposit – 368 Thomson", category: "Rent", sgd: 2400.0 },
];
function finManualInclusionRows() {
  return MANUAL_LOG_INCLUSIONS.map((r, idx) => ({ ...r, idx, source: "manual" }));
}
// The item text as it appears in the raw source file, ignoring any override —
// used wherever code needs to recognize a SPECIFIC known statement line (e.g.
// CONSOLIDATED_GROUPS) regardless of whether Ria has since renamed it for display.
function finRawItem(r) {
  if (r.source === "ria") return (window.FINANCE_TXNS[r.sourceIdx] || [])[1];
  if (r.source === "jangelo") return (window.JANGELO_TXNS[r.sourceIdx] || [])[1];
  return r.item;
}
// Ria's + Jangelo's statements merged into one pool — the "most true expenses in
// SG" picture, per Ria, since it's what actually left an account rather than what
// made it into the manual log (which stays untouched — this only merges the two
// STATEMENT sources, not the sheet). Used by Overview AND Consolidate now, so
// there's one combined reconciliation instead of a confusing per-person toggle.
// idx is reassigned to a position unique across the WHOLE combined array (Ria's
// rows keep the same value they already had, since she's placed first) so every
// existing idx-keyed lookup — matching, enrichment, confirm/dismiss keys — stays
// collision-free without needing source-aware key changes. sourceIdx keeps each
// row's original per-source position, for the few things still scoped to Ria/
// Jangelo only (the Edit button, category/item overrides) — the small set of
// manual-log inclusions aren't editable this way, they're a fixed confirmed list.
function finHouseholdRows() {
  const combined = [
    ...finRows().map((r) => ({ ...r, sourceIdx: r.idx })),
    ...finJangeloRows().map((r) => ({ ...r, source: "jangelo", sourceIdx: r.idx })),
    ...finManualInclusionRows().map((r) => ({ ...r, sourceIdx: r.idx })),
  ];
  combined.forEach((r, i) => { r.idx = i; });
  return combined;
}
function finFmtSGD(n) {
  const sign = n < 0 ? "-" : "";
  return `${sign}S$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function finFmtPHP(n) {
  const sign = n < 0 ? "-" : "";
  return `${sign}₱${Math.abs(n * (window.FX_RATE || 1)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function finFmtMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}
function finFmtMonthShort(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "short" });
}
function finFmtDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Matches the RJ Bahay sheet's own columns (Month, Year, Date, Item, Category,
// Cost) so the rows can be pasted straight into it — Cost is a plain number, not a
// "$ 12.34" string, so it lands as a real number in Excel/Sheets, not text.
function finExportXlsx(rows, filename) {
  if (!window.XLSX) { alert("The export library didn't load (check your connection) — try again in a moment."); return; }
  const data = rows.map((r) => {
    const [y, m] = r.date.split("-").map(Number);
    const status = r.source === "jangelo" ? "Paid by Jangelo" : "Paid by Iestin";
    return { Month: m, Year: y, Date: finFmtDate(r.date), Item: r.item, Category: r.category, Cost: r.sgd, Status: status };
  });
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Missing entries");
  XLSX.writeFile(wb, filename);
}

function finAggregate(rows) {
  const byCategory = {}, byMonth = {};
  let total = 0, minDate = null, maxDate = null;
  for (const r of rows) {
    total += r.sgd;
    byCategory[r.category] = (byCategory[r.category] || 0) + r.sgd;
    const ym = r.date.slice(0, 7);
    byMonth[ym] = (byMonth[ym] || 0) + r.sgd;
    if (!minDate || r.date < minDate) minDate = r.date;
    if (!maxDate || r.date > maxDate) maxDate = r.date;
  }
  return { total, byCategory, byMonth, minDate, maxDate };
}

function finCategoryChart(byCategory, total) {
  const entries = FIN_CATEGORY_ORDER
    .map((cat) => ({ cat, value: byCategory[cat] || 0 }))
    .filter((e) => e.value !== 0)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  if (!entries.length) return `<div class="fin-empty">No category data.</div>`;
  const max = Math.max(1, ...entries.map((e) => Math.abs(e.value)));
  return `<div class="fin-hbar-chart">${entries.map((e) => {
    const pct = total ? (e.value / total) * 100 : 0;
    const w = Math.max(2, (Math.abs(e.value) / max) * 100);
    const colorVar = FIN_CATEGORY_COLOR[e.cat] || "--fin-c-other";
    return `
      <div class="fin-hbar-row" title="${esc(e.cat)}: ${esc(finFmtSGD(e.value))} (${pct.toFixed(1)}%)">
        <span class="fin-hbar-label"><span class="fin-cat-swatch" style="background:var(${colorVar})"></span>${esc(e.cat)}</span>
        <div class="fin-hbar-track"><div class="fin-hbar-fill" style="width:${w}%;background:var(${colorVar})"></div></div>
        <span class="fin-hbar-value">${esc(finFmtSGD(e.value))}</span>
      </div>`;
  }).join("")}</div>`;
}

// Each column is clickable — sets the month filter (wired in renderFinance) so the
// transaction table AND the category breakdown drill into that one month.
function finMonthlyChart(byMonth, selectedMonth) {
  const months = Object.keys(byMonth).sort();
  if (!months.length) return `<div class="fin-empty">No monthly data.</div>`;
  const max = Math.max(1, ...months.map((m) => Math.abs(byMonth[m])));
  return `<div class="fin-vbar-chart">${months.map((m) => {
    const v = byMonth[m];
    const h = Math.max(2, (Math.abs(v) / max) * 100);
    return `
      <div class="fin-vbar-col${m === selectedMonth ? " selected" : ""}" data-month="${m}" title="${esc(finFmtMonth(m))}: ${esc(finFmtSGD(v))} — click to filter">
        <div class="fin-vbar-value">${finFmtSGD(v).replace("S$", "")}</div>
        <div class="fin-vbar-track"><div class="fin-vbar-fill" style="height:${h}%"></div></div>
        <div class="fin-vbar-label">${esc(finFmtMonthShort(m))}</div>
      </div>`;
  }).join("")}</div>`;
}

function finCategorySummaryTable(byCategory, total) {
  const entries = FIN_CATEGORY_ORDER
    .map((cat) => ({ cat, value: byCategory[cat] || 0 }))
    .filter((e) => e.value !== 0)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return `
    <table class="fin-summary-table">
      <thead><tr><th>Category</th><th>SGD</th><th>PHP</th><th>%</th></tr></thead>
      <tbody>${entries.map((e) => `
        <tr>
          <td><span class="fin-cat-name"><span class="fin-cat-swatch" style="background:var(${FIN_CATEGORY_COLOR[e.cat] || "--fin-c-other"})"></span>${esc(e.cat)}</span></td>
          <td class="fin-num">${esc(finFmtSGD(e.value))}</td>
          <td class="fin-num">${esc(finFmtPHP(e.value))}</td>
          <td class="fin-num">${(total ? (e.value / total) * 100 : 0).toFixed(1)}%</td>
        </tr>`).join("")}</tbody>
      <tfoot><tr><td>Total</td><td class="fin-num">${esc(finFmtSGD(total))}</td><td class="fin-num">${esc(finFmtPHP(total))}</td><td class="fin-num">100%</td></tr></tfoot>
    </table>`;
}

function finMonthlySummaryTable(byMonth, total, selectedMonth) {
  const months = Object.keys(byMonth).sort();
  return `
    <table class="fin-summary-table fin-summary-table-clickable">
      <thead><tr><th>Month</th><th>SGD</th><th>PHP</th></tr></thead>
      <tbody>${months.map((m) => `
        <tr data-month="${m}" class="${m === selectedMonth ? "selected" : ""}">
          <td>${esc(finFmtMonth(m))}</td>
          <td class="fin-num">${esc(finFmtSGD(byMonth[m]))}</td>
          <td class="fin-num">${esc(finFmtPHP(byMonth[m]))}</td>
        </tr>`).join("")}</tbody>
      <tfoot><tr><td>Total</td><td class="fin-num">${esc(finFmtSGD(total))}</td><td class="fin-num">${esc(finFmtPHP(total))}</td></tr></tfoot>
    </table>`;
}

// Merchants you keep going back to — grouped by exact item text (already
// normalized to one spelling per merchant earlier this session) within
// spend-y categories only. Rent/transfers/subscriptions are excluded since
// "recurring" there just means a bill, not a place you actually chose to
// revisit. Needs 3+ visits to count as a "regular", not a coincidence.
const FIN_REGULARS_CATEGORIES = ["Food", "Groceries/Supplies", "Shopping", "Entertainment", "Medicine/Health"];
// Not real merchants, just a payment rail — "PayLah! top-up" is Ria reloading her
// own wallet, tagged Food only because that's usually what the top-up went toward.
const FIN_REGULARS_EXCLUDE = /^paylah! top-up$/i;
function finRegulars(rows) {
  const byMerchant = {};
  for (const r of rows) {
    if (!FIN_REGULARS_CATEGORIES.includes(r.category)) continue;
    if (FIN_REGULARS_EXCLUDE.test(r.item)) continue;
    const key = r.item;
    const m = (byMerchant[key] ||= { item: key, category: r.category, count: 0, total: 0 });
    m.count++;
    m.total += r.sgd;
  }
  return Object.values(byMerchant)
    .filter((m) => m.count >= 3)
    .sort((a, b) => b.count - a.count || b.total - a.total);
}
function finRegularsTable(regulars) {
  if (!regulars.length) return `<div class="fin-empty">No repeat merchants yet — need 3+ visits to count as a regular.</div>`;
  return `
    <table class="fin-summary-table fin-summary-table-clickable">
      <thead><tr><th>Merchant</th><th>Visits</th><th class="fin-num">Total</th></tr></thead>
      <tbody>${regulars.slice(0, 8).map((m) => `
        <tr data-merchant="${esc(m.item)}" class="${state.finSearch === m.item ? "selected" : ""}">
          <td><span class="fin-cat-name"><span class="fin-cat-swatch" style="background:var(${FIN_CATEGORY_COLOR[m.category] || "--fin-c-other"})"></span>${esc(m.item)}</span></td>
          <td class="fin-num">${m.count}×</td>
          <td class="fin-num">${esc(finFmtSGD(m.total))}</td>
        </tr>`).join("")}</tbody>
    </table>`;
}

// enrichMap is optional (Consolidate needs manual log data to exist at all) — when
// present, search also matches the enriched display text (e.g. "Grab To Gerrys"),
// not just the raw generic statement text ("PayNow transfer (personal)") it's
// standing in for. Without this, a search for exactly what the table shows you
// could still turn up nothing.
function finFilteredRows(enrichMap) {
  const q = state.finSearch.trim().toLowerCase();
  const all = finHouseholdRows();
  return all.filter((r) => {
    if (state.finCategory !== "all" && r.category !== state.finCategory) return false;
    if (state.finMonth !== "all" && r.date.slice(0, 7) !== state.finMonth) return false;
    if (state.finAccount !== "all" && r.account !== state.finAccount) return false;
    if (q) {
      const displayItem = (enrichMap && enrichMap.get(r.idx)) || r.item;
      if (!r.item.toLowerCase().includes(q) && !displayItem.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

function finTransactionTable(rows, enrichMap) {
  if (!rows.length) return `<div class="fin-empty">No transactions match this filter.</div>`;
  const sorted = [...rows].sort((a, b) => {
    if (state.finSort === "cost-desc") return b.sgd - a.sgd;
    if (state.finSort === "cost-asc") return a.sgd - b.sgd;
    if (state.finSort === "item-asc") return a.item.localeCompare(b.item);
    if (state.finSort === "date-asc") return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    return b.date < a.date ? -1 : b.date > a.date ? 1 : 0;
  });
  return `
    <div class="fin-scroll">
      <table class="fin-table">
        <thead><tr><th>Date</th><th>Item</th><th>Category</th><th class="fin-num">Cost</th><th></th></tr></thead>
        <tbody>${sorted.map((r) => {
          // Prefer the manual log's item text over a statement line that's just the
          // payment rail with no merchant name (a masked PayNow recipient, etc.) —
          // enrichMap is keyed by the household-wide idx now, so this works for
          // either source. Editing (Edit button, overrides) works for both sources
          // now, each keyed by its own source + sourceIdx.
          const displayItem = (enrichMap && enrichMap.get(r.idx)) || r.item;
          return `
          <tr data-idx="${r.sourceIdx}" data-source="${r.source}">
            <td>${esc(finFmtDate(r.date))}</td>
            <td>${esc(displayItem)}${finSourceTag(r)}${r.edited ? ` <span class="fin-edited-tag">(edited)</span>` : ""}</td>
            <td><span class="fin-cat-name"><span class="fin-cat-swatch" style="background:var(${FIN_CATEGORY_COLOR[r.category] || "--fin-c-other"})"></span>${esc(r.category)}</span></td>
            <td class="fin-num">${esc(finFmtSGD(r.sgd))}</td>
            <td>${r.source === "manual" ? "" : `<button class="fin-edit-btn" data-idx="${r.sourceIdx}" data-source="${r.source}">Edit</button>`}</td>
          </tr>`;
        }).join("")}</tbody>
      </table>
    </div>`;
}

// Swaps one row into an inline item/category editor in place — a full renderFinance()
// would also be fine, but this keeps the edit action from feeling like the whole
// page reset while she's mid-correction.
function finEditRowForm(row) {
  const options = FIN_CATEGORY_ORDER.map((c) => `<option value="${c}" ${row.category === c ? "selected" : ""}>${esc(c)}</option>`).join("");
  return {
    itemCell: `<input type="text" class="fin-edit-item" value="${esc(row.item)}" />`,
    categoryCell: `<select class="fin-edit-category">${options}</select>`,
    actionsCell: `<button class="fin-edit-save">Save</button><button class="btn-ghost fin-edit-cancel">Cancel</button>${row.edited ? `<button class="btn-ghost fin-edit-reset">Reset</button>` : ""}`,
  };
}

// ---------- Smart summary: everyday vs one-off vs transfers ----------
const EVERYDAY_CATEGORIES = ["Food", "Groceries/Supplies", "Transportation"];
const DISCRETIONARY_CATEGORIES = ["Shopping", "Entertainment", "Medicine/Health"];

// Some "Other"-category rows are really transfers between accounts/people (Wise, ATM
// cash, bank-to-bank, a large one-off PayNow to a named person) rather than
// consumption — left inside "Other" for the main table since that's still the truest
// category, but split out here so one big transfer doesn't read as a spending spike.
function finIsTransferLike(row) {
  if (row.category !== "Other") return false;
  if (/wise|atm withdrawal|i-bank transfer|maribank/i.test(row.item)) return true;
  return row.sgd >= 200;
}
function finBucket(row) {
  if (row.category === "Rent") return "rent";
  if (EVERYDAY_CATEGORIES.includes(row.category)) return "everyday";
  if (DISCRETIONARY_CATEGORIES.includes(row.category)) return "discretionary";
  if (finIsTransferLike(row)) return "transfer";
  return "misc";
}
function finBucketBreakdown(rows) {
  const out = { rent: 0, everyday: 0, discretionary: 0, transfer: 0, misc: 0 };
  for (const r of rows) out[finBucket(r)] += r.sgd;
  return out;
}

// Auto-generated from real numbers each render — not a live AI call, just template
// sentences over computed aggregates. Explains whichever month is the spending peak
// (today that's August) rather than hardcoding which month to call out.
function finInsights(all, byMonth) {
  const months = Object.keys(byMonth).sort();
  if (!months.length) return "";
  const totals = months.map((m) => ({ m, total: byMonth[m].reduce((s, r) => s + r.sgd, 0) }));
  const top = totals.reduce((a, b) => (b.total > a.total ? b : a));
  const others = totals.filter((t) => t.m !== top.m);
  const othersAvg = others.length ? others.reduce((s, t) => s + t.total, 0) / others.length : 0;
  const topRows = byMonth[top.m];
  const overallTotal = all.reduce((s, r) => s + r.sgd, 0);
  const bucket = finBucketBreakdown(all);
  const bucketTop = finBucketBreakdown(topRows);
  const biggest = [...topRows].sort((a, b) => b.sgd - a.sgd).slice(0, 5);
  const biggestSum = biggest.reduce((s, r) => s + r.sgd, 0);
  const pct = (n) => (overallTotal ? ((n / overallTotal) * 100).toFixed(0) : "0");

  const catFlags = [];
  for (const cat of FIN_CATEGORY_ORDER) {
    const topVal = topRows.filter((r) => r.category === cat).reduce((s, r) => s + r.sgd, 0);
    const otherVals = others.map((t) => byMonth[t.m].filter((r) => r.category === cat).reduce((s, r) => s + r.sgd, 0));
    const otherAvg = otherVals.length ? otherVals.reduce((s, v) => s + v, 0) / otherVals.length : 0;
    if (topVal > 0 && otherAvg > 0 && topVal > otherAvg * 1.3 && topVal - otherAvg > 100) catFlags.push({ cat, topVal, otherAvg });
  }

  const open = state.finShowInsights;
  return `
    <div class="fin-card fin-insights">
      <div class="fin-card-head">
        <h3>Smart summary</h3>
        <button id="fin-insights-toggle" class="fin-insights-toggle">${open ? "Hide" : "Show"}</button>
      </div>
      ${open ? `
      <p>Across ${months.length} months (${esc(finFmtMonth(months[0]))}–${esc(finFmtMonth(months[months.length - 1]))}) that's <strong>${esc(finFmtSGD(overallTotal))}</strong> total. Split by what it actually is: <strong>${esc(finFmtSGD(bucket.rent))}</strong> rent (${pct(bucket.rent)}%), <strong>${esc(finFmtSGD(bucket.everyday))}</strong> everyday food/groceries/transport (${pct(bucket.everyday)}%), <strong>${esc(finFmtSGD(bucket.discretionary))}</strong> discretionary shopping/entertainment/health (${pct(bucket.discretionary)}%), and <strong>${esc(finFmtSGD(bucket.transfer))}</strong> transfers or cash movement between accounts — not day-to-day spending (${pct(bucket.transfer)}%).</p>
      <p><strong>${esc(finFmtMonth(top.m))}</strong> is your highest month at <strong>${esc(finFmtSGD(top.total))}</strong>${othersAvg ? `, ${(((top.total - othersAvg) / othersAvg) * 100).toFixed(0)}% above the ${esc(finFmtSGD(othersAvg))} average of the other months` : ""}. Its 5 biggest transactions alone are ${esc(finFmtSGD(biggestSum))} (${top.total ? ((biggestSum / top.total) * 100).toFixed(0) : 0}% of the month):</p>
      <ul class="fin-insight-list">
        ${biggest.map((r) => `<li>${esc(finFmtDate(r.date))} — ${esc(r.item)}, ${esc(finFmtSGD(r.sgd))}</li>`).join("")}
      </ul>
      ${catFlags.length ? `<p>Worth a second look: ${catFlags.map((f) => `<strong>${esc(f.cat)}</strong> ran ${esc(finFmtSGD(f.topVal))} vs a usual ${esc(finFmtSGD(f.otherAvg))}`).join("; ")} — check neither is a duplicate or unexpected charge.</p>` : ""}
      ${bucketTop.transfer > 0 ? `<p class="fin-consolidate-note">${esc(finFmtSGD(bucketTop.transfer))} of ${esc(finFmtMonth(top.m))}'s total is transfers (Wise, ATM cash, bank-to-bank), not spending — the real day-to-day increase is smaller than the headline number suggests.</p>` : ""}
      ` : ""}
    </div>`;
}

// ---------- Income vs Expenses ----------
function finIncomeRows() {
  return (window.INCOME_TXNS || []).map(([date, item, sgd]) => ({ date, item, sgd }));
}

function finIncomeExpenseTab() {
  // Deliberately Ria's own statement only (not the household total) — income here
  // is only ever her own salary, so netting it against Jangelo's Wise spend too
  // would subtract money that never touched her DBS account in the first place,
  // making "Net" meaningless against her actual bank balance.
  const income = finIncomeRows();
  const expenses = finRows();
  const months = [...new Set([...income.map((r) => r.date.slice(0, 7)), ...expenses.map((r) => r.date.slice(0, 7))])].sort();
  const incomeByMonth = {}, expenseByMonth = {};
  for (const r of income) incomeByMonth[r.date.slice(0, 7)] = (incomeByMonth[r.date.slice(0, 7)] || 0) + r.sgd;
  for (const r of expenses) expenseByMonth[r.date.slice(0, 7)] = (expenseByMonth[r.date.slice(0, 7)] || 0) + r.sgd;
  const totalIncome = income.reduce((s, r) => s + r.sgd, 0);
  const totalExpense = expenses.reduce((s, r) => s + r.sgd, 0);
  const net = totalIncome - totalExpense;
  const maxVal = Math.max(1, ...months.map((m) => Math.max(incomeByMonth[m] || 0, expenseByMonth[m] || 0)));
  const netColor = (n) => (n >= 0 ? "var(--ok)" : "var(--danger)");

  return `
    <div class="fin-kpis">
      <div class="fin-kpi"><div class="fin-kpi-label">Total income</div><div class="fin-kpi-value">${esc(finFmtSGD(totalIncome))}</div><div class="fin-kpi-sub">${esc(finFmtPHP(totalIncome))}</div></div>
      <div class="fin-kpi"><div class="fin-kpi-label">Total expenses</div><div class="fin-kpi-value">${esc(finFmtSGD(totalExpense))}</div><div class="fin-kpi-sub">${esc(finFmtPHP(totalExpense))}</div></div>
      <div class="fin-kpi"><div class="fin-kpi-label">Net</div><div class="fin-kpi-value" style="color:${netColor(net)}">${net >= 0 ? "+" : ""}${esc(finFmtSGD(net))}</div><div class="fin-kpi-sub">${net >= 0 ? "saved" : "over"} across ${months.length} months</div></div>
      <div class="fin-kpi"><div class="fin-kpi-label">Savings rate</div><div class="fin-kpi-value">${totalIncome ? ((net / totalIncome) * 100).toFixed(0) : 0}%</div><div class="fin-kpi-sub">of income kept</div></div>
    </div>
    <div class="fin-card">
      <h3>Income vs expenses, by month</h3>
      <p class="fin-consolidate-note">Income is bucketed by the month it landed in your DBS account — HitPay pays in arrears (the Aug credit is for July's work), not the month it was earned.</p>
      <div class="fin-ie-chart">
        ${months.map((m) => {
          const inc = incomeByMonth[m] || 0, exp = expenseByMonth[m] || 0;
          const incH = inc ? Math.max(2, (inc / maxVal) * 100) : 0;
          const expH = exp ? Math.max(2, (exp / maxVal) * 100) : 0;
          const monthNet = inc - exp;
          return `
            <div class="fin-ie-col" title="${esc(finFmtMonth(m))}: income ${esc(finFmtSGD(inc))}, expenses ${esc(finFmtSGD(exp))}">
              <div class="fin-ie-bars">
                <div class="fin-ie-bar fin-ie-income" style="height:${incH}%"></div>
                <div class="fin-ie-bar fin-ie-expense" style="height:${expH}%"></div>
              </div>
              <div class="fin-ie-net" style="color:${netColor(monthNet)}">${monthNet >= 0 ? "+" : ""}${finFmtSGD(monthNet).replace("S$", "")}</div>
              <div class="fin-ie-label">${esc(finFmtMonthShort(m))}</div>
            </div>`;
        }).join("")}
      </div>
      <div class="fin-ie-legend">
        <span><span class="fin-cat-swatch" style="background:var(--ok)"></span>Income</span>
        <span><span class="fin-cat-swatch" style="background:var(--danger)"></span>Expenses</span>
      </div>
      <table class="fin-summary-table">
        <thead><tr><th>Month</th><th>Income</th><th>Expenses</th><th>Net</th></tr></thead>
        <tbody>${months.map((m) => {
          const inc = incomeByMonth[m] || 0, exp = expenseByMonth[m] || 0, n = inc - exp;
          return `<tr><td>${esc(finFmtMonth(m))}</td><td class="fin-num">${esc(finFmtSGD(inc))}</td><td class="fin-num">${esc(finFmtSGD(exp))}</td><td class="fin-num" style="color:${netColor(n)}">${n >= 0 ? "+" : ""}${esc(finFmtSGD(n))}</td></tr>`;
        }).join("")}</tbody>
        <tfoot><tr><td>Total</td><td class="fin-num">${esc(finFmtSGD(totalIncome))}</td><td class="fin-num">${esc(finFmtSGD(totalExpense))}</td><td class="fin-num" style="color:${netColor(net)}">${net >= 0 ? "+" : ""}${esc(finFmtSGD(net))}</td></tr></tfoot>
      </table>
    </div>`;
}

// ---------- Consolidate: reconcile the combined statement data against the manual log ----------
state.finTab = "overview"; // 'overview' | 'income' | 'statements' | 'consolidate'
state.finShowInsights = true;

// Real money movements that would double-count (a bill payment settling
// purchases already itemized elsewhere) or aren't a household expense at all (an
// internal transfer between the household's own accounts) — left out of each
// account's main Debit/Credit totals in the Statements tab, but listed here so
// they're shown as their own caveat breakdown instead of silently vanishing.
// The Aug 5 transfer appears on BOTH sides (a DBS debit, a Wise credit) since
// it's the same real transaction — "everything should be there" per Ria, just
// not folded into either side's main total.
const STATEMENT_CAVEATS = [
  { account: "DBS", direction: "debit", date: "2026-07-07", desc: "Citibank card payment — settles the Jun statement", amount: 80.00 },
  { account: "DBS", direction: "debit", date: "2026-08-07", desc: "Citibank card payment — settles the Jul statement", amount: 780.00 },
  { account: "DBS", direction: "debit", date: "2026-08-05", desc: "PayNow – Wise Asia-Pacific (transfer to Jangelo, allowance-style)", amount: 1000.00 },
  { account: "Wise", direction: "credit", date: "2026-08-05", desc: "Received money from Ria (the DBS transfer above)", amount: 1000.00 },
  { account: "Wise", direction: "credit", date: "2026-04-15", desc: "PHP → SGD conversion (₱141,716.38 → S$3,000.00)", amount: 3000.00 },
  { account: "Wise", direction: "credit", date: "2026-06-04", desc: "PHP → SGD conversion (₱80,000.00 → S$1,662.03)", amount: 1662.03 },
  // Known from Jangelo's statement export notes but never captured as a dated
  // data row — flagged rather than guessing a date, so it doesn't silently
  // disappear from "everything should be there".
  { account: "Wise", direction: "credit", date: null, desc: "Received money from Alyssa Karin Pang (repayment/gift) — date not on record", amount: 100.00 },
];

function finStatementsTab() {
  const rows = finRows();
  const jRows = finJangeloRows();
  const incomeTotal = finIncomeRows().reduce((s, r) => s + r.sgd, 0);
  const netColor = (n) => (n >= 0 ? "var(--ok)" : "var(--danger)");

  function summarize(account, accountRows, extraCredit) {
    const debit = accountRows.filter((r) => r.sgd > 0).reduce((s, r) => s + r.sgd, 0);
    const refundCredit = accountRows.filter((r) => r.sgd < 0).reduce((s, r) => s - r.sgd, 0);
    const credit = refundCredit + (extraCredit || 0);
    return { account, debit, credit, net: credit - debit, caveats: STATEMENT_CAVEATS.filter((c) => c.account === account) };
  }

  const accounts = [
    summarize("Citibank", rows.filter((r) => r.account === "Citibank"), 0),
    summarize("DBS", rows.filter((r) => r.account === "DBS"), incomeTotal),
    summarize("Wise", jRows, 0),
  ];

  return `
    <p class="fin-consolidate-note">Per-account totals straight from the raw statement data. "Net" is the movement captured here (Credit − Debit) — not your real account balance, since no opening balance is tracked.</p>
    ${accounts.map((a) => `
      <div class="fin-card" style="margin-bottom:16px;">
        <h3>${esc(a.account)}</h3>
        <div class="fin-kpis" style="margin-bottom:${a.caveats.length ? "12px" : "0"};">
          <div class="fin-kpi"><div class="fin-kpi-label">Debit</div><div class="fin-kpi-value">${esc(finFmtSGD(a.debit))}</div></div>
          <div class="fin-kpi"><div class="fin-kpi-label">Credit</div><div class="fin-kpi-value">${esc(finFmtSGD(a.credit))}</div></div>
          <div class="fin-kpi"><div class="fin-kpi-label">Net</div><div class="fin-kpi-value" style="color:${netColor(a.net)}">${a.net >= 0 ? "+" : ""}${esc(finFmtSGD(a.net))}</div></div>
        </div>
        ${a.caveats.length ? `
        <p class="fin-consolidate-note">Not counted above — real money movements that would double-count elsewhere, or aren't a household expense:</p>
        <ul class="fin-cc-list">
          ${a.caveats.map((c) => `<li>${c.date ? esc(finFmtDate(c.date)) + " — " : ""}${esc(c.desc)}, ${c.direction === "debit" ? "-" : "+"}${esc(finFmtSGD(c.amount))}</li>`).join("")}
        </ul>` : ""}
      </div>`).join("")}`;
}

// Rounded-up Citibank card payments, found as "BILL CCC" lines in the DBS history —
// excluded from FINANCE_TXNS itself (they'd double-count the card's own itemized
// purchases) but surfaced here since Ria asked whether she'd separately logged the
// payment itself.
const CC_BILL_PAYMENTS = [
  { date: "2026-07-07", desc: "Citibank card payment — settles the Jun statement ($79.50 balance)", amount: 80.00 },
  { date: "2026-08-07", desc: "Citibank card payment — settles the Jul statement ($779.54 balance)", amount: 780.00 },
];

// Real money out of the DBS account, deliberately left out of FINANCE_TXNS because
// it isn't a household expense — kept visible here (same treatment as the CC bill
// payments above) rather than disappearing entirely.
const EXCLUDED_TRANSFERS = [
  { date: "2026-08-05", desc: "Wise Asia-Pacific — transfer to Jangelo (allowance-style, not a household expense)", amount: 1000.00 },
  { date: "2026-04-15", desc: "Jangelo — PHP → SGD conversion (₱141,716.38 → S$3,000.00)", amount: 3000.00 },
  { date: "2026-06-04", desc: "Jangelo — PHP → SGD conversion (₱80,000.00 → S$1,662.03)", amount: 1662.03 },
];

// Days Ria logged ONE lump manual entry instead of each individual purchase — a
// many-statement-rows-to-one-manual-row sum, which the pairwise matcher can't find
// on its own (it only ever pairs one row to one row). Ria confirms these directly
// rather than this being auto-detected — add more here as she lists them.
// Verified: 50 + 64 + 9 + 15 + 37.5 + 36 + 68 + 58 = 337.50 exactly.
const CONSOLIDATED_GROUPS = [
  {
    manualDate: "2026-08-22", manualItem: "pop toy art stuff", manualCost: 337.50,
    members: [
      { date: "2026-08-22", item: "PayNow – Pigeoncrafts", sgd: 50.00 },
      { date: "2026-08-22", item: "PayNow – Wise Asia-Pacific", sgd: 64.00 },
      { date: "2026-08-22", item: "PayNow transfer (personal)", sgd: 9.00 },
      { date: "2026-08-22", item: "PayNow – Wise Asia-Pacific", sgd: 15.00 },
      { date: "2026-08-22", item: "PayNow transfer (personal)", sgd: 37.50 },
      { date: "2026-08-22", item: "PayNow transfer (personal)", sgd: 36.00 },
      { date: "2026-08-22", item: "PayNow transfer (personal)", sgd: 68.00 },
      { date: "2026-08-22", item: "PayNow transfer (personal)", sgd: 58.00 },
    ],
  },
];

// 1:1 pairs Ria confirmed directly, where the amount gap is bigger than the
// near-amount tier allows (>50 cents) so the matcher would never surface them on
// its own. Treated as certain, same as a strict match — not put in a review list.
const CONFIRMED_PAIRS = [
  {
    statementDate: "2026-08-01", statementItem: "Tiong Bahru Bakery", statementSgd: 16.79,
    manualDate: "2026-08-01", manualItem: "tiong bahru bakery",
  },
  {
    statementDate: "2026-04-15", statementItem: "Zheng Yan", statementSgd: 2400.0,
    manualDate: "2026-04-23", manualItem: "368 thomson rent - april 2026",
  },
  {
    statementDate: "2026-08-14", statementItem: "PayNow – rent (recurring)", statementSgd: 2400.0,
    manualDate: "2026-08-02", manualItem: "368 thomson rent - august 2026",
  },
];
// Note: the Mar 30 rent deposit (see MANUAL_LOG_INCLUSIONS above) doesn't need an
// entry here — same date + same exact amount means the plain strict matcher
// (tryMatch(0)) already pairs it with its manual log row on its own.

function finDaysApart(a, b) { return Math.abs((new Date(a) - new Date(b)) / 86400000); }
function finManualRows() {
  return (window.MANUAL_TXNS || []).map(([date, item, category, cost, status], idx) => ({ date, item, category, cost, status, idx }));
}

// Word-overlap check (words of 4+ letters, so "the"/"and"/"m1" don't count as a
// match) — the signal that separates a genuine same-purchase pair ("Fairprice
// pasalubong" / "Fairprice Finest") from a same-amount coincidence ("MR DIY" /
// "Lunch Chiken" both happening to cost $11.90). Words this common in Ria's own
// vocabulary ("jixiong" is her go-to hawker stall, "lunch"/"chicken"/"busmrt" recur
// constantly) aren't a signal either — two different $5 "jixiong lunch"es on
// different days aren't the same purchase just because they share those words.
const FIN_TOKEN_STOPWORDS = new Set([
  "lunch", "dinner", "jixiong", "grab", "chicken", "food", "busmrt", "bus", "fish",
  "soup", "hawker", "thomson", "curry", "coffee", "drinks", "breakfast",
]);
function finTokens(s) {
  return new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    .filter((w) => w.length >= 4 && !FIN_TOKEN_STOPWORDS.has(w)));
}
function finSharesToken(a, b) {
  const tb = finTokens(b);
  for (const t of finTokens(a)) if (tb.has(t)) return true;
  return false;
}
// "M1 Mobile Subscription - Iestin" and "... - Jang" are two different people's own
// subscriptions, not the same bill logged twice — never treat those as duplicates
// of each other regardless of how much text they share.
// Not used as a match filter — per Ria, the "Paid by"/who-logged-it status isn't a
// reliable boundary (either of them logs either of their own purchases, and either
// of them might cover a shared expense on their own card/account) — so a manual
// entry's status never excludes it as a candidate for either statement. Amount +
// date + word-overlap do the real filtering; the review tiers exist to catch what
// that gets wrong.

function finDifferentPerson(a, b) {
  // Ria refers to herself as both "Iestin" and "Ria" in her own item text (e.g.
  // "Night Safari Grab Jang" next to "Night Safari Grab Ria" — two separate rides,
  // not one trip logged twice) — either counts as "her".
  const isRia = (s) => /iestin|\bria\b/i.test(s), isJang = (s) => /\bjang(elo)?\b/i.test(s);
  return (isRia(a) && isJang(b) && !isJang(a) && !isRia(b))
    || (isJang(a) && isRia(b) && !isRia(a) && !isJang(b));
}

// Confirmations from the "possible matches"/"possible duplicates" review lists are
// judgment calls only Ria can make (a same-amount coincidence looks identical to a
// real match on paper) — persisted client-side since this static app has nowhere
// else to keep them. Dismissals are the opposite call ("no, that's a different,
// separate purchase") — kept in their own set so a dismissed pair never confirms
// itself back in through the "consolidate all shown" bulk button.
const FIN_CONFIRMED_KEY = "rj_fin_confirmed";
const FIN_DISMISSED_KEY = "rj_fin_dismissed";
function finLoadSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || "[]")); } catch { return new Set(); }
}
function finSaveSet(key, set) {
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch { /* private mode / quota */ }
}
state.finConfirmed = finLoadSet(FIN_CONFIRMED_KEY);
state.finDismissed = finLoadSet(FIN_DISMISSED_KEY);

// Per-row corrections to a statement transaction's item text/category — e.g. "I
// don't actually know what this PayLah top-up was for" — made directly in the
// Overview table instead of asking for a source-file edit each time.
const FIN_OVERRIDES_KEY = "rj_fin_overrides";
function finLoadOverrides() {
  let raw;
  try { raw = JSON.parse(localStorage.getItem(FIN_OVERRIDES_KEY) || "{}"); } catch { return {}; }
  // One-time migration: overrides saved before Jangelo's rows became editable were
  // keyed by bare index (no source prefix). Without this they'd silently stop
  // showing up the moment the newer, source-prefixed lookup shipped — every key
  // back then was necessarily Ria's, so they migrate straight to "ria:<idx>".
  let migrated = false;
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (/^\d+$/.test(key)) { out[`ria:${key}`] = val; migrated = true; }
    else out[key] = val;
  }
  if (migrated) {
    try { localStorage.setItem(FIN_OVERRIDES_KEY, JSON.stringify(out)); } catch { /* private mode / quota */ }
  }
  return out;
}
function finSaveOverrides() {
  try { localStorage.setItem(FIN_OVERRIDES_KEY, JSON.stringify(state.finOverrides)); } catch { /* private mode / quota */ }
}
state.finOverrides = finLoadOverrides();
function finSetOverride(source, idx, patch) {
  const key = `${source}:${idx}`;
  state.finOverrides[key] = { ...(state.finOverrides[key] || {}), ...patch };
  finSaveOverrides();
}
function finClearOverride(source, idx) { delete state.finOverrides[`${source}:${idx}`]; finSaveOverrides(); }
// Mutually exclusive — confirming a pair un-dismisses it and vice versa, so a
// previously-confirmed match can still be corrected later via Split, and undoing
// that isn't a dead end either.
function finConfirm(key) {
  state.finConfirmed.add(key); state.finDismissed.delete(key);
  finSaveSet(FIN_CONFIRMED_KEY, state.finConfirmed); finSaveSet(FIN_DISMISSED_KEY, state.finDismissed);
}
function finDismiss(key) {
  state.finDismissed.add(key); state.finConfirmed.delete(key);
  finSaveSet(FIN_DISMISSED_KEY, state.finDismissed); finSaveSet(FIN_CONFIRMED_KEY, state.finConfirmed);
}

// Two passes, tightest first: same date + same amount, then within 4 days + same
// amount. Ria logs a few days late/early relative to the actual posting date, so a
// same-day-only match misses a lot of real matches — see the reconcile.mjs analysis
// this was validated against (144 -> 194 matched once the window opened to 4 days).
// Reconciles the COMBINED statement pool (Ria's + Jangelo's, via finHouseholdRows())
// against the one shared manual log — merging the statements, not the sheet, per
// Ria. idx is unique across the whole combined array (see finHouseholdRows), so
// every idx-keyed set/map below works exactly as it did when this only covered
// Ria's own statement.
function finReconcile() {
  const statementRows = finHouseholdRows();
  const manual = finManualRows();
  const usedStatement = new Set();
  const usedManual = new Set();
  const matched = [];
  // Exact amount + close date alone isn't a guaranteed match (two unrelated $100
  // charges 2 days apart happens) — so even here, a dismissed pairing is skipped in
  // favor of the next-nearest candidate rather than forced back together.
  function tryMatch(maxDays) {
    for (const m of manual) {
      if (usedManual.has(m.idx)) continue;
      const candidates = [];
      for (let i = 0; i < statementRows.length; i++) {
        if (usedStatement.has(i)) continue;
        const s = statementRows[i];
        if (Math.abs(s.sgd - m.cost) > 0.01) continue;
        const dd = finDaysApart(s.date, m.date);
        if (dd > maxDays) continue;
        candidates.push({ i, dd });
      }
      candidates.sort((a, b) => a.dd - b.dd);
      for (const c of candidates) {
        const key = `sm|${c.i}|${m.idx}`;
        if (state.finDismissed.has(key)) continue;
        usedStatement.add(c.i); usedManual.add(m.idx);
        matched.push({ manual: m, statement: statementRows[c.i], daysApart: c.dd, key });
        break;
      }
    }
  }
  tryMatch(0);
  tryMatch(4);

  // Confirmed many-to-one groups (see CONSOLIDATED_GROUPS) — pull their member rows
  // out of circulation before the pairwise passes below ever see them. Matched
  // against the RAW source text (finRawItem), not r.item, so renaming a member row
  // via the Edit button doesn't silently drop it out of its group.
  const consolidatedGroups = [];
  for (const g of CONSOLIDATED_GROUPS) {
    const rows = g.members
      .map((mem) => statementRows.find((r) => r.date === mem.date && finRawItem(r) === mem.item && Math.abs(r.sgd - mem.sgd) < 0.01 && !usedStatement.has(r.idx)))
      .filter(Boolean);
    const sum = rows.reduce((s, r) => s + r.sgd, 0);
    for (const r of rows) usedStatement.add(r.idx);
    const manualRow = manual.find((m) => m.date === g.manualDate && m.item === g.manualItem);
    if (manualRow) usedManual.add(manualRow.idx);
    consolidatedGroups.push({ ...g, rows, sum, manualRow, ok: Math.abs(sum - g.manualCost) < 0.01 });
  }

  // Confirmed 1:1 pairs (see CONFIRMED_PAIRS) — Ria confirmed these by hand, so treat
  // as certain matches rather than surfacing them through the amount-tolerance tiers.
  for (const p of CONFIRMED_PAIRS) {
    const s = statementRows.find((r) => r.date === p.statementDate && r.item === p.statementItem && Math.abs(r.sgd - p.statementSgd) < 0.01 && !usedStatement.has(r.idx));
    const m = manual.find((r) => r.date === p.manualDate && r.item.toLowerCase() === p.manualItem.toLowerCase() && !usedManual.has(r.idx));
    if (s && m) {
      usedStatement.add(s.idx); usedManual.add(m.idx);
      matched.push({ manual: m, statement: s, daysApart: finDaysApart(s.date, m.date), key: `cp|${s.idx}|${m.idx}` });
    }
  }

  // Possible matches: still-unmatched pairs with the SAME exact amount, either
  // within 10 days outright, or further apart but sharing a real word — cuts most
  // of the pure-coincidence noise a same-amount-only widened window produces.
  const pairKey = (s, m) => `pm|${s.idx}|${m.idx}`;
  const possibleMatches = [];
  for (const s of statementRows) {
    if (usedStatement.has(s.idx)) continue;
    let best = null, bestDist = Infinity;
    for (const m of manual) {
      if (usedManual.has(m.idx)) continue;
      if (Math.abs(m.cost - s.sgd) > 0.01) continue;
      const dd = finDaysApart(m.date, s.date);
      if (dd > 14) continue;
      if (dd > 4 && !finSharesToken(s.item, m.item)) continue;
      if (dd < bestDist) { bestDist = dd; best = m; }
    }
    if (best) {
      const key = pairKey(s, best);
      if (state.finConfirmed.has(key)) {
        usedStatement.add(s.idx); usedManual.add(best.idx);
        matched.push({ manual: best, statement: s, daysApart: bestDist, key });
      } else if (!state.finDismissed.has(key)) {
        possibleMatches.push({ manual: best, statement: s, daysApart: bestDist, key });
      }
    }
  }

  // Near-amount matches: same or next day, amount within 50 cents but NOT exact —
  // Ria estimates/rounds when typing an amount by hand, so "Otou San $19.80" on the
  // statement next to her own "otousan lunch zhongshan $19.50" is very likely the
  // same meal. Lower confidence than the tiers above (the amount genuinely differs,
  // not just the posting date), so these need a closer look before confirming.
  const nearAmountUsedManual = new Set();
  const possibleMatchesNearAmount = [];
  for (const s of statementRows) {
    if (usedStatement.has(s.idx)) continue;
    let best = null, bestScore = Infinity;
    for (const m of manual) {
      if (usedManual.has(m.idx) || nearAmountUsedManual.has(m.idx)) continue;
      const dd = finDaysApart(m.date, s.date);
      if (dd > 1) continue;
      const delta = Math.abs(m.cost - s.sgd);
      if (delta < 0.01 || delta > 0.5) continue; // exact matches already handled above
      const score = delta * 10 + dd;
      if (score < bestScore) { bestScore = score; best = m; }
    }
    if (best) {
      const key = `pmn|${s.idx}|${best.idx}`;
      if (state.finConfirmed.has(key)) {
        usedStatement.add(s.idx); usedManual.add(best.idx);
        matched.push({ manual: best, statement: s, daysApart: finDaysApart(best.date, s.date), key });
      } else if (!state.finDismissed.has(key)) {
        nearAmountUsedManual.add(best.idx);
        possibleMatchesNearAmount.push({ manual: best, statement: s, delta: Math.abs(best.cost - s.sgd), key });
      }
    }
  }

  // Possible duplicates WITHIN the manual log itself — same exact amount, within 5
  // days, sharing a word. Ria mentioned she once forwarded a Citibank statement PDF
  // straight to Darth Mitbot, which auto-logs every line — that would double-log
  // anything she'd also typed in by hand herself, and not always as just a pair (a
  // dinner logged by hand, then bot-ingested twice more, is a group of 3). Grouped
  // as connected components rather than one-shot pairing so a group like that
  // surfaces as one 3-way cluster instead of a pair plus a leftover single.
  const stillManualOnly = manual.filter((m) => !usedManual.has(m.idx));
  const n = stillManualOnly.length;
  const adj = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = stillManualOnly[i], b = stillManualOnly[j];
      if (Math.abs(a.cost - b.cost) <= 0.01 && finDaysApart(a.date, b.date) <= 5
        && finSharesToken(a.item, b.item) && !finDifferentPerson(a.item, b.item)) {
        adj[i].push(j); adj[j].push(i);
      }
    }
  }
  const seen = new Array(n).fill(false);
  const possibleDuplicates = [];
  const confirmedDuplicates = [];
  for (let i = 0; i < n; i++) {
    if (seen[i]) continue;
    const stack = [i], members = [];
    seen[i] = true;
    while (stack.length) {
      const u = stack.pop(); members.push(stillManualOnly[u]);
      for (const v of adj[u]) if (!seen[v]) { seen[v] = true; stack.push(v); }
    }
    if (members.length < 2) continue;
    members.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    const key = `pd|${members.map((m) => m.idx).sort((a, b) => a - b).join(",")}`;
    if (state.finDismissed.has(key)) continue;
    (state.finConfirmed.has(key) ? confirmedDuplicates : possibleDuplicates).push({ members, key });
  }

  const manualOnly = manual.filter((m) => !usedManual.has(m.idx));
  const statementOnly = statementRows.filter((s) => !usedStatement.has(s.idx));
  const withManualMatch = (list) => list.map((p) => ({
    ...p,
    manualMatch: manual.find((m) => Math.abs(m.cost - p.amount) <= 0.5 && finDaysApart(m.date, p.date) <= 10) || null,
  }));
  const ccBillPayments = withManualMatch(CC_BILL_PAYMENTS);
  const excludedTransfers = withManualMatch(EXCLUDED_TRANSFERS);

  // For the main transaction table: prefer the manual log's item text over a
  // statement description that's just the payment rail with no merchant info
  // (e.g. a masked PayNow recipient) — built from confirmed matches only.
  const enrichMap = new Map();
  for (const p of matched) {
    if (/^PayNow transfer \(personal\)$/i.test(p.statement.item)) enrichMap.set(p.statement.idx, p.manual.item);
  }

  return { matched, manualOnly, statementOnly, ccBillPayments, excludedTransfers, possibleMatches, possibleMatchesNearAmount, possibleDuplicates, confirmedDuplicates, consolidatedGroups, enrichMap };
}

// ---------- Jangelo's statements (Wise SGD account) ----------
// Feeds finHouseholdRows() — reconciliation is combined (finReconcile() above),
// not run separately per person, per Ria ("merge the statements please").
function finJangeloRows() {
  return (window.JANGELO_TXNS || []).map(([date, item, category, sgd], idx) => {
    const ov = (state.finOverrides || {})[`jangelo:${idx}`];
    return { date, item: (ov && ov.item) || item, category: (ov && ov.category) || category, sgd, idx, edited: !!ov, source: "jangelo", account: "Wise" };
  });
}
// Small muted tag so a statement row's source/account is visible once merged —
// hidden by default (Ria found it cluttered) behind two independent toggles:
// "Show who paid" (Ria/Jangelo/manual-log) and "Show statement" (Citibank/DBS/
// Wise). Either, both, or neither can be on; parts join into one tag.
function finSourceTag(r) {
  const parts = [];
  if (state.finShowSource) {
    if (r.source === "manual") parts.push("from your log, not a statement");
    else if (r.source === "jangelo") parts.push("Jangelo");
    else if (r.source === "ria") parts.push("Ria");
  }
  if (state.finShowStatement && r.source !== "manual" && r.account) {
    parts.push(r.account);
  }
  return parts.length ? ` <span class="fin-edited-tag">· ${parts.join(" · ")}</span>` : "";
}
function finConsolidatePanel(reconcile) {
  const { matched, manualOnly, statementOnly, ccBillPayments, excludedTransfers, possibleMatches, possibleMatchesNearAmount, possibleDuplicates, confirmedDuplicates, consolidatedGroups } = reconcile;
  const byJangelo = manualOnly.filter((m) => /jangelo/i.test(m.status)).length;
  const byIestin = manualOnly.length - byJangelo;
  // Ria stopped logging Bus/MRT rides by hand — those will always show up here and
  // aren't a real gap, so keep them visually separate from purchases actually worth
  // adding to the sheet.
  const realMissing = statementOnly.filter((r) => r.category !== "Transportation");
  const transportMissing = statementOnly.filter((r) => r.category === "Transportation");
  const sortedStatementOnly = [...realMissing].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const sortedTransportMissing = [...transportMissing].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const sortedMatched = [...matched].sort((a, b) => a.manual.date < b.manual.date ? -1 : a.manual.date > b.manual.date ? 1 : 0);

  return `
    <div class="fin-card">
      <h3>Consolidate with the manual log</h3>
      <p class="fin-consolidate-note">Matches the RJ Bahay sheet against Ria's and Jangelo's statements together (rows tagged "· Jangelo" are his) by date (within 4 days) and exact amount, regardless of who's listed as paying — either of you logs either of your own purchases.</p>
      <div class="fin-kpis">
        <div class="fin-kpi"><div class="fin-kpi-label">Matched</div><div class="fin-kpi-value">${matched.length}</div><div class="fin-kpi-sub">same purchase, already logged</div></div>
        <div class="fin-kpi"><div class="fin-kpi-label">Missing from the log</div><div class="fin-kpi-value">${realMissing.length}</div><div class="fin-kpi-sub">${transportMissing.length} more are Bus/MRT — not logged by choice</div></div>
        <div class="fin-kpi"><div class="fin-kpi-label">Only in the log</div><div class="fin-kpi-value">${manualOnly.length}</div><div class="fin-kpi-sub">${byIestin} tagged you, ${byJangelo} tagged Jangelo</div></div>
      </div>
      ${consolidatedGroups.length ? `
      <h4 class="fin-sub-h">Consolidated days — several charges logged as one entry (${consolidatedGroups.length})</h4>
      <ul class="fin-cc-list">
        ${consolidatedGroups.map((g) => `
          <li>${esc(finFmtDate(g.manualDate))} "${esc(g.manualItem)}" (${esc(finFmtSGD(g.manualCost))}) = ${g.rows.length} statement lines summing to ${esc(finFmtSGD(g.sum))}${g.ok ? "" : ` <strong>— doesn't add up, double check</strong>`}: ${g.rows.map((r) => `${esc(r.item)} ${esc(finFmtSGD(r.sgd))}`).join(", ")}</li>`).join("")}
      </ul>` : ""}
      ${possibleMatches.length ? `
      <div class="fin-review-section" data-section="pm">
        <div class="fin-card-head">
          <h4 class="fin-sub-h">Possible matches to review (${possibleMatches.length})</h4>
          <button class="btn-ghost fin-consolidate-all">Consolidate all shown</button>
        </div>
        <p class="fin-consolidate-note">Same exact amount, logged close in time — not close enough to auto-match. Confirm the ones that are really the same purchase, side by side.</p>
        <div class="fin-scroll" style="max-height:320px;">
          <table class="fin-table fin-review-table">
            <thead><tr><th>Statement</th><th>Manual log</th><th class="fin-num">Cost</th><th>Gap</th><th></th></tr></thead>
            <tbody>${possibleMatches.map((p) => `
              <tr>
                <td>${esc(finFmtDate(p.statement.date))} "${esc(p.statement.item)}"${finSourceTag(p.statement)}</td>
                <td>${esc(finFmtDate(p.manual.date))} "${esc(p.manual.item)}"</td>
                <td class="fin-num">${esc(finFmtSGD(p.statement.sgd))}</td>
                <td>${p.daysApart}d</td>
                <td class="fin-review-actions">
                  <button class="fin-confirm-btn" data-key="${esc(p.key)}">Confirm</button>
                  <button class="fin-dismiss-btn" data-key="${esc(p.key)}">Split — different purchase</button>
                </td>
              </tr>`).join("")}</tbody>
          </table>
        </div>
      </div>` : ""}
      ${possibleMatchesNearAmount.length ? `
      <div class="fin-review-section" data-section="pmn">
        <div class="fin-card-head">
          <h4 class="fin-sub-h">Possible matches — close in price (${possibleMatchesNearAmount.length})</h4>
          <button class="btn-ghost fin-consolidate-all">Consolidate all shown</button>
        </div>
        <p class="fin-consolidate-note">Same or next day, amount within 50 cents but not exact — you likely rounded when typing it in by hand. Lower confidence than the tiers above, so look closely before confirming.</p>
        <div class="fin-scroll" style="max-height:320px;">
          <table class="fin-table fin-review-table">
            <thead><tr><th>Statement</th><th>Manual log</th><th class="fin-num">Statement cost</th><th class="fin-num">Manual log cost</th><th></th></tr></thead>
            <tbody>${possibleMatchesNearAmount.map((p) => `
              <tr>
                <td>${esc(finFmtDate(p.statement.date))} "${esc(p.statement.item)}"${finSourceTag(p.statement)}</td>
                <td>${esc(finFmtDate(p.manual.date))} "${esc(p.manual.item)}"</td>
                <td class="fin-num">${esc(finFmtSGD(p.statement.sgd))}</td>
                <td class="fin-num">${esc(finFmtSGD(p.manual.cost))}</td>
                <td class="fin-review-actions">
                  <button class="fin-confirm-btn" data-key="${esc(p.key)}">Confirm</button>
                  <button class="fin-dismiss-btn" data-key="${esc(p.key)}">Split — different purchase</button>
                </td>
              </tr>`).join("")}</tbody>
          </table>
        </div>
      </div>` : ""}
      ${possibleDuplicates.length ? `
      <div class="fin-review-section" data-section="pd">
        <div class="fin-card-head">
          <h4 class="fin-sub-h">Possible duplicates in your own log (${possibleDuplicates.length})</h4>
          <button class="btn-ghost fin-consolidate-all">Consolidate all shown</button>
        </div>
        <p class="fin-consolidate-note">Same exact amount, logged close together, in your OWN sheet — likely the same purchase entered more than once (by hand, and again from a statement forwarded to Darth Mitbot — sometimes that's 3 copies, not 2). Confirm to flag the group for cleanup there.</p>
        <div class="fin-scroll" style="max-height:320px;">
          <table class="fin-table fin-review-table">
            <thead><tr><th>Entries logged as one purchase</th><th class="fin-num">Cost</th><th></th></tr></thead>
            <tbody>${possibleDuplicates.map((p) => `
              <tr>
                <td>${p.members.map((m) => `${esc(finFmtDate(m.date))} "${esc(m.item)}"`).join("<br>")}</td>
                <td class="fin-num">${esc(finFmtSGD(p.members[0].cost))}</td>
                <td class="fin-review-actions">
                  <button class="fin-confirm-btn" data-key="${esc(p.key)}">Confirm</button>
                  <button class="fin-dismiss-btn" data-key="${esc(p.key)}">Split — different purchases</button>
                </td>
              </tr>`).join("")}</tbody>
          </table>
        </div>
      </div>` : ""}
      ${confirmedDuplicates.length ? `
      <h4 class="fin-sub-h">Confirmed duplicates — keep one, delete the rest from your sheet (${confirmedDuplicates.length} group${confirmedDuplicates.length === 1 ? "" : "s"})</h4>
      <ul class="fin-cc-list">
        ${confirmedDuplicates.map((p) => `<li>${p.members.map((m) => `${esc(finFmtDate(m.date))} "${esc(m.item)}"`).join(" ↔ ")} (${esc(finFmtSGD(p.members[0].cost))} each)</li>`).join("")}
      </ul>` : ""}
      <h4 class="fin-sub-h">Credit card bill payments</h4>
      <ul class="fin-cc-list">
        ${ccBillPayments.map((p) => `
          <li>${esc(finFmtDate(p.date))} — ${esc(p.desc)}, ${esc(finFmtSGD(p.amount))}:
            ${p.manualMatch
              ? `<strong>found in your log</strong> (${esc(finFmtDate(p.manualMatch.date))} "${esc(p.manualMatch.item)}")`
              : `<strong>not in your log</strong> — you likely haven't logged the payment itself, only the individual purchases it covers`}
          </li>`).join("")}
      </ul>
      ${excludedTransfers.length ? `
      <h4 class="fin-sub-h">Other excluded transfers</h4>
      <p class="fin-consolidate-note">Real money out of the account, but not counted in the Finances totals above — kept visible here instead of just disappearing.</p>
      <ul class="fin-cc-list">
        ${excludedTransfers.map((p) => `
          <li>${esc(finFmtDate(p.date))} — ${esc(p.desc)}, ${esc(finFmtSGD(p.amount))}${
            p.manualMatch ? ` — <strong>found in your log</strong> (${esc(finFmtDate(p.manualMatch.date))} "${esc(p.manualMatch.item)}")` : ""
          }</li>`).join("")}
      </ul>` : ""}
      <div class="fin-card-head">
        <h4 class="fin-sub-h">Missing from the log (${realMissing.length})</h4>
        ${realMissing.length ? `<button id="fin-export-missing" class="btn-ghost">Export to Excel</button>` : ""}
      </div>
      <div class="fin-scroll" style="max-height:320px;">
        <table class="fin-table">
          <thead><tr><th>Date</th><th>Item</th><th>Category</th><th class="fin-num">Cost</th></tr></thead>
          <tbody>${sortedStatementOnly.map((r) => `
            <tr>
              <td>${esc(finFmtDate(r.date))}</td>
              <td>${esc(r.item)}${finSourceTag(r)}</td>
              <td><span class="fin-cat-name"><span class="fin-cat-swatch" style="background:var(${FIN_CATEGORY_COLOR[r.category] || "--fin-c-other"})"></span>${esc(r.category)}</span></td>
              <td class="fin-num">${esc(finFmtSGD(r.sgd))}</td>
            </tr>`).join("")}</tbody>
        </table>
      </div>
      ${transportMissing.length ? `
      <details class="fin-details">
        <summary>Bus/MRT rides not in the log (${transportMissing.length}) — not logged by choice, not a gap</summary>
        <div class="fin-scroll" style="max-height:220px;">
          <table class="fin-table">
            <thead><tr><th>Date</th><th>Item</th><th class="fin-num">Cost</th></tr></thead>
            <tbody>${sortedTransportMissing.map((r) => `
              <tr><td>${esc(finFmtDate(r.date))}</td><td>${esc(r.item)}</td><td class="fin-num">${esc(finFmtSGD(r.sgd))}</td></tr>`).join("")}</tbody>
          </table>
        </div>
      </details>` : ""}
      <details class="fin-details">
        <summary>Matched pairs (${matched.length}) — same purchase, logged once</summary>
        <p class="fin-consolidate-note">Exact amount + close date isn't a 100% guarantee (two unrelated charges can share an amount by coincidence) — split any pair here that isn't really the same purchase.</p>
        <div class="fin-scroll" style="max-height:320px;">
          <table class="fin-table fin-review-table">
            <thead><tr><th>Manual log</th><th>Statement</th><th class="fin-num">Cost</th><th>Gap</th><th></th></tr></thead>
            <tbody>${sortedMatched.map((p) => `
              <tr>
                <td>${esc(finFmtDate(p.manual.date))} "${esc(p.manual.item)}"</td>
                <td>${esc(finFmtDate(p.statement.date))} "${esc(p.statement.item)}"${finSourceTag(p.statement)}</td>
                <td class="fin-num">${esc(finFmtSGD(p.statement.sgd))}</td>
                <td>${p.daysApart === 0 ? "same day" : `${p.daysApart}d`}</td>
                <td class="fin-review-actions"><button class="fin-dismiss-btn" data-key="${esc(p.key)}">Split — different purchase</button></td>
              </tr>`).join("")}</tbody>
          </table>
        </div>
      </details>
    </div>`;
}

function finOverviewTab(all, agg, filtered, filteredTotal, months, enrichMap) {
  const monthOptions = months.map((m) => `<option value="${m}" ${state.finMonth === m ? "selected" : ""}>${esc(finFmtMonth(m))}</option>`).join("");
  const categoryOptions = FIN_CATEGORY_ORDER.filter((c) => agg.byCategory[c])
    .map((c) => `<option value="${c}" ${state.finCategory === c ? "selected" : ""}>${esc(c)}</option>`).join("");
  const byMonth = {};
  for (const r of all) (byMonth[r.date.slice(0, 7)] ||= []).push(r);

  // Category breakdown drills into whichever month is selected (via the toolbar's
  // month filter, or by clicking a month in the Monthly breakdown below) — the
  // Monthly breakdown itself always shows every month, since you need to see them
  // all to click between them.
  const categoryScopeRows = state.finMonth === "all" ? all : (byMonth[state.finMonth] || []);
  const categoryAgg = finAggregate(categoryScopeRows);
  const categoryHeading = state.finMonth === "all" ? "Category breakdown" : `Category breakdown — ${esc(finFmtMonth(state.finMonth))}`;

  return `
    ${finInsights(all, byMonth)}
    <div class="fin-kpis">
      <div class="fin-kpi"><div class="fin-kpi-label">Total spend</div><div class="fin-kpi-value">${esc(finFmtSGD(agg.total))}</div><div class="fin-kpi-sub">${esc(finFmtPHP(agg.total))}</div></div>
      <div class="fin-kpi"><div class="fin-kpi-label">Transactions</div><div class="fin-kpi-value">${all.length}</div><div class="fin-kpi-sub">${months.length} months</div></div>
      <div class="fin-kpi"><div class="fin-kpi-label">Avg / month</div><div class="fin-kpi-value">${esc(finFmtSGD(months.length ? agg.total / months.length : 0))}</div><div class="fin-kpi-sub">${esc(finFmtPHP(months.length ? agg.total / months.length : 0))}</div></div>
      <div class="fin-kpi"><div class="fin-kpi-label">Filtered view</div><div class="fin-kpi-value">${esc(finFmtSGD(filteredTotal))}</div><div class="fin-kpi-sub">${filtered.length} rows</div></div>
    </div>
    <div class="fin-grid">
      <div class="fin-table-wrap">
        <div class="fin-toolbar">
          <input id="fin-search" type="search" placeholder="Search item…" value="${esc(state.finSearch)}" />
          <select id="fin-category-filter">
            <option value="all">All categories</option>
            ${categoryOptions}
          </select>
          <select id="fin-month-filter">
            <option value="all">All months</option>
            ${monthOptions}
          </select>
          <select id="fin-account-filter">
            <option value="all">All statements</option>
            <option value="Citibank" ${state.finAccount === "Citibank" ? "selected" : ""}>Citibank</option>
            <option value="DBS" ${state.finAccount === "DBS" ? "selected" : ""}>DBS</option>
            <option value="Wise" ${state.finAccount === "Wise" ? "selected" : ""}>Wise</option>
          </select>
          <select id="fin-sort-filter">
            <option value="date-desc" ${state.finSort === "date-desc" ? "selected" : ""}>Newest first</option>
            <option value="date-asc" ${state.finSort === "date-asc" ? "selected" : ""}>Oldest first</option>
            <option value="cost-desc" ${state.finSort === "cost-desc" ? "selected" : ""}>Cost: high to low</option>
            <option value="cost-asc" ${state.finSort === "cost-asc" ? "selected" : ""}>Cost: low to high</option>
            <option value="item-asc" ${state.finSort === "item-asc" ? "selected" : ""}>Item: A to Z</option>
          </select>
          <label class="fin-toggle"><input type="checkbox" id="fin-show-source" ${state.finShowSource ? "checked" : ""} /> Show who paid</label>
          <label class="fin-toggle"><input type="checkbox" id="fin-show-statement" ${state.finShowStatement ? "checked" : ""} /> Show statement</label>
        </div>
        ${finTransactionTable(filtered, enrichMap)}
      </div>
      <div class="fin-side">
        <div class="fin-card">
          <h3>Monthly breakdown</h3>
          <p class="fin-consolidate-note">Click a month to filter the table and category breakdown to it.</p>
          ${finMonthlyChart(agg.byMonth, state.finMonth)}
          ${finMonthlySummaryTable(agg.byMonth, agg.total, state.finMonth)}
        </div>
        <div class="fin-card">
          <h3>${categoryHeading}</h3>
          ${finCategoryChart(categoryAgg.byCategory, categoryAgg.total)}
          ${finCategorySummaryTable(categoryAgg.byCategory, categoryAgg.total)}
        </div>
        <div class="fin-card">
          <h3>Your regulars 💕</h3>
          <p class="fin-consolidate-note">Places you keep going back to (3+ visits). Click one to filter the table.</p>
          ${finRegularsTable(finRegulars(all))}
        </div>
      </div>
    </div>`;
}

function renderFinance() {
  const all = finHouseholdRows();
  const agg = finAggregate(all);
  const months = Object.keys(agg.byMonth).sort();
  const rangeLabel = agg.minDate && agg.maxDate ? `${finFmtDate(agg.minDate)} – ${finFmtDate(agg.maxDate)}` : "";

  const hasManual = !!window.MANUAL_TXNS;
  if (state.finTab === "consolidate" && !hasManual) state.finTab = "overview";
  const reconcile = hasManual ? finReconcile() : null;
  const filtered = finFilteredRows(reconcile && reconcile.enrichMap);
  const filteredTotal = filtered.reduce((s, r) => s + r.sgd, 0);
  const tabContent = state.finTab === "income" ? finIncomeExpenseTab()
    : state.finTab === "statements" ? finStatementsTab()
    : state.finTab === "consolidate" ? finConsolidatePanel(reconcile)
    : finOverviewTab(all, agg, filtered, filteredTotal, months, reconcile && reconcile.enrichMap);

  $("#finance-view").innerHTML = `
    <div class="fin-head">
      <h2>Finances — Singapore</h2>
      <p>${esc(rangeLabel)} · Ria's Citibank + DBS/POSB and Jangelo's Wise SGD account · ${all.length} transactions · ${esc(window.FX_NOTE || "")}</p>
    </div>
    <div class="fin-tabs">
      <button class="fin-tab-btn ${state.finTab === "overview" ? "selected" : ""}" data-tab="overview">Overview</button>
      <button class="fin-tab-btn ${state.finTab === "income" ? "selected" : ""}" data-tab="income">Income vs Expenses</button>
      <button class="fin-tab-btn ${state.finTab === "statements" ? "selected" : ""}" data-tab="statements">Statements</button>
      ${hasManual ? `<button class="fin-tab-btn ${state.finTab === "consolidate" ? "selected" : ""}" data-tab="consolidate">Consolidate</button>` : ""}
    </div>
    ${tabContent}`;

  $$("#finance-view .fin-tab-btn[data-tab]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.tab === state.finTab) return;
    state.finTab = b.dataset.tab;
    renderFinance();
  }));
  if (state.finTab === "consolidate") {
    $$(".fin-confirm-btn[data-key]").forEach((btn) => btn.addEventListener("click", () => { finConfirm(btn.dataset.key); renderFinance(); }));
    $$(".fin-dismiss-btn[data-key]").forEach((btn) => btn.addEventListener("click", () => { finDismiss(btn.dataset.key); renderFinance(); }));
    $$(".fin-consolidate-all").forEach((btn) => btn.addEventListener("click", () => {
      const section = btn.closest(".fin-review-section");
      Array.from(section.querySelectorAll(".fin-confirm-btn[data-key]")).forEach((el) => finConfirm(el.dataset.key));
      renderFinance();
    }));
    const exportBtn = $("#fin-export-missing");
    if (exportBtn) exportBtn.addEventListener("click", () => {
      const realMissing = reconcile.statementOnly.filter((r) => r.category !== "Transportation");
      finExportXlsx(realMissing, `RJ Bahay - missing entries ${todayIso()}.xlsx`);
    });
    return;
  }
  if (state.finTab !== "overview") return;
  $("#fin-search").addEventListener("input", (e) => {
    state.finSearch = e.target.value;
    renderFinance();
    // Full re-render replaces the input node, so the caret would otherwise jump
    // out of the field after every keystroke — put it back at the end.
    const el = $("#fin-search");
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
  $("#fin-category-filter").addEventListener("change", (e) => { state.finCategory = e.target.value; renderFinance(); });
  $("#fin-month-filter").addEventListener("change", (e) => { state.finMonth = e.target.value; renderFinance(); });
  $("#fin-account-filter").addEventListener("change", (e) => { state.finAccount = e.target.value; renderFinance(); });
  $("#fin-sort-filter").addEventListener("change", (e) => { state.finSort = e.target.value; renderFinance(); });
  $("#fin-show-source").addEventListener("change", (e) => { state.finShowSource = e.target.checked; renderFinance(); });
  $("#fin-show-statement").addEventListener("change", (e) => { state.finShowStatement = e.target.checked; renderFinance(); });
  const insightsToggle = $("#fin-insights-toggle");
  if (insightsToggle) insightsToggle.addEventListener("click", () => { state.finShowInsights = !state.finShowInsights; renderFinance(); });
  // Clicking the already-selected month clears the filter back to "All months".
  const clickMonth = (m) => { state.finMonth = state.finMonth === m ? "all" : m; renderFinance(); };
  $$(".fin-vbar-col[data-month]").forEach((el) => el.addEventListener("click", () => clickMonth(el.dataset.month)));
  $$(".fin-summary-table-clickable tbody tr[data-month]").forEach((el) => el.addEventListener("click", () => clickMonth(el.dataset.month)));
  // Clicking a regular filters the table to that merchant; clicking the
  // already-selected one clears the search back to empty.
  const clickMerchant = (name) => { state.finSearch = state.finSearch === name ? "" : name; renderFinance(); };
  $$(".fin-summary-table-clickable tbody tr[data-merchant]").forEach((el) => el.addEventListener("click", () => clickMerchant(el.dataset.merchant)));

  $$(".fin-edit-btn[data-idx]").forEach((btn) => btn.addEventListener("click", () => {
    const idx = Number(btn.dataset.idx);
    const source = btn.dataset.source;
    const tr = btn.closest("tr");
    const row = (source === "jangelo" ? finJangeloRows() : finRows()).find((r) => r.idx === idx);
    if (!row || !tr) return;
    // Prefill with whatever the table actually shows — for an enriched row (a
    // generic statement line standing in for a real manual-log item, e.g. "PayNow
    // transfer (personal)" displayed as "Dry Fish Soup"), editing should start
    // from the displayed name, not silently revert to the raw underlying text.
    const enrichMap = reconcile && reconcile.enrichMap;
    const householdMatch = enrichMap && finHouseholdRows().find((r) => r.source === source && r.sourceIdx === idx);
    const displayItem = (householdMatch && enrichMap.get(householdMatch.idx)) || row.item;
    const { itemCell, categoryCell, actionsCell } = finEditRowForm({ ...row, item: displayItem });
    const cells = tr.children;
    cells[1].innerHTML = itemCell;
    cells[2].innerHTML = categoryCell;
    cells[4].innerHTML = actionsCell;
    tr.querySelector(".fin-edit-save").addEventListener("click", () => {
      const newItem = tr.querySelector(".fin-edit-item").value.trim();
      const newCategory = tr.querySelector(".fin-edit-category").value;
      finSetOverride(source, idx, { item: newItem || displayItem, category: newCategory });
      renderFinance();
    });
    tr.querySelector(".fin-edit-cancel").addEventListener("click", () => renderFinance());
    const resetBtn = tr.querySelector(".fin-edit-reset");
    if (resetBtn) resetBtn.addEventListener("click", () => { finClearOverride(source, idx); renderFinance(); });
  }));
}

// ---------- boot ----------
if (pw()) showApp(); else showLogin();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
