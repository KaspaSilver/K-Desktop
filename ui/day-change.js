// Calls back when the local calendar day changes (K 01f71184, release audit 2026-11-27 C2).
//
// The Chats list shows a clock time for today and "Yesterday" for the day before, but it was only
// drawn again when a chat changed: a quiet night left "10:15 PM" on a row the next morning. A timer
// fires just after local midnight, and coming back to the page (a laptop asleep at midnight, a
// throttled background tab) checks whether the day moved meanwhile.
//
// No DOM at import: tools/test-ios-01f71184-chats.mjs runs it in node.

/** The local day a time falls on, as a comparable key. */
export function localDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Milliseconds from `nowMs` to one second past the next local midnight. */
export function delayToNextLocalMidnight(nowMs) {
  const d = new Date(nowMs);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 1).getTime();
  return Math.max(1000, next - nowMs);
}

/** Runs `run()` once per new local day. Returns a stop function. */
export function onDayChange(run, {
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  doc = typeof document !== "undefined" ? document : null,
} = {}) {
  let day = localDayKey(now());
  let timer = null;
  let stopped = false;
  const check = () => {
    if (stopped) return;
    const today = localDayKey(now());
    if (today === day) return;
    day = today;
    try { run(); } catch { /* the next day tries again */ }
  };
  const schedule = () => {
    if (stopped) return;
    if (timer != null) clearTimer(timer);
    timer = setTimer(() => { timer = null; check(); schedule(); }, delayToNextLocalMidnight(now()));
    timer?.unref?.();
  };
  const onVisible = () => { if (!doc || doc.visibilityState === "visible") { check(); schedule(); } };
  doc?.addEventListener?.("visibilitychange", onVisible);
  schedule();
  return () => {
    stopped = true;
    if (timer != null) clearTimer(timer);
    timer = null;
    doc?.removeEventListener?.("visibilitychange", onVisible);
  };
}
