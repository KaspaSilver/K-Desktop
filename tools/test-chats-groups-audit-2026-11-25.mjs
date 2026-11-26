// node tools/test-chats-groups-audit-2026-11-25.mjs - the 1:1 chat and group findings of the
// 2026-11-25 audit: group rows deduped by txid (msg ids repeat every epoch), the big group stores in
// the chat storage and an unsaved root read again, isResponse no longer an acceptance by itself,
// reactions aimed at "toString", edits of payment and handshake rows, and replayed group photos.
// app.js can't be loaded in node, so its functions are cut out of its source and run on stubs; the
// engine's GroupManager runs for real on in-memory localStorage with genuinely sealed payloads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

class MemoryStorage {
  constructor() { this.map = new Map(); this.failKeys = new Set(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) {
    if (this.failKeys.has(key)) { const error = new Error("QuotaExceededError"); error.name = "QuotaExceededError"; throw error; }
    this.map.set(key, String(value));
  }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); this.failKeys.clear(); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
}
globalThis.localStorage = new MemoryStorage();

const G = await import("../engine/group.js");
const { GroupManager, GROUP_SEEN_MSG_KEY, GROUP_BULK_STORE_KEYS, setGroupBulkStorage } = await import("../engine/group-store.js");

const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
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
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const ME = "kaspa:qme";
const ALICE = "kaspa:qalice";
const BOB = "kaspa:qbob";
const tx = (n) => n.toString(16).padStart(64, "0");

// --- #2: group rows ---------------------------------------------------------------------------

// Two real messages from one device: counter 0 in epoch 0, and counter 0 again in epoch 1.
function sealedIds() {
  const seed = G.generateGroupSeed(); const gid = G.deriveGroupId(seed); const blinding = G.deriveBlindingKey(seed, gid);
  const priv = new Uint8Array(32).fill(7); const deviceId = G.generateDeviceId();
  const send = (epoch, counter) => G.parseGroupMessagePayload(G.sealGroupMessage({
    plaintext: `epoch ${epoch}`, groupId: gid, epoch, groupRootEpoch: G.deriveGroupRootEpoch(seed, gid, epoch),
    blindingKey: blinding, senderAddress: ALICE, senderPrivateKey: priv, deviceId, counter,
  }));
  return [send(0, 0), send(1, 0)].map((p) => ({ msgIdHex: G.bytesToHex(p.msgId), epoch: p.epoch }));
}

function groupRows() {
  const chat = new Map();
  let all = {};
  const env = {
    engine: { address: ME },
    accountScopedKey: (base) => `acct:${ME}:${base}`,
    chatStorageGetSync: (key) => (chat.has(key) ? chat.get(key) : null),
    chatStorageSetSync: (key, value) => chat.set(key, value),
    loadGroupMsgAll: () => all,
    saveGroupMsgAll: (next) => { all = next; },
  };
  const source = between("function groupRowEpoch(row)", "function appendGroupMessage(groupId, message)");
  const fns = build(source, env, "{ groupMessagesAreSame, appendGroupMessagesBulk, rememberDeletedGroupMessages, isDeletedGroupMessage }");
  return { ...fns, chat, list: (gid) => all[ME]?.[gid] || [] };
}

test("#2 a msg id repeats across epochs: the epoch-1 message is its own row, not a duplicate", () => {
  const [a, b] = sealedIds();
  assert.equal(a.msgIdHex, b.msgIdHex, "the counter restarted, so the msg id is the same");
  const { groupMessagesAreSame, appendGroupMessagesBulk, list } = groupRows();
  const rowA = { id: "1", senderAddress: ALICE, txId: tx(1), createdAt: 1, ...a, text: "old" };
  const rowB = { id: "2", senderAddress: ALICE, txId: tx(2), createdAt: 2, ...b, text: "new" };
  assert.equal(groupMessagesAreSame(rowA, rowB), false);
  assert.equal(appendGroupMessagesBulk("g", [rowA, rowB]), 2);
  assert.deepEqual(list("g").map((m) => m.text), ["old", "new"]);
  // A row stored before epochs were kept, read again by txid: still the same message.
  assert.equal(groupMessagesAreSame({ ...rowA, epoch: undefined }, rowA), true);
  // ...and a later epoch's message with the same msg id is still new next to it.
  assert.equal(groupMessagesAreSame({ ...rowA, epoch: undefined }, rowB), false);
});

