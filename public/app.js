// La biblioteca de Ilary — v1
// Estanterías, búsqueda (Google Books + Open Library), escáner ISBN, fichas de autor y alta manual.
// Funciona offline: los cambios se guardan en el dispositivo y se sincronizan con Netlify Blobs al volver la conexión.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const norm = (s) =>
  String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const today = () => new Date().toLocaleDateString("en-CA");
const fmtDate = (d) =>
  d ? new Date(d + "T12:00").toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" }) : "";

const SHELVES = {
  reading: { label: "Leyendo", one: "Leyendo", empty: "No está leyendo nada ahora mismo." },
  read: { label: "Leídos", one: "Leído", empty: "Aquí aparecerán los libros que ya leyó." },
  want: { label: "Quiero leer", one: "Quiero leer", empty: "Su lista de pendientes está vacía." },
  abandoned: { label: "Abandonados", one: "Abandonado", empty: "Ningún libro abandonado. ¡Bien!" },
};
const STATUS_ORDER = ["want", "reading", "read", "abandoned"];
const LANGS = { spa: "Español", es: "Español", eng: "Inglés", en: "Inglés", fre: "Francés", fr: "Francés", ger: "Alemán", de: "Alemán", ita: "Italiano", it: "Italiano", por: "Portugués", pt: "Portugués", rus: "Ruso", ru: "Ruso", jpn: "Japonés", ja: "Japonés", cat: "Catalán", ca: "Catalán" };
const SCAN_LIB = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
const OL_FIELDS = "key,title,subtitle,author_name,author_key,first_publish_year,cover_i,isbn,subject,number_of_pages_median,publisher,language";

// ---------- Almacenamiento local ----------
function load(k, fallback) {
  try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function save(k, v) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch (e) {
    console.warn("No se pudo guardar localmente", e);
  }
}

const db = {
  books: load("lib.books", []),
  queue: load("lib.queue", []),
  key: load("lib.key", ""),
};
let settings = load("lib.settings", {});
const persist = () => {
  save("lib.books", db.books);
  save("lib.queue", db.queue);
};

function applyOp(books, op) {
  if (op.op === "upsert") {
    const i = books.findIndex((b) => b.id === op.book.id);
    if (i < 0) books.push(op.book);
    else if ((books[i].updatedAt || 0) <= (op.book.updatedAt || 0)) books[i] = op.book;
  } else if (op.op === "delete") {
    books = books.filter((b) => b.id !== op.id);
  }
  return books;
}

function upsert(book) {
  const b = { ...book, updatedAt: Date.now() };
  db.books = applyOp(db.books, { op: "upsert", book: b });
  db.queue.push({ op: "upsert", book: b });
  persist();
  scheduleSync();
  return b;
}
function removeBook(id) {
  db.books = applyOp(db.books, { op: "delete", id });
  db.queue.push({ op: "delete", id });
  persist();
  scheduleSync();
}
const getBook = (id) => db.books.find((b) => b.id === id);
const bookKey = (b) => norm(b.title) + "|" + norm((b.authors || [])[0]);
const findInLibrary = (c) =>
  db.books.find((b) => (c.isbn && b.isbn && b.isbn === c.isbn) || bookKey(b) === bookKey(c));

// ---------- Sincronización ----------
let syncing = false;
let syncTimer = null;
let askedKey = false;

function scheduleSync() {
  updateSyncBadge();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 700);
}

async function sync() {
  if (syncing) return;
  if (!navigator.onLine) return updateSyncBadge();
  syncing = true;
  updateSyncBadge();
  const ops = db.queue.slice();
  try {
    const r = await fetch("/api/sync", {
      method: "POST",
      headers: { "content-type": "application/json", "x-app-key": db.key },
      body: JSON.stringify({ ops }),
    });
    if (r.status === 401) {
      syncing = false;
      return askKey();
    }
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    db.queue = db.queue.slice(ops.length);
    let books = data.books || [];
    for (const op of db.queue) books = applyOp(books, op);
    const changed = JSON.stringify(books) !== JSON.stringify(db.books);
    db.books = books;
    persist();
    if (changed) rerender();
  } catch (e) {
    console.warn("Sync falló, se reintentará", e);
  } finally {
    syncing = false;
    updateSyncBadge();
  }
}

function askKey() {
  updateSyncBadge();
  if (askedKey) return;
  askedKey = true;
  const k = prompt("Escribe la contraseña de la biblioteca");
  if (k) {
    db.key = k.trim();
    save("lib.key", db.key);
    askedKey = false;
    sync();
  }
}

function updateSyncBadge() {
  const el = $("#sync");
  const pending = db.queue.length;
  let state = "ok", text = "Sincronizado";
  if (!navigator.onLine) (state = "off"), (text = pending ? `Sin conexión · ${pending} cambio(s) guardados` : "Sin conexión");
  else if (syncing) (state = "busy"), (text = "Sincronizando…");
  else if (pending) (state = "pending"), (text = `${pending} cambio(s) por sincronizar`);
  el.dataset.state = state;
  el.title = text;
  el.setAttribute("aria-label", text);
}

// ---------- Utilidades de UI ----------
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function hueOf(s) {
  return [...String(s || "")].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
}
function coverHtml(b, cls = "cover") {
  const h = hueOf(b.title);
  if (!b.cover) return `<div class="${cls} cover-fallback" style="--h:${h}"><span>${esc(b.title)}</span></div>`;
  return `<div class="${cls}" style="--h:${h}"><img src="${esc(b.cover)}" alt="" loading="lazy" data-title="${esc(b.title)}"></div>`;
}
// Si una portada falla, mostrar la tapa generada
document.addEventListener(
  "error",
  (e) => {
    const img = e.target;
    if (img.tagName === "IMG" && img.dataset.title != null) {
      const wrap = img.parentNode;
      wrap.classList.add("cover-fallback");
      wrap.innerHTML = `<span>${esc(img.dataset.title)}</span>`;
    }
  },
  true
);

function authorKeyFor(name, b) {
  const a = (b.olAuthors || []).find((x) => norm(x.name) === norm(name));
  return a ? a.key : "";
}
function authorLinks(b) {
  return (b.authors || [])
    .map((n) => {
      const k = authorKeyFor(n, b);
      return `<a href="#/author/${encodeURIComponent(n)}${k ? "/" + k : ""}">${esc(n)}</a>`;
    })
    .join(", ");
}

function stripHtml(h) {
  if (!h) return "";
  const withBreaks = String(h).replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n");
  return (new DOMParser().parseFromString(withBreaks, "text/html").body.textContent || "").trim();
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error("No se pudo cargar " + src));
    document.head.appendChild(s);
  });
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

// ---------- APIs de libros ----------
function pickIsbn(list = []) {
  return list.find((x) => /^97[89]\d{10}$/.test(x)) || list.find((x) => /^\d{9}[\dX]$/i.test(x)) || "";
}

function fromGoogle(item) {
  const v = item.volumeInfo || {};
  const ids = v.industryIdentifiers || [];
  const isbn = (ids.find((i) => i.type === "ISBN_13") || ids.find((i) => i.type === "ISBN_10") || {}).identifier || "";
  const l = v.imageLinks || {};
  const cover = (l.thumbnail || l.smallThumbnail || "").replace("http://", "https://").replace("&edge=curl", "");
  return {
    title: v.title || "Sin título",
    subtitle: v.subtitle || "",
    authors: v.authors || [],
    olAuthors: [],
    year: (v.publishedDate || "").slice(0, 4),
    pages: v.pageCount || null,
    genres: v.categories || [],
    publisher: v.publisher || "",
    description: stripHtml(v.description),
    language: v.language || "",
    isbn,
    cover,
    olWorkKey: "",
    links: { google: v.infoLink || "" },
    source: "google",
  };
}

function fromOL(d) {
  const names = d.author_name || [];
  const keys = d.author_key || [];
  return {
    title: d.title || "Sin título",
    subtitle: d.subtitle || "",
    authors: names,
    olAuthors: names.map((name, i) => ({ name, key: keys[i] || "" })).filter((a) => a.key),
    year: d.first_publish_year ? String(d.first_publish_year) : "",
    pages: d.number_of_pages_median || null,
    genres: (d.subject || []).filter((s) => s.length < 30).slice(0, 4),
    publisher: (d.publisher || [])[0] || "",
    description: "",
    language: (d.language || [])[0] || "",
    isbn: pickIsbn(d.isbn),
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : "",
    olWorkKey: d.key || "",
    links: { openlibrary: d.key ? `https://openlibrary.org${d.key}` : "" },
    source: "openlibrary",
  };
}

function mergeInto(a, b) {
  // a tiene prioridad; b rellena huecos
  const out = { ...a };
  for (const k of ["subtitle", "year", "pages", "publisher", "description", "language", "isbn", "cover", "olWorkKey"]) {
    if (!out[k] && b[k]) out[k] = b[k];
  }
  if (!out.genres?.length) out.genres = b.genres || [];
  if (!out.authors?.length) out.authors = b.authors || [];
  out.olAuthors = [...(a.olAuthors || []), ...(b.olAuthors || [])];
  out.links = { ...(b.links || {}), ...(a.links || {}) };
  return out;
}

async function searchGoogle(q) {
  const data = await getJSON(
    `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=20&printType=books`
  );
  return (data.items || []).map(fromGoogle);
}
async function searchOL(params) {
  const qs = new URLSearchParams({ ...params, limit: "20", fields: OL_FIELDS });
  const data = await getJSON(`https://openlibrary.org/search.json?${qs}`);
  return (data.docs || []).map(fromOL);
}

async function searchBooks(q) {
  const isbn = q.replace(/[-\s]/g, "");
  const isIsbn = /^(97[89]\d{10}|\d{9}[\dX])$/i.test(isbn);
  const [g, o] = await Promise.allSettled([
    searchGoogle(isIsbn ? `isbn:${isbn}` : q),
    searchOL(isIsbn ? { isbn } : { q }),
  ]);
  const google = g.status === "fulfilled" ? g.value : [];
  const ol = o.status === "fulfilled" ? o.value : [];
  if (g.status === "rejected" && o.status === "rejected") throw new Error("Las dos fuentes fallaron");

  const byKey = new Map();
  for (const c of [...google, ...ol]) {
    const k = isIsbn ? "isbn" : bookKey(c);
    byKey.set(k, byKey.has(k) ? mergeInto(byKey.get(k), c) : c);
  }
  const results = [...byKey.values()];
  if (isIsbn) results.forEach((r) => (r.isbn = r.isbn || isbn));
  return { results, isIsbn, isbn };
}

async function fetchWorkDescription(workKey) {
  if (!workKey) return "";
  try {
    const w = await getJSON(`https://openlibrary.org${workKey}.json`);
    const d = typeof w.description === "string" ? w.description : w.description?.value || "";
    return d.replace(/\(\[source\].*$/s, "").replace(/-{5,}[\s\S]*$/, "").trim();
  } catch {
    return "";
  }
}

// ---------- Acciones ----------
function addBook(candidate, status) {
  const { source, ...rest } = candidate;
  const b = upsert({
    ...rest,
    source: source || "manual",
    id: crypto.randomUUID(),
    status,
    addedAt: today(),
    startedAt: status === "reading" ? today() : "",
    finishedAt: "",
  });
  toast(`«${b.title}» agregado a ${SHELVES[status].label}`);
  return b;
}

function changeStatus(b, s) {
  if (b.status === s) return;
  const next = { ...b, status: s };
  if (s === "reading" && !next.startedAt) next.startedAt = today();
  if ((s === "read" || s === "abandoned") && b.status === "reading" && !next.finishedAt) next.finishedAt = today();
  upsert(next);
  toast(`Movido a ${SHELVES[s].label}`);
}

// ---------- Router ----------
const view = $("#view");
let currentRoute = "";
let lastShelf = "all";
let routeSeq = 0;

function route() {
  routeSeq++;
  const [path, qs] = (location.hash.slice(1) || "/shelf/all").split("?");
  const parts = path.split("/").filter(Boolean);
  const params = new URLSearchParams(qs || "");
  currentRoute = parts[0];
  closeDialogs();
  if (parts[0] !== "read") {
    document.body.classList.remove("reading-mode");
    if (wakeLock) setWakeLock(false);
  }
  setTimeout(() => {
    updateTimerPill();
    checkForgottenTimer();
  });
  const navKey = ["add", "manual", "goodreads"].includes(parts[0]) ? "add" : "shelf";
  $$(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === navKey));
  $('.nav a[data-nav="shelf"]').href = `#/shelf/${lastShelf}`;

  switch (parts[0]) {
    case "shelf":
      lastShelf = TABS[parts[1]] ? parts[1] : "all";
      return renderShelf(lastShelf);
    case "add":
      return renderAdd(params.get("q") || "");
    case "manual":
      return renderForm(null, params);
    case "edit":
      return renderForm(getBook(parts[1]), params);
    case "book":
      return renderBook(parts[1]);
    case "goodreads":
      return renderGoodreads();
    case "review":
      return renderReview(getBook(parts[1]));
    case "read":
      return renderReadMode(getBook(parts[1]));
    case "session":
      return renderSession(getBook(parts[1]), parts[2] || "manual");
    case "author":
      return renderAuthor(decodeURIComponent(parts[1] || ""), parts[2] || "");
    default:
      location.hash = "#/shelf/all";
  }
}

