// KaPlay's arcade (K 518fdc8c ArcadeEngines.swift, ARCADE.md): Snake and 2048. Every game is
// seeded and deterministic, so a finished game's stamp (its seed and its moves) replays to the same
// score anywhere: the indexer checks a score by playing it again. Nothing here knows about time or
// the screen: ui/arcade.js drives these engines and draws them. Tests: tools/test-arcade-engines.mjs.

/** The arcade's games (K ArcadeGame), in KaPlay's order. */
export const ARCADE_GAMES = Object.freeze([
  Object.freeze({ id: "snake", title: "Snake", detail: "Eat, grow, don't hit the walls or yourself. Scores go on Kaspa." }),
  Object.freeze({ id: "2048", title: "2048", detail: "Swipe to merge tiles and reach 2048. Scores go on Kaspa." }),
]);
export function arcadeGame(id) {
  return ARCADE_GAMES.find((game) => game.id === String(id ?? "").toLowerCase()) || null;
}

// --- Chance: SplitMix64 (ARCADE.md §2) -----------------------------------------------------------

const MASK64 = (1n << 64n) - 1n;

/** SplitMix64, the arcade's only source of chance: the same seed gives the same game on any
 *  device and in the indexer. `seed` is a BigInt (or anything BigInt() takes), wrapped to 64 bits. */
export class ArcadeRandom {
  constructor(seed) {
    this.state = BigInt.asUintN(64, BigInt(seed));
  }

  /** The next 64-bit value, a BigInt. */
  next() {
    this.state = (this.state + 0x9E3779B97F4A7C15n) & MASK64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK64;
    return z ^ (z >> 31n);
  }

  /** 0 ..< n (n > 0), as `next() % n`. */
  below(n) {
    return Number(this.next() % BigInt(n));
  }
}

/** A fresh seed for a new game (K ArcadeRandom.newSeed). */
export function newArcadeSeed() {
  const words = new Uint32Array(2);
  globalThis.crypto.getRandomValues(words);
  return (BigInt(words[0]) << 32n) | BigInt(words[1]);
}

/** 16 lowercase hex digits (K ArcadeRandom.hex). */
export function arcadeSeedHex(seed) {
  return BigInt.asUintN(64, BigInt(seed)).toString(16).padStart(16, "0");
}

/** A seed back from its 16 hex digits, or null (K ArcadeRandom.seed(fromHex:)). */
export function arcadeSeedFromHex(text) {
  const value = String(text ?? "");
  if (!/^[0-9a-fA-F]{16}$/.test(value)) return null;
  return BigInt(`0x${value}`);
}

// --- Directions ------------------------------------------------------------------------------------

export const DIRECTIONS = Object.freeze({
  U: Object.freeze({ dx: 0, dy: -1, opposite: "D" }),
  D: Object.freeze({ dx: 0, dy: 1, opposite: "U" }),
  L: Object.freeze({ dx: -1, dy: 0, opposite: "R" }),
  R: Object.freeze({ dx: 1, dy: 0, opposite: "L" }),
});
export const isDirection = (letter) => Object.prototype.hasOwnProperty.call(DIRECTIONS, letter);

// --- Snake (ARCADE.md §3) ------------------------------------------------------------------------

export const SNAKE_WIDTH = 16;
export const SNAKE_HEIGHT = 16;
/** Ticks a replay may run before the stamp counts as invalid. */
export const SNAKE_REPLAY_LIMIT = 1_000_000;

const cellKey = (x, y) => y * SNAKE_WIDTH + x;

/** A 16 by 16 board. The snake starts three long at (6,8), (5,8), (4,8), heading right. Each tick
 *  it takes the turn queued for that tick (if any), moves one cell, and either eats the apple
 *  (grows by one, score +1, a new apple) or moves its tail along. Hitting a wall or its own body
 *  ends the game (the tail cell it is leaving doesn't count, unless it is eating). */
