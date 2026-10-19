// Tarea programada: cada 15 minutos revisa qué avisos tocan y los envía.
import { libStore } from "../lib/common.mjs";
import { dueNotifications } from "../lib/notify.mjs";
import { setupVapid, sendToAll } from "./push.mjs";

export default async () => {
  if (!setupVapid()) return;
  const store = libStore();
  const [settings, books, subs] = await Promise.all([
    store.get("settings", { type: "json" }),
    store.get("library", { type: "json" }),
    store.get("push-subs", { type: "json" }),
  ]);
  if (!settings?.notify?.enabled || !subs?.length) return;
  const log = (await store.get("push-log", { type: "json" })) || {};
  const due = dueNotifications({ now: new Date(), settings, books: books || [], log });
  for (const n of due.slice(0, 2)) {
    await sendToAll(store, { title: n.title, body: n.body, url: n.url, tag: n.key.split(":")[0] });
    log[n.key] = Date.now();
  }
  if (due.length) {
    // conservar solo los últimos 60 días del registro
    const cutoff = Date.now() - 60 * 86400000;
    for (const k of Object.keys(log)) if (log[k] < cutoff) delete log[k];
    await store.setJSON("push-log", log);
  }
};

export const config = { schedule: "*/15 * * * *" };