function rerender() {
  if (!["shelf", "book"].includes(currentRoute)) return;
  if (document.activeElement?.matches("input, textarea")) return;
  const y = window.scrollY;
  route();
  window.scrollTo(0, y);
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function backButton() {
  return `<button class="back" data-action="back">← Volver</button>`;
}

// ---------- Vista: estanterías ----------
let shelfFilter = "";
let viewMode = load("lib.view2", "covers");
let drawShelf = null;
const TABS = { all: "Todos", reading: "Leyendo", read: "Leídos", want: "Quiero leer", abandoned: "Abandonados" };
const EMPTY_ALL = "Su biblioteca está vacía. Empieza agregando un libro.";

function renderShelf(status) {
  window.scrollTo(0, 0);
  const counts = { all: db.books.length };
  db.books.forEach((b) => (counts[b.status] = (counts[b.status] || 0) + 1));
  const filtering = !!shelfFilter.trim();
  const qi = $("#q");
  if (qi && qi.value !== shelfFilter) qi.value = shelfFilter;
  view.innerHTML = `
    ${filtering ? "" : continueHtml()}
    <section class="collection">
      <div class="sec-head"><h2 class="h2">${filtering ? "Resultados" : "Colección"}</h2><span class="muted small" id="colCount"></span></div>
      <div class="tabs" role="tablist">
        ${Object.entries(TABS)
          .map(([k, label]) => `<a href="#/shelf/${k}" role="tab" aria-selected="${k === status}" class="tab ${k === status ? "active" : ""}">${label}<span class="count">${counts[k] || 0}</span></a>`)
          .join("")}
      </div>
      <div id="grid"></div>
    </section>
    ${filtering ? "" : darkPanelHtml()}`;

  drawShelf = () => {
    const f = norm(shelfFilter);
    const sortKey = { reading: "startedAt", read: "finishedAt", abandoned: "finishedAt", want: "addedAt", all: "addedAt" }[status];
    const list = db.books
      .filter((b) => status === "all" || b.status === status)
      .filter((b) => !f || norm(b.title).includes(f) || (b.authors || []).some((a) => norm(a).includes(f)))
      .sort((a, b) => String(b[sortKey] || "").localeCompare(String(a[sortKey] || "")) || (b.updatedAt || 0) - (a.updatedAt || 0));
    const grid = $("#grid");
    if (!grid) return;
    $("#colCount").textContent = list.length ? `${list.length} libro${list.length > 1 ? "s" : ""}` : "";
    grid.className = list.length ? (viewMode === "spines" ? "shelf glass" : "grid") : "";
    grid.innerHTML = list.length
      ? list.map(viewMode === "spines" ? spineHtml : cardHtml).join("")
      : `<div class="empty">
          <p>${f ? "Nada coincide con esa búsqueda." : status === "all" ? EMPTY_ALL : SHELVES[status].empty}</p>
          ${f ? "" : `<a class="btn primary" href="#/add">Agregar un libro</a>`}
        </div>`;
    if (viewMode === "spines") fillSpineColors();
  };
  drawShelf();
}

function continueHtml() {
  const list = db.books
    .filter((b) => b.status === "reading")
    .sort((a, b) => (timer?.bookId === b.id) - (timer?.bookId === a.id) || (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!list.length) return "";
  const card = (b) => {
    const pct = Math.round(progressPct(b));
    const active = timer && timer.bookId === b.id;
    return `<article class="cont-card glass">
      <a href="#/book/${b.id}" class="cont-cover">${coverHtml(b, "cover")}</a>
      <div class="cont-body">
        <a href="#/book/${b.id}" class="cont-title">${esc(b.title)}</a>
        <span class="cont-author">${esc((b.authors || []).join(", "))}</span>
        <span class="cont-progress"><span class="bar"><span style="width:${pct}%"></span></span><span>${pct}%</span></span>
        ${
          active
            ? `<button class="pill-btn live" data-action="cont-open" data-id="${b.id}"><span class="pill-dot ${timer.pausedAt ? "paused" : ""}"></span><span data-clock>${fmtClock(elapsedMs(timer))}</span></button>`
            : `<button class="pill-btn" data-action="cont-resume" data-id="${b.id}">Seguir leyendo</button>`
        }
      </div>
    </article>`;
  };
  return `<section class="continue">
    <div class="sec-head"><h2 class="h2">Continuar leyendo</h2>${list.length > 1 ? `<span class="muted small">${list.length}</span>` : ""}</div>
    <div class="cont-row ${list.length > 1 ? "multi" : ""}">${list.map(card).join("")}</div>
  </section>`;
}

function yearStats() {
  const y = String(new Date().getFullYear());
  const readThisYear = db.books.filter((b) => b.status === "read" && (b.finishedAt || "").startsWith(y));
  const pages = readThisYear.reduce((a, b) => a + (b.pages || 0), 0);
  let minutes = 0;
  for (const b of db.books) for (const s of b.sessions || []) if ((s.date || "").startsWith(y)) minutes += s.minutes || 0;
  return { y, books: readThisYear.length, pages, hours: minutes / 60 };
}

function darkPanelHtml() {
  const { goal, todayMin, streak } = goalStats();
  const ys = yearStats();
  const recent = [...db.books].sort((a, b) => String(b.addedAt || "").localeCompare(String(a.addedAt || "")) || (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 10);
  const pct = goal ? Math.min(100, (todayMin / goal) * 100) : 0;
  const fmtN = (n) => Math.round(n).toLocaleString("es");
  return `<section class="dark-panel">
    <div class="dp-grid">
      <button class="dp-tile" data-action="goal-set">
        <span class="dp-label">Meta diaria</span>
        ${
          goal
            ? `<span class="dp-big">${Math.round(todayMin)}<small>/${goal} min</small></span>
               <span class="dp-bar"><span style="width:${pct.toFixed(0)}%"></span></span>
               <span class="dp-sub">${pct >= 100 ? "¡Cumplida hoy!" : `Faltan ${Math.ceil(goal - todayMin)} min`}${streak ? ` · ${streak} día${streak > 1 ? "s" : ""} de racha` : ""}</span>`
            : `<span class="dp-big muted-big">—</span><span class="dp-sub">Toca para ponerte una meta</span>`
        }
      </button>
      <div class="dp-tile">
        <span class="dp-label">En ${ys.y}</span>
        <dl class="dp-rows">
          <div><dt>Libros leídos</dt><dd>${ys.books}</dd></div>
          <div><dt>Páginas</dt><dd>${fmtN(ys.pages)}</dd></div>
          <div><dt>Horas leyendo</dt><dd>${ys.hours >= 10 ? fmtN(ys.hours) : ys.hours.toFixed(1).replace(".", ",").replace(",0", "")}</dd></div>
        </dl>
      </div>
    </div>
    ${
      recent.length
        ? `<div class="sec-head"><h2 class="h2">Agregados recientemente</h2><a href="#/shelf/all" class="dp-link">Todo</a></div>
           <div class="recent-row">${recent
             .map((b) => `<a class="recent" href="#/book/${b.id}">${coverHtml(b, "cover")}<span>${esc(b.title)}</span></a>`)
             .join("")}</div>`
        : ""
    }
  </section>`;
}

// Lomos: el color sale de la portada real; el ancho, de las páginas; el alto varía un poco.
const SPINE_TONES = ["#2f4a3a", "#7a2e26", "#1f2f45", "#d9c9a8", "#5b3b5e", "#a8553e", "#3d5a6c", "#c9a13b", "#4a5a3a", "#8c6a4f", "#e6ddcc", "#2b2b2b"];
const SPINE_TITLE_PX = 12.5;
const SPINE_CHAR_PX = SPINE_TITLE_PX * 0.56;

function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? "#1d1b19" : "#f7f3ec";
}

// Parte el título en 1 o 2 líneas según lo que cabe a lo alto del lomo
function spineLines(title, capacity) {
  const t = String(title).trim();
  if (t.length <= capacity) return [t];
  const words = t.split(/\s+/);
  let best = [t.slice(0, capacity), t.slice(capacity)], bestScore = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" "), b = words.slice(i).join(" ");
    const score = Math.max(a.length, b.length) + (a.length > capacity ? 50 : 0);
    if (score < bestScore) (bestScore = score), (best = [a, b]);
  }
  return best;
}

function spineHtml(b) {
  const seed = hueOf(b.title + (b.authors || [])[0]);
  const pages = b.pages || 280;
  let height = 168 + (seed % 5) * 7;
  const author = (b.authors || [])[0] || "";
  const surname = author.split(/\s+/).slice(-1)[0] || "";
  const reserved = surname ? 26 + Math.min(64, surname.length * 7.5) : 26; // espacio del autor + márgenes
  const capacity = Math.max(6, Math.floor((height - reserved) / SPINE_CHAR_PX));
  const lines = spineLines(b.title, capacity);
  const longest = Math.max(...lines.map((l) => l.length));
  if (longest > capacity) height = Math.min(206, Math.ceil(reserved + longest * SPINE_CHAR_PX + 8));
  let width = Math.round(Math.min(46, Math.max(28, 20 + pages / 24)));
  if (lines.length === 2) width = Math.max(width, 40);
  const known = b.spineColor || spineColorCache.get(b.id) || "";
  const bg = /^#[0-9a-f]{6}$/i.test(known) ? known : SPINE_TONES[seed % SPINE_TONES.length];
  return `<a class="spine" data-spine="${b.id}" href="#/book/${b.id}" style="--w:${width}px;--hgt:${height}px;--res:${Math.round(reserved + 6)}px;--sb:${bg};--sf:${textOn(bg)}" aria-label="${esc(b.title)}${author ? ", de " + esc(author) : ""}">
    <span class="spine-title ${lines.length === 2 ? "two" : ""}">${lines.map((l) => `<span>${esc(l)}</span>`).join("")}</span>
    ${surname ? `<span class="spine-author">${esc(surname)}</span>` : ""}
  </a>`;
}

// Color dominante de una portada (se calcula una vez y se guarda en el libro)
const spineColorTried = new Set();
const spineColorCache = new Map();
async function dominantColor(url) {
  const img = await loadCoverForCanvas(url);
  if (!img) return null;
  const c = document.createElement("canvas");
  c.width = 24;
  c.height = 36;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 24, 36);
  const data = ctx.getImageData(0, 0, 24, 36).data;
  const bins = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const sat = max ? (max - min) / max : 0;
    // Los colores con algo de saturación pesan más que el blanco/negro del fondo
    const w = 1 + sat * 2.5 - (max > 235 && sat < 0.12 ? 0.7 : 0) - (max < 22 ? 0.5 : 0);
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const bin = bins.get(key) || { w: 0, r: 0, g: 0, b: 0 };
    bin.w += w; bin.r += r * w; bin.g += g * w; bin.b += b * w;
    bins.set(key, bin);
  }
  let top = null;
  for (const bin of bins.values()) if (!top || bin.w > top.w) top = bin;
  if (!top || top.w <= 0) return null;
  let [r, g, b] = [top.r / top.w, top.g / top.w, top.b / top.w];
  // Evitar blancos puros que se confundan con el fondo
  const max = Math.max(r, g, b);
  if (max > 232) [r, g, b] = [r, g, b].map((v) => v * (232 / max));
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

