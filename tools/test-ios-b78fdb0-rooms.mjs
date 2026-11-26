// node tools/test-ios-b78fdb0-rooms.mjs - KaPost iOS b78fdb0, Public Chats (Build 301): answers that
// land after an account change are dropped and no sweep runs signed out, a voice note's later parts
// stay retryable after one fails, one delivered copy settles one leftover row, and a push rings or
// opens only a joined room with its bell on.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const rooms = read("ui/broadcasts.js");

let failures = 0;
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.log(`FAIL - ${name}\n`, error); }
}

await test("an account change drops room answers still on their way; no sweep while signed out", () => {
  assert.match(rooms, /export function resetBroadcastsForAccount\(\) \{\n[^\n]*\n\s+roomAccountGeneration \+= 1;/);
  // the newest page and the failure in backfillChannel; each page in pageBackHistory (Build 312)
  assert.equal((rooms.match(/if \(generation !== roomAccountGeneration\) return 0;/g) || []).length, 2, "backfill: poll, failure");
  assert.match(rooms, /if \(generation !== roomAccountGeneration\) return \{ added: 0, stale: true \};/);
  assert.match(rooms, /!deps\.engine\?\.address \|\| !hasBroadcastIndexer\(\)\) return;/);
  assert.equal((rooms.match(/if \(generation !== roomAccountGeneration\) return;/g) || []).length, 3, "sweep: per room and after its fetch; the Rooms list check after its fetch (K d089011f)");
});
await test("a voice note's later parts are Failed, saved and free for Retry", () => {
  assert.match(rooms, /for \(const id of later\) pendingSendsThisRun\.delete\(id\);\n\s+saveCache\(\);/);
});
await test("one delivered copy settles one leftover row", async () => {
  const { settleLeftoverRoomRows } = await import("../ui/leftover-sends.js");
  const me = "kaspa:qme";
  const rows = [
    { txId: "pending-1-a", senderAddress: me, content: "hi", blockTime: 1000, status: "pending" },
    { txId: "pending-2-b", senderAddress: me, content: "hi", blockTime: 1001, status: "pending" },
    { txId: "a".repeat(64), senderAddress: me, content: "hi", blockTime: 1500 },
  ];
  settleLeftoverRoomRows(rows);
  assert.equal(rows.length, 2, "one leftover went with the copy");
  assert.equal(rows.filter((r) => r.status === "unconfirmed" || r.status === "pending").length, 1, "the other is Not confirmed");
});
await test("a push opens only a joined room, and rings only for one with its bell on", () => {
  assert.match(rooms, /if \(!joinedChannels\.includes\(clean\)\) return;\n\s+openRoom\(clean\);/);
  // (a push that @'s you by username passes the bell, K bdf29425: tools/test-k-mentions.mjs)
  assert.match(read("public/sw-push.js"), /if \(Array\.isArray\(m\.rooms\) && !m\.rooms\.includes\(channel\) && !mentionsYou\) out\.suppress = true;/);
  assert.match(read("ui/app.js"), /try \{ rooms = broadcastPushWatch\(\)\.channels; \} catch \{ rooms = null; \}/);
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log(`ios b78fdb0 rooms: ${passed} passed`);
