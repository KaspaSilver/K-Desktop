// kUSDT balances (engine/kusdt-balances.js) without a network: Trestly's /tokens answer through a
// fake fetch, the node through a fake getUtxos. A listed coin counts only when the node holds that
// exact outpoint at the script recomputed here, carrying kUSDT's covenant id; expected coins,
// the 2-minute landing window and "Received" detection as iOS TokenWallet. Run from the repo root:
//
//   node tools/test-kusdt-balances.mjs

import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js";

const K = await import("../engine/kusdt.js");
const B = await import("../engine/kusdt-balances.js");
const S = await import("../engine/kusdt-store.js");
const C = await import("../engine/kachat-names/codec.js");

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (error) { failures.push(`${name}: ${error?.stack || error}`); }
}

const net = "testnet-10";
const dep = K.kusdtDeployment(net);
const tmpl = K.kusdtTemplate();
const keyA = schnorr.getPublicKey(C.unhex("01".repeat(32)));
const keyB = schnorr.getPublicKey(C.unhex("02".repeat(32)));
const addrA = K.addressOfOwner(keyA, net);
const txid = (n) => n.toString(16).padStart(2, "0").repeat(32);

function answer(body, { status = 200, headers = {} } = {}) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}
function fakeFetch(json, opts) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return answer(typeof json === "string" ? json : K.stringifyExact(json), opts); };
  f.calls = calls;
  return f;
}
const listed = (n, index, state) => ({ utxo: { transactionId: txid(n), index, amount: 150000000 }, state: { ...K.stateToJson(state) } });
function nodeUtxo(n, index, state, { covenantId = dep.covenantId, script = null, scriptVersion = 0, amount = 150_000_000n } = {}) {
  return {
    outpoint: { transactionId: txid(n), index }, amount, blockDaaScore: 77n, isCoinbase: false, scriptVersion,
    scriptPublicKey: C.hex(script ?? K.lockingScript(state, tmpl)), covenantId,
  };
}

// MARK: Trestly's API

await check("the API is read directly: https only, no cookies, no cache, no referrer", async () => {
  const f = fakeFetch({ states: [] });
  await B.fetchTokenStates("https://testnet.trestly.io/api/v1/", addrA, { fetchImpl: f });
  assert.equal(f.calls[0].url, `https://testnet.trestly.io/api/v1/tokens?owner=${encodeURIComponent(addrA)}`);
  assert.equal(f.calls[0].init.cache, "no-store");
  assert.equal(f.calls[0].init.credentials, "omit");
  assert.equal(f.calls[0].init.referrerPolicy, "no-referrer");
  await assert.rejects(B.fetchTokenStates("http://testnet.trestly.io/api/v1", addrA, { fetchImpl: f }), (e) => e.message === B.BALANCE_MESSAGES.badApiUrl);
  await assert.rejects(B.fetchTokenStates("not a url", addrA, { fetchImpl: f }), (e) => e.message === B.BALANCE_MESSAGES.badApiUrl);
});

await check("API failures say what iOS says", async () => {
  await assert.rejects(B.fetchTokenStates(dep.apiBase, addrA, { fetchImpl: fakeFetch("{}", { status: 503 }) }), (e) => e.message === "Trestly answered HTTP 503.");
  await assert.rejects(B.fetchTokenStates(dep.apiBase, addrA, { fetchImpl: fakeFetch("not json") }), (e) => e.message === B.BALANCE_MESSAGES.unreadable);
  await assert.rejects(B.fetchTokenStates(dep.apiBase, addrA, { fetchImpl: fakeFetch("[1]") }), (e) => e.message === B.BALANCE_MESSAGES.unreadable);
  await assert.rejects(B.fetchTokenStates(dep.apiBase, addrA, { fetchImpl: async () => { throw new TypeError("offline"); } }), (e) => e.message === B.BALANCE_MESSAGES.noAnswer);
  const big = new Uint8Array(B.MAX_ANSWER_BYTES + 1).fill(0x20);
  await assert.rejects(B.fetchTokenStates(dep.apiBase, addrA, { fetchImpl: async () => answer(big) }), (e) => e.message === B.BALANCE_MESSAGES.unreadable, "over 4 MB");
  await assert.rejects(B.fetchTokenStates(dep.apiBase, addrA, { fetchImpl: fakeFetch("{}", { headers: { "content-length": String(B.MAX_ANSWER_BYTES + 1) } }) }), (e) => e.message === B.BALANCE_MESSAGES.unreadable, "declared over 4 MB");
});

