// node tools/test-ios-5-3-kapost.mjs - KaPost iOS 369794e's fixes, ported in Build 294: Public Chats
// (voice-note parts, Retry, the read marker, leaving a room, paging), chain posts always signed,
// indexer recovery on two probe passes, the byte-based post limit, mentions on the real key, block
// and the bell, translations after an edit, a second edit, search, the thread probe, scheduled
// posts (a coin set aside, cancels the indexer missed, posts already on chain), follows both ways,
// polls and live edits in the outage feed, push for mentions and hidden actors.
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
const rooms = read("ui/broadcasts.js");
const kaposts = read("ui/kaposts.js");
const engineKaposts = read("engine/kaposts.js");

let failures = 0;
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.log(`FAIL - ${name}\n`, error); }
}

// MARK: Public Chats
await test("a voice note's later parts left pending by a closed tab are Failed, the first Not confirmed", async () => {
  const { settleLeftoverRoomRows, ROOM_UNCONFIRMED } = await import("../ui/leftover-sends.js");
  const { mediaFileEnvelopeJson } = await import("../engine/media-frame.js");
  const part = (index) => mediaFileEnvelopeJson({ name: "voice.webm", size: 64, mimeType: "audio/webm", voicePart: { id: "0123456789abcdef0123456789abcdef", index, count: 3 }, dataUrlContent: `data:audio/webm;base64,${"A".repeat(80)}` });
  const rows = [1, 2, 3].map((i) => ({ txId: `pending-${i}`, senderAddress: "kaspa:qme", content: part(i), status: "pending", blockTime: 1 }));
  settleLeftoverRoomRows(rows);
  assert.deepEqual(rows.map((r) => r.status), [ROOM_UNCONFIRMED, "failed", "failed"]);
});
await test("rooms: reactions on hidden parts reach the bubble; replies to a part jump to it", () => {
  assert.match(rooms, /function reactionsOn\(channel, txId\)/);
  assert.equal(rooms.split("reactionsOn(activeChannel, m.txId)").length - 1, 3);
  assert.match(rooms, /txId = roomParts\.anchorKeyOf\.get\(txId\) \|\| txId;/);
});
await test("rooms: Retry reads the live row; a failed part is free for Retry again", () => {
  assert.match(rooms, /if \(!live \|\| live\.status !== "failed" \|\| pendingSendsThisRun\.has\(live\.txId\)\) return;/);
  assert.match(rooms, /\.filter\(\(m\) => m && m\.status === "failed" && !pendingSendsThisRun\.has\(m\.txId\)\)/);
  assert.match(rooms, /\/\/ failed: free for a Retry again\n\s+pendingSendsThisRun\.delete\(pendingId\);/);
});
await test("rooms: read up to the newest message, leaving a room clears it, paging keeps the oldest millisecond", () => {
  assert.match(rooms, /readMarkerByChannel\[channel\] = newest \? Math\.max\(newest,/);
  assert.match(rooms, /delete editsCache\[name\];\n\s+saveEdits\(\);/);
  assert.match(rooms, /roomNewestSeen\.delete\(name\);/);
  assert.match(rooms, /before = oldest \+ 1 === before \? oldest : oldest \+ 1;/);
  assert.match(rooms, /if \(isIndexerDown\(roomIndexerBase\(channel\)\) && settlePendingFromEarlierRuns\(channel\)\)/);
});

// MARK: indexer health
await test("an outage ends on two probe passes in a row, or one real read", async () => {
  const { createIndexerHealth, INDEXER_PROBE_PASSES_TO_RECOVER } = await import("../engine/indexer-health.js");
  assert.equal(INDEXER_PROBE_PASSES_TO_RECOVER, 2);
  let clock = 0;
  const health = createIndexerHealth({ now: () => clock, storage: null });
  const url = "https://idx.test";
  for (let i = 0; i < 3; i += 1) { health.recordFailure(url); clock += 6_000; }
  assert.equal(health.isDown(url), true);
  clock += 61_000;
  assert.equal(health.claimRecoveryCheck(url), true);
  health.recordAnswer(url);
  assert.equal(health.isDown(url), true, "one pass");
  assert.equal(health.claimRecoveryCheck(url), true, "the next probe goes at once");
  health.recordFailure(url); // a failure breaks the run
  clock += 61_000;
  assert.equal(health.claimRecoveryCheck(url), true);
  health.recordAnswer(url);
  assert.equal(health.isDown(url), true);
  assert.equal(health.claimRecoveryCheck(url), true);
  health.recordAnswer(url);
  assert.equal(health.isDown(url), false, "two in a row");
  // a real read (no probe) ends it at once
  for (let i = 0; i < 3; i += 1) { clock += 6_000; health.recordFailure(url); }
  assert.equal(health.isDown(url), true);
  health.recordAnswer(url);
  assert.equal(health.isDown(url), false);
});

// MARK: KaPost
await test("a post from the chain needs the KaChat marker and a valid signature, indexer up or down", () => {
  assert.match(engineKaposts, /if \(!isKaChatContent\(decoded\)\) return null;/);
  assert.match(engineKaposts, /if \(!chainPayloadIsSigned\(payload\)\) return null;/);
});
await test("the post limit counts UTF-8 bytes and cuts on a character", async () => {
  const { kapostsPostLength, kapostsClampBytes } = await import("../ui/kaposts-format.js");
  assert.equal(kapostsPostLength("abc"), 3);
  assert.equal(kapostsPostLength("你好"), 6);
  assert.equal(kapostsPostLength("😀"), 4);
  assert.equal(kapostsClampBytes("😀😀😀", 9), "😀😀", "never half an emoji");
  assert.equal(kapostsClampBytes("你好吗", 7), "你好");
  assert.match(kaposts, /const count = kapostsPostLength\(input\.value\);/);
});
await test("a payload too big for one transaction is refused, not retried", async () => {
  const { checkKaPostPayloadFits, KAPOST_TOO_LONG, KAPOST_MAX_PAYLOAD_BYTES } = await import("../engine/kaposts.js");
  assert.doesNotThrow(() => checkKaPostPayloadFits(KAPOST_MAX_PAYLOAD_BYTES));
  assert.throws(() => checkKaPostPayloadFits(KAPOST_MAX_PAYLOAD_BYTES + 1), (e) => e.code === KAPOST_TOO_LONG && /too long for one transaction/.test(e.message));
});
await test("mentions are once per person, never yourself, on the x-only key; the real key is looked up", () => {
  assert.match(engineKaposts, /if \(xOnly === meXOnly \|\| seen\.has\(xOnly\)\) continue;/);
  assert.match(kaposts, /pubkey = \(await realMentionKey\(address\)\) \|\|/);
  assert.match(kaposts, /keys\.has\(String\(pk\)\.toLowerCase\(\)\.slice\(2\)\)/);
});
await test("block turns the bell off; muted or blocked authors' quotes and ancestors are hidden", () => {
  assert.match(kaposts, /\/\/ blocking turns the bell off too \(KaPost 369794e\)\n\s+unwatchAuthor\(address\);/);
  assert.match(kaposts, /\[\.\.\.watchedAuthors\(\)\]\.filter\(\(address\) => !isHiddenAuthorLower\(address\)\)/);
  assert.match(kaposts, /You muted or blocked this account/);
  assert.match(kaposts, /\.filter\(\(entry\) => !isHiddenAuthorLower\(entry\.posterAddress\)\)/);
});
await test("translations follow edits; a second edit starts from the text before both", () => {
  assert.match(kaposts, /return post\?\.editedAt \? `\$\{base\}#\$\{textHash\(String\(post\.text \|\| ""\)\)\}` : base;/);
  assert.match(kaposts, /const txId = !post\.editedAt && \/\^\[0-9a-f\]\{64\}\$\/i\.test/);
  assert.match(kaposts, /cancelUndoable\(`edit:\$\{post\.id\}`\);\n\s+const previous = post\.text;/);
});
await test("search matches a .kachat name with or without its ending; a no-thread answer expires", () => {
  assert.match(kaposts, /if \(label\) names\.push\(label, `\$\{label\}\.kachat`\);/);
  assert.match(kaposts, /Math\.min\(Math\.max\(age, 600_000\), 86_400_000\)/);
});
await test("follows sync both ways and this session's taps win; a post without its key still follows", () => {
  assert.match(kaposts, /if \(before\) for \(const address of before\) if \(!onChain\.has\(address\)\) merged\.delete\(address\);/);
  assert.match(kaposts, /for \(const \[address, follow\] of followTapsThisSession\)/);
  assert.match(kaposts, /resolveKaPostsPubkey\(address\)\.catch\(\(\) => null\)/);
});

// MARK: scheduled posts
await test("a cancel the indexer missed is remembered for a local post; one it holds says so", async () => {
  const { cancelScheduledEntry, flushPendingScheduledCancels, KAPOSTS_SCHEDULED_CANCEL_UNREACHED } = await import("../engine/kaposts.js");
  const entry = (fields) => ({ id: "aa".repeat(32), status: "scheduled", onServer: false, ...fields });
  const run = async (e, cancelOnServer) => {
    const removed = [];
    const remembered = [];
    const problem = await cancelScheduledEntry({ id: e.id, readEntries: () => [e], inFlight: new Set(), cancelOnServer, remove: (x) => removed.push(x.id), rememberCancel: (id) => remembered.push(id) });
    return { problem, removed, remembered };
  };
  const down = async () => { throw new Error("network down"); };
  const answered = async () => { const err = new Error("404"); err.indexerAnswered = true; throw err; };
  assert.deepEqual(await run(entry(), down), { problem: null, removed: ["aa".repeat(32)], remembered: ["aa".repeat(32)] });
  assert.deepEqual(await run(entry({ onServer: true }), down), { problem: KAPOSTS_SCHEDULED_CANCEL_UNREACHED, removed: [], remembered: [] });
  assert.deepEqual(await run(entry({ onServer: true }), answered), { problem: null, removed: ["aa".repeat(32)], remembered: [] }, "it doesn't hold it");
  const left = await flushPendingScheduledCancels({ ids: ["a", "b", "c"], cancel: async (id) => { if (id === "a") return; if (id === "b") throw Object.assign(new Error("x"), { indexerAnswered: true }); throw new Error("down"); } });
  assert.deepEqual(left, ["c"]);
});
await test("a post refused because it's on chain already counts as sent; the indexer's sent post holds its coins", async () => {
  const { submitDueScheduledPosts, applyScheduledOutcomes } = await import("../engine/kaposts.js");
  const T = await import("../engine/transactions.js");
  const e = { id: "bb".repeat(32), status: "scheduled", onServer: false, notBefore: 0 };
  await submitDueScheduledPosts({ readEntries: () => [e], inFlight: new Set(), now: 1, submit: async () => { throw new Error("transaction rejected: already spent"); }, handToIndexer: async () => {}, isOnChain: async () => true });
  assert.equal(e.status, "submitted");
  T.clearJustSpentOutpoints();
  const held = { id: "cc".repeat(32), status: "scheduled", onServer: true, notBefore: 0, spentOutpoints: ["dd:0"] };
  applyScheduledOutcomes([held], [{ txId: held.id, status: "submitted" }]);
  assert.equal(T.excludeJustSpentUtxos([{ outpoint: { transactionId: "dd", index: 0 } }]).length, 0);
  T.clearJustSpentOutpoints();
});
await test("a post that would hold every coin over 2 KAS sets 1 KAS aside first", () => {
  assert.match(engineKaposts, /if \(!noSplit && inputCount === usable\.length && totalUtxoSompi\(usable\) > SCHEDULE_SPLIT_ABOVE_SOMPI\)/);
  assert.match(engineKaposts, /await args\.engine\.send\(address, "1", "0", \{ exactAmount: true, ownerAddress: address \}\)/);
});

// MARK: outage feed
await test("the chain fallback reads polls, and edits and deletes off the block stream", () => {
  const fb = read("engine/kaposts-chain-fallback.js");
  assert.match(fb, /\} else if \(action === "poll"\) \{/);
  assert.match(fb, /poll = \{ options, counts: null, total: null, closesAt: Number\(fields\[5\]\), myVote: null \};/);
  assert.match(fb, /const LIVE_SEEN_PAYLOADS_MAX = 3000;\nconst LIVE_AMENDMENTS_MAX = 1000;/);
  assert.match(fb, /if \(!edit \|\| post\.poll \|\|/);
  assert.match(kaposts, /remotePosts = applyLiveAmendments\(mergeOutageRows\(/);
});
await test("an edit counts within the window and never on a poll", async () => {
  const { editAppliesTo } = await import("../engine/kaposts-chain-fallback.js");
  assert.equal(editAppliesTo({ timestamp: 1000 }, 2000), true);
  assert.equal(editAppliesTo({ timestamp: 1000, poll: { options: [] } }, 2000), false);
  assert.equal(editAppliesTo({ timestamp: 1000 }, 500), false);
});

// MARK: push and names
await test("the Mentions switch reaches the push service; muted or blocked KaPost actors are silent", async () => {
  assert.match(read("ui/web-push-core.js"), /kaposts_notify_mentions: kaposts \? kaposts\.mentions !== false : true,/);
  assert.match(read("ui/app.js"), /mentions: accountShellPrefs\.kaPostsNotifyMentions \?\? true,/);
  assert.match(read("public/sw-push.js"), /m\.kapostsHidden\.includes\(actor\.length === 66 \? actor\.slice\(2\) : actor\)\) out\.suppress = true;/);
});
await test("a resolved .kachat name follows Show .kachat Endings", () => {
  assert.match(read("ui/app.js"), /return tld === "kachat" \|\| \/\\\.kachat\$\/i\.test\(text\) \? kachatNameDisplay\(text\) : text;/);
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log(`ios 5.3 kapost: ${passed} passed`);
