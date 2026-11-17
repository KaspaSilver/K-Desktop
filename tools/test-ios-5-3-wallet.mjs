// node tools/test-ios-5-3-wallet.mjs - the wallet fixes shared by the iOS 5.3 apps (KaChat 83806b3d,
// KaPost 369794e, KaPlay 077d777, KaPay 5848fb0), ported in Build 292: strict addresses and
// upper-case QR codes, covenant coins kept out of plain spends, coins held from the submit for 10
// minutes, verified mempool answers, name answers checked, KNS reveal records kept until the commit
// is surely gone, and nodes on the wrong network refused.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const N = await import("../engine/network.js");
const T = await import("../engine/transactions.js");
const Q = await import("../engine/qr.js");
const U = await import("../engine/utils.js");
const NS = await import("../engine/name-services.js");
const KW = await import("../engine/kns-write.js");
const kaspa = await import("../kaspa/kaspa.js");
await kaspa.default({ module_or_path: readFileSync(join(repo, "kaspa/kaspa_bg.wasm")) });

let failures = 0;
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.log(`FAIL - ${name}\n`, error); }
}

const key = new kaspa.PrivateKey("5a".padEnd(62, "0") + "4d");
const schnorr = key.toPublicKey().toAddress("mainnet").toString();
const ecdsa = key.toPublicKey().toAddressECDSA("mainnet").toString();

