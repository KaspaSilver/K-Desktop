// K 8cb4c88e (owner, 2026-11-24), the UI part: a bell at the top right of 1:1 and group threads
// (Silence / Unsilence, the Chats list's swipe Silence, with iOS's toasts); Edit Default Public
// Chats as a gear at the top left of Chats instead of a New sheet row; and a Translate link under
// someone else's room message in another language, as KaPost posts have.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "..", "ui", "app.js"), "utf8");
const rooms = readFileSync(join(here, "..", "ui", "broadcasts.js"), "utf8");
const html = readFileSync(join(here, "..", "index.html"), "utf8");
const css = readFileSync(join(here, "..", "ui", "styles.css"), "utf8");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}
const between = (text, start, end) => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = text.indexOf(end, from + start.length);
  assert.ok(to > from, `missing ${end} after ${start}`);
  return text.slice(from, to);
};

test("1:1 and group thread headers each have a bell button", () => {
  const oneToOne = between(html, '<div class="conversation-header">', "</div>");
  assert.match(oneToOne, /data-open-chess[\s\S]*class="conversation-call-button conversation-bell-button" type="button" data-chat-bell/);
  const group = between(html, '<div class="conversation-header group-chat-header">', "</div>");
  assert.match(group, /class="conversation-call-button conversation-bell-button" type="button" data-group-chat-bell/);
});

test("the 1:1 bell is the swipe's Silence, with iOS's toasts", () => {
  const handler = between(app, 'document.querySelector("[data-chat-bell]")?.addEventListener("click"', "});");
  assert.match(handler, /const silence = getContactNotifyOverride\(contact\.address\) !== "off";/);
  assert.match(handler, /runChatRowChoice\(conversationEntry, "silence"\);/);
  assert.match(handler, /showCopyToast\(silence \? "Chat silenced\." : "Notifications on\."\);/);
});

test("the group bell is the swipe's Silence, with iOS's toasts", () => {
  const handler = between(app, 'document.querySelector("[data-group-chat-bell]")?.addEventListener("click"', "});");
  assert.match(handler, /const silence = getGroupNotify\(activeGroupId\) !== "muted";/);
  assert.match(handler, /runGroupRowChoice\(activeGroupId, "silence"\);/);
  assert.match(handler, /showCopyToast\(silence \? "Group silenced\." : "Notifications on\."\);/);
});

test("the bells show the chat's state and hide while selecting messages", () => {
  assert.match(app, /button\.innerHTML = silent \? ACTION_TILE_ICONS\.bellSlash : CHAT_BELL_ON_SVG;/);
  assert.match(app, /button\.setAttribute\("aria-label", silent \? "Notifications off" : "Notifications on"\);/);
  assert.match(app, /getContactNotifyOverride\(contact\?\.address\) === "off", !contact \|\| messageSelectionMode\);/);
  assert.match(app, /getGroupNotify\(activeGroupId\) === "muted", !activeGroupId \|\| groupSelectionMode\);/);
  // painted when a thread draws, when a group opens, and when select mode starts or ends
  assert.match(app, /\/\/ and the bell beside it \(K 8cb4c88e\)\n  try \{ refreshChatBellButton\(\); \}/);
  assert.match(app, /groupAvatarHtml\(g\.photoHex\);\n  refreshGroupChatBellButton\(\);/);
  assert.match(app, /selectionToolbar\.hidden = !messageSelectionMode;\n  try \{ refreshChatBellButton\(\); \}/);
  assert.match(app, /if \(del\) del\.disabled = selectedGroupMessageKeys\.size === 0;\n  refreshGroupChatBellButton\(\);/);
  // a swipe or sheet Silence with the thread open moves the bell too
  assert.match(app, /"muted" \? "all" : "muted"\); renderChats\(\); refreshGroupChatBellButton\(\); return; \}/);
  assert.match(app, /=== "off" \? undefined : "off"\);\n    renderChats\(\);\n    refreshChatBellButton\(\);/);
  // the chess board keeps the corner; the bell moves left of it
  assert.match(css, /\[data-open-chess\]:not\(\[hidden\]\) ~ \.conversation-bell-button \{ right: 62px; \}/);
});

test("Chat Info's Notifications takes effect as it's picked", () => {
  const listener = between(app, 'chatInfoNotifyToggle?.addEventListener("change"', "});");
  assert.match(listener, /applyChatInfoStagedPrefs\(\);/);
  assert.match(listener, /refreshChatBellButton\(\);/);
});

test("no gear for Public Chats any more (K 824a30bb): rooms come from Add Room", () => {
  const cluster = between(html, '<div class="toolbar-health-cluster">', '<div class="toolbar-balance"');
  assert.doesNotMatch(cluster, /data-chats-public-settings/);
  assert.doesNotMatch(app, /syncChatsPublicSettingsGear|openPublicChatsSettings/);
});

test("the New sheet no longer lists it", () => {
  const menu = between(app, "function newChatSheetMenuHtml() {", "return actionRowsSheetHtml");
  assert.doesNotMatch(menu, /Edit Default Public Chats"/);
  assert.doesNotMatch(app, /choice === "public-settings"/);
  assert.doesNotMatch(app, /"public-settings": '/);
});

test("room messages offer Translate under the bubble, KaPost's way", () => {
  const note = between(rooms, "const tState = translationKey ? deps.translation.state(translationKey) : null;", "el.append(note);");
  // someone else's (translationKey is null for your own), confirmed, plain text, offered by the
  // same check as the menu and KaPost texts (canOfferTextTranslation: language guess + pair served)
  assert.match(note, /const offerText = translationKey && !tState && !m\.status \? translatableText\(m\) : "";/);
  assert.match(note, /deps\.translation\.canOffer\(translationKey, offerText\)/);
  assert.match(note, /if \(!tState\) note\.append\(link\("Translate", \(\) => deps\.translation\.translate\(translationKey, offerText\)\)\);/);
  assert.match(rooms, /const translationKey = !mine && deps\.translation \? translationKeyFor\(m\) : null;/);
  // the translation calls are KaPost's
  assert.match(app, /translation: \{ canOffer: canOfferTextTranslation, state: textTranslationState,[^}]*translate: translateText/);
});

console.log(`chat bells, Chats gear, room Translate (K 8cb4c88e): ${passed} passed`);
