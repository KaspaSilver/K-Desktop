// node tools/test-k-961-chat.mjs - the chat, chess and battery changes ported from K 961fc05a
// (AUDIT_2026-11-25): one voice at a time with recorders and previews included, the voice-note
// info cache, the 1:1 chess clock that runs only with the board open and the page showing, the
// shared foreground beat, and the kUSDT builder's idle teardown.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createVoicePlaybackCoordinator } from "../ui/voice-coordinator.js";
import { voiceInfoKey, createVoiceInfoCache, VOICE_INFO_CAP } from "../ui/voice-info-cache.js";
import { chessClockShouldRun, chessClockNextTickMs, CHESS_CLOCK_SAVE_MS } from "../ui/chess-clock.js";
import { delayToNextBeat, beatIntervalMs, onForegroundBeat, BEAT_MS, BEAT_EXPENSIVE_MS } from "../ui/foreground-beat.js";
import { formatChessClock } from "../engine/chess.js";
import { createKusdtCore, sha256Hex, IDLE_TEARDOWN_MS } from "../engine/kusdt-core.js";
import { KUSDT_POLL_MS } from "../ui/kusdt-wallet.js";

const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
const broadcasts = readFileSync(new URL("../ui/broadcasts.js", import.meta.url), "utf8");
const kusdtWallet = readFileSync(new URL("../ui/kusdt-wallet.js", import.meta.url), "utf8");
const namesLive = readFileSync(new URL("../ui/kachat-names-live.js", import.meta.url), "utf8");

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${name}`); }
  catch (error) { console.error(`FAIL ${name}\n`, error); process.exitCode = 1; }
}
const between = (src, start, end) => {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `missing ${start}`);
  const j = src.indexOf(end, i + start.length);
  assert.ok(j > i, `missing ${end}`);
  return src.slice(i, j);
};

// --- voice: one at a time, recorders included ---------------------------------------------------

await test("voice: starting one stops the one playing; its own stop doesn't stop the next", () => {
  const c = createVoicePlaybackCoordinator();
  const stopped = [];
  assert.equal(c.willStart("a", () => stopped.push("a")), true);
  assert.equal(c.willStart("b", () => stopped.push("b")), true);
  assert.deepEqual(stopped, ["a"]);
  c.didStop("a"); // a's late pause event
  assert.equal(c.current, "b", "a's stop leaves b playing");
  c.didStop("b");
  assert.equal(c.current, null);
  assert.equal(c.willStart("b", () => stopped.push("b")), true);
  assert.equal(c.willStart("b", () => stopped.push("b")), true, "the same one again: not stopped");
  assert.deepEqual(stopped, ["a"]);
});

await test("voice: a recording stops the note playing, and nothing plays until it ends", () => {
  const c = createVoicePlaybackCoordinator();
  const stopped = [];
  c.willStart("note", () => stopped.push("note"));
  const recorder = {};
  c.recordingWillStart(recorder);
  assert.deepEqual(stopped, ["note"]);
  assert.equal(c.isRecording, true);
  assert.equal(c.willStart("preview", () => {}), false, "no playing while recording");
  c.recordingDidEnd({}); // another recorder's end
  assert.equal(c.isRecording, true);
  c.recordingDidEnd(recorder);
  assert.equal(c.willStart("preview", () => {}), true);
});

await test("voice: every player, preview and recorder goes through the coordinator", () => {
  const player = between(app, "function buildVoicePlayer(", "function buildNextcloudRevealCard(");
  assert.match(player, /voicePlayback\.willStart\(audio, \(\) => audio\.pause\(\)\)/);
  assert.match(player, /"pause", \(\) => \{ voicePlayback\.didStop\(audio\)/);
  assert.match(player, /"ended", \(\) => \{ voicePlayback\.didStop\(audio\)/);
  assert.doesNotMatch(player, /querySelectorAll\("\.voice-player audio"\)/, "the old DOM sweep missed previews and detached players");
  const preview = between(app, "function toggleVoicePreviewPlayback(", "const chatVoiceRecorder = createVoiceRecorder(");
  assert.match(preview, /voicePlayback\.willStart\(entry, stop\)/);
  assert.match(preview, /voicePlayback\.didStop\(entry\)/);
  assert.match(between(app, "function clearVoicePreview(", "function toggleVoicePreviewPlayback("), /voicePlayback\.didStop\(entry\)/);
  const recorder = between(app, "function createVoiceRecorder(", "return { start, stop, isRecording");
  assert.match(recorder, /recorder\.start\(\);[\s\S]{0,160}voicePlayback\.recordingWillStart\(recorder\)/);
  assert.match(recorder, /if \(recorder\) voicePlayback\.recordingDidEnd\(recorder\)/);
  const group = between(app, "async function startGroupVoice(", "function stopGroupVoiceTimer(");
  assert.match(group, /voicePlayback\.recordingWillStart\(recorderToken\)/);
  assert.match(group, /onstop = \(\) => \{[^}]*voicePlayback\.recordingDidEnd\(recorderToken\)/);
  assert.match(group, /if \(groupVoiceRecorder\) voicePlayback\.recordingDidEnd\(groupVoiceRecorder\)/, "a failed start doesn't leave a recording held");
});

// --- voice note info cache ---------------------------------------------------------------------

await test("voice info: a note is decoded once, however many times its bubble is drawn", async () => {
  const cache = createVoiceInfoCache();
  let decodes = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const decode = async () => { decodes += 1; await gate; return { samples: [1], duration: 3 }; };
  const key = voiceInfoKey("data:audio/webm;base64,AAAABBBB");
  const first = cache.load(key, decode);
  const again = cache.load(key, decode); // the thread drawn again while the first decode runs
  release();
  assert.deepEqual(await first, { samples: [1], duration: 3 });
  assert.equal(await again, await first);
  assert.equal(decodes, 1);
  await cache.load(key, decode);
  assert.equal(decodes, 1, "and after it finished");
});

await test("voice info: a note that couldn't be read is tried again; the cap drops the oldest", async () => {
  const cache = createVoiceInfoCache({ cap: 3 });
  let tries = 0;
  assert.equal(await cache.load("bad", async () => { tries += 1; throw new Error("EncodingError"); }), null);
  assert.equal(cache.has("bad"), false);
  await cache.load("bad", async () => { tries += 1; return { samples: [], duration: 1 }; });
  assert.equal(tries, 2);
  for (const k of ["a", "b", "c"]) await cache.load(k, async () => ({ samples: [], duration: 1 }));
  assert.equal(cache.size, 3);
  assert.equal(cache.has("bad"), false, "least recently used first out");
  assert.equal(VOICE_INFO_CAP, 500);
});

await test("voice info: keys tell notes apart without keeping the whole data URL", () => {
  const a = `data:audio/webm;base64,${"A".repeat(200_000)}B`;
  const b = `data:audio/webm;base64,${"A".repeat(100_000)}C${"A".repeat(99_999)}B`;
  assert.notEqual(voiceInfoKey(a), voiceInfoKey(b), "same length, same tail, different middle");
  assert.equal(voiceInfoKey(a), voiceInfoKey(`${a}`));
  assert.ok(voiceInfoKey(a).length < 120);
  assert.equal(voiceInfoKey("blob:https://x/1"), "blob:https://x/1");
  assert.match(app, /return voiceWaveformCache\.load\(voiceInfoKey\(src\), \(\) => decodeWaveformNow\(src\)\)/);
});

// --- 1:1 chess clock ----------------------------------------------------------------------------

await test("chess clock: runs only on my turn in a timed game, board open and page showing", () => {
  const on = { timed: true, over: false, myTurn: true, timeoutSent: false, boardShown: true, pageVisible: true };
  assert.equal(chessClockShouldRun(on), true);
  for (const [key, value] of [["timed", false], ["over", true], ["myTurn", false], ["timeoutSent", true], ["boardShown", false], ["pageVisible", false]]) {
    assert.equal(chessClockShouldRun({ ...on, [key]: value }), false, key);
  }
});

await test("chess clock: the chip is redrawn just after its shown second (or tenth) changes", () => {
  for (const remaining of [65_432, 12_000, 10_001, 9_999, 9_950, 450, 100]) {
    const wait = chessClockNextTickMs(remaining);
    assert.ok(wait >= 1 && wait <= 1_000, `${remaining}: ${wait}`);
    assert.notEqual(formatChessClock(remaining - wait), formatChessClock(remaining), `${remaining} changes after ${wait} ms`);
    assert.equal(formatChessClock(remaining - wait + 1), formatChessClock(remaining), `${remaining}: not a tick early`);
  }
  // "0:00.0" already shown: the next tick is the one that runs out, and flags
  for (const remaining of [99, 1]) assert.ok(chessClockNextTickMs(remaining) > remaining);
  assert.equal(chessClockNextTickMs(0), 0);
  assert.equal(chessClockNextTickMs(-5), 0);
  assert.equal(CHESS_CLOCK_SAVE_MS, 5_000);
});

await test("chess clock: elapsed from a start date, banked on stop, no ticking timer when stopped", () => {
  const clock = between(app, "function chessTurnElapsedMs(", "function chessMyClockRunning(");
  assert.match(clock, /chessState\.clockRunStart \? banked \+ Math\.max\(0, at - chessState\.clockRunStart\) : banked/);
  const body = between(app, "function syncChessTurnElapsed(", "// Flagging: my clock hit zero");
  assert.doesNotMatch(body, /setInterval/, "no 5x-a-second interval");
  assert.match(body, /function scheduleChessClockTick\(\) \{\s*stopChessClockTimer\(\);\s*if \(!chessState\?\.clockRunStart\) return;/, "nothing scheduled while stopped (untimed games included)");
  assert.match(body, /CHESS_CLOCK_SAVE_MS\) persistChessClock\(\)/, "saved every 5 s while it runs");
  assert.match(body, /pageVisible: typeof document === "undefined" \|\| !document\.hidden/);
  assert.match(body, /document\.addEventListener\("visibilitychange", \(\) => \{ if \(chessState\) syncChessClock\(\); \}\)/);
  assert.match(between(app, "function closeChess(", "function buildChessInviteBubble("), /if \(chessState\?\.clockRunStart\) bankChessClock\(\);\s*chessState = null;/);
  assert.match(between(app, "function doChessMove(", "function showChessPromo("), /if \(chessState\.clockRunStart\) \{ bankChessClock\(\); stopChessClockTimer\(\); \}/);
  assert.match(between(app, "function refreshChessOverlay(", "// \"Play Chess\" opens"), /bankChessClock\(\);\s*chessState\.summary = summary;/, "a stretch is banked against its own turn before the summary moves on");
  assert.doesNotMatch(app, /\blastTick\b|CHESS_CLOCK_TICK_MS/);
});

// --- one foreground beat ------------------------------------------------------------------------

await test("beat: every poll wakes on the same wall-clock beat, never twice in one", () => {
  assert.equal(delayToNextBeat(30_000, 0, 60_000), 30_000);
  assert.equal(delayToNextBeat(30_000, 0, 61_000), 29_000);
  assert.equal(delayToNextBeat(30_000, 1_500, 61_000), 30_500);
  assert.equal(delayToNextBeat(30_000, 0, 89_500), 30_500, "under a second to go: the next beat");
  // two loops started at different moments land on the same beat
  const a = 1_000 + delayToNextBeat(30_000, 0, 1_000);
  const b = 17_345 + delayToNextBeat(30_000, 0, 17_345);
  assert.equal(a, b);
  assert.equal(beatIntervalMs({}), BEAT_MS);
  assert.equal(beatIntervalMs({ connection: { type: "cellular" } }), BEAT_EXPENSIVE_MS);
  assert.equal(beatIntervalMs({ connection: { saveData: true } }), BEAT_EXPENSIVE_MS);
});

await test("beat: runs while the page shows, skips while hidden, stops for good", async () => {
  let now = 0;
  const timers = [];
  let visible = true;
  let runs = 0;
  const stop = onForegroundBeat(() => { runs += 1; }, {
    offsetMs: 0, isVisible: () => visible, intervalMs: () => 30_000, now: () => now,
    setTimer: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length; },
    clearTimer: () => { timers.length = 0; },
  });
  const fire = async () => { const t = timers.shift(); now = t.at; await t.fn(); };
  assert.equal(timers[0].at, 30_000);
  await fire();
  assert.equal(runs, 1);
  visible = false;
  await fire();
  assert.equal(runs, 1, "hidden: skipped");
  visible = true;
  await fire();
  assert.equal(runs, 2);
  assert.equal(timers[0].at % 30_000, 0, "still on the beat");
  stop();
  assert.equal(timers.length, 0);
});

await test("beat: the room sweep and the kUSDT poll are on it, not their own timers", () => {
  const sweep = between(broadcasts, "const SWEEP_MS", "async function sweepClosedRooms(");
  assert.match(sweep, /sweepTimer = onForegroundBeat\(\(\) => sweepClosedRooms\(\), \{ offsetMs: 0 \}\)/);
  assert.doesNotMatch(sweep, /setInterval/);
  const poll = between(kusdtWallet, "function startPolling()", "function forgetAccount(");
  assert.match(poll, /pollTimer = onForegroundBeat\(/);
  assert.match(poll, /offsetMs: 1_500/);
  assert.doesNotMatch(poll, /setInterval/);
  assert.equal(KUSDT_POLL_MS, BEAT_MS);
});

// --- the kUSDT builder lives only while it's used -----------------------------------------------

function fakeWorkerFactory(made) {
  return () => {
    const w = {
      terminated: false, onmessage: null, onerror: null, onmessageerror: null,
      postMessage(m) {
        if (m.type === "init") setTimeout(() => w.onmessage?.({ data: { type: "ready", version: "t" } }), 0);
        if (m.type === "run") setTimeout(() => w.onmessage?.({ data: { type: "answer", id: m.id, answer: '{"ok":1}' } }), 0);
      },
      terminate() { w.terminated = true; },
    };
    made.push(w);
    return w;
  };
}

await test("kUSDT builder: stopped two minutes after its last call, started again by the next", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const made = [];
  const timers = [];
  const core = createKusdtCore({
    fetchWasm: async () => bytes,
    expectedSha256: await sha256Hex(bytes),
    workerFactory: fakeWorkerFactory(made),
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.live = false; },
  });
  assert.deepEqual(await core.runCore("template", {}), { ok: 1 });
  assert.equal(core.mode, "worker");
  const idle = timers.filter((t) => t.live);
  assert.equal(idle.length, 1);
  assert.equal(idle[0].ms, IDLE_TEARDOWN_MS);
  assert.equal(IDLE_TEARDOWN_MS, 120_000);

  // a call in flight when the timer fires keeps the worker
  const busy = core.runCore("template", {});
  assert.equal(idle[0].live, false, "a new call cancels the pending teardown");
  idle[0].fn();
  await busy;
  assert.equal(made[0].terminated, false);

  const again = timers.filter((t) => t.live);
  assert.equal(again.length, 1, "rescheduled after the last call");
  again[0].fn();
  assert.equal(made[0].terminated, true, "idle: the worker (and its WebAssembly) is gone");
  assert.equal(core.mode, null);

  assert.deepEqual(await core.runCore("template", {}), { ok: 1 });
  assert.equal(made.length, 2, "the next call starts a fresh one");
});

// --- profile pictures --------------------------------------------------------------------------

await test("hourly profile rescan revalidates pictures instead of downloading them again", () => {
  const rescan = between(namesLive, "export async function kachatRescanProfile(", "// People shown as an address");
  assert.match(rescan, /cache: "no-cache"/);
  assert.doesNotMatch(rescan, /cache: "reload"/);
});

console.log(`test-k-961-chat: ${passed} passed`);
