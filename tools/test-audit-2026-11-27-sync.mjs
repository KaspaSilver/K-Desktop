// node tools/test-audit-2026-11-27-sync.mjs - audit 2026-11-27, three things that went missing
// for good after one bad moment:
//   1. Group messages (engine/group-store.js syncGroups): a pass saved each group's per-member
//      cursors as soon as that group was decoded, but the app only stores the decoded messages
//      once the pass returns. A pass discarded for an account change had already moved the
//      cursors past messages nobody stored. Now the advances are staged and written only when the
//      pass ends normally for the account it started for.
//   2. Web Push (ui/web-push.js webPushForgetAccount): removing an account only looked at this
//      network's saved registration; one on the other network's push server (same browser
//      subscription) kept ringing. And public/sw-push.js drops wallet pushes (Received KAS, a
//      .kachat name event, KaPost activity) that are for another account than the mirrored one.
//   3. .kachat news (ui/kachat-names-notifier.js): a failed history lookup for a name that left
//      the wallet read as "nothing happened" and the snapshot forgot the name, so the sale was
//      never told. Now the name is kept and asked about again; the same for a closed offer.
// The real GroupManager, web-push module and worker script run on in-memory stubs (localStorage,
// IndexedDB, fetch); the notifier check runs from its own source. Nothing leaves the machine.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// ---- browser stubs (shared by the modules below) -----------------------------------------------
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
}
const storage = new MemoryStorage();
const noop = () => {};
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
define("localStorage", storage);
define("window", globalThis);
// No PushManager: web-push's own sync rounds stop at "unsupported" and stay out of the way.
define("Notification", { permission: "granted" });
define("navigator", { userAgent: "node", platform: "node", maxTouchPoints: 0, serviceWorker: { addEventListener: noop, getRegistration: async () => null, register: async () => null, ready: new Promise(noop) } });
define("document", { visibilityState: "hidden", addEventListener: noop });
define("matchMedia", () => ({ matches: false }));
globalThis.addEventListener = noop;
// A minimal IndexedDB: one object store, values kept as they are (the device key is a CryptoKey).
const idb = new Map();
const later = (fn) => setTimeout(fn, 0);
define("indexedDB", {
  open() {
    const request = {};
    later(() => {
      request.result = {
        objectStoreNames: { contains: () => true },
        createObjectStore: noop,
        close: noop,
        transaction() {
          const tx = {
            objectStore: () => ({
              get(key) { const r = {}; later(() => { r.result = idb.get(key); r.onsuccess?.(); }); return r; },
              put(value, key) { idb.set(key, value); },
              delete(key) { idb.delete(key); },
            }),
          };
          later(() => tx.oncomplete?.());
          return tx;
        },
      };
      request.onsuccess?.();
    });
    return request;
  },
});
const fetchCalls = [];
let unregisterStatus = 200;
define("fetch", async (url, init = {}) => {
  const text = String(url);
  fetchCalls.push({ url: text, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  if (text.endsWith("/v1/push/challenge")) { const now = Date.now(); return json({ nonce: "nonce", issued_at_ms: now, expires_at_ms: now + 60_000 }); }
  if (text.endsWith("/v1/push/unregister")) return json(unregisterStatus === 200 ? {} : { error: "down" }, unregisterStatus);
  return json({}, 404);
});

const G = await import("../engine/group.js");
const { GroupManager } = await import("../engine/group-store.js");
const webPush = await import("../ui/web-push.js");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function waitFor(cond, what) {
  for (let i = 0; i < 2000; i += 1) { if (cond()) return; await new Promise((r) => setImmediate(r)); }
  throw new Error(`timed out waiting for ${what}`);
}

// ==== 1. group cursors ==========================================================================
const KEY = (n) => n.toString(16).padStart(64, "0");
const SELF = { address: "kaspa:qzselfaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", key: KEY(0x51) };
const ADMIN = { address: "kaspa:qzadminbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", key: KEY(0xad) };
const OTHER = { address: "kaspa:qzothercccccccccccccccccccccccccccccccccccccccccccccccccccc", key: KEY(0x0c) };
const NEXT = "kaspa:qznextaccountdddddddddddddddddddddddddddddddddddddddddddd";
const PUB = new Map([SELF, ADMIN, OTHER].map((w) => [w.address, G.bytesToHex(G.xOnlyPublicKey(w.key))]));

// Which scan calls wait, and for what (null: none).
let scanGate = null;
let gateAfter = 0;
const scanCalls = [];
const engine = {
  address: SELF.address,
  privateKeyHex: SELF.key,
  log() {},
  groupIndexerUrl: () => "https://indexer.stub.test",
  async xOnlyPubKeyForAddress(address) { const pub = PUB.get(address); if (!pub) throw new Error("no key"); return pub; },
  async encryptGroupControl() { throw new Error("not used"); },
  async decryptGroupControl() { throw new Error("not ours"); },
  async sendGroupPayload() { return { txids: ["tx"] }; },
  async scanGroupControlByRecipientPage() { return { rows: [], nextCursor: null, rawCount: 0 }; },
  async scanGroupMessagesSince() { const e = new Error("no /since"); e.unsupported = true; throw e; },
  async scanGroupMessages(blindedHex, cursor) {
    scanCalls.push({ blindedHex, cursor });
    if (scanGate && scanCalls.length > gateAfter) await scanGate.promise;
    // One unreadable row per stream: decodes to nothing, but carries the stream's newest cursor.
    return [{ txId: `scan-${blindedHex.slice(0, 8)}-${cursor || "start"}`, blockTime: 1000, cursor: `${cursor || "start"}>next`, payloadString: "junk" }];
  },
};
function memberGroup(mgr, name) {
  const seed = G.generateGroupSeed();
  const groupId = G.deriveGroupId(seed);
  const gid = G.bytesToHex(groupId);
  assert.ok(mgr.importGroupRecord({
    groupId: gid, name, isAdmin: false,
    adminAddress: ADMIN.address, adminSigningPub: PUB.get(ADMIN.address),
    groupRootEpoch: G.bytesToHex(G.deriveGroupRootEpoch(seed, groupId, 0)),
    blindingKey: G.bytesToHex(G.deriveBlindingKey(seed, groupId)),
    currentEpoch: 0,
    members: [ADMIN, SELF, OTHER].map((w) => ({ address: w.address, xOnlyPubKeyHex: PUB.get(w.address), isAdmin: w === ADMIN })),
  }), "group imported");
  return gid;
}
function resetGroups() {
  storage.clear();
  scanGate = null; gateAfter = 0;
  scanCalls.length = 0;
  engine.address = SELF.address;
}
const cursorsOf = (mgr, gid) => {
  const was = engine.address;
  engine.address = SELF.address;
  try { return { ...(mgr.getGroup(gid)?.cursors || {}) }; } finally { engine.address = was; }
};

test("group sync: a completed pass writes its cursors, and the next pass reads on from them", async () => {
  resetGroups();
  const mgr = new GroupManager(engine);
  const gid = memberGroup(mgr, "One");
  const result = await mgr.syncGroups();
  assert.equal(result.skipped, undefined);
  const cursors = cursorsOf(mgr, gid);
  assert.equal(Object.keys(cursors).length, 3, "one cursor per member stream");
  assert.ok(Object.values(cursors).every((c) => c === "start>next"));
  scanCalls.length = 0;
  mgr._sincePasses = 0;
  await mgr.syncGroups();
  assert.ok(scanCalls.length === 3 && scanCalls.every((c) => c.cursor === "start>next"), JSON.stringify(scanCalls));
});

test("group sync: an account change after the first group was decoded keeps every pre-pass cursor", async () => {
  resetGroups();
  const mgr = new GroupManager(engine);
  const first = memberGroup(mgr, "First");
  const second = memberGroup(mgr, "Second");
  // The first group's three streams answer; the second group's wait, and the account changes then.
  scanGate = deferred();
  gateAfter = 3;
  const pass = mgr.syncGroups();
  await waitFor(() => scanCalls.length > 3, "the second group's scans to start");
  engine.address = NEXT;
  scanGate.resolve();
  const result = await pass;
  assert.equal(result.skipped, "account-changed");
  assert.deepEqual(result.messages, []);
  // Before the fix the first group's cursors were already saved here, past rows nobody stored.
  assert.deepEqual(cursorsOf(mgr, first), {}, "the decoded group's cursors did not move");
  assert.deepEqual(cursorsOf(mgr, second), {});
  // Back on the account: the next pass reads both groups from where they were.
  engine.address = SELF.address;
  scanGate = null;
  scanCalls.length = 0;
  const again = await mgr.syncGroups();
  assert.equal(again.skipped, undefined);
  assert.equal(scanCalls.length, 6);
  assert.ok(scanCalls.every((c) => c.cursor === null), "every stream read from its start again");
  assert.equal(Object.keys(cursorsOf(mgr, first)).length, 3, "and now the cursors move");
});

test("group sync: switched away and back within one pass is still discarded (no cursors, skipped)", async () => {
  resetGroups();
  const mgr = new GroupManager(engine);
  const first = memberGroup(mgr, "First");
  memberGroup(mgr, "Second");
  scanGate = deferred();
  gateAfter = 3;
  const pass = mgr.syncGroups();
  await waitFor(() => scanCalls.length > 3, "the second group's scans to start");
  engine.address = NEXT;
  await new Promise((r) => setImmediate(r));
  scanGate.resolve();
  // The pass sees the other account once its scans return; the account is back before it ends.
  await waitFor(() => scanCalls.length === 6, "the scans to answer");
  await new Promise((r) => setImmediate(r));
  engine.address = SELF.address;
  const result = await pass;
  assert.equal(result.skipped, "account-changed", "an empty result here would let the app settle sends early");
  assert.deepEqual(cursorsOf(mgr, first), {});
});

test("group sync: a pass that throws leaves the cursors where they were", async () => {
  resetGroups();
  const mgr = new GroupManager(engine);
  const gid = memberGroup(mgr, "One");
  const original = mgr._takeMemberStatuses;
  mgr._takeMemberStatuses = () => { throw new Error("boom"); };
  try { await assert.rejects(mgr.syncGroups(), /boom/); } finally { mgr._takeMemberStatuses = original; }
  assert.deepEqual(cursorsOf(mgr, gid), {});
  assert.equal(mgr._syncInFlight, null, "the next pass may start");
});

test("group sync: a cursor rewind during the pass wins over the pass's advances", async () => {
  resetGroups();
  const mgr = new GroupManager(engine);
  const gid = memberGroup(mgr, "One");
  scanGate = deferred();
  const pass = mgr.syncGroups();
  await waitFor(() => scanCalls.length === 3, "the scans to start");
  await mgr.rewindGroupCursors(500);
  scanGate.resolve();
  const result = await pass;
  assert.equal(result.skipped, undefined, "the messages still go to the app");
  assert.deepEqual(cursorsOf(mgr, gid), {}, "the next pass re-reads from the rewound place");
});

// ==== 2a. Web Push: a removed account's registration on every network ============================
const A = "kaspa:qqaccounta";
const B = "kaspa:qqaccountb";
const MAIN_KEY = "kachat-web-push-registration-v1:mainnet";
const TEST_KEY = "kachat-web-push-registration-v1:testnet";
const MAIN_BASE = "https://push.main.example";
const TEST_BASE = "https://push.test.example";
const ENDPOINT = "https://web.push.apple.com/shared-subscription";
webPush.initWebPush({
  network: () => "mainnet",
  endpoint: () => MAIN_BASE,
  enabled: () => true,
  wallet: () => null,
  collect: async () => ({}),
  mirror: () => ({}),
  focusKey: () => "",
  log: noop,
  onStatus: noop,
});
const saveReg = (key, value) => storage.setItem(key, JSON.stringify({ endpoint: ENDPOINT, fingerprint: "f", at: Date.now(), ...value }));
const unregisters = () => fetchCalls.filter((c) => c.url.endsWith("/v1/push/unregister"));
function resetPush() {
  storage.clear();
  fetchCalls.length = 0;
  unregisterStatus = 200;
}

test("web push: removing an account registered only on the other network unregisters it there", async () => {
  resetPush();
  saveReg(MAIN_KEY, { base: MAIN_BASE, wallet: B });
  saveReg(TEST_KEY, { base: TEST_BASE, wallet: A.toUpperCase() });
  await webPush.webPushForgetAccount(A);
  const calls = unregisters();
  assert.equal(calls.length, 1, JSON.stringify(fetchCalls));
  assert.equal(calls[0].url, `${TEST_BASE}/v1/push/unregister`, "at the other network's push server");
  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].body.device_token, ENDPOINT);
  assert.equal(calls[0].body.auth.wallet_address, "", "with the device key: the removed account's key is gone");
  assert.ok(calls[0].body.auth.device_auth?.signature, "the device proof is there");
  assert.equal(storage.getItem(TEST_KEY), null, "its saved registration is gone");
  assert.equal(JSON.parse(storage.getItem(MAIN_KEY)).wallet, B, "this network's other account keeps its own");
});

