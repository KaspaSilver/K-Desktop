// node tools/test-kachat-only-names.mjs - .kachat is the only name service (K 518fdc8c, owner's call
// 2026-11-23): KNS (.kas), dotk (.k) and Kaspa Names (.kaspa) are gone, a typed name gets one
// .kachat answer with no "Other domains", and the screens say "Usernames" (audit 2026-11-24 #36).
// What stays of KNS is the recovery that finishes unfinished reveals and transfers, so coins a
// commit locked come back (audit 2026-11-24 #4) - run here against the real Kaspa WASM and an
// in-memory node. Nothing leaves the machine.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(repo, ...p), "utf8");
const NS = await import("../engine/name-services.js");
const R = await import("../engine/kns-reveal-recovery.js");
const { KaspaEngine } = await import("../engine/index.js");
const kaspa = await import("../kaspa/kaspa.js");
await kaspa.default({ module_or_path: readFileSync(join(repo, "kaspa/kaspa_bg.wasm")) });

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

const KAS = 100_000_000n;
const ownerKey = new kaspa.PrivateKey("5a".padEnd(62, "0") + "4d");
const owner = ownerKey.toAddress("mainnet").toString();
const otherKey = new kaspa.PrivateKey("5a".padEnd(62, "0") + "4f");
const recipient = new kaspa.PrivateKey("5a".padEnd(62, "0") + "4e").toAddress("mainnet").toString();

// --- resolution ------------------------------------------------------------------------------

await test("one service: .kachat", () => {
  assert.deepEqual([...NS.NAME_SERVICE_TLDS], ["kachat"]);
  assert.deepEqual(Object.keys(NS.NAME_SERVICES), ["kachat"]);
  assert.equal(NS.NAME_SERVICES.kachat.serviceName, "KaChat Names");
  for (const gone of ["RESOLUTION_ORDER", "apiBaseURL", "dotkCanonical", "kaspaNamesCanonical", "kasCanonical", "listOwnedNames", "ownedNamesForAddresses", "fetchDotkOwnedNames"]) {
    assert.equal(NS[gone], undefined, `${gone} is gone`);
  }
});

await test("a typed name is read as .kachat only; another service's ending is not a name", () => {
  assert.deepEqual(NS.splitTypedName(" Bob.KACHAT "), { label: "Bob", tld: "kachat" });
  assert.deepEqual(NS.splitTypedName("bob.kas"), { label: "bob.kas", tld: null });
  assert.equal(NS.looksLikeName("bob"), true);
  assert.equal(NS.looksLikeName("bob.kachat"), true);
  for (const other of ["bob.kas", "bob.k", "bob.kaspa"]) assert.equal(NS.looksLikeName(other), false, other);
  assert.equal(NS.looksLikeName("kaspa:qqabc"), false);
});

await test("resolution asks the registry once and gives one answer, no Other domains", async () => {
  const asked = [];
  const results = await NS.resolveEverywhere("Alice.kachat", { resolveKachat: async (name) => { asked.push(name); return owner; }, resolveKas: async () => { throw new Error("never asked"); } });
  assert.deepEqual(asked, ["alice"]);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], { tld: "kachat", name: "alice.kachat", address: owner, state: "resolved" });
  assert.equal(NS.primary(results)?.address, owner);
  assert.deepEqual(await NS.resolveEverywhere("", { resolveKachat: async () => owner }), []);
  assert.deepEqual(await NS.resolveEverywhere("no spaces allowed", { resolveKachat: async () => owner }), []);
});

await test("not found reads \"No username found\"; a failed lookup says it couldn't look", async () => {
  const none = await NS.resolveEverywhere("ghost", { resolveKachat: async () => null });
  assert.equal(NS.primary(none), null);
  assert.equal(NS.notFoundMessage("ghost", none), "No username found");
  const down = await NS.resolveEverywhere("ghost", { resolveKachat: async () => { throw new Error("down"); } });
  assert.equal(NS.notFoundMessage("ghost", down), "Couldn't look up ghost.kachat right now. Try again in a moment.");
});