async function fillSpineColors() {
  const todo = db.books.filter((b) => b.cover && !b.spineColor && !spineColorTried.has(b.id));
  if (!todo.length || !navigator.onLine) return;
  const updates = [];
  const worker = async () => {
    while (todo.length) {
      const b = todo.shift();
      spineColorTried.add(b.id);
      try {
        const color = await dominantColor(b.cover);
        if (!color) continue;
        updates.push([b.id, color]);
        spineColorCache.set(b.id, color);
        const el = document.querySelector(`[data-spine="${b.id}"]`);
        if (el) el.style.setProperty("--sb", color), el.style.setProperty("--sf", textOn(color));
      } catch {}
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (!updates.length) return;
  // Guardar todo de una vez
  const now = Date.now();
  for (const [id, color] of updates) {
    const b = getBook(id);
    if (!b) continue;
    const next = { ...b, spineColor: color, updatedAt: now };
    Object.assign(b, next);
    db.queue.push({ op: "upsert", book: next });
  }
  persist();
  scheduleSync();
}

function cardHtml(b) {
  let foot = "";
  if (b.status === "reading") {
    const pct = Math.round(progressPct(b));
    foot = `<span class="tile-progress"><span>${pct}%</span><span class="bar"><span style="width:${pct}%"></span></span></span>`;
  } else if (b.rating && (b.status === "read" || b.status === "abandoned")) {
    foot = `<span class="tile-sub"><span class="card-stars">★ ${fmtRating(b.rating)}</span>${b.finishedAt ? " · " + fmtDate(b.finishedAt) : ""}</span>`;
  } else if (b.status === "read" && b.finishedAt) foot = `<span class="tile-sub">${fmtDate(b.finishedAt)}</span>`;
  else if (b.status === "want") foot = `<span class="tile-sub">Quiero leer</span>`;
  else if (b.status === "abandoned") foot = `<span class="tile-sub">Abandonado</span>`;
  return `<a class="card tile glass" href="#/book/${b.id}">
    ${coverHtml(b)}
    <span class="card-title">${esc(b.title)}</span>
    <span class="card-author">${esc((b.authors || []).join(", "))}</span>
    ${foot}
  </a>`;
}

// ---------- Vista: agregar / buscar ----------
let lastResults = [];
let searchSeq = 0;

function renderAdd(q) {
  window.scrollTo(0, 0);
  view.innerHTML = `
    <h1 class="page-title">Agregar libro</h1>
    <form class="searchbar" id="sf" role="search">
      <input name="q" type="search" placeholder="Título, autor o ISBN" value="${esc(q)}" autocomplete="off" aria-label="Buscar libro">
      <button class="btn primary">Buscar</button>
    </form>
    <div class="add-actions">
      <button class="btn" data-action="scan">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V4h3M21 7V4h-3M3 17v3h3M21 17v3h-3M7 8v8M10 8v8M13 8v8M16 8v8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
        Escanear código
      </button>
      <a class="btn" href="#/manual">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
        Agregar a mano
      </a>
    </div>
    <a class="gr-link" href="#/goodreads">
      <span><strong>Importar desde Goodreads</strong><br><span class="muted">${settings.grUser ? `Conectado${settings.grName ? " como " + esc(settings.grName) : ""}` : "Trae todos sus libros de una vez"}</span></span>
      <span aria-hidden="true">→</span>
    </a>
    <div id="results" class="results"></div>`;

  $("#sf").addEventListener("submit", (e) => {
    e.preventDefault();
    const val = e.target.q.value.trim();
    if (!val) return;
    history.replaceState(null, "", "#/add?q=" + encodeURIComponent(val));
    e.target.q.blur();
    doSearch(val);
  });
  if (q) doSearch(q);
  else $("#sf input").focus({ preventScroll: true });
}

async function doSearch(q) {
  const box = $("#results");
  if (!navigator.onLine) {
    box.innerHTML = `<p class="muted center">Sin conexión. Puedes <a href="#/manual">agregarlo a mano</a> y completar los datos después.</p>`;
    return;
  }
  const seq = ++searchSeq;
  box.innerHTML = `<p class="muted center">Buscando…</p>`;
  try {
    const { results, isIsbn, isbn } = await searchBooks(q);
    if (seq !== searchSeq || !$("#results")) return;
    lastResults = results;
    if (!results.length) {
      box.innerHTML = `<div class="empty">
        <p>No encontramos ${isIsbn ? "ese ISBN" : "resultados"}.</p>
        <a class="btn primary" href="#/manual${isIsbn ? "?isbn=" + isbn : "?title=" + encodeURIComponent(q)}">Agregarlo a mano</a>
      </div>`;
      return;
    }
    box.innerHTML = results.map((c, i) => resultHtml(c, i)).join("");
    if (isIsbn) openPreview(results[0]);
  } catch (e) {
    if (seq !== searchSeq) return;
    box.innerHTML = `<p class="muted center">No se pudo buscar ahora. Inténtalo de nuevo en un momento.</p>`;
  }
}

function resultHtml(c, i) {
  const owned = findInLibrary(c);
  return `<button class="result" data-preview="${i}">
    ${coverHtml(c, "cover sm")}
    <span class="result-text">
      <span class="result-title">${esc(c.title)}</span>
      <span class="result-meta">${esc((c.authors || []).join(", "))}${c.year ? " · " + esc(c.year) : ""}</span>
      ${owned ? `<span class="badge">${SHELVES[owned.status].one}</span>` : ""}
    </span>
  </button>`;
}

// ---------- Hoja de vista previa ----------
const sheet = $("#sheet");
let previewList = [];

function chipsHtml(b) {
  const chips = [];
  if (b.year) chips.push(esc(b.year));
  if (b.pages) chips.push(`${b.pages} págs.`);
  (b.genres || []).slice(0, 3).forEach((g) => chips.push(esc(g)));
  return chips.length ? `<div class="chips">${chips.map((c) => `<span>${c}</span>`).join("")}</div>` : "";
}

async function openPreview(c) {
  const owned = findInLibrary(c);
  sheet.innerHTML = `<div class="sheet-inner">
    <button class="close" data-close aria-label="Cerrar">×</button>
    <div class="sheet-head">
      ${coverHtml(c, "cover lg")}
      <div>
        <h2>${esc(c.title)}</h2>
        ${c.subtitle ? `<p class="sub">${esc(c.subtitle)}</p>` : ""}
        <p class="authors">${authorLinks(c)}</p>
        ${chipsHtml(c)}
      </div>
    </div>
    <p class="desc clamp" id="pdesc">${c.description ? esc(c.description) : c.olWorkKey ? `<span class="muted">Cargando sinopsis…</span>` : `<span class="muted">Sin sinopsis disponible.</span>`}</p>
    <div class="sheet-actions">
      ${
        owned
          ? `<p class="muted">Ya está en su biblioteca (${SHELVES[owned.status].one}).</p><a class="btn primary" href="#/book/${owned.id}">Ver ficha</a>`
          : `<p class="muted">Agregar a…</p>
             <div class="status-buttons">
               <button class="btn" data-add="want">Quiero leer</button>
               <button class="btn" data-add="reading">Leyendo</button>
               <button class="btn primary" data-add="read">Ya lo leí</button>
             </div>`
      }
    </div>
  </div>`;
  sheet._candidate = c;
  if (!sheet.open) sheet.showModal();

  if (!c.description && c.olWorkKey) {
    const d = await fetchWorkDescription(c.olWorkKey);
    if (sheet._candidate !== c) return;
    c.description = d;
    $("#pdesc").innerHTML = d ? esc(d) : `<span class="muted">Sin sinopsis disponible.</span>`;
  }
}

function closeDialogs() {
  $$("dialog[open]").forEach((d) => d.close());
}

// ---------- Vista: ficha del libro ----------
async function renderBook(id) {
  window.scrollTo(0, 0);
  const b = getBook(id);
  if (!b) {
    view.innerHTML = `${backButton()}<div class="empty"><p>Este libro ya no está en la biblioteca.</p></div>`;
    return;
  }
  const lang = LANGS[b.language] || "";
  const metaRows = [
    ["Año", b.year],
    ["Páginas", b.pages],
    ["Editorial", b.publisher],
    ["Género", (b.genres || []).join(", ")],
    ["Idioma", lang],
    ["ISBN", b.isbn],
    ["Agregado", fmtDate(b.addedAt)],
  ].filter(([, v]) => v);

  const grQuery = b.isbn || `${b.title} ${(b.authors || [])[0] || ""}`;
  const links = [
    [b.links?.goodreads || `https://www.goodreads.com/search?q=${encodeURIComponent(grQuery)}`, "Goodreads"],
    [b.links?.google, "Google Books"],
    [b.links?.openlibrary, "Open Library"],
  ].filter(([u]) => u);

  const showStart = b.status !== "want";
  const showEnd = b.status === "read" || b.status === "abandoned";

  view.innerHTML = `
    ${backButton()}
    <article class="book">
      <div class="book-hero">
        ${coverHtml(b, "cover xl")}
        <div class="book-heading">
          ${b.series?.name ? `<p class="series">${esc(b.series.name)}${b.series.number ? ` · Libro ${esc(b.series.number)}` : ""}</p>` : ""}
          <h1>${esc(b.title)}</h1>
          ${b.subtitle ? `<p class="sub">${esc(b.subtitle)}</p>` : ""}
          <p class="authors">${authorLinks(b) || `<span class="muted">Autor desconocido</span>`}</p>
          <div id="heroStars">${b.rating ? starsHtml(b.rating) : ""}</div>
        </div>
      </div>

      <div class="seg" role="radiogroup" aria-label="Estado">
        ${STATUS_ORDER.map(
          (s) =>
            `<button role="radio" aria-checked="${b.status === s}" data-status="${s}" class="${b.status === s ? "on" : ""}">${SHELVES[s].one}</button>`
        ).join("")}
      </div>

      ${
        showStart || showEnd
          ? `<div class="dates">
              ${showStart ? `<label>Empezó<input type="date" data-date="startedAt" value="${esc(b.startedAt)}"></label>` : ""}
              ${showEnd ? `<label>${b.status === "read" ? "Terminó" : "Lo dejó"}<input type="date" data-date="finishedAt" value="${esc(b.finishedAt)}"></label>` : ""}
            </div>`
          : ""
      }

      ${readingSectionHtml(b)}

      ${b.status !== "want" ? reviewSectionHtml(b) : ""}

      ${(b.tags || []).length ? `<div class="tags">${b.tags.map((t) => `<span>${esc(t.replace(/-/g, " "))}</span>`).join("")}</div>` : ""}

      ${
        b.description
          ? `<section><h2 class="section">Sinopsis</h2><p class="desc clamp" id="bdesc">${esc(b.description)}</p>
             <button class="link" data-action="more">Leer más</button></section>`
          : `<section id="bdescSec"></section>`
      }

      ${metaRows.length ? `<section><h2 class="section">Información</h2><dl class="meta">${metaRows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl></section>` : ""}

      ${links.length ? `<section><h2 class="section">Ver en</h2><div class="links">${links.map(([u, t]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${t} ↗</a>`).join("")}</div></section>` : ""}

      <div class="row-actions">
        <a class="btn" href="#/edit/${b.id}">Editar datos</a>
        <button class="btn danger" data-action="delete">Eliminar</button>
      </div>
    </article>`;

  view._book = b.id;
  $$(".picker", view).forEach(paintPicker);
  updateTimerPill();

  const descEl = $("#bdesc");
  if (descEl && descEl.scrollHeight <= descEl.clientHeight + 2) $('[data-action="more"]')?.remove();

  if (!b.description && b.olWorkKey && navigator.onLine) {
    const d = await fetchWorkDescription(b.olWorkKey);
    const fresh = getBook(id);
    if (d && fresh && !fresh.description) {
      upsert({ ...fresh, description: d });
      const sec = $("#bdescSec");
      if (sec) sec.innerHTML = `<h2 class="section">Sinopsis</h2><p class="desc">${esc(d)}</p>`;
    }
  }
}

// ---------- Vista: autor ----------
async function renderAuthor(name, key) {
  window.scrollTo(0, 0);
  const seq = routeSeq;
  const mine = db.books.filter((b) => (b.authors || []).some((a) => norm(a) === norm(name)));
  const initials = name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  view.innerHTML = `
    ${backButton()}
    <div class="author-head">
      <div class="author-photo" id="aphoto" style="--h:${hueOf(name)}">${esc(initials)}</div>
      <div><h1>${esc(name)}</h1><p class="sub" id="adates"></p></div>
    </div>
    <p class="bio" id="abio"></p>
    <h2 class="section">En su biblioteca</h2>
    <div class="grid">${mine.length ? mine.map(cardHtml).join("") : `<p class="muted">Todavía no tiene libros de este autor.</p>`}</div>
    <h2 class="section">Otras obras</h2>
    <div class="grid" id="aworks"><p class="muted">${navigator.onLine ? "Cargando…" : "Disponible con conexión."}</p></div>`;

  if (!navigator.onLine) return;
  try {
    if (!key) {
      const s = await getJSON(`https://openlibrary.org/search/authors.json?q=${encodeURIComponent(name)}&limit=1`);
      key = s.docs?.[0]?.key || "";
    }
    if (!key) throw new Error("Autor no encontrado");
    const [info, works] = await Promise.all([
      getJSON(`https://openlibrary.org/authors/${key}.json`),
      searchOL({ author_key: key, sort: "editions" }),
    ]);
    if (seq !== routeSeq) return;

    const bio = typeof info.bio === "string" ? info.bio : info.bio?.value || "";
    $("#abio").textContent = bio.replace(/\(\[Source\].*$/is, "").trim();
    const dates = [info.birth_date, info.death_date].filter(Boolean).join(" – ");
    $("#adates").textContent = dates;
    const photo = (info.photos || []).find((p) => p > 0);
    if (photo) $("#aphoto").innerHTML = `<img src="https://covers.openlibrary.org/a/id/${photo}-M.jpg" alt="">`;

    previewList = works.filter((w) => !findInLibrary(w));
    $("#aworks").innerHTML = previewList.length
      ? previewList
          .map(
            (c, i) => `<button class="card" data-author-work="${i}">
              ${coverHtml(c)}
              <span class="card-title">${esc(c.title)}</span>
              <span class="card-sub">${esc(c.year)}</span>
            </button>`
          )
          .join("")
      : `<p class="muted">No encontramos más obras.</p>`;
  } catch {
    if (seq !== routeSeq) return;
    $("#aworks").innerHTML = `<p class="muted">No encontramos más información sobre este autor.</p>`;
  }
}

// ---------- Vista: formulario manual / edición ----------
let formCover = "";

function renderForm(book, params = new URLSearchParams()) {
  window.scrollTo(0, 0);
  if (location.hash.startsWith("#/edit") && !book) {
    view.innerHTML = `${backButton()}<div class="empty"><p>Libro no encontrado.</p></div>`;
    return;
  }
  const b = book || { title: params.get("title") || "", isbn: params.get("isbn") || "", authors: [], genres: [] };
  formCover = b.cover || "";
  const v = (x) => esc(x ?? "");

  view.innerHTML = `
    ${backButton()}
    <h1 class="page-title">${book ? "Editar libro" : "Agregar a mano"}</h1>
    <form id="bf" class="form" novalidate>
      <div class="cover-pick">
        <div id="coverPreview">${coverHtml({ title: b.title || "Portada", cover: formCover }, "cover lg")}</div>
        <div class="cover-inputs">
          <label class="btn">Subir foto<input type="file" accept="image/*" name="coverFile" hidden></label>
          <input name="coverUrl" type="url" placeholder="o pega el enlace de una imagen" value="${formCover.startsWith("data:") ? "" : v(formCover)}">
          ${formCover ? `<button type="button" class="link" data-action="clear-cover">Quitar portada</button>` : ""}
        </div>
      </div>
      <label>Título *<input name="title" required value="${v(b.title)}"></label>
      <label>Subtítulo<input name="subtitle" value="${v(b.subtitle)}"></label>
      <label>Autor(es)<input name="authors" placeholder="Separados por coma" value="${v((b.authors || []).join(", "))}"></label>
      <div class="two">
        <label>Año<input name="year" inputmode="numeric" maxlength="4" value="${v(b.year)}"></label>
        <label>Páginas<input name="pages" inputmode="numeric" value="${v(b.pages)}"></label>
      </div>
      <label>Género(s)<input name="genres" placeholder="Separados por coma" value="${v((b.genres || []).join(", "))}"></label>
      <div class="two">
        <label>Editorial<input name="publisher" value="${v(b.publisher)}"></label>
        <label>ISBN<input name="isbn" inputmode="numeric" value="${v(b.isbn)}"></label>
      </div>
      <label>Sinopsis<textarea name="description" rows="5">${v(b.description)}</textarea></label>
      ${
        book
          ? ""
          : `<fieldset class="status-pick"><legend>¿En qué estante?</legend>
              ${STATUS_ORDER.slice(0, 3)
                .map((s, i) => `<label><input type="radio" name="status" value="${s}" ${i === 0 ? "checked" : ""}><span>${SHELVES[s].one}</span></label>`)
                .join("")}
            </fieldset>`
      }
      <div class="row-actions">
        <button class="btn primary" type="submit">Guardar</button>
        <button class="btn" type="button" data-action="back">Cancelar</button>
      </div>
    </form>`;

  const form = $("#bf");
  const refreshCover = () => {
    $("#coverPreview").innerHTML = coverHtml({ title: form.elements.title.value || "Portada", cover: formCover }, "cover lg");
  };
  form.coverFile.addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      formCover = await resizeImage(f);
      form.coverUrl.value = "";
      refreshCover();
    } catch {
      toast("No se pudo leer esa imagen");
    }
  });
  form.coverUrl.addEventListener("change", () => {
    formCover = form.coverUrl.value.trim();
    refreshCover();
  });
  form.elements.title.addEventListener("input", () => !formCover && refreshCover());

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = form.elements.title.value.trim();
    if (!title) {
      form.elements.title.focus();
      return toast("El título es obligatorio");
    }
    const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
    const data = {
      title,
      subtitle: form.subtitle.value.trim(),
      authors: list(form.authors.value),
      year: form.year.value.trim(),
      pages: parseInt(form.pages.value, 10) || null,
      genres: list(form.genres.value),
      publisher: form.publisher.value.trim(),
      isbn: form.isbn.value.replace(/[-\s]/g, ""),
      description: form.description.value.trim(),
      cover: formCover,
    };
    if (book) {
      upsert({ ...book, ...data });
      toast("Cambios guardados");
      go(`#/book/${book.id}`);
    } else {
      const created = addBook({ ...data, olAuthors: [], links: {}, language: "", olWorkKey: "" }, form.elements.status.value);
      go(`#/book/${created.id}`);
    }
  });
}

