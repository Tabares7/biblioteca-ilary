// Lectura de las estanterías públicas de Goodreads a través de sus feeds RSS.
// Goodreads cerró su API en 2020; los RSS de cada estantería siguen siendo públicos
// cuando el perfil es público.

export const SHELF_MAP = { read: "read", "currently-reading": "reading", "to-read": "want" };
const DNF = /(^|-)(dnf|did-not-finish|abandon|abandonado|abandonados|no-terminado|dejado)/i;

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", iexcl: "¡", iquest: "¿",
  ordf: "ª", ordm: "º", szlig: "ß", aelig: "æ", oslash: "ø", aring: "å", eacute: "é",
};
const MARKS = { acute: "\u0301", grave: "\u0300", circ: "\u0302", tilde: "\u0303", uml: "\u0308", cedil: "\u0327", ring: "\u030A" };
export function decode(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-zA-Z])(acute|grave|circ|tilde|uml|cedil|ring);/g, (_, l, k) => (l + MARKS[k]).normalize("NFC"))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n] ?? ENTITIES[n.toLowerCase()] ?? m);
}
export function htmlToText(s) {
  return decode(
    String(s || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  if (!m) return "";
  const v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return cdata ? cdata[1].trim() : decode(v);
}

export function toISODate(s) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d)) return "";
  // Las fechas de Goodreads vienen a medianoche en la zona del usuario; tomamos la fecha tal cual.
  const m = String(s).match(/(\d{1,2}) (\w{3}) (\d{4})/);
  if (m) {
    const months = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
    if (months[m[2]]) return `${m[3]}-${String(months[m[2]]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return d.toISOString().slice(0, 10);
}

// "Título (Saga, #2)" -> { title: "Título", series: { name: "Saga", number: 2 } }
export function splitSeries(raw) {
  const t = String(raw || "").trim();
  const m = t.match(/^(.*\S)\s*\(([^()]+?),?\s*#(\d+(?:\.\d+)?)(?:-\d+)?\)$/);
  if (!m) return { title: t, series: null };
  return { title: m[1], series: { name: m[2].trim(), number: parseFloat(m[3]) } };
}

export function bestCover(url) {
  if (!url || /nophoto/.test(url)) return "";
  // Quitar el sufijo de tamaño (._SY75_, ._SX98_) para obtener la imagen grande
  return url.replace(/\._S[XY]\d+_\./, ".").replace(/^http:/, "https:");
}

export function statusFrom(primaryShelf, shelves) {
  if (shelves.some((s) => DNF.test(s))) return "abandoned";
  return SHELF_MAP[primaryShelf] || "";
}

export function parseItem(xml, primaryShelf) {
  const shelves = tag(xml, "user_shelves")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const { title, series } = splitSeries(tag(xml, "title"));
  const rating = parseInt(tag(xml, "user_rating"), 10) || 0;
  const pages = parseInt(tag(xml, "num_pages"), 10) || null;
  const isbn = tag(xml, "isbn").replace(/[^\dX]/gi, "");
  const status = statusFrom(primaryShelf, shelves);
  return {
    grId: tag(xml, "book_id"),
    title,
    series,
    authors: tag(xml, "author_name") ? [tag(xml, "author_name")] : [],
    year: (tag(xml, "book_published").match(/\d{4}/) || [""])[0],
    pages,
    isbn,
    cover: bestCover(tag(xml, "book_large_image_url") || tag(xml, "book_image_url")),
    description: htmlToText(tag(xml, "book_description")),
    status,
    rating,
    review: htmlToText(tag(xml, "user_review")),
    tags: shelves.filter((s) => !SHELF_MAP[s] && !DNF.test(s)),
    finishedAt: status === "read" || status === "abandoned" ? toISODate(tag(xml, "user_read_at")) : "",
    addedAt: toISODate(tag(xml, "user_date_added")),
    link: tag(xml, "book_id") ? `https://www.goodreads.com/book/show/${tag(xml, "book_id")}` : "",
  };
}

export function parseFeed(xml, primaryShelf) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  const channelTitle = tag(xml.split("<item>")[0], "title");
  return { items: items.map((i) => parseItem(i, primaryShelf)), userName: channelTitle.replace(/'s bookshelf.*$/i, "").trim() };
}

// Acepta: 12345, 12345-nombre, goodreads.com/user/show/12345-nombre, goodreads.com/review/list/12345...
export function extractUserId(input) {
  const s = String(input || "").trim();
  const m = s.match(/goodreads\.com\/(?:\w+\/)?(?:user\/show|review\/list(?:_rss)?|user)\/(\d+)/i) || s.match(/^(\d+)(?:-[\w-]*)?$/);
  return m ? m[1] : "";
}
