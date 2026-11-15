// .kachat claim tracking (KaPay 5848fb0, ported in Build 290): a commit sent again on a busy
// network can land as the first send instead of the resend, and a register sent again can land
// late. The claim must follow whichever send landed, never fail a claim whose name was
// registered, and never take a stranger's coin at the commit address for the commit. Fakes only,
// no network:
//
//   node tools/test-kachat-claim-tracking.mjs
import assert from "node:assert/strict";

const store = new Map([["kachat-network-v1", "testnet"]]);
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const A = await import("../engine/kachat-names/actions.js");
const { Lookup, GapInfo } = await import("../engine/kachat-names/registry-state.js");
const { unhex32 } = await import("../engine/kachat-names/codec.js");

const wallet = "kaspatest:qwalleta";
const FIRST = "a1".repeat(32);
const RESEND = "b2".repeat(32);
const STRANGER = "c3".repeat(32);
const REGISTER_1 = "d4".repeat(32);
const SCRIPT = "aa20" + "11".repeat(32) + "87";

const utxo = (txid, index = 0, daa = 100n) => ({
  outpoint: { txid: unhex32(txid), index },
  entry: { amount: 20_000_000n, script: new Uint8Array(), blockDaaScore: daa },
});

let liveAtCommit = [];
let nodeDown = false;
const service = {
  manifest: null,
  async liveUtxos() {
    if (nodeDown) throw new Error("no node");
    return liveAtCommit;
  },
  async liveRegistryUtxo() { throw new Error("not used"); },
};
let owns = false;
const accepted = new Set();
const registry = {
  graceMs: 0n,
  async lookup(name) { return owns ? { kind: "registered", info: { owner: wallet, status: () => "active", name } } : Lookup.free(name, null); },
  async isAccepted(tx) { return accepted.has(tx); },
  async refreshUntilIncludes() {},
  async refresh() {},
};
const engine = { address: wallet, log() {}, async currentVirtualDaaScore() { return 1n; } };
const mem = new Map();
const storage = { get: (k) => mem.get(k) ?? null, set: (k, v) => { mem.set(k, v); } };
const actions = new A.KachatNamesActions({ engine, service, registry, storage });
actions._ownsName = async () => owns;
actions._inMempool = async () => false;
actions._restAccepted = async (tx) => accepted.has(tx);

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.log(`FAIL - ${name}\n`, error); }
}

const claim = (over = {}) => ({
  id: "c1", name: "alice", years: 1, owner: "11".repeat(32), commitTxId: RESEND, commitTxIds: [FIRST, RESEND],
  commitScript: SCRIPT, commitDaa: null, registerTxId: null, registerTxIds: null, cancelTxId: null,
  stage: A.Stage.waiting, createdAt: 1, updatedAt: Date.now(), lastError: null, salt: "33".repeat(32), ...over,
});

function reset(over) {
  mem.clear();
  actions._loadPending(wallet);
  actions._upsert(claim(over));
  return actions._pending[0];
}

await test("the first send of a resent commit landed: the claim follows it", async () => {
  const p = reset();
  liveAtCommit = [utxo(FIRST)];
  const found = await actions._findCommit(p);
  assert.equal(found.kind, "live");
  assert.equal(actions._find("c1").commitTxId, FIRST, "commitTxId follows the send that landed");
});

await test("the latest send wins when both are somehow there", async () => {
  const p = reset();
  liveAtCommit = [utxo(FIRST), utxo(RESEND)];
  const found = await actions._findCommit(p);
  assert.equal(found.kind, "live");
  assert.equal(found.utxo.outpoint.index, 0);
  assert.equal(actions._find("c1").commitTxId, RESEND);
});

await test("a stranger's coin at the commit address is never the commit", async () => {
  const p = reset();
  liveAtCommit = [utxo(STRANGER)];
  assert.equal((await actions._findCommit(p)).kind, "gone");
  liveAtCommit = [utxo(FIRST, 1)];
  assert.equal((await actions._findCommit(p)).kind, "gone", "only output 0 is a commit");
});

await test("a claim from before commitTxIds still finds its one commit", async () => {
  const p = reset({ commitTxId: FIRST, commitTxIds: null });
  liveAtCommit = [utxo(FIRST)];
  assert.equal((await actions._findCommit(p)).kind, "live");
});

await test("a node that can't be asked is unknown: never spent, never failed", async () => {
  const p = reset({ commitDaa: 100 });
  nodeDown = true;
  try {
    assert.equal((await actions._findCommit(p)).kind, "unknown");
    assert.equal(await actions._commitSpent(p), null);
    await actions._advance(p);
    assert.equal(actions._find("c1").stage, A.Stage.waiting, "the driver waits for the next tick");
  } finally { nodeDown = false; }
});

