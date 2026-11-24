// KaPlay's arcade (K 518fdc8c ArcadeViews.swift, ARCADE.md): a game's home (Play, your best, the
// boards), the game itself (Snake, 2048) and the game-over sheet that stamps the score in the hidden
// #kplay-arcade room and shares it to KaPost through KaPost's composer, which slides up over the
// game (K KaPostQuickComposer) - the game stays where it was.
//
// The screens live inside KaPlay's own screen (ui/chess-tournaments.js), as the chess bots' do: its
// Games cards open them, its render() paints renderArcade() while view.name is "arcade", and its
// click, hide and account-reset hooks call the exports below. The engines are engine/arcade.js; the
// stamp job, records, boards and challenge links engine/arcade-services.js.
//
// Controls: arrow keys and WASD on a keyboard, a swipe on the board (touch or mouse), and Snake's
// arrow pad. Snake pauses whenever K isn't in front (the tab hidden, the window blurred, KaPlay
// left; audit 2026-11-24 #12) and waits for the next direction.

import "./arcade.css";
import { cycleButtonHtml, cycleChanged } from "./cycle-button.js";
import btcCoinUrl from "./assets/coins/coin_btc.png";
import kaspaLogoUrl from "./assets/kaspa-logo.png";
import { arcadeIconHtml } from "./arcade-icon.js";
import {
  arcadeGame, newArcadeSeed, SnakeEngine, Game2048Engine, snakeStepMs, SNAKE_WIDTH, SNAKE_HEIGHT, G2048_SIZE, lineIndices2048,
} from "../engine/arcade.js";
import {
  ARCADE_CHANNEL, ArcadeStampJob, ArcadeProgress, ArcadeBoards, arcadeCheckFromRest, isTxId, readCappedText,
  arcadeSharePostText, arcadeChallengeBannerText, arcadeConfirmedBy, formatArcadeScore, sampleArcadeStampContent,
  ARCADE_OTHER_ACCOUNT_NOTE,
} from "../engine/arcade-services.js";
import { sendBroadcastMessage, broadcastPayloadBytes } from "../engine/broadcasts.js";
import { getEndpoint } from "../engine/endpoints.js";
import { KAS_UNIT } from "../engine/network.js";

/** ui/app.js's accountScopedKey prefix, for when the host passes no accountScopedKey. */
const ACCOUNT_DATA_PREFIX = "kachat-account-data-v1";
const SWIPE_MIN_PX = 14;
const SLIDE_MS = 110;
const BOARD_POLL_MS = 60_000;

let ctx = null;            // { deps, render, exit, isShown }
let screen = "home";       // home | play
let gameId = "snake";
/** The challenge that opened the game's home: the parsed link and the post's signer. */
let challenge = null;
let period = "month";
let round = null;          // the round on screen (snakeRound / g2048Round)
let job = null;            // the finished round's stamp (ArcadeStampJob)
let sheetOpen = false;     // its game-over sheet is up
let feeText = null;
let feeEstimating = false;
let progress = null;
let boards = null;
let resetScroll = false;
let roundSerial = 0;

const deps = () => ctx?.deps || {};
const esc = (v) => (deps().escapeHtml ? deps().escapeHtml(String(v ?? "")) : String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
const me = () => deps().engine?.address || "";
const shown = () => { try { return Boolean(ctx?.isShown?.()); } catch { return false; } };
const requestRender = () => { if (!shown()) return; try { ctx?.render?.(); } catch { /* not on screen */ } };
const nameFor = (address) => (address ? (deps().displayNameFor?.(address) || address) : "");
const avatarFor = (address) => deps().avatarHtmlFor?.(address, "chess-t-avatar") || "";
const gameTitle = (id = gameId) => arcadeGame(id)?.title || "";

// ---------------------------------------------------------------------------------------------
// On chain
// ---------------------------------------------------------------------------------------------

function accountKey(name, address) {
  const d = deps();
  const clean = String(address || "").trim();
  if (typeof d.accountScopedKey === "function") return d.accountScopedKey(name, clean);
  return clean ? `${ACCOUNT_DATA_PREFIX}:${clean}:${name}` : name;
}

function storage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** The REST API's word on a stamp: accepted, not accepted (404) or no answer (K
 *  ArcadeTransactionCheck, audit 2026-11-24 #9). */
async function lookUpStamp(txId) {
  if (!isTxId(txId)) return "unanswered";
  const base = String(getEndpoint("kaspaApi") || "").trim().replace(/\/+$/, "");
  if (!base || typeof fetch !== "function") return "unanswered";
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), 8_000);
  try {
    const response = await fetch(`${base}/transactions/${encodeURIComponent(txId)}?inputs=false&outputs=false&resolve_previous_outpoints=no`, { headers: { Accept: "application/json" }, cache: "no-store", signal: controller?.signal });
    const json = response.status === 200 ? JSON.parse(await readCappedText(response, 256 * 1024)) : null;
    return arcadeCheckFromRest(response.status, json);
  } catch {
    return "unanswered";
  } finally {
    clearTimeout(timer);
  }
}