await test("the engine resolves and finds owners through the .kachat hooks only", async () => {
  const engine = new KaspaEngine({ log: () => {} });
  engine.setKachatNameHooks({ resolve: async () => owner, ownsAny: async (a) => a === owner, held: async (a) => (a === owner ? ["alice"] : []) });
  const { results, resolution } = await engine.lookUpName("alice");
  assert.equal(results.length, 1);
  assert.deepEqual({ ownerAddress: resolution.ownerAddress, domain: resolution.domain, tld: resolution.tld }, { ownerAddress: owner, domain: "alice.kachat", tld: "kachat" });
  assert.deepEqual([...await engine.addressesOwningAnyName([owner, recipient])], [owner]);
  assert.equal(await engine.ownsAnyName(recipient), false);
  assert.deepEqual([...(await engine.kachatNamesFor([owner, recipient])).keys()], [owner]);
  const proto = Object.getOwnPropertyNames(KaspaEngine.prototype);
  const kns = proto.filter((n) => /kns/i.test(n));
  assert.deepEqual(kns, ["resumeKnsRevealRecovery"], "the only KNS method left is the recovery");
  for (const gone of ["listOtherServiceNames", "otherServiceNamesFor", "confirmSpend"]) assert.ok(!proto.includes(gone), gone);
});

// --- the reveal recovery -----------------------------------------------------------------------

let txCounter = 0;
const fakeTxid = () => (++txCounter).toString(16).padStart(64, "0");
function stubNode() {
  const node = {
    utxos: new Map(), submitted: [], refuse: null, lookups: 0,
    async getUtxosByAddresses(addresses) {
      node.lookups += 1;
      const list = (Array.isArray(addresses) ? addresses : addresses?.addresses || []).map(String);
      return { entries: list.flatMap((a) => node.utxos.get(a) || []) };
    },
    async submitTransaction({ transaction }) {
      const refusal = node.refuse?.(transaction);
      if (refusal) throw new Error(refusal);
      node.submitted.push(transaction);
      return { transactionId: transaction.id };
    },
  };
  return node;
}
function engineOn(node, key = ownerKey) {
  return { kaspa, privateKey: key, address: key.toAddress("mainnet").toString(), log: () => {}, async connect() {}, async withRpc(fn) { return fn(node); } };
}
function commitCoin(address, scriptPublicKey, amount, txid = fakeTxid(), index = 0) {
  return { address, outpoint: { transactionId: txid, index }, amount, scriptPublicKey, blockDaaScore: 1000n, isCoinbase: false };
}
const hour = 3_600_000;

await test("the reveal builder spends a commit: one input, commit minus fee, the redeem script in the signature", async () => {
  const node = stubNode();
  const payload = R.buildTransferPayload("asset-1", recipient);
  const redeem = R.buildKnsRedeemScript(kaspa, R.xOnlyPublicKeyHexFromPrivateKey(ownerKey), payload);
  assert.ok(redeem.commitAddressString.startsWith("kaspa:p"), "a P2SH commit address");
  assert.equal(R.knsPayloadFromRedeemScript(redeem.redeemScriptHex), payload, "the payload reads back out of the script");
  assert.equal(R.knsPayloadFromRedeemScript("00ff"), null);
  const reveal = await R.buildAndSubmitKnsReveal({
    engine: engineOn(node), commitTxId: fakeTxid(), commitOutputIndex: 0, commitAmountSompi: 2n * KAS,
    commitScriptPublicKey: redeem.commitScriptPublicKey, builder: redeem.builder, revealTargetAddress: owner, revealAmountSompi: 2n * KAS,
  });
  const tx = node.submitted[0];
  assert.equal(tx.inputs.length, 1);
  assert.equal(tx.outputs.length, 1);
  assert.equal(BigInt(tx.outputs[0].value), 2n * KAS - reveal.fee);
  assert.ok(String(tx.inputs[0].signatureScript).toLowerCase().includes(redeem.redeemScriptHex.toLowerCase()));
});

