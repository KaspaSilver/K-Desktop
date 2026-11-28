// K 01f71184 (release and smoothness audits 2026-11-27), the chats / groups / rooms / polling part:
// 1. T1: a public room stays pinned to its newest message while its rows grow (link previews);
// 2. B4/B5: with Web Push on and proven, push-covered rooms are swept every 5 minutes, the group
//    pass (when every group is pushed and none is open) every 3, the inbox every second beat; a
//    push reads its kind at once; nothing changes while push is off or unproven; the unnamed-
//    identity sweep sleeps to the foreground beat;
// 3. C2: the Chats list is drawn again after local midnight;
// 5. C6: jump to newest lands a screen short first when far up, then glides.
// Pure modules first, then source checks on ui/app.js, ui/broadcasts.js and ui/kachat-names-live.js.
// Run from the repo root:
//
//   node tools/test-ios-01f71184-chats.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createPushReliability, createPushPollGate, intervalDue, PUSH_SAFETY_NET_MS, GROUP_PASS_PUSH_MS,
  PUSH_FORCE_WINDOW_MS, PUSH_OBSERVATION_GRACE_MS,
} from "../ui/push-poll-gate.js";
import { nearBottomStart, jumpToLatest } from "../ui/jump-to-latest.js";
import { localDayKey, delayToNextLocalMidnight, onDayChange } from "../ui/day-change.js";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const app = read("ui/app.js");
const rooms = read("ui/broadcasts.js");
const names = read("ui/kachat-names-live.js");

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

/** Timers run by hand. */
function fakeTimers() {
  const queue = [];
  return {
    setTimer: (fn, ms) => { queue.push({ fn, ms }); return queue.length; },
    async runAll() { while (queue.length) await queue.shift().fn(); },
    get count() { return queue.length; },
  };
}

// --- push reliability (K PushReliabilityState) -----------------------------------------------------
await test("reliability: a matched push makes it reliable, three misses in a row unreliable", async () => {
  const arrivedSet = new Set();
  const timers = fakeTimers();
  const r = createPushReliability({ arrived: async (key) => arrivedSet.has(key), setTimer: timers.setTimer });
  assert.equal(r.state(), "unknown");
  assert.equal(r.observe("AA"), true);
  assert.equal(r.observe("aa"), false, "one check per txid");
  arrivedSet.add("aa");
  await timers.runAll();
  assert.equal(r.state(), "reliable");
  for (const tx of ["b1", "b2"]) r.observe(tx);
  await timers.runAll();
  assert.equal(r.state(), "reliable", "two misses are not enough");
  r.observe("b3");
  await timers.runAll();
  assert.equal(r.state(), "unreliable");
  arrivedSet.add("c1");
  r.observe("c1");
  await timers.runAll();
  assert.equal(r.state(), "reliable", "a push that comes again restores it");
  assert.equal(r.misses(), 0);
});

await test("reliability: a reset (account switch) drops the checks under way", async () => {
  const timers = fakeTimers();
  const r = createPushReliability({ arrived: async () => true, setTimer: timers.setTimer });
  r.observe("x");
  r.reset("kaspa:other");
  await timers.runAll();
  assert.equal(r.state(), "unknown");
  assert.equal(r.account(), "kaspa:other");
  assert.equal(PUSH_OBSERVATION_GRACE_MS, 60_000);
});

// --- the gate --------------------------------------------------------------------------------------
function gateWith({ operational = true, covers = true } = {}) {
  let t = 1_000_000_000_000;
  const timers = fakeTimers();
  const pushes = new Set();
  const flags = { operational, covers, account: "kaspa:me" };
  const gate = createPushPollGate({ now: () => t, beatMs: () => 30_000, setTimer: timers.setTimer, listen: false });
  gate.configure({
    operational: () => flags.operational,
    account: () => flags.account,
    arrived: async (key) => pushes.has(key),
    pushCoversGroups: () => flags.covers,
  });
  return {
    gate, timers, flags, pushes,
    advance(ms) { t += ms; },
    async prove() { pushes.add("proof"); gate.observeIncoming("proof"); await timers.runAll(); },
  };
}