await check("an answer's amounts above 2^53 are read exactly; bad outpoints dropped; unread counted", async () => {
  const s = K.plainState(keyA, 9_007_199_254_740_993n);
  const body = `{"states":[{"utxo":{"transactionId":"${txid(1)}","index":0},"state":{"amount":9007199254740993,"owner":"${C.hex(keyA)}","ownerScheme":0}},`
    + `{"utxo":{"transactionId":"xyz","index":0},"state":{}},{"utxo":{"transactionId":"${txid(2)}","index":4294967296},"state":{}}],"unread":[{},{}]}`;
  const r = await B.fetchTokenStates(dep.apiBase, addrA, { fetchImpl: fakeFetch(body) });
  assert.equal(r.states.length, 1);
  assert.ok(K.sameState(r.states[0].state, s));
  assert.equal(r.unreadCount, 2);
});

// MARK: verification on the node

await check("a coin counts only when the node has it, at that script, with kUSDT's covenant", async () => {
  const good = K.plainState(keyA, 5_000_000n);
  const states = [
    listed(1, 0, good),                                  // on the node as listed: counts
    listed(2, 0, K.plainState(keyA, 1_000_000n)),        // the node doesn't have it
    listed(3, 1, K.plainState(keyA, 2_000_000n)),        // wrong covenant id
    listed(4, 0, K.plainState(keyA, 3_000_000n)),        // the node has another script there
    listed(5, 0, K.plainState(keyA, 4_000_000n)),        // script version 1
    listed(6, 0, K.plainState(keyB, 9_000_000n)),        // another key's coin
    listed(7, 0, K.makeState({ amount: 1n, owner: keyA, ownerScheme: 0, borrowScheme: 1 })), // not plain
    listed(1, 0, good),                                  // listed twice
    listed(8, 2, K.plainState(keyA, 6_000_000n)),        // at the right script but no covenant
  ];
  const node = [
    nodeUtxo(1, 0, good, { amount: 150_000_123n }),
    nodeUtxo(3, 1, K.plainState(keyA, 2_000_000n), { covenantId: dep.poolId }),
    nodeUtxo(4, 0, null, { script: K.lockingScript(K.plainState(keyA, 3_000_001n), tmpl) }),
    nodeUtxo(5, 0, K.plainState(keyA, 4_000_000n), { scriptVersion: 1 }),
    nodeUtxo(6, 0, K.plainState(keyB, 9_000_000n)),
    nodeUtxo(8, 2, K.plainState(keyA, 6_000_000n), { covenantId: null }),
  ];
  let asked = null;
  const r = await B.verifiedCoins({
    address: addrA, network: net, fetchImpl: fakeFetch({ states }),
    getUtxos: async (addresses) => { asked = addresses; return node; },
  });
  assert.equal(r.coins.length, 1);
  assert.equal(r.coins[0].transactionId, txid(1));
  assert.equal(r.coins[0].kasSompi, 150_000_123n, "the KAS the node says it holds");
  assert.equal(r.coins[0].blockDaaScore, 77n);
  assert.equal(r.units, 5_000_000n);
  assert.ok(asked.every((a) => a.startsWith("kaspatest:p")), "only the coins' own P2SH addresses are read");
  assert.equal(new Set(asked).size, asked.length);
  assert.ok(!asked.includes(K.coinAddress(K.lockingScript(K.plainState(keyB, 9_000_000n), tmpl), net)), "another key's coin isn't even looked up");
  assert.ok(r.listedByAPI.has(`${txid(1)}:0`) && !r.listedByAPI.has(`${txid(6)}:0`));
});

