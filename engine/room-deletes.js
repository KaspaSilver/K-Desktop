// Public chat deletes (K e4062188, MESSAGING.md "Public Chat Deletes").
//
// A sender deletes their own room message for everyone with a room message of its own:
//   {"type":"delete","targetTxId":"<txid>"}
// It counts only from the address that sent the target, in that room, never in the machinery
// rooms (chess, bots, arcade). Every client drops the target and remembers the delete as
// room|txid|sender, so a page or block still carrying it can't bring it back. The indexer removes
// it too (indexer repo docs/ROOM_MESSAGE_DELETES.md).
//
// Cached messages the app-wide indexer no longer serves go as well (K `dropRowsTheIndexerNoLongerHas`):
// a page answers for the span between its own oldest and newest rows, so a delivered row held in
// that span that isn't on the page was removed (a moderator, or its sender's delete).

export const ROOM_DELETES_MAX = 2000;
/** Deletes whose target wasn't held when they came are kept on a budget of their own (audit
 *  2026-11-25 #26): anyone can post deletes naming txids nobody here holds, and on one shared list
 *  ~2,000 of them pushed the real ones out. */
export const ROOM_DELETES_UNHELD_MAX = 500;
/** How an unheld delete is stored: its entry with this mark in front. Entries stored before the
 *  mark existed (all without it) read as held. */
const UNHELD_MARK = "?";
const TXID_RE = /^[0-9a-f]{64}$/;

/** `{"type":"delete","targetTxId":...}` (K MessageDeleteCodec.encode). */
export function encodeRoomDelete(targetTxId) {
  return JSON.stringify({ type: "delete", targetTxId: String(targetTxId || "") });
}

/** The delete a room message carries, or null (K MessageDeleteCodec.parse: same "{"-prefix and
 *  2,000-byte guard as an edit). */
export function parseRoomDelete(text) {
  if (typeof text !== "string" || text.length >= 2000) return null;
  const trimmed = text.trim();
  if (trimmed[0] !== "{" || !trimmed.includes('"delete"')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || parsed.type !== "delete" || typeof parsed.targetTxId !== "string" || !parsed.targetTxId) return null;
    return { targetTxId: parsed.targetTxId };
  } catch { return null; }
}

/** One remembered delete: "room|txid|sender", the txid and sender lowercased. */
export function roomDeleteEntry(channel, txId, sender) {
  return `${String(channel || "").toLowerCase()}|${String(txId || "").toLowerCase()}|${String(sender || "").toLowerCase()}`;
}

/** The "room|txid|sender" a stored entry stands for, held or not. */
export function roomDeleteLookupKey(stored) {
  const text = String(stored || "");
  return text.startsWith(UNHELD_MARK) ? text.slice(UNHELD_MARK.length) : text;
}
/** Every remembered delete as "room|txid|sender", for isRoomDeleted-style lookups. */
export function roomDeleteLookupSet(list) {
  return new Set((Array.isArray(list) ? list : []).map(roomDeleteLookupKey));
}

/**
 * Adds a delete to the remembered list (oldest first). Two budgets (audit 2026-11-25 #26): the
 * newest `max` (2,000) deletes whose target was held, and the newest `unheldMax` (500) whose target
 * wasn't (`held: false`, stored with a "?" in front). A delete stored unheld and met again with its
 * target held moves to the held budget. Returns the new list, or null when nothing changed.
 */
export function addRoomDelete(list, channel, txId, sender, max = ROOM_DELETES_MAX, { held = true, unheldMax = ROOM_DELETES_UNHELD_MAX } = {}) {
  const entry = roomDeleteEntry(channel, txId, sender);
  const unheld = UNHELD_MARK + entry;
  const current = Array.isArray(list) ? list : [];
  if (current.includes(entry)) return null;
  const hadUnheld = current.includes(unheld);
  if (!held && hadUnheld) return null;
  const next = [...(hadUnheld ? current.filter((stored) => stored !== unheld) : current), held ? entry : unheld];
  let heldCount = 0;
  let unheldCount = 0;
  for (const stored of next) { if (stored.startsWith(UNHELD_MARK)) unheldCount += 1; else heldCount += 1; }
  let dropHeld = Math.max(0, heldCount - max);
  let dropUnheld = Math.max(0, unheldCount - unheldMax);
  if (!dropHeld && !dropUnheld) return next;
  // the oldest of each kind go
  return next.filter((stored) => {
    if (stored.startsWith(UNHELD_MARK)) { if (dropUnheld > 0) { dropUnheld -= 1; return false; } return true; }
    if (dropHeld > 0) { dropHeld -= 1; return false; }
    return true;
  });
}