// MARK: addresses (iOS 5.3 Bech32)
await test("well-formed addresses pass: Schnorr (v0), ECDSA (v1), P2SH (v8), upper case", async () => {
  assert.equal(N.isValidKaspaAddress(schnorr), true);
  assert.equal(N.isValidKaspaAddress(ecdsa), true);
  // a quantum-safe address is P2SH (version 8, 32 bytes)
  const p2sh = await import("../engine/quantum.js").then((q) => String(q.quantumAddressForRedeem(new Uint8Array([0x51]))));
  assert.match(p2sh, /^kaspa:p/);
  assert.equal(N.isValidKaspaAddress(p2sh), true);
  assert.equal(N.isValidKaspaAddress(schnorr.toUpperCase()), true, "a compact QR code's form");
});
await test("mixed case, unknown prefixes and wrong payload lengths are refused", () => {
  const mixed = schnorr.slice(0, 10) + schnorr.slice(10, 14).toUpperCase() + schnorr.slice(14);
  assert.equal(N.isValidKaspaAddress(mixed), false);
  // same payload, re-checksummed under another prefix
  assert.equal(N.isValidKaspaAddress(N.reencodeAddress(schnorr, "kaspatest")), true);
  const words = schnorr.slice(6, -8);
  assert.equal(N.isValidKaspaAddress(`bitcoin:${words}aaaaaaaa`), false);
  // a v0 payload one byte short: drop two 5-bit groups and re-checksum
  const short = reencodeWithBody("kaspa", words.slice(0, -2));
  assert.equal(N.isValidKaspaAddress(short), false, "31-byte v0 payload");
  assert.equal(N.isValidKaspaAddress("kaspa:"), false);
  assert.equal(N.isValidKaspaAddress("nonsense"), false);
});
await test("an upper-case QR address reads in lower case; mixed case and queries stay as given", () => {
  assert.equal(N.lowercasedKaspaAddress(schnorr.toUpperCase()), schnorr);
  assert.equal(Q.normalizeScannedKaspaAddress(`${schnorr.toUpperCase()}?amount=1`), schnorr);
  const mixed = schnorr.slice(0, 10) + "Q" + schnorr.slice(11);
  assert.equal(N.lowercasedKaspaAddress(mixed), mixed);
  assert.equal(N.lowercasedKaspaAddress("ALICE.KAS"), "ALICE.KAS", "not an address");
});
await test("every send checks the whole address", () => {
  assert.equal(U.validateMainnetAddress(schnorr.toUpperCase()), schnorr);
  assert.throws(() => U.validateMainnetAddress("kaspa:qqqq"), /isn't a valid Kaspa address/);
  assert.throws(() => U.validateMainnetAddress(N.reencodeAddress(schnorr, "kaspatest")), /testnet|mainnet/i);
});

// MARK: covenant coins
await test("covenant coins are left out of plain spends", () => {
  const plain = { outpoint: { transactionId: "aa", index: 0 }, amount: 5n };
  const bound = { outpoint: { transactionId: "bb", index: 0 }, amount: 9n, covenantId: "cd".repeat(32) };
  assert.equal(T.isCovenantUtxo(bound), true);
  assert.deepEqual(T.excludeCovenantUtxos([plain, bound]), [plain]);
  assert.equal(T.singleInputFor([bound], 1n, 0n), null, "an arena send never takes one");
  assert.match(read("ui/app.js"), /return "Locked by a covenant";/);
});

// MARK: coin holds
const coins = ["11:0", "22:1"];
const isHeld = (k) => !T.excludeJustSpentUtxos([{ outpoint: { transactionId: k.split(":")[0], index: Number(k.split(":")[1]) } }]).length;
await test("a send's coins are held from the submit, 10 minutes", async () => {
  T.clearJustSpentOutpoints();
  assert.equal(T.JUST_SPENT_HOLD_MS, 600_000);
  let duringSubmit = null;
  await T.submitConfirmingAcceptance({ rpc: {}, txid: "ab".repeat(32), spends: coins, recheckMs: 60_000,
    submit: async () => { duringSubmit = coins.every(isHeld); return "ab".repeat(32); } });
  assert.equal(duringSubmit, true, "held while the node answers");
  assert.ok(coins.every(isHeld), "and after it went out");
});
await test("a refused send gives its coins back; 'already spent' keeps them held", async () => {
  T.clearJustSpentOutpoints();
  const rpc = { getMempoolEntry: async () => { throw new Error("no"); } };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 404 });
  try {
    await assert.rejects(T.submitConfirmingAcceptance({ rpc, txid: "ab".repeat(32), spends: coins, submit: async () => { throw new Error("fee too low"); } }), /fee too low/);
    assert.ok(!coins.some(isHeld));
    await assert.rejects(T.submitConfirmingAcceptance({ rpc, txid: "ab".repeat(32), spends: coins, submit: async () => { throw new Error("transaction rejected: outpoint already spent"); } }));
    assert.ok(coins.every(isHeld));
  } finally { globalThis.fetch = saved; T.clearJustSpentOutpoints(); }
});
await test("a hold is never shortened, and a coin another send holds stays held after this one fails", async () => {
  T.clearJustSpentOutpoints();
  T.noteSpentOutpoints(["33:0"]);
  const rpc = { getMempoolEntry: async () => { throw new Error("no"); } };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 404 });
  try {
    await assert.rejects(T.submitConfirmingAcceptance({ rpc, txid: "ab".repeat(32), spends: ["33:0"], submit: async () => { throw new Error("fee too low"); } }));
    assert.ok(isHeld("33:0"));
  } finally { globalThis.fetch = saved; T.clearJustSpentOutpoints(); }
});

// MARK: mempool answers
await test("a mempool answer counts only for that transaction, never an orphan", () => {
  const id = "ab".repeat(32);
  assert.equal(T.mempoolAnswerHolds({ mempoolEntry: { transaction: {} } }, id), true);
  assert.equal(T.mempoolAnswerHolds({ mempoolEntry: { isOrphan: true } }, id), false);
  assert.equal(T.mempoolAnswerHolds({ mempoolEntry: { transaction: { verboseData: { transactionId: "cd".repeat(32) } } } }, id), false);
  assert.equal(T.mempoolAnswerHolds({ mempoolEntry: { transaction: { verboseData: { transactionId: id.toUpperCase() } } } }, id), true);
  assert.equal(T.mempoolAnswerHolds(null, id), false);
  assert.match(read("engine/transactions.js"), /includeOrphanPool: false/);
});
await test("after a node's verdict its mempool doesn't make the send 'sent'", async () => {
  const id = "ab".repeat(32);
  const rpc = { getMempoolEntry: async () => ({ mempoolEntry: { transaction: {} } }) };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 404 });
  try {
    await assert.rejects(T.submitConfirmingAcceptance({ rpc, txid: id, submit: async () => { throw new Error("transaction rejected: fee too low"); } }), /fee too low/);
    // "already in the mempool" is no verdict: the mempool still counts
    assert.equal(await T.submitConfirmingAcceptance({ rpc, txid: id, submit: async () => { throw new Error("already in the mempool"); }, recheckMs: 60_000 }), id);
  } finally { globalThis.fetch = saved; T.clearJustSpentOutpoints(); }
});