test("#2 another member can't pre-send someone's next ids to hide them", () => {
  const { groupMessagesAreSame, appendGroupMessagesBulk, list } = groupRows();
  const forged = { id: "f", senderAddress: BOB, txId: tx(9), msgIdHex: "ab".repeat(24), epoch: 3, createdAt: 1, text: "bob first" };
  const real = { id: "r", senderAddress: ALICE, txId: tx(10), msgIdHex: "ab".repeat(24), epoch: 3, createdAt: 2, text: "alice" };
  assert.equal(groupMessagesAreSame(forged, real), false);
  appendGroupMessagesBulk("g", [forged, real]);
  assert.equal(list("g").length, 2);
});

test("#2 our own send in flight (no txid yet) is matched by sender, epoch and msg id", () => {
  const { groupMessagesAreSame, appendGroupMessagesBulk, list } = groupRows();
  const pending = { id: "p", senderAddress: ME, txId: null, msgIdHex: "cd".repeat(24), epoch: 2, createdAt: 1, text: "hi" };
  const chainCopy = { id: "c", senderAddress: ME, txId: tx(3), msgIdHex: "cd".repeat(24), epoch: 2, createdAt: 2, text: "hi" };
  assert.equal(groupMessagesAreSame(pending, chainCopy), true);
  assert.equal(groupMessagesAreSame(pending, { ...chainCopy, epoch: 3 }), false, "a new epoch is another message");
  appendGroupMessagesBulk("g", [pending]);
  assert.equal(appendGroupMessagesBulk("g", [chainCopy]), 0);
  assert.equal(list("g")[0].txId, tx(3), "the chain copy fills in the txid");
});

test("#2 a replay (same sender, epoch and msg id in a new transaction) is still a duplicate", () => {
  const { groupMessagesAreSame } = groupRows();
  const first = { senderAddress: ALICE, txId: tx(4), msgIdHex: "ef".repeat(24), epoch: 1 };
  assert.equal(groupMessagesAreSame(first, { ...first, txId: tx(5) }), true);
});

test("#2 the deleted log keys rows the same way, and old bare msg ids only hide copies without a txid", () => {
  const { rememberDeletedGroupMessages, isDeletedGroupMessage, chat } = groupRows();
  const msgId = "12".repeat(24);
  rememberDeletedGroupMessages([{ senderAddress: ALICE, txId: tx(6), msgIdHex: msgId, epoch: 0 }]);
  assert.equal(isDeletedGroupMessage({ senderAddress: ALICE, txId: tx(6), msgIdHex: msgId, epoch: 0 }), true);
  assert.equal(isDeletedGroupMessage({ senderAddress: ALICE, txId: tx(7), msgIdHex: msgId, epoch: 1 }), false, "epoch 1 reuses the id");
  const stored = JSON.parse(chat.get(`acct:${ME}:kachat-deleted-group-messages-v1`));
  assert.deepEqual(stored, [tx(6)], "kept in the chat storage, the txid alone");
  // A deleted row with no txid: sender, epoch and msg id.
  rememberDeletedGroupMessages([{ senderAddress: ME, txId: null, msgIdHex: "34".repeat(24), epoch: 4 }]);
  assert.equal(isDeletedGroupMessage({ senderAddress: ME, txId: tx(8), msgIdHex: "34".repeat(24), epoch: 4 }), true);
  assert.equal(isDeletedGroupMessage({ senderAddress: ME, txId: tx(8), msgIdHex: "34".repeat(24), epoch: 5 }), false);
  // An entry from before this change: a bare msg id.
  const legacy = groupRows();
  legacy.chat.set(`acct:${ME}:kachat-deleted-group-messages-v1`, JSON.stringify([tx(1), "56".repeat(24)]));
  assert.equal(legacy.isDeletedGroupMessage({ txId: tx(1) }), true);
  assert.equal(legacy.isDeletedGroupMessage({ senderAddress: ALICE, txId: null, msgIdHex: "56".repeat(24) }), true);
  assert.equal(legacy.isDeletedGroupMessage({ senderAddress: ALICE, txId: tx(2), msgIdHex: "56".repeat(24), epoch: 2 }), false);
});

