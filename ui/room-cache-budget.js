// What the public-chat message cache keeps in storage (audit 2026-11-25 #11).
//
// The cache is every indexed room's 30 days, shared by every account here, and a row's text can be
// up to ~200 KB. Cheap spam of long messages could fill the site's storage, and then settings
// writes (a block, a joined room) failed. The copy in memory stays whole for the session; the copy
// written to storage is bounded:
//   - a plain-text row longer than ROOM_ROW_STORED_CHARS keeps its start and `truncated: true`
//     (the bubble shows 500 characters anyway; Show More says only the start is kept here, and the
//     full text comes back when the indexer or the chain serves the row again - restoreTruncatedRow);
//   - envelopes (JSON: voice parts, photos, replies...) are never cut, as a cut one no longer parses;
//   - each room keeps at most ROOM_STORED_CHARS and all rooms ROOM_CACHE_STORED_CHARS, the oldest
//     rows going first. Rows with a status (sending, failed, not confirmed) always stay: a reload
//     needs them to settle the send.
// Pure functions: ui/broadcasts.js does the storage, tools/test-room-cache-budget.mjs the checks.

export const ROOM_ROW_STORED_CHARS = 4096;
export const ROOM_STORED_CHARS = 400_000;
export const ROOM_CACHE_STORED_CHARS = 1_500_000;

/** The row as it is stored: long plain text cut to its start (`truncated`), anything else as is. */
export function storedRoomRow(row, rowMax = ROOM_ROW_STORED_CHARS) {
  const content = typeof row?.content === "string" ? row.content : "";
  if (content.length <= rowMax || row.truncated || content.trimStart().startsWith("{")) return row;
  return { ...row, content: content.slice(0, rowMax), truncated: true };
}

function rowChars(row) {
  try { return JSON.stringify(row).length + 1; } catch { return 0; }
}

/**
 * `{ [channel]: rows }` to write to storage, within the budgets above. `messageCache` is not
 * changed. `budget` lowers the caps (a retry after a quota error asks for half).
 */
export function roomCacheForStorage(messageCache, {
  rowMax = ROOM_ROW_STORED_CHARS, roomMax = ROOM_STORED_CHARS, totalMax = ROOM_CACHE_STORED_CHARS, budget = 1,
} = {}) {
  const perRoom = Math.max(1, Math.floor(roomMax * budget));
  const total = Math.max(1, Math.floor(totalMax * budget));
  const rooms = [];
  for (const channel of Object.keys(messageCache || {})) {
    const rows = Array.isArray(messageCache[channel]) ? messageCache[channel] : [];
    const stored = rows.map((row) => storedRoomRow(row, rowMax));
    const sizes = stored.map(rowChars);
    // keep[i]: still stored. Oldest first in the cache (sorted by block time), so they go first.
    const keep = stored.map(() => true);
    let size = sizes.reduce((sum, n) => sum + n, 0);
    for (let i = 0; i < stored.length && size > perRoom; i += 1) {
      if (stored[i]?.status) continue;
      keep[i] = false;
      size -= sizes[i];
    }
    rooms.push({ channel, stored, sizes, keep, size, next: 0 });
  }
  let sum = rooms.reduce((acc, room) => acc + room.size, 0);
  // Over the total: the biggest room gives up its oldest rows, a tenth of the excess at a time.
  while (sum > total) {
    const room = rooms.reduce((big, r) => (r.size > (big?.size ?? -1) && r.next < r.stored.length ? r : big), null);
    if (!room) break;
    const goal = Math.max(1, Math.ceil((sum - total) / 10));
    let freed = 0;
    while (room.next < room.stored.length && freed < goal) {
      const i = room.next++;
      if (!room.keep[i] || room.stored[i]?.status) continue;
      room.keep[i] = false;
      freed += room.sizes[i];
    }
    if (!freed && room.next >= room.stored.length) { room.size = -1; continue; }
    room.size -= freed;
    sum -= freed;
  }
  const out = {};
  for (const room of rooms) {
    const rows = room.stored.filter((_, i) => room.keep[i]);
    if (rows.length) out[room.channel] = rows;
  }
  return out;
}

/** A stored row cut to its start (`truncated`) whose full text came back (the indexer or the
 *  chain served it again): it takes the full text. Returns whether it changed. */
export function restoreTruncatedRow(row, incoming) {
  if (!row?.truncated || typeof incoming?.content !== "string") return false;
  const content = String(row.content ?? "");
  if (incoming.content.length <= content.length || !incoming.content.startsWith(content)) return false;
  row.content = incoming.content;
  delete row.truncated;
  return true;
}

/**
 * Room edits whose message is gone (audit 2026-11-25 #23): edits are kept per target, and the
 * cache's retention pruned the messages but never their edits. Drops, in place, every edit whose
 * target isn't among `messageCache[channel]`, or older than the room's `cutoffFor(channel)` (0 or
 * null: no cutoff), and rooms left with none. Returns whether anything went.
 */
export function pruneRoomEdits(editsCache, messageCache, cutoffFor = () => 0) {
  let changed = false;
  for (const channel of Object.keys(editsCache || {})) {
    const edits = editsCache[channel];
    const held = new Set((messageCache?.[channel] || []).map((m) => m?.txId));
    const cutoff = Number(cutoffFor(channel)) || 0;
    for (const target of Object.keys(edits || {})) {
      const edit = edits[target];
      if (held.has(target) && !(cutoff && Number(edit?.blockTime || 0) < cutoff)) continue;
      delete edits[target];
      changed = true;
    }
    if (!edits || typeof edits !== "object" || Object.keys(edits).length === 0) {
      delete editsCache[channel];
      changed = true;
    }
  }
  return changed;
}
