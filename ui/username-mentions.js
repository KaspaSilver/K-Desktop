// @mentions by .kachat username (K bdf29425, 157790b0; K's Views/Shared/UsernameMentions.swift):
// in group chats, public chats (rooms) and KaPost you can @ someone only if they have a username.
// One set of rules for all three:
// - group chats keep their wire format: the mention goes out as `@<address>` (the encode below),
//   so it survives a rename, and shows as the member's current name;
// - rooms and KaPost are public text: the mention is the plain `@name.kachat` as typed (KaPost also
//   signs the mentioned keys);
// - a token is only a mention when it is a valid username (`a-z 0-9 -`, 1-32, no hyphen at either
//   end, an optional `.kachat` ending), after the start of the text, a space or an opening bracket
//   or quote; `@word` that can't be a username stays text.
//
// What a suggestion inserts keeps the `.kachat` ending (Show .kachat Endings is display only: a
// mention and anything sent keep it). The lists show names as the app shows them.
//
// The first half is pure (tools/test-k-mentions.mjs); `attachMentionSuggestions` is the DOM list
// above or under a composer, and touches the document only when called.

import { isValid, normalize } from "../engine/kachat-names/codec.js";

/** @mentions are on (K MentionsFeature.enabled, back on 2026-11-24 on .kachat names). */
export const MENTIONS_ENABLED = true;

const TOKEN_SOURCE = String.raw`(^|[\s(\[{<"'])@([A-Za-z0-9-]{1,32})(\.kachat)?(?![A-Za-z0-9-])`;
/** A fresh global token regex: groups 1 the lead, 2 the name, 3 the ending (if written). */
export function mentionTokenRegex() { return new RegExp(TOKEN_SOURCE, "gi"); }

/** Every username-shaped @token in `text`: `{ start, end, name }`, where start is the "@", end is
 *  past the name (and its ending), and name is bare and lowercased. */
export function mentionTokens(text) {
  const value = String(text ?? "");
  if (!value.includes("@")) return [];
  const out = [];
  for (const m of value.matchAll(mentionTokenRegex())) {
    const name = m[2].toLowerCase();
    if (!isValid(name)) continue;
    const start = m.index + (m[1] || "").length;
    out.push({ start, end: start + 1 + m[2].length + (m[3] || "").length, name });
  }
  return out;
}

/** The bare username `label` is, or null when it can't be one (no name: no mention). */
export function mentionName(label) {
  if (label == null) return null;
  const bare = normalize(String(label));
  return bare && isValid(bare) ? bare : null;
}

/** What a picked suggestion writes: "@alice.kachat " (the ending kept, as anything sent keeps it). */
export function mentionInsertText(name) { return `@${normalize(name)}.kachat `; }

/** Whether public text @'s `myName` (a bare username) by its username. */
export function textMentionsName(text, myName) {
  const me = mentionName(myName);
  if (!me) return false;
  return mentionTokens(text).some((t) => t.name === me);
}

/** The @token being typed at the end of `before` (the text up to the caret): "" right after the
 *  "@", the typed name lowercased, or null when the caret isn't in one. */