test("#2 incoming rows and our own sends store the epoch", () => {
  assert.match(app, /msgIdHex: decoded\.msgIdHex \|\| null,\n.*\n\s+epoch: groupRowEpoch\(decoded\),/);
  assert.equal((app.match(/epoch: groupRowEpoch\(res\)/g) || []).length, 3);
});

// Reactions and edits: lookups find a msg id key too, and a key off the network never throws.
function groupStores(rows = []) {
  const chat = new Map();
  const env = {
    engine: { address: ME },
    chatStorageGetSync: (key) => (chat.has(key) ? chat.get(key) : null),
    chatStorageSetSync: (key, value) => chat.set(key, value),
    groupMessages: () => rows,
    MESSAGE_EDIT_MAX_LENGTH: 4000,
    isEditableContent: () => true,
    applyEditToContent: (text) => text,
  };
  const source = [
    between("function groupRowEpoch(row)", "function groupMsgIdsMatch("),
    between("function groupMsgKey(message)", "let groupEditTarget = null;"),
  ].join("\n");
  return { chat, ...build(source, env, "{ groupReactionsFor, applyGroupReaction, groupEditFor, applyGroupEdit, findGroupTargetRow, groupMessageContent, GROUP_TARGETS_KEPT_PER_GROUP }") };
}

test("#2 reactions and edits filed under a msg id are found from the row's txid", () => {
  const s = groupStores();
  const row = { txId: tx(1), msgIdHex: "aa".repeat(24), senderAddress: ALICE, text: "hello" };
  s.applyGroupReaction("g", row.msgIdHex, BOB, "👍", "add");
  s.applyGroupReaction("g", row.txId, ME, "❤️", "add");
  assert.deepEqual(s.groupReactionsFor("g", row.txId, row.msgIdHex).map((e) => e.emoji).sort(), ["❤️", "👍"].sort());
  assert.deepEqual(s.groupReactionsFor("g", row.txId).map((e) => e.emoji), ["❤️"]);
  s.applyGroupEdit("g", row.msgIdHex, ALICE, "edited", 10);
  assert.equal(s.groupMessageContent("g", row), "edited");
  assert.ok(s.chat.has("kachat-group-reactions-v1") && s.chat.has("kachat-group-edits-v1"), "kept in the chat storage");
  assert.equal(localStorage.getItem("kachat-group-reactions-v1"), null);
});