function resizeImage(file, max = 480) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("imagen inválida"));
    };
    img.src = url;
  });
}

// ---------- Escáner ----------
const scanDlg = $("#scanDlg");
let scanner = null;

async function openScanner() {
  scanDlg.showModal();
  const msg = $("#scanMsg");
  msg.textContent = "Iniciando cámara…";
  try {
    if (!window.Html5Qrcode) await loadScript(SCAN_LIB);
    const F = window.Html5QrcodeSupportedFormats;
    scanner = new window.Html5Qrcode("reader", {
      formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A],
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      verbose: false,
    });
    await scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: (w, h) => ({ width: Math.floor(Math.min(w * 0.85, 320)), height: Math.floor(Math.min(h * 0.45, 150)) }) },
      onCode,
      () => {}
    );
    if (!scanDlg.open) return stopScanner();
    msg.textContent = "Apunta al código de barras de la contraportada";
  } catch (e) {
    console.warn(e);
    msg.textContent = navigator.onLine
      ? "No se pudo abrir la cámara. Puedes escribir el ISBN abajo."
      : "El escáner necesita conexión la primera vez. Escribe el ISBN abajo.";
  }
}

async function stopScanner() {
  const s = scanner;
  scanner = null;
  if (!s) return;
  try {
    if (s.isScanning) await s.stop();
    s.clear();
  } catch {}
}

function onCode(text) {
  const isbn = String(text).replace(/[^\dX]/gi, "");
  if (!/^(97[89]\d{10}|\d{9}[\dX])$/i.test(isbn)) {
    $("#scanMsg").textContent = "Ese código no parece un ISBN. Busca el que empieza por 978 o 979.";
    return;
  }
  navigator.vibrate?.(60);
  lookupIsbn(isbn);
}

function lookupIsbn(isbn) {
  stopScanner();
  scanDlg.close();
  go("#/add?q=" + isbn);
}

scanDlg.addEventListener("close", stopScanner);
$("#isbnForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const val = e.target.isbn.value.replace(/[-\s]/g, "");
  if (val) {
    e.target.reset();
    lookupIsbn(val);
  }
});

// ---------- Estrellas ----------
function starsHtml(r) {
  const full = Math.floor(r);
  const half = r - full >= 0.5;
  let out = "";
  for (let i = 0; i < 5; i++) out += `<span class="${i < full ? "on" : i === full && half ? "half" : ""}">★</span>`;
  return `<p class="stars" aria-label="${r} de 5 estrellas">${out}</p>`;
}

// ---------- Reseñas ----------
const REVIEW_PARTS = [
  ["characters", "Personajes"],
  ["plot", "Trama"],
  ["ending", "Final"],
  ["style", "Estilo y escritura"],
];
const fmtRating = (r) => String(r).replace(".", ",");
const ratingWords = { 0.5: "Horrible", 1: "Muy malo", 1.5: "Malo", 2: "Flojo", 2.5: "Regular", 3: "Bueno", 3.5: "Muy bueno", 4: "Genial", 4.5: "Increíble", 5: "Obra maestra" };

function starPicker(value, key, size = "") {
  let h = `<div class="picker ${size}" data-picker="${key}" data-value="${value || 0}" role="slider" tabindex="0"
    aria-label="Puntuación" aria-valuemin="0" aria-valuemax="5" aria-valuenow="${value || 0}"><span class="pstars">`;
  for (let i = 1; i <= 5; i++) {
    h += `<span class="pstar" data-i="${i}">★<button type="button" data-rate="${i - 0.5}" aria-label="${fmtRating(i - 0.5)} estrellas" tabindex="-1"></button><button type="button" data-rate="${i}" aria-label="${i} estrellas" tabindex="-1"></button></span>`;
  }
  return h + `</span><span class="pval"></span></div>`;
}

function paintPicker(el) {
  const v = +el.dataset.value || 0;
  $$(".pstar", el).forEach((s) => {
    const i = +s.dataset.i;
    s.className = "pstar" + (v >= i ? " on" : v >= i - 0.5 ? " half" : "");
  });
  el.setAttribute("aria-valuenow", v);
  const label = $(".pval", el);
  if (label) label.textContent = v ? `${fmtRating(v)} · ${ratingWords[v]}` : el.classList.contains("sm") ? "" : "Toca para puntuar";
}

function setPicker(el, v) {
  v = Math.max(0, Math.min(5, Math.round(v * 2) / 2));
  el.dataset.value = v;
  paintPicker(el);
  if (el.dataset.picker === "book") {
    const b = getBook(view._book);
    if (!b) return;
    upsert({ ...b, rating: v, reviewedAt: b.reviewedAt || today() });
    $("#heroStars").innerHTML = v ? starsHtml(v) : "";
    const share = $('[data-action="share-review"]');
    if (share) share.hidden = !v && !b.review;
  }
}

function hasReview(b) {
  return !!(b.review || Object.values(b.reviewParts || {}).some((p) => p.text || p.rating));
}

function reviewSectionHtml(b) {
  const parts = REVIEW_PARTS.filter(([k]) => b.reviewParts?.[k]?.text || b.reviewParts?.[k]?.rating);
  return `<section class="review-sec">
    <h2 class="section">Su reseña</h2>
    ${starPicker(b.rating, "book")}
    ${
      hasReview(b)
        ? `${b.spoilers ? `<p class="spoiler-tag">Contiene spoilers</p>` : ""}
           ${b.review ? `<p class="review clamp" id="reviewText">${esc(b.review)}</p>` : ""}
           ${
             parts.length
               ? `<dl class="parts">${parts
                   .map(
                     ([k, label]) => `<div><dt>${label}${b.reviewParts[k].rating ? ` <span class="part-stars">★ ${fmtRating(b.reviewParts[k].rating)}</span>` : ""}</dt>
                       ${b.reviewParts[k].text ? `<dd>${esc(b.reviewParts[k].text)}</dd>` : ""}</div>`
                   )
                   .join("")}</dl>`
               : ""
           }`
        : ""
    }
    <div class="row-actions tight">
      <a class="btn" href="#/review/${b.id}">${hasReview(b) ? "Editar reseña" : "Escribir reseña"}</a>
      <button class="btn" data-action="share-review" ${b.rating || hasReview(b) ? "" : "hidden"}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3M7.5 7.5 12 3l4.5 4.5M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Compartir
      </button>
    </div>
  </section>`;
}

function renderReview(b) {
  window.scrollTo(0, 0);
  if (!b) {
    view.innerHTML = `${backButton()}<div class="empty"><p>Libro no encontrado.</p></div>`;
    return;
  }
  const parts = b.reviewParts || {};
  const hasParts = REVIEW_PARTS.some(([k]) => parts[k]?.text || parts[k]?.rating);
  view.innerHTML = `
    ${backButton()}
    <div class="review-head">
      ${coverHtml(b, "cover sm")}
      <div><p class="review-book">${esc(b.title)}</p><p class="muted small">${esc((b.authors || []).join(", "))}</p></div>
    </div>
    <form id="rf" class="form review-form">
      ${starPicker(b.rating, "main", "lg")}
      <label class="sr-only" for="rtext">Su reseña</label>
      <textarea id="rtext" name="review" class="review-input" rows="6" placeholder="¿Qué te pareció? Una frase o todo lo que quieras contar…">${esc(b.review)}</textarea>

      <details class="parts-edit" ${hasParts ? "open" : ""}>
        <summary>Reseña por partes <span class="muted">(opcional)</span></summary>
        ${REVIEW_PARTS.map(
          ([k, label]) => `<div class="part">
            <div class="part-head"><span>${label}</span>${starPicker(parts[k]?.rating, "part-" + k, "sm")}</div>
            <textarea name="part-${k}" rows="2" placeholder="${label}…">${esc(parts[k]?.text)}</textarea>
          </div>`
        ).join("")}
      </details>

      <label class="check"><input type="checkbox" name="spoilers" ${b.spoilers ? "checked" : ""}> Contiene spoilers</label>

      <div class="row-actions">
        <button class="btn primary" type="submit">Guardar reseña</button>
        <button class="btn" type="button" data-action="back">Cancelar</button>
      </div>
    </form>`;

  $$(".picker", view).forEach(paintPicker);
  view._book = null; // las estrellas de este formulario no guardan al instante
  const form = $("#rf");
  const grow = (t) => {
    t.style.height = "auto";
    t.style.height = t.scrollHeight + 2 + "px";
  };
  $$("textarea", form).forEach((t) => {
    grow(t);
    t.addEventListener("input", () => grow(t));
  });
  $("details", form).addEventListener("toggle", () => $$("textarea", form).forEach(grow));

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const reviewParts = {};
    for (const [k] of REVIEW_PARTS) {
      const text = form.elements["part-" + k].value.trim();
      const rating = +$(`[data-picker="part-${k}"]`, form).dataset.value || 0;
      if (text || rating) reviewParts[k] = { text, rating };
    }
    const fresh = getBook(b.id) || b;
    upsert({
      ...fresh,
      rating: +$('[data-picker="main"]', form).dataset.value || 0,
      review: form.elements.review.value.trim(),
      reviewParts,
      spoilers: form.elements.spoilers.checked,
      reviewedAt: fresh.reviewedAt || today(),
    });
    toast("Reseña guardada");
    go(`#/book/${b.id}`);
  });
}

