// API de la biblioteca: guarda todos los libros en un único documento JSON en Netlify Blobs.
//   GET  /api/books  -> { books: [...] }
//   POST /api/sync   -> body { ops: [{op:"upsert", book} | {op:"delete", id}] } -> { books: [...] }
import { getStore } from "@netlify/blobs";

const KEY = "library";
const MAX_BODY = 8 * 1024 * 1024;

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

export function applyOp(books, op) {
  if (!op || typeof op !== "object") return books;
  if (op.op === "upsert" && op.book && typeof op.book.id === "string") {
    const i = books.findIndex((b) => b.id === op.book.id);
    if (i < 0) books.push(op.book);
    else if ((books[i].updatedAt || 0) <= (op.book.updatedAt || 0)) books[i] = op.book;
  } else if (op.op === "delete" && typeof op.id === "string") {
    books = books.filter((b) => b.id !== op.id);
  }
  return books;
}

export default async (req) => {
  const password = getPassword();
  if (password && req.headers.get("x-app-key") !== password) {
    return json({ error: "unauthorized" }, 401);
  }

  const store = getStore({ name: "biblioteca", consistency: "strong" });
  const { pathname } = new URL(req.url);
  let books = (await store.get(KEY, { type: "json" })) || [];

  if (req.method === "GET" && pathname === "/api/books") {
    return json({ books });
  }

  if (req.method === "POST" && pathname === "/api/sync") {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return json({ error: "too_large" }, 413);
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return json({ error: "bad_json" }, 400);
    }
    const ops = Array.isArray(body.ops) ? body.ops : [];
    if (ops.length) {
      for (const op of ops) books = applyOp(books, op);
      await store.setJSON(KEY, books);
    }
    return json({ books });
  }

  // Ajustes compartidos entre dispositivos (p. ej. conexión con Goodreads)
  if (pathname === "/api/settings") {
    if (req.method === "GET") return json({ settings: (await store.get("settings", { type: "json" })) || {} });
    if (req.method === "POST") {
      let patch;
      try {
        patch = JSON.parse((await req.text()) || "{}");
      } catch {
        return json({ error: "bad_json" }, 400);
      }
      const current = (await store.get("settings", { type: "json" })) || {};
      const next = { ...current, ...patch };
      for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
      await store.setJSON("settings", next);
      return json({ settings: next });
    }
  }

  return json({ error: "not_found" }, 404);
};

export const config = { path: ["/api/books", "/api/sync", "/api/settings"] };