await test("gate: unconfigured, every turn is due (the old cadence)", () => {
  const gate = createPushPollGate({ listen: false });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(gate.takeInboxTurn(), true);
    assert.equal(gate.takeGroupTurn(), true);
    assert.equal(gate.takeCoveredRoomsTurn(), true);
  }
  assert.equal(gate.observeIncoming("tx"), false, "nothing is checked without push");
});

await test("gate: push on but not yet proven keeps every sweep", async () => {
  const h = gateWith();
  for (let i = 0; i < 3; i += 1) {
    h.advance(5_000);
    assert.equal(h.gate.takeInboxTurn(), true);
    assert.equal(h.gate.takeGroupTurn(), true);
    assert.equal(h.gate.takeCoveredRoomsTurn(), true);
  }
  // a miss leaves it unproven
  h.gate.observeIncoming("missed");
  await h.timers.runAll();
  assert.equal(h.gate.pushIsReliable(), false);
  assert.equal(h.gate.takeInboxTurn(), true);
});

await test("gate: proven push reads the inbox every second beat", async () => {
  const h = gateWith();
  await h.prove();
  assert.equal(h.gate.pushIsReliable(), true);
  assert.equal(h.gate.takeInboxTurn(), true, "the first turn reads");
  h.advance(5_000);
  assert.equal(h.gate.takeInboxTurn(), false);
  h.advance(30_000);
  assert.equal(h.gate.takeInboxTurn(), false, "one beat later: not yet");
  h.advance(25_000);
  assert.equal(h.gate.takeInboxTurn(), true, "two beats (less the slack) later");
  h.advance(5_000);
  assert.equal(h.gate.takeInboxTurn({ catchUp: true }), true, "a catch-up always reads");
});

await test("gate: a chat push reads the inbox on every sweep for 20 s; a group push the groups", async () => {
  const h = gateWith();
  await h.prove();
  h.gate.takeInboxTurn();
  h.gate.takeGroupTurn();
  h.gate.pushed("contextual");
  h.advance(5_000);
  assert.equal(h.gate.takeInboxTurn(), true);
  h.advance(5_000);
  assert.equal(h.gate.takeInboxTurn(), true);
  assert.equal(h.gate.takeGroupTurn(), false, "a chat push doesn't move the groups");
  h.advance(PUSH_FORCE_WINDOW_MS);
  assert.equal(h.gate.takeInboxTurn(), false, "the window closed");
  h.gate.pushed("group_message");
  h.advance(1_000);
  assert.equal(h.gate.takeGroupTurn(), true);
  assert.equal(h.gate.takeInboxTurn(), false, "a group push doesn't read the inbox");
  h.gate.pushed("broadcast");
  h.gate.pushed("kaposts");
  h.advance(PUSH_FORCE_WINDOW_MS);
  assert.equal(h.gate.takeInboxTurn(), false, "room and KaPost pushes have their own fetch");
});

await test("gate: the group pass runs every 3 minutes only when push covers every group and none is open", async () => {
  const h = gateWith();
  await h.prove();
  assert.equal(h.gate.takeGroupTurn(), true);
  h.advance(5_000);
  assert.equal(h.gate.takeGroupTurn(), false);
  assert.equal(h.gate.takeGroupTurn({ groupOpen: true }), true, "an open group keeps every sweep");
  h.advance(5_000);
  h.flags.covers = false;
  assert.equal(h.gate.takeGroupTurn(), true, "a muted group or member keeps every sweep");
  h.flags.covers = true;
  h.advance(5_000);
  assert.equal(h.gate.takeGroupTurn(), false);
  h.advance(GROUP_PASS_PUSH_MS);
  assert.equal(h.gate.takeGroupTurn(), true, "the safety net");
  assert.ok(GROUP_PASS_PUSH_MS <= PUSH_SAFETY_NET_MS, "never slower than K's 5-minute net");
});

