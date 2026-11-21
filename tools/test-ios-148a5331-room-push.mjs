// KaChat iOS 148a5331 NotificationService: a room push's body is the raw on-chain message, so the
// worker reads it the way iOS's publicChatPreviewText does, and an edit rings nothing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const sandbox = { atob, TextDecoder, Uint8Array };
sandbox.globalThis = sandbox;
vm.runInNewContext(readFileSync(new URL("../public/sw-push.js", import.meta.url), "utf8"), sandbox);
const { notificationFromPush } = sandbox.KaChatPushMap;
const mirror = { account: "kaspa:qpme", unit: "KAS", sound: true, names: {}, rooms: ["kaspa"] };
const room = (body) => notificationFromPush({ type: "broadcast", channel: "kaspa", tx_id: "t1", subtitle: "alice", body }, mirror);
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

test("plain text, with or without the on-chain prefix", () => {
  assert.equal(room("gm everyone").options.body, "alice: gm everyone");
  assert.equal(room("kchat:1:bcast:kaspa:gm everyone").options.body, "alice: gm everyone");
});
test("a lone base64 run is decoded", () => {
  assert.equal(room(b64("hello from a reply")).options.body, "alice: hello from a reply");
});
test("reactions, chess, replies", () => {
  assert.equal(room(JSON.stringify({ type: "reaction", emoji: "🔥", targetTxId: "x" })).options.body, "alice: Reacted 🔥 to a message");
  assert.equal(room(JSON.stringify({ type: "reaction", emoji: "🔥", action: "remove", targetTxId: "x" })).options.body, "alice: Removed their 🔥 reaction");
  assert.equal(room(JSON.stringify({ type: "reply", text: "agreed", replyTo: "x" })).options.body, "alice: agreed");
  assert.equal(room('{"type":"reply","replyTo":"abcdef0123456789","sender":"kaspa:qq').options.body, "alice: Replied to a message");
  assert.equal(room('{"type":"reply","replyTo":"ab","text":"cut off he').options.body, "alice: cut off he");
});
test("voice, photo, video, never raw JSON", () => {
  assert.equal(room('{"mimeType":"audio/ogg","data":"AAAA').options.body, "alice: Voice message");
  assert.equal(room('{"mimeType":"image/jpeg","data":"AAAA').options.body, "alice: Photo");
  assert.equal(room('{"mimeType":"video/mp4","data":"AAAA').options.body, "alice: Video");
  assert.equal(room('{"weird":1}').options.body, "alice: New message");
});
test("an edit is delivered silently", () => {
  assert.equal(room(JSON.stringify({ type: "edit", targetTxId: "x", text: "fixed" })).suppress, true);
  assert.equal(room('{"type":"edit","targetTxId":"abc","te').suppress, true);
  assert.notEqual(room("plain").suppress, true);
});

console.log(`ios 148a5331 room push: ${passed} passed`);
