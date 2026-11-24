// Settings > Chats > Who Can Message You? (K 518fdc8c `WhoCanMessage`): Anyone, or Only Users with
// a Username. With usernames only, a 1:1 Message Request from a sender with no .kachat name (or none
// known yet) is hidden - not deleted, and left out of the Message Requests count - and rings
// nothing. A name that lands shows the request, and it rings once then (K audit 2026-11-24 #13).
// Accepted chats and group invites are never affected.
//
// One app setting, as on K (UserDefaults.standard there): not per account. Pure apart from the
// storage passed in, so tools/test-k54-chat-features.mjs checks it in Node.

export const WHO_CAN_MESSAGE_KEY = "kachat-who-can-message-v1";
export const WHO_CAN_MESSAGE_ANYONE = "anyone";
export const WHO_CAN_MESSAGE_USERNAMES = "usernames";

/** The choices, in K's order. */
export const WHO_CAN_MESSAGE_OPTIONS = Object.freeze([
  Object.freeze({ value: WHO_CAN_MESSAGE_ANYONE, label: "Anyone" }),
  Object.freeze({ value: WHO_CAN_MESSAGE_USERNAMES, label: "Only Users with a Username" }),
]);

/** What each choice does, under the picker (K WhoCanMessageView's footer). */
export const WHO_CAN_MESSAGE_FOOTERS = Object.freeze({
  [WHO_CAN_MESSAGE_ANYONE]: "Anyone can send you a first message. It waits in Message Requests until you accept it.",
  [WHO_CAN_MESSAGE_USERNAMES]: "Only people with a username (a .kachat name) can reach your Message Requests. First messages from anyone else are hidden and don't notify you; choose Anyone to see them again. People you already chat with aren't affected.",
});

// Read once and kept (K audit 2026-11-24 #28: the requests count reads it on every draw).
let cached = null;

/** The current choice: "anyone" (the default) or "usernames". */
export function whoCanMessage(storage = globalThis.localStorage) {
  if (cached) return cached;
  let raw = null;
  try { raw = storage?.getItem(WHO_CAN_MESSAGE_KEY) ?? null; } catch { raw = null; }
  cached = raw === WHO_CAN_MESSAGE_USERNAMES ? WHO_CAN_MESSAGE_USERNAMES : WHO_CAN_MESSAGE_ANYONE;
  return cached;
}

/** Saves the choice (anything else is Anyone) and returns it. */
export function setWhoCanMessage(value, storage = globalThis.localStorage) {
  const next = value === WHO_CAN_MESSAGE_USERNAMES ? WHO_CAN_MESSAGE_USERNAMES : WHO_CAN_MESSAGE_ANYONE;
  cached = next;
  try {
    if (next === WHO_CAN_MESSAGE_USERNAMES) storage?.setItem(WHO_CAN_MESSAGE_KEY, next);
    else storage?.removeItem(WHO_CAN_MESSAGE_KEY);
  } catch { /* this session only */ }
  return next;
}

/** Forgets the kept copy (tests; another tab's change). */
export function resetWhoCanMessageCache() { cached = null; }

/** K isHiddenRequest: usernames only, and no .kachat name known for the sender. Only ever asked of
 *  a conversation that already is a Message Request. */
export function isHiddenRequest({ setting, label } = {}) {
  return setting === WHO_CAN_MESSAGE_USERNAMES && !String(label || "").trim();
}

/** The Message Requests list and its count: requests, without the hidden ones. */
export function visibleMessageRequests(entries, { isRequest, isHidden }) {
  return (entries || []).filter((entry) => isRequest(entry) && !isHidden(entry));
}

// --- Silenced senders, waiting for a name (K chat_hidden_request_addresses) -----------------------
// Entries are "wallet|address", lowercased, newest last, at most 500. The open app files a sender
// it kept quiet for; public/sw.js files the ones a closed-app push kept quiet for.
export const HIDDEN_REQUESTS_LIMIT = 500;

function entryFor(wallet, address) {
  const w = String(wallet || "").trim().toLowerCase();
  const a = String(address || "").trim().toLowerCase();
  return w && a ? `${w}|${a}` : "";
}

/** `list` with this sender filed (once). A new array. */
export function noteHiddenRequest(list, wallet, address) {
  const entry = entryFor(wallet, address);
  const next = Array.isArray(list) ? list.filter((item) => typeof item === "string" && item) : [];
  if (!entry || next.includes(entry)) return next;
  next.push(entry);
  return next.length > HIDDEN_REQUESTS_LIMIT ? next.slice(next.length - HIDDEN_REQUESTS_LIMIT) : next;
}

/** Two lists as one, each entry once, order kept. */
export function mergeHiddenRequests(a, b) {
  let out = Array.isArray(a) ? a.filter((item) => typeof item === "string" && item) : [];
  for (const item of Array.isArray(b) ? b : []) {
    if (typeof item !== "string" || !item.includes("|")) continue;
    const [wallet, ...rest] = item.split("|");
    out = noteHiddenRequest(out, wallet, rest.join("|"));
  }
  return out;
}

/**
 * K ChatService.announceNamedHiddenRequests, as a pure step. For this wallet's filed senders:
 * - `requestState(address)`: true while they are still a Message Request, false when not (accepted,
 *   deleted, rejected), null when their chat isn't here yet (kept for the next pass);
 * - `blocked(address)`: a blocked sender is dropped;
 * - `labelOf(address)`: their .kachat name, or null while none is known (kept).
 * A named one leaves the list and is announced once (`notified` holds whom the app already rang).
 * Returns `{ list, announce: [address] }`; nothing at all while the setting is Anyone.
 */
export function settleHiddenRequests({ list, wallet, setting, requestState, blocked = () => false, labelOf, notified = new Set() } = {}) {
  const all = Array.isArray(list) ? list : [];
  if (setting !== WHO_CAN_MESSAGE_USERNAMES) return { list: all, announce: [] };
  const prefix = `${String(wallet || "").trim().toLowerCase()}|`;
  if (prefix === "|") return { list: all, announce: [] };
  const kept = [];
  const announce = [];
  for (const entry of all) {
    if (typeof entry !== "string" || !entry.startsWith(prefix)) { kept.push(entry); continue; }
    const address = entry.slice(prefix.length);
    const isRequest = requestState(address);
    if (isRequest == null) { kept.push(entry); continue; } // not loaded yet
    if (!isRequest || blocked(address)) continue; // nothing to announce
    if (!String(labelOf(address) || "").trim()) { kept.push(entry); continue; } // still nameless
    if (!notified.has(address) && !announce.includes(address)) announce.push(address);
  }
  return { list: kept, announce };
}
