// Audit 2026-11-25, public chats and KaPost: #7 (profile counts), #9 (indexer rows checked against
// the chain, UI side), #11 (room cache size), #19 (link-preview image URLs), #23 (room edits
// pruned), #24 (reactions kept on a quota error), #25 (own rows take the chain's time).
// The engine side of #9 is in tools/test-broadcast-sender.mjs, #22/#25/#26 in tools/test-room-deletes.mjs.
//
//   node tools/test-rooms-kapost-audit.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  roomCacheForStorage, storedRoomRow, restoreTruncatedRow, pruneRoomEdits,
  ROOM_ROW_STORED_CHARS,
} from "../ui/room-cache-budget.js";
import { setSettingItem, onSettingsStorageFull } from "../ui/settings-storage.js";
import { createBlobUrlCache } from "../ui/preview-image-cache.js";
import { settleRoomCopy } from "../ui/leftover-sends.js";
import { normalizeKaPostUserDetails, clampKaPostCount, KAPOST_MAX_COUNT } from "../engine/kaposts.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const rooms = read("../ui/broadcasts.js");
const kaposts = read("../ui/kaposts.js");
const app = read("../ui/app.js");
const arena = read("../ui/chess-tournaments.js");

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}
const tx = (n) => n.toString(16).padStart(64, "0");

// --- #7 ---------------------------------------------------------------------------------------
await test("#7 get-user-details: only typed, clamped fields survive", () => {
  const hostile = normalizeKaPostUserDetails({
    userPublicKey: "<img src=x>", followersCount: "<img src=x onerror=alert(1)>", followingCount: 12.7,
    followedUser: "yes", extra: "<b>",
  });
  assert.deepEqual(hostile, { userPublicKey: null, followersCount: 0, followingCount: 12, followedUser: false });
  assert.equal(normalizeKaPostUserDetails(null), null);
  assert.equal(normalizeKaPostUserDetails([1]), null);
  const key = "02" + "ab".repeat(32);
  assert.deepEqual(normalizeKaPostUserDetails({ userPublicKey: key.toUpperCase(), followersCount: "42", followingCount: -3, followedUser: true }),
    { userPublicKey: key, followersCount: 42, followingCount: 0, followedUser: true });
  assert.equal(clampKaPostCount(1e15), KAPOST_MAX_COUNT);
  assert.equal(clampKaPostCount(Infinity), 0);
  assert.equal(clampKaPostCount("1e3"), 0);
});
await test("#7 the profile header prints counts through profileCountText", () => {
  assert.match(kaposts, /<b>\$\{profileCountText\(isMine \? prefs\.following\.filter\(\(a\) => a !== address\)\.length : panel\.details\?\.followingCount\)\}<\/b> Following/);
  assert.match(kaposts, /<b>\$\{profileCountText\(panel\.details\?\.followersCount\)\}<\/b> Followers/);
  assert.match(kaposts, /function profileCountText\(value\) \{\n\s*return clampKaPostCount\(value\)\.toLocaleString\(\);\n\}/);
  assert.ok(!/details\?\.follow(ers|ing)Count \?\? 0/.test(kaposts), "no raw count left");
});

// --- #9 UI side --------------------------------------------------------------------------------
await test("#9 the arena keeps a verified row's own text and time; its own sends are checked", () => {
  const fn = arena.slice(arena.indexOf("async function verifiedArenaRows("), arena.indexOf("/** Rows cached by an older build"));
  assert.match(fn, /if \(existing\?\.verified\) \{ accepted\.push\(\{ \.\.\.existing \}\); continue; \}/);
  assert.ok(!fn.includes("existing.local"), "an unconfirmed own send is no longer taken on the indexer's word");
});
await test("#9 rooms drop an indexer row whose text or room differs from the chain's copy", () => {
  const fn = rooms.slice(rooms.indexOf("function withKnownSenderVerdicts("), rooms.indexOf("function mergeMessages("));
  assert.match(fn, /known\.digest !== broadcastContentDigest\(known\.channel, row\.content\)/);
  assert.match(fn, /known\.blockTime > 0/);
  assert.match(rooms, /const ordered = withKnownSenderVerdicts\(rows, channel, seen\)/);
});