export class SnakeEngine {
  constructor(seed) {
    this.random = new ArcadeRandom(seed);
    this.body = [{ x: 6, y: 8 }, { x: 5, y: 8 }, { x: 4, y: 8 }];
    this.heading = "R";
    this.food = null;
    this.score = 0;
    this.ticks = 0;
    this.isOver = false;
    /** The turns taken: [{ tick, direction }]. */
    this.turns = [];
    this.placeFood();
  }

  get head() { return this.body[0]; }

  /** Whether `direction` would be taken now: not the way it is already going, nor straight back. */
  canTurn(direction) {
    return isDirection(direction) && direction !== this.heading && direction !== DIRECTIONS[this.heading].opposite;
  }

  /** One step. `turn`, if it can be taken, is taken first and recorded. False when the game is
   *  (or just went) over. */
  tick(turn = null) {
    if (this.isOver) return false;
    if (turn && this.canTurn(turn)) {
      this.heading = turn;
      this.turns.push({ tick: this.ticks, direction: turn });
    }
    this.ticks += 1;
    const { dx, dy } = DIRECTIONS[this.heading];
    const next = { x: this.head.x + dx, y: this.head.y + dy };
    const eating = this.food != null && next.x === this.food.x && next.y === this.food.y;
    if (next.x < 0 || next.x >= SNAKE_WIDTH || next.y < 0 || next.y >= SNAKE_HEIGHT) {
      this.isOver = true;
      return false;
    }
    const blocking = eating ? this.body.length : this.body.length - 1;
    for (let index = 0; index < blocking; index += 1) {
      const part = this.body[index];
      if (part.x === next.x && part.y === next.y) {
        this.isOver = true;
        return false;
      }
    }
    this.body.unshift(next);
    if (eating) {
      this.score += 1;
      this.placeFood();
    } else {
      this.body.pop();
    }
    return true;
  }

  /** The apple goes on one of the empty cells, counted row by row from the top left. */
  placeFood() {
    const taken = new Set(this.body.map((part) => cellKey(part.x, part.y)));
    const empty = [];
    for (let y = 0; y < SNAKE_HEIGHT; y += 1) {
      for (let x = 0; x < SNAKE_WIDTH; x += 1) {
        if (!taken.has(cellKey(x, y))) empty.push({ x, y });
      }
    }
    if (!empty.length) {
      this.food = null;
      this.isOver = true;
      return;
    }
    this.food = empty[this.random.below(empty.length)];
  }

  /** The turns as the stamp writes them: "12R 30U" (the tick it was taken on, then the direction). */
  get movesText() {
    return this.turns.map((turn) => `${turn.tick}${turn.direction}`).join(" ");
  }
}

/** Replays a Snake stamp: `{ score, ticks }` it really reaches, or null when the moves don't make a
 *  game (a bad token, ticks not strictly increasing, a turn that is the heading or its opposite, or
 *  no end within SNAKE_REPLAY_LIMIT ticks). */
export function replaySnake(seed, moves) {
  const turns = new Map();
  let lastTick = -1;
  for (const token of String(moves ?? "").split(" ")) {
    if (!token) continue;
    const letter = token.slice(-1);
    const digits = token.slice(0, -1);
    if (!isDirection(letter) || !/^\d+$/.test(digits)) return null;
    const tick = Number(digits);
    if (!Number.isSafeInteger(tick) || tick <= lastTick) return null;
    turns.set(tick, letter);
    lastTick = tick;
  }
  const game = new SnakeEngine(seed);
  while (!game.isOver && game.ticks < SNAKE_REPLAY_LIMIT) {
    const turn = turns.get(game.ticks);
    if (turn) {
      if (!game.canTurn(turn)) return null;
      game.tick(turn);
    } else {
      game.tick();
    }
  }
  return game.isOver ? { score: game.score, ticks: game.ticks } : null;
}

/** How long a Snake step takes: 240 ms, 5 ms less per apple, down to 85 (K SnakePlayView). */
export function snakeStepMs(score) {
  return Math.max(85, 240 - Math.max(0, Number(score) || 0) * 5);
}

// --- 2048 (ARCADE.md §4) -------------------------------------------------------------------------

