// One shared beat for the foreground polls (K 961fc05a ForegroundBeat, audit 2026-11-25 B4).
//
// The closed-room sweep (20 s) and the kUSDT poll (30 s) each woke on their own schedule. Now each
// sleeps to the same wall-clock beat (every 30 s, 60 s on an expensive connection: cellular or
// Save-Data) and they run a second or two apart, so the network wakes once per beat instead of
// whenever each timer happens to fire. A new background poll uses it, not its own interval. The
// open chat (2 s), the open room (8 s) and the 1:1 sweep keep their own cadence. (K 01f71184 put its
// 1:1 sweep on the beat too; Desktop's 5 s sweep is its 1:1 live path and keeps its pace, and only
// its inbox read and group pass slow down with Web Push proven: ui/push-poll-gate.js.)
//
// No DOM at import: tools/test-foreground-beat.mjs and the kUSDT tests load it in node.

export const BEAT_MS = 30_000;
export const BEAT_EXPENSIVE_MS = 60_000;

/** The beat's interval now: 30 s, or 60 s on cellular / Save-Data (Network Information API). */
export function beatIntervalMs(nav = globalThis.navigator) {
  const connection = nav?.connection;
  const expensive = Boolean(connection) && (connection.saveData === true || connection.type === "cellular");
  return expensive ? BEAT_EXPENSIVE_MS : BEAT_MS;
}

/** The wait until the next beat (the next whole multiple of `intervalMs` since 1970) plus
 *  `offsetMs`; never under a second, so a loop that just ran doesn't run twice in one beat. */
export function delayToNextBeat(intervalMs, offsetMs, nowMs) {
  let next = (Math.floor(nowMs / intervalMs) + 1) * intervalMs + offsetMs;
  if (next - nowMs < 1000) next += intervalMs;
  return next - nowMs;
}

/**
 * Runs `run()` on every beat, `offsetMs` into it, while the page shows. Returns a stop function.
 * A run that is still going when the next beat comes is not started twice.
 */
export function onForegroundBeat(run, {
  offsetMs = 0,
  isVisible = () => typeof document === "undefined" || !document.hidden,
  intervalMs = () => beatIntervalMs(),
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let timer = null;
  let stopped = false;
  let running = false;
  const schedule = () => {
    if (stopped) return;
    timer = setTimer(tick, delayToNextBeat(intervalMs(), offsetMs, now()));
    timer?.unref?.();
  };
  async function tick() {
    timer = null;
    if (!stopped && !running && isVisible()) {
      running = true;
      try { await run(); } catch { /* the next beat tries again */ }
      finally { running = false; }
    }
    schedule();
  }
  schedule();
  return () => {
    stopped = true;
    if (timer != null) clearTimer(timer);
    timer = null;
  };
}
