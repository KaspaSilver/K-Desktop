// node tools/test-notification-recency.mjs - only something that just happened rings (K 961fc05a,
// owner 2026-11-25). Every banner or notification K posts itself checks the age of what it
// announces: chats, groups, rooms and dollar notices 3 minutes (InAppBanner.isRecent); KaPost 10
// minutes; Received KAS from the catch-up 3 minutes by block time; Received kUSDT 6 minutes by the
// coin's block time (TokenWallet.ringWindow). Anything older goes to the bell only, dated when it
// happened; "Balance increased" is always bell only. Also the catch-up's unaccepted block rewards
// (audit 2026-11-25 C1). app.js can't be loaded in node, so its wiring is read from the source.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  BANNER_MAX_AGE_MS, KAPOST_BANNER_MAX_AGE_MS, KUSDT_RING_WINDOW_MS, isRecentForBanner, bellTimestamp, timeMs,
} from "../ui/notification-recency.js";
import { catchUpCandidates, UNACCEPTED_HOLD_MS } from "../ui/address-activity.js";
import { transactionBelongsInHistory } from "../engine/sync.js";

const K = await import("../engine/kusdt.js");
const B = await import("../engine/kusdt-balances.js");
const S = await import("../engine/kusdt-store.js");
const C = await import("../engine/kachat-names/codec.js");

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const app = read("ui/app.js");
const kaposts = read("ui/kaposts.js");
const wallet = read("ui/kusdt-wallet.js");
const between = (source, start, end) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing ${end}`);
  return source.slice(from, to);
};

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

const NOW = Date.parse("2026-11-25T12:00:00Z");
const minutes = (n) => n * 60_000;

await test("the windows: 3 minutes for chats, groups, rooms, dollars and Received KAS; 10 for KaPost; 6 for kUSDT", () => {
  assert.equal(BANNER_MAX_AGE_MS, minutes(3));
  assert.equal(KAPOST_BANNER_MAX_AGE_MS, minutes(10));
  assert.equal(KUSDT_RING_WINDOW_MS, minutes(6));
  assert.equal(isRecentForBanner(NOW - minutes(3), { now: NOW }), true, "three minutes is still news");
  assert.equal(isRecentForBanner(NOW - minutes(3) - 1, { now: NOW }), false, "older is the bell's");
  assert.equal(isRecentForBanner(NOW - minutes(9), { now: NOW, maxAgeMs: KAPOST_BANNER_MAX_AGE_MS }), true);
  assert.equal(isRecentForBanner(NOW - minutes(11), { now: NOW, maxAgeMs: KAPOST_BANNER_MAX_AGE_MS }), false);
});

await test("an unknown time is now (not in a block yet); seconds and ms both read", () => {
  for (const unknown of [0, null, undefined, "", -5, Number.NaN]) assert.equal(isRecentForBanner(unknown, { now: NOW }), true, String(unknown));
  assert.equal(timeMs(1_764_072_000), 1_764_072_000_000, "seconds");
  assert.equal(timeMs(1_764_072_000_000), 1_764_072_000_000, "ms");
  assert.equal(isRecentForBanner((NOW - minutes(1)) / 1000, { now: NOW }), true, "a KaPost time in seconds");
  assert.equal(bellTimestamp(NOW - minutes(60), NOW), NOW - minutes(60), "the bell is dated when it happened");
  assert.equal(bellTimestamp(0, NOW), NOW, "unknown: now");
});

await test("1:1 chats, message requests and payment / dollar notices ring only within three minutes", () => {
  const body = between(app, "function maybeNotifyIncoming(", "/// \"Received a tip: 0.2 KAS\"");
  assert.match(body, /const recent = isRecentForBanner\(messageEventTime\(message\)\);/);
  // a request: not counted as rung when it isn't news, so its next (new) message still rings it
  const request = between(body, "if (isMessageRequest(conversationEntry)) {", "showAppNotification({");
  assert.ok(request.indexOf("if (!recent) return;") < request.indexOf("s.notified.add(key);"));
  assert.ok(request.indexOf("fileHiddenRequest(key)") < request.indexOf("if (!recent) return;"), "a hidden request is still filed");
  const tail = body.slice(body.indexOf("// Don't notify for the conversation you're already looking at") - 40);
  assert.match(tail, /if \(!recent\) return;/);
  // the time the gate reads: the block time, or none yet = now
  assert.match(between(app, "function messageEventTime(message) {", "\n}\n"), /return Number\(message\?\.createdAt \|\| 0\) \|\| Date\.now\(\);/);
});

await test("groups, group mentions and group invites ring only within three minutes; a mention stays in the bell", () => {
  const group = between(app, "function maybeNotifyGroupIncoming(", "// When an incoming group message @mentions you");
  assert.ok(group.indexOf("if (!isRecentForBanner(createdAt)) return;") < group.indexOf("postDesktopNotification({"));
  const mention = between(app, "function maybeRecordGroupMention(", "/// Are these two rows the same message?");
  assert.ok(mention.indexOf("recordGlobalNotification({") < mention.indexOf("!isRecentForBanner(createdAt)"), "the bell first, whatever its age");
  assert.match(mention, /if \(!groupOsPingAllowed\(groupId\) \|\| !isRecentForBanner\(createdAt\)\) return;/);
  assert.match(app, /if \(isNews && isRecentForBanner\(evMs\)\) notifyGroupInvite\(ev\);/);
});

await test("public rooms keep their three-minute rule", () => {
  const rooms = read("ui/broadcasts.js");
  assert.match(rooms, /const ROOM_BANNER_MAX_AGE_MS = 3 \* 60_000;/);
  assert.match(rooms, /&& Date\.now\(\) - Number\(row\.blockTime \|\| 0\) <= ROOM_BANNER_MAX_AGE_MS/);
});

await test("KaPost activity rings only within ten minutes; the bell lists it dated when it happened", () => {
  const poll = between(kaposts, "async function pollKaPostNotificationsForPings(", "// The same person, post and kind rings once in 15 minutes");
  assert.match(poll, /if \(!isRecentForBanner\(n\.timestamp, \{ maxAgeMs: KAPOST_BANNER_MAX_AGE_MS \}\)\) continue;/);
  assert.ok(poll.indexOf("isRecentForBanner(n.timestamp") < poll.indexOf("claimKaPostsBanner("), "an old one doesn't use up its banner claim");
  assert.match(poll, /timestamp: bellTimestamp\(n\.timestamp\),/);
});

await test("Received KAS from the catch-up rings within three minutes of its block time; older is the bell's, dated then", () => {
  const body = between(app, "async function attributeAndNotifyAddressActivity(", "// Where a tapped address-activity notification goes");
  assert.match(body, /const happenedAt = txBlockTimeMs\(tx\);\n\s*if \(isRecentForBanner\(happenedAt\)\) postDesktopNotification\(\{/);
  assert.match(body, /timestamp: bellTimestamp\(happenedAt\),/);
  // "Balance increased": the bell only, never a banner
  const fallback = body.slice(body.indexOf("if (!attributed && mayFallBack) {"));
  assert.ok(!fallback.includes("postDesktopNotification("), "Balance increased never rings");
  assert.match(fallback, /recordGlobalNotification\(\{\n\s*id: `wallet-bal-/);
  assert.match(body, /catchUpCandidates\(recentTxs, loadActivityFloor\(address\), \{ chatting: isChatting, belongsInHistory: transactionBelongsInHistory \}\)/);
});

