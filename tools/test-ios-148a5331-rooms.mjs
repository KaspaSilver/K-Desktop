// KaChat iOS 148a5331 (owner, 2026-11-21): public rooms are rows in the Chats list again, with the
// chats and groups; the Public Chats screen and its dock item are gone, and Edit Default Public
// Chats sits in the Chats New sheet. Desktop keeps its left dock (no Kaspa Hub).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RAIL_ORDER, PHONE_BAR, dockLayoutFor } from "../ui/dock-arrangement.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "..", "ui", "app.js"), "utf8");
const rooms = readFileSync(join(here, "..", "ui", "broadcasts.js"), "utf8");
const html = readFileSync(join(here, "..", "index.html"), "utf8");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

test("no Public Chats item in either dock", () => {
  assert.ok(!RAIL_ORDER.includes("broadcasts"));
  assert.ok(!PHONE_BAR.includes("broadcasts"));
  assert.deepEqual(PHONE_BAR, ["chats", "wallet", "profile", "settings", "hub"]);
  assert.ok(!dockLayoutFor(false).hub.includes("broadcasts"));
  assert.doesNotMatch(html, /data-app-tab="broadcasts"/);
  assert.doesNotMatch(html, /data-public-chats-settings/);
});

test("a saved spot or link for Public Chats opens Chats", () => {
  assert.match(app, /if \(tab === "broadcasts"\) tab = "chats";/);
  assert.doesNotMatch(app, /listShowsRooms/);
});

test("rooms sit in the one list; an unwritten room goes below every chat", () => {
  assert.match(app, /function visibleChatRooms\(\) \{\n  if \(isChildModeEnabled\(\)\) return \[\];/);
  assert.match(app, /visibleRooms\.map\(\(room, order\) => \(\{ at: room\.lastMessageAt \|\| -1, order,/);
});

test("a chat, a group and a room share Chats' pane", () => {
  assert.match(app, /if \(id && publicRoomOpen\) \{ try \{ closeBroadcastRoom\(\); \}/);
  assert.match(app, /if \(publicRoomOpen\) \{ try \{ closeBroadcastRoom\(\); \} catch \{ \/\* rooms not started \*\/ \} \}\n  markGroupOpened\(groupId\);/);
  assert.match(app, /onRoomVisibility: \(open\) => \{\n        publicRoomOpen = open;\n        if \(open\) \{\n          try \{ if \(activeGroupId\) closeGroupChat\(\); \}/);
});

test("the Chats badge counts rooms whose bell is on", () => {
  assert.match(rooms, /export function broadcastNotifyingUnreadTotal\(\) \{[\s\S]*?if \(notifyByChannel\[name\]\) total \+= unreadFor\(name\);/);
  assert.match(app, /rooms = broadcastNotifyingUnreadTotal\(\);/);
  assert.match(app, /for \(const tab of \["profile", "kaposts", "chats"\]\)/);
});

// K 8cb4c88e moved it again, out of the New sheet to a gear at the top left of Chats
// (tools/test-chat-bells-translate.mjs).
test("Edit Default Public Chats is the Chats gear, not a New sheet row", () => {
  assert.doesNotMatch(app, /id: "public-settings"/);
  assert.match(html, /data-chats-public-settings aria-label="Edit Default Public Chats"/);
  assert.match(rooms, /export function openPublicChatsSettings\(\)/);
});

console.log(`ios 148a5331 rooms: ${passed} passed`);
