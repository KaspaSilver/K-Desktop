// The public chat rooms audit (2026-11-27), after reports of rooms disappearing:
// 1. a room the indexer dropped is left only after fresh `/broadcast-channels` answers this session
//    lacked it - two, an hour apart (an empty answer counts for nothing, and one that lists it again
//    starts over) - never at boot from the list saved last session;
// 2. an account change keeps the whole room cache in memory (no re-read of the trimmed stored copy);
// 3. leaving a room keeps its cached rows while another account on this device still has it joined;
// 4. another account's unsent rows (Sending, Failed, Not confirmed) never show as messages;
// 5. leaving a room forgets its read marker, so rejoining doesn't count everything since;
// 6. a room dropped while open closes its pane and stops its poll.
// Pure rules first, then ui/broadcasts.js under node with the DOM stubbed out. Run from the repo root:
//
//   node tools/test-audit-2026-11-27-rooms.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const roomsSource = read("ui/broadcasts.js");

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}
function fnSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  let depth = 0;
  for (let i = source.indexOf(") {", start) + 2; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

// --- the browser stubs ui/broadcasts.js needs (a storage that can list its keys) -------------------
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  key: (index) => [...storage.keys()][index] ?? null,
  get length() { return storage.size; },
};
const noop = () => {};
globalThis.window = globalThis;
globalThis.addEventListener = noop;
globalThis.matchMedia = () => ({ matches: false, addEventListener: noop });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.document = {
  hidden: true, // keeps the closed-room sweep and the poll's fetches quiet
  addEventListener: noop,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, dataset: {}, setAttribute: noop, addEventListener: noop, appendChild: noop, remove: noop, querySelector: () => null }),
  body: { appendChild: noop },
};
globalThis.fetch = async (url) => {
  const href = String(url);
  if (href.includes("/get-broadcasts")) {
    const body = JSON.stringify({ messages: [], hasMore: false });
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => body, json: async () => JSON.parse(body) };
  }
  return { ok: false, status: 404, headers: { get: () => null }, text: async () => "", json: async () => ({}) };
};
// the open room's 8 s poll is an interval: count the live ones
const liveIntervals = new Set();
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (fn, ms, ...args) => { const id = realSetInterval(fn, ms, ...args); liveIntervals.add(id); return id; };
globalThis.clearInterval = (id) => { liveIntervals.delete(id); realClearInterval(id); };

const { createIndexerTrackedRooms, onTrackedRoomsAnswer } = await import("../engine/indexer-tracked-rooms.js");
const { setReportedBroadcastChannels, DROPPED_ROOM_GRACE_MS } = await import("../engine/broadcasts.js");
const rooms = await import("../ui/broadcasts.js");
const { applyRoomListAnswer, roomJoinedByOtherAccount, DROPPED_ROOM_MISSES, DROPPED_ROOM_MISS_SPACING_MS } = rooms;
const HOUR = 60 * 60 * 1000;

// --- 1. the miss count (pure) ------------------------------------------------------------------------
await test("a room is left only after two answers at least an hour apart lack it", () => {
  assert.equal(DROPPED_ROOM_MISSES, 2);
  assert.equal(DROPPED_ROOM_MISS_SPACING_MS, HOUR);
  const t = 1_000_000_000;
  let step = applyRoomListAnswer({}, ["gone"], t);
  assert.deepEqual(step.dropped, [], "one answer lacks it: kept");
  assert.deepEqual(step.record.gone, { since: t, misses: 1, lastAt: t });
  step = applyRoomListAnswer(step.record, ["gone"], t + 59 * 60_000);
  assert.deepEqual(step.dropped, [], "a second answer within the hour doesn't count");
  assert.equal(step.record.gone.misses, 1);
  step = applyRoomListAnswer(step.record, ["gone"], t + HOUR);
  assert.deepEqual(step.dropped, ["gone"], "two answers an hour apart: left");
  assert.equal(step.record.gone, undefined, "and no longer counted");
});