await test("the catch-up skips block rewards the network didn't accept, and its floor waits below a recent one (audit C1)", () => {
  const COINBASE = "0100000000000000000000000000000000000000";
  const NATIVE = "0000000000000000000000000000000000000000";
  const reward = (time, accepted) => ({ transaction_id: `r${time}`, subnetwork_id: COINBASE, block_time: time, is_accepted: accepted, payload: "" });
  const pay = (time) => ({ transaction_id: `p${time}`, subnetwork_id: NATIVE, inputs: [{}], block_time: time, is_accepted: false, payload: "" });
  const opts = { belongsInHistory: transactionBelongsInHistory, now: NOW };
  const floor = NOW - minutes(30);
  const look = catchUpCandidates([reward(NOW - minutes(2), false), reward(NOW - minutes(2) + 1, true), pay(NOW - minutes(1))], floor, opts);
  assert.deepEqual(look.candidates.map((tx) => tx.transaction_id), [`p${NOW - minutes(1)}`, `r${NOW - minutes(2) + 1}`], "the accepted reward and an unaccepted payment count; the unaccepted reward doesn't");
  assert.equal(look.nextFloor, NOW - minutes(2) - 1, "held just below the reward that may still be accepted");
  // a reward older than ten minutes won't be: the floor moves past it
  const old = catchUpCandidates([reward(NOW - UNACCEPTED_HOLD_MS - 1, false), pay(NOW - minutes(1))], floor, opts);
  assert.equal(old.nextFloor, NOW - minutes(1));
  // never below the floor already stored
  assert.equal(catchUpCandidates([reward(floor - 5, false)], floor, opts).nextFloor, floor);
  // without the predicate every transaction counts, as before
  assert.equal(catchUpCandidates([reward(NOW - minutes(2), false)], floor, { now: NOW }).candidates.length, 1);
});