// ---------- Timer de lectura ----------
// El timer guarda la hora de inicio (no un contador), así sigue bien aunque se cierre la app.
let timer = load("lib.timer", null);
const FORGOT_AFTER = 2 * 3600 * 1000; // preguntar si sigue leyendo tras 2 h seguidas

function saveTimer(t) {
  timer = t;
  save("lib.timer", t);
  saveSettings({ activeTimer: t || null });
  updateTimerPill();
}
const elapsedMs = (t, end) => Math.max(0, (end || t.pausedAt || Date.now()) - t.startedAt - (t.pausedMs || 0));
function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}
function fmtDur(min) {
  min = Math.round(min);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
const localDate = (ms) => new Date(ms).toLocaleDateString("en-CA");
const timeOf = (ms) => new Date(ms).toTimeString().slice(0, 5);

// Progreso: siempre se guarda la página; si lee en %, también el % (y se convierte a páginas)
const currentPage = (b) => b.progress?.page || 0;
function progressPct(b) {
  if (b.pages && b.progress?.page) return Math.min(100, (b.progress.page / b.pages) * 100);
  return b.progress?.percent || 0;
}
const progressUnit = (b) => b.progress?.unit || "page";

function bookTimeStats(b) {
  const sessions = b.sessions || [];
  const minutes = sessions.reduce((a, s) => a + (s.minutes || 0), 0);
  let pages = 0, pageMin = 0, pct = 0, pctMin = 0;
  for (const s of sessions) {
    if (!s.minutes) continue;
    const dp = (s.toPage || 0) - (s.fromPage || 0);
    if (dp > 0) (pages += dp), (pageMin += s.minutes);
    else if (s.toPercent != null && s.fromPercent != null && s.toPercent > s.fromPercent) (pct += s.toPercent - s.fromPercent), (pctMin += s.minutes);
  }
  const pagesPerHour = pageMin ? pages / (pageMin / 60) : 0;
  const pctPerHour = pctMin ? pct / (pctMin / 60) : 0;
  let remainingMin = 0;
  if (b.status !== "read") {
    if (pagesPerHour && b.pages) remainingMin = Math.max(0, ((b.pages - currentPage(b)) / pagesPerHour) * 60);
    else if (pctPerHour) remainingMin = Math.max(0, ((100 - progressPct(b)) / pctPerHour) * 60);
  }
  return { minutes, pagesPerHour, pctPerHour, remainingMin, count: sessions.length };
}

function startTimer(b, { reading = false } = {}) {
  if (timer && timer.bookId !== b.id) {
    const other = getBook(timer.bookId);
    if (other) {
      toast(`Primero termina la sesión de «${other.title}»`);
      return go(`#/session/${other.id}/new`);
    }
  }
  if (!timer) {
    if (b.status !== "reading") changeStatus(b, "reading");
    const fresh = getBook(b.id);
    saveTimer({
      bookId: b.id,
      startedAt: Date.now(),
      pausedAt: null,
      pausedMs: 0,
      fromPage: currentPage(fresh),
      fromPercent: fresh.progress?.percent ?? null,
    });
  }
  if (reading) go(`#/read/${b.id}`);
  else rerenderSoft();
}

function togglePause() {
  if (!timer) return;
  if (timer.pausedAt) saveTimer({ ...timer, pausedMs: (timer.pausedMs || 0) + (Date.now() - timer.pausedAt), pausedAt: null });
  else saveTimer({ ...timer, pausedAt: Date.now() });
  tick();
  $$("[data-action=timer-pause]").forEach((btn) => (btn.textContent = timer.pausedAt ? "Seguir" : "Pausar"));
  $$(".timer-live").forEach((el) => el.classList.toggle("paused", !!timer.pausedAt));
}

// Actualiza los relojes visibles una vez por segundo
function tick() {
  if (!timer) return;
  const txt = fmtClock(elapsedMs(timer));
  $$("[data-clock]").forEach((el) => (el.textContent = txt));
}
setInterval(tick, 1000);

function updateTimerPill() {
  const pill = $("#timerPill");
  if (!pill) return;
  const b = timer && getBook(timer.bookId);
  const hide = !b || currentRoute === "read" || (currentRoute === "book" && view._book === b.id) || currentRoute === "session";
  pill.hidden = hide;
  document.body.classList.toggle("has-pill", !hide);
  if (b) pill.innerHTML = `<span class="pill-dot ${timer.pausedAt ? "paused" : ""}"></span><span class="pill-title">${esc(b.title)}</span><span data-clock>${fmtClock(elapsedMs(timer))}</span>`;
}

function readingSectionHtml(b) {
  const active = timer && timer.bookId === b.id;
  const busyElsewhere = timer && timer.bookId !== b.id;
  const st = bookTimeStats(b);
  const pct = progressPct(b);
  const hasProgress = b.status === "reading" || currentPage(b) || b.progress?.percent;
  const unitPct = progressUnit(b) === "percent";
  const progressLabel = unitPct && !b.pages
    ? `${Math.round(pct)}%`
    : b.pages
      ? `Página ${currentPage(b)} de ${b.pages} · ${Math.round(pct)}%`
      : currentPage(b) ? `Página ${currentPage(b)}` : "Sin progreso todavía";

  const statBits = [];
  if (st.minutes) statBits.push(["Tiempo leyendo", fmtDur(st.minutes)]);
  if (st.pagesPerHour) statBits.push(["Ritmo", `${Math.round(st.pagesPerHour)} pág/h`]);
  else if (st.pctPerHour) statBits.push(["Ritmo", `${st.pctPerHour.toFixed(1).replace(".", ",")}%/h`]);
  if (st.remainingMin) statBits.push(["Le falta", `≈ ${fmtDur(st.remainingMin)}`]);

  if (b.status !== "reading" && !st.count && !active) {
    return `<section class="reading-sec compact">
      ${b.status === "want" ? `<button class="btn primary wide" data-action="timer-start">Empezar a leer</button>` : ""}
      <a class="link small-link" href="#/session/${b.id}/manual">Anotar una sesión de lectura</a>
    </section>`;
  }

  return `<section class="reading-sec">
    <h2 class="section">Lectura</h2>
    ${
      hasProgress
        ? `<div class="progress"><div class="bar"><span style="width:${pct.toFixed(1)}%"></span></div>
           <p class="progress-label">${progressLabel}</p></div>`
        : ""
    }
    ${
      active
        ? `<div class="timer-live ${timer.pausedAt ? "paused" : ""}">
             <span class="clock" data-clock>${fmtClock(elapsedMs(timer))}</span>
             <div class="timer-actions">
               <button class="btn" data-action="timer-pause">${timer.pausedAt ? "Seguir" : "Pausar"}</button>
               <button class="btn primary" data-action="timer-finish">Terminar</button>
             </div>
             <a class="link small-link" href="#/read/${b.id}">Abrir modo lectura</a>
           </div>`
        : b.status !== "read"
          ? `<div class="timer-start">
               <button class="btn primary" data-action="timer-start" ${busyElsewhere ? "disabled" : ""}>Empezar a leer</button>
               <button class="btn" data-action="timer-read" ${busyElsewhere ? "disabled" : ""}>Modo lectura</button>
             </div>
             ${busyElsewhere ? `<p class="muted small">Hay una sesión abierta de «${esc(getBook(timer.bookId)?.title || "otro libro")}».</p>` : ""}`
          : ""
    }
    ${statBits.length ? `<dl class="meta tstats">${statBits.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>` : ""}
    ${sessionsListHtml(b)}
    <a class="link small-link" href="#/session/${b.id}/manual">+ Anotar una sesión a mano</a>
  </section>`;
}

function sessionsListHtml(b) {
  const list = [...(b.sessions || [])].sort((x, y) => (y.date + (y.start || "")).localeCompare(x.date + (x.start || "")) || (y.start || 0) - (x.start || 0));
  if (!list.length) return "";
  const row = (s) => {
    const dp = (s.toPage || 0) - (s.fromPage || 0);
    const range = dp > 0 ? `pág. ${s.fromPage} → ${s.toPage}` : s.toPercent != null ? `${Math.round(s.toPercent)}%` : "";
    return `<a class="session" href="#/session/${b.id}/${s.id}">
      <span class="session-top"><span>${fmtDate(s.date)}${s.start ? " · " + timeOf(s.start) : ""}</span><span>${s.minutes ? fmtDur(s.minutes) : ""}</span></span>
      ${range ? `<span class="session-range">${range}${dp > 0 ? ` <em>+${dp}</em>` : ""}</span>` : ""}
      ${s.note ? `<span class="session-note">${esc(s.note)}</span>` : ""}
      ${s.feeling ? `<span class="session-feeling">${esc(s.feeling)}</span>` : ""}
    </a>`;
  };
  const first = list.slice(0, 4).map(row).join("");
  const rest = list.slice(4);
  return `<div class="sessions"><h3 class="sub-section">Sesiones <span class="muted">${list.length}</span></h3>${first}
    ${rest.length ? `<details class="more-sessions"><summary>Ver ${rest.length} más</summary>${rest.map(row).join("")}</details>` : ""}</div>`;
}

// ---------- Modo lectura ----------
let wakeLock = null;
async function setWakeLock(on) {
  try {
    if (on && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    else if (wakeLock) await wakeLock.release(), (wakeLock = null);
  } catch {
    wakeLock = null;
  }
}

function renderReadMode(b) {
  if (!b) return go("#/shelf/all");
  if (!timer) return startTimer(b, { reading: true });
  if (timer.bookId !== b.id) return go(`#/read/${timer.bookId}`);
  document.body.classList.add("reading-mode");
  const keepOn = load("lib.wake", false);
  view.innerHTML = `<div class="readmode">
    <button class="close rm-close" data-action="read-exit" aria-label="Salir del modo lectura">×</button>
    <div class="rm-book">${coverHtml(b, "cover rm-cover")}<p class="rm-title">${esc(b.title)}</p><p class="muted small">${esc((b.authors || []).join(", "))}</p></div>
    <div class="timer-live rm-timer ${timer.pausedAt ? "paused" : ""}">
      <span class="clock big" data-clock>${fmtClock(elapsedMs(timer))}</span>
      <p class="muted small rm-state">${b.pages && currentPage(b) ? `Empezaste en la página ${timer.fromPage || currentPage(b)}` : "Disfruta la lectura"}</p>
    </div>
    <div class="rm-actions">
      <button class="btn" data-action="timer-pause">${timer.pausedAt ? "Seguir" : "Pausar"}</button>
      <button class="btn primary" data-action="timer-finish">Terminar</button>
    </div>
    ${"wakeLock" in navigator ? `<label class="check rm-wake"><input type="checkbox" id="wakeToggle" ${keepOn ? "checked" : ""}> Mantener la pantalla encendida</label>` : ""}
  </div>`;
  $("#wakeToggle")?.addEventListener("change", (e) => {
    save("lib.wake", e.target.checked);
    setWakeLock(e.target.checked);
  });
  if (keepOn) setWakeLock(true);
}

// ---------- Formulario de sesión ----------
// sid: "new" (cerrar el timer), "manual" (anotar a mano) o el id de una sesión existente
function renderSession(b, sid) {
  window.scrollTo(0, 0);
  if (!b) return go("#/shelf/all");
  const fromTimer = sid === "new";
  if (fromTimer && (!timer || timer.bookId !== b.id)) return go(`#/book/${b.id}`);
  const existing = !fromTimer && sid !== "manual" ? (b.sessions || []).find((s) => s.id === sid) : null;
  if (!fromTimer && sid !== "manual" && !existing) return go(`#/book/${b.id}`);

  const unit = progressUnit(b);
  let minutes, date, fromPage, toPage, toPercent, note = "", feeling = "";
  if (fromTimer) {
    minutes = Math.max(1, Math.round(elapsedMs(timer, timer.endOverride) / 60000));
    date = localDate(timer.startedAt);
    fromPage = timer.fromPage || 0;
    toPage = "";
    toPercent = "";
  } else if (existing) {
    ({ minutes, date, fromPage, toPage, note = "", feeling = "" } = existing);
    toPercent = existing.toPercent ?? "";
  } else {
    minutes = 30;
    date = today();
    fromPage = currentPage(b);
    toPage = "";
    toPercent = "";
  }

  view.innerHTML = `
    ${backButton()}
    <div class="review-head">
      ${coverHtml(b, "cover sm")}
      <div><p class="review-book">${esc(b.title)}</p><p class="muted small">${fromTimer ? "Terminar sesión" : existing ? "Editar sesión" : "Anotar sesión"}</p></div>
    </div>
    <form id="sf2" class="form session-form" novalidate>
      ${fromTimer ? `<p class="session-summary"><span class="clock">${fmtDur(minutes)}</span> de lectura${timer.endOverride ? ` hasta las ${timeOf(timer.endOverride)}` : ""}</p>` : ""}
      <div class="two">
        <label>Fecha<input type="date" name="date" value="${esc(date)}" max="${today()}"></label>
        <label>Minutos<input type="number" name="minutes" min="0" max="1440" inputmode="numeric" value="${esc(minutes)}"></label>
      </div>

      <fieldset class="unit-pick">
        <legend>¿Hasta dónde llegó?</legend>
        <div class="seg small-seg">
          <button type="button" data-unit="page" class="${unit === "page" ? "on" : ""}">Página</button>
          <button type="button" data-unit="percent" class="${unit === "percent" ? "on" : ""}">Porcentaje</button>
        </div>
        <div class="two">
          <label data-for="page">Desde la página<input type="number" name="fromPage" min="0" inputmode="numeric" value="${esc(fromPage)}"></label>
          <label data-for="page">Llegó a la página<input type="number" name="toPage" min="0" inputmode="numeric" value="${esc(toPage)}" placeholder="${b.pages ? "de " + b.pages : ""}"></label>
          <label data-for="percent" class="span2">Porcentaje que marca<input type="number" name="toPercent" min="0" max="100" step="0.1" inputmode="decimal" value="${esc(toPercent)}" placeholder="Ej. 42"></label>
        </div>
        <p class="muted small" id="pctHint"></p>
      </fieldset>

      <label>Nota sobre lo que leyó<textarea name="note" rows="2" placeholder="Qué pasó, una idea, una frase…">${esc(note)}</textarea></label>
      <label>¿Cómo se sintió?<textarea name="feeling" class="review-input feeling-input" rows="4" placeholder="Escribe lo que quieras…">${esc(feeling)}</textarea></label>

      ${b.status !== "read" ? `<label class="check"><input type="checkbox" name="finished"> Terminé el libro</label>` : ""}

      <div class="row-actions">
        <button class="btn primary" type="submit">Guardar sesión</button>
        ${fromTimer ? `<button class="btn" type="button" data-action="timer-resume-back">Seguir leyendo</button>` : ""}
      </div>
      ${fromTimer ? `<button type="button" class="link danger-link" data-action="timer-discard">Descartar esta sesión</button>` : ""}
      ${existing ? `<button type="button" class="link danger-link" data-action="session-delete" data-sid="${existing.id}">Eliminar sesión</button>` : ""}
    </form>`;

  const form = $("#sf2");
  let curUnit = unit;
  const applyUnit = () => {
    $$("[data-unit]", form).forEach((x) => x.classList.toggle("on", x.dataset.unit === curUnit));
    $$("[data-for]", form).forEach((x) => (x.hidden = x.dataset.for !== curUnit));
    updateHint();
  };
  const updateHint = () => {
    const hint = $("#pctHint");
    if (curUnit === "percent") {
      const v = parseFloat(form.elements.toPercent.value);
      hint.textContent = b.pages ? (isNaN(v) ? `Se convierte a páginas (${b.pages} en total).` : `≈ página ${Math.round((v / 100) * b.pages)} de ${b.pages}`) : "Sin número de páginas: el ritmo se medirá en % por hora.";
    } else {
      const to = parseInt(form.elements.toPage.value, 10), from = parseInt(form.elements.fromPage.value, 10) || 0;
      hint.textContent = to > from ? `${to - from} páginas en esta sesión` : "";
    }
    const fin = form.elements.finished;
    if (fin && b.pages) {
      const reached = curUnit === "percent" ? parseFloat(form.elements.toPercent.value) >= 100 : parseInt(form.elements.toPage.value, 10) >= b.pages;
      if (reached) fin.checked = true;
    }
  };
  $$("[data-unit]", form).forEach((x) => x.addEventListener("click", () => ((curUnit = x.dataset.unit), applyUnit())));
  form.addEventListener("input", updateHint);
  const grow = (t) => ((t.style.height = "auto"), (t.style.height = t.scrollHeight + 2 + "px"));
  $$("textarea", form).forEach((t) => (grow(t), t.addEventListener("input", () => grow(t))));
  applyUnit();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = form.elements;
    const fresh = getBook(b.id) || b;
    const mins = Math.max(0, parseInt(f.minutes.value, 10) || 0);
    const from = Math.max(0, parseInt(f.fromPage.value, 10) || 0);
    let to = null, pctVal = null;
    if (curUnit === "percent") {
      pctVal = parseFloat(f.toPercent.value);
      pctVal = isNaN(pctVal) ? null : Math.min(100, Math.max(0, pctVal));
      if (pctVal != null && fresh.pages) to = Math.round((pctVal / 100) * fresh.pages);
    } else {
      to = parseInt(f.toPage.value, 10);
      to = isNaN(to) ? null : Math.max(0, fresh.pages ? Math.min(to, fresh.pages) : to);
    }
    const finished = !!f.finished?.checked;
    if (finished && fresh.pages) (to = fresh.pages), curUnit === "percent" && (pctVal = 100);

    const session = {
      id: existing?.id || crypto.randomUUID(),
      date: f.date.value || today(),
      start: fromTimer ? timer.startedAt : existing?.start || null,
      minutes: mins,
      fromPage: from,
      toPage: to ?? from,
      fromPercent: fromTimer ? timer.fromPercent : existing?.fromPercent ?? fresh.progress?.percent ?? null,
      toPercent: pctVal,
      note: f.note.value.trim(),
      feeling: f.feeling.value.trim(),
      manual: !fromTimer && !existing?.start,
    };
    const sessions = [...(fresh.sessions || []).filter((s) => s.id !== session.id), session];
    const next = { ...fresh, sessions };
    // El progreso avanza con la sesión más reciente (editar una vieja no lo hace retroceder)
    const latest = [...sessions].sort((x, y) => (x.date + String(x.start || "")).localeCompare(y.date + String(y.start || ""))).pop();
    if (latest.id === session.id && (to != null || pctVal != null)) {
      next.progress = { page: to ?? currentPage(fresh), percent: pctVal ?? (fresh.pages && to != null ? (to / fresh.pages) * 100 : fresh.progress?.percent ?? null), unit: curUnit };
    } else if (next.progress) next.progress = { ...next.progress, unit: curUnit };
    if (!next.startedAt) next.startedAt = session.date;
    if (finished) {
      next.status = "read";
      next.finishedAt = session.date;
    } else if (next.status === "want") next.status = "reading";
    upsert(next);
    if (fromTimer) saveTimer(null), setWakeLock(false);
    toast(finished ? "¡Libro terminado! 🎉" : "Sesión guardada");
    go(finished ? `#/review/${b.id}` : `#/book/${b.id}`);
  });
}

// ---------- Timer olvidado ----------
function checkForgottenTimer() {
  if (!timer || timer.pausedAt) return;
  const since = Date.now() - Math.max(timer.startedAt, timer.confirmedAt || 0);
  if (since < FORGOT_AFTER || currentRoute === "session") return;
  const b = getBook(timer.bookId);
  if (!b) return saveTimer(null);
  if (sheet.open) return;
  sheet.innerHTML = `<div class="sheet-inner">
    <h2 class="sheet-title">¿Sigues leyendo?</h2>
    <p>El timer de <strong>${esc(b.title)}</strong> lleva <strong>${fmtDur(elapsedMs(timer) / 60000)}</strong>.</p>
    <div class="forgot-actions">
      <button class="btn primary" data-action="forgot-yes">Sí, sigo leyendo</button>
      <button class="btn" data-action="forgot-no">Ya paré</button>
    </div>
    <form id="forgotForm" class="forgot-form" hidden>
      <label>¿A qué hora paró?<input type="time" name="t" value="${timeOf(Math.min(Date.now(), timer.startedAt + 60 * 60000))}" required></label>
      <button class="btn primary">Continuar</button>
    </form>
  </div>`;
  sheet.showModal();
  $("#forgotForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const [hh, mm] = e.target.t.value.split(":").map(Number);
    const d = new Date();
    d.setHours(hh, mm, 0, 0);
    let end = d.getTime();
    if (end > Date.now()) end -= 86400000; // fue ayer
    if (end <= timer.startedAt) return toast(`El timer empezó a las ${timeOf(timer.startedAt)}`);
    saveTimer({ ...timer, endOverride: end, pausedAt: end });
    sheet.close();
    go(`#/session/${b.id}/new`);
  });
}