export function typedMentionQuery(before) {
  const text = String(before ?? "");
  const at = text.lastIndexOf("@");
  if (at < 0) return null;
  const lead = at > 0 ? text[at - 1] : "";
  if (lead && !/[\s([{<"']/.test(lead)) return null;
  const query = text.slice(at + 1);
  if (query.length > 32 || !/^[\p{L}\p{N}-]*$/u.test(query)) return null;
  return query.toLowerCase();
}

/** `before` with its typed @token swapped for `insert`. */
export function replaceTypedMention(before, insert) {
  const text = String(before ?? "");
  const at = text.lastIndexOf("@");
  return at < 0 ? text + insert : text.slice(0, at) + insert;
}

const lower = (value) => String(value || "").trim().toLowerCase();
const matchesQuery = (name, query) => {
  const typed = normalize(query || "");
  return !typed || name.startsWith(typed);
};

/**
 * A group's members to @ (K GroupChatDetailView.mentionCandidates): those with a username whose
 * name starts with what's typed, never you, by name. `labelOf(address)` is the cached .kachat
 * label (bare) or null. -> [{ address, name }]
 */
export function groupMentionCandidates({ query = "", members = [], me = "", labelOf }) {
  const self = lower(me);
  const out = [];
  const seen = new Set();
  for (const member of members) {
    const address = String(member?.address ?? member ?? "");
    const key = lower(address);
    if (!key || key === self || seen.has(key)) continue;
    seen.add(key);
    const name = mentionName(labelOf?.(address));
    if (name && matchesQuery(name, query)) out.push({ address, name });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** One list from address sources in order: each person once (named or not), never you, only those
 *  with a username matching the query. `first` (optional, `{ address, name }`) leads. */
function orderedCandidates({ query, me, sources, labelOf, first = null, limit }) {
  const self = lower(me);
  const seen = new Set();
  const names = new Set();
  const out = [];
  const consider = (address, given = null) => {
    const key = lower(address);
    if (!key || key === self || seen.has(key)) return;
    seen.add(key);
    const name = mentionName(given ?? labelOf?.(address));
    if (!name || names.has(name) || !matchesQuery(name, query)) return;
    names.add(name);
    out.push({ address: String(address), name });
  };
  if (first?.name) consider(first.address || `name:${first.name}`, first.name);
  for (const list of sources) for (const address of list || []) consider(address);
  return out.slice(0, limit);
}

/**
 * Who a room's @ suggests (K PublicChatChannelView.roomMentionCandidates, 157790b0): anyone looked
 * up by the typed name, then everyone who has written in the room (`senders`, newest first), then
 * your contacts - only people with a username, never you. -> [{ address, name }], at most 50.
 */
export function roomMentionCandidates({ query = "", me = "", senders = [], contacts = [], labelOf, lookedUp = null }) {
  return orderedCandidates({ query, me, sources: [senders, contacts], labelOf, first: lookedUp, limit: 50 });
}

/**
 * Who KaPost's @ suggests (K KaPostMentionSources.handles, 157790b0): the people you follow, people
 * whose posts you've seen lately (newest first), then your contacts - only those with a username,
 * never you - plus a name looked up as you type, first. -> [{ address, name }], at most 30 (and the
 * looked-up one).
 */
export function kaPostMentionCandidates({ query = "", me = "", following = [], recentPosters = [], contacts = [], labelOf, lookedUp = null }) {
  const list = orderedCandidates({ query, me, sources: [[...following].map(String).sort(), recentPosters.slice(0, 200), contacts], labelOf, limit: 30 });
  const extra = lookedUp?.name ? mentionName(lookedUp.name) : null;
  if (extra && matchesQuery(extra, query) && !list.some((c) => c.name === extra)) {
    list.unshift({ address: lookedUp.address || "", name: extra });
  }
  return list;
}

// KaPost's recent posters (K KaPostMentionSources.notePoster): a poster whose post was read (the
// feed, threads, profiles), newest first, at most 300.
const recentPosterList = [];
export function noteKaPostPoster(address) {
  const key = lower(address);
  if (!key) return;
  const at = recentPosterList.indexOf(key);
  if (at === 0) return;
  if (at > 0) recentPosterList.splice(at, 1);
  recentPosterList.unshift(key);
  if (recentPosterList.length > 300) recentPosterList.length = 300;
}
export function recentKaPostPosters() { return recentPosterList.slice(); }
export function resetKaPostPosters() { recentPosterList.length = 0; }

/**
 * Group text with each member's `@name` / `@name.kachat` (any case) turned into `@<their address>`,
 * the group wire format (K GroupChatDetailView.encodeMentions). `members`: [{ address, name }] with
 * bare names. Longest name first, so "@alice2" isn't caught by "@alice". A name that isn't a
 * member's stays text.
 */
export function encodeGroupMentionText(text, members) {
  let out = String(text ?? "");
  if (!out.includes("@")) return out;
  const named = (members || [])
    .map((m) => ({ address: String(m?.address || ""), name: mentionName(m?.name) }))
    .filter((m) => m.address && m.name)
    .sort((a, b) => b.name.length - a.name.length);
  for (const { address, name } of named) {
    const escaped = name.replace(/[-]/g, "\\-");
    const re = new RegExp(String.raw`(^|[\s(\[{<"'])@${escaped}(?:\.kachat)?(?![A-Za-z0-9-])`, "gi");
    out = out.replace(re, (_, lead) => `${lead}@${address}`);
  }
  return out;
}

/** An on-chain group mention: `@<kaspa address>` (optionally brace-wrapped, an older desktop form). */
export const GROUP_MENTION_ADDRESS_RE = /@\{?(kaspa(?:test)?:[a-z0-9]{20,})\}?/gi;

/** Group text with each `@<address>` read as `@<their name>` (`nameOf(address)`). */
export function decodeGroupMentionText(text, nameOf) {
  return String(text ?? "").replace(new RegExp(GROUP_MENTION_ADDRESS_RE.source, "gi"), (_, address) => `@${nameOf(address)}`);
}

/**
 * A membership line as the thread shows it (K GroupSystemLine.display): the stored line
 * ("<address> joined the group"), with each address as that person's current name. Lines keep the
 * full address so a .kachat name or a contact name that lands later shows too; an older line that
 * stored a name reads as it was.
 */
const ADDRESS_IN_TEXT_RE = /kaspa(?:test)?:[a-z0-9]{40,90}/g;
export function groupSystemLineDisplay(stored, nameOf) {
  const text = String(stored ?? "");
  if (!text.includes("kaspa")) return text;
  return text.replace(new RegExp(ADDRESS_IN_TEXT_RE.source, "g"), (address) => nameOf(address));
}

// ---- The suggestion list (DOM) ------------------------------------------------------------------

const ROW_LIMIT_VISIBLE = 5;

/**
 * Wires an @ suggestion list to a composer `textarea`. While an @token is being typed, the list
 * shows who `source(query, lookedUp)` gives (`[{ address, name }]`); picking one writes
 * "@name.kachat ". Two or more letters are also looked up as a name (`lookup(query)` ->
 * `{ address, name }` | null, 350 ms after the last key), for anyone with a username who is in no
 * list. Five rows show before the list scrolls. `subscribe(fn)` re-asks the source when names
 * arrive (the names registry), so people appear as their usernames do.
 *
 * `container`: an element to draw in (it is shown and hidden); without one the list floats under
 * the field. Returns { refresh, close }.
 */
export function attachMentionSuggestions(textarea, { source, lookup = null, subscribe = null, avatarHtml = null, displayName = (n) => n, escapeHtml, container = null, className = "mention-suggest" } = {}) {
  if (!textarea || textarea.dataset.mentionSuggestWired) return null;
  textarea.dataset.mentionSuggestWired = "1";
  const esc = escapeHtml || ((v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  let list = container;
  let items = [];
  let active = 0;
  let query = null;
  let lookedUp = null;
  let lookupTimer = null;
  let lookupToken = 0;

  const ensureList = () => {
    if (list) return list;
    list = document.createElement("div");
    list.className = `${className} ${className}-floating`;
    list.hidden = true;
    document.body.appendChild(list);
    return list;
  };
  const place = () => {
    if (container || !list) return;
    const rect = textarea.getBoundingClientRect();
    list.style.left = `${rect.left + window.scrollX}px`;
    list.style.top = `${rect.bottom + window.scrollY + 4}px`;
    list.style.width = `${Math.min(Math.max(rect.width, 220), 320)}px`;
  };
  function close() {
    query = null;
    items = [];
    active = 0;
    lookedUp = null;
    lookupToken += 1;
    if (lookupTimer) { window.clearTimeout(lookupTimer); lookupTimer = null; }
    if (list && (!list.hidden || list.firstChild)) { list.hidden = true; list.innerHTML = ""; }
  }
  function draw() {
    if (query == null) return;
    items = (source?.(query, lookedUp) || []).filter((c) => c && c.name);
    if (!items.length) { if (list) { list.hidden = true; list.innerHTML = ""; } return; }
    if (active >= items.length) active = 0;
    const el = ensureList();
    el.classList.add(className);
    el.style.setProperty("--mention-visible-rows", String(Math.min(items.length, ROW_LIMIT_VISIBLE)));
    el.innerHTML = items.map((c, i) => `
      <button type="button" class="${className}-row${i === active ? " active" : ""}" data-mention-pick="${i}">
        ${avatarHtml && c.address && !c.address.startsWith("name:") ? avatarHtml(c.address) : `<span class="${className}-glyph" aria-hidden="true">@</span>`}
        <strong>@${esc(displayName(c.name))}</strong>
      </button>`).join("");
    el.hidden = false;
    place();
    el.querySelector(".active")?.scrollIntoView?.({ block: "nearest" });
  }
  function scheduleLookup(q) {
    lookupToken += 1;
    const token = lookupToken;
    if (lookupTimer) { window.clearTimeout(lookupTimer); lookupTimer = null; }
    if (lookedUp && lookedUp.query !== q) lookedUp = null;
    const typed = normalize(q || "");
    if (!lookup || typed.length < 2 || !isValid(typed)) return;
    lookupTimer = window.setTimeout(async () => {
      lookupTimer = null;
      let found = null;
      try { found = await lookup(typed); } catch { found = null; }
      if (token !== lookupToken || !found?.name) return;
      lookedUp = { query: q, address: found.address || "", name: normalize(found.name) };
      draw();
    }, 350);
  }
  function refresh() {
    const caret = textarea.selectionStart ?? textarea.value.length;
    const q = typedMentionQuery(textarea.value.slice(0, caret));
    if (q == null) { close(); return; }
    if (q !== query) active = 0;
    query = q;
    draw();
    scheduleLookup(q);
  }
  function pick(index) {
    const item = items[index];
    if (!item) { close(); return; }
    const caret = textarea.selectionStart ?? textarea.value.length;
    const before = replaceTypedMention(textarea.value.slice(0, caret), mentionInsertText(item.name));
    textarea.value = before + textarea.value.slice(caret);
    close();
    textarea.focus();
    try { textarea.setSelectionRange(before.length, before.length); } catch { /* not a text field */ }
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  textarea.addEventListener("input", refresh);
  textarea.addEventListener("click", refresh);
  textarea.addEventListener("keydown", (event) => {
    if (query == null || !items.length || !list || list.hidden) return;
    if (event.key === "ArrowDown") { event.preventDefault(); active = (active + 1) % items.length; draw(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); active = (active - 1 + items.length) % items.length; draw(); }
    else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") { event.preventDefault(); event.stopImmediatePropagation(); pick(active); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  }, true);
  textarea.addEventListener("blur", () => { window.setTimeout(() => { if (document.activeElement !== textarea) close(); }, 180); });
  // mousedown, so the field keeps the focus (and the caret) through the pick
  const onPress = (event) => {
    const row = event.target.closest?.("[data-mention-pick]");
    if (!row || !list?.contains(row)) return;
    event.preventDefault();
    pick(Number(row.dataset.mentionPick));
  };
  if (container) container.addEventListener("mousedown", onPress);
  else document.addEventListener("mousedown", onPress);
  subscribe?.(() => { if (query != null) draw(); });
  return { refresh, close };
}