test("web push: removing the account registered on both networks clears both", async () => {
  resetPush();
  saveReg(MAIN_KEY, { base: MAIN_BASE, wallet: A });
  saveReg(TEST_KEY, { base: TEST_BASE, wallet: A });
  await webPush.webPushForgetAccount(A);
  assert.deepEqual(unregisters().map((c) => c.url).sort(), [`${MAIN_BASE}/v1/push/unregister`, `${TEST_BASE}/v1/push/unregister`]);
  assert.equal(storage.getItem(MAIN_KEY), null);
  assert.equal(storage.getItem(TEST_KEY), null);
});

test("web push: another account's registrations are left alone", async () => {
  resetPush();
  saveReg(MAIN_KEY, { base: MAIN_BASE, wallet: B });
  saveReg(TEST_KEY, { base: TEST_BASE, wallet: B });
  await webPush.webPushForgetAccount(A);
  assert.equal(unregisters().length, 0);
  assert.ok(storage.getItem(MAIN_KEY) && storage.getItem(TEST_KEY));
});

test("web push: an unregister that fails on the other network is kept, marked, to be moved later", async () => {
  resetPush();
  unregisterStatus = 500;
  saveReg(TEST_KEY, { base: TEST_BASE, wallet: A });
  await webPush.webPushForgetAccount(A);
  const kept = JSON.parse(storage.getItem(TEST_KEY));
  assert.equal(kept.removeFailures, 1);
  assert.equal(kept.forgotten, true);
});

