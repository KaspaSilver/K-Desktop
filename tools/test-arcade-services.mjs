// KaPlay's arcade services (K 518fdc8c ArcadeServices.swift, ARCADE.md, AUDIT_2026-11-24.md): the
// stamp's bytes; challenge links parsed, rebuilt from checked fields and found in posts; who a
// challenge names (#21); the stamp job (stamped when the node takes it) and its share states (#8);
// the record keep/remove rules on the REST API's answers (#9); the boards' 404 handling per game
// (#19), the size cap and de-duplication (#22); challenges held while a game is on (#11). Test keys
// only; nothing leaves the machine. Run from the repo root:
//
//   node tools/test-arcade-services.mjs

import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js";
import { addressOf } from "../engine/kachat-names/registry-state.js";
import {
  ARCADE_CHANNEL, arcadeStampContent, arcadeCheckFromRest, ArcadeStampJob, ArcadeProgress, applyArcadeRecheck,
  addArcadeRecord, bestArcadeRecord, arcadeBoardRows, arcadeBoardAnswer, mergeOwnArcadeBest, readCappedText,
  ArcadeBoards, ARCADE_BOARD_MAX_BYTES, ARCADE_NOT_ACCEPTED_AFTER_MS, arcadeChallengeUrl, parseArcadeChallengeLink,
  arcadeChallengeTitle, arcadeChallengeIn, arcadeConfirmedBy, arcadeChallengeBannerText, arcadeSharePostText,
  arcadeChallengeFromLaunchSearch, arcadeChallengeMayOpen, newArcadeGameId, sampleArcadeStampContent, formatArcadeScore,
  ARCADE_NOT_CONFIRMED_NOTE,
} from "../engine/arcade-services.js";
import { isServiceBroadcastChannel, isValidBroadcastChannel } from "../engine/broadcasts.js";
import { periodSinceMs } from "../engine/chess-tournament.js";

const fromHex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const keyAddress = (n) => addressOf(schnorr.getPublicKey(fromHex(n.toString(16).padStart(64, "0"))), "kaspa");
const ME = keyAddress(3);
const OTHER = keyAddress(5);
const THIRD = keyAddress(7);
const GAME_ID = "9d2c7a54-1f0e-4b8a-a3c1-6e5f4d3b2a10";
const TX = "a".repeat(64);

// --- The stamp (§1) ------------------------------------------------------------------------------
assert.equal(ARCADE_CHANNEL, "kplay-arcade");
assert.ok(isValidBroadcastChannel(ARCADE_CHANNEL) && isServiceBroadcastChannel(ARCADE_CHANNEL), "#kplay-arcade is a hidden service room");
assert.equal(
  arcadeStampContent({ game: "snake", gameId: "g1", seed: 0x9f2c41d07a3b55e1n, score: 7, moves: "12R 30U 41L" }),
  '{"g":"g1","game":"snake","m":"12R 30U 41L","score":7,"seed":"9f2c41d07a3b55e1","type":"arcade","v":1}',
  "ARCADE.md §1's example, keys sorted, no whitespace",
);
assert.ok(JSON.parse(sampleArcadeStampContent()).m.split(" ").length === 60);
assert.match(newArcadeGameId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
assert.equal(formatArcadeScore(1240), "1,240");

// --- The REST API's answer (#9) ------------------------------------------------------------------
assert.equal(arcadeCheckFromRest(404, null), "notAccepted", "404 is a definite not found");
assert.equal(arcadeCheckFromRest(200, { is_accepted: true }), "accepted");
assert.equal(arcadeCheckFromRest(200, { is_accepted: false }), "unanswered", "in a block, not accepted yet: no answer either way");
assert.equal(arcadeCheckFromRest(0, null), "unanswered", "no answer");
assert.equal(arcadeCheckFromRest(503, null), "unanswered");

// --- Records -------------------------------------------------------------------------------------
{
  let list = [];
  for (let i = 0; i < 60; i += 1) list = addArcadeRecord(list, { game: "snake", score: i, at: i, gameId: `s${i}`, txId: null });
  list = addArcadeRecord(list, { game: "2048", score: 5, at: 1, gameId: "t1", txId: null });
  assert.equal(list.filter((r) => r.game === "snake").length, 50, "the best 50 per game");
  assert.equal(Math.min(...list.filter((r) => r.game === "snake").map((r) => r.score)), 10);
  assert.equal(bestArcadeRecord(list, "snake").score, 59);
  assert.equal(bestArcadeRecord(list, "snake", 1000), null, "since");
  const tie = [{ game: "snake", score: 4, at: 20, gameId: "a" }, { game: "snake", score: 4, at: 10, gameId: "b" }];
  assert.equal(bestArcadeRecord(tie, "snake").gameId, "b", "the earlier on a tie");
}

// --- Keep / remove (#9) --------------------------------------------------------------------------
{
  const sentAt = 1_000_000;
  const record = { game: "snake", score: 9, at: sentAt, gameId: "x", txId: TX };
  const base = { records: [record], unconfirmed: [record], record };
  let r = applyArcadeRecheck({ ...base, answer: "unanswered", nowMs: sentAt + 60 * 60_000 });
  assert.equal(r.verdict, "keep", "no answer keeps it, however long");
  assert.equal(r.records.length, 1);
  r = applyArcadeRecheck({ ...base, answer: "notAccepted", nowMs: sentAt + ARCADE_NOT_ACCEPTED_AFTER_MS });
  assert.equal(r.verdict, "keep", "not found within ten minutes: kept, a slow REST API");
  r = applyArcadeRecheck({ ...base, answer: "notAccepted", nowMs: sentAt + ARCADE_NOT_ACCEPTED_AFTER_MS + 1 });
  assert.equal(r.verdict, "remove", "a definite not found past ten minutes removes it");
  assert.equal(r.records.length, 0);
  assert.equal(r.unconfirmed.length, 0);
  r = applyArcadeRecheck({ records: [], unconfirmed: [record], record, answer: "accepted", nowMs: sentAt + 5 });
  assert.equal(r.verdict, "confirm");
  assert.equal(r.records.length, 1, "taken back on an earlier 404, it comes back once accepted");
  assert.equal(r.unconfirmed.length, 0, "and is no longer checked");
}

// A storage stand-in.
function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map };
}

