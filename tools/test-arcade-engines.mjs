// KaPlay's arcade engines (K 518fdc8c ArcadeEngines.swift) against ARCADE.md's test vectors: the
// indexer replays every stamp with the same rules, so these must match K exactly. Run from the repo
// root:
//
//   node tools/test-arcade-engines.mjs

import assert from "node:assert/strict";
import {
  ARCADE_GAMES, arcadeGame, ArcadeRandom, newArcadeSeed, arcadeSeedHex, arcadeSeedFromHex,
  SnakeEngine, replaySnake, snakeStepMs, Game2048Engine, replay2048, slideLine2048, lineIndices2048,
} from "../engine/arcade.js";

// --- §2 SplitMix64 ------------------------------------------------------------------------------
{
  const random = new ArcadeRandom(42n);
  assert.equal(random.next(), 13679457532755275413n, "seed 42, first value");
  assert.equal(random.next(), 2949826092126892291n, "seed 42, second value");
  const big = new ArcadeRandom(0xFFFFFFFFFFFFFFFFn);
  const value = big.next();
  assert.ok(value >= 0n && value < (1n << 64n), "wraps at 64 bits");
  const below = new ArcadeRandom(42n);
  assert.equal(below.below(10), Number(13679457532755275413n % 10n), "below(n) is next % n");
}
assert.equal(arcadeSeedHex(1n), "0000000000000001");
assert.equal(arcadeSeedHex(0x9f2c41d07a3b55e1n), "9f2c41d07a3b55e1");
assert.equal(arcadeSeedFromHex("9f2c41d07a3b55e1"), 0x9f2c41d07a3b55e1n);
assert.equal(arcadeSeedFromHex("9F2C41D07A3B55E1"), 0x9f2c41d07a3b55e1n);
assert.equal(arcadeSeedFromHex("123"), null, "16 digits");
assert.equal(arcadeSeedFromHex("zz2c41d07a3b55e1"), null, "hex only");
{
  const seed = newArcadeSeed();
  assert.equal(typeof seed, "bigint");
  assert.equal(arcadeSeedFromHex(arcadeSeedHex(seed)), seed, "a fresh seed round-trips");
}

// --- §3 Snake ------------------------------------------------------------------------------------
{
  const game = new SnakeEngine(1n);
  assert.deepEqual(game.food, { x: 0, y: 9 }, "seed 1: the first apple is (0,9)");
  assert.deepEqual(game.body, [{ x: 6, y: 8 }, { x: 5, y: 8 }, { x: 4, y: 8 }], "the start");
  assert.equal(game.heading, "R");
}
assert.deepEqual(replaySnake(1n, "1D 3L"), { score: 0, ticks: 11 }, "seed 1, 1D 3L: over after 11 ticks with 0");
{
  // Played live the same way, the moves text is the stamp's.
  const game = new SnakeEngine(1n);
  game.tick();
  game.tick("D");
  game.tick();
  game.tick("L");
  while (!game.isOver) game.tick();
  assert.equal(game.movesText, "1D 3L");
  assert.equal(game.ticks, 11);
  assert.equal(game.score, 0);
}
assert.equal(new SnakeEngine(1n).canTurn("R"), false, "not the heading");
assert.equal(new SnakeEngine(1n).canTurn("L"), false, "not straight back");
assert.equal(new SnakeEngine(1n).canTurn("U"), true);
assert.equal(replaySnake(1n, "1R"), null, "a turn onto the heading is invalid");
assert.equal(replaySnake(1n, "1L"), null, "a turn straight back is invalid");
assert.equal(replaySnake(1n, "3D 1L"), null, "ticks strictly increasing");
assert.equal(replaySnake(1n, "1D 1L"), null, "no repeated tick");
assert.equal(replaySnake(1n, "1X"), null, "a bad letter");
assert.equal(replaySnake(1n, "D"), null, "no tick");
assert.equal(replaySnake(1n, "+1D"), null, "digits only");
assert.deepEqual(replaySnake(1n, ""), { score: 0, ticks: 10 }, "no turns: straight into the right wall");
{
  // An apple eaten, then replayed: the score the engine reached.
  const game = new SnakeEngine(7n);
  let guard = 0;
  while (!game.isOver && guard < 5000) {
    guard += 1;
    const { x, y } = game.head;
    const food = game.food;
    let want = null;
    if (food) {
      if (food.x > x) want = "R"; else if (food.x < x) want = "L"; else if (food.y > y) want = "D"; else if (food.y < y) want = "U";
    }
    game.tick(want && game.canTurn(want) ? want : null);
    if (game.score >= 5) break;
  }
  while (!game.isOver) game.tick();
  const replay = replaySnake(7n, game.movesText);
  assert.deepEqual(replay, { score: game.score, ticks: game.ticks }, "a played game replays to its score");
}
{
  // Eating counts the tail cell; moving doesn't: a 4-long loop chasing its tail is legal.
  const game = new SnakeEngine(1n);
  game.body = [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 5 }];
  game.heading = "U";
  game.food = { x: 0, y: 0 };
  assert.equal(game.tick("R"), true, "onto the tail cell as it moves away");
}
assert.equal(snakeStepMs(0), 240);
assert.equal(snakeStepMs(10), 190);
assert.equal(snakeStepMs(100), 85);