/** One broadcast in #kplay-arcade from the chatting address, single input like the chess stamps. */
async function sendStamp(content, address) {
  const engine = deps().engine;
  if (!engine?.address || engine.address !== address) throw new Error(ARCADE_OTHER_ACCOUNT_NOTE);
  return sendBroadcastMessage({ engine, channel: ARCADE_CHANNEL, content, feeKas: "0", singleInput: true, expectedSender: address });
}

function getProgress() {
  if (!progress) {
    progress = new ArcadeProgress({
      storage: storage(),
      keyFor: accountKey,
      lookUp: lookUpStamp,
      currentAddress: me,
      onChange: () => { if (screen === "home" || sheetOpen) requestRender(); },
      log: (line) => deps().appendEngineLog?.(line),
    });
  }
  return progress;
}

function getBoards() {
  if (!boards) {
    boards = new ArcadeBoards({
      fetch: (...args) => fetch(...args),
      base: () => getEndpoint("broadcastIndexer"),
      progress: getProgress(),
      currentAddress: me,
      onChange: () => { if (screen === "home") requestRender(); },
    });
  }
  return boards;
}

function refreshBoards(force = false) {
  getBoards().refresh(gameId, { force }).catch(() => {});
}

/** "about 0.0012 KAS" for the home's note. */
async function estimateStampFee() {
  if (feeText || feeEstimating || !deps().estimateFeeKas) return;
  feeEstimating = true;
  try {
    const fee = await deps().estimateFeeKas(broadcastPayloadBytes(ARCADE_CHANNEL, sampleArcadeStampContent()), { singleInput: true });
    if (fee != null && Number.isFinite(Number(fee))) { feeText = `${Number(fee).toFixed(4)} ${KAS_UNIT}`; if (screen === "home") requestRender(); }
  } catch { /* "a small network fee" */ } finally { feeEstimating = false; }
}

// ---------------------------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------------------------

function newRound() {
  stopRound();
  const seed = newArcadeSeed();
  roundSerial += 1;
  if (gameId === "snake") {
    round = { game: "snake", serial: roundSerial, seed, engine: new SnakeEngine(seed), queued: [], started: false, timer: 0, over: false };
  } else {
    const engine = new Game2048Engine(seed);
    round = { game: "2048", serial: roundSerial, seed, engine, shown: [], nextTile: 0, settle: null, settleTimer: 0, over: false };
    round.shown = tilesFromEngine(round);
  }
  job = null;
  sheetOpen = false;
}

function stopRound() {
  if (!round) return;
  clearTimeout(round.timer);
  clearTimeout(round.settleTimer);
  round.timer = 0;
  round.over = true;
}

/** A round ended: its stamp goes out (a score of 0 is shown, never sent) and the sheet comes up. */
function finishRound(r) {
  if (r !== round || r.finished) return;
  r.finished = true;
  r.over = true;
  const engine = r.engine;
  const score = engine.score;
  const moves = r.game === "snake" ? engine.movesText : engine.moves;
  const address = me();
  const next = new ArcadeStampJob({
    game: r.game, score, seed: r.seed, moves, playerAddress: address || null,
    currentAddress: me,
    send: (content) => sendStamp(content, address),
    lookUp: lookUpStamp,
    progress: getProgress(),
    onChange: (j) => { if (j === job && sheetOpen) requestRender(); },
    log: (line) => deps().appendEngineLog?.(line),
    shouldSend: score > 0,
  });
  job = next;
  sheetOpen = true;
  requestRender();
}

// --- Snake ---