// --- The stamp job: stamped when the node takes it; the check after (#9) ---------------------------
async function runJob({ answers, sendImpl, score = 7 }) {
  const storage = memoryStorage();
  let clock = 5_000;
  const progress = new ArcadeProgress({ storage, currentAddress: () => ME, now: () => clock });
  let asked = 0;
  const states = [];
  const job = new ArcadeStampJob({
    game: "snake", score, seed: 1n, moves: "1D 3L", playerAddress: ME, currentAddress: () => ME,
    send: sendImpl || (async () => TX),
    lookUp: async () => { const a = answers[Math.min(asked, answers.length - 1)]; asked += 1; return a; },
    progress, sleep: async () => { clock += 2_000; }, now: () => clock,
    onChange: (j) => states.push(j.state),
  });
  await job.done;
  return { job, progress, states, asked, storage };
}
{
  const { job, progress, states } = await runJob({ answers: ["unanswered", "accepted"] });
  assert.deepEqual(states.slice(0, 2), ["sending", "stamped"], "stamped once the node takes it");
  assert.equal(job.state, "stamped");
  assert.equal(progress.records(ME).length, 1);
  assert.equal(progress.unconfirmed(ME).length, 0, "accepted: no more checks");
  assert.equal(JSON.parse(job.content).g, job.id);
}
{
  const { job, progress } = await runJob({ answers: ["unanswered"] });
  assert.equal(job.state, "unconfirmed");
  assert.equal(job.note, ARCADE_NOT_CONFIRMED_NOTE);
  assert.equal(progress.records(ME).length, 1, "no answer from the REST API: the record stays (#9)");
  assert.equal(progress.unconfirmed(ME).length, 1, "and is checked again later");
}
{
  const { job, progress } = await runJob({ answers: ["notAccepted"] });
  assert.equal(job.state, "unconfirmed");
  assert.equal(progress.records(ME).length, 0, "a 404 after the window takes it off the board");
  assert.equal(progress.unconfirmed(ME).length, 1, "but it is still checked");
}
{
  const unknown = Object.assign(new Error("may have gone"), { code: "SEND_OUTCOME_UNKNOWN" });
  const { job, progress } = await runJob({ answers: ["accepted"], sendImpl: async () => { throw unknown; } });
  assert.equal(job.state, "unconfirmed", "an unknown outcome is no failure: no Retry");
  assert.equal(job.shareEnabled, false);
  assert.equal(progress.records(ME).length, 0);
}
{
  const { job } = await runJob({ answers: ["accepted"], sendImpl: async () => { throw new Error("Insufficient funds"); } });
  assert.equal(job.state, "failed");
  assert.equal(job.shareTitle, "Retry the Stamp");
}
{
  const { job } = await runJob({ answers: ["accepted"], score: 0 });
  assert.equal(job.state, "notSent", "a score of 0 is never sent");
}
{
  const job = new ArcadeStampJob({ game: "2048", score: 4, seed: 1n, moves: "L", playerAddress: ME, currentAddress: () => OTHER, send: async () => TX });
  await job.done;
  assert.equal(job.state, "failed", "another account never signs it");
}

