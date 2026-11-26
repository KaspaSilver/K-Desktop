// Audit 2026-11-25, chess and the arena: #8 (an open board sends only to its own chat), #10 (the
// arena cache is capped by size and keeps this device's unconfirmed rows), #16 (the arena is
// reduced room by room, only the rooms that changed - same result as replaying every row), #27
// (the first resignation ends a 1:1 game; a late timeout-resign can't flip it), #28 (a tapped
// notification leaves Chess Online only through the dock's may-leave check), and the minor one: a
// pending invite withdrawn by its inviter is "Game cancelled", not a loss. Run from the repo root:
//
//   node tools/test-chess-audit-2026-11-25.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as C from "../engine/chess.js";
import * as T from "../engine/chess-tournament.js";

const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
const arenaUi = readFileSync(new URL("../ui/chess-tournaments.js", import.meta.url), "utf8");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}
const fnBody = (source, name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const next = source.indexOf("\nfunction ", start + 10);
  const nextAsync = source.indexOf("\nasync function ", start + 10);
  const ends = [next, nextAsync].filter((i) => i > 0);
  return source.slice(start, ends.length ? Math.min(...ends) : undefined);
};

// --- #27 and the cancelled invite (engine/chess.js) -------------------------------------------
const ME = "kaspa:me", THEM = "kaspa:them", G = "g1";
const msg = (text, outgoing, txid, at, extra = {}) => ({ text, outgoing, txid, at, ...extra });

test("#27 a late timeout-resign after the opponent resigned doesn't flip the result", () => {
  const base = [
    msg(C.chessInvite(G, "white", 3, 0), true, "a", 1),
    msg(C.chessResponse(G, true), false, "b", 2),
    msg(C.chessMove(G, "e2", "e4", null, 170000), true, "c", 3),
    msg(C.chessResign(G), false, "d", 4),
  ];
  const before = C.summarizeChessGame(G, base, ME, THEM).status;
  assert.equal(before.kind, "resigned");
  assert.equal(before.loser, "black");
  const after = C.summarizeChessGame(G, [...base, msg(C.chessResign(G, "timeout"), true, "e", 5)], ME, THEM).status;
  assert.equal(after.loser, "black", "the first resignation stands");
  assert.equal(after.timeout, false);
  assert.equal(C.chessSummaryStatusText(C.summarizeChessGame(G, [...base, msg(C.chessResign(G, "timeout"), true, "e", 5)], ME, THEM)), "They resigned");
  assert.deepEqual(C.chessRecord([...base, msg(C.chessResign(G, "timeout"), true, "e", 5)], ME, THEM), { wins: 1, losses: 0 });
});

test("#27 a failed (unsent) resign still doesn't count, and the next real one does", () => {
  const list = [
    msg(C.chessInvite(G, "white"), true, "a", 1),
    msg(C.chessResponse(G, true), false, "b", 2),
    msg(C.chessMove(G, "e2", "e4"), true, "c", 3),
    msg(C.chessResign(G, "timeout"), true, "d", 4, { failed: true }),
    msg(C.chessResign(G), false, "e", 5),
  ];
  assert.equal(C.summarizeChessGame(G, list, ME, THEM).status.loser, "black");
});