await test("gate: covered rooms every 5 minutes; back in front reads everything again", async () => {
  const h = gateWith();
  await h.prove();
  assert.equal(h.gate.takeCoveredRoomsTurn(), true);
  h.advance(30_000);
  assert.equal(h.gate.takeCoveredRoomsTurn(), false);
  h.advance(PUSH_SAFETY_NET_MS - 30_000);
  assert.equal(h.gate.takeCoveredRoomsTurn(), true);
  h.advance(30_000);
  h.gate.takeInboxTurn();
  h.gate.takeGroupTurn();
  h.gate.backInFront();
  assert.equal(h.gate.takeCoveredRoomsTurn(), true);
  assert.equal(h.gate.takeInboxTurn(), true);
  assert.equal(h.gate.takeGroupTurn(), true);
});

await test("gate: push switched off or another account starts over", async () => {
  const h = gateWith();
  await h.prove();
  h.gate.takeCoveredRoomsTurn();
  h.flags.operational = false;
  assert.equal(h.gate.pushIsReliable(), false);
  assert.equal(h.gate.takeCoveredRoomsTurn(), true);
  h.flags.operational = true;
  assert.equal(h.gate.pushIsReliable(), false, "proof is needed again");
  await h.prove();
  assert.equal(h.gate.pushIsReliable(), true);
  h.flags.account = "kaspa:other";
  assert.equal(h.gate.pushIsReliable(), false, "proof is per account");
  assert.equal(intervalDue(0, 1000, 5), true);
});

// --- jump to newest (C6) -----------------------------------------------------------------------------
await test("jump to newest: far up lands a screen short, then glides", () => {
  assert.equal(nearBottomStart({ scrollTop: 0, scrollHeight: 50_000, clientHeight: 800 }), 50_000 - 1600);
  assert.equal(nearBottomStart({ scrollTop: 50_000 - 800 - 2000, scrollHeight: 50_000, clientHeight: 800 }), null, "within three screens: glide all the way");
  assert.equal(nearBottomStart({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }), null, "hidden");
  const el = { scrollTop: 100, scrollHeight: 40_000, clientHeight: 1000, calls: [], scrollTo(options) { this.calls.push(options); } };
  jumpToLatest(el);
  assert.equal(el.scrollTop, 38_000);
  assert.deepEqual(el.calls, [{ top: 40_000, behavior: "smooth" }]);
  jumpToLatest(null);
});

// --- midnight (C2) -----------------------------------------------------------------------------------
await test("day change: a timer just past local midnight, and a check on coming back", async () => {
  const late = new Date(2026, 10, 27, 23, 59, 0).getTime();
  assert.equal(delayToNextLocalMidnight(late), 61_000);
  assert.notEqual(localDayKey(late), localDayKey(late + 61_000));
  let t = late;
  const timers = [];
  const listeners = {};
  const doc = { visibilityState: "visible", addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener: () => {} };
  let runs = 0;
  const stop = onDayChange(() => { runs += 1; }, { now: () => t, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {}, doc });
  assert.equal(timers.at(-1).ms, 61_000);
  t += 61_000;
  timers.at(-1).fn();
  assert.equal(runs, 1);
  listeners.visibilitychange();
  assert.equal(runs, 1, "same day: once");
  t += 24 * 3600 * 1000;
  listeners.visibilitychange();
  assert.equal(runs, 2, "asleep past midnight: drawn on return");
  stop();
});