await test("Received kUSDT rings when a coin came within six minutes by its block time; else the bell, dated then", async () => {
  assert.deepEqual(B.receivedRing([{ at: NOW - minutes(5) }], { windowMs: KUSDT_RING_WINDOW_MS, now: NOW }), { ring: true, happenedAtMs: NOW - minutes(5) });
  assert.deepEqual(B.receivedRing([{ at: NOW - minutes(7) }, { at: NOW - minutes(60) }], { windowMs: KUSDT_RING_WINDOW_MS, now: NOW }), { ring: false, happenedAtMs: NOW - minutes(7) }, "the bell, dated when the newest came");
  assert.deepEqual(B.receivedRing([{ at: null }], { windowMs: KUSDT_RING_WINDOW_MS, now: NOW }), { ring: true, happenedAtMs: null }, "unknown: now");
  // findReceived carries each coin's block time and dates its history row by it
  const net = "testnet-10";
  const key = schnorr.getPublicKey(C.unhex("01".repeat(32)));
  const addr = K.addressOfOwner(key, net);
  const txid = (n) => n.toString(16).padStart(2, "0").repeat(32);
  const coinOf = (n, units) => ({ transactionId: txid(n), index: 0, state: K.plainState(key, units), kasSompi: 150_000_000n, blockDaaScore: 1n });
  const m = new Map();
  const store = S.createKusdtStore({ storage: { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } }, account: "kaspa:acct" });
  await B.findReceived({ store, current: [{ holdingId: "chatting", coins: [coinOf(1, 5n)] }] });
  const came = NOW - minutes(45);
  const found = await B.findReceived({
    store, now: NOW, current: [{ holdingId: "chatting", coins: [coinOf(1, 5n), coinOf(2, 7n)] }], previous: [coinOf(1, 5n)],
    fetchTransactionInputs: async () => ({ inputs: [{ hash: txid(50), index: 0, address: "kaspatest:someoneelse" }], blockTimeMs: came }),
    ownAddresses: [addr],
  });
  assert.deepEqual(found.received.map((r) => [r.units, r.at]), [[7n, came]]);
  assert.equal(store.activity()[0].date, came, "the history row is dated when it came, not when it was found");
  assert.deepEqual(B.transactionLookup([{ hash: "a" }]), { inputs: [{ hash: "a" }], at: null }, "a plain inputs list still reads");
  // the wallet hands ring and the date to the app, which rings only then and dates the bell
  assert.match(wallet, /const \{ ring, happenedAtMs \} = receivedRing\(announced, \{ windowMs: deps\.ringWindowMs \?\? KUSDT_RING_WINDOW_MS, now: now\(\) \}\);/);
  const notify = between(app, "notify: ({ title, body, ring = true, happenedAtMs = null }) => {", "ringWindowMs: KUSDT_RING_WINDOW_MS,");
  assert.match(notify, /if \(ring\) postDesktopNotification\(\{/);
  assert.match(notify, /timestamp: bellTimestamp\(happenedAtMs, stamp\)/);
  assert.match(between(app, "async function kusdtTransactionInputs(txid) {", "\n}\n"), /const blockTimeMs = txBlockTimeMs\(tx\) \|\| null;/);
});

console.log(`notification recency: ${passed} passed`);
