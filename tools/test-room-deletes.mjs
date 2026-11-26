// K e4062188: a room message's sender deletes it for everyone ({"type":"delete","targetTxId":...}),
// and cached room messages the app-wide indexer no longer serves are dropped, with K's safeguards.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  encodeRoomDelete, parseRoomDelete, roomDeleteEntry, addRoomDelete, resolveRoomDeletes, rowsTheIndexerNoLongerHas,
  roomDeleteLookupSet, roomDeleteLookupKey, ROOM_DELETES_MAX, ROOM_DELETES_UNHELD_MAX,
} from "../engine/room-deletes.js";

const rooms = readFileSync(new URL("../ui/broadcasts.js", import.meta.url), "utf8");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}
const tx = (n) => n.toString(16).padStart(64, "0");

test("the envelope reads and writes as K's MessageDeleteCodec", () => {
  assert.equal(encodeRoomDelete(tx(1)), `{"type":"delete","targetTxId":"${tx(1)}"}`);
  assert.deepEqual(parseRoomDelete(` {"type":"delete","targetTxId":"${tx(1)}"} `), { targetTxId: tx(1) });
  assert.equal(parseRoomDelete('{"type":"edit","targetTxId":"x","text":"delete"}'), null);
  assert.equal(parseRoomDelete('{"type":"delete","targetTxId":""}'), null);
  assert.equal(parseRoomDelete("delete it"), null);
  assert.equal(parseRoomDelete(`{"type":"delete","targetTxId":"${"a".repeat(2000)}"}`), null);
});

test("remembered as room|txid|sender, lowercased, newest 2,000", () => {
  assert.equal(roomDeleteEntry("kaspa", "ABC", "kaspa:QQ"), "kaspa|abc|kaspa:qq");
  const once = addRoomDelete([], "kaspa", "a", "s");
  assert.deepEqual(once, ["kaspa|a|s"]);
  assert.equal(addRoomDelete(once, "kaspa", "A", "S"), null);
  const capped = addRoomDelete(["x|1|s", "x|2|s", "x|3|s"], "x", "4", "s", 3);
  assert.deepEqual(capped, ["x|2|s", "x|3|s", "x|4|s"]);
});

test("a delete counts only from the target's own sender", () => {
  const held = { [tx(1)]: "kaspa:alice", [tx(2)]: "kaspa:bob" };
  const senderOf = (id) => held[id] ?? null;
  const { gone, record } = resolveRoomDeletes([
    { target: tx(1), sender: "kaspa:alice" }, // hers: goes, remembered
    { target: tx(2), sender: "kaspa:alice" }, // bob's: nothing, not remembered
    { target: tx(3), sender: "kaspa:carol" }, // not here yet: remembered for that sender
  ], senderOf);
  assert.deepEqual([...gone], [tx(1)]);
  // `held` picks the budget it is kept on (audit 2026-11-25 #26)
  assert.deepEqual(record, [{ target: tx(1), sender: "kaspa:alice", held: true }, { target: tx(3), sender: "kaspa:carol", held: false }]);
});

test("deletes for targets not held have a budget of their own (audit 2026-11-25 #26)", () => {
  // a flood of unheld deletes never pushes a held one out
  let list = addRoomDelete([], "kaspa", "real", "s");
  for (let i = 0; i < 50; i += 1) list = addRoomDelete(list, "kaspa", `junk${i}`, "x", 3, { held: false, unheldMax: 5 });
  assert.ok(list.includes("kaspa|real|s"), "the held delete stays");
  assert.equal(list.filter((e) => e.startsWith("?")).length, 5, "only the newest 5 unheld kept");
  assert.ok(list.includes("?kaspa|junk49|x") && !list.includes("?kaspa|junk0|x"));
  // the held budget trims only held ones
  const held = addRoomDelete(["?x|u|s", "x|1|s", "x|2|s", "x|3|s"], "x", "4", "s", 3);
  assert.deepEqual(held, ["?x|u|s", "x|2|s", "x|3|s", "x|4|s"]);
  // an unheld delete met again with its target held moves to the held budget; never stored twice
  assert.deepEqual(addRoomDelete(["?x|t|s"], "x", "T", "S"), ["x|t|s"]);
  assert.equal(addRoomDelete(["?x|t|s"], "x", "t", "s", undefined, { held: false }), null);
  assert.equal(addRoomDelete(["x|t|s"], "x", "t", "s", undefined, { held: false }), null);
  // lookups see both kinds; lists stored before the mark read as held
  assert.deepEqual([...roomDeleteLookupSet(["?x|t|s", "x|u|s"])], ["x|t|s", "x|u|s"]);
  assert.equal(roomDeleteLookupKey("x|u|s"), "x|u|s");
  assert.equal(ROOM_DELETES_UNHELD_MAX, 500);
  assert.equal(ROOM_DELETES_MAX, 2000);
  // the rooms module records with the budget and looks up through the set
  assert.match(rooms, /for \(const \{ target, sender, held \} of record\) recordRoomDelete\(channel, target, sender, held !== false\);/);
  assert.match(rooms, /roomDeleteSet = roomDeleteLookupSet\(roomDeletes\);/);
  assert.match(rooms, /roomDeleteSet = roomDeleteLookupSet\(next\);/);
});

