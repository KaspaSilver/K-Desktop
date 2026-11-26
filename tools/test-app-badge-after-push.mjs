// K 4b8e78b3: the app icon's badge. Pushes put their own number on it while the app is away, so
// what the page last set is forgotten when it comes back to the front and the next count is always
// set (a room read in the app left "1" on the icon); a bell-on room's push counts on the icon from
// the same count as a chat's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

const set = [];
Object.defineProperty(globalThis, "navigator", {
  value: { setAppBadge: async (n) => { set.push(n); }, clearAppBadge: async () => { set.push(0); } },
  configurable: true,
});
const { setAppIconBadge, forgetAppliedAppIconBadge } = await import("../ui/web-push.js");

await test("the same number isn't set twice, until the app comes back to the front", async () => {
  await setAppIconBadge(1);
  await setAppIconBadge(1);
  assert.deepEqual(set, [1], "skipped while nothing else could have changed it");
  // a room push put 2 on the icon while away; the room is read and the count is 1 again
  forgetAppliedAppIconBadge();
  await setAppIconBadge(1);
  assert.deepEqual(set, [1, 1], "set again after coming back");
  forgetAppliedAppIconBadge();
  await setAppIconBadge(0);
  assert.deepEqual(set, [1, 1, 0], "cleared");
});

await test("app.js forgets it and recounts whenever the page becomes visible", () => {
  const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
  assert.match(app, /document\.addEventListener\("visibilitychange", \(\) => \{\n\s*if \(document\.visibilityState !== "visible"\) return;\n\s*forgetAppliedAppIconBadge\(\);\n\s*scheduleAppBadgeUpdate\(\);\n\s*\}\);/);
});

await test("a bell-on room's push counts on the icon; a muted one, an edit or a mention from a bell-off room doesn't", () => {
  const sandbox = { atob, TextDecoder, Uint8Array };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(new URL("../public/sw-push.js", import.meta.url), "utf8"), sandbox);
  const { notificationFromPush } = sandbox.KaChatPushMap;
  const mirror = { account: "kaspa:qpme", unit: "KAS", sound: true, names: {}, rooms: ["kaspa"] };
  const push = (channel, body = "gm", extra = {}) => notificationFromPush({ type: "broadcast", channel, tx_id: "t1", subtitle: "alice", body, ...extra }, mirror);
  assert.equal(push("kaspa").badge, "increment");
  assert.equal(push("other").badge, null, "a room whose bell is off is suppressed");
  assert.equal(push("other", "hi @me", { mention: "true" }).badge, null, "a mention from a bell-off room rings but the app doesn't count that room");
  assert.equal(push("kaspa", JSON.stringify({ type: "edit", targetTxId: "a".repeat(64), text: "x" })).badge, null);
});

console.log(`app badge after a push: ${passed} passed`);