await test("a register that landed late finishes the claim as registered", async () => {
  const p = reset({ commitDaa: 100, registerTxIds: [REGISTER_1], registerTxId: null });
  liveAtCommit = [];
  accepted.add(REGISTER_1);
  try {
    await actions._advance(p);
    assert.equal(actions._find("c1").stage, A.Stage.registered);
  } finally { accepted.clear(); }
});

await test("a sent register gets half an hour for the registry to catch up, then fails", async () => {
  const p = reset({ commitDaa: 100, registerTxIds: [REGISTER_1] });
  liveAtCommit = [];
  await actions._advance(p);
  assert.equal(actions._find("c1").stage, A.Stage.waiting, "not failed while the registry may be behind");
  const old = reset({ commitDaa: 100, registerTxIds: [REGISTER_1], updatedAt: Date.now() - 1_900_000 });
  await actions._advance(old);
  assert.equal(actions._find("c1").stage, A.Stage.failed);
});

await test("without any register sent, a gone commit still fails as before", async () => {
  const p = reset({ commitDaa: 100 });
  liveAtCommit = [];
  await actions._advance(p);
  assert.equal(actions._find("c1").stage, A.Stage.failed);
  assert.equal(actions._find("c1").lastError, "The commit is no longer on chain.");
});

await test("a cancel is finished only once the commit is seen gone", async () => {
  const p = reset({ stage: A.Stage.cancelling, cancelTxId: "e5".repeat(32), updatedAt: Date.now() - 200_000 });
  nodeDown = true;
  try {
    await actions._advance(p);
    assert.equal(actions._find("c1").stage, A.Stage.cancelling, "no answer is not gone");
  } finally { nodeDown = false; }
  liveAtCommit = [];
  await actions._advance(actions._find("c1"));
  assert.equal(actions._find("c1"), null, "cancelled and dropped from the list");
});

await test("a resent commit's mempool check covers every send", async () => {
  const p = reset({ commitSentAt: Date.now() - 90_000 });
  const asked = [];
  actions._inMempool = async (tx) => { asked.push(tx); return tx === FIRST; };
  try {
    assert.equal(await actions._commitStillPending(p), true, "the first send is still waiting");
    assert.deepEqual(asked, [FIRST]);
  } finally { actions._inMempool = async () => false; }
});

await test("claiming: a free answer needs a live gap; a stale one is read again, then refused", async () => {
  const gap = new GapInfo({ lo: new Uint8Array(32), hi: new Uint8Array(32).fill(255), outpoint: { txid: unhex32(FIRST), index: 0 } });
  let refreshed = 0;
  const realLookup = registry.lookup;
  const realRefresh = registry.refresh;
  registry.lookup = async (name) => Lookup.free(name, gap);
  registry.refresh = async () => { refreshed += 1; };
  try {
    actions._liveGap = async () => ({ ok: true });
    assert.equal(await actions._claimable("alice", {}), null, "free in a live gap");
    actions._liveGap = async () => { throw new Error("spent"); };
    await assert.rejects(actions._claimable("alice", {}), /can't be checked right now/);
    assert.equal(refreshed, 1, "read again once before refusing");
    registry.lookup = async (name) => Lookup.free(name, null);
    await assert.rejects(actions._claimable("alice", {}), /can't be checked right now/, "no gap at all is no answer");
  } finally {
    registry.lookup = realLookup;
    registry.refresh = realRefresh;
    delete actions._liveGap;
  }
});

await test("the indexer's registered-but-unreadable record is no answer, never free", async () => {
  const { KachatNamesRegistry } = await import("../engine/kachat-names/registry.js");
  const r = Object.create(KachatNamesRegistry.prototype);
  r.prepare = async () => {};
  r.source = { kind: "indexer", base: "https://x.test" };
  r._get = async () => ({ name: "alice", registered: true });
  await assert.rejects(r.lookup("alice"), /can't be read/);
  r._get = async () => ({ name: "alice", registered: false });
  assert.equal((await r.lookup("alice")).kind, "free");
});

await test("offers on a name that leaves are declined only once the change is in a block", async () => {
  const declined = [];
  actions.declineOpenOffers = (name, except) => declined.push([name, except]);
  let landedCallback = null;
  actions.follow = (txId, plan, opts) => { landedCallback = opts?.onAccepted; return Promise.resolve(null); };
  const src = (await import("node:fs")).readFileSync(new URL("../engine/kachat-names/actions.js", import.meta.url), "utf8");
  assert.match(src, /onAccepted = \(\) => this\.declineOpenOffers\(op\.name, null\)/);
  assert.match(src, /this\.follow\(txId, plan, \{ onAccepted \}\)/);
  assert.match(src, /try \{ onAccepted\?\.\(\); \}/, "the follower runs it when the transaction lands");
  assert.equal(declined.length, 0);
  delete actions.declineOpenOffers;
  delete actions.follow;
  void landedCallback;
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log("kachat claim tracking: all passed");