test("web push: the same server and endpoint as this network's other account: only the saved line goes", async () => {
  resetPush();
  saveReg(MAIN_KEY, { base: MAIN_BASE, wallet: B });
  saveReg(TEST_KEY, { base: MAIN_BASE, wallet: A });
  await webPush.webPushForgetAccount(A);
  assert.equal(unregisters().length, 0, "B's registration on that server is not removed with it");
  assert.equal(storage.getItem(TEST_KEY), null);
});

// ==== 2b. the worker: wallet pushes for another account ===========================================
const sandbox = { console, BigInt, Math, JSON, String, Number, Array, Object, RegExp, Set, Map };
sandbox.self = sandbox;
vm.runInNewContext(readFileSync(join(root, "public/sw-push.js"), "utf8"), sandbox);
const { notificationFromPush } = sandbox.KaChatPushMap;
const ME = "kaspa:qqmeaccount";
const mirror = {
  account: ME, unit: "KAS", sound: true, names: {}, quiet: [], off: [], loud: [], blocked: [],
  addressLabels: { [ME]: "Chatting address", "kaspa:qqspendaddr": "Spending address" },
};

test("worker: Received KAS for this account's own or watched address rings", () => {
  assert.equal(notificationFromPush({ type: "address_activity", address: ME, amount_kas: "1", tx_id: "t" }, mirror).suppress, false);
  assert.equal(notificationFromPush({ type: "address_activity", address: "kaspa:qqspendaddr", amount_kas: "1", tx_id: "t" }, mirror).suppress, false);
});