/**
 * The deletes in a batch of room rows that take something away: for each delete, the target is
 * gone when this client holds it from the delete's own sender. A delete naming someone else's
 * message does nothing and isn't kept; one whose target isn't held (yet) is kept, so the target
 * can't arrive later. Returns { gone: Set<txid>, record: [{ target, sender, held }] }, `held`
 * saying which budget the delete is kept on (addRoomDelete).
 * `senderOf(txId)` gives the held message's sender, or null when it isn't held.
 */
export function resolveRoomDeletes(deletes, senderOf) {
  const gone = new Set();
  const record = [];
  for (const { target, sender } of deletes || []) {
    if (!target || !sender) continue;
    const held = senderOf(target) ?? senderOf(String(target).toLowerCase());
    if (held != null) {
      if (String(held).toLowerCase() !== String(sender).toLowerCase()) continue; // not theirs to delete
      gone.add(target);
    }
    record.push({ target, sender, held: held != null });
  }
  return { gone, record };
}

/**
 * Which held rows the indexer no longer has, from one read (K d089011f dropRowsTheIndexerNoLongerHas).
 * For a room the indexer tracks, the indexer is the truth ("work like KaPost"): a delivered row
 * held in the span the read answers for, that the read doesn't have, goes. The caller checks the
 * rest of K's rules first: the app-wide indexer only, a room it tracks, never a machinery room,
 * never a failed read.
 * - never an empty page, never below the page's oldest row (an indexer holding less than this
 *   device says nothing about older messages), never the oldest day of the 30 days;
 * - the newest page (`before` null) answers from its oldest row, a minute in, up to 90 seconds
 *   ago, so the newest message goes too; an older page between its oldest row and `before`, a
 *   minute inside both;
 * - your own messages only once 5 minutes old (sends still on their way to the indexer stay), and
 *   never a pending, failed or unconfirmed send (any `status`) nor a sent row still on this
 *   device's clock (`localTime`). `me` may be one address or a list: the room cache is shared by
 *   every account saved here, so all of theirs count (audit 2026-11-25 #25);
 * - a row goes on its `needed`th miss (`strikes`, a Map of "room|txid" -> misses, updated here):
 *   2 normally, 1 on the first read after the room opens and in the Rooms list's check;
 * - no brake on how many go at once: if the indexer loses history, this shows that too, as KaPost
 *   would. A row that's only missing, not deleted for everyone, comes back with the read that has it.
 * `before` is the page's exclusive upper bound when it was asked for older history.
 * Returns { gone: [txid] }.
 */
export function rowsTheIndexerNoLongerHas({ channel, page, before = null, held, me = "", now = Date.now(), retentionMs, strikes, needed = 2 }) {
  const times = (page || []).map((row) => Number(row?.blockTime)).filter((t) => Number.isFinite(t) && t > 0);
  if (!times.length) return { gone: [] };
  const oldest = Math.min(...times);
  const margin = 60_000;
  const catchUp = 90_000;
  // the newest page answers for everything up to now, less the indexer's catch-up time
  const upper = Math.min(before != null ? Number(before) - 1 - margin : now - catchUp, now - catchUp);
  const lower = Math.max(oldest + margin, now - retentionMs + 86_400_000);
  if (!(lower <= upper)) return { gone: [] };
  const mine = new Set((Array.isArray(me) ? me : [me]).map((address) => String(address || "").toLowerCase()).filter(Boolean));
  const onPage = new Set((page || []).map((row) => String(row?.txId || "").toLowerCase()));
  const considered = (held || []).filter((m) => {
    const t = Number(m?.blockTime) || 0;
    const id = String(m?.txId || "").toLowerCase();
    return t >= lower && t <= upper && !m.status && !m.localTime && TXID_RE.test(id)
      && (!mine.has(String(m.senderAddress || "").toLowerCase()) || t < now - 300_000);
  });
  const required = Math.max(1, Number(needed) || 2);
  const gone = [];
  for (const row of considered) {
    const id = String(row.txId).toLowerCase();
    const key = `${channel}|${id}`;
    if (onPage.has(id)) { strikes.delete(key); continue; }
    const misses = (strikes.get(key) || 0) + 1;
    strikes.set(key, misses);
    if (misses >= required) gone.push(row.txId);
  }
  if (strikes.size > 5000) strikes.clear();
  for (const id of gone) strikes.delete(`${channel}|${String(id).toLowerCase()}`);
  return { gone };
}