// --- #11 --------------------------------------------------------------------------------------
await test("#11 long plain text is stored as its start; envelopes and short rows stay whole", () => {
  const long = { txId: tx(1), senderAddress: "kaspa:a", content: "x".repeat(10_000), blockTime: 1 };
  const stored = storedRoomRow(long);
  assert.equal(stored.content.length, ROOM_ROW_STORED_CHARS);
  assert.equal(stored.truncated, true);
  assert.equal(long.content.length, 10_000, "the row in memory is untouched");
  const voice = { txId: tx(2), content: `{"type":"audio","data":"${"A".repeat(30_000)}"}` };
  assert.equal(storedRoomRow(voice), voice);
  const short = { txId: tx(3), content: "hi" };
  assert.equal(storedRoomRow(short), short);
});
await test("#11 each room and all rooms are capped, oldest first, rows with a status kept", () => {
  const rowOf = (n, extra = {}) => ({ txId: tx(n), senderAddress: "kaspa:a", content: "y".repeat(900), blockTime: n, ...extra });
  const cache = {
    big: Array.from({ length: 100 }, (_, i) => rowOf(i, i === 0 ? { status: "pending" } : {})),
    small: [rowOf(1000)],
  };
  const out = roomCacheForStorage(cache, { roomMax: 20_000, totalMax: 1e9 });
  const size = JSON.stringify(out.big).length;
  assert.ok(size <= 21_000, `room capped (${size})`);
  assert.equal(out.big[0].status, "pending", "the pending send stays");
  assert.equal(out.big.at(-1).txId, tx(99), "the newest stay");
  assert.equal(out.small.length, 1);
  assert.equal(cache.big.length, 100, "memory untouched");
  const total = roomCacheForStorage(cache, { roomMax: 1e9, totalMax: 30_000 });
  assert.ok(JSON.stringify(total).length <= 33_000, "total capped");
  assert.ok(total.small?.length === 1, "the small room keeps its row: the big one gives first");
  const half = roomCacheForStorage(cache, { roomMax: 20_000, totalMax: 1e9, budget: 0.5 });
  assert.ok(JSON.stringify(half.big).length <= 11_000, "a retry asks for half");
});
await test("#11 a cut row gets its full text back when it is served again", () => {
  const row = { txId: tx(1), content: "abc", truncated: true };
  assert.equal(restoreTruncatedRow(row, { content: "abcdef" }), true);
  assert.deepEqual(row, { txId: tx(1), content: "abcdef" });
  const other = { txId: tx(2), content: "abc", truncated: true };
  assert.equal(restoreTruncatedRow(other, { content: "zzzzzz" }), false, "a different text is not taken");
  assert.equal(restoreTruncatedRow({ content: "abc" }, { content: "abcdef" }), false, "only a cut row");
});
await test("#11 settings writes make room instead of throwing", () => {
  const data = new Map();
  let full = true;
  const storage = {
    setItem(k, v) { if (full && k !== "cache") throw new Error("QuotaExceededError"); data.set(k, v); },
    removeItem(k) { data.delete(k); },
  };
  onSettingsStorageFull(() => { storage.removeItem("cache"); full = false; });
  assert.equal(setSettingItem("joined", "[1]", storage), true);
  assert.equal(data.get("joined"), "[1]");
  const never = { setItem() { throw new Error("full"); } };
  assert.equal(setSettingItem("x", "1", never), false, "never throws");
  // the room module's settings and the cache's own handling
  for (const key of ["CHANNELS_KEY", "HIDDEN_KEY", "NOTIFY_KEY", "LISTEN_KEY", "INDEXER_KEY", "JOINED_AT_KEY"]) {
    assert.match(rooms, new RegExp(`setSettingItem\\(deps\\.accountScopedKey\\(${key}\\), `), key);
    assert.ok(!new RegExp(`\\n  localStorage\\.setItem\\(deps\\.accountScopedKey\\(${key}\\)`).test(rooms), `${key} unguarded`);
  }
  assert.match(kaposts, /function savePrefs\(\) \{\n\s*setSettingItem\(deps\.accountScopedKey\(KAPOSTS_PREFS_KEY\), JSON\.stringify\(prefs\)\);/);
  const save = rooms.slice(rooms.indexOf("function saveCacheNow()"), rooms.indexOf("function saveReactions()"));
  assert.match(save, /JSON\.stringify\(roomCacheForStorage\(messageCache\)\)/);
  assert.match(save, /localStorage\.removeItem\(CACHE_KEY\)/, "the old near-full copy is removed on a quota error");
  assert.ok(!/messageCache\[channel\] = /.test(save), "memory is never halved");
  assert.match(save, /onSettingsStorageFull\(\(\) => \{ localStorage\.removeItem\(CACHE_KEY\); \}\);/);
  assert.match(rooms, /truncatedIds\.has\(row\.txId\) && restoreTruncatedRow\(/);
});

// --- #19 --------------------------------------------------------------------------------------
await test("#19 preview image URLs: LRU of 200, evicted ones freed unless shown, one fetch per image", async () => {
  const revoked = [];
  const shown = new Set();
  const cache = createBlobUrlCache({ max: 3, revoke: (u) => revoked.push(u), inUse: (u) => shown.has(u) });
  for (const n of [1, 2, 3]) cache.set(`img${n}`, `blob:${n}`);
  cache.get("img1"); // img2 is now the least recently used
  shown.add("blob:2");
  cache.set("img4", "blob:4");
  assert.deepEqual(revoked, ["blob:3"], "the oldest not on screen is freed");
  assert.equal(cache.size, 3);
  // concurrent loads share one fetch
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const loader = async () => { calls += 1; await gate; return "blob:5"; };
  const a = cache.load("img5", loader);
  const b = cache.load("img5", loader);
  release();
  assert.equal(await a, "blob:5");
  assert.equal(await b, "blob:5");
  assert.equal(calls, 1);
  // a second URL for an image already kept is freed at once
  assert.equal(cache.set("img5", "blob:5b"), "blob:5");
  assert.ok(revoked.includes("blob:5b"));
  // app.js uses it
  assert.match(app, /const previewImageBlobs = createBlobUrlCache\(\{/);
  assert.ok(!app.includes("previewImageBlobs.set("), "no unbounded set left");
  assert.match(app, /img\.src = await previewImageBlobs\.load\(imageUrl, async \(\) => \{/);
});

// --- #23 / #24 --------------------------------------------------------------------------------
await test("#23 edits go with their messages", () => {
  const edits = {
    kaspa: { [tx(1)]: { text: "a", blockTime: 50 }, [tx(2)]: { text: "b", blockTime: 50 }, [tx(3)]: { text: "c", blockTime: 5 } },
    gone: { [tx(4)]: { text: "d", blockTime: 50 } },
  };
  const messages = { kaspa: [{ txId: tx(1) }, { txId: tx(3) }] };
  assert.equal(pruneRoomEdits(edits, messages, () => 10), true);
  assert.deepEqual(Object.keys(edits), ["kaspa"]);
  assert.deepEqual(Object.keys(edits.kaspa), [tx(1)], "not held, or past the cutoff, goes");
  assert.equal(pruneRoomEdits(edits, messages, () => 10), false);
  assert.match(rooms, /if \(pruneRoomEdits\(editsCache, messageCache, retentionCutoffMs\)\) saveEdits\(\);/);
});
await test("#24 a quota error keeps the reactions in memory", () => {
  const fn = rooms.slice(rooms.indexOf("function saveReactions()"), rooms.indexOf("/** Rolling retention"));
  assert.ok(!fn.includes("reactionsCache = {}"));
});

// --- #25 --------------------------------------------------------------------------------------
await test("#25 a sent row still on this device's clock takes its copy's time, once", () => {
  const rows = [{ txId: tx(1), senderAddress: "kaspa:me", content: "hi", blockTime: 999_999, localTime: true }];
  assert.equal(settleRoomCopy(rows, tx(1), 1_000), true);
  assert.deepEqual(rows[0], { txId: tx(1), senderAddress: "kaspa:me", content: "hi", blockTime: 1_000 });
  assert.equal(settleRoomCopy(rows, tx(1), 2_000), false, "once only");
  assert.equal(settleRoomCopy([{ txId: tx(2), localTime: true, status: "pending" }], tx(2), 5), false, "not while still sending");
});

console.log(`rooms/kapost audit: ${passed} passed`);
