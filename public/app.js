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
let lastShelf = "reading";
let routeSeq = 0;

function route() {
  routeSeq++;
  const [path, qs] = (location.hash.slice(1) || "/shelf/reading").split("?");
  const parts = path.split("/").filter(Boolean);
  const params = new URLSearchParams(qs || "");
  currentRoute = parts[0];
  closeDialogs();
  const navKey = ["add", "manual"].includes(parts[0]) ? "add" : "shelf";
  $$(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === navKey));
  $('.nav a[data-nav="shelf"]').href = `#/shelf/${lastShelf}`;

  switch (parts[0]) {
    case "shelf":
      lastShelf = SHELVES[parts[1]] ? parts[1] : "reading";
      return renderShelf(lastShelf);
    case "add":
      return renderAdd(params.get("q") || "");
    case "manual":
      return renderForm(null, params);
    case "edit":
      return renderForm(getBook(parts[1]), params);
    case "book":
      return renderBook(parts[1]);
    case "author":
      return renderAuthor(decodeURIComponent(parts[1] || ""), parts[2] || "");
    default:
      location.hash = "#/shelf/reading";
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
function renderShelf(status) {
  window.scrollTo(0, 0);
  const counts = {};
  db.books.forEach((b) => (counts[b.status] = (counts[b.status] || 0) + 1));
  view.innerHTML = `
    <div class="tabs" role="tablist">
      ${Object.entries(SHELVES)
        .map(
          ([k, s]) =>
            `<a href="#/shelf/${k}" role="tab" aria-selected="${k === status}" class="tab ${k === status ? "active" : ""}">${s.label}<span class="count">${counts[k] || 0}</span></a>`
        )
        .join("")}
    </div>
    <input class="filter" type="search" placeholder="Filtrar por título o autor" value="${esc(shelfFilter)}" aria-label="Filtrar">
    <div class="grid" id="grid"></div>`;

  const draw = () => {
    const f = norm(shelfFilter);
    const sortKey = { reading: "startedAt", read: "finishedAt", abandoned: "finishedAt", want: "addedAt" }[status];
    const list = db.books
      .filter((b) => b.status === status)
      .filter((b) => !f || norm(b.title).includes(f) || (b.authors || []).some((a) => norm(a).includes(f)))
      .sort((a, b) => String(b[sortKey] || "").localeCompare(String(a[sortKey] || "")) || (b.updatedAt || 0) - (a.updatedAt || 0));
    $("#grid").innerHTML = list.length
      ? list.map(cardHtml).join("")
      : `<div class="empty">
          <p>${f ? "Nada coincide con ese filtro." : SHELVES[status].empty}</p>
          ${f ? "" : `<a class="btn primary" href="#/add">Agregar un libro</a>`}
        </div>`;
  };
  $(".filter").addEventListener("input", (e) => {
    shelfFilter = e.target.value;
    draw();
  });
  draw();
}

function cardHtml(b) {
  let sub = "";
  if (b.status === "reading" && b.startedAt) sub = `Desde ${fmtDate(b.startedAt)}`;
  if (b.status === "read" && b.finishedAt) sub = fmtDate(b.finishedAt);
  return `<a class="card" href="#/book/${b.id}">
    ${coverHtml(b)}
    <span class="card-title">${esc(b.title)}</span>
    <span class="card-author">${esc((b.authors || []).join(", "))}</span>
    ${sub ? `<span class="card-sub">${sub}</span>` : ""}
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
    [`https://www.goodreads.com/search?q=${encodeURIComponent(grQuery)}`, "Goodreads"],
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
          <h1>${esc(b.title)}</h1>
          ${b.subtitle ? `<p class="sub">${esc(b.subtitle)}</p>` : ""}
          <p class="authors">${authorLinks(b) || `<span class="muted">Autor desconocido</span>`}</p>
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

// ---------- Eventos globales ----------
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-action],[data-preview],[data-add],[data-status],[data-close],[data-author-work]");
  if (!t) return;

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

// Cerrar hojas tocando el fondo
$$("dialog").forEach((d) =>
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close();
  })
);

window.addEventListener("hashchange", route);
window.addEventListener("online", () => {
  updateSyncBadge();
  sync();
});
window.addEventListener("offline", updateSyncBadge);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && sync());

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("SW", e));
}

route();
updateSyncBadge();
sync();