test("#27 the timeout-resign retries stop once the game is no longer in progress", () => {
  const retry = fnBody(app, "retryChessTimeoutResign");
  assert.match(retry, /if \(!chessGameStillInProgress\(conversationId, gameId\)\) return;\s*if \(attempt >= CHESS_TIMEOUT_RESIGN_RETRY_MS\.length\)/);
  assert.match(retry, /setTimeout\(\(\) => \{\s*if \(!chessGameStillInProgress\(conversationId, gameId\)\) return;\s*runEngineSendPipeline/);
  assert.match(fnBody(app, "chessGameStillInProgress"), /!Chess\.isChessGameOver\(summary\.status\)/);
});

test("minor: the inviter withdrawing an unanswered invite is cancelled, not a loss", () => {
  const list = [msg(C.chessInvite(G, "white"), true, "a", 1), msg(C.chessResign(G), true, "b", 2)];
  const s = C.summarizeChessGame(G, list, ME, THEM);
  assert.equal(s.status.kind, "resigned", "still over, as before");
  assert.equal(C.isChessGameOver(s.status), true);
  assert.equal(s.status.cancelled, true);
  assert.equal(C.chessSummaryStatusText(s), "Game cancelled");
  assert.deepEqual(C.chessRecord(list, ME, THEM), { wins: 0, losses: 0 });
  // the other side sees the same
  const theirs = [msg(C.chessInvite(G, "white"), false, "a", 1), msg(C.chessResign(G), false, "b", 2)];
  assert.equal(C.chessSummaryStatusText(C.summarizeChessGame(G, theirs, ME, THEM)), "Game cancelled");
  assert.deepEqual(C.chessRecord(theirs, ME, THEM), { wins: 0, losses: 0 });
  // the wire format is unchanged
  assert.equal(C.chessResign(G), JSON.stringify(JSON.parse(C.chessResign(G))));
  assert.equal(JSON.parse(C.chessResign(G)).type, "chess_resign");
});

test("minor: a resign after the invite was accepted, or after a move, still counts", () => {
  const accepted = [msg(C.chessInvite(G, "white"), true, "a", 1), msg(C.chessResponse(G, true), false, "b", 2), msg(C.chessResign(G), true, "c", 3)];
  const s = C.summarizeChessGame(G, accepted, ME, THEM);
  assert.equal(s.status.cancelled, false);
  assert.equal(C.chessSummaryStatusText(s), "You resigned");
  assert.deepEqual(C.chessRecord(accepted, ME, THEM), { wins: 0, losses: 1 });
  const moved = [msg(C.chessInvite(G, "white"), true, "a", 1), msg(C.chessMove(G, "e2", "e4"), true, "b", 2), msg(C.chessResign(G), true, "c", 3)];
  assert.equal(C.summarizeChessGame(G, moved, ME, THEM).status.cancelled, false);
  // the invited side resigning a pending invite is not the inviter cancelling
  const invitee = [msg(C.chessInvite(G, "white"), false, "a", 1), msg(C.chessResign(G), true, "b", 2)];
  assert.equal(C.summarizeChessGame(G, invitee, ME, THEM).status.cancelled, false);
});

// --- #8 (ui/app.js) ----------------------------------------------------------------------------
test("#8 the board remembers its chat and sends only there", () => {
  const send = fnBody(app, "chessSendEnvelope");
  assert.match(send, /function chessSendEnvelope\(content, conversationId = activeConversationId\)/);
  assert.match(send, /if \(!state\.conversations\.some\(\(entry\) => entry\.id === conversationId\)\)/, "refuses a chat that is gone");
  assert.match(send, /return queueConversationMessage\(conversationId, content\)/);
  const open = fnBody(app, "openChessGame");
  assert.match(open, /const conversationId = activeConversationId;/);
  assert.match(open, /gameId: summary\.gameId, conversationId, summary/);
  assert.match(fnBody(app, "doChessMove"), /chessSendEnvelope\(Chess\.chessMove\([^;]*\), chessState\.conversationId\)/);
  assert.match(fnBody(app, "resignChess"), /chessSendEnvelope\(Chess\.chessResign\(chessState\.gameId\), chessState\.conversationId\)/);
  const timeout = fnBody(app, "sendChessTimeoutResign");
  assert.match(timeout, /const conversationId = chessState\.conversationId;/);
  assert.doesNotMatch(timeout, /activeConversationId/);
  assert.match(fnBody(app, "refreshChessOverlay"), /chessConversationContext\(chessState\.conversationId\)/);
  assert.match(fnBody(app, "renderChessRecord"), /chessConversationContext\(chessBoardConversationId\(\)\)/);
  assert.match(fnBody(app, "renderChessChat"), /entry\.id === chessBoardConversationId\(\)/);
  assert.match(fnBody(app, "unconfirmedChessMove"), /entry\.id === chessBoardConversationId\(\)/);
  assert.match(app, /chessSendEnvelope\(Chess\.chessResponse\(chessState\.gameId, true\), chessState\.conversationId\)/);
  assert.match(app, /chessSendEnvelope\(Chess\.chessResponse\(chessState\.gameId, false\), chessState\.conversationId\)/);
});

test("#8 opening a different chat closes the board", () => {
  const set = fnBody(app, "setActiveConversationId");
  assert.match(set, /if \(id\) \{ try \{ if \(chessState && chessState\.conversationId !== id\) closeChess\(\); \} catch/);
});

// --- #28 (ui/app.js) ---------------------------------------------------------------------------
test("#28 notification clicks leave Chess only through the may-leave check", () => {
  const route = fnBody(app, "routeNotificationClick");
  assert.match(route, /leaveChessForNotificationThen\(\(\) => routeNotificationClickNow\(data\)\)/);
  assert.match(fnBody(app, "leaveChessForNotificationThen"), /chessTournamentsMayLeave\(\)\.catch\(\(\) => true\)\.then\(\(ok\) => \{\s*if \(!ok\) return;/);
  assert.match(fnBody(app, "showAppNotification"), /note\.onclick = \(\) => \{\s*try \{ window\.focus\(\); \} catch \{\}\s*leaveChessForNotificationThen\(\(\) => onClick\?\.\(\)\)/);
  assert.match(fnBody(app, "routeNotificationClickNow"), /ownNotificationClickHandler\(data\.clickId\)/);
});

// --- #16 incremental reduce (engine/chess-tournament.js) ---------------------------------------
let txn = 0;
const id = () => String(++txn).padStart(64, "0");
const ev = (sender, blockTime, message) => ({ txId: id(), sender, blockTime, message: T.decodeMessage(T.encodeMessage(message)) });

/** A random arena: duels and 8-player rooms with joins, legal and illegal moves, resigns, claims,
 *  leaves and a private room. */
function randomArena(seed, games) {
  let x = seed;
  const rnd = (n) => { x = (x * 1103515245 + 12345) % 2147483648; return x % n; };
  const events = [];
  let t = 1_795_000_000_000;
  for (let g = 1; g <= games; g += 1) {
    const eight = rnd(5) === 0;
    const room = eight ? T.publicId(g) : T.duelId(g);
    const players = Array.from({ length: eight ? 8 : 2 }, (_, i) => `kaspa:p${g}-${i}`);
    for (const p of players) events.push(ev(p, (t += 500), T.messages.join(room)));
    if (rnd(7) === 0) events.push(ev(players[0], (t += 100), T.messages.leave(room)));
    let board = C.initialBoard();
    const plies = rnd(30);
    for (let ply = 1; ply <= plies; ply += 1) {
      const ms = C.legalMoves(board);
      if (!ms.length) break;
      const m = ms[rnd(ms.length)];
      t += 1000 + rnd(9000);
      const mover = board.sideToMove === "white" ? players[0] : players[eight ? 7 : 1];
      events.push(ev(mover, t, T.messages.move(room, "1-0", ply, C.algebraic(m.from), C.algebraic(m.to), m.promotion ? C.promotionLetter(m.promotion) : null)));
      board = C.applyMove(board, m);
    }
    const end = rnd(4);
    if (end === 0) events.push(ev(players[0], (t += 2000), T.messages.resign(room, "1-0")));
    // the side NOT to move claims, long after the mover's clock ran out
    if (end === 1) events.push(ev(board.sideToMove === "white" ? players[eight ? 7 : 1] : players[0], (t += 400_000), T.messages.claim(room, "1-0")));
  }
  const pid = "priv-abc";
  events.push(ev("kaspa:c", (t += 10), T.messages.createDuel(pid, "x")));
  events.push(ev("kaspa:d", (t += 10), T.messages.join(pid)));
  events.push(ev("kaspa:e", (t += 10), T.messages.create("priv-eight", "y", T.PRIVATE_CREATE_CODE)));
  events.push(ev("kaspa:f", (t += 10), T.messages.join("priv-eight")));
  events.push(ev("kaspa:e", (t += 10), T.messages.cancel("priv-eight")));
  return events;
}
const full = (events, local) => T.reduce(T.orderingLocalStamps(events, local));
const same = (a, b, label) => {
  assert.equal(JSON.stringify(a), JSON.stringify(b), `${label}: same rooms, same key order`);
  assert.deepEqual(a, b, label);
};

test("#16 the random arena really plays: games with moves, finished games, a cancelled room", () => {
  const rooms = Object.values(full(randomArena(7, 120), new Set()));
  const games = rooms.flatMap((t) => Object.values(t.games));
  assert.ok(games.length > 50, "games started");
  assert.ok(games.reduce((n, g) => n + g.moves.length, 0) > 500, "moves applied");
  assert.ok(games.some((g) => g.outcome?.kind === "resignation"), "a resignation");
  assert.ok(games.some((g) => g.outcome?.kind === "timeout"), "a claim on time");
  assert.ok(rooms.some((t) => t.cancelled), "a cancelled private room");
});

test("#16 incremental reduce equals the full replay through adds, re-times, drops and shuffles", () => {
  const all = randomArena(7, 120);
  const reduceInc = T.createIncrementalReducer();
  let shown = [];
  const local = new Set();
  // rows arrive in batches, out of order within each batch
  for (let i = 0; i < all.length; i += 37) {
    const batch = all.slice(i, i + 37).reverse();
    shown = shown.concat(batch);
    // the newest move of the batch is "ours", still on this device's clock, a little ahead
    const mine = batch.find((e) => e.message.a === "move");
    if (mine) {
      local.add(mine.txId);
      shown = shown.map((e) => (e === mine ? { ...e, blockTime: e.blockTime + 1500 } : e));
    }
    same(reduceInc(shown, local), full(shown, local), `after ${shown.length} rows`);
  }
  // the chain's times land for our rows
  shown = shown.map((e) => (local.has(e.txId) ? all.find((a) => a.txId === e.txId) : e));
  local.clear();
  same(reduceInc(shown, local), full(shown, local), "chain times in");
  // a row that never landed is dropped
  const dropped = shown.filter((e) => e.message.a === "move").at(-3);
  shown = shown.filter((e) => e !== dropped);
  same(reduceInc(shown, local), full(shown, local), "a row dropped");
  // the same rows in another order: still the same
  same(reduceInc([...shown].reverse(), local), full(shown, local), "reordered input");
  // a row whose content changes (a new decoded message object) is replayed
  const changed = shown.findIndex((e) => e.message.a === "join");
  shown[changed] = { ...shown[changed], message: T.decodeMessage(T.encodeMessage(T.messages.leave(shown[changed].message.t))) };
  same(reduceInc(shown, local), full(shown, local), "a changed row");
  // no rows at all
  same(reduceInc([], local), full([], local), "empty");
});

test("#16 an unchanged room keeps its result; only the changed room is replayed", () => {
  const all = randomArena(11, 40);
  const reduceInc = T.createIncrementalReducer();
  const first = reduceInc(all, new Set());
  const room = Object.keys(first).find((k) => k.startsWith("duel-"));
  const other = Object.keys(first).find((k) => k !== room);
  const extra = ev("kaspa:stranger", all.at(-1).blockTime + 5, T.messages.join(room));
  const second = reduceInc([...all, extra], new Set());
  assert.equal(second[other], first[other], "an untouched room is the same object");
  same(second, full([...all, extra], new Set()), "with the extra row");
});

test("#16 a new row on a 500-game arena is far quicker than the full replay", () => {
  const all = randomArena(3, 500);
  const reduceInc = T.createIncrementalReducer();
  reduceInc(all, new Set());
  const extra = ev("kaspa:late", all.at(-1).blockTime + 5, T.messages.join(T.duelId(100_000)));
  const plus = [...all, extra];
  let s = performance.now();
  const inc = reduceInc(plus, new Set());
  const incMs = performance.now() - s;
  s = performance.now();
  const whole = full(plus, new Set());
  const fullMs = performance.now() - s;
  same(inc, whole, "500 games");
  console.log(`  (${all.length} rows: incremental ${incMs.toFixed(1)} ms, full ${fullMs.toFixed(1)} ms)`);
  assert.ok(incMs < fullMs, "incremental is quicker");
});

test("#16 the arena UI reduces through the incremental reducer with memoised messages", () => {
  assert.match(arenaUi, /const reduceArenaRooms = T\.createIncrementalReducer\(\);/);
  assert.match(arenaUi, /tournaments = reduceArenaRooms\(events, localStamps\);/);
  assert.match(arenaUi, /const message = rowMessage\(r\);/);
  assert.doesNotMatch(arenaUi, /tournaments = T\.reduce\(/);
});

// --- #10 the arena cache (engine/chess-tournament.js + ui/chess-tournaments.js) -----------------
const asRow = (e, extra = {}) => ({ txId: e.txId, senderAddress: e.sender, content: T.encodeMessage(e.message), blockTime: e.blockTime, verified: true, ...extra });

test("#10 the cache is capped by rows and size, whole rooms, newest first", () => {
  const all = randomArena(5, 1200).map((e) => asRow(e));
  assert.ok(all.length > T.ARENA_CACHE_MAX_ROWS, "the test arena is bigger than the cap");
  const kept = T.arenaCacheRows(all);
  assert.ok(kept.length <= T.ARENA_CACHE_MAX_ROWS);
  assert.ok(JSON.stringify(kept).length <= T.ARENA_CACHE_MAX_CHARS, "inside the character budget");
  assert.ok(kept.length > T.ARENA_CACHE_MAX_ROWS / 2, "and not needlessly small");
  for (let i = 1; i < kept.length; i += 1) assert.ok(kept[i - 1].blockTime <= kept[i].blockTime, "oldest first");
  const roomOf = (r) => T.decodeMessage(r.content).t;
  const keptRooms = new Set(kept.map(roomOf));
  for (const r of all) if (keptRooms.has(roomOf(r))) assert.ok(kept.includes(r), "a kept room is kept whole");
  const newestDropped = Math.max(...all.filter((r) => !keptRooms.has(roomOf(r))).map((r) => r.blockTime));
  const keptNewest = new Map();
  for (const r of kept) keptNewest.set(roomOf(r), Math.max(keptNewest.get(roomOf(r)) ?? 0, r.blockTime));
  for (const t of keptNewest.values()) assert.ok(t >= newestDropped, "only older rooms are dropped");
  // the character budget binds too
  const small = T.arenaCacheRows(all, { maxRows: 100_000, maxChars: 50_000 });
  assert.ok(JSON.stringify(small).length <= 50_000);
});

test("#10 rooms with this device's unconfirmed rows are always kept", () => {
  const all = randomArena(9, 600).map((e) => asRow(e));
  const oldest = all[0];
  all[0] = { ...oldest, local: true };
  const kept = T.arenaCacheRows(all, { maxRows: 50, maxChars: 20_000 });
  assert.ok(kept.some((r) => r.txId === oldest.txId && r.local), "our oldest unconfirmed row stays");
  const none = T.arenaCacheRows(all, { maxRows: 0, maxChars: 0 });
  assert.ok(none.length > 0 && none.every((r) => T.decodeMessage(r.content).t === T.decodeMessage(oldest.content).t), "at zero budget only our room is left");
});

test("#10 the UI saves capped and retries smaller on a refused write", () => {
  const save = fnBody(arenaUi, "saveCache");
  assert.match(save, /for \(const budget of \[1, 0\.5, 0\.25, 0\]\)/);
  assert.match(save, /T\.arenaCacheRows\(all, \{/);
  assert.match(save, /localStorage\.setItem\(ARENA_CACHE_KEY, JSON\.stringify\(list\)\);\s*return;/);
  assert.doesNotMatch(arenaUi, /ARENA_MAX_ROWS/);
});

console.log(`\n${passed} passed`);