// --- Share states (#8) ---------------------------------------------------------------------------
{
  const { job } = await runJob({ answers: ["accepted"] });
  assert.equal(job.shareEnabled, true);
  assert.equal(job.shareTitle, "Share to KaPost");
  job.sharePosting();
  assert.equal(job.shareEnabled, false, "Posting... disables Share");
  assert.equal(job.shareTitle, "Posting to KaPost…");
  job.shareResult({ ok: true });
  assert.equal(job.shareEnabled, false, "Shared stays off");
  assert.equal(job.shareTitle, "Shared to KaPost");
  job.share = "none";
  job.sharePosting();
  job.shareResult({ unknown: true });
  assert.equal(job.share, "unconfirmed", "an unknown outcome counts as shared, unconfirmed");
  assert.equal(job.shareEnabled, false, "so it can't post twice");
  job.share = "none";
  job.sharePosting();
  job.shareResult({ error: new Error("Insufficient funds") });
  assert.equal(job.share, "failed");
  assert.equal(job.shareEnabled, true, "a definite failure turns Share back on");
}

// --- ArcadeProgress.recheck: once a minute, no answer keeps ---------------------------------------
{
  const storage = memoryStorage();
  let clock = 1_000_000;
  const answers = { [TX]: "unanswered" };
  let lookUps = 0;
  const progress = new ArcadeProgress({ storage, currentAddress: () => ME, now: () => clock, lookUp: async (tx) => { lookUps += 1; return answers[tx]; } });
  const record = { game: "snake", score: 9, at: clock, gameId: "x", txId: TX };
  progress.add(record, ME);
  progress.markUnconfirmed(record, ME);
  await progress.recheck();
  assert.equal(lookUps, 1);
  await progress.recheck();
  assert.equal(lookUps, 1, "at most once a minute");
  clock += 60_000;
  await progress.recheck();
  assert.equal(lookUps, 2);
  assert.equal(progress.best("snake").score, 9, "kept while unanswered");
  answers[TX] = "notAccepted";
  clock += 60_000;
  await progress.recheck();
  assert.equal(progress.best("snake").score, 9, "not found within ten minutes: kept");
  clock += ARCADE_NOT_ACCEPTED_AFTER_MS;
  await progress.recheck();
  assert.equal(progress.best("snake"), null, "not found past ten minutes: removed");
  assert.equal(progress.unconfirmed(ME).length, 0);
}

// --- Boards: de-duplication and the cap (#22) ----------------------------------------------------
{
  const rows = arcadeBoardRows([
    { address: ME, score: 5, at: 10 },
    { address: ME, score: 9, at: 20 },
    { address: OTHER, score: 9, at: 5 },
    { address: "kaspa:nope", score: 100, at: 1 },
    { address: THIRD, score: -1, at: 1 },
    { address: THIRD, score: 2.5, at: 1 },
  ]);
  assert.deepEqual(rows.map((r) => [r.address.toLowerCase(), r.score]), [[OTHER, 9], [ME, 9]], "one row per address, the best, the earlier on a tie, invalid ones out");
  const many = Array.from({ length: 150 }, (_, i) => ({ address: i % 2 ? ME : OTHER, score: i, at: i }));
  assert.equal(arcadeBoardRows(many).length, 2, "duplicates never make two rows");
}
{
  const merged = mergeOwnArcadeBest([{ address: OTHER, score: 9, at: 5 }, { address: ME, score: 3, at: 5 }], { address: ME, best: { score: 12, at: 9 } });
  assert.deepEqual(merged.map((r) => [r.address, r.score]), [[ME, 12], [OTHER, 9]], "your own stamped best beats the server's older row");
  const kept = mergeOwnArcadeBest([{ address: ME, score: 30, at: 5 }], { address: ME, best: { score: 12, at: 9 } });
  assert.deepEqual(kept.map((r) => r.score), [30], "the server's higher row stays");
  assert.deepEqual(mergeOwnArcadeBest([], { address: ME, best: { score: 1, at: 1 } }).map((r) => r.address), [ME], "your own row alone while the board isn't served");
}
{
  const answer = arcadeBoardAnswer({ status: 404, json: null, game: "snake", period: "month" });
  assert.deepEqual(answer, { answered: true, notServed: true, rows: null }, "404: not served yet, an answer of no scores (#19)");
  assert.equal(arcadeBoardAnswer({ status: 500, json: null, game: "snake", period: "month" }).answered, false);
  assert.equal(arcadeBoardAnswer({ status: 200, json: { game: "2048", period: "month", players: [] }, game: "snake", period: "month" }).answered, false, "another game's board is no answer");
  assert.deepEqual(arcadeBoardAnswer({ status: 200, json: { game: "snake", period: "all", players: [{ address: ME, score: 1, at: 1 }] }, game: "snake", period: "all" }).rows.length, 1);
}
{
  // The response cap: a declared length past it, and a body that runs past it.
  const big = { status: 200, headers: { get: (k) => (k === "content-length" ? String(ARCADE_BOARD_MAX_BYTES + 1) : null) }, body: null, text: async () => "{}" };
  await assert.rejects(readCappedText(big), /too large/);
  const stream = new Response(new ReadableStream({
    start(controller) { for (let i = 0; i < 9; i += 1) controller.enqueue(new Uint8Array(64 * 1024)); controller.close(); },
  }));
  await assert.rejects(readCappedText(stream), /too large/, "an undeclared body is cut off past 512 KB");
  assert.equal(await readCappedText(new Response('{"a":1}')), '{"a":1}');
}

