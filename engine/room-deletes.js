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

/** Adds a delete to the remembered list (oldest first), keeping the newest 2,000. Returns the new
 *  list, or null when it was already there. */
export function addRoomDelete(list, channel, txId, sender, max = ROOM_DELETES_MAX) {
  const entry = roomDeleteEntry(channel, txId, sender);
  const current = Array.isArray(list) ? list : [];
  if (current.includes(entry)) return null;
  const next = [...current, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * The deletes in a batch of room rows that take something away: for each delete, the target is
 * gone when this client holds it from the delete's own sender. A delete naming someone else's
 * message does nothing and isn't kept; one whose target isn't held (yet) is kept, so the target
 * can't arrive later. Returns { gone: Set<txid>, record: [{ target, sender }] }.
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
    record.push({ target, sender });
  }
  return { gone, record };
}

/**
 * Which held rows the indexer no longer has, from one page (K dropRowsTheIndexerNoLongerHas).
 * The caller checks the rest of K's rules first: the app-wide indexer only, a room it tracks,
 * never a machinery room.
 * - never an empty page, never below the page's oldest row;
 * - a minute inside both edges, never the newest 3 minutes, never the oldest day of the 30 days;
 * - never your own messages, nor a pending, failed or unconfirmed send (any `status`);
 * - a row goes on its second miss (`strikes`, a Map of "room|txid" -> misses, updated here);
 * - a read that would remove more than a handful (over 3 and over a fifth) removes nothing.
 * `before` is the page's exclusive upper bound when it was asked for older history.
 * Returns { gone: [txid], refused: { gone, considered } | null }.
 */
export function rowsTheIndexerNoLongerHas({ channel, page, before = null, held, me = "", now = Date.now(), retentionMs, strikes }) {
  const times = (page || []).map((row) => Number(row?.blockTime)).filter((t) => Number.isFinite(t) && t > 0);
  if (!times.length) return { gone: [], refused: null };
  const newest = Math.max(...times);
  const oldest = Math.min(...times);
  const margin = 60_000;
  const upper = Math.min((before != null ? Number(before) - 1 : newest) - margin, now - 180_000);
  const lower = Math.max(oldest + margin, now - retentionMs + 86_400_000);
  if (lower > upper) return { gone: [], refused: null };
  const mine = String(me || "").toLowerCase();
  const onPage = new Set((page || []).map((row) => String(row?.txId || "").toLowerCase()));
  const considered = (held || []).filter((m) => {
    const t = Number(m?.blockTime) || 0;
    const id = String(m?.txId || "").toLowerCase();
    return t >= lower && t <= upper && !m.status && TXID_RE.test(id)
      && String(m.senderAddress || "").toLowerCase() !== mine;
  });
  const gone = [];
  for (const row of considered) {
    const id = String(row.txId).toLowerCase();
    const key = `${channel}|${id}`;
    if (onPage.has(id)) { strikes.delete(key); continue; }
    const misses = (strikes.get(key) || 0) + 1;
    strikes.set(key, misses);
    if (misses >= 2) gone.push(row.txId);
  }
  if (strikes.size > 5000) strikes.clear();
  if (!gone.length) return { gone: [], refused: null };
  if (gone.length > 3 && gone.length * 5 > considered.length) {
    return { gone: [], refused: { gone: gone.length, considered: considered.length } };
  }
  for (const id of gone) strikes.delete(`${channel}|${String(id).toLowerCase()}`);
  return { gone, refused: null };
}
