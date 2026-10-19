// Decide qué notificaciones tocan en este momento. Lógica pura (sin red) para poder probarla.

const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];
const hash = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);

// Fecha y hora locales en la zona de la lectora
export function localNow(now, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  const hour = parseInt(parts.hour, 10) % 24;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour, minute: parseInt(parts.minute, 10), weekday: parts.weekday, day: parseInt(parts.day, 10), month: parseInt(parts.month, 10), year: parseInt(parts.year, 10) };
}

function minutesByDay(books) {
  const m = {};
  for (const b of books) for (const s of b.sessions || []) if (s.date) m[s.date] = (m[s.date] || 0) + (s.minutes || 0);
  return m;
}

function shiftDate(date, days) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function streakFor(books, goal, today) {
  if (!goal) return 0;
  const m = minutesByDay(books);
  let d = (m[today] || 0) >= goal ? today : shiftDate(today, -1);
  let n = 0;
  while ((m[d] || 0) >= goal) n++, (d = shiftDate(d, -1));
  return n;
}

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
// Dentro de la hora objetivo (las ejecuciones son cada 15 min; el registro evita repetir)
const inWindow = (t, hour, minute = 0) => t.hour * 60 + t.minute >= hour * 60 + minute && t.hour * 60 + t.minute < hour * 60 + minute + 60;

/**
 * @returns {Array<{key:string,title:string,body:string,url:string}>}
 */
export function dueNotifications({ now = new Date(), settings = {}, books = [], log = {} }) {
  const n = settings.notify || {};
  if (!n.enabled) return [];
  const types = { daily: true, streak: true, weekly: true, monthly: true, timer: true, ...(n.types || {}) };
  const tz = n.tz || settings.tz || "America/Havana";
  const t = localNow(now, tz);
  const name = settings.name || "Ilary";
  const title = `Biblioteca de ${name}`;
  const goal = settings.dailyGoal || 0;
  const todayMin = minutesByDay(books)[t.date] || 0;
  const reading = books.filter((b) => b.status === "reading").sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const book = reading[0]?.title;
  const seed = hash(t.date);
  const out = [];
  const add = (key, body, url = "/") => !log[key] && out.push({ key, title, body, url });

  // 1. Recordatorio diario a su hora, si aún no cumplió la meta
  const hour = Number.isInteger(n.hour) ? n.hour : 21;
  if (types.daily && inWindow(t, hour) && (!goal || todayMin < goal)) {
    const left = goal ? Math.ceil(goal - todayMin) : 0;
    const night = hour >= 19 || hour < 4;
    const opts = book
      ? [
          night ? `¿Unas páginas de ${book} antes de dormir? 📖` : `¿Un ratito con ${book}? 📖`,
          `${book} te está esperando 👀`,
          left && todayMin ? `Te faltan ${left} min para tu meta de hoy. ¡Casi! ✨` : `Tu libro te extraña. ¿${goal || 15} minutitos hoy? 💛`,
          `Hora de escaparte a ${book} ✨`,
        ]
      : ["Hoy es buen día para empezar un libro nuevo 📚", "Tu biblioteca te está esperando 💛"];
    add(`daily:${t.date}`, pick(opts, seed), reading[0] ? `/#/read/${reading[0].id}` : "/");
  }

  // 2. Racha en peligro (22:30), si lleva 2+ días y hoy no ha leído
  const streak = streakFor(books, goal, t.date);
  if (types.streak && goal && streak >= 2 && todayMin < goal && inWindow(t, 22, 30)) {
    add(`streak:${t.date}`, pick([`Tu racha de ${streak} días está en peligro 🔥 Unos minutos y la salvas.`, `🔥 ${streak} días seguidos… ¡no la dejes apagarse hoy!`, `Psst… tu racha de ${streak} días te necesita esta noche 🔥`], seed), reading[0] ? `/#/read/${reading[0].id}` : "/");
  }

  // 3. Progreso del reto (domingos 11:00)
  const yearGoal = settings.yearGoals?.[String(t.year)];
  if (types.weekly && yearGoal && t.weekday === "Sun" && inWindow(t, 11)) {
    const read = books.filter((b) => b.status === "read" && (b.finishedAt || "").startsWith(String(t.year))).length;
    const start = Date.UTC(t.year, 0, 1), end = Date.UTC(t.year + 1, 0, 1);
    const expected = yearGoal * ((now.getTime() - start) / (end - start));
    const diff = read - expected;
    const pace = read >= yearGoal ? "¡Reto cumplido! 🎉" : Math.abs(diff) < 0.5 ? "Vas justo al día 👌" : diff > 0 ? `Vas ${Math.round(diff)} adelantada 🚀` : diff > -3 ? `Vas ${Math.round(-diff)} atrasadita… ¡nada que un fin de semana lector no arregle! 💪` : "Cada página cuenta: ¡a por el siguiente! 💪";
    add(`weekly:${t.date}`, `Llevas ${read} de ${yearGoal} libros en tu reto ${t.year}. ${pace}`, "/#/challenges");
  }

  // 4. Retos del mes nuevo (día 1, 10:00)
  if (types.monthly && t.day === 1 && inWindow(t, 10)) {
    add(`monthly:${t.year}-${t.month}`, `Nuevo mes, nuevos retos ✨ Mira los de ${MONTHS[t.month - 1]}.`, "/#/challenges");
  }

  // 5. Timer olvidado (2 h corriendo)
  const timer = settings.activeTimer;
  if (types.timer && timer && !timer.pausedAt && now.getTime() - timer.startedAt >= 2 * 3600 * 1000) {
    const b = books.find((x) => x.id === timer.bookId);
    const h = Math.floor((now.getTime() - timer.startedAt) / 3600000);
    add(`timer:${timer.startedAt}`, `¿Sigues leyendo? ⏱ El timer de ${b?.title || "tu libro"} lleva ${h} hora${h > 1 ? "s" : ""}.`, `/#/read/${timer.bookId}`);
  }
  return out;
}
