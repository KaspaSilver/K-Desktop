// node tools/test-ios-5-3-kachat.mjs - KaChat iOS 83806b3d's messaging and group fixes, ported in
// Build 293: capped message fees, the group fee pill for text only, the payment notice's fee on
// the Review, group sends tied to their account and a Retry that reads the live row, voice notes
// anchored at their lowest part, media JSON escaping, .kachat records that can't be read, a
// Nextcloud revoke that failed, notifications cleared on Log Out, silent group control pushes, no
// total while the chatting balance is unknown, and push sign-out ordered before the next register.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const app = read("ui/app.js");

let failures = 0;
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.log(`FAIL - ${name}\n`, error); }
}

await test("a message fee is at most 1 KAS, and over 0.01 KAS it asks first", async () => {
  const { clampMessageFeeKas, MESSAGE_FEE_MAX_SOMPI } = await import("../engine/amounts.js");
  assert.equal(MESSAGE_FEE_MAX_SOMPI, 100_000_000n);
  assert.equal(clampMessageFeeKas("5"), "1");
  assert.equal(clampMessageFeeKas("1"), "1");
  assert.equal(clampMessageFeeKas("0.002"), "0.002");
  assert.equal(clampMessageFeeKas("0"), "0");
  assert.match(app, /const MESSAGE_FEE_MAX_SOMPI = 100_000_000n;\nconst MESSAGE_FEE_WARN_SOMPI = 1_000_000n;/);
  assert.match(app, /title: "Fee Too High", message: `A message fee can be at most 1 \$\{KAS_UNIT\}\.`/);
  assert.match(app, /title: "Use a High Fee\?",/);
  assert.equal(app.split("if (!(await messageFeeAllowed(typedSompi))) return;").length - 1, 2, "1:1 and group pills");
  assert.match(read("engine/messages.js"), /feeKas: clampMessageFeeKas\(feeKas\)/);
  assert.match(read("engine/index.js"), /feeKas: clampMessageFeeKas\(feeKas\),\n\s+payload: new TextEncoder/);
});

await test("the group fee pill is for text: a voice note or photo pays the estimate", () => {
  assert.match(app, /if \(groupFeeOverrideKas != null && !groupMediaPending\(\)\) \{ renderGroupFeePill/);
  assert.match(app, /pill\.classList\.contains\("estimating"\) \|\| groupMediaPending\(\)\) return;/);
  assert.match(read("ui/styles.css"), /\.fee-pill\.locked \{ cursor: default; text-decoration: none; \}/);
});

await test("a spending-address chat payment shows what the notice costs the chatting address", () => {
  assert.match(app, /Your chatting address also pays \$\{trimKas8\(Number\(paymentNoticeFeeKas\)\)\} \$\{KAS_UNIT\} to tell \$\{name\} about this payment\./);
  assert.match(app, /encodePaymentNotice\(\{ txId: "0"\.repeat\(64\), amountSompi: sompi, address: contact\.address, memo \}\)/);
  assert.match(app, /\$\{paymentNoticeFeeLineHtml\(\)\}/);
});

await test("a group store never signs another account's message", async () => {
  const { GroupStore } = await import("../engine/group-store.js").catch(() => ({}));
  const src = read("engine/group-store.js");
  assert.match(src, /if \(String\(this\.engine\.address \|\| ""\) !== String\(this\.walletAddress \|\| ""\)\) throw new Error\(SEND_ACCOUNT_CHANGED\);/);
  assert.match(src, /sendGroupPayload\(payload, \{ feeKas: String\(feeKas \|\| "0"\), ownerAddress: this\.walletAddress \}\)/);
  void GroupStore;
  const { KaspaEngine } = await import("../engine/index.js");
  const engine = new KaspaEngine({ log: () => {} });
  engine.address = "kaspa:qnow";
  engine.requireWallet = () => {};
  engine.connect = async () => { engine.address = "kaspa:qother"; };
  await assert.rejects(engine.sendGroupPayload("x", { ownerAddress: "kaspa:qthen" }), /account changed/i, "before the connect");
  engine.address = "kaspa:qthen";
  await assert.rejects(engine.sendGroupPayload("x", { ownerAddress: "kaspa:qthen" }), /account changed/i, "a switch during the connect");
});