// ---------- Meta diaria y racha ----------
function minutesByDay() {
  const map = {};
  for (const b of db.books) for (const s of b.sessions || []) map[s.date] = (map[s.date] || 0) + (s.minutes || 0);
  if (timer && localDate(timer.startedAt) === today()) map[today()] = (map[today()] || 0) + elapsedMs(timer) / 60000;
  return map;
}
function goalStats() {
  const goal = settings.dailyGoal || 0;
  const map = minutesByDay();
  const todayMin = map[today()] || 0;
  let streak = 0;
  if (goal) {
    const d = new Date();
    if (todayMin < goal) d.setDate(d.getDate() - 1); // hoy todavía cuenta
    while ((map[d.toLocaleDateString("en-CA")] || 0) >= goal) streak++, d.setDate(d.getDate() - 1);
    if (todayMin >= goal && streak === 0) streak = 1;
  }
  return { goal, todayMin, streak };
}
function goalWidgetHtml() {
  const { goal, todayMin, streak } = goalStats();
  if (!goal) return `<button class="goal goal-empty" data-action="goal-set"><span>Ponerte una meta diaria de lectura</span><span aria-hidden="true">→</span></button>`;
  const pct = Math.min(1, todayMin / goal);
  const R = 20, C = 2 * Math.PI * R;
  return `<button class="goal" data-action="goal-set" aria-label="Meta diaria: ${Math.round(todayMin)} de ${goal} minutos">
    <svg viewBox="0 0 48 48" class="ring" aria-hidden="true"><circle cx="24" cy="24" r="${R}" class="ring-bg"/><circle cx="24" cy="24" r="${R}" class="ring-fg" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}"/></svg>
    <span class="goal-text"><strong>${Math.round(todayMin)} de ${goal} min hoy</strong><span class="muted">${pct >= 1 ? "¡Meta cumplida!" : `Faltan ${Math.ceil(goal - todayMin)} min`}${streak ? ` · racha de ${streak} día${streak > 1 ? "s" : ""}` : ""}</span></span>
  </button>`;
}
function openGoalSheet() {
  const cur = settings.dailyGoal || 0;
  sheet.innerHTML = `<div class="sheet-inner">
    <button class="close" data-close aria-label="Cerrar">×</button>
    <h2 class="sheet-title">Meta diaria</h2>
    <p class="muted small">Minutos de lectura al día. Cada día que la cumple suma a la racha.</p>
    <div class="goal-options">${[10, 15, 20, 30, 45, 60, 90].map((m) => `<button class="btn ${m === cur ? "primary" : ""}" data-goal="${m}">${m} min</button>`).join("")}</div>
    ${cur ? `<button class="link danger-link" data-goal="0">Quitar la meta</button>` : ""}
  </div>`;
  sheet._candidate = null;
  sheet.showModal();
}

// ---------- Compartir reseña como imagen ----------
function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

async function loadCoverForCanvas(url) {
  if (!url) return null;
  try {
    if (url.startsWith("data:")) return await loadImage(url);
    const r = await fetch("/api/cover?url=" + encodeURIComponent(url));
    if (!r.ok) return null;
    const blobUrl = URL.createObjectURL(await r.blob());
    const img = await loadImage(blobUrl);
    return img;
  } catch {
    return null;
  }
}

function wrapLines(ctx, text, maxWidth, maxLines) {
  const words = String(text).replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width <= maxWidth) line = test;
    else {
      if (line) lines.push(line);
      line = w;
      if (lines.length === maxLines) break;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  const used = lines.join(" ").length;
  if (used < String(text).replace(/\s+/g, " ").trim().length && lines.length) {
    let last = lines[lines.length - 1];
    while (last && ctx.measureText(last + "…").width > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = last.replace(/[\s,.;:]+$/, "") + "…";
  }
  return lines;
}

function drawStar(ctx, cx, cy, r, fill) {
  const path = new Path2D();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 ? r * 0.45 : r;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    path[i ? "lineTo" : "moveTo"](cx + rad * Math.cos(a), cy + rad * Math.sin(a));
  }
  path.closePath();
  ctx.fillStyle = "#dedad2";
  ctx.fill(path);
  if (fill > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - r, cy - r, fill >= 1 ? 2 * r : r, 2 * r);
    ctx.clip();
    ctx.fillStyle = "#161616";
    ctx.fill(path);
    ctx.restore();
  }
}