function snakeAsk(direction) {
  const r = round;
  if (!r || r.game !== "snake" || r.over || sheetOpen) return;
  if (r.queued.length < 3) r.queued.push(direction);
  if (!r.started) {
    r.started = true;
    paintSnakeHint();
    scheduleSnakeStep(r);
  }
}

function scheduleSnakeStep(r) {
  clearTimeout(r.timer);
  r.timer = setTimeout(() => snakeStep(r), snakeStepMs(r.engine.score));
}

function snakeStep(r) {
  if (r !== round || !r.started || r.over) return;
  // the first queued turn that can be taken now
  let turn = null;
  while (r.queued.length) {
    const next = r.queued.shift();
    if (r.engine.canTurn(next)) { turn = next; break; }
  }
  r.engine.tick(turn);
  paintSnake();
  if (r.engine.isOver) { finishRound(r); return; }
  scheduleSnakeStep(r);
}

/** Paused (audit 2026-11-24 #12): the snake waits for the next direction, its hint back. */
function pauseSnake() {
  const r = round;
  if (!r || r.game !== "snake" || !r.started || r.over) return;
  clearTimeout(r.timer);
  r.timer = 0;
  r.queued = [];
  r.started = false;
  paintSnakeHint();
}

// --- 2048 ---

function tilesFromEngine(r) {
  const tiles = [];
  r.engine.tiles.forEach((value, cell) => {
    if (value) tiles.push({ id: ++r.nextTile, value, cell, pops: 0, consumed: false, isNew: false });
  });
  return tiles;
}

function settleNow(r) {
  if (!r?.settle) return;
  const settle = r.settle;
  r.settle = null;
  clearTimeout(r.settleTimer);
  settle();
}

/** One swipe (K Game2048PlayView.swipe): every tile slides to where it lands, equal tiles run into
 *  each other, then they become one and the new tile appears. The board as drawn always ends up as
 *  the engine's: on any mismatch the engine wins. */
function move2048(direction) {
  const r = round;
  if (!r || r.game !== "2048" || r.over || sheetOpen) return;
  settleNow(r);
  if (!r.engine.move(direction)) return;
  const moved = r.shown.map((tile) => ({ ...tile, isNew: false }));
  const merges = [];
  for (let line = 0; line < G2048_SIZE; line += 1) {
    const cells = lineIndices2048(line, direction);
    const inLine = cells.map((cell) => moved.findIndex((t) => t.cell === cell && !t.consumed)).filter((i) => i >= 0);
    let target = 0;
    let i = 0;
    while (i < inLine.length) {
      const a = inLine[i];
      if (i + 1 < inLine.length && moved[a].value === moved[inLine[i + 1]].value) {
        const b = inLine[i + 1];
        moved[a].cell = cells[target];
        moved[b].cell = cells[target];
        moved[b].consumed = true;
        merges.push([moved[a].id, moved[b].id]);
        i += 2;
      } else {
        moved[a].cell = cells[target];
        i += 1;
      }
      target += 1;
    }
  }
  r.shown = moved;
  paint2048();
  const after = { tiles: [...r.engine.tiles], lastSpawn: r.engine.lastSpawn };
  r.settle = () => {
    let tiles = r.shown.filter((t) => !t.consumed);
    for (const [keep] of merges) {
      const tile = tiles.find((t) => t.id === keep);
      if (tile) { tile.value *= 2; tile.pops += 1; }
    }
    if (after.lastSpawn != null && after.tiles[after.lastSpawn] !== 0) {
      tiles.push({ id: ++r.nextTile, value: after.tiles[after.lastSpawn], cell: after.lastSpawn, pops: 0, consumed: false, isNew: true });
    }
    const check = new Array(16).fill(0);
    for (const tile of tiles) if (tile.cell >= 0 && tile.cell < 16) check[tile.cell] = tile.value;
    if (check.some((value, index) => value !== after.tiles[index])) tiles = tilesFromEngine(r);
    r.shown = tiles;
    paint2048();
  };
  r.settleTimer = setTimeout(() => settleNow(r), SLIDE_MS);
  if (r.engine.isOver && !r.reported) {
    r.reported = true;
    setTimeout(() => finishRound(r), 600);
  }
}

function playDirection(direction) {
  if (round?.game === "snake") snakeAsk(direction);
  else if (round?.game === "2048") move2048(direction);
}