await test("a room that's back on the list starts over; a bad record counts from now", () => {
  const t = 2_000_000_000;
  let step = applyRoomListAnswer({}, ["flaky"], t);
  step = applyRoomListAnswer(step.record, [], t + HOUR); // listed again
  assert.deepEqual(step.record, {}, "its count is gone");
  step = applyRoomListAnswer(step.record, ["flaky"], t + 2 * HOUR);
  assert.equal(step.record.flaky.misses, 1, "counting starts again");
  // the old record (a bare wall-clock time from the saved list) and a clock that ran back are not trusted
  for (const old of [t - 30 * 24 * HOUR, { since: t, misses: 5, lastAt: t + 10 * HOUR }, { misses: "x" }, null]) {
    const fresh = applyRoomListAnswer({ room: old }, ["room"], t);
    assert.deepEqual(fresh.dropped, [], `${JSON.stringify(old)}: not left`);
    assert.deepEqual(fresh.record.room, { since: t, misses: 1, lastAt: t });
  }
});

await test("a switched-off room also waits out its grace since the first answer that lacked it", () => {
  const t = 3_000_000_000;
  const grace = () => DROPPED_ROOM_GRACE_MS;
  let step = applyRoomListAnswer({}, ["off"], t, grace);
  step = applyRoomListAnswer(step.record, ["off"], t + 2 * HOUR, grace);
  assert.deepEqual(step.dropped, [], "two misses, but not a week yet");
  assert.equal(step.record.off.misses, 2);
  step = applyRoomListAnswer(step.record, ["off"], t + DROPPED_ROOM_GRACE_MS, grace);
  assert.deepEqual(step.dropped, ["off"], "a week since the first miss: left");
});

await test("every answer reaches the answer listeners, changed or not", () => {
  const data = {};
  const tracked = createIndexerTrackedRooms({
    storage: { getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } },
    reportedKey: "r", servedKey: "s", now: () => 42,
  });
  const heard = [];
  const stop = onTrackedRoomsAnswer((answer) => heard.push(answer));
  assert.equal(tracked.setReported(["b", "A"]), true);
  assert.equal(tracked.setReported(["a", "b"]), false, "the same list: no change");
  tracked.setReported([]);
  stop();
  tracked.setReported(["c"]);
  assert.deepEqual(heard, [{ channels: ["a", "b"], at: 42 }, { channels: ["a", "b"], at: 42 }, { channels: [], at: 42 }]);
});

// --- 3. whose rooms are joined (pure) -------------------------------------------------------------------
await test("another account's joined list keeps a room's rows; this account's own list doesn't", () => {
  const data = {
    "acct:kaspa:qme:kachat-broadcast-channels-v1": JSON.stringify(["mine", "both"]),
    "acct:kaspa:qother:kachat-broadcast-channels-v1": JSON.stringify(["both"]),
    "acct:kaspa:qbroken:kachat-broadcast-channels-v1": "not json",
    "acct:kaspa:qother:kachat-broadcast-notify-v1": JSON.stringify({ mine: true }),
  };
  const keys = Object.keys(data);
  const own = "acct:kaspa:qme:kachat-broadcast-channels-v1";
  const get = (k) => data[k] ?? null;
  assert.equal(roomJoinedByOtherAccount(keys, own, get, "both"), true);
  assert.equal(roomJoinedByOtherAccount(keys, own, get, "mine"), false, "a bell elsewhere isn't a join");
  assert.equal(roomJoinedByOtherAccount(null, own, get, "both"), false);
});

// --- ui/broadcasts.js ------------------------------------------------------------------------------------
const ME = "kaspa:qaccountone";
const OTHER = "kaspa:qaccounttwo";
const SENDER = "kaspa:qzk2jrk7wq3zdw2n0260v87fglky82cg5u3pwy73wpktk3u864yecm5djll40";
const engine = { address: ME, onConnectionState: noop, onBroadcastBlockHits: noop, setBroadcastScanChannels: noop };
const scopedFor = (address, key) => `acct:${address}:${key}`;
const scoped = (key) => (engine.address ? scopedFor(engine.address, key) : key);
const CACHE_KEY = "kachat-broadcast-messages-cache-v1";
const now = Date.now();
const txid = (n) => n.toString(16).padStart(64, "0");