await check("an address that can't hold kUSDT isn't asked about; no template refuses", async () => {
  const f = fakeFetch({ states: [] });
  const p2sh = K.coinAddress(K.lockingScript(K.plainState(keyA, 1n), tmpl), net);
  const r = await B.verifiedCoins({ address: p2sh, network: net, fetchImpl: f, getUtxos: async () => [] });
  assert.equal(r.coins.length, 0);
  assert.equal(f.calls.length, 0);
  const mainnetAddr = K.addressOfOwner(keyA, "mainnet");
  await B.verifiedCoins({ address: mainnetAddr, network: net, fetchImpl: f, getUtxos: async () => [] });
  assert.equal(f.calls.length, 0, "the other network's address");
  await assert.rejects(B.verifiedCoins({ address: addrA, network: net, template: null, fetchImpl: f, getUtxos: async () => [] }), (e) => e.code === "templateMissing");
});

await check("an expected coin is checked on the node until Trestly lists it", async () => {
  const s = K.plainState(keyA, 7_000_000n);
  const expected = [{ transactionId: txid(9), index: 1, state: s }, { transactionId: txid(10), index: 0, state: K.plainState(keyB, 1n) }];
  let read = [];
  const r = await B.verifiedCoins({
    address: addrA, network: net, fetchImpl: fakeFetch({ states: [] }), expected,
    getUtxos: async (a) => { read = a; return [nodeUtxo(9, 1, s)]; },
  });
  assert.equal(r.coins.length, 1, "found on the node though not listed");
  assert.equal(r.listedByAPI.size, 0);
  assert.equal(read.length, 1, "another key's expected coin isn't looked up");
});

await check("expected coins: let go when listed or after 30 minutes; 2 minutes in the balance; follow-up in 5 s", () => {
  const t0 = 1_000_000;
  const s = K.plainState(keyA, 3_000_000n);
  const coin = { transactionId: txid(1), index: 0, state: K.plainState(keyA, 1_000_000n), kasSompi: 150_000_000n, blockDaaScore: 1n };
  const expected = [
    { holdingId: "chatting", address: addrA, transactionId: txid(2), index: 1, state: s, since: t0 },          // landing
    { holdingId: "chatting", address: addrA, transactionId: txid(3), index: 0, state: s, since: t0 - 1_800_001 }, // too old
    { holdingId: "chatting", address: addrA, transactionId: txid(4), index: 0, state: s, since: t0 },          // now listed
  ];
  const results = [{ holdingId: "chatting", address: addrA, result: { coins: [coin], listedByAPI: new Set([`${txid(4)}:0`]) } }];
  const a = B.applyResults({ results, expected, now: t0 + 1_000 });
  assert.deepEqual(a.expected.map((e) => e.transactionId), [txid(2)]);
  assert.equal(a.holdings[0].units, 4_000_000n, "the landing coin counts in the balance");
  assert.equal(a.holdings[0].coinCount, 2);
  assert.equal(a.holdings[0].coins.length, 1, "but not in what a send can spend");
  assert.equal(a.followUpMs, 5_000);
  const later = B.applyResults({ results, expected: a.expected, now: t0 + 120_000 });
  assert.equal(later.holdings[0].units, 1_000_000n, "after 2 minutes it no longer counts");
  assert.equal(later.followUpMs, null);
  assert.equal(later.expected.length, 1, "but is still looked for, up to 30 minutes");
  const held = B.applyResults({ results, expected: [], now: t0, isHeld: (k) => k === `${txid(1)}:0` });
  assert.equal(held.holdings.length, 0, "a coin a send just spent never counts again");
});