const DAY = 86_400_000;
const now = 100 * DAY;
const retentionMs = 30 * DAY;
const row = (n, t, sender = "kaspa:alice", extra = {}) => ({ txId: tx(n), blockTime: t, senderAddress: sender, ...extra });
function check(page, held, strikes, opts = {}) {
  return rowsTheIndexerNoLongerHas({ channel: "kaspa", page, held, me: "kaspa:me", now, retentionMs, strikes, ...opts });
}

test("a row missing from the page's span goes on its second miss", () => {
  const t0 = now - 2 * 3600_000;
  const page = [row(1, t0), row(3, t0 + 20 * 60_000)];
  const held = [row(1, t0), row(2, t0 + 10 * 60_000), row(3, t0 + 20 * 60_000)];
  const strikes = new Map();
  assert.deepEqual(check(page, held, strikes).gone, []);
  assert.deepEqual(check(page, held, strikes).gone, [tx(2)]);
  assert.equal(strikes.size, 0);
});

test("back on a later page clears its strike", () => {
  const t0 = now - 2 * 3600_000;
  const held = [row(1, t0), row(2, t0 + 10 * 60_000), row(3, t0 + 20 * 60_000)];
  const strikes = new Map();
  check([row(1, t0), row(3, t0 + 20 * 60_000)], held, strikes);
  check(held, held, strikes);
  assert.deepEqual(check([row(1, t0), row(3, t0 + 20 * 60_000)], held, strikes).gone, []);
});

test("never below the oldest row, a minute inside the edges, not the newest 3 minutes or the oldest day", () => {
  const t0 = now - 2 * 3600_000;
  const page = [row(1, t0), row(3, t0 + 20 * 60_000)];
  const strikes = new Map();
  const held = [
    row(10, t0 - 60_000),          // below the page
    row(11, t0 + 30_000),          // inside the lower minute
    row(12, t0 + 20 * 60_000 - 1), // inside the upper minute
  ];
  check(page, held, strikes);
  assert.deepEqual(check(page, held, strikes).gone, []);
  // the newest 3 minutes
  const fresh = [row(1, now - 10 * 60_000), row(3, now)];
  check(fresh, [row(20, now - 2 * 60_000)], strikes);
  assert.deepEqual(check(fresh, [row(20, now - 2 * 60_000)], strikes).gone, []);
  // the oldest day of the 30
  const old = [row(1, now - 30 * DAY + 1000), row(3, now - 28 * DAY)];
  check(old, [row(21, now - 29.5 * DAY)], strikes);
  assert.deepEqual(check(old, [row(21, now - 29.5 * DAY)], strikes).gone, []);
});

test("never your own messages or an unsettled send, never an empty page", () => {
  const t0 = now - 2 * 3600_000;
  const page = [row(1, t0), row(3, t0 + 20 * 60_000)];
  const held = [row(4, t0 + 5 * 60_000, "kaspa:me"), row(5, t0 + 6 * 60_000, "kaspa:alice", { status: "not-confirmed" }), { txId: "pending-1", blockTime: t0 + 7 * 60_000, senderAddress: "kaspa:alice" }];
  const strikes = new Map();
  check(page, held, strikes);
  assert.deepEqual(check(page, held, strikes).gone, []);
  assert.deepEqual(check([], [row(6, t0)], strikes).gone, []);
});