const transferKey = R.pendingKnsTransferKey();
function fileTransfer(record) {
  const map = JSON.parse(store.get(transferKey) || "{}");
  map[record.assetId] = record;
  store.set(transferKey, JSON.stringify(map));
}
function transferRecord(assetId, fields = {}) {
  const redeem = R.buildKnsRedeemScript(kaspa, R.xOnlyPublicKeyHexFromPrivateKey(ownerKey), R.buildTransferPayload(assetId, recipient));
  return {
    redeem,
    record: {
      kind: "transfer", version: 1, network: "mainnet", assetId, domain: `${assetId}.kas`, recipient,
      source: { kind: "identity", address: owner }, commitAddress: redeem.commitAddressString,
      commitAmountSompi: String(2n * KAS), commitTxId: null, commitOutputIndex: 0, revealTargetAddress: owner,
      revealPriorityFeeSompi: "2000000", status: "reveal-failed", createdAt: Date.now() - hour, ...fields,
    },
  };
}
const signerFor = (record) => (record.source?.address === owner ? { privateKey: ownerKey, address: owner } : null);

await test("a transfer whose commit went out is finished: the reveal spends it and the 2 KAS come back", async () => {
  store.clear();
  const node = stubNode();
  const { redeem, record } = transferRecord("asset-a");
  const coin = commitCoin(redeem.commitAddressString, redeem.commitScriptPublicKey, 2n * KAS);
  node.utxos.set(redeem.commitAddressString, [coin]);
  fileTransfer({ ...record, commitTxId: coin.outpoint.transactionId });
  assert.equal(await R.resumePendingKnsTransfers({ engine: engineOn(node), signerFor }), 1);
  const tx = node.submitted[0];
  assert.equal(tx.inputs[0].previousOutpoint.transactionId, coin.outpoint.transactionId);
  assert.equal(tx.outputs[0].scriptPublicKey.script ?? tx.outputs[0].scriptPublicKey, kaspa.payToAddressScript(owner).script, "back to the sender's change address");
  assert.ok(BigInt(tx.outputs[0].value) > 19n * KAS / 10n, "less only the fee");
  assert.equal(store.has(transferKey), false, "the record is cleared");
});

await test("a commit still only in the mempool: the recorded txid is revealed", async () => {
  store.clear();
  const node = stubNode();
  const { record } = transferRecord("asset-b", { commitTxId: fakeTxid(), commitOutputIndex: 1 });
  fileTransfer(record);
  assert.equal(await R.resumePendingKnsTransfers({ engine: engineOn(node), signerFor }), 1);
  assert.equal(node.submitted[0].inputs[0].previousOutpoint.transactionId, record.commitTxId);
  assert.equal(Number(node.submitted[0].inputs[0].previousOutpoint.index), 1);
  assert.equal(store.has(transferKey), false);
});

await test("an earlier reveal already in: settled and cleared, nothing new sent", async () => {
  store.clear();
  const node = stubNode();
  node.refuse = () => "output already spent by transaction in the mempool";
  const { record } = transferRecord("asset-c", { commitTxId: fakeTxid() });
  fileTransfer(record);
  assert.equal(await R.resumePendingKnsTransfers({ engine: engineOn(node), signerFor }), 0);
  assert.equal(node.submitted.length, 0);
  assert.equal(store.has(transferKey), false);
});

await test("a refused reveal keeps the record for the next look; another account's or a fresh one is left alone", async () => {
  store.clear();
  const node = stubNode();
  node.refuse = () => "transaction fee too low (stub)";
  const { redeem, record } = transferRecord("asset-d");
  node.utxos.set(redeem.commitAddressString, [commitCoin(redeem.commitAddressString, redeem.commitScriptPublicKey, 2n * KAS)]);
  fileTransfer(record);
  fileTransfer({ ...transferRecord("asset-e").record, source: { kind: "identity", address: recipient } });
  fileTransfer({ ...transferRecord("asset-f").record, createdAt: Date.now() });
  assert.equal(await R.resumePendingKnsTransfers({ engine: engineOn(node), signerFor }), 0);
  const left = JSON.parse(store.get(transferKey));
  assert.deepEqual(Object.keys(left).sort(), ["asset-d", "asset-e", "asset-f"]);
  assert.equal(left["asset-d"].status, "reveal-failed");
  assert.equal(left["asset-d"].commitSeen, true, "the commit was seen unspent");
});

