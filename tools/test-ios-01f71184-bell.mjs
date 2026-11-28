// K 01f71184 (AUDIT_RELEASE_2026-11-27), the bell's part: Received Kaspa and kUSDT always go in
// Profile's bell (the switches decide only the ping), every own address has a catch-up floor and a
// quiet one's first look only sets it (R2), the catch-up reads 3 transactions (B6), unsent payment
// notices keep the ones whose contact isn't loaded (R4), a spending-address payment whose send got
// no answer sends its notice when it settles (C5), and REST output sums past u64 skip the
// transaction (R6). Plain node, run from the repo root:
//
//   node tools/test-ios-01f71184-bell.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { catchUpLook, CATCH_UP_TX_COUNT, outputsSompiTo } from "../ui/address-activity.js";
import { checkedSompiSum, MAX_U64 } from "../engine/amounts.js";
import { createOwedSpendingNotices, OWED_NOTICE_KEEP_MS } from "../ui/owed-spending-notices.js";
import { sompiPaidToAddress } from "../engine/payment-notice.js";
import { restPaymentSompiTo } from "../engine/sync.js";
import * as W from "../ui/kusdt-wallet.js";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const app = read("ui/app.js");
const between = (start, end) => {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `markers found: ${start}`);
  return app.slice(from, to);
};
const build = (source, env, exportsList) => {
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${source}\nreturn ${exportsList};`)(...names.map((n) => env[n]));
};

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

const NOW = 1_800_000_000_000;
const tx = (id, time, extra = {}) => ({ transaction_id: id, block_time: time, payload: "", ...extra });

await test("R2: a quiet address's (or the chatting address's) first look only sets its floor", () => {
  const txs = [tx("a", NOW - 60_000), tx("b", NOW - 90 * 86_400_000)];
  for (const opts of [{ rings: false }, { chatting: true, rings: true }, { chatting: true, rings: false }]) {
    const look = catchUpLook(txs, 0, { ...opts, now: NOW });
    assert.equal(look.firstLookOnly, true, JSON.stringify(opts));
    assert.deepEqual(look.candidates, [], "no old receive is ever filed");
    assert.equal(look.floorToSave, NOW - 60_000, "the newest fetched block time");
  }
  // an empty answer on a first look sets the floor to now
  assert.equal(catchUpLook([], 0, { rings: false, now: NOW }).floorToSave, NOW);
});

await test("R2: a ringing address's first look counts as before; a stored floor filters older receives", () => {
  const txs = [tx("a", NOW - 60_000), tx("b", NOW - 600_000)];
  const ringing = catchUpLook(txs, 0, { rings: true, now: NOW });
  assert.equal(ringing.firstLookOnly, false);
  assert.deepEqual(ringing.candidates.map((t) => t.transaction_id), ["a", "b"]);
  const quiet = catchUpLook(txs, NOW - 300_000, { rings: false, now: NOW });
  assert.equal(quiet.firstLookOnly, false, "a quiet address with a floor is looked at: its receives go in the bell");
  assert.deepEqual(quiet.candidates.map((t) => t.transaction_id), ["a"]);
  assert.equal(quiet.floorToSave, NOW - 60_000);
  assert.equal(catchUpLook([], NOW - 300_000, { now: NOW }).floorToSave, NOW - 300_000, "an empty answer keeps a stored floor");
});

await test("B6: the catch-up reads 3 transactions per address", () => {
  assert.equal(CATCH_UP_TX_COUNT, 3);
  assert.match(app, /fetchRecentFullTransactionsFor\(address, CATCH_UP_TX_COUNT\)/);
});

await test("R1/R2: every increase is attributed; Address Activity and each address's switch decide only the ping", () => {
  const check = between("async function runAddressActivityCheck()", "function makeOutputAddressLookup()");
  assert.match(check, /const rings = addressActivityFeatureEnabled\(\) && watched\.has\(address\);/);
  assert.match(check, /kind: watched\.get\(address\) \|\| addressActivityQuietKind\(address\), rings \}/);
  assert.doesNotMatch(check, /addressActivityFeatureEnabled\(\) && watched\.has\(address\)\) \{/, "no increase is left out for its switch");
});

function activityRun({ rings, floor = 1000, txs }) {
  const writes = [];
  const engine = { address: "kaspa:me" };
  const env = {
    engine, KAS_UNIT: "KAS",
    ownInputAddressSet: () => new Set(["kaspa:me"]),
    loadAddrActivityHandled: () => [],
    saveAddrActivityHandled: (list) => writes.push(["handled", [...list]]),
    makeOutputAddressLookup: () => async () => null,
    fetchRecentFullTransactionsFor: async (address, limit) => { writes.push(["fetch", limit]); return txs; },
    catchUpLook, CATCH_UP_TX_COUNT, outputsSompiTo,
    transactionBelongsInHistory: () => true,
    txBlockTimeMs: (t) => Number(t.block_time) || 0,
    isRecentForBanner: () => true,
    bellTimestamp: (at, now = Date.now()) => at || now,
    loadActivityFloor: () => floor,
    saveActivityFloor: (address, ms) => writes.push(["floor", ms]),
    pushShowsReceive: () => false,
    kaspaOutputAddress: (output) => output.address,
    spendsOwnFunds: async () => false,
    isMarkedOwnTransaction: () => false,
    postDesktopNotification: (note) => writes.push(["notify", note.title]),
    recordGlobalNotification: (item) => writes.push(["bell", item.id, item.title]),
    appendEngineLog: () => {},
    formatSompiForNotification: (sompi) => String(sompi),
    describeActivityAddress: () => "Spending address",
    addressActivityRoute: () => ({}), addressActivityCenterTarget: () => ({}), openAddressActivityTarget: () => {},
    shortAddress: (address) => address,
  };
  const source = between("async function attributeAndNotifyAddressActivity(", "// Where a tapped address-activity notification goes");
  const { attributeAndNotifyAddressActivity } = build(source, env, "{ attributeAndNotifyAddressActivity }");
  return attributeAndNotifyAddressActivity([{ address: "kaspa:spend", delta: 500n, kind: "spending", rings }], "kaspa:me").then(() => writes);
}

await test("R1: a quiet address's receive is filed in the bell with no notification; a ringing one rings too", async () => {
  const txs = [tx("t1", 5000, { outputs: [{ address: "kaspa:spend", amount: 500 }] })];
  const quiet = await activityRun({ rings: false, txs });
  assert.deepEqual(quiet.filter((w) => w[0] === "bell").map((w) => w[1]), ["wallet-t1"]);
  assert.equal(quiet.some((w) => w[0] === "notify"), false, "no ping for a quiet address");
  assert.deepEqual(quiet.find((w) => w[0] === "fetch"), ["fetch", 3]);
  const loud = await activityRun({ rings: true, txs });
  assert.deepEqual(loud.filter((w) => w[0] !== "fetch").map((w) => w[0]), ["floor", "notify", "bell", "handled"]);
});

await test("R2: a quiet address seen for the first time files nothing, not even Balance increased", async () => {
  const txs = [tx("old", 5000, { outputs: [{ address: "kaspa:spend", amount: 500 }] })];
  const writes = await activityRun({ rings: false, floor: 0, txs });
  assert.deepEqual(writes.filter((w) => w[0] !== "fetch" && w[0] !== "handled").map((w) => w[0]), ["floor"]);
});

await test("R6: a REST sum past u64, or a negative amount, skips the transaction", async () => {
  assert.equal(checkedSompiSum([1, "2", 3n]), 6n);
  assert.equal(checkedSompiSum([MAX_U64, 1]), null, "overflowing sum");
  assert.equal(checkedSompiSum([MAX_U64 + 1n]), null);
  assert.equal(checkedSompiSum([-5, 10]), null, "a negative amount");
  assert.equal(checkedSompiSum(["1.5", 4]), 4n, "an unreadable amount pays nothing, as before");
  const huge = { outputs: [{ script_public_key_address: "kaspa:me", amount: MAX_U64.toString() }, { script_public_key_address: "kaspa:me", amount: "1" }] };
  assert.equal(sompiPaidToAddress(huge, "kaspa:me"), 0n, "a claim can't match an overflowing sum");
  assert.equal(restPaymentSompiTo({ outputs: [{ script_public_key_address: "kaspa:me", amount: "-1" }] }, "kaspa:me"), 0n);
  assert.equal(outputsSompiTo(huge, "kaspa:me", { readAddress: (o) => o.script_public_key_address, readAmount: (o) => o.amount }), null);
  const writes = await activityRun({ rings: true, txs: [tx("big", 5000, { outputs: [{ address: "kaspa:spend", amount: MAX_U64.toString() }, { address: "kaspa:spend", amount: "9" }] })] });
  assert.equal(writes.some((w) => w[0] === "bell" && w[1] === "wallet-big"), false, "the overflowing transaction isn't filed");
});

await test("Received kUSDT: the bell always, the ping with Address Activity; the poll every 5 minutes when it's off", () => {
  assert.equal(W.shouldPoll({ visible: true, account: "kaspa:me", usesTokens: true }), true, "Address Activity off still polls");
  assert.equal(W.pollMaxAgeMs(false), 290_000);
  assert.equal(W.pollMaxAgeMs(true), W.KUSDT_POLL_MAX_AGE_MS);
  const src = read("ui/kusdt-wallet.js");
  assert.doesNotMatch(src, /if \(!deps\.notificationsEnabled\?\.\(\)\) return;/, "notifications off no longer skips the bell");
  assert.match(src, /deps\.notify\?\.\(\{ \.\.\.note, ring: ring && ringing, happenedAtMs \}\)/);
  // app.js: a ring posts the notification; the bell row is recorded either way
  const notify = between("notify: ({ title, body, ring = true, happenedAtMs = null }) => {", "ringWindowMs: KUSDT_RING_WINDOW_MS,");
  assert.match(notify, /if \(ring\) postDesktopNotification\(/);
  assert.match(notify, /recordGlobalNotification\(\{ id: `kusdt-\$\{stamp\}`/);
});

await test("R4: a kept notice whose contact isn't loaded stays; only the sent ones leave, the list re-read", () => {
  const body = between("async function sendUnsentPaymentNotices()", "/// The chatting address got KAS");
  assert.match(body, /const walletAddress = engine\.address;/, "the account is fixed at the start");
  assert.match(body, /if \(!contact \|\| !conversationEntry\) continue;/);
  assert.doesNotMatch(body, /if \(!contact \|\| !conversationEntry\) \{ done\.add/);
  assert.match(body, /if \(engine\.address !== walletAddress\) break;/);
  assert.match(body, /writeUnsentPaymentNotices\(walletAddress, readUnsentPaymentNotices\(walletAddress\)\.filter\(\(n\) => !done\.has\(n\.txId\)\)\);/);
});

await test("C5: a spending-address payment with no answer owes its notice until it settles, for its own account", () => {
  let clock = NOW;
  const book = createOwedSpendingNotices({ now: () => clock });
  const TX = "ab".repeat(32);
  assert.equal(book.owe({ txId: "not-a-txid", contactAddress: "kaspa:bob", amountSompi: 5n, owner: "kaspa:me" }), false);
  assert.equal(book.owe({ txId: TX.toUpperCase(), contactAddress: "kaspa:bob", amountSompi: 5n, memo: "hi", owner: "kaspa:me" }), true);
  assert.equal(book.take({ txId: TX, contactAddress: "kaspa:carol", account: "kaspa:me" }), null, "another contact's chat");
  assert.equal(book.take({ txId: TX, contactAddress: "kaspa:bob", account: "kaspa:other" }), null, "never from a different account");
  assert.equal(book.size, 1, "kept for its own account");
  assert.deepEqual(book.take({ txId: TX, contactAddress: "KASPA:BOB", account: "kaspa:me" }), { txId: TX, contactAddress: "kaspa:bob", amountSompi: 5n, memo: "hi", owner: "kaspa:me", at: NOW });
  assert.equal(book.take({ txId: TX, contactAddress: "kaspa:bob", account: "kaspa:me" }), null, "sent once");
  book.owe({ txId: TX, contactAddress: "kaspa:bob", amountSompi: 5n, owner: "kaspa:me" });
  clock += OWED_NOTICE_KEEP_MS;
  assert.equal(book.size, 0, "a week at most");
  // app.js: owed in the three spending-funded catches, sent when settleUnconfirmedSends settles it
  assert.equal((app.match(/\) oweSpendingNoticeIfUnknown\(error, contact,/g) || []).length, 3);
  const settle = between("async function settleUnconfirmedSends(", "async function refreshPendingPaymentStatuses(");
  assert.match(settle, /if \(contact\) sendOwedSpendingNoticeIfAny\(conversationEntry, contact, txid\);/);
  const owe = between("function oweSpendingNoticeIfUnknown(", "/// settleUnconfirmedSends found");
  assert.match(owe, /if \(error\?\.code !== SEND_OUTCOME_UNKNOWN \|\| !error\.txid\) return;/);
});

console.log(`\n${passed} passed`);