// --- ArcadeBoards: 404 per game, unreachable per game (#19) ----------------------------------------
{
  const served = { snake: 404, 2048: "down" };
  const fetchImpl = async (url) => {
    const game = new URL(url).searchParams.get("game");
    const period = new URL(url).searchParams.get("period");
    if (served[game] === "down") throw new Error("offline");
    if (served[game] === 404) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ game, period, games: 3, players: [{ address: OTHER, score: 40, at: 1 }, { address: OTHER, score: 30, at: 2 }] }), { status: 200 });
  };
  let clock = periodSinceMs("month", Date.UTC(2026, 10, 24)) + 1000;
  const storage = memoryStorage();
  const progress = new ArcadeProgress({ storage, currentAddress: () => ME, now: () => clock });
  progress.add({ game: "snake", score: 7, at: clock, gameId: "own", txId: TX }, ME);
  const boards = new ArcadeBoards({ fetch: fetchImpl, base: () => "https://indexer.example/", progress, currentAddress: () => ME, now: () => clock });
  await boards.refresh("snake");
  await boards.refresh("2048");
  assert.equal(boards.unreachable("snake"), false, "a 404 is an answer: not 'couldn't be loaded'");
  assert.equal(boards.notServed("snake"), true);
  assert.equal(boards.unreachable("2048"), true, "2048's own failure");
  assert.deepEqual(boards.rows("snake", "month").map((r) => [r.address, r.score]), [[ME, 7]], "your own stamped best while not served");
  served[2048] = 200;
  await boards.refresh("2048");
  assert.equal(boards.unreachable("2048"), true, "within 20 s: not fetched again");
  clock += 21_000;
  await boards.refresh("2048");
  assert.equal(boards.unreachable("2048"), false);
  assert.deepEqual(boards.rows("2048", "all").map((r) => r.score), [40], "de-duplicated");
  assert.equal(boards.unreachable("snake"), false, "Snake's state is its own");
  served.snake = 200;
  await boards.refresh("snake", { force: true });
  assert.equal(boards.notServed("snake"), false);
  assert.deepEqual(boards.rows("snake", "month").map((r) => [r.address, r.score]), [[OTHER, 40], [ME, 7]]);
}