test("worker: Received KAS for an address this account doesn't watch, or on the other network, is dropped", () => {
  assert.equal(notificationFromPush({ type: "address_activity", address: "kaspa:qqremovedaccount", amount_kas: "1", tx_id: "t" }, mirror).suppress, true);
  assert.equal(notificationFromPush({ type: "address_activity", address: "kaspatest:qqremoved", amount_kas: "1", tx_id: "t" }, mirror).suppress, true);
  // an older app mirrored no labels: only the network is judged
  const older = { ...mirror, addressLabels: undefined };
  assert.equal(notificationFromPush({ type: "address_activity", address: "kaspa:qqsomething", amount_kas: "1", tx_id: "t" }, older).suppress, false);
});

test("worker: a name event or KaPost activity naming another account is dropped; its own rings", () => {
  for (const field of ["account", "primary_address", "wallet_address", "recipient"]) {
    assert.equal(notificationFromPush({ type: "name_event", title: "Sold", body: "b", dedup: "d", [field]: "kaspa:qqremovedaccount" }, mirror).suppress, true, field);
    assert.equal(notificationFromPush({ type: "kaposts", body: "liked your post", [field]: "kaspa:qqremovedaccount" }, mirror).suppress, true, field);
    assert.equal(notificationFromPush({ type: "name_event", title: "Sold", body: "b", dedup: "d", [field]: ME.toUpperCase() }, mirror).suppress, false, field);
  }
  // a push that doesn't say whose it is: as before
  assert.equal(notificationFromPush({ type: "name_event", title: "Sold", body: "b", dedup: "d" }, mirror).suppress, false);
  assert.equal(notificationFromPush({ type: "kaposts", body: "liked your post" }, mirror).suppress, false);
});