for (const address of [ME, OTHER]) {
  // past the once-per-account clean-ups, so they leave nothing here
  storage.set(scopedFor(address, "kachat-rooms-silenced-once-v1"), "1");
  storage.set(scopedFor(address, "kachat-rooms-opt-in-v1"), "1");
}
storage.set(scopedFor(ME, "kachat-broadcast-channels-v1"), JSON.stringify(["gone-room", "shared-room", "solo-room"]));
storage.set(scopedFor(OTHER, "kachat-broadcast-channels-v1"), JSON.stringify(["shared-room"]));
// last session the indexer listed gone-room; the list saved since lacks it, and the old record says it
// has been missing three days by the wall clock
storage.set(scopedFor(ME, "kachat-rooms-indexer-listed-v1"), JSON.stringify(["gone-room"]));
storage.set("kachat-broadcast-tracked-reported-v1", JSON.stringify(["kaspa"]));
storage.set(scopedFor(ME, "kachat-broadcast-hidden-missing-v1"), JSON.stringify({ "gone-room": now - 3 * 24 * HOUR }));
// shared-room: a message from someone, then the other account's failed send (newer)
storage.set(CACHE_KEY, JSON.stringify({
  "shared-room": [
    { txId: txid(1), senderAddress: SENDER, content: "hello room", blockTime: now - 60_000 },
    { txId: "pending-1-abcde", senderAddress: OTHER, content: "my failed send", blockTime: now - 30_000, status: "failed" },
    { txId: "pending-2-abcde", senderAddress: OTHER, content: "still sending", blockTime: now - 20_000, status: "pending" },
  ],
  "solo-room": [{ txId: txid(2), senderAddress: SENDER, content: "solo message", blockTime: now - 60_000 }],
}));
// this account read shared-room long ago: one unread
storage.set(scopedFor(ME, "kachat-broadcast-read-v1"), JSON.stringify({ markers: { "shared-room": 1 }, unread: {} }));

const visibility = [];
rooms.initBroadcasts({
  engine,
  accountScopedKey: scoped,
  escapeHtml: (value) => String(value),
  shortAddress: (address) => String(address).slice(0, 12),
  onUnreadChanged: noop,
  onRoomRemoved: noop,
  onRoomVisibility: (shown) => visibility.push(shown),
  blockedAccounts: () => [],
});
const byName = () => new Map(rooms.chatListRooms().map((room) => [room.name, room]));
const storedJson = (key) => JSON.parse(storage.get(scoped(key)) || "null");
const realNow = Date.now;

await test("boot never leaves a room on the saved list's word (#1)", () => {
  assert.equal(byName().get("gone-room")?.joined, true, "still joined after a restart days later");
  rooms.refreshBroadcasts();
  rooms.resetBroadcastsForAccount();
  assert.equal(byName().get("gone-room")?.joined, true, "and after reloads with no fresh answer");
});

await test("fresh answers: one lacking it keeps it, an empty one counts for nothing, a listing starts over (#1)", () => {
  const start = realNow();
  try {
    Date.now = () => start;
    setReportedBroadcastChannels(["kaspa"]);
    assert.equal(byName().get("gone-room")?.joined, true, "one answer lacks it: kept");
    assert.equal(storage.get(scoped("kachat-broadcast-hidden-missing-v1")), undefined, "the old wall-clock record is gone");
    assert.equal(storedJson("kachat-rooms-indexer-missing-v2")["gone-room"].misses, 1);
    Date.now = () => start + 2 * HOUR;
    setReportedBroadcastChannels([]);
    assert.equal(byName().get("gone-room")?.joined, true, "an empty answer leaves nothing");
    assert.equal(storedJson("kachat-rooms-indexer-missing-v2")["gone-room"].misses, 1, "nor counts");
    Date.now = () => start + 3 * HOUR;
    setReportedBroadcastChannels(["kaspa", "gone-room"]);
    assert.equal(storage.get(scoped("kachat-rooms-indexer-missing-v2")), undefined, "listed again: its count is gone");
  } finally {
    Date.now = realNow;
  }
});