async function buildReviewImage(b) {
  const W = 1080, H = 1350;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  const serif = '"Inter", system-ui, sans-serif';
  const sans = '"Inter", system-ui, sans-serif';
  try {
    await Promise.all([
      document.fonts.load(`600 58px "Inter"`),
      document.fonts.load(`400 36px "Inter"`),
      document.fonts.load(`400 30px "Inter"`),
    ]);
  } catch {}

  ctx.fillStyle = "#ebe6df";
  ctx.fillRect(0, 0, W, H);

  // Texto de la reseña (sin spoilers en la imagen)
  const firstPart = REVIEW_PARTS.map(([k]) => b.reviewParts?.[k]?.text).find(Boolean);
  const quote = b.spoilers ? "" : b.review || firstPart || "";

  // Portada
  const coverH = quote ? 560 : 680;
  const coverW = Math.round(coverH * 2 / 3);
  const cx = (W - coverW) / 2, cy = quote ? 96 : 130;
  const img = await loadCoverForCanvas(b.cover);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.18)";
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 16;
  ctx.fillStyle = "#e9e5dd";
  ctx.fillRect(cx, cy, coverW, coverH);
  ctx.restore();
  if (img) {
    // recorte tipo "cover"
    const r = Math.max(coverW / img.width, coverH / img.height);
    const sw = coverW / r, sh = coverH / r;
    ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, cx, cy, coverW, coverH);
  } else {
    ctx.fillStyle = "#1f1f1f";
    ctx.font = `500 44px ${serif}`;
    ctx.textAlign = "left";
    const lines = wrapLines(ctx, b.title, coverW - 60, 5);
    lines.forEach((l, i) => ctx.fillText(l, cx + 30, cy + coverH - 40 - (lines.length - 1 - i) * 54));
  }

  let y = cy + coverH + 86;
  ctx.textAlign = "center";

  // Estrellas
  if (b.rating) {
    const r = 26, gap = 66, startX = W / 2 - gap * 2;
    for (let i = 0; i < 5; i++) drawStar(ctx, startX + i * gap, y, r, Math.max(0, Math.min(1, b.rating - i)));
    y += 74;
  }

  // Título y autor
  ctx.fillStyle = "#161616";
  ctx.font = `600 54px ${serif}`;
  const titleLines = wrapLines(ctx, b.title, W - 200, 2);
  titleLines.forEach((l) => {
    ctx.fillText(l, W / 2, y + 20);
    y += 66;
  });
  ctx.fillStyle = "#8a8780";
  ctx.font = `400 30px ${sans}`;
  if (b.authors?.length) {
    ctx.fillText(b.authors.join(", "), W / 2, y + 8);
    y += 48;
  }

  // Cita de la reseña
  if (quote) {
    y += 40;
    ctx.fillStyle = "#2a2a2a";
    ctx.font = `400 34px ${serif}`;
    const maxLines = Math.max(2, Math.floor((H - 130 - y) / 54));
    const lines = wrapLines(ctx, `“${quote}”`, W - 220, Math.min(maxLines, 5));
    lines.forEach((l) => {
      ctx.fillText(l, W / 2, y + 10);
      y += 54;
    });
  }

  // Pie
  ctx.fillStyle = "#a8a49c";
  ctx.font = `500 26px ${serif}`;
  const date = b.finishedAt ? " · " + fmtDate(b.finishedAt) : "";
  ctx.fillText("La biblioteca de Ilary" + date, W / 2, H - 64);

  return new Promise((res) => c.toBlob(res, "image/png"));
}

let shareBlobUrl = "";
async function shareReview(b, btn) {
  btn.disabled = true;
  try {
    const blob = await buildReviewImage(b);
    const fileName = `resena-${norm(b.title).slice(0, 40) || "libro"}.png`;
    const file = new File([blob], fileName, { type: "image/png" });
    if (shareBlobUrl) URL.revokeObjectURL(shareBlobUrl);
    shareBlobUrl = URL.createObjectURL(blob);
    const canShare = navigator.canShare?.({ files: [file] });
    sheet.innerHTML = `<div class="sheet-inner">
      <button class="close" data-close aria-label="Cerrar">×</button>
      <h2 class="sheet-title">Compartir reseña</h2>
      <img class="share-preview" src="${shareBlobUrl}" alt="Imagen de la reseña de ${esc(b.title)}">
      ${b.spoilers ? `<p class="muted small center">La reseña tiene spoilers, así que la imagen solo muestra la puntuación.</p>` : ""}
      <div class="status-buttons two-cols">
        ${canShare ? `<button class="btn primary" id="doShare">Compartir</button>` : ""}
        <a class="btn ${canShare ? "" : "primary"}" href="${shareBlobUrl}" download="${fileName}">Guardar imagen</a>
      </div>
    </div>`;
    sheet._candidate = null;
    if (!sheet.open) sheet.showModal();
    $("#doShare")?.addEventListener("click", async () => {
      try {
        await navigator.share({ files: [file], title: b.title });
      } catch (e) {
        if (e.name !== "AbortError") toast("No se pudo compartir; usa Guardar imagen");
      }
    });
  } catch (e) {
    console.warn(e);
    toast("No se pudo crear la imagen");
  } finally {
    btn.disabled = false;
  }
}

// ---------- Ajustes compartidos ----------
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { "content-type": "application/json", "x-app-key": db.key, ...(opts.headers || {}) } });
  if (r.status === 401) {
    askKey();
    throw Object.assign(new Error("unauthorized"), { status: 401 });
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || "HTTP " + r.status), { status: r.status });
  return data;
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  for (const k of Object.keys(settings)) if (settings[k] === null) delete settings[k];
  save("lib.settings", settings);
  try {
    await api("/api/settings", { method: "POST", body: JSON.stringify(patch) });
  } catch (e) {
    console.warn("No se pudieron guardar los ajustes en la nube", e);
  }
}

async function loadSettings() {
  if (!navigator.onLine) return;
  try {
    const { settings: remote } = await api("/api/settings");
    settings = { ...settings, ...remote };
    save("lib.settings", settings);
    if (!timer && remote.activeTimer) {
      timer = remote.activeTimer;
      save("lib.timer", timer);
      updateTimerPill();
    }
  } catch {}
}

// ---------- Goodreads: fusión ----------
const GR_SHELVES = { read: "read", "currently-reading": "reading", "to-read": "want" };
const GR_DNF = /(^|-)(dnf|did-not-finish|abandon|abandonado|abandonados|no-terminado|dejado)/i;
const olCoverByIsbn = (isbn) => (isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false` : "");

function splitSeries(raw) {
  const t = String(raw || "").trim();
  const m = t.match(/^(.*\S)\s*\(([^()]+?),?\s*#(\d+(?:\.\d+)?)(?:-\d+)?\)$/);
  return m ? { title: m[1], series: { name: m[2].trim(), number: parseFloat(m[3]) } } : { title: t, series: null };
}

// Campos que vienen de Goodreads y que ella también puede editar aquí.
const GR_SYNCED = ["status", "rating", "review", "tags", "finishedAt", "series"];
const grSnapshot = (g) => JSON.stringify(GR_SYNCED.map((k) => g[k] ?? null));

function findMatch(g) {
  return (
    (g.grId && db.books.find((b) => b.grId === g.grId)) ||
    (g.isbn && db.books.find((b) => b.isbn && b.isbn === g.isbn)) ||
    db.books.find((b) => bookKey(b) === bookKey(g))
  );
}

// Fusiona libros de Goodreads sin pisar lo que ella cambió aquí:
// un campo solo se actualiza si cambió en Goodreads desde la última sincronización.
function mergeGoodreads(list) {
  let added = 0, updated = 0;
  const ops = [];
  const now = Date.now();
  for (const g of list) {
    if (!g.title || !g.status) continue;
    const snap = grSnapshot(g);
    const existing = findMatch(g);
    if (!existing) {
      const book = {
        id: crypto.randomUUID(),
        title: g.title,
        subtitle: "",
        authors: g.authors || [],
        olAuthors: [],
        year: g.year || "",
        pages: g.pages || null,
        genres: [],
        publisher: g.publisher || "",
        description: g.description || "",
        language: "",
        isbn: g.isbn || "",
        cover: g.cover || olCoverByIsbn(g.isbn),
        olWorkKey: "",
        links: g.link ? { goodreads: g.link } : {},
        source: "goodreads",
        status: g.status,
        addedAt: g.addedAt || today(),
        startedAt: g.status === "reading" ? g.startedAt || today() : g.startedAt || "",
        finishedAt: g.finishedAt || "",
        rating: g.rating || 0,
        review: g.review || "",
        tags: g.tags || [],
        series: g.series || null,
        grId: g.grId || "",
        grSnap: snap,
        updatedAt: now,
      };
      db.books.push(book);
      ops.push({ op: "upsert", book });
      added++;
      continue;
    }
    const next = { ...existing };
    let changed = false;
    // Datos del libro: solo rellenar huecos
    for (const k of ["year", "pages", "isbn", "description", "publisher"]) {
      if (!next[k] && g[k]) (next[k] = g[k]), (changed = true);
    }
    if (!next.cover && (g.cover || g.isbn)) (next.cover = g.cover || olCoverByIsbn(g.isbn)), (changed = true);
    if (g.link && !next.links?.goodreads) (next.links = { ...(next.links || {}), goodreads: g.link }), (changed = true);
    if (g.grId && !next.grId) (next.grId = g.grId), (changed = true);
    // Datos de lectura: solo si cambiaron en Goodreads
    if (existing.grSnap !== snap) {
      const prev = existing.grSnap ? JSON.parse(existing.grSnap) : null;
      GR_SYNCED.forEach((k, i) => {
        const incoming = g[k] ?? null;
        const emptyIncoming = incoming === null || incoming === "" || incoming === 0 || (Array.isArray(incoming) && !incoming.length);
        const wasChangedThere = !prev || JSON.stringify(prev[i]) !== JSON.stringify(incoming);
        if (wasChangedThere && !(emptyIncoming && !prev)) next[k] = incoming;
      });
      if (next.status === "reading" && !next.startedAt) next.startedAt = today();
      next.grSnap = snap;
      changed = true;
    }
    if (changed) {
      next.updatedAt = now;
      Object.assign(existing, next);
      ops.push({ op: "upsert", book: next });
      updated++;
    }
  }
  if (ops.length) {
    db.queue.push(...ops);
    persist();
    scheduleSync();
  }
  return { added, updated };
}

// ---------- Goodreads: conexión por perfil ----------
let grBusy = false;

async function goodreadsSync({ silent = false, user = settings.grUser } = {}) {
  if (grBusy || !user || !navigator.onLine) return null;
  grBusy = true;
  updateGrStatus("Sincronizando con Goodreads…");
  try {
    const data = await api("/api/goodreads?user=" + encodeURIComponent(user));
    const result = mergeGoodreads(data.books || []);
    await saveSettings({ grUser: data.userId, grName: data.userName || settings.grName || "", grLastSync: Date.now(), grCount: (data.books || []).length });
    const msg = result.added || result.updated
      ? `Goodreads: ${result.added} nuevo(s), ${result.updated} actualizado(s)`
      : "Goodreads: todo al día";
    if (!silent || result.added || result.updated) toast(msg);
    if (currentRoute === "shelf" || currentRoute === "goodreads") rerenderSoft();
    return result;
  } catch (e) {
    const reason = {
      404: "No encontramos ese perfil de Goodreads.",
      403: "Ese perfil es privado. Hay que hacerlo público en Goodreads.",
      400: "Ese enlace no parece un perfil de Goodreads.",
    }[e.status] || "No se pudo conectar con Goodreads. Inténtalo más tarde.";
    if (!silent) toast(reason);
    updateGrStatus(reason, true);
    throw e;
  } finally {
    grBusy = false;
    updateGrStatus();
  }
}

function maybeAutoSyncGoodreads() {
  const SIX_HOURS = 6 * 3600 * 1000;
  if (settings.grUser && Date.now() - (settings.grLastSync || 0) > SIX_HOURS) goodreadsSync({ silent: true }).catch(() => {});
}

function rerenderSoft() {
  if (document.activeElement?.matches("input, textarea")) return;
  const y = window.scrollY;
  route();
  window.scrollTo(0, y);
}

function updateGrStatus(text, isError) {
  const el = $("#grStatus");
  if (!el) return;
  if (text) {
    el.textContent = text;
    el.classList.toggle("error", !!isError);
    return;
  }
  if (!el.classList.contains("error")) el.textContent = grStatusText();
}

function timeAgo(ts) {
  if (!ts) return "nunca";
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "ahora mismo";
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}
const grStatusText = () =>
  settings.grUser ? `Última sincronización: ${timeAgo(settings.grLastSync)}${settings.grCount != null ? ` · ${settings.grCount} libros en Goodreads` : ""}` : "";

function renderGoodreads() {
  window.scrollTo(0, 0);
  const connected = !!settings.grUser;
  view.innerHTML = `
    ${backButton()}
    <h1 class="page-title">Goodreads</h1>

    <section class="panel">
      ${
        connected
          ? `<p class="panel-title">Conectado${settings.grName ? ` como <strong>${esc(settings.grName)}</strong>` : ""}</p>
             <p class="muted small" id="grStatus">${grStatusText()}</p>
             <p class="small">Lo nuevo que agregue en Goodreads aparece aquí solo. Lo que cambie en esta app no se pierde al sincronizar.</p>
             <div class="row-actions tight">
               <button class="btn primary" data-action="gr-sync">Sincronizar ahora</button>
               <button class="btn" data-action="gr-disconnect">Desconectar</button>
             </div>`
          : `<p class="panel-title">Conectar su perfil</p>
             <p class="small">Pega el enlace de su perfil de Goodreads. Se traen sus estanterías con puntuaciones, reseñas, fechas y etiquetas.</p>
             <form id="grForm" class="searchbar">
               <input name="user" placeholder="goodreads.com/user/show/…" autocomplete="off" inputmode="url" aria-label="Enlace del perfil de Goodreads">
               <button class="btn primary">Conectar</button>
             </form>
             <p class="muted small" id="grStatus"></p>
             <details class="help">
               <summary>¿Dónde está el enlace?</summary>
               <p>En la app de Goodreads: <em>Perfil → Compartir</em>, o en la web, la dirección de su página de perfil. También vale solo el número.</p>
               <p>El perfil tiene que ser público: en Goodreads, <em>Settings → Privacy</em>, la opción de quién puede ver el perfil en <em>anyone</em>.</p>
             </details>`
      }
    </section>

    <section class="panel">
      <p class="panel-title">Historial completo (CSV)</p>
      <p class="small">El enlace trae casi todo, pero el archivo de exportación de Goodreads es más completo. Se hace desde un navegador:</p>
      <ol class="small steps">
        <li>Entrar a <a href="https://www.goodreads.com/review/import" target="_blank" rel="noopener">goodreads.com/review/import</a></li>
        <li>Tocar <em>Export Library</em> y esperar a que aparezca el enlace del archivo</li>
        <li>Descargarlo y subirlo aquí</li>
      </ol>
      <label class="btn">Subir CSV de Goodreads<input type="file" accept=".csv,text/csv" id="grCsv" hidden></label>
      <p class="muted small" id="csvStatus"></p>
    </section>`;

  $("#grForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const val = e.target.user.value.trim();
    if (!val) return;
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    try {
      await goodreadsSync({ user: val });
      renderGoodreads();
    } catch {
      btn.disabled = false;
    }
  });

  $("#grCsv").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const status = $("#csvStatus");
    status.textContent = "Leyendo archivo…";
    try {
      const rows = parseGoodreadsCsv(await f.text());
      if (!rows.length) throw new Error("vacío");
      const { added, updated } = mergeGoodreads(rows);
      status.textContent = `Listo: ${added} libro(s) nuevo(s) y ${updated} actualizado(s) de ${rows.length} en el archivo.`;
      toast("Importación completada");
    } catch {
      status.textContent = "Ese archivo no parece una exportación de Goodreads.";
    }
    e.target.value = "";
  });
}

// ---------- Goodreads: CSV ----------
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') (field += '"'), i++;
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field), rows.push(row), (row = []), (field = "");
    } else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => r.some((x) => x.trim()));
}

function parseGoodreadsCsv(text) {
  const [head, ...rows] = parseCsv(text.replace(/^﻿/, ""));
  const idx = Object.fromEntries((head || []).map((h, i) => [h.trim(), i]));
  if (idx["Title"] == null || idx["Exclusive Shelf"] == null) throw new Error("formato");
  const get = (r, k) => (idx[k] != null ? (r[idx[k]] || "").trim() : "");
  const isbnOf = (v) => v.replace(/^="?|"$/g, "").replace(/[^\dX]/gi, "");
  const date = (v) => (/^\d{4}\/\d{2}\/\d{2}$/.test(v) ? v.replace(/\//g, "-") : "");
  return rows.map((r) => {
    const exclusive = get(r, "Exclusive Shelf");
    const shelves = get(r, "Bookshelves").split(",").map((s) => s.trim()).filter(Boolean);
    const status = GR_DNF.test(exclusive) || shelves.some((s) => GR_DNF.test(s)) ? "abandoned" : GR_SHELVES[exclusive] || "";
    const { title, series } = splitSeries(get(r, "Title"));
    const authors = [get(r, "Author"), ...get(r, "Additional Authors").split(",")].map((s) => s.trim()).filter(Boolean);
    const grId = get(r, "Book Id");
    return {
      grId,
      title,
      series,
      authors,
      year: get(r, "Original Publication Year") || get(r, "Year Published"),
      pages: parseInt(get(r, "Number of Pages"), 10) || null,
      isbn: isbnOf(get(r, "ISBN13")) || isbnOf(get(r, "ISBN")),
      publisher: get(r, "Publisher"),
      status,
      rating: parseInt(get(r, "My Rating"), 10) || 0,
      review: stripHtml(get(r, "My Review")),
      tags: shelves.filter((s) => s !== exclusive && !GR_SHELVES[s] && !GR_DNF.test(s)),
      finishedAt: status === "read" || status === "abandoned" ? date(get(r, "Date Read")) : "",
      addedAt: date(get(r, "Date Added")),
      link: grId ? `https://www.goodreads.com/book/show/${grId}` : "",
    };
  });
}

