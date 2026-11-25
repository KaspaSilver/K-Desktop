// The node connection's idle rules (K 961fc05a, battery audit AUDIT_2026-11-25 B1, B3, B4, B6/B7),
// without a DOM, for tools/test-node-fallback.mjs.
//
// - Keepalive: the primary is asked GetServerInfo every 15 s, every 45 s on an expensive
//   connection (cellular or Save-Data), and the ask is skipped when the node pushed a
//   notification within that time: a node that just spoke is alive. Both stay well under the
//   ~100 s a proxy such as Cloudflare lets a WebSocket sit idle.
// - Offline: no reconnect attempt while the browser says it's offline; the `online` event kicks
//   one at once.
// - Block-added: stopped on the node (unsubscribe) while the page has been hidden a little while,
//   as K stops it in the background; it comes back the moment the page shows. Not while the
//   indexer is down (an outage scan reads the chain then, and a hidden tab still sweeps for
//   notifications).

export const KEEPALIVE_MS = 15_000;
export const KEEPALIVE_EXPENSIVE_MS = 45_000;
/** How long the page stays hidden before the block stream is stopped: a quick look at another
 *  tab doesn't stop and restart it. */
export const BLOCK_ADDED_HIDDEN_GRACE_MS = 30_000;

/** Cellular, or the reader asked to save data (the Network Information API, where there is one). */
export function isExpensiveConnection(nav = globalThis.navigator) {
  const connection = nav?.connection;
  if (!connection) return false;
  return connection.saveData === true || connection.type === "cellular";
}

/** The keepalive's interval right now. */
export function keepaliveIntervalMs(nav = globalThis.navigator) {
  return isExpensiveConnection(nav) ? KEEPALIVE_EXPENSIVE_MS : KEEPALIVE_MS;
}

/** False when the node pushed something within the interval: the ask is spared. */
export function keepaliveProbeDue({ now = Date.now(), lastNotificationAt = 0, intervalMs = KEEPALIVE_MS } = {}) {
  const spoke = Number(lastNotificationAt) || 0;
  return !(spoke > 0 && now - spoke >= 0 && now - spoke < intervalMs);
}

/** Only `navigator.onLine === false` counts as offline (no API: online). */
export function browserOffline(nav = globalThis.navigator) {
  return nav?.onLine === false;
}

/** Whether the block stream is held off: the page hidden for the grace period, and no outage
 *  scan (indexer down) reading it. */
export function blockAddedSuspended({ hiddenSince = 0, now = Date.now(), outageClients = 0, graceMs = BLOCK_ADDED_HIDDEN_GRACE_MS } = {}) {
  if (!hiddenSince || outageClients > 0) return false;
  return now - hiddenSince >= graceMs;
}