// ---------------------------------------------------------------------------------------------
// Painting what moves (no full render per tick)
// ---------------------------------------------------------------------------------------------

let rootEl = null;
const images = {};
function image(url) {
  if (!images[url]) {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => paintSnake();
    img.src = url;
    images[url] = img;
  }
  return images[url];
}

function paintScore() {
  if (!rootEl || !round) return;
  const score = rootEl.querySelector("[data-arcade-score]");
  if (score) score.textContent = formatArcadeScore(round.engine.score);
  const best = rootEl.querySelector("[data-arcade-best-tile]");
  if (best && round.game === "2048") best.textContent = formatArcadeScore(round.engine.bestTile);
}

function paintSnakeHint() {
  const hint = rootEl?.querySelector("[data-arcade-hint]");
  if (hint && round?.game === "snake") hint.hidden = round.started || round.over;
}

/** Kaspa eats Bitcoin (owner, 2026-11-24): the apple is the Bitcoin logo, the head the Kaspa logo. */
function paintSnake() {
  const canvas = rootEl?.querySelector("[data-arcade-snake]");
  const r = round;
  if (!canvas || !r || r.game !== "snake" || !canvas.isConnected) return;
  const side = canvas.clientWidth;
  if (!side) return;
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const px = Math.round(side * dpr);
  if (canvas.width !== px || canvas.height !== px) { canvas.width = px; canvas.height = px; }
  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, side, side);
  const cell = side / SNAKE_WIDTH;
  const styles = getComputedStyle(canvas);
  const accent = styles.getPropertyValue("--kaspa").trim() || "#70c7ba";
  const food = r.engine.food;
  if (food) {
    const coin = image(btcCoinUrl);
    const inset = cell * 0.08;
    const cx = food.x * cell + cell / 2;
    const cy = food.y * cell + cell / 2;
    const radius = cell / 2 - inset;
    g.save();
    g.beginPath();
    g.arc(cx, cy, radius * 0.97, 0, Math.PI * 2);
    g.clip();
    if (coin.complete && coin.naturalWidth) g.drawImage(coin, cx - radius, cy - radius, radius * 2, radius * 2);
    else { g.fillStyle = "#f7931a"; g.fill(); }
    g.restore();
  }
  const body = r.engine.body;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    const part = body[index];
    const x = part.x * cell + 1;
    const y = part.y * cell + 1;
    const w = cell - 2;
    if (index === 0) {
      const logo = image(kaspaLogoUrl);
      if (logo.complete && logo.naturalWidth) g.drawImage(logo, x - 0.5, y - 0.5, w + 1, w + 1);
      else { g.fillStyle = accent; g.beginPath(); g.arc(x + w / 2, y + w / 2, w / 2, 0, Math.PI * 2); g.fill(); }
    } else {
      g.globalAlpha = 0.75;
      g.fillStyle = accent;
      roundRect(g, x, y, w, w, cell * 0.25);
      g.fill();
      g.globalAlpha = 1;
    }
  }
  paintScore();
  paintSnakeHint();
}

