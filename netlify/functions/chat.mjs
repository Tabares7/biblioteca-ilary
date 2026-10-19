// POST /api/chat — compañero de lectura sin spoilers.
// Usa Netlify AI Gateway: el SDK de Anthropic recibe las credenciales solo
// (ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL). También funciona con una clave propia.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.AI_MODEL || "claude-sonnet-5-5";
const MAX_MESSAGES = 16;
const MAX_CHARS = 4000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function env(name) {
  try {
    return globalThis.Netlify?.env.get(name) || process.env[name] || "";
  } catch {
    return process.env[name] || "";
  }
}

const clean = (s, n = 400) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function systemPrompt(book, position) {
  const authors = (book.authors || []).map((a) => clean(a, 80)).join(", ") || "autor desconocido";
  const series = book.series?.name ? `Saga: ${clean(book.series.name, 120)}${book.series.number ? `, libro ${book.series.number}` : ""}.` : "";
  const where = position.finished
    ? "Ya terminó el libro: puedes hablar de toda la trama, incluido el final."
    : position.page
      ? `Va por la página ${position.page}${book.pages ? ` de ${book.pages} (alrededor del ${position.percent}%)` : ""}.`
      : position.percent
        ? `Va por el ${position.percent}% del libro.`
        : "No sabemos por qué parte va: asume que acaba de empezar.";

  return `Eres el compañero de lectura de Ilary dentro de su biblioteca personal. Está leyendo:
«${clean(book.title, 200)}»${book.subtitle ? ` — ${clean(book.subtitle, 200)}` : ""}, de ${authors}${book.year ? ` (${clean(book.year, 10)})` : ""}.
${series}
${book.genres?.length ? `Géneros: ${book.genres.map((g) => clean(g, 40)).join(", ")}.` : ""}
${book.description ? `Sinopsis de la editorial (puede usarse sin problema): ${clean(book.description, 1500)}` : ""}

Posición de lectura: ${where}

Reglas:
- NADA DE SPOILERS. No reveles eventos, giros, muertes, identidades, relaciones ni el destino de personajes que ocurran después de su posición actual, ni siquiera de forma indirecta ("ya verás", "eso cambiará", "presta atención a…"). Si una respuesta completa exigiría adelantar algo, responde solo hasta donde va y dile con amabilidad que el resto lo descubrirá más adelante.
- Si te pregunta por un personaje, describe solo lo que se sabe hasta su posición.
- Puedes explicar con libertad: definiciones de palabras y expresiones, términos de otros idiomas, referencias culturales, contexto histórico o geográfico, mitología, el estilo del autor, y datos del autor y de la obra que no revelen la trama.
- Si no conoces bien este libro o no estás seguro de en qué punto ocurre algo, dilo con honestidad y no inventes. Puedes pedirle que te cuente qué acaba de pasar.
- Responde en el idioma en que te escriba (normalmente español), de forma cálida, clara y breve: 1 a 3 párrafos cortos, o una lista corta si ayuda. Sin encabezados.`;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const password = env("APP_PASSWORD");
  if (password && req.headers.get("x-app-key") !== password) return json({ error: "unauthorized" }, 401);
  if (!env("ANTHROPIC_API_KEY") && !env("ANTHROPIC_BASE_URL")) return json({ error: "ai_unavailable" }, 503);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  const book = body.book || {};
  if (!book.title) return json({ error: "no_book" }, 400);
  const position = {
    page: Math.max(0, parseInt(body.position?.page, 10) || 0),
    percent: Math.min(100, Math.max(0, Math.round(+body.position?.percent || 0))),
    finished: !!body.position?.finished,
  };
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== "user") return json({ error: "no_question" }, 400);

  const client = new Anthropic();
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const s = client.messages.stream({
          model: MODEL,
          max_tokens: 900,
          system: systemPrompt(book, position),
          messages,
        });
        s.on("text", (t) => controller.enqueue(enc.encode(t)));
        await s.finalMessage();
      } catch (e) {
        console.error("chat error", e?.status, e?.message);
        controller.enqueue(enc.encode("\n\n(No pude terminar la respuesta. Inténtalo de nuevo.)"));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
};

export const config = { path: "/api/chat" };