test("never any local account's messages, nor a sent row still on this device's clock (audit 2026-11-25 #25)", () => {
  const t0 = now - 2 * 3600_000;
  const page = [row(1, t0), row(3, t0 + 20 * 60_000)];
  const held = [row(4, t0 + 5 * 60_000, "kaspa:other"), row(5, t0 + 6 * 60_000, "kaspa:alice", { localTime: true }), row(6, t0 + 7 * 60_000, "kaspa:bob")];
  const strikes = new Map();
  const opts = { me: ["kaspa:me", "KASPA:OTHER"] };
  check(page, held, strikes, opts);
  assert.deepEqual(check(page, held, strikes, opts).gone, [tx(6)], "only bob's row goes");
  // the rooms module passes every saved account, and app.js hands them over
  assert.match(rooms, /me: \[deps\.engine\?\.address \|\| "", \.\.\.mine\]/);
  const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
  assert.match(app, /localAccountAddresses: \(\) => \{ try \{ return loadSavedAccounts\(\)\.map\(\(entry\) => entry\?\.address\)\.filter\(Boolean\); \} catch \{ return \[\]; \} \},/);
  // a sent row keeps localTime until its copy brings the chain's time
  assert.match(rooms, /\{ \.\.\.m, txId: txid, status: undefined, localTime: true \}/);
});

test("an older-history page answers up to its `before`", () => {
  const t0 = now - 5 * 3600_000;
  const page = [row(1, t0), row(3, t0 + 10 * 60_000)];
  const held = [row(1, t0), row(3, t0 + 10 * 60_000), row(7, t0 + 30 * 60_000)];
  const strikes = new Map();
  check(page, held, strikes, { before: t0 + 60 * 60_000 });
  assert.deepEqual(check(page, held, strikes, { before: t0 + 60 * 60_000 }).gone, [tx(7)]);
});

test("more than a handful missing at once removes nothing", () => {
  const t0 = now - 3 * 3600_000;
  const page = [row(1, t0), row(2, t0 + 100 * 60_000)];
  const held = [...page, ...Array.from({ length: 10 }, (_, i) => row(100 + i, t0 + (10 + i) * 60_000))];
  const strikes = new Map();
  check(page, held, strikes);
  const second = check(page, held, strikes);
  assert.deepEqual(second.gone, []);
  assert.deepEqual(second.refused, { gone: 10, considered: 10 }); // the page's own edge rows sit in the margins
  // up to 3 always may go
  const few = [...page, ...Array.from({ length: 3 }, (_, i) => row(200 + i, t0 + (10 + i) * 60_000))];
  const s2 = new Map();
  check(page, few, s2);
  assert.equal(check(page, few, s2).gone.length, 3);
});