// MARK: Received

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
const coinOf = (n, index, units) => ({ transactionId: txid(n), index, state: K.plainState(keyA, units), kasSompi: 150_000_000n, blockDaaScore: 1n });

await check("Received: never on the first look; new coins from others announced and recorded", async () => {
  const store = S.createKusdtStore({ storage: memoryStorage(), account: "kaspa:acct" });
  const first = await B.findReceived({ store, current: [{ holdingId: "chatting", coins: [coinOf(1, 0, 5n)] }] });
  assert.equal(first.firstLook, true);
  assert.equal(first.received.length, 0);
  const second = await B.findReceived({
    store, current: [{ holdingId: "chatting", coins: [coinOf(1, 0, 5n), coinOf(2, 0, 7n)] }], previous: [coinOf(1, 0, 5n)],
    fetchTransactionInputs: async () => [{ hash: txid(50), index: 0, address: "kaspatest:someoneelse" }], ownAddresses: [addrA],
  });
  assert.deepEqual(second.received.map((r) => r.units), [7n]);
  assert.equal(store.activity()[0].kind, "received");
  assert.equal(store.activity()[0].id, `${txid(2)}:chatting:received`);
  const third = await B.findReceived({ store, current: [{ holdingId: "chatting", coins: [coinOf(1, 0, 5n), coinOf(2, 0, 7n)] }] });
  assert.equal(third.received.length, 0, "known now");
});

await check("Received: never for your own transfers", async () => {
  const store = S.createKusdtStore({ storage: memoryStorage(), account: "kaspa:acct" });
  store.rememberSeen([`${txid(1)}:0`]);
  const fromOwnAddress = await B.findReceived({
    store, current: [{ holdingId: "s1", coins: [coinOf(3, 0, 9n)] }],
    fetchTransactionInputs: async () => [{ hash: txid(60), index: 0, address: addrA.toUpperCase() }], ownAddresses: [addrA],
  });
  assert.equal(fromOwnAddress.received.length, 0, "an input from one of your addresses");
  store.rememberSeen([`${txid(1)}:0`]);
  const spentKnown = await B.findReceived({
    store, current: [{ holdingId: "s1", coins: [coinOf(4, 0, 9n)] }],
    fetchTransactionInputs: async () => [{ hash: txid(1), index: 0, address: "kaspatest:p..." }], ownAddresses: [addrA],
  });
  assert.equal(spentKnown.received.length, 0, "it spent a coin of yours");
  store.rememberSeen([`${txid(1)}:0`]);
  const restDown = await B.findReceived({
    store, current: [{ holdingId: "s1", coins: [coinOf(5, 0, 9n)] }], previous: [coinOf(1, 0, 5n)],
    fetchTransactionInputs: async () => null, ownAddresses: [addrA],
  });
  assert.equal(restDown.received.length, 0, "REST can't say, and a coin of yours went in this window");
  store.rememberSeen([]);
  store.record({ id: `${txid(6)}:chatting:combined`, kind: "combined", units: 1n });
  const madeHere = await B.findReceived({
    store, current: [{ holdingId: "chatting", coins: [coinOf(6, 0, 3n)] }],
    fetchTransactionInputs: async () => [{ hash: txid(70), index: 0, address: "kaspatest:p..." }], ownAddresses: [addrA],
  });
  assert.equal(madeHere.received.length, 0, "a transaction made on this device");
});

await check("the notification reads as K's: just the amount (K b0f0a4e6)", () => {
  const n = B.receivedNotification([{ units: 1_500_000n }, { units: 1_000_000n }], ["Chatting Address"], (u) => K.formatKusdt(u));
  assert.deepEqual(n, { title: "Received 2.50 kUSDT", body: "" });
  assert.equal(B.receivedNotification([{ units: 1n }], ["A", "B"], K.formatKusdt).body, "");
});

if (failures.length) for (const f of failures) console.log(`FAIL ${f}`);
console.log(`kusdt balances: ${passed} checks passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