test("#2 a msg id target is matched to the right epoch's row; a txid always wins", () => {
  const rows = [
    { txId: tx(1), msgIdHex: "bb".repeat(24), epoch: 0, senderAddress: ALICE, createdAt: 1 },
    { txId: tx(2), msgIdHex: "bb".repeat(24), epoch: 1, senderAddress: ALICE, createdAt: 2 },
    { txId: tx(3), msgIdHex: "bb".repeat(24), epoch: 1, senderAddress: BOB, createdAt: 3 },
  ];
  const s = groupStores(rows);
  assert.equal(s.findGroupTargetRow("g", tx(1)).txId, tx(1));
  assert.equal(s.findGroupTargetRow("g", "bb".repeat(24), { senderAddress: ALICE, epoch: 0 }).txId, tx(1));
  assert.equal(s.findGroupTargetRow("g", "bb".repeat(24), { senderAddress: ALICE, epoch: 1 }).txId, tx(2));
  assert.equal(s.findGroupTargetRow("g", "bb".repeat(24), { senderAddress: ALICE }).txId, tx(2), "newest without an epoch");
  assert.match(app, /applyGroupEdit\(decoded\.groupId, groupMsgKey\(target\),/);
  assert.match(app, /applyGroupReaction\(decoded\.groupId, reactionTarget \? groupMsgKey\(reactionTarget\) : reaction\.targetTxId,/);
});

test("#12 group reactions and edits keep each group's newest 5,000 targets; inherited keys never read", () => {
  const s = groupStores();
  assert.doesNotThrow(() => s.applyGroupReaction("g", "toString", BOB, "👍", "add"));
  assert.deepEqual(s.groupReactionsFor("g", "hasOwnProperty"), []);
  assert.equal(s.groupEditFor("g", "toString"), null);
  for (let i = 0; i < s.GROUP_TARGETS_KEPT_PER_GROUP + 5; i += 1) s.applyGroupReaction("g", tx(i), BOB, "👍", "add");
  const bucket = JSON.parse(s.chat.get("kachat-group-reactions-v1"))[ME].g;
  assert.equal(Object.keys(bucket).length, s.GROUP_TARGETS_KEPT_PER_GROUP);
  assert.ok(!bucket[tx(0)] && bucket[tx(s.GROUP_TARGETS_KEPT_PER_GROUP + 4)], "the oldest go first");
  s.applyGroupReaction("g", tx(10), BOB, null, "remove");
  assert.equal(Object.hasOwn(JSON.parse(s.chat.get("kachat-group-reactions-v1"))[ME].g, tx(10)), false, "an emptied target is dropped");
});

// --- #12: the engine's stores -----------------------------------------------------------------

const UTF8 = new TextEncoder();
const toHex = (s) => G.bytesToHex(UTF8.encode(s));
const fromHex = (h) => new TextDecoder().decode(G.hexToBytes(h));
const KEY = (n) => n.toString(16).padStart(64, "0");
const wallet = (name, n) => ({ address: `kaspa:qz${name.padEnd(58, name[0])}`, key: KEY(n) });
const W_ME = wallet("me", 0xa1);
const W_ADMIN = wallet("admin", 0xad);
const W_BOB = wallet("bob", 0xb0);
const W_EVE = wallet("eve", 0xee);
const PUB = new Map();
const pub = (w) => { if (!PUB.has(w.address)) PUB.set(w.address, G.bytesToHex(G.xOnlyPublicKey(w.key))); return PUB.get(w.address); };
for (const w of [W_ME, W_ADMIN, W_BOB, W_EVE]) pub(w);
const NOW = Date.now();

function makeGroup() {
  const seed = G.generateGroupSeed();
  const id = G.deriveGroupId(seed);
  return { seed, id, idHex: G.bytesToHex(id), blinding: G.deriveBlindingKey(seed, id), root: (epoch) => G.deriveGroupRootEpoch(seed, id, epoch) };
}
function rootControl(group, epoch, members, version) {
  const payload = G.buildSignedRootPayload({
    groupId: group.id, epoch, groupRootEpoch: group.root(epoch), blindingKey: group.blinding,
    adminSigningPub: pub(W_ADMIN), members: members.map((m) => m.address), name: "Audit",
    adminPrivateKey: W_ADMIN.key, rosterVersion: version,
  });
  return G.buildControlPayload({ recipientXOnlyPubKey: pub(W_ME), encryptedHex: toHex(JSON.stringify(payload)) });
}
function photoControl(group, photoHex) {
  const payload = G.buildSignedPhotoPayload({ groupId: group.id, photoHex, signingPub: pub(W_ADMIN), privateKey: W_ADMIN.key });
  return G.buildControlPayload({ recipientXOnlyPubKey: pub(W_ME), encryptedHex: toHex(JSON.stringify(payload)) });
}
async function joinedManager(group, controlPages = []) {
  const engine = {
    address: W_ME.address,
    privateKeyHex: W_ME.key,
    xOnlyPubKeyForAddress: async (address) => PUB.get(address) || null,
    encryptGroupControl: async (_to, json) => toHex(json),
    decryptGroupControl: async (hex) => fromHex(hex),
    sendGroupPayload: async () => ({ txids: ["sent"] }),
    groupIndexerUrl: () => "https://indexer.test",
    scanGroupControlByRecipientPage: async (cursor) => controlPages.find((page) => page.after === cursor) || { rows: [], nextCursor: cursor, rawCount: 0 },
  };
  const mgr = new GroupManager(engine);
  await mgr.applyControl(rootControl(group, 0, [W_ADMIN, W_ME], 1), W_ADMIN.address, NOW - 1000);
  const [invite] = mgr.pendingGroupInvites();
  await mgr.acceptGroupInvite(invite.id);
  assert.equal(mgr.getGroup(group.idHex)?.currentEpoch, 0);
  return mgr;
}

test("#12 a new epoch's root that can't be saved isn't passed by: the walk stops before its cursor", async () => {
  localStorage.clear();
  const group = makeGroup();
  const pages = [{ after: null, rows: [{ txId: tx(1), sender: W_ADMIN.address, blockTime: NOW, payloadString: rootControl(group, 1, [W_ADMIN, W_ME, W_BOB], 2) }], nextCursor: "c1", rawCount: 1 }];
  const mgr = await joinedManager(group, pages);
  localStorage.failKeys.add("kachat-groups-v1");
  await mgr._catchUpControlByRecipient([]);
  assert.equal(mgr.groupControlCursor(), null, "the cursor did not move past the root");
  localStorage.failKeys.clear();
  assert.equal(mgr.getGroup(group.idHex).currentEpoch, 0);
  const events = [];
  await mgr._catchUpControlByRecipient(events);
  assert.equal(mgr.getGroup(group.idHex).currentEpoch, 1, "read again and applied once storage had room");
  assert.equal(mgr.groupControlCursor()?.cursor, "c1");
  assert.ok(events.some((ev) => ev.kind === "root-updated"));
});

test("#12 the seen ids go to the storage the app hands over (its IndexedDB chat storage)", async () => {
  localStorage.clear();
  assert.deepEqual([...GROUP_BULK_STORE_KEYS], [GROUP_SEEN_MSG_KEY, "kachat-group-reactions-v1", "kachat-group-edits-v1"]);
  const bulk = new Map();
  setGroupBulkStorage({ get: (key) => (bulk.has(key) ? bulk.get(key) : null), set: (key, value) => bulk.set(key, value) });
  try {
    const group = makeGroup();
    const mgr = await joinedManager(group);
    const parsed = G.parseGroupMessagePayload(G.sealGroupMessage({
      plaintext: "hi", groupId: group.id, epoch: 0, groupRootEpoch: group.root(0), blindingKey: group.blinding,
      senderAddress: W_ADMIN.address, senderPrivateKey: W_ADMIN.key, senderXOnlyPub: pub(W_ADMIN), deviceId: new Uint8Array(16).fill(1), counter: 0,
    }));
    assert.ok(mgr.processMessage(parsed, null, { txId: "aa".repeat(32), blockTime: NOW }));
    assert.ok(bulk.has(GROUP_SEEN_MSG_KEY));
    assert.equal(localStorage.getItem(GROUP_SEEN_MSG_KEY), null);
    assert.equal(mgr.processMessage(parsed, null, { txId: "bb".repeat(32), blockTime: NOW }), null, "a replay is still refused");
  } finally { setGroupBulkStorage(null); }
  const main = between("const CHAT_STORAGE_GLOBAL_KEYS", "await initChatStorage(");
  assert.match(main, /\.\.\.GROUP_BULK_STORE_KEYS/);
  assert.match(app, /setGroupBulkStorage\(\{ get: \(key\) => chatStorageGetSync\(key\), set: \(key, value\) => chatStorageSetSync\(key, value\) \}\);/);
  assert.match(app, /const CHAT_STORAGE_BASE_KEYS = \[STORAGE_KEY, STATE_BACKUP_KEY, MESSAGE_HISTORY_KEY, "kachat-deleted-group-messages-v1"\];/);
});

// --- #34: group photo replays -------------------------------------------------------------------

test("#34 a group photo counts only from a transaction sent by the admin's key", async () => {
  localStorage.clear();
  const group = makeGroup();
  const mgr = await joinedManager(group);
  // An old admin-signed photo, put in a new transaction by someone else: refused.
  assert.equal(await mgr.applyControl(photoControl(group, "ff00"), W_EVE.address, NOW + 1), null);
  assert.equal(await mgr.applyControl(photoControl(group, "ff00"), W_BOB.address, NOW + 2), null);
  assert.equal(mgr.getGroup(group.idHex).photoHex || "", "");
  const ev = await mgr.applyControl(photoControl(group, "aa11"), W_ADMIN.address, NOW + 3);
  assert.equal(ev?.kind, "photo-updated");
  assert.equal(mgr.getGroup(group.idHex).photoHex, "aa11");
  // No sender known yet (the indexer hasn't resolved one): applied, as an unsigned roster's is.
  assert.equal((await mgr.applyControl(photoControl(group, "bb22"), "", NOW + 4))?.kind, "photo-updated");
});

// --- #13: isResponse ----------------------------------------------------------------------------

test("#13 a handshake marked response is an acceptance only of something this wallet sent", () => {
  const { hasOwnOutgoingEvidence } = build(between("function hasOwnOutgoingEvidence(", "async function syncIncomingHandshakeRequests("),
    { MESSAGE_STATUSES: { FAILED: "failed", CONFIRMED: "confirmed" } }, "{ hasOwnOutgoingEvidence }");
  assert.equal(hasOwnOutgoingEvidence(null, null), false, "a stranger");
  assert.equal(hasOwnOutgoingEvidence({ relationshipState: "incoming-request", handshakeTxid: "" }, { messages: [] }), false);
  assert.equal(hasOwnOutgoingEvidence({ relationshipState: "outgoing-request" }, null), true);
  assert.equal(hasOwnOutgoingEvidence({ handshakeTxid: tx(1) }, null), true);
  assert.equal(hasOwnOutgoingEvidence({}, { messages: [{ direction: "outgoing", messageType: "handshake", status: "confirmed" }] }), true);
  assert.equal(hasOwnOutgoingEvidence({}, { messages: [{ direction: "outgoing", text: "hi", status: "confirmed" }] }), true);
  assert.equal(hasOwnOutgoingEvidence({}, { messages: [{ direction: "outgoing", text: "hi", status: "failed" }] }), false);
  assert.equal(hasOwnOutgoingEvidence({}, { messages: [{ direction: "incoming", text: "hi" }] }), false);
  assert.match(app, /const isAcceptance = request\.isResponse === true && hasOwnOutgoingEvidence\(contact, conversationEntry\);/);
});

// --- #15: reactions aimed at inherited keys -----------------------------------------------------

test("#15 a 1:1 reaction aimed at \"toString\" or \"hasOwnProperty\" applies without throwing", () => {
  const { applyLocalReaction, removeLocalReaction } = build(between("function ownReactionList(", "// Matches iOS's ChatService+Fetching interception"), {}, "{ applyLocalReaction, removeLocalReaction }");
  const entry = JSON.parse('{"messages":[]}');
  assert.doesNotThrow(() => applyLocalReaction(entry, "toString", "kaspa:qpeer", "👍", 5));
  assert.doesNotThrow(() => removeLocalReaction(entry, "hasOwnProperty", "kaspa:qpeer"));
  assert.doesNotThrow(() => removeLocalReaction(entry, "valueOf", "kaspa:qpeer"));
  assert.deepEqual(entry.reactionsByTxId.toString, [{ reactorAddress: "kaspa:qpeer", emoji: "👍" }]);
  assert.match(app, /const visible = appendIncomingSafely\(conversationEntry, message\);/);
  assert.match(app, /function appendIncomingSafely\(conversationEntry, message\) \{\n\s+try \{ return appendIncomingOrReactionMessage\(conversationEntry, message\); \}/);
});

// --- #33: edits of payment and handshake rows ---------------------------------------------------

test("#33 an incoming edit naming a payment bubble or a handshake row is dropped", () => {
  const source = [
    between("function isPaymentLikeMessage(m) {", "function noteInboxTagged("),
    between("function applyLocalEdit(", "// Matches iOS's MessageReactionContent"),
  ].join("\n");
  const { applyLocalEdit } = build(source, {
    engine: { address: ME },
    contactForConversation: () => ({ address: ALICE }),
    isEditableContent: () => true,
    isChatPaymentPayloadHex: () => false,
  }, "{ applyLocalEdit }");
  const rows = [
    { txid: tx(1), direction: "incoming", sender: ALICE, text: "Received 1 KAS", messageType: "payment" },
    { txid: tx(2), direction: "incoming", sender: ALICE, text: "Received 2 KAS", transport: "kaspa-payment-rest" },
    { txid: tx(3), direction: "incoming", sender: ALICE, text: "Communication request received", messageType: "handshake" },
    { txid: tx(4), direction: "incoming", sender: ALICE, text: "hello" },
  ];
  const entry = { messages: rows };
  assert.equal(applyLocalEdit(entry, tx(1), ALICE, "Received 1000 KAS", 10), false);
  assert.equal(applyLocalEdit(entry, tx(2), ALICE, "Received 1000 KAS", 10), false);
  assert.equal(applyLocalEdit(entry, tx(3), ALICE, "anything", 10), false);
  assert.equal(applyLocalEdit(entry, tx(4), ALICE, "hello again", 10), true);
  assert.equal(rows[3].edit.text, "hello again");
  assert.ok(rows.slice(0, 3).every((m) => !m.edit));
});

for (const [name, fn] of tests) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); console.error(error); process.exitCode = 1; }
}
console.log(`chats and groups audit 2026-11-25: ${passed}/${tests.length} passed`);