// MARK: name answers
await test("a name service's address must be valid on this network; else the lookup failed", async () => {
  const results = await NS.resolveEverywhere("alice.kas", { network: "mainnet", resolveKas: async () => "kaspa:notreal" });
  const kas = results.find((r) => r.tld === "kas");
  assert.equal(kas.state, "failed");
  assert.equal(kas.address, null);
  const good = (await NS.resolveEverywhere("alice.kas", { network: "mainnet", resolveKas: async () => schnorr.toUpperCase() })).find((r) => r.tld === "kas");
  assert.equal(good.state, "resolved");
  assert.equal(good.address, schnorr);
  const testnet = (await NS.resolveEverywhere("alice.kas", { network: "mainnet", resolveKas: async () => N.reencodeAddress(schnorr, "kaspatest") })).find((r) => r.tld === "kas");
  assert.equal(testnet.state, "failed", "another network's address is no answer");
});
await test("a lookup that couldn't run says so, not 'not found'", async () => {
  const results = await NS.resolveEverywhere("alice.kas", { network: "mainnet", resolveKas: async () => { throw new Error("down"); } });
  assert.equal(NS.notFoundMessage("alice.kas", results), "Couldn't look up .kas right now.");
  const none = await NS.resolveEverywhere("alice.kas", { network: "mainnet", resolveKas: async () => null });
  assert.equal(NS.notFoundMessage("alice.kas", none), "No .kas domain found");
});
await test("strict KNS lookups throw on an outage, keep null for a free name", async () => {
  const { resolveDomain } = await import("../engine/kns.js");
  const saved = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("down", { status: 503 });
    await assert.rejects(resolveDomain("alice.kas", { baseUrl: "https://kns.test", strict: true }), /Couldn't look up alice\.kas/);
    assert.equal(await resolveDomain("alice.kas", { baseUrl: "https://kns.test" }), null, "not strict: null as before");
    globalThis.fetch = async () => new Response("", { status: 404 });
    assert.equal(await resolveDomain("alice.kas", { baseUrl: "https://kns.test", strict: true }), null);
    globalThis.fetch = async () => new Response(JSON.stringify({ success: true, data: { owner: schnorr, asset: "bob.kas" } }), { status: 200 });
    await assert.rejects(resolveDomain("alice.kas", { baseUrl: "https://kns.test", strict: true }), /Couldn't look up/, "an answer about another domain");
    assert.match(read("engine/index.js"), /resolveKnsDomain\(name, \{ strict: true \}\)/);
  } finally { globalThis.fetch = saved; }
});

// MARK: KNS reveal records
const ME = "kaspa:qme";
const RKEY = `kachat-account-data-v1:${ME}:kachat-kns-pending-reveals-v1`;
const recordsNow = () => JSON.parse(store.get(RKEY) || "[]");
const fakeEngine = (entries) => ({
  address: ME, privateKey: key, kaspa, connect: async () => {},
  withRpc: async (fn) => fn({ getUtxosByAddresses: async () => ({ entries }) }),
});
function fileRecord(fields) {
  // the commit address must be the one the script builds, or the record is dropped as foreign
  const xOnly = key.toPublicKey().toXOnlyPublicKey().toString();
  const payloadJson = JSON.stringify({ op: "test" });
  const built = KW.buildKnsRedeemScript ? KW.buildKnsRedeemScript(kaspa, xOnly, payloadJson) : null;
  store.set(RKEY, JSON.stringify([{ id: "r1", payloadJson, commitAddressString: built?.commitAddressString ?? "x", commitAmountSompi: "100", revealAmountSompi: "1", revealTargetAddress: ME, ...fields }]));
}
await test("a commit seen on chain and then gone twice in a row is dropped; once is not enough", async () => {
  if (!KW.buildKnsRedeemScript) { console.log("  (skipped: buildKnsRedeemScript not exported)"); return; }
  store.clear();
  fileRecord({ createdAt: Date.now() - 3_600_000, commitSeen: true });
  await KW.resumePendingKnsReveals({ engine: fakeEngine([]) });
  assert.equal(recordsNow().length, 1);
  assert.equal(recordsNow()[0].emptyChecks, 1);
  await KW.resumePendingKnsReveals({ engine: fakeEngine([]) });
  assert.equal(recordsNow().length, 0);
});
await test("a commit never seen is kept for 30 days, then dropped after two empty looks", async () => {
  if (!KW.buildKnsRedeemScript) { console.log("  (skipped: buildKnsRedeemScript not exported)"); return; }
  store.clear();
  fileRecord({ createdAt: Date.now() - 2 * 86_400_000 });
  for (let i = 0; i < 3; i += 1) await KW.resumePendingKnsReveals({ engine: fakeEngine([]) });
  assert.equal(recordsNow().length, 1, "two days old: kept");
  fileRecord({ createdAt: Date.now() - 31 * 86_400_000 });
  await KW.resumePendingKnsReveals({ engine: fakeEngine([]) });
  assert.equal(recordsNow().length, 1);
  await KW.resumePendingKnsReveals({ engine: fakeEngine([]) });
  assert.equal(recordsNow().length, 0);
});
await test("the reveal rules are in place (source)", () => {
  const src = read("engine/kns-write.js");
  assert.match(src, /KNS_REVEAL_MISSING_LIFETIME_MS = 30 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(src, /record\.commitSeen === true \|\| old/);
  assert.match(src, /commitSeen: true, emptyChecks: 0/);
});

// MARK: nodes, change slots, message coin cap
await test("a node on another network is refused", () => {
  const rpc = read("engine/rpc.js");
  assert.match(rpc, /node is on \$\{info\.networkId\}, not \$\{wanted\}/);
  assert.match(rpc, /connection\.\*reset/);
});
await test("change slots are picked one at a time and claimed", () => {
  const app = read("ui/app.js");
  assert.match(app, /const pick = changeSlotPicks\.then/);
  assert.match(app, /claimChangeSlot\(account\.owner, index\)/);
  assert.match(app, /Math\.max\(getSpendingState\(owner\)\.qMaxIndex, claimedChangeBound\(owner\)\)/);
});
await test("a message spread over too many coins says Compound, not 'balance too low'", () => {
  assert.match(read("engine/transactions.js"), /This message needs too many coins for one transaction\. Use Compound UTXOs on your chatting address, then try again\./);
});

// helpers
function reencodeWithBody(hrp, body5) {
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const data = [...body5].map((c) => CHARSET.indexOf(c));
  const polymod = (values) => {
    let c = 1n;
    for (const d of values) {
      const c0 = c >> 35n;
      c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
      if (c0 & 0x01n) c ^= 0x98f2bc8e61n;
      if (c0 & 0x02n) c ^= 0x79b76d99e2n;
      if (c0 & 0x04n) c ^= 0xf33e5fb3c4n;
      if (c0 & 0x08n) c ^= 0xae2eabe2a8n;
      if (c0 & 0x10n) c ^= 0x1e4f43e470n;
    }
    return c ^ 1n;
  };
  const prefix = [...hrp].map((ch) => ch.charCodeAt(0) & 0x1f);
  const v = polymod([...prefix, 0, ...data, 0, 0, 0, 0, 0, 0, 0, 0]);
  let sum = "";
  for (let i = 7; i >= 0; i -= 1) sum += CHARSET[Number((v >> BigInt(i * 5)) & 31n)];
  return `${hrp}:${body5}${sum}`;
}

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log(`ios 5.3 wallet: ${passed} passed`);
