// Group messages live in IndexedDB with the 1:1 chats (2026-11-25, reports of group messages
// disappearing): they were one localStorage value - photos and voice notes inline - and a save
// past the ~5MB quota failed silently, so everything since was gone after a reload.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

test("the group messages key is moved into the chat storage at startup", () => {
  assert.match(app, /const CHAT_STORAGE_GLOBAL_KEYS = \["kachat-group-messages-v1"\];/);
  assert.match(app, /if \(CHAT_STORAGE_GLOBAL_KEYS\.includes\(key\)\) return true;/);
  assert.match(app, /const GROUP_MSG_KEY = "kachat-group-messages-v1";/);
  assert.ok(app.indexOf("CHAT_STORAGE_GLOBAL_KEYS") < app.indexOf("await initChatStorage("), "declared before the migration runs");
});

test("reads and writes go through the chat storage, a failed save is logged", () => {
  assert.match(app, /groupMsgAllCache = JSON\.parse\(chatStorageGetSync\(GROUP_MSG_KEY\) \|\| "\{\}"\)/);
  assert.match(app, /chatStorageSetSync\(GROUP_MSG_KEY, JSON\.stringify\(groupMsgAllCache\)\);/);
  assert.match(app, /appendEngineLog\(`Group messages could not be saved: /);
  assert.doesNotMatch(app, /localStorage\.(get|set)Item\(GROUP_MSG_KEY/);
});

test("hiding the app writes pending group messages straight away", () => {
  assert.match(app, /flushGroupMsgAll\(\); try \{ flushChatStorage\(\); \} catch \{\}/);
});

test("removing an account clears its group messages from the chat storage", () => {
  assert.match(app, /const inChatStorage = key === GROUP_MSG_KEY;/);
  assert.match(app, /if \(inChatStorage\) chatStorageSetSync\(key, JSON\.stringify\(all\)\);/);
});

console.log(`group messages storage: ${passed} passed`);