await test("a commit seen and then gone twice is dropped; one never seen waits 30 days", async () => {
  store.clear();
  const node = stubNode();
  fileTransfer(transferRecord("asset-g", { commitSeen: true }).record);
  fileTransfer(transferRecord("asset-h").record);
  await R.resumePendingKnsTransfers({ engine: engineOn(node), signerFor });
  let left = JSON.parse(store.get(transferKey));
  assert.equal(left["asset-g"].emptyChecks, 1, "one empty look is not enough");
  await R.resumePendingKnsTransfers({ engine: engineOn(node), signerFor });
  left = JSON.parse(store.get(transferKey));
  assert.deepEqual(Object.keys(left), ["asset-h"], "the spent one goes, the never-seen young one stays");
  fileTransfer({ ...left["asset-h"], createdAt: Date.now() - 31 * 24 * hour });
  await R.resumePendingKnsTransfers({ engine: engineOn(node), signerFor });
  assert.equal(store.has(transferKey), false, "30 days old and missing twice: dropped");
  assert.equal(node.submitted.length, 0);
});

await test("a reveal owed by a registration or profile edit is finished, the coins paid where they always would be", async () => {
  store.clear();
  const node = stubNode();
  const payloadJson = JSON.stringify({ op: "addProfile", id: "asset-x", key: "bio", value: "hi" });
  const redeem = R.buildKnsRedeemScript(kaspa, R.xOnlyPublicKeyHexFromPrivateKey(ownerKey), payloadJson);
  node.utxos.set(redeem.commitAddressString, [commitCoin(redeem.commitAddressString, redeem.commitScriptPublicKey, 2n * KAS)]);
  store.set(`kachat-account-data-v1:${owner}:kachat-kns-pending-reveals-v1`, JSON.stringify([{
    id: redeem.commitAddressString, kind: "profile", payloadJson, commitAddressString: redeem.commitAddressString,
    commitAmountSompi: String(2n * KAS), revealTargetAddress: owner, revealAmountSompi: String(KAS), createdAt: Date.now() - hour,
  }]));
  assert.equal(await R.resumePendingKnsReveals({ engine: engineOn(node) }), 1);
  assert.equal(R.pendingKnsReveals(owner).length, 0);
});

await test("the old single pending commit (before Build 276) is adopted by the key that made it, then finished", async () => {
  store.clear();
  const node = stubNode();
  const payloadJson = JSON.stringify({ op: "create", p: "domain", v: "alice" });
  const redeem = R.buildKnsRedeemScript(kaspa, R.xOnlyPublicKeyHexFromPrivateKey(ownerKey), payloadJson);
  const coin = commitCoin(redeem.commitAddressString, redeem.commitScriptPublicKey, 2n * KAS);
  node.utxos.set(redeem.commitAddressString, [coin]);
  const legacy = { kind: "domain", label: "alice", commitTxId: coin.outpoint.transactionId, commitOutputIndex: 0, commitAmountSompi: String(2n * KAS), redeemScriptHex: redeem.redeemScriptHex, revealTargetAddress: owner, revealAmountSompi: String(KAS), createdAt: Date.now() - hour };
  store.set(R.LEGACY_PENDING_COMMIT_KEY, JSON.stringify(legacy));
  // another account's key does not match its script: left for that account
  assert.equal(await R.resumePendingKnsReveals({ engine: engineOn(node, otherKey) }), 0);
  assert.ok(store.has(R.LEGACY_PENDING_COMMIT_KEY));
  assert.equal(await R.resumePendingKnsReveals({ engine: engineOn(node) }), 1);
  assert.equal(store.has(R.LEGACY_PENDING_COMMIT_KEY), false);
  assert.equal(node.submitted[0].inputs[0].previousOutpoint.transactionId, coin.outpoint.transactionId);
});

