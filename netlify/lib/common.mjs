// Utilidades compartidas por las funciones del servidor.
import { getStore } from "@netlify/blobs";

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export function env(name) {
  try {
    return globalThis.Netlify?.env.get(name) || process.env[name] || "";
  } catch {
    return process.env[name] || "";
  }
}

export function authorized(req) {
  const password = env("APP_PASSWORD");
  return !password || req.headers.get("x-app-key") === password;
}

export const libStore = () => getStore({ name: "biblioteca", consistency: "strong" });

export const DAILY_AI_LIMIT = 40;
// Cuenta las llamadas a la IA del día para no gastar de más (compartido con el chat).
export async function takeDailySlot(cost = 1) {
  try {
    const store = libStore();
    const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const u = (await store.get("ai-usage", { type: "json" })) || {};
    const count = u.day === day ? u.count || 0 : 0;
    if (count + cost > DAILY_AI_LIMIT) return false;
    await store.setJSON("ai-usage", { day, count: count + cost });
    return true;
  } catch (e) {
    console.warn("usage counter", e?.message);
    return true;
  }
}

export const clean = (s, n = 400) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// Saca el primer objeto JSON de un texto (por si el modelo añade algo alrededor)
export function extractJSON(text) {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no_json");
  return JSON.parse(text.slice(start, end + 1));
}