function roundRect(g, x, y, w, h, radius) {
  const rr = Math.min(radius, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

/** The tiles as drawn, each its own element, so a move slides it (K Game2048Tile). */
const tileEls = new Map();
function tileBackground(value) {
  const level = value > 0 ? Math.log2(value) : 0;
  return `rgba(112, 199, 186, ${Math.min(1, 0.25 + level * 0.07).toFixed(2)})`;
}
function paint2048() {
  const layer = rootEl?.querySelector("[data-arcade-tiles]");
  const r = round;
  if (!layer || !r || r.game !== "2048") return;
  const keep = new Set();
  // consumed tiles under the ones they merge into
  const order = [...r.shown].sort((a, b) => (a.consumed ? 0 : 1) - (b.consumed ? 0 : 1));
  for (const tile of order) {
    keep.add(tile.id);
    let el = tileEls.get(tile.id);
    let created = false;
    if (!el || !el.isConnected) {
      el = document.createElement("div");
      el.className = `arcade-2048-tile${tile.isNew ? " new" : ""}`;
      el.innerHTML = `<span class="arcade-2048-face"></span>`;
      el.dataset.pops = String(tile.pops);
      tileEls.set(tile.id, el);
      created = true;
    }
    // placed before it is in the page, so a new tile appears in its cell rather than sliding there
    el.style.setProperty("--x", String(tile.cell % G2048_SIZE));
    el.style.setProperty("--y", String(Math.floor(tile.cell / G2048_SIZE)));
    el.style.zIndex = tile.consumed ? "1" : "2";
    if (created) layer.append(el);
    const face = el.firstElementChild;
    const digits = String(tile.value).length;
    face.textContent = String(tile.value);
    face.style.background = tileBackground(tile.value);
    face.classList.toggle("dark-text", Math.log2(tile.value) >= 7);
    face.dataset.digits = String(Math.min(digits, 5));
    if (el.dataset.pops !== String(tile.pops)) {
      el.dataset.pops = String(tile.pops);
      // the clash: a quick swell as the two become one
      face.classList.remove("pop");
      void face.offsetWidth;
      face.classList.add("pop");
    }
  }
  for (const [id, el] of tileEls) {
    if (!keep.has(id)) { el.remove(); tileEls.delete(id); }
  }
  paintScore();
}

// ---------------------------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------------------------

const ICON_BACK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"/></svg>`;
const ICON_FLAGS = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21 15.5 4.5M15.5 4.5 21 8l-3.5 3.8L13 10.5M20 21 8.5 4.5M8.5 4.5 3 8l3.5 3.8 4.5-1.3"/></svg>`;
const ICON_SEAL = `<svg class="arcade-status-icon ok" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="m7.5 12.3 3 3 6-6.3" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_WARN = `<svg class="arcade-status-icon warn" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20L12 3Z" fill="currentColor"/><path d="M12 10v4.5M12 17.2v.3" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>`;
const ICON_CLOCK = `<svg class="arcade-status-icon warn" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const ICON_SHARE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3.5M8 7l4-4 4 4M7.5 10.5H6a1.5 1.5 0 0 0-1.5 1.5v7.5A1.5 1.5 0 0 0 6 21h12a1.5 1.5 0 0 0 1.5-1.5V12a1.5 1.5 0 0 0-1.5-1.5h-1.5"/></svg>`;
const ICON_REFRESH = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 12.6A7.5 7.5 0 1 1 17 6.6"/><path d="M19.6 3.8v4.6H15"/></svg>`;
const ARROWS = { U: "m6 15 6-6 6 6", D: "m6 9 6 6 6-6", L: "m15 6-6 6 6 6", R: "m9 6 6 6-6 6" };
const ARROW_NAMES = { U: "Up", D: "Down", L: "Left", R: "Right" };

function headerHtml(title, trailing = "") {
  return `
    <div class="kaposts-header chess-t-header chess-t-header-pushed">
      <button class="kaposts-icon-button" type="button" data-arcade-back aria-label="Back">${ICON_BACK}</button>
      <h1 class="kaposts-title">${esc(title)}</h1>
      ${trailing}
    </div>`;
}

function challengeBannerHtml() {
  if (!challenge || challenge.game !== gameId) return "";
  // named only when the link's `by` is the post's signer (audit 2026-11-24 #21)
  const confirmed = arcadeConfirmedBy(challenge, challenge.author);
  const text = arcadeChallengeBannerText({ challenge, who: confirmed ? nameFor(confirmed) : null });
  if (!text) return "";
  return `<div class="arcade-challenge">${ICON_FLAGS}<span>${esc(text)}</span></div>`;
}

function leaderboardHtml() {
  const b = getBoards();
  const rows = b.rows(gameId, period);
  const my = me().toLowerCase();
  const options = [["month", "This month"], ["all", "All time"]];
  const fade = cycleChanged(`page:arcade-${gameId}`, period) ? " cycle-fade" : "";
  let body;
  if (!rows.length) {
    body = b.unreachable(gameId)
      ? `<p class="field-hint arcade-board-empty">The leaderboard couldn't be loaded. <button class="arcade-link-button" type="button" data-arcade-refresh>Try again</button></p>`
      : `<p class="field-hint arcade-board-empty">No scores yet. Be the first.</p>`;
  } else {
    body = `<div class="chess-t-list">${rows.map((row, i) => `
      <button class="chess-t-row${row.address.toLowerCase() === my ? " me" : ""}" type="button" data-arcade-user="${esc(row.address)}">
        <span class="chess-t-rank${i < 3 ? " top" : ""}">${i + 1}</span>
        ${avatarFor(row.address)}
        <span class="chess-t-row-main"><strong>${esc(nameFor(row.address))}</strong></span>
        <span class="arcade-board-score">${esc(formatArcadeScore(row.score))}</span>
      </button>`).join("")}</div>`;
  }
  // This month / All time on the cycle button beside the title (K 518fdc8c ArcadeViews).
  return `
    <div class="arcade-board-head">
      <h2>Leaderboard</h2>
      <span class="arcade-board-tools">
        ${cycleButtonHtml({ name: `arcade-period-${gameId}`, options, value: period, hint: "Switches the leaderboard period", attrs: "data-arcade-period" })}
        <button class="kaposts-icon-button" type="button" data-arcade-refresh aria-label="Refresh" title="Refresh">${ICON_REFRESH}</button>
      </span>
    </div>
    <div class="arcade-board-rows${fade}">${body}</div>`;
}

function renderHome() {
  const best = getProgress().best(gameId);
  const fee = feeText ? ` About ${feeText} a game.` : "";
  return `
    ${headerHtml(gameTitle())}
    <div class="chess-t-body arcade-home">
      ${challengeBannerHtml()}
      <div class="arcade-hero">
        <span class="arcade-hero-icon${gameId === "2048" ? " number" : ""}">${arcadeIconHtml(gameId)}</span>
        <p>${esc(arcadeGame(gameId)?.detail || "")}</p>
        ${best ? `<strong class="arcade-best">Your best: ${esc(formatArcadeScore(best.score))}</strong>` : ""}
        <button class="primary-button arcade-play-button" type="button" data-arcade-play>Play</button>
        <small>Each finished game's score is stamped on Kaspa from your chatting address, for a small network fee.${esc(fee)}</small>
      </div>
      ${leaderboardHtml()}
    </div>`;
}

function stampLineHtml(j) {
  switch (j.state) {
    case "sending": return `<span class="chess-bot-spinner small" role="progressbar" aria-label="Sending"></span><span>Stamping the score on Kaspa…</span>`;
    case "stamped": return `${ICON_SEAL}<span>Score stamped on Kaspa</span>`;
    case "failed": return `${ICON_WARN}<span>${esc(j.note || "The score was not sent.")}</span>`;
    case "unconfirmed": return `${ICON_CLOCK}<span>${esc(j.note || "")}</span>`;
    default: return `<span>No score to stamp.</span>`;
  }
}

/** Why Share to KaPost is off or back on (audit 2026-11-24 #8). Posting and shared are the
 *  button's own title. */
function shareLineHtml(j) {
  if (j.share === "unconfirmed") return `<p class="arcade-status">${ICON_CLOCK}<span>${esc(j.shareNote || "")}</span></p>`;
  if (j.share === "failed") return `<p class="arcade-status">${ICON_WARN}<span>${esc(j.shareNote || "")}</span></p>`;
  return "";
}

function gameOverHtml() {
  const j = job;
  if (!j || !sheetOpen) return "";
  const best = getProgress().best(j.game);
  return `
    <div class="arcade-over" role="dialog" aria-modal="true" aria-label="Game Over">
      <div class="arcade-over-card">
        <strong class="arcade-over-title">Game Over</strong>
        <span class="arcade-over-score">${esc(formatArcadeScore(j.score))}</span>
        ${best && best.gameId !== j.id ? `<small class="arcade-over-best">Your best: ${esc(formatArcadeScore(best.score))}</small>` : ""}
        <p class="arcade-status">${stampLineHtml(j)}</p>
        ${shareLineHtml(j)}
        ${j.score > 0 ? `<button class="chess-bot-share arcade-share" type="button" data-arcade-share ${j.shareEnabled ? "" : "disabled"}>${ICON_SHARE}<span>${esc(j.shareTitle)}</span></button>` : ""}
        <div class="chess-bot-end-actions">
          <button class="primary-button" type="button" data-arcade-again>Play Again</button>
          <button class="secondary-button chess-bot-done" type="button" data-arcade-done>Done</button>
        </div>
      </div>
    </div>`;
}

function padHtml() {
  const arrow = (d) => `<button class="arcade-pad-button" type="button" data-arcade-dir="${d}" aria-label="${ARROW_NAMES[d]}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ARROWS[d]}"/></svg></button>`;
  return `<div class="arcade-pad">${arrow("U")}<div class="arcade-pad-row">${arrow("L")}${arrow("R")}</div>${arrow("D")}</div>`;
}

function renderPlay() {
  const r = round;
  if (!r) return renderHome();
  let board;
  let top;
  let hint;
  if (r.game === "snake") {
    top = `<div class="arcade-scorebar"><span class="arcade-score-big">Score: <b data-arcade-score>${esc(formatArcadeScore(r.engine.score))}</b></span></div>`;
    board = `<div class="arcade-board arcade-snake-board" data-arcade-board><canvas data-arcade-snake aria-label="Snake board" role="img"></canvas></div>`;
    hint = `<p class="field-hint center" data-arcade-hint ${r.started || r.over ? "hidden" : ""}>Use the arrow keys or WASD, or swipe on the board, to start.</p>${padHtml()}`;
  } else {
    top = `
      <div class="arcade-scorebar">
        <span class="arcade-score-box"><small>Score</small><b data-arcade-score>${esc(formatArcadeScore(r.engine.score))}</b></span>
        <span class="arcade-score-box"><small>Best Tile</small><b data-arcade-best-tile>${esc(formatArcadeScore(r.engine.bestTile))}</b></span>
      </div>`;
    board = `
      <div class="arcade-board arcade-2048" data-arcade-board aria-label="2048 board" role="img">
        <div class="arcade-2048-cells">${Array.from({ length: 16 }, () => `<span class="arcade-2048-cell"></span>`).join("")}</div>
        <div class="arcade-2048-tiles" data-arcade-tiles></div>
      </div>`;
    hint = `<p class="field-hint center">Use the arrow keys or WASD, or swipe, to move the tiles. Equal tiles merge.</p>`;
  }
  return `
    <div class="arcade-play-wrap">
      ${headerHtml(gameTitle(r.game))}
      <div class="chess-t-body arcade-play">
        ${top}
        ${board}
        ${hint}
      </div>
      ${gameOverHtml()}
    </div>`;
}

// ---------------------------------------------------------------------------------------------
// Hooks for ui/chess-tournaments.js
// ---------------------------------------------------------------------------------------------

/** `dependencies`: KaPlay's deps (engine, escapeHtml, displayNameFor, avatarHtmlFor,
 *  estimateFeeKas, openUserInfo, openKaPostQuickComposer, showToast, appendEngineLog;
 *  accountScopedKey when the host passes it). `render`: repaint KaPlay's screen. `exit`: back to
 *  KaPlay's games. `isShown()`: the arcade is the screen in front. */
export function initArcade({ deps: dependencies, render, exit, isShown }) {
  ctx = { deps: dependencies || {}, render, exit, isShown };
  if (typeof globalThis.document?.addEventListener !== "function" || typeof globalThis.window?.addEventListener !== "function") return;
  document.addEventListener("keydown", onKeyDown);
  // Snake pauses whenever K isn't in front (audit 2026-11-24 #12).
  document.addEventListener("visibilitychange", () => { if (document.hidden) pauseArcade(); });
  window.addEventListener("blur", () => pauseArcade());
  window.addEventListener("resize", () => { if (screen === "play" && shown()) paintSnake(); });
  // Unconfirmed stamps are looked up about once a minute while a game's home is up (audit #9).
  setInterval(() => { if (screen === "home" && shown() && !document.hidden) refreshBoards(); }, BOARD_POLL_MS);
}

/** A game's card, or a challenge: that game's home, with the score to beat when a challenge
 *  opened it. `link` is a parsed challenge with `author`, the post's signer (or null). */
export function openArcadeGame(game, link = null) {
  if (!arcadeGame(game)) return;
  if (screen === "play") stopRound();
  round = null;
  job = null;
  sheetOpen = false;
  gameId = arcadeGame(game).id;
  challenge = link && link.game === gameId ? link : null;
  screen = "home";
  period = "month";
  resetScroll = true;
  refreshBoards();
  estimateStampFee().catch(() => {});
}

export function renderArcade() {
  return screen === "play" && round ? renderPlay() : renderHome();
}

/** After KaPlay painted an arcade screen: the board drawn, its swipes bound, a new screen at top. */
export function afterArcadeRender(root) {
  rootEl = root || null;
  if (!root) return;
  if (!root.dataset.arcadeSwipe) {
    root.dataset.arcadeSwipe = "1";
    let start = null;
    root.addEventListener("pointerdown", (event) => {
      if (!event.target.closest?.("[data-arcade-board]")) return;
      start = { x: event.clientX, y: event.clientY, id: event.pointerId };
    });
    root.addEventListener("pointerup", (event) => {
      if (!start || start.id !== event.pointerId) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      start = null;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_MIN_PX) return;
      playDirection(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "R" : "L") : (dy > 0 ? "D" : "U"));
    });
    root.addEventListener("pointercancel", () => { start = null; });
  }
  if (screen === "play" && round) {
    tileEls.clear();
    if (round.game === "snake") paintSnake(); else paint2048();
  }
  if (resetScroll) {
    resetScroll = false;
    const body = root.querySelector(".chess-t-body");
    if (body) body.scrollTop = 0;
  }
}