await test("the recovery starts nothing new and is wired to wallet load and the app-active sweep", () => {
  const src = read("engine", "kns-reveal-recovery.js");
  assert.doesNotMatch(src, /sendKaspa|sendKnsCommitTransaction|inscribeDomain|submitProfileField|transferDomain|uploadKnsProfileImage|setKnsPrimaryDomain/);
  const app = read("ui", "app.js");
  assert.match(app, /setTimeout\(\(\) => \{ resumeKnsRevealRecovery\(\); \}, 3000\)/, "on wallet load");
  assert.match(app, /lastKnsRevealCheckAt = Date\.now\(\);\n\s+resumeKnsRevealRecovery\(\);/, "now and then while the app is in use");
  assert.match(app, /engine\.resumeKnsRevealRecovery\(\{\n\s+mnemonic: activeAccountMnemonic\(\) \|\| null,/, "with the seed for spending-address transfers");
  assert.match(read("engine", "index.js"), /resumePendingKnsReveals\(\{ engine: this, log: this\.log \}\);\n\s+const transfers = await resumePendingKnsTransfers\(/);
});

// --- what is gone, and the Usernames wording ----------------------------------------------------

await test("no KNS, dotk or Kaspa Names code and no Other domains left", () => {
  assert.equal(existsSync(join(repo, "engine", "kns.js")), false);
  assert.equal(existsSync(join(repo, "engine", "kns-write.js")), false);
  const files = [
    ...readdirSync(join(repo, "ui")).filter((f) => f.endsWith(".js") || f.endsWith(".css")).map((f) => ["ui", f]),
    ...readdirSync(join(repo, "engine")).filter((f) => f.endsWith(".js")).map((f) => ["engine", f]),
    ["index.html"],
  ];
  for (const parts of files) {
    const text = read(...parts);
    const name = parts.join("/");
    assert.doesNotMatch(text, /Other domains|otherDomainsHtml|pickOtherDomain/i, `${name}: Other domains`);
    assert.doesNotMatch(text, /api\.knsdomains\.org|api(-tn10)?\.dotk\.name|kaspaname\.com/, `${name}: a removed service's API`);
    assert.doesNotMatch(text, /peekKnsAddress|refreshKnsIfNeeded|knsNamesAsIdentity|getEndpoint\("knsApi"\)/, `${name}: KNS reads`);
    assert.doesNotMatch(text, /data-kns-(transfer|register|editor)|data-domains-service=/, `${name}: KNS screens`);
  }
  assert.equal(read("engine", "endpoints.js").includes("knsApi"), false);
});

await test("Usernames: the Wallet card, its screen, the dock item, empty state and fields", () => {
  const html = read("index.html");
  assert.match(html, /data-open-domains-screen>[\s\S]*?<span>Your Usernames<\/span>/);
  assert.match(html, /<span class="chatting-address-balance">Your Usernames<\/span>/);
  assert.match(html, /data-domains-inscribe hidden>Claim a Username</);
  assert.match(html, /data-app-tab="kachat-names" hidden>[\s\S]*?<span>Usernames<\/span>/);
  assert.match(html, /placeholder="kaspa:qr\.\.\. or username"/);
  const shown = html.replace(/<!--[\s\S]*?-->/g, "");
  assert.doesNotMatch(shown, /Your Domains|or domain"|Kaspa Address or Domain/);
  assert.doesNotMatch(html, /<span class="settings-group-label">Other Domains/);
  const live = read("ui", "kachat-names-live.js");
  assert.match(live, /No usernames yet/);
  assert.match(read("ui", "send-kaspa-components.js"), /Looking up username\.\.\./);
  assert.match(read("ui", "app.js"), /"kachat-names": "Usernames"/);
  assert.match(read("ui", "app.js"), /"One of your usernames expired"/);
});

await test("kept: .kas contact names are un-named, and old domain-transfer lines still draw", () => {
  const app = read("ui", "app.js");
  assert.match(app, /function revertDomainContactNames\(\) \{\n\s+if \(!engine\.address\) return;/);
  assert.match(app, /iOS isKNSTransferMessage/);
  // a KNS commit/reveal is a contract transaction, never a chat payment (engine/sync.js)
  assert.match(read("engine", "sync.js"), /an offer's locked KAS, a KNS reveal/);
});

console.log(`\nkachat-only names: ${passed} passed`);