// --- §4 2048 -------------------------------------------------------------------------------------
{
  const game = new Game2048Engine(1n);
  assert.deepEqual(game.tiles, [2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "seed 1 starts [2,2,0,...]");
  for (const letter of "LURDLURDLURD") assert.ok(game.move(letter), `${letter} moves`);
  assert.equal(game.score, 48, "LURDLURDLURD scores 48");
  assert.deepEqual(game.tiles, [0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 2, 16, 2, 2, 4, 2], "and leaves these tiles");
  assert.equal(game.moves, "LURDLURDLURD");
}
assert.deepEqual(replay2048(1n, "LURDLURDLURD"), { score: 48, isOver: false });
assert.equal(replay2048(1n, "U"), null, "[2,2,0,...] can't move up: a move that changes nothing is invalid");
assert.equal(replay2048(1n, "LX"), null, "a bad letter");
assert.deepEqual(replay2048(1n, ""), { score: 0, isOver: false });
assert.deepEqual(slideLine2048([2, 2, 2, 2]), { line: [4, 4, 0, 0], points: 8 }, "pairs merge once each");
assert.deepEqual(slideLine2048([2, 2, 2, 0]), { line: [4, 2, 0, 0], points: 4 }, "nearest the wall first");
assert.deepEqual(slideLine2048([4, 0, 4, 8]), { line: [8, 8, 0, 0], points: 8 }, "a merged tile doesn't merge again");
assert.deepEqual(slideLine2048([0, 0, 0, 2]), { line: [2, 0, 0, 0], points: 0 });
assert.deepEqual(lineIndices2048(0, "L"), [0, 1, 2, 3]);
assert.deepEqual(lineIndices2048(0, "R"), [3, 2, 1, 0]);
assert.deepEqual(lineIndices2048(1, "U"), [1, 5, 9, 13]);
assert.deepEqual(lineIndices2048(1, "D"), [13, 9, 5, 1]);
{
  // A full board with no pair is over.
  const game = new Game2048Engine(1n);
  game.tiles = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2];
  assert.equal(game.canMove, false);
  game.tiles[1] = 2;
  assert.equal(game.canMove, true);
}
{
  // A long game, played to its end, replays to its own score.
  const seed = 0xdeadbeefcafebaben;
  const game = new Game2048Engine(seed);
  const order = ["L", "D", "R", "U"];
  let turn = 0;
  while (!game.isOver && turn < 100_000) {
    if (!game.move(order[turn % 4])) game.move(order[(turn + 1) % 4]) || game.move(order[(turn + 2) % 4]) || game.move(order[(turn + 3) % 4]);
    turn += 1;
  }
  assert.ok(game.isOver, "the game ends");
  assert.deepEqual(replay2048(seed, game.moves), { score: game.score, isOver: true });
}

assert.deepEqual(ARCADE_GAMES.map((g) => g.id), ["snake", "2048"]);
assert.equal(arcadeGame("2048").title, "2048");
assert.equal(arcadeGame("SNAKE").title, "Snake");
assert.equal(arcadeGame("tetris"), null);

console.log("ok arcade engines");
