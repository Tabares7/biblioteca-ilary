// GET /api/cover?url=<portada>
// Sirve portadas desde el mismo dominio para poder dibujarlas en un canvas
// (necesario para generar la imagen de la reseña). Solo hosts de portadas conocidos.
const ALLOWED = [
  "covers.openlibrary.org",
  "books.google.com",
  "books.googleusercontent.com",
  "i.gr-assets.com",
  "images.gr-assets.com",
  "s.gr-assets.com",
];

export default async (req) => {
  const target = new URL(req.url).searchParams.get("url") || "";
  let u;
  try {
    u = new URL(target);
  } catch {
    return new Response("bad url", { status: 400 });
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return new Response("bad url", { status: 400 });
  if (!ALLOWED.includes(u.hostname)) return new Response("host not allowed", { status: 403 });
  u.protocol = "https:";

  const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (compatible; BibliotecaPersonal/1.0)" }, redirect: "follow" });
  const type = r.headers.get("content-type") || "";
  if (!r.ok || !type.startsWith("image/")) return new Response("not found", { status: 404 });
  const body = await r.arrayBuffer();
  if (body.byteLength > 5 * 1024 * 1024) return new Response("too large", { status: 413 });
  return new Response(body, {
    headers: { "content-type": type, "cache-control": "public, max-age=2592000, immutable" },
  });
};

export const config = { path: "/api/cover" };
