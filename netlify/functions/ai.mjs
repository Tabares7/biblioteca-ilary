// POST /api/ai — trivias y retos propuestos por la IA. Devuelve JSON.
import Anthropic from "@anthropic-ai/sdk";
import { json, env, authorized, takeDailySlot, clean, extractJSON } from "../lib/common.mjs";

const MODEL = process.env.AI_MODEL || "claude-sonnet-5-5";

function bookLine(b) {
  const who = (b.authors || []).map((a) => clean(a, 60)).join(", ");
  const pos = b.finished ? "terminado" : b.page ? `va por la página ${b.page}${b.pages ? ` de ${b.pages}` : ""}` : "recién empezado";
  return `- «${clean(b.title, 160)}» de ${who || "autor desconocido"}${b.year ? ` (${clean(b.year, 8)})` : ""} — ${pos}`;
}

export function triviaPrompt(books, count, kind) {
  return {
    system: `Eres el creador de trivias de la biblioteca personal de una lectora apasionada. Escribes en español, con tono cálido y un toque de humor.
Reglas:
- Haz preguntas de opción múltiple con 4 opciones y una sola correcta.
- Pregunta SOLO sobre hechos que conozcas con seguridad de esos libros (trama, personajes, lugares, citas famosas, el autor, el contexto). Si no conoces bien un libro, pregunta por su autor, su época o su contexto, nunca inventes detalles.
- Para libros no terminados, NO preguntes nada que ocurra después de su posición: limítate a lo que se sabe al principio o al contexto.
- Las opciones incorrectas deben ser plausibles. Varía la posición de la respuesta correcta.
- Cada pregunta trae una explicación breve (1 frase) de la respuesta.
Responde SOLO con JSON: {"questions":[{"book":"título","q":"pregunta","options":["a","b","c","d"],"answer":0,"explain":"..."}]}`,
    user: `${kind === "week" ? "Trivia semanal mezclando estos libros que ya leyó" : "Trivia sobre este libro"} (${count} preguntas):\n${books.map(bookLine).join("\n")}`,
  };
}

export function challengesPrompt(profile, recent, existing) {
  return {
    system: `Propones retos de lectura personales, divertidos y alcanzables, en español y con tono cálido. Cada reto se cumple con UN libro y debe ser concreto (ej. "Un libro de una autora africana", "Una novela que transcurra en el mar", "Un clásico ruso de menos de 300 páginas"). Basa las ideas en sus gustos pero empújala un poquito fuera de su zona de confort. Nada de retos de cantidad.
Responde SOLO con JSON: {"challenges":[{"emoji":"🌊","title":"máx. 7 palabras","desc":"1 frase con una sugerencia o pista"}]}`,
    user: `Sus géneros favoritos: ${(profile.genres || []).join(", ") || "no lo sabemos"}.
Lee en: ${(profile.langs || []).join(", ") || "español"}.
Libros recientes y su nota:\n${(recent || []).slice(0, 15).map((r) => `- ${clean(r.title, 120)} (${clean(r.author, 60)})${r.rating ? ` ★${r.rating}` : ""}${r.genre ? ` · ${clean(r.genre, 30)}` : ""}`).join("\n") || "- (todavía ninguno)"}
Retos que ya tiene (no los repitas): ${(existing || []).map((t) => clean(t, 80)).join("; ") || "ninguno"}.
Propón 3 retos nuevos.`,
  };
}

function validTrivia(data, count) {
  const qs = (data.questions || [])
    .filter((q) => q && typeof q.q === "string" && Array.isArray(q.options) && q.options.length === 4 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4)
    .slice(0, count)
    .map((q) => ({ book: clean(q.book, 160), q: clean(q.q, 300), options: q.options.map((o) => clean(o, 160)), answer: q.answer, explain: clean(q.explain, 300) }));
  if (qs.length < Math.min(3, count)) throw new Error("bad_trivia");
  return qs;
}

function validChallenges(data) {
  const cs = (data.challenges || [])
    .filter((c) => c && typeof c.title === "string")
    .slice(0, 3)
    .map((c) => ({ emoji: clean(c.emoji, 4) || "✨", title: clean(c.title, 80), desc: clean(c.desc, 200) }));
  if (!cs.length) throw new Error("bad_challenges");
  return cs;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  if (!env("ANTHROPIC_API_KEY") && !env("ANTHROPIC_BASE_URL")) return json({ error: "ai_unavailable" }, 503);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }

  let prompt, validate, maxTokens;
  if (body.mode === "trivia") {
    const books = (Array.isArray(body.books) ? body.books : []).filter((b) => b?.title).slice(0, 6);
    if (!books.length) return json({ error: "no_books" }, 400);
    const count = Math.min(7, Math.max(3, parseInt(body.count, 10) || 5));
    prompt = triviaPrompt(books, count, body.kind === "week" ? "week" : "book");
    validate = (d) => ({ questions: validTrivia(d, count) });
    maxTokens = 2000;
  } else if (body.mode === "challenges") {
    prompt = challengesPrompt(body.profile || {}, body.recent || [], body.existing || []);
    validate = (d) => ({ challenges: validChallenges(d) });
    maxTokens = 800;
  } else return json({ error: "bad_mode" }, 400);

  if (!(await takeDailySlot())) return json({ error: "daily_limit" }, 429);

  const client = new Anthropic();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const msg = await client.messages.create({ model: MODEL, max_tokens: maxTokens, system: prompt.system, messages: [{ role: "user", content: prompt.user }] });
      const text = msg.content.filter((c) => c.type === "text").map((c) => c.text).join("");
      return json(validate(extractJSON(text)));
    } catch (e) {
      console.error("ai error", attempt, e?.status, e?.message);
      if (e?.status === 429 || e?.status >= 500 || attempt === 1) {
        if (attempt === 1) return json({ error: "ai_failed" }, 502);
      }
    }
  }
  return json({ error: "ai_failed" }, 502);
};

export const config = { path: "/api/ai" };