/** Every click on an arcade screen. */
export function arcadeClick(event) {
  const t = event.target;
  if (t.closest("[data-arcade-back]")) {
    if (screen === "play") {
      // Done: the round closes (K's Done); a stamp already going out goes on.
      stopRound();
      round = null;
      sheetOpen = false;
      screen = "home";
      resetScroll = true;
      refreshBoards(true);
      requestRender();
      return;
    }
    challenge = null;
    ctx?.exit?.();
    return;
  }
  if (t.closest("[data-arcade-play]") || t.closest("[data-arcade-again]")) {
    screen = "play";
    newRound();
    resetScroll = true;
    requestRender();
    return;
  }
  if (t.closest("[data-arcade-done]")) {
    stopRound();
    round = null;
    sheetOpen = false;
    screen = "home";
    resetScroll = true;
    refreshBoards(true);
    requestRender();
    return;
  }
  const period_ = t.closest("[data-arcade-period]");
  if (period_) { period = period_.dataset.cycleNext === "all" ? "all" : "month"; requestRender(); return; }
  if (t.closest("[data-arcade-refresh]")) { refreshBoards(true); return; }
  const user = t.closest("[data-arcade-user]");
  if (user) { deps().openUserInfo?.(user.dataset.arcadeUser); return; }
  const dir = t.closest("[data-arcade-dir]");
  if (dir) { playDirection(dir.dataset.arcadeDir); return; }
  if (t.closest("[data-arcade-share]")) { share(); }
}