// --- the app's wiring ----------------------------------------------------------------------------------
await test("app: the sweep's inbox and group pass ask the gate; pushes and incoming messages feed it", () => {
  const sweep = fnSource(app, "refreshAllConversations");
  assert.match(sweep, /if \(hasIndexer && pushPollGate\.takeInboxTurn\(\{ catchUp \}\)\) try \{ added \+= await syncInbox\(\{ catchUp \}\); \}/);
  assert.match(sweep, /if \(pushPollGate\.takeGroupTurn\(\{ catchUp, groupOpen: Boolean\(activeGroupId\) && !document\.hidden \}\)\) try \{ added \+= await syncGroupsNow\(\{ catchUp \}\); \}/);
  // the per-contact sweep itself is untouched (Desktop's 5 s sweep stays the 1:1 live path)
  assert.match(sweep, /await syncOneConversation\(conversationEntry, \{ quiet, catchUp \}\)/);
  const notify = fnSource(app, "maybeNotifyIncoming");
  assert.ok(notify.indexOf("pushPollGate.observeIncoming(notificationKeyForMessage(message))") < notify.indexOf("if (chatOnScreen(conversationEntry.id) && appIsInFront()) return;"));
  assert.ok(notify.indexOf("if (!recent) return;") < notify.indexOf("pushPollGate.observeIncoming"), "only live messages count");
  const onPush = app.slice(app.indexOf("  onPush: (data = {}) => {"), app.indexOf("  onRoomPush:"));
  assert.ok(onPush.indexOf("pushPollGate.pushed(data.type);") < onPush.indexOf("if (pushFetchTimer || !engine.address) return;"));
  assert.match(app, /pushPollGate\.configure\(\{\n  operational: \(\) => pushNotificationsEnabled\(\) && webPushStatus\(\)\?\.state === "on",/);
  assert.match(app, /arrived: \(txId\) => pushArrivedRecently\(txId\),/);
  assert.match(app, /return streams <= PUSH_LIMITS\.groups;/);
});

await test("app: rooms pin while growing, jump buttons glide only the last screen, midnight redraws Chats", () => {
  assert.match(app, /keepChatPinnedWhileGrowing\(document\.querySelector\("\[data-broadcast-room-body\]"\)\);/);
  assert.match(app, /btn\.addEventListener\("click", \(\) => jumpToLatest\(messageArea\)\);/);
  assert.match(app, /btn\.addEventListener\("click", \(\) => jumpToLatest\(groupMessageArea\)\);/);
  assert.doesNotMatch(app, /scrollTo\(\{ top: (messageArea|groupMessageArea)\.scrollHeight, behavior: "smooth" \}\)/);
  assert.match(app, /onDayChange\(\(\) => \{ try \{ renderChats\(\); \}/);
  assert.match(rooms, /btn\.addEventListener\("click", \(\) => jumpToLatest\(roomBodyEl\)\);/);
});

await test("rooms: a push-covered room is skipped between safety-net sweeps, after its first sweep", () => {
  const sweep = fnSource(rooms, "sweepClosedRooms");
  assert.match(sweep, /const coveredDue = pushPollGate\.takeCoveredRoomsTurn\(\);/);
  assert.match(sweep, /if \(!coveredDue && roomPushCovers\(name\) && sweptRooms\.has\(name\)\) continue;/);
  assert.match(sweep, /sweptRooms\.add\(name\);/);
  const covers = fnSource(rooms, "roomPushCovers");
  for (const part of ["notifyByChannel[name]", "isIndexerTrackedBroadcastChannel(name)", "curatedShown(name)", "!indexerOverrideFor(name)"]) assert.ok(covers.includes(part), part);
  // the open room keeps its own poll; a room push still fetches its room
  assert.match(rooms, /pollTimer = window\.setInterval\(\(\) => \{ if \(!document\.hidden\) backfillChannel\(channel\); \}, POLL_MS\);/);
  assert.match(rooms, /export function fetchRoomBeforePushBanner\(/);
});

await test("names: the unnamed-identity sweep sleeps to the foreground beat, about once a minute", () => {
  assert.match(names, /onForegroundBeat\(\(\) => \(unnamedSweepPassDue\(lastPassAt, Date\.now\(\)\) \? run\(\) : null\), \{ offsetMs: 1600 \}\)/);
  assert.doesNotMatch(names, /setTimeout\(tick, UNNAMED_SWEEP_EVERY_MS\)/);
  const due = fnSource(names, "unnamedSweepPassDue");
  const unnamedSweepPassDue = new Function(`const UNNAMED_SWEEP_EVERY_MS = 60000; return (${due.replace(/^export /, "")});`)();
  assert.equal(unnamedSweepPassDue(0, 30_000), false);
  assert.equal(unnamedSweepPassDue(0, 55_000), true);
});

console.log(`test-ios-01f71184-chats: ${passed} passed`);