// --- Challenge links (§6) ------------------------------------------------------------------------
{
  const url = arcadeChallengeUrl({ game: "snake", score: 1240, by: ME, gameId: GAME_ID });
  assert.equal(url, `kachatarcade://snake?score=1240&by=${ME}&game=${GAME_ID}`, "URLComponents' bytes (the colon stays)");
  const parsed = parseArcadeChallengeLink(url);
  assert.deepEqual(parsed, { game: "snake", score: 1240, by: ME, gameId: GAME_ID, url }, "round trip");
  assert.equal(parseArcadeChallengeLink("kachatarcade://2048?score=48").url, "kachatarcade://2048?score=48");
  assert.equal(parseArcadeChallengeLink("KACHATARCADE://Snake").url, "kachatarcade://snake", "scheme and game in any case");
  assert.equal(parseArcadeChallengeLink("kachatarcade://tetris?score=1"), null, "only the game has to be valid, and it must be");
  assert.equal(parseArcadeChallengeLink("kachatchess://bot/1"), null);
  assert.equal(parseArcadeChallengeLink("https://kachat.app/post/x"), null);
  const bad = parseArcadeChallengeLink(`kachatarcade://snake?score=-4&by=kaspa:nope&game=${"x".repeat(65)}`);
  assert.deepEqual([bad.score, bad.by, bad.gameId, bad.url], [null, null, null, "kachatarcade://snake"], "bad values dropped, url rebuilt from what passed");
  assert.equal(parseArcadeChallengeLink("kachatarcade://snake?score=+3").score, null, "digits only");
  assert.equal(parseArcadeChallengeLink("kachatarcade://snake?score=10000001").score, null, "at most 10,000,000");
  assert.equal(parseArcadeChallengeLink("kachatarcade://snake?score=10000000").score, 10_000_000);
  assert.equal(parseArcadeChallengeLink(`kachatarcade://snake?game=<script>&score=5`).url, "kachatarcade://snake?score=5", "a hostile game id never reaches the url");
  assert.equal(parseArcadeChallengeLink("kachatarcade://snake?score=5#frag").url, "kachatarcade://snake?score=5");
}
assert.equal(arcadeChallengeTitle({ game: "snake", score: 1240 }), "Beat 1,240 in Snake");
assert.equal(arcadeChallengeTitle({ game: "2048", score: null }), "Challenge: play 2048");
{
  const text = arcadeSharePostText({ game: "snake", score: 1240, by: ME, gameId: GAME_ID });
  assert.equal(text, `I scored 1,240 in Snake on K. Think you can beat it?\n\nkachatarcade://snake?score=1240&by=${ME}&game=${GAME_ID}`, "K's post");
  const found = arcadeChallengeIn(`${text}.`);
  assert.equal(found.challenge.score, 1240, "found in a post, trailing punctuation left out");
  assert.equal(found.bodyText, "I scored 1,240 in Snake on K. Think you can beat it?\n\n.");
  assert.equal(arcadeChallengeIn("no link here"), null);
  assert.equal(arcadeChallengeIn("kachatarcade://tetris kachatarcade://2048?score=4").challenge.game, "2048", "the first valid one");
}
assert.equal(arcadeChallengeFromLaunchSearch(`?challenge=${encodeURIComponent("kachatarcade://2048?score=4")}`).score, 4);
assert.equal(arcadeChallengeFromLaunchSearch("?challenge=kachatchess://bot/1"), null);
assert.equal(arcadeChallengeFromLaunchSearch(""), null);

// --- Who a challenge names (#21) -----------------------------------------------------------------
{
  const challenge = parseArcadeChallengeLink(arcadeChallengeUrl({ game: "snake", score: 1240, by: ME, gameId: GAME_ID }));
  assert.equal(arcadeConfirmedBy(challenge, ME), ME, "by is the post's signer: named");
  assert.equal(arcadeConfirmedBy(challenge, ME.toUpperCase()), ME, "case-insensitive");
  assert.equal(arcadeConfirmedBy(challenge, OTHER), null, "someone else's post: not named");
  assert.equal(arcadeConfirmedBy(challenge, null), null, "a tapped link with no post: not named");
  assert.equal(arcadeChallengeBannerText({ challenge, who: "Alice" }), "Alice scored 1,240 in Snake. Can you beat it?");
  assert.equal(arcadeChallengeBannerText({ challenge, who: null }), "Someone scored 1,240 in Snake. Can you beat it?");
  assert.equal(arcadeChallengeBannerText({ challenge: { game: "snake", score: null } }), null, "no score, no banner");
}

// --- Holding a challenge while a game is on (#11) ------------------------------------------------
assert.equal(arcadeChallengeMayOpen({}), true);
assert.equal(arcadeChallengeMayOpen({ arcadeRoundOpen: true }), false, "an arcade round holds it");
assert.equal(arcadeChallengeMayOpen({ botGameOn: true }), false, "a bot game holds it");
assert.equal(arcadeChallengeMayOpen({ chessOpen: true, busyOnline: true }), false, "an online game in open Chess holds it");
assert.equal(arcadeChallengeMayOpen({ chessOpen: false, busyOnline: true }), true, "Chess closed: no board to pop");

console.log("ok arcade services");