await test("dropped while open: left after two answers an hour apart, its pane closed and its poll stopped (#1, #6)", () => {
  const start = realNow();
  try {
    Date.now = () => start;
    const before = liveIntervals.size;
    rooms.openBroadcastRoom("gone-room");
    assert.equal(rooms.activeBroadcastChannelName(), "gone-room");
    assert.equal(liveIntervals.size, before + 1, "a tracked room polls while open");
    setReportedBroadcastChannels(["kaspa"]);
    Date.now = () => start + 30 * 60_000;
    setReportedBroadcastChannels(["kaspa"]);
    assert.equal(byName().get("gone-room")?.joined, true, "two answers, but half an hour apart: kept");
    Date.now = () => start + HOUR;
    setReportedBroadcastChannels(["kaspa"]);
    assert.equal(byName().has("gone-room"), false, "left");
    assert.equal(rooms.activeBroadcastChannelName(), null, "the pane is closed");
    assert.equal(visibility.at(-1), false, "the room view went away");
    assert.equal(liveIntervals.size, before, "its poll stopped");
  } finally {
    Date.now = realNow;
  }
});

await test("another account's unsent rows never show as messages (#4)", () => {
  const shared = byName().get("shared-room");
  assert.match(shared.preview, /hello room/, "the preview is the last real message");
  assert.doesNotMatch(shared.preview, /failed send|still sending/);
  assert.equal(shared.lastMessageAt, now - 60_000, "nor do they order the list");
  const render = fnSource(roomsSource, "renderRoom");
  assert.match(render, /!isOtherAccountsUnsentRow\(m\)/, "the room view skips them too");
});

await test("leaving a room another account still has keeps its rows; the read marker goes (#3, #5)", async () => {
  assert.equal(byName().get("shared-room").unread, 1, "one unread before leaving");
  rooms.removeBroadcastRooms(["shared-room"]);
  assert.equal(byName().has("shared-room"), false, "left");
  assert.equal(storedJson("kachat-broadcast-read-v1").markers["shared-room"], undefined, "its read marker is gone");
  rooms.joinBroadcastRoom("shared-room");
  const back = byName().get("shared-room");
  assert.equal(back.unread, 0, "rejoining counts from now");
  assert.match(back.preview, /hello room/, "the history the other account has is still here");
  // the solo room is nobody else's: its rows go with it
  rooms.removeBroadcastRooms(["solo-room"]);
  rooms.joinBroadcastRoom("solo-room");
  assert.equal(byName().get("solo-room").preview, "", "rows gone");
  await new Promise((resolve) => setTimeout(resolve, 600)); // the cache's debounced save
  const cache = JSON.parse(storage.get(CACHE_KEY));
  assert.equal(cache["solo-room"], undefined);
  assert.ok(cache["shared-room"].some((m) => m.txId === txid(1)), "shared-room's rows saved still");
});

await test("an account change keeps the whole cache in memory, and a re-read pages history in again (#2)", () => {
  // the stored copy is trimmed; the copy in memory is the whole one
  storage.set(CACHE_KEY, "{}");
  engine.address = OTHER;
  rooms.resetBroadcastsForAccount();
  assert.match(byName().get("shared-room").preview, /my failed send|still sending/, "the other account sees its own unsent rows");
  engine.address = ME;
  rooms.resetBroadcastsForAccount();
  assert.match(byName().get("shared-room").preview, /hello room/, "not re-read from the trimmed copy");
  assert.match(fnSource(roomsSource, "resetBroadcastsForAccount"), /loadState\(\{ caches: false \}\);/);
  const load = fnSource(roomsSource, "loadState");
  assert.match(load, /if \(cachesLoaded\) \{\s*deepBackfilled\.clear\(\);\s*deepBackfillDone\.clear\(\);\s*deepBackfillFloor\.clear\(\);/,
    "reading the stored copy over held rows lets each room page its history in again");
});

console.log(`audit 2026-11-27 rooms: ${passed} passed`);
process.exit(0);