export const G2048_SIZE = 4;

/** The cells of one line, from the wall the tiles move toward (K Game2048Engine.lineIndices). */
export function lineIndices2048(line, direction) {
  const size = G2048_SIZE;
  const cells = [];
  for (let step = 0; step < size; step += 1) {
    if (direction === "L") cells.push(line * size + step);
    else if (direction === "R") cells.push(line * size + (size - 1 - step));
    else if (direction === "U") cells.push(step * size + line);
    else cells.push((size - 1 - step) * size + line);
  }
  return cells;
}

/** One line, slid toward its start: equal neighbours merge once each, the first pair first.
 *  `{ line, points }`. */
export function slideLine2048(values) {
  const tiles = values.filter((value) => value !== 0);
  const out = [];
  let points = 0;
  let index = 0;
  while (index < tiles.length) {
    if (index + 1 < tiles.length && tiles[index] === tiles[index + 1]) {
      const merged = tiles[index] * 2;
      out.push(merged);
      points += merged;
      index += 2;
    } else {
      out.push(tiles[index]);
      index += 1;
    }
  }
  while (out.length < G2048_SIZE) out.push(0);
  return { line: out, points };
}

/** A 4 by 4 board. Two tiles to start, then one after every move that changes the board: on one
 *  of the empty cells (row by row from the top left), a 4 one time in ten, else a 2. A move that
 *  changes nothing isn't a move. The game is over when no move changes the board. */
export class Game2048Engine {
  constructor(seed) {
    this.random = new ArcadeRandom(seed);
    /** Row by row: tiles[y * 4 + x], 0 for empty. */
    this.tiles = new Array(16).fill(0);
    this.score = 0;
    this.moves = "";
    this.isOver = false;
    /** Where the last tile appeared, for the view's pop. */
    this.lastSpawn = null;
    this.spawn();
    this.spawn();
  }

  get bestTile() { return Math.max(...this.tiles); }

  /** Plays `direction`; false (and nothing recorded) when it changes nothing. */
  move(direction) {
    if (this.isOver || !isDirection(direction)) return false;
    let changed = false;
    let gained = 0;
    for (let line = 0; line < G2048_SIZE; line += 1) {
      const indices = lineIndices2048(line, direction);
      const values = indices.map((index) => this.tiles[index]);
      const { line: merged, points } = slideLine2048(values);
      if (merged.some((value, i) => value !== values[i])) {
        changed = true;
        indices.forEach((index, i) => { this.tiles[index] = merged[i]; });
      }
      gained += points;
    }
    if (!changed) return false;
    this.score += gained;
    this.moves += direction;
    this.spawn();
    if (!this.canMove) this.isOver = true;
    return true;
  }

  get canMove() {
    if (this.tiles.includes(0)) return true;
    for (let y = 0; y < G2048_SIZE; y += 1) {
      for (let x = 0; x < G2048_SIZE; x += 1) {
        const value = this.tiles[y * G2048_SIZE + x];
        if (x + 1 < G2048_SIZE && this.tiles[y * G2048_SIZE + x + 1] === value) return true;
        if (y + 1 < G2048_SIZE && this.tiles[(y + 1) * G2048_SIZE + x] === value) return true;
      }
    }
    return false;
  }

  spawn() {
    const empty = [];
    this.tiles.forEach((value, index) => { if (value === 0) empty.push(index); });
    if (!empty.length) { this.lastSpawn = null; return; }
    const cell = empty[this.random.below(empty.length)];
    this.tiles[cell] = this.random.below(10) === 0 ? 4 : 2;
    this.lastSpawn = cell;
  }
}

/** Replays a 2048 stamp: `{ score, isOver }`, or null when a letter isn't a move or a move changes
 *  nothing (a real game never records one). */
export function replay2048(seed, moves) {
  const game = new Game2048Engine(seed);
  for (const letter of String(moves ?? "")) {
    if (!game.move(letter)) return null;
  }
  return { score: game.score, isOver: game.isOver };
}
