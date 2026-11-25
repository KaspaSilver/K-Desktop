// Only something that just happened rings (K 961fc05a, owner 2026-11-25). Every banner or
// notification K posts itself checks the age of what it announces; anything older (found on opening
// K, after the tab slept, or on switching accounts) goes to the bell only, dated when it happened.
// Pure, so tools/test-notification-recency.mjs runs it without the app.
//
// - chats, groups, rooms and dollar notices: 3 minutes (iOS InAppBanner.isRecent / maxAgeMs);
// - KaPost activity: 10 minutes (KaPostsNotificationService.bannerMaxAgeSeconds);
// - Received KAS from the address catch-up: 3 minutes, by block time;
// - Received kUSDT: 6 minutes, by the coin's block time (TokenWallet.ringWindow: Trestly lists new
//   coins late, and a coin on the Chatting Address waits for its chat notice);
// - "Balance increased" (the catch-up couldn't find the transaction): never rings, bell only.

export const BANNER_MAX_AGE_MS = 3 * 60_000;
export const KAPOST_BANNER_MAX_AGE_MS = 10 * 60_000;
export const KUSDT_RING_WINDOW_MS = 6 * 60_000;

/** A time in ms from one in seconds or ms (KaPost's API and the REST API differ): anything below
 *  1e11 is seconds (iOS KaPostsNotificationService.milliseconds). 0 when there is none. */
export function timeMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 100_000_000_000 ? n * 1000 : n;
}

/** Whether what happened at `atMs` (ms or seconds; 0 / missing = not in a block yet) is recent
 *  enough to ring. An unknown time counts as now: it is that new (iOS audit 2026-11-25 C10). */
export function isRecentForBanner(atMs, { maxAgeMs = BANNER_MAX_AGE_MS, now = Date.now() } = {}) {
  const at = timeMs(atMs);
  if (!at) return true;
  return now - at <= maxAgeMs;
}

/** The bell's date for what was announced: when it happened, else now. */
export function bellTimestamp(atMs, now = Date.now()) {
  return timeMs(atMs) || now;
}
