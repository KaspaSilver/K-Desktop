// A message a sync reads back late (sent from another device, a catch-up after time away) goes into
// the thread at its time, not at the bottom until the next reload's sort.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addMessageToConversation, insertMessageByTime } from "../engine/conversations.js";

const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}
const ids = (conversation) => conversation.messages.map((m) => m.id).join(",");

test("an older message read back later lands at its time", () => {
  const chat = { messages: [{ id: "a", createdAt: 1000 }, { id: "c", createdAt: 3000 }], lastActivityAt: 3000 };
  addMessageToConversation(chat, { id: "b", createdAt: 2000 });
  assert.equal(ids(chat), "a,b,c");
  assert.equal(chat.lastActivityAt, 3000, "an older message doesn't move the chat's last activity back");
  addMessageToConversation(chat, { id: "first", createdAt: 500 });
  addMessageToConversation(chat, { id: "newest", createdAt: 4000 });
  assert.equal(ids(chat), "first,a,b,c,newest");
});

test("a batch from another device interleaves with what's already here, as a reload would sort it", () => {
  const chat = { messages: [] };
  for (const [id, at] of [["in1", 100], ["in2", 300], ["in3", 500]]) addMessageToConversation(chat, { id, createdAt: at });
  for (const [id, at] of [["out1", 200], ["out2", 400], ["out3", 600]]) addMessageToConversation(chat, { id, createdAt: at });
  assert.equal(ids(chat), "in1,out1,in2,out2,in3,out3");
  const resorted = [...chat.messages].sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  assert.equal(resorted.map((m) => m.id).join(","), ids(chat));
});

test("equal times keep arrival order; no time sorts first, like the reload sort", () => {
  const chat = { messages: [{ id: "x", createdAt: 1000 }] };
  insertMessageByTime(chat, { id: "y", createdAt: 1000 });
  insertMessageByTime(chat, { id: "none" });
  assert.equal(ids(chat), "none,x,y");
});

test("synced sent handshakes use the same insert", () => {
  assert.match(app, /insertMessageByTime\(conversationEntry, message\);/);
  assert.doesNotMatch(app, /note: "Handshake sent",\n\s*\}\);\n\s*conversationEntry\.messages\.push\(message\);/);
});

console.log(`message order: ${passed} passed`);