// ==== 3. .kachat news: a failed history lookup is asked again ======================================
const notifierSrc = readFileSync(join(root, "ui", "kachat-names-notifier.js"), "utf8");
const fnStart = notifierSrc.indexOf("export async function checkKachatNamesNews(");
assert.ok(fnStart >= 0, "checkKachatNamesNews in the source");
let depth = 0;
let fnEnd = -1;
for (let i = notifierSrc.indexOf("{", fnStart); i < notifierSrc.length; i += 1) {
  if (notifierSrc[i] === "{") depth += 1;
  else if (notifierSrc[i] === "}") { depth -= 1; if (depth === 0) { fnEnd = i + 1; break; } }
}
const checkCode = notifierSrc.slice(fnStart, fnEnd).replace(/^export /, "");
function newsChecker({ snapshots, history, recorded }) {
  const actions = {
    myAddress: "kaspatest:qa", myKey: new Uint8Array([1]),
    ownNamesAndOffers: async () => ({ names: [], offers: [] }),
    isOwnKey: () => false, selfClosedOffers: new Set(),
  };
  const registry = { manifest: { params: {} }, graceMs: 1n, offersFor: async () => [], history };
  const make = new Function("env", `
    const kachatNames = () => env.rt;
    const deps = env.deps;
    let checking = false;
    let lastCheckAt = 0;
    const Status = { active: "active", grace: "grace" };
    const bytesEqual = () => false;
    const updateReminders = () => {};
    const dayString = String;
    const kas = String;
    const KAS_UNIT = "KAS";
    const kachatNameDisplay = (n) => String(n || "");
    const readSnapshot = (w) => { const t = env.snapshots.get(w); if (!t) return null; const j = JSON.parse(t);
      return { names: j.names, offersOnMine: new Set(j.offersOnMine), myOffers: j.myOffers }; };
    const writeSnapshot = (w, s) => env.snapshots.set(w, JSON.stringify({ names: s.names, offersOnMine: [...s.offersOnMine], myOffers: s.myOffers }));
    ${checkCode}
    return checkKachatNamesNews;
  `);
  return make({ rt: { registry, actions }, deps: { record: (e) => recorded.push(e), log: noop }, snapshots });
}

test(".kachat news: a sold name whose history lookup fails is kept, then told once when it answers", async () => {
  const snapshots = new Map([["kaspatest:qa", JSON.stringify({ names: { alice: { expiresAt: "1", renewNoted: true } }, offersOnMine: [], myOffers: {} })]]);
  const recorded = [];
  let fail = true;
  const history = async () => { if (fail) throw new Error("indexer hiccup"); return [{ op: "sale", txId: "t1", price: null }]; };
  await newsChecker({ snapshots, history, recorded })();
  assert.equal(recorded.length, 0);
  assert.deepEqual(JSON.parse(snapshots.get("kaspatest:qa")).names.alice, { expiresAt: "1", renewNoted: true }, "carried as it was");
  fail = false;
  await newsChecker({ snapshots, history, recorded })();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].id, "kachat-sold-t1");
  assert.equal(recorded[0].title, "alice sold");
  assert.deepEqual(JSON.parse(snapshots.get("kaspatest:qa")).names, {}, "told: the name leaves the snapshot");
  await newsChecker({ snapshots, history, recorded })();
  assert.equal(recorded.length, 1, "and is not told again");
});

test(".kachat news: a closed offer whose history lookup fails is asked about again, not told as returned", async () => {
  const snapshots = new Map([["kaspatest:qa", JSON.stringify({ names: {}, offersOnMine: [], myOffers: { o1: "bob" } })]]);
  const recorded = [];
  let fail = true;
  const history = async () => { if (fail) throw new Error("indexer hiccup"); return [{ op: "offer_decline", txId: "t2" }]; };
  await newsChecker({ snapshots, history, recorded })();
  assert.equal(recorded.length, 0, "no guess at what happened to it");
  assert.deepEqual(JSON.parse(snapshots.get("kaspatest:qa")).myOffers, { o1: "bob" });
  fail = false;
  await newsChecker({ snapshots, history, recorded })();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].title, "Offer on bob declined");
  assert.deepEqual(JSON.parse(snapshots.get("kaspatest:qa")).myOffers, {});
  await newsChecker({ snapshots, history, recorded })();
  assert.equal(recorded.length, 1, "told once");
});

let passed = 0;
for (const { name, fn } of tests) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); console.error(error); process.exit(1); }
}
console.log(`\n${passed} passed`);
process.exit(0);