// ---------- Eventos globales ----------
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-action],[data-preview],[data-add],[data-status],[data-close],[data-author-work],[data-rate],[data-goal],#reviewText");
  if (!t) return;

  if (t.dataset.rate) {
    const picker = t.closest("[data-picker]");
    const v = +t.dataset.rate;
    return setPicker(picker, +picker.dataset.value === v ? 0 : v);
  }
  if (t.id === "reviewText") return t.classList.remove("clamp");
  if (t.dataset.goal != null) {
    saveSettings({ dailyGoal: +t.dataset.goal || null });
    sheet.close();
    if (currentRoute === "shelf") rerenderSoft();
    return;
  }

  if (t.dataset.close != null) return t.closest("dialog")?.close();
  if (t.dataset.preview != null) return openPreview(lastResults[+t.dataset.preview]);
  if (t.dataset.authorWork != null) return openPreview(previewList[+t.dataset.authorWork]);

  if (t.dataset.add) {
    const b = addBook(sheet._candidate, t.dataset.add);
    sheet.close();
    return go(`#/book/${b.id}`);
  }

  if (t.dataset.status) {
    const b = getBook(view._book);
    if (b) {
      changeStatus(b, t.dataset.status);
      renderBook(b.id);
    }
    return;
  }

  switch (t.dataset.action) {
    case "back":
      return history.length > 1 ? history.back() : go("#/shelf/" + lastShelf);
    case "scan":
      return openScanner();
    case "cont-resume": {
      const b = getBook(t.dataset.id);
      if (b) startTimer(b, { reading: true });
      return;
    }
    case "cont-open":
      return go(`#/read/${t.dataset.id}`);
    case "menu-goal":
      sheet.close();
      return setTimeout(openGoalSheet, 50);
    case "timer-start":
    case "timer-read": {
      const b = getBook(view._book);
      if (b) startTimer(b, { reading: t.dataset.action === "timer-read" });
      return;
    }
    case "timer-pause":
      return togglePause();
    case "timer-finish":
      if (timer) {
        if (!timer.pausedAt) saveTimer({ ...timer, pausedAt: Date.now() });
        go(`#/session/${timer.bookId}/new`);
      }
      return;
    case "timer-resume-back":
      if (timer) {
        const { endOverride, ...rest } = timer;
        // El tiempo en el formulario no cuenta como lectura
        saveTimer(rest.pausedAt ? { ...rest, pausedMs: (rest.pausedMs || 0) + (Date.now() - rest.pausedAt), pausedAt: null } : rest);
        go(`#/book/${timer.bookId}`);
      }
      return;
    case "timer-discard":
      if (timer && confirm("¿Descartar esta sesión? No se guardará el tiempo.")) {
        const id = timer.bookId;
        saveTimer(null);
        setWakeLock(false);
        go(`#/book/${id}`);
      }
      return;
    case "session-delete": {
      const id = location.hash.split("/")[2];
      const b = getBook(id);
      if (b && confirm("¿Eliminar esta sesión?")) {
        upsert({ ...b, sessions: (b.sessions || []).filter((x) => x.id !== t.dataset.sid) });
        toast("Sesión eliminada");
        go(`#/book/${id}`);
      }
      return;
    }
    case "read-exit":
      return go(timer ? `#/book/${timer.bookId}` : "#/shelf/all");
    case "forgot-yes":
      saveTimer({ ...timer, confirmedAt: Date.now() });
      return sheet.close();
    case "forgot-no":
      $("#forgotForm").hidden = false;
      $(".forgot-actions").hidden = true;
      return;
    case "goal-set":
      return openGoalSheet();
    case "share-review": {
      const b = getBook(view._book);
      if (b) shareReview(b, t);
      return;
    }
    case "gr-sync":
      return goodreadsSync().catch(() => {});
    case "gr-disconnect":
      if (confirm("¿Desconectar Goodreads? Los libros ya importados se quedan.")) {
        saveSettings({ grUser: null, grName: null, grLastSync: null, grCount: null }).then(renderGoodreads);
      }
      return;
    case "more": {
      $("#bdesc")?.classList.remove("clamp");
      return t.remove();
    }
    case "delete": {
      const b = getBook(view._book);
      if (b && confirm(`¿Eliminar «${b.title}» de la biblioteca?`)) {
        removeBook(b.id);
        toast("Libro eliminado");
        go("#/shelf/" + b.status);
      }
      return;
    }
    case "clear-cover": {
      formCover = "";
      $("#bf").coverUrl.value = "";
      $("#coverPreview").innerHTML = coverHtml({ title: $("#bf").elements.title.value || "Portada" }, "cover lg");
      return t.remove();
    }
  }
});

document.addEventListener("change", (e) => {
  const field = e.target.dataset?.date;
  if (!field) return;
  const b = getBook(view._book);
  if (b) upsert({ ...b, [field]: e.target.value });
});

// Teclado en el selector de estrellas
document.addEventListener("keydown", (e) => {
  const picker = e.target.closest?.("[data-picker]");
  if (!picker) return;
  const step = { ArrowRight: 0.5, ArrowUp: 0.5, ArrowLeft: -0.5, ArrowDown: -0.5 }[e.key];
  if (step == null) return;
  e.preventDefault();
  setPicker(picker, (+picker.dataset.value || 0) + step);
});

// Cerrar hojas tocando el fondo
$$("dialog").forEach((d) =>
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close();
  })
);

// ---------- Encabezado: búsqueda, vista y menú ----------
const VIEW_ICONS = {
  covers: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6.5" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="13.5" y="4" width="6.5" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="4" y="14.5" width="6.5" height="5.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="13.5" y="14.5" width="6.5" height="5.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`,
  spines: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4v15M9 6v13M13 3v16M17.5 6l2.5 13M3 20.5h18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
};
function paintViewBtn() {
  const btn = $("#viewBtn");
  btn.innerHTML = VIEW_ICONS[viewMode];
  btn.title = viewMode === "covers" ? "Vista: portadas (toca para lomos)" : "Vista: lomos (toca para portadas)";
}
$("#viewBtn").addEventListener("click", () => {
  viewMode = viewMode === "covers" ? "spines" : "covers";
  save("lib.view2", viewMode);
  paintViewBtn();
  if (currentRoute === "shelf" && drawShelf) drawShelf();
  else go("#/shelf/" + lastShelf);
  toast(viewMode === "covers" ? "Vista de portadas" : "Vista de estantería");
});
paintViewBtn();

const q = $("#q");
q.addEventListener("input", () => {
  const wasFiltering = !!shelfFilter.trim();
  shelfFilter = q.value;
  const isFiltering = !!shelfFilter.trim();
  if (currentRoute !== "shelf") return go("#/shelf/all");
  if (wasFiltering !== isFiltering) renderShelf(lastShelf), q.focus();
  else drawShelf?.();
});

$("#menuBtn").addEventListener("click", () => {
  const pending = db.queue.length;
  sheet.innerHTML = `<div class="sheet-inner">
    <button class="close" data-close aria-label="Cerrar">×</button>
    <h2 class="sheet-title">Biblioteca de Ilary</h2>
    <p class="muted small">${navigator.onLine ? (pending ? `${pending} cambio(s) por sincronizar` : "Todo sincronizado") : "Sin conexión · los cambios se guardan en el teléfono"}</p>
    <nav class="menu-list">
      <a href="#/add">Agregar un libro<span>→</span></a>
      <button data-action="menu-goal">Meta diaria${settings.dailyGoal ? ` · ${settings.dailyGoal} min` : ""}<span>→</span></button>
      <a href="#/goodreads">Goodreads${settings.grUser ? " · conectado" : ""}<span>→</span></a>
    </nav>
  </div>`;
  sheet._candidate = null;
  sheet.showModal();
});

$("#timerPill").addEventListener("click", () => timer && go(`#/read/${timer.bookId}`));
window.addEventListener("hashchange", route);
window.addEventListener("online", () => {
  updateSyncBadge();
  sync();
});
window.addEventListener("offline", updateSyncBadge);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    sync();
    maybeAutoSyncGoodreads();
    checkForgottenTimer();
    tick();
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("SW", e));
}

route();
updateSyncBadge();
sync();
loadSettings().then(() => {
  if (currentRoute === "shelf") rerenderSoft();
  maybeAutoSyncGoodreads();
});
