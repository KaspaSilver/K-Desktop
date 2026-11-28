// Fewer polls while Web Push is proven to work (K 01f71184, release audit 2026-11-27 B4/B5).
//
// With push registered and reliable, K sweeps the rooms the push covers and (when every group is
// pushed) its group pass every 5 minutes instead of every beat, and reads the inbox (first messages
// with no handshake) every second beat: each of those pushes, and a push fetches its own message at
// once. Desktop does the same where its Web Push covers that traffic:
//   - rooms: ui/broadcasts.js sweepClosedRooms skips a push-covered room (bell on, read from the
//     app-wide indexer) between safety-net sweeps; a room push fetches it (fetchRoomBeforePushBanner).
//   - groups: the sweep's one group pass (Desktop has no separate catch-up) runs at least every
//     3 minutes, K's group catch-up cadence, which is push-blind and reads invites; every sweep while
//     a group is open, or when any group or member isn't pushed (muted, hidden, past the cap).
//   - inbox: every second beat instead of every 5 s sweep.
// A push opens a 20 s window in which its kind is read on every sweep (the indexer may push a
// moment before it serves the row), and coming back to the page reads everything again.
// Anything else, and everything while push isn't registered or not yet proven, is unchanged.
//
// "Reliable" is K's PushReliabilityState, kept in memory per account: an incoming 1:1 message from
// a chat the push watches is looked for in public/sw.js's arrivals ledger a minute later
// (pushArrivedRecently). Found: reliable. Three misses in a row: unreliable. A browser that
// subscribes but never delivers (Brave without push messaging, a blocked push service) is never
// trusted, and a page load starts over as unknown.
//
// No DOM at import beyond an optional visibilitychange listener: tools/test-ios-01f71184-chats.mjs
// runs it in node.
import { beatIntervalMs } from "./foreground-beat.js";

export const PUSH_OBSERVATION_GRACE_MS = 60_000;
export const PUSH_MISSES_UNRELIABLE = 3;
/** K's room and group safety net with push working. */
export const PUSH_SAFETY_NET_MS = 5 * 60_000;
/** Desktop's group pass is also K's push-blind catch-up (invites, control): K runs that every 3 min. */
export const GROUP_PASS_PUSH_MS = 3 * 60_000;
/** After a push, its kind is read on every sweep for this long. */
export const PUSH_FORCE_WINDOW_MS = 20_000;
/** Slack: a beat-aligned timer lands a moment either side of an interval. */
const SLACK_MS = 5_000;

const GROUP_PUSH_TYPES = new Set(["group_message", "group_control"]);
/** Push kinds that aren't 1:1 or inbox traffic. */
const OTHER_PUSH_TYPES = new Set(["broadcast", "kaposts", "name_event", "address_activity"]);

/** K's PushReliabilityState for one account: "unknown" | "reliable" | "unreliable". */
export function createPushReliability({
  arrived,
  graceMs = PUSH_OBSERVATION_GRACE_MS,
  missLimit = PUSH_MISSES_UNRELIABLE,
  setTimer = (fn, ms) => setTimeout(fn, ms),
} = {}) {
  let state = "unknown";
  let misses = 0;
  let account = "";
  let generation = 0;
  const pending = new Set();
  function outcome(got) {
    if (got) { misses = 0; state = "reliable"; return; }
    misses += 1;
    if (misses >= missLimit) state = "unreliable";
  }
  return {
    state: () => state,
    account: () => account,
    misses: () => misses,
    reset(nextAccount = "") {
      state = "unknown";
      misses = 0;
      pending.clear();
      generation += 1;
      account = nextAccount;
    },
    /** An incoming message the push should have announced: checked once the grace is over. */
    observe(txId) {
      const key = String(txId || "").trim().toLowerCase();
      if (!key || pending.has(key) || typeof arrived !== "function") return false;
      pending.add(key);
      const started = generation;
      const timer = setTimer(async () => {
        if (started !== generation) return;
        pending.delete(key);
        let got;
        try { got = Boolean(await arrived(key)); } catch { return; }
        if (started === generation) outcome(got);
      }, graceMs);
      timer?.unref?.();
      return true;
    },
    outcome,
  };
}