test("the rooms module applies deletes on every read path and blocks deleted rows", () => {
  assert.match(rooms, /const deletion = parseRoomDelete\(row\.content\);\n\s*if \(deletion && !deletesTrusted\) \{ unprovenDeletes\.push\(row\); continue; \}\n\s*if \(deletion\) \{\n\s*applied\.add\(row\.txId\);\n\s*removed \+= applyRoomDeletes\(/);
  assert.match(rooms, /if \(isRoomDeleted\(channel, row\.txId, row\.senderAddress\)\) \{ applied\.add\(row\.txId\); continue; \}/);
  // never in the machinery rooms
  assert.match(rooms, /function applyRoomDeletes\(channel, deletes, senderOf = null\) \{\n\s*if \(!deletes\?\.length \|\| isServiceBroadcastChannel\(channel\)\) return 0;/);
  // reactions and edits go with the message
  const remove = rooms.slice(rooms.indexOf("function removeRoomRows("), rooms.indexOf("function applyRoomDeletes("));
  assert.match(remove, /reactionsCache\[channel\]\?\.byTarget/);
  assert.match(remove, /editsCache\[channel\]/);
  // older caches that stored a delete as text
  assert.match(rooms, /migrateCachedReactionRows\(\);\n\s*migrateCachedDeleteRows\(\);/);
});

test("deletes count at once only from the block stream or the app-wide indexer (audit 2026-11-25 #22)", () => {
  assert.match(rooms, /function mergeMessages\(channel, rows, \{ live = false \} = \{\}\) \{\n\s*const deletesTrusted = live \|\| !indexerOverrideFor\(channel\);/);
  assert.match(rooms, /mergeMessages\(channel, rows, \{ live: true \}\)/, "block-stream hits are trusted");
  assert.match(rooms, /if \(unprovenDeletes\.length\) proveRoomDeletes\(channel, unprovenDeletes\);/);
  const prove = rooms.slice(rooms.indexOf("async function proveRoomDeletes("), rooms.indexOf("// Channels that already did the full historical page-back"));
  assert.ok(prove.length > 100);
  assert.match(prove, /await deps\.engine\.verifyBroadcastRows\(ask, \{ channel \}\)/, "a room's own indexer's deletes are proved on chain first");
  assert.match(prove, /const deletion = parseRoomDelete\(row\.content\);/, "the chain's text decides");
  assert.match(prove, /for \(const row of forged\) applied\.add\(row\.txId\);/, "forged ones are only set aside");
  assert.match(prove, /applyRoomDeletes\(channel, deletes\)/);
});

test("indexer removals: newest page, older pages and the closed-room sweep; app-wide indexer only", () => {
  assert.match(rooms, /added = mergeMessages\(channel, result\.messages\);\n\s*added \+= dropRowsTheIndexerNoLongerHas\(channel, result\.messages\);/);
  assert.match(rooms, /added \+= mergeMessages\(channel, result\.messages\);\n\s*added \+= dropRowsTheIndexerNoLongerHas\(channel, result\.messages, before\);/);
  assert.match(rooms, /mergeMessages\(name, result\.messages\) \+ dropRowsTheIndexerNoLongerHas\(name, result\.messages\)/);
  assert.match(rooms, /if \(indexerOverrideFor\(channel\) \|\| !isIndexerTrackedBroadcastChannel\(channel\) \|\| isServiceBroadcastChannel\(channel\)\) return 0;/);
});

test("Delete for Everyone: own delivered non-voice messages, K's words, gone only once sent", () => {
  assert.match(rooms, /label: "Delete for Everyone", hint: "Removes it from this room for everyone using K\.", icon: icons\.trash, danger: true/);
  assert.match(rooms, /if \(mine && !pending && !deps\.parseAudioEnvelope\?\.\(m\.content\) && !roomParts\.clusters\.get\(m\.txId\)/);
  assert.ok(rooms.includes('title: "Delete for Everyone?"'));
  assert.ok(rooms.includes("It goes from this room for everyone using K. It stays on the Kaspa network, where anyone reading the chain can still find it. Deleting costs a small network fee."));
  const fn = rooms.slice(rooms.indexOf("async function deleteBroadcastMessageForEveryone("), rooms.indexOf("/** Human text for previews"));
  const send = fn.indexOf("await sendBroadcastText(channel, encodeRoomDelete(m.txId), { showBubble: false });");
  assert.ok(send > 0);
  assert.ok(fn.indexOf("recordRoomDelete(channel, m.txId, me);") > send, "remembered only after the send");
  assert.ok(fn.indexOf("removeRoomRows(") > send, "removed only after the send");
  assert.match(fn, /if \(error\?\.code !== SEND_OUTCOME_UNKNOWN\) deps\.showToast\?\.\("Couldn't delete the message\. Try again\."\);\n\s*return false;/);
});

test("the push worker rings nothing for a delete", () => {
  const sandbox = { atob, TextDecoder, Uint8Array };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(new URL("../public/sw-push.js", import.meta.url), "utf8"), sandbox);
  const { notificationFromPush } = sandbox.KaChatPushMap;
  const mirror = { account: "kaspa:qpme", unit: "KAS", sound: true, names: {}, rooms: ["kaspa"] };
  const room = (body) => notificationFromPush({ type: "broadcast", channel: "kaspa", tx_id: "t1", subtitle: "alice", body }, mirror);
  assert.equal(room(encodeRoomDelete(tx(1))).suppress, true);
  assert.equal(room('{ "type": "delete", "targetTxId": "ab').suppress, true);
  assert.notEqual(room("please delete this").suppress, true);
});

console.log(`room deletes: ${passed} passed`);