await test("group rows are written under the account that sent them; Retry reads the live row", () => {
  assert.match(app, /function groupMessages\(groupId, owner = engine\.address\)/);
  assert.match(app, /function patchGroupMessage\(groupId, localId, patch, owner = engine\.address\)/);
  assert.match(app, /if \(groupSendAccountChanged\(error\)\) return false;/);
  assert.match(app, /if \(!row \|\| row\.status !== MESSAGE_STATUSES\.FAILED \|\| groupSendsInFlight\.has\(row\.id\)\) return;/);
  assert.match(app, /const live = new Map\(groupMessages\(gid\)\.map\(\(m\) => \[m\.id, m\]\)\);/);
});

await test("a voice note sits at its lowest part, whatever arrived first", async () => {
  const { groupParts } = await import("../engine/voice-parts.js");
  const { mediaFileEnvelopeJson } = await import("../engine/media-frame.js");
  const tag = (index) => mediaFileEnvelopeJson({ name: "voice.webm", size: 64, mimeType: "audio/webm", voicePart: { id: "0123456789abcdef0123456789abcdef", index, count: 3 }, dataUrlContent: `data:audio/webm;base64,${"A".repeat(80)}` });
  const rows = [{ id: "c", text: tag(3) }, { id: "a", text: tag(1) }, { id: "b", text: tag(2) }];
  const result = groupParts(rows, { content: (m) => m.text, owner: () => "kaspa:qx", key: (m) => m.id, status: () => "sent" });
  assert.deepEqual([...result.clusters.keys()], ["a"], "anchored at part 1, not the first row");
  assert.deepEqual([...result.hidden].sort(), ["b", "c"]);
  assert.equal(result.anchorKeyOf.get("c"), "a");
});

await test("media JSON escapes control characters and still keeps '/' as it is", async () => {
  const { mediaFileEnvelopeJson } = await import("../engine/media-frame.js");
  const name = "a\"b\\c\nd\te\u0001/x";
  const json = mediaFileEnvelopeJson({ name, size: 1, mimeType: "audio/webm", dataUrlContent: "data:audio/webm;base64,AA==" });
  assert.equal(JSON.parse(json).name, name);
  assert.match(json, /"mimeType":"audio\/webm"/);
  assert.equal(mediaFileEnvelopeJson({ name: "p.jpg", size: 1, mimeType: "image/jpeg", dataUrlContent: "data:image/jpeg;base64,AA==" }),
    '{"type":"file","name":"p.jpg","size":1,"mimeType":"image/jpeg","content":"data:image/jpeg;base64,AA=="}');
});

await test(".kachat: a record that doesn't say registered but has an owner, and junk times, are no answer", async () => {
  assert.match(read("engine/kachat-names/registry.js"), /j\.registered == null && \(j\.outpoint \|\| j\.owner \|\| j\.ownerKey\)/);
  const { IndexerAPI } = await import("../engine/kachat-names/registry-state.js");
  const base = { name: "alice", registered: true, owner: null, ownerKey: "11".repeat(32), outpoint: { txId: "22".repeat(32), index: 0 }, periodStart: 1, expiresAt: 2 };
  assert.ok(IndexerAPI.nameInfo(base));
  assert.equal(IndexerAPI.nameInfo({ ...base, expiresAt: 99_000_000_000_000 }), null);
  assert.equal(IndexerAPI.nameInfo({ ...base, periodStart: -5 }), null);
});

await test("Disconnect says when the server kept its app password", () => {
  const nc = read("ui/nextcloud.js");
  assert.match(nc, /return response\.status === 200 \|\| response\.status === 401;/);
  assert.match(nc, /title: "Couldn't Remove App Password",/);
  assert.match(nc, /Delete it in Nextcloud under Settings > Security > Devices & sessions\./);
});

await test("Log Out and Delete Account take down notifications on screen", () => {
  assert.match(app, /async function clearShownNotifications\(\)/);
  assert.equal(app.split("clearShownNotifications().catch(() => {});").length - 1, 2);
  assert.match(app, /for \(const note of \(await registration\?\.getNotifications\?\.\(\)\) \|\| \[\]\)/);
});

await test("group control pushes are silent", () => {
  assert.match(read("public/sw-push.js"), /if \(control\) out\.suppress = true;/);
});

await test("no Total Balance while the chatting balance is unknown", () => {
  assert.match(app, /if \(!hasChatting\) \{ totalEl\.textContent = `-- \$\{KAS_UNIT\}`; return; \}/);
});

await test("a push sign-out runs before the next register, and one during a register undoes it", () => {
  const wp = read("ui/web-push.js");
  assert.match(wp, /if \(signOutRunning\) \{ try \{ await signOutRunning; \}/);
  assert.match(wp, /if \(generation !== signOutGeneration\) \{/);
  assert.match(wp, /signOutGeneration \+= 1;/);
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log(`ios 5.3 kachat: ${passed} passed`);