/** Share to KaPost (K ArcadePlayView): KaPost's composer slides up over the game with the post
 *  written; Post sends it at once, the X closes it, and the game-over sheet is right where it was.
 *  A stamp that failed is retried instead. */
function share() {
  const j = job;
  if (!j) return;
  if (j.state === "failed") { j.retry(); return; }
  if (!j.shareEnabled) return;
  const by = me();
  if (!by) return;
  const text = arcadeSharePostText({ game: j.game, score: j.score, by, gameId: j.id });
  deps().openKaPostQuickComposer?.(text, {
    onPosting: () => j.sharePosting(),
    onResult: (result) => {
      j.shareResult(result);
      // the sheet shows how it went; once it has gone, a toast does
      if (j === job && sheetOpen) return;
      if (result?.ok) deps().showToast?.("Posted to KaPost");
      else if (!result?.unknown) deps().showToast?.(j.shareNote || "The post didn't go out.");
    },
  });
}

/** A round on screen holds challenge links until it closes (audit 2026-11-24 #11). */
export function arcadeRoundOpen() {
  return screen === "play" && Boolean(round);
}

/** K isn't in front, or KaPlay was left: Snake waits for the next direction. */
export function pauseArcade() {
  pauseSnake();
}

/** Another account: its own records and fee; a stamp of the old one finishes on its own. */
export function resetArcadeForAccount() {
  stopRound();
  round = null;
  job = null;
  sheetOpen = false;
  screen = "home";
  challenge = null;
  feeText = null;
}

function onKeyDown(event) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  if (screen !== "play" || !round || sheetOpen || !shown()) return;
  const target = event.target;
  if (target?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return;
  // nothing over the game: the quick composer, a dialog
  if (document.querySelector(".modal-backdrop:not([hidden])")) return;
  const direction = { ArrowUp: "U", ArrowDown: "D", ArrowLeft: "L", ArrowRight: "R", w: "U", s: "D", a: "L", d: "R", W: "U", S: "D", A: "L", D: "R" }[event.key];
  if (!direction) return;
  event.preventDefault();
  playDirection(direction);
}

void SNAKE_HEIGHT;
