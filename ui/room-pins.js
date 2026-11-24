// Public rooms pinned into the Chats circles row (K 518fdc8c, `kachat_room_pins_<wallet>`): room
// names, newest pin first, kept per account apart from the chat and group pins. A pinned room is a
// "#" circle after the pinned groups, out of the list (except while searching, when the results list
// it with the rest). Switching a default room off or leaving your own drops its pin, so it comes
// back in the list, not the row. Pure, so tools/test-k54-chat-features.mjs checks it in Node.

export const ROOM_PINS_KEY = "kachat-room-pins-v1";

/** Stored text to a clean list: strings, trimmed, each once. */
export function parseRoomPins(raw) {
  let list;
  try { list = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { list = null; }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const value of list) {
    const name = typeof value === "string" ? value.trim() : "";
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Pin or unpin `name`: a new pin goes first. Returns `{ pins, pinned }` (pinned = after). */
export function toggleRoomPin(pins, name) {
  const list = parseRoomPins(pins);
  const clean = String(name || "").trim();
  if (!clean) return { pins: list, pinned: false };
  if (list.includes(clean)) return { pins: list.filter((entry) => entry !== clean), pinned: false };
  return { pins: [clean, ...list], pinned: true };
}

/** `pins` without `name` (a room switched off or left). `changed` says whether it was there. */
export function dropRoomPin(pins, name) {
  const list = parseRoomPins(pins);
  const clean = String(name || "").trim();
  const next = list.filter((entry) => entry !== clean);
  return { pins: next, changed: next.length !== list.length };
}

/** The listed rooms that are pinned, in pin order. A pin whose room isn't listed shows nowhere. */
export function pinnedRoomsInOrder(pins, rooms) {
  const byName = new Map();
  for (const room of rooms || []) if (room?.name && !byName.has(room.name)) byName.set(room.name, room);
  return parseRoomPins(pins).map((name) => byName.get(name)).filter(Boolean);
}
