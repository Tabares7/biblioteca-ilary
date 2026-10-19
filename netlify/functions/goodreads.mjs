// GET /api/goodreads?user=<enlace o id del perfil>
// Devuelve los libros de las estanterías públicas de Goodreads, ya normalizados.
import { parseFeed, extractUserId } from "../lib/goodreads.mjs";

const SHELVES = ["read", "currently-reading", "to-read"];
const MAX_PAGES = 15; // ~1500 libros por estantería
const UA = "Mozilla/5.0 (compatible; BibliotecaPersonal/1.0)";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function getPassword() {
  try {
    return globalThis.Netlify?.env.get("APP_PASSWORD") || process.env.APP_PASSWORD || "";
  } catch {
    return process.env.APP_PASSWORD || "";
  }
}

async function fetchShelf(userId, shelf) {
  const books = [];
  const seen = new Set();
  let userName = "";
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://www.goodreads.com/review/list_rss/${userId}?shelf=${encodeURIComponent(shelf)}&page=${page}`;
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/rss+xml, text/xml" } });
    if (r.status === 404) throw Object.assign(new Error("not_found"), { code: 404 });
    if (!r.ok) throw Object.assign(new Error("upstream_" + r.status), { code: 502 });
    const xml = await r.text();
    if (!xml.includes("<rss")) throw Object.assign(new Error("private"), { code: 403 });
    const feed = parseFeed(xml, shelf);
    userName = userName || feed.userName;
    const fresh = feed.items.filter((b) => b.grId && !seen.has(b.grId));
    fresh.forEach((b) => seen.add(b.grId));
    books.push(...fresh);
    if (!fresh.length || feed.items.length < 20) break;
  }
  return { books, userName };
}

export default async (req) => {
  const password = getPassword();
  if (password && req.headers.get("x-app-key") !== password) return json({ error: "unauthorized" }, 401);

  const input = new URL(req.url).searchParams.get("user") || "";
  const userId = extractUserId(input);
  if (!userId) return json({ error: "bad_user" }, 400);

  try {
    const results = await Promise.all([...SHELVES, "#ALL#"].map((s) => fetchShelf(userId, s)));
    const byId = new Map();
    // Primero las estanterías principales (su estado es fiable)
    results.slice(0, SHELVES.length).forEach((r) => r.books.forEach((b) => byId.has(b.grId) || byId.set(b.grId, b)));
    // Luego #ALL#: solo agrega los que están en estanterías propias tipo "abandonados"
    for (const b of results[SHELVES.length].books) {
      if (!byId.has(b.grId) && b.status === "abandoned") byId.set(b.grId, b);
    }
    const userName = results.find((r) => r.userName)?.userName || "";
    return json({ userId, userName, books: [...byId.values()] });
  } catch (e) {
    const code = e.code || 500;
    return json({ error: e.message || "error" }, code === 404 ? 404 : code === 403 ? 403 : 502);
  }
};

export const config = { path: "/api/goodreads" };