/** Whether a safety-net interval has passed since `lastAt` (0 = never). */
export function intervalDue(lastAt, intervalMs, nowMs) {
  return !lastAt || nowMs - lastAt >= intervalMs - SLACK_MS;
}

/**
 * The gate the sweeps ask. `configure()` it from the app; until then (and whenever push isn't
 * operational) every turn is due, as before.
 *   operational(): Web Push is on and registered for this account
 *   account(): the signed-in address
 *   arrived(txId): a push for this message reached this browser (web-push.js pushArrivedRecently)
 *   pushCoversGroups(): every group and member is in the push registration
 */
export function createPushPollGate({
  now = () => Date.now(),
  beatMs = () => beatIntervalMs(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  listen = true,
} = {}) {
  let deps = { operational: () => false, account: () => "", arrived: null, pushCoversGroups: () => false };
  const reliability = createPushReliability({ arrived: (key) => deps.arrived?.(key), setTimer });
  let inboxAt = 0;
  let groupsAt = 0;
  let roomsAt = 0;
  let inboxForcedUntil = 0;
  let groupsForcedUntil = 0;
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

  function pushIsReliable() {
    const account = String(safe(() => deps.account(), "") || "").toLowerCase();
    if (!account || !safe(() => deps.operational(), false)) {
      if (reliability.account() || reliability.state() !== "unknown") reliability.reset("");
      return false;
    }
    if (reliability.account() !== account) reliability.reset(account);
    return reliability.state() === "reliable";
  }

  /** The page is back in front: the next turn of each kind reads everything (K resets its sweeps
   *  on coming to the foreground). */
  function backInFront() { inboxAt = 0; groupsAt = 0; roomsAt = 0; }

  const gate = {
    configure(next = {}) { deps = { ...deps, ...next }; },
    pushIsReliable,
    reliabilityState: () => { pushIsReliable(); return reliability.state(); },
    backInFront,
    /** A live incoming 1:1 message from a chat the push watches (its txid). */
    observeIncoming(txId) {
      if (!pushIsReliable() && reliability.account() === "") return false;
      return reliability.observe(txId);
    },
    /** A push reached the open page (public/sw.js "kachat:push"): its kind is read at once. */
    pushed(type) {
      const kind = String(type || "");
      const until = now() + PUSH_FORCE_WINDOW_MS;
      if (GROUP_PUSH_TYPES.has(kind)) groupsForcedUntil = until;
      else if (!OTHER_PUSH_TYPES.has(kind)) inboxForcedUntil = until;
    },
    /** The sweep's inbox read: every sweep, or every second beat while push is reliable. */
    takeInboxTurn({ catchUp = false } = {}) {
      const t = now();
      const due = catchUp || !pushIsReliable() || t < inboxForcedUntil || intervalDue(inboxAt, 2 * beatMs(), t);
      if (due) inboxAt = t;
      return due;
    },
    /** The sweep's group pass: every sweep, or at least every GROUP_PASS_PUSH_MS while push is
     *  reliable, covers every group and none is open. */
    takeGroupTurn({ catchUp = false, groupOpen = false } = {}) {
      const t = now();
      const due = catchUp || groupOpen || t < groupsForcedUntil || !pushIsReliable()
        || !safe(() => deps.pushCoversGroups(), false) || intervalDue(groupsAt, GROUP_PASS_PUSH_MS, t);
      if (due) groupsAt = t;
      return due;
    },
    /** The closed-room sweep: true when the push-covered rooms are due too (always, unless push is
     *  reliable and a covered sweep ran in the last 5 minutes). */
    takeCoveredRoomsTurn() {
      const t = now();
      const due = !pushIsReliable() || intervalDue(roomsAt, PUSH_SAFETY_NET_MS, t);
      if (due) roomsAt = t;
      return due;
    },
    // for tests
    _reliability: reliability,
  };
  if (listen && typeof document !== "undefined" && document?.addEventListener) {
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") backInFront(); });
  }
  return gate;
}

/** The app's one gate (ui/app.js configures it; ui/broadcasts.js asks it). */
export const pushPollGate = createPushPollGate();
