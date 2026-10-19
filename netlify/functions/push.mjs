// Notificaciones push: clave pública, suscripción y aviso de prueba.
//   GET  /api/push/key
//   POST /api/push/subscribe   { subscription, tz }
//   POST /api/push/unsubscribe { endpoint }
//   POST /api/push/test
import webpush from "web-push";
import { json, env, authorized, libStore } from "../lib/common.mjs";

export function setupVapid() {
  const pub = env("VAPID_PUBLIC_KEY"), priv = env("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return false;
  webpush.setVapidDetails(env("VAPID_SUBJECT") || "https://biblioteca-ilary.netlify.app", pub, priv);
  return true;
}

export async function sendToAll(store, payload) {
  const subs = (await store.get("push-subs", { type: "json" })) || [];
  let sent = 0;
  const alive = [];
  for (const s of subs) {
    try {
      await webpush.sendNotification(s, JSON.stringify(payload), { TTL: 3600 });
      sent++;
      alive.push(s);
    } catch (e) {
      // 404/410: la suscripción ya no existe (se desinstaló o se negó el permiso)
      if (e?.statusCode !== 404 && e?.statusCode !== 410) alive.push(s);
      console.warn("push error", e?.statusCode, e?.body);
    }
  }
  if (alive.length !== subs.length) await store.setJSON("push-subs", alive);
  return sent;
}

export default async (req) => {
  const { pathname } = new URL(req.url);
  if (pathname === "/api/push/key") return json({ key: env("VAPID_PUBLIC_KEY") || null });
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const store = libStore();
  const body = await req.json().catch(() => ({}));

  if (pathname === "/api/push/subscribe") {
    const sub = body.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json({ error: "bad_subscription" }, 400);
    const subs = ((await store.get("push-subs", { type: "json" })) || []).filter((s) => s.endpoint !== sub.endpoint);
    subs.push({ endpoint: sub.endpoint, keys: sub.keys, tz: String(body.tz || "").slice(0, 60), at: Date.now() });
    await store.setJSON("push-subs", subs.slice(-6));
    return json({ ok: true, devices: subs.length });
  }
  if (pathname === "/api/push/unsubscribe") {
    const subs = ((await store.get("push-subs", { type: "json" })) || []).filter((s) => s.endpoint !== body.endpoint);
    await store.setJSON("push-subs", subs);
    return json({ ok: true });
  }
  if (pathname === "/api/push/test") {
    if (!setupVapid()) return json({ error: "push_unavailable" }, 503);
    const settings = (await store.get("settings", { type: "json" })) || {};
    const sent = await sendToAll(store, { title: `Biblioteca de ${settings.name || "Ilary"}`, body: "¡Así te llegarán mis avisos! 📚✨", url: "/" });
    return json({ ok: true, sent });
  }
  return json({ error: "not_found" }, 404);
};

export const config = { path: ["/api/push/key", "/api/push/subscribe", "/api/push/unsubscribe", "/api/push/test"] };
