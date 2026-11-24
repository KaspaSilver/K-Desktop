// KaPlay's arcade on Kaspa (K 518fdc8c ArcadeServices.swift, ARCADE.md): a finished game is stamped in
// the hidden `#kplay-arcade` room by the player's chatting address; the indexer replays each stamp
// and serves the boards (`GET /arcade/leaderboard`, INDEXER_HANDOFF.md, not served yet); a score
// shared to KaPost carries a `kachatarcade://` challenge. Pure and UI-free: the stamp job, the
// boards and the record store take their I/O as arguments, so tools/test-arcade-services.mjs runs
// them under node. ui/arcade.js wires them to the wallet, fetch and localStorage.

import { arcadeGame, arcadeSeedHex } from "./arcade.js";
import { isPaymentAddress } from "./payment-request.js";
import {
  periodSinceMs, LEADERBOARD_PERIODS, isRetryableSendError, friendlySendErrorMessage, sendOutcomeUnknownTxid,
  SEND_OUTCOME_UNKNOWN_NOTE,
} from "./chess-tournament.js";

export const ARCADE_CHANNEL = "kplay-arcade";
export const ARCADE_PERIODS = LEADERBOARD_PERIODS;

const isAddress = (value) => typeof value === "string" && (isPaymentAddress(value, "kaspa") || isPaymentAddress(value, "kaspatest"));
const sameAddress = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
/** A score as K's `formatted()` writes it in English: "1,240". */
export const formatArcadeScore = (score) => Number(score || 0).toLocaleString("en-US");

// --- The stamp (ARCADE.md §1) --------------------------------------------------------------------

/** The stamp's JSON, keys sorted, no whitespace: the bytes K's JSONEncoder(.sortedKeys) writes. */
export function arcadeStampContent({ game, gameId, seed, score, moves }) {
  return JSON.stringify({ g: String(gameId), game: String(game), m: String(moves ?? ""), score: Number(score), seed: arcadeSeedHex(seed), type: "arcade", v: 1 });
}

/** A typical stamp, for the fee estimate: a Snake game of 60 turns. */
export function sampleArcadeStampContent() {
  const turns = Array.from({ length: 60 }, (_, i) => `${(i + 1) * 17}${"URDL"[i % 4]}`).join(" ");
  return arcadeStampContent({ game: "snake", gameId: "00000000-0000-4000-8000-000000000000", seed: 0n, score: 40, moves: turns });
}

/** A lowercase UUID, K's game id. */
export function newArcadeGameId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID().toLowerCase();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The REST API's word on a stamp, keeping "no answer" apart from "not accepted" (K
 *  ArcadeTransactionCheck, audit 2026-11-24 #9): 404 is "notAccepted"; 200 with is_accepted true is
 *  "accepted"; anything else (no answer, in a block but not accepted yet, something odd) is
 *  "unanswered". */
export function arcadeCheckFromRest(httpStatus, json) {
  if (httpStatus === 404) return "notAccepted";
  if (httpStatus === 200 && json && typeof json === "object" && json.is_accepted === true) return "accepted";
  return "unanswered";
}
export const isTxId = (txId) => typeof txId === "string" && /^[0-9a-fA-F]{64}$/.test(txId);

/** After the send, the REST API is asked every 2 s for a minute and a half (K landed). */
export const ARCADE_STAMP_CHECKS = 45;
export const ARCADE_STAMP_CHECK_GAP_MS = 2_000;
const ARCADE_SEND_RETRIES = 5;
const ARCADE_SEND_RETRY_MS = 1_200;
export const ARCADE_NOT_CONFIRMED_NOTE = "Sent, but Kaspa hasn't confirmed it yet.";
export const ARCADE_OTHER_ACCOUNT_NOTE = "This game was played on another account. Sign in to it to stamp the score.";
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One finished game being stamped (K ArcadeStampJob): goes on even if the screen closes; only
 * another account stops it. `state`: "sending" | "stamped" | "failed" | "unconfirmed" | "notSent"
 * (a score of 0: nothing is sent), `note` the line under it. "stamped" as soon as the node takes it
 * (owner, 2026-11-24); the REST API check after that only adds or takes back the board record.
 *
 * `share` is Share to KaPost from the game-over sheet (audit 2026-11-24 #8): "none" | "posting" |
 * "shared" | "unconfirmed" | "failed"; posting, shared and unconfirmed keep Share off, so one score
 * is never posted twice.
 *
 * Hooks: `send(content)` resolves the txid (rejects on failure); `lookUp(txId)` resolves an
 * arcadeCheckFromRest answer; `currentAddress()` the account on now; `progress` the record store
 * (ArcadeProgress); `onChange()` repaint.
 */
export class ArcadeStampJob {
  constructor({ game, score, seed, moves, playerAddress, currentAddress = () => playerAddress, send, lookUp = async () => "unanswered", progress = null, onChange = () => {}, log = () => {}, sleep = defaultSleep, now = () => Date.now(), id = newArcadeGameId(), shouldSend = true }) {
    this.id = id;
    this.game = game;
    this.score = Number(score) || 0;
    this.seed = seed;
    this.moves = String(moves ?? "");
    this.playerAddress = playerAddress || null;
    this.currentAddress = currentAddress;
    this.sendContent = send;
    this.lookUp = lookUp;
    this.progress = progress;
    this.onChange = onChange;
    this.log = log;
    this.sleep = sleep;
    this.now = now;
    this.state = "sending";
    this.note = null;
    this.share = "none";
    this.shareNote = null;
    this.txId = null;
    /** Resolves once the send and its check are over (tests wait on it). */
    this.done = Promise.resolve();
    if (shouldSend && this.score > 0) this.done = this.send();
    else this.state = "notSent";
  }

  get content() {
    return arcadeStampContent({ game: this.game, gameId: this.id, seed: this.seed, score: this.score, moves: this.moves });
  }

  changed() { try { this.onChange(this); } catch { /* repaint only */ } }

  set(state, note = null) {
    this.state = state;
    this.note = note;
    this.changed();
  }

  retry() {
    if (this.state !== "failed") return;
    this.done = this.send();
  }

  onOtherAccount() {
    return !this.playerAddress || !sameAddress(this.currentAddress(), this.playerAddress);
  }

  async send() {
    if (this.onOtherAccount()) { this.set("failed", ARCADE_OTHER_ACCOUNT_NOTE); return; }
    this.set("sending");
    const sender = this.playerAddress;
    const content = this.content;
    let attempt = 0;
    for (;;) {
      if (this.onOtherAccount()) { this.set("failed", ARCADE_OTHER_ACCOUNT_NOTE); return; }
      let txId;
      try {
        txId = await this.sendContent(content);
      } catch (error) {
        if (sendOutcomeUnknownTxid(error) !== null) {
          // a node may hold it: no Retry, which could stamp twice
          this.set("unconfirmed", error?.message || SEND_OUTCOME_UNKNOWN_NOTE);
          return;
        }
        attempt += 1;
        if (attempt > ARCADE_SEND_RETRIES || !isRetryableSendError(error)) {
          this.log(`Arcade stamp failed: ${error?.message || String(error)}`);
          this.set("failed", friendlySendErrorMessage(error));
          return;
        }
        await this.sleep(ARCADE_SEND_RETRY_MS);
        continue;
      }
      if (!txId) { this.set("failed", "The score was not sent."); return; }
      this.txId = String(txId);
      // The node took it into its mempool, and Kaspa puts that in a block within a second or so:
      // "stamped" now. The check below still runs, and takes the record back if the chain says no.
      this.set("stamped");
      const record = { game: this.game, score: this.score, at: this.now(), gameId: this.id, txId: this.txId };
      this.progress?.add(record, sender);
      // Only a definite "not accepted" takes the record back; no answer keeps it and checks again
      // later (ArcadeProgress.recheck), since until the boards are served it is the player's only
      // row (audit 2026-11-24 #9).
      this.progress?.markUnconfirmed(record, sender);
      const answer = await this.landed(this.txId);
      if (answer === "accepted") {
        this.progress?.confirm(this.id, sender);
      } else if (answer === "notAccepted") {
        // off the board, but still checked: a slow REST API can say 404 for a while
        this.set("unconfirmed", ARCADE_NOT_CONFIRMED_NOTE);
        this.progress?.takeBack(this.id, sender);
      } else {
        this.set("unconfirmed", ARCADE_NOT_CONFIRMED_NOTE);
      }
      return;
    }
  }

  /** "accepted" as soon as the REST API shows it; else its last answer after the window. */
  async landed(txId) {
    let last = "unanswered";
    for (let check = 0; check < ARCADE_STAMP_CHECKS; check += 1) {
      await this.sleep(ARCADE_STAMP_CHECK_GAP_MS);
      try { last = await this.lookUp(txId); } catch { last = "unanswered"; }
      if (last === "accepted") return "accepted";
    }
    return last;
  }

  /** Share to KaPost may be tapped (K shareEnabled). */
  get shareEnabled() {
    if (["posting", "shared", "unconfirmed"].includes(this.share)) return false;
    return this.state === "stamped" || this.state === "failed";
  }

  /** The game-over button's title (K shareTitle): the share's state first, then the stamp's. */
  get shareTitle() {
    if (this.share === "posting") return "Posting to KaPost…";
    if (this.share === "shared") return "Shared to KaPost";
    if (this.share === "unconfirmed") return "Not confirmed";
    return this.state === "failed" ? "Retry the Stamp" : "Share to KaPost";
  }

  /** Post was clicked in the quick composer. */
  sharePosting() { this.share = "posting"; this.shareNote = null; this.changed(); }

  /** How the post went: `{ ok: true }`, `{ unknown: true }` (it may have gone out: counted as
   *  shared, unconfirmed - no second Share), or `{ error }` (it definitely didn't: Share on again). */
  shareResult(result) {
    if (result?.ok) { this.share = "shared"; this.shareNote = null; }
    else if (result?.unknown) { this.share = "unconfirmed"; this.shareNote = SEND_OUTCOME_UNKNOWN_NOTE; }
    else { this.share = "failed"; this.shareNote = friendlySendErrorMessage(result?.error) || "The post didn't go out."; }
    this.changed();
  }
}

// --- Your own scores (K ArcadeProgress) ----------------------------------------------------------

/** A stamp still not accepted this long after it was sent is gone: its record goes. */
export const ARCADE_NOT_ACCEPTED_AFTER_MS = 10 * 60 * 1000;
/** Unconfirmed stamps are looked up again at most this often. */
export const ARCADE_RECHECK_MS = 60_000;
const RECORDS_PER_GAME = 50;

function cleanRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  const game = arcadeGame(raw.game)?.id;
  const score = Number(raw.score);
  const at = Number(raw.at);
  const gameId = typeof raw.gameId === "string" ? raw.gameId.slice(0, 64) : "";
  if (!game || !Number.isSafeInteger(score) || score < 0 || !Number.isFinite(at) || !gameId) return null;
  return { game, score, at, gameId, txId: isTxId(raw.txId) ? raw.txId.toLowerCase() : null };
}
/** A stored record list, each record checked. */
export function parseArcadeRecords(raw) {
  try {
    const list = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(list) ? list.map(cleanRecord).filter(Boolean) : [];
  } catch { return []; }
}
/** The list with `record` in, the best 50 per game kept. */
export function addArcadeRecord(list, record) {
  const all = [...list.filter((r) => r.gameId !== record.gameId), record];
  const kept = [];
  for (const game of ["snake", "2048"]) {
    kept.push(...all.filter((r) => r.game === game).sort((a, b) => b.score - a.score).slice(0, RECORDS_PER_GAME));
  }
  return kept;
}
/** The best record in `game` since `since` (ms): the highest score, the earlier on a tie. */
export function bestArcadeRecord(list, game, since = 0) {
  let best = null;
  for (const r of list) {
    if (r.game !== game || r.at < since) continue;
    if (!best || r.score > best.score || (r.score === best.score && r.at < best.at)) best = r;
  }
  return best;
}
export function withoutArcadeRecord(list, gameId) {
  return list.filter((r) => r.gameId !== gameId);
}
/** Sent, its acceptance not known yet: the newest 50 are kept. */
export function markArcadeUnconfirmed(list, record) {
  if (!record.txId) return list;
  return [...list.filter((r) => r.gameId !== record.gameId), record].slice(-RECORDS_PER_GAME);
}

/**
 * One unconfirmed stamp looked up again (K recheckUnconfirmed): accepted ones stop being checked
 * (and come back on the board if an earlier 404 took them off); ones the REST API says aren't
 * accepted more than ARCADE_NOT_ACCEPTED_AFTER_MS after their send are removed for good; no answer
 * leaves them for next time. Returns `{ records, unconfirmed, verdict }`.
 */
export function applyArcadeRecheck({ records, unconfirmed, record, answer, nowMs }) {
  if (answer === "accepted") {
    const back = records.some((r) => r.gameId === record.gameId) ? records : addArcadeRecord(records, record);
    return { records: back, unconfirmed: withoutArcadeRecord(unconfirmed, record.gameId), verdict: "confirm" };
  }
  if (answer === "notAccepted" && nowMs - record.at > ARCADE_NOT_ACCEPTED_AFTER_MS) {
    return { records: withoutArcadeRecord(records, record.gameId), unconfirmed: withoutArcadeRecord(unconfirmed, record.gameId), verdict: "remove" };
  }
  return { records, unconfirmed, verdict: "keep" };
}

/**
 * The account's stamped scores on this device (K ArcadeProgress), so its own best shows on the
 * board at once. `storage` is a localStorage-like object; `keyFor(name, address)` scopes a key to
 * an account; `lookUp(txId)` resolves an arcadeCheckFromRest answer.
 */
export class ArcadeProgress {
  constructor({ storage, keyFor = (name, address) => `${name}:${String(address).toLowerCase()}`, lookUp = async () => "unanswered", currentAddress = () => "", now = () => Date.now(), onChange = () => {}, log = () => {} }) {
    Object.assign(this, { storage, keyFor, lookUp, currentAddress, now, onChange, log });
    this.rechecking = false;
    this.lastRecheck = 0;
  }

  read(name, address) {
    try { return parseArcadeRecords(this.storage?.getItem(this.keyFor(name, address))); } catch { return []; }
  }
  write(name, address, list) {
    try {
      if (list.length) this.storage?.setItem(this.keyFor(name, address), JSON.stringify(list));
      else this.storage?.removeItem(this.keyFor(name, address));
    } catch { /* storage blocked: this session's board only */ }
  }
  records(address) { return this.read("kachat-arcade-records-v1", address); }
  unconfirmed(address) { return this.read("kachat-arcade-unconfirmed-v1", address); }
  setRecords(address, list) { this.write("kachat-arcade-records-v1", address, list); }
  setUnconfirmed(address, list) { this.write("kachat-arcade-unconfirmed-v1", address, list); }

  add(record, address) { this.setRecords(address, addArcadeRecord(this.records(address), record)); this.changed(); }
  /** The REST API said it isn't accepted: off the board, still checked. */
  takeBack(gameId, address) { this.setRecords(address, withoutArcadeRecord(this.records(address), gameId)); this.changed(); }
  markUnconfirmed(record, address) { this.setUnconfirmed(address, markArcadeUnconfirmed(this.unconfirmed(address), record)); }
  confirm(gameId, address) {
    const list = this.unconfirmed(address);
    const kept = withoutArcadeRecord(list, gameId);
    if (kept.length !== list.length) this.setUnconfirmed(address, kept);
  }
  /** Account removal. */
  removeAll(address) { this.setRecords(address, []); this.setUnconfirmed(address, []); this.changed(); }

  /** The signed-in account's best stamped score in `game` since `since` (ms). */
  best(game, since = 0) {
    const address = this.currentAddress();
    return address ? bestArcadeRecord(this.records(address), game, since) : null;
  }

  changed() { try { this.onChange(); } catch { /* repaint only */ } }

  /** Looks the signed-in account's unconfirmed stamps up again, at most once a minute (audit
   *  2026-11-24 #9). Resolves once done (tests wait on it). */
  async recheck({ force = false } = {}) {
    const address = this.currentAddress();
    if (this.rechecking || !address) return;
    if (!force && this.lastRecheck && this.now() - this.lastRecheck < ARCADE_RECHECK_MS) return;
    const pending = this.unconfirmed(address);
    if (!pending.length) return;
    this.rechecking = true;
    this.lastRecheck = this.now();
    try {
      for (const record of pending) {
        if (!record.txId) continue;
        let answer;
        try { answer = await this.lookUp(record.txId); } catch { answer = "unanswered"; }
        const next = applyArcadeRecheck({ records: this.records(address), unconfirmed: this.unconfirmed(address), record, answer, nowMs: this.now() });
        if (next.verdict === "keep") continue;
        if (next.verdict === "remove") this.log(`Arcade stamp ${record.txId} never accepted: its score is taken back`);
        this.setRecords(address, next.records);
        this.setUnconfirmed(address, next.unconfirmed);
        this.changed();
      }
    } finally { this.rechecking = false; }
  }
}

// --- Leaderboards (ARCADE.md §5) -----------------------------------------------------------------

/** The most rows a board keeps, and the most bytes an answer may be (audit 2026-11-24 #22). */
export const ARCADE_BOARD_LIMIT = 100;
export const ARCADE_BOARD_MAX_BYTES = 512 * 1024;
const ARCADE_BOARD_MIN_MS = 20_000;

/** One row per address, its best kept (highest score, the earlier stamp on a tie), valid
 *  addresses and scores only, at most ARCADE_BOARD_LIMIT (audit 2026-11-24 #22). */
export function arcadeBoardRows(players) {
  const list = (Array.isArray(players) ? players : [])
    .filter((p) => p && isAddress(p.address) && Number.isSafeInteger(Number(p.score)) && Number(p.score) >= 0)
    .map((p) => ({ address: p.address, score: Number(p.score), at: Number.isFinite(Number(p.at)) ? Number(p.at) : 0 }))
    .sort((a, b) => b.score - a.score || a.at - b.at);
  const seen = new Set();
  const rows = [];
  for (const row of list) {
    const key = row.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
    if (rows.length === ARCADE_BOARD_LIMIT) break;
  }
  return rows;
}

/**
 * What one `/arcade/leaderboard` answer means (K ArcadeLeaderboardService.refresh): `answered`
 * says the server spoke (a 404 is "not served yet", an answer of no scores; audit 2026-11-24 #19);
 * `rows` is the board when there is one to show, else null (what is there stays).
 */
export function arcadeBoardAnswer({ status, json, game, period }) {
  if (status === 404) return { answered: true, notServed: true, rows: null };
  if (!(status >= 200 && status <= 299) || !json || typeof json !== "object") return { answered: false, rows: null };
  if (json.game !== game || json.period !== period || !Array.isArray(json.players)) return { answered: false, rows: null };
  return { answered: true, rows: arcadeBoardRows(json.players) };
}

/** The board with your own stamped best merged in (K rows(_:period:)): your row is yours or the
 *  server's, whichever is higher; highest first, the earlier stamp on a tie. */
export function mergeOwnArcadeBest(rows, { address, best }) {
  let list = [...(rows || [])];
  if (address && best) {
    const own = { address, score: best.score, at: best.at };
    const index = list.findIndex((r) => sameAddress(r.address, address));
    if (index >= 0) { if (best.score > list[index].score) list[index] = own; } else list.push(own);
  }
  list = list.sort((a, b) => b.score - a.score || a.at - b.at || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return list.slice(0, ARCADE_BOARD_LIMIT);
}

/** A response's text, refused past `limit` bytes (audit 2026-11-24 #22): a declared length past it
 *  is not read at all, and a body that runs past it is cut off and refused. */
export async function readCappedText(response, limit = ARCADE_BOARD_MAX_BYTES) {
  const declared = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    try { await response.body?.cancel?.(); } catch { /* gone */ }
    throw new Error("Response too large");
  }
  const reader = response?.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > limit) throw new Error("Response too large");
    return text;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try { await reader.cancel(); } catch { /* gone */ }
      throw new Error("Response too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

/**
 * The boards (K ArcadeLeaderboardService): per game and period from the indexer, with the
 * player's own stamped best merged in. A failure leaves what is there; `unreachable(game)` is per
 * game (audit 2026-11-24 #19) and true only when neither period got any answer, a 404 included as
 * an answer. `fetch` and `base()` (the indexer's URL, "" for none) are passed in.
 */
export class ArcadeBoards {
  constructor({ fetch: fetchImpl, base = () => "", progress = null, currentAddress = () => "", now = () => Date.now(), onChange = () => {} }) {
    Object.assign(this, { fetchImpl, base, progress, currentAddress, now, onChange });
    this.boards = new Map();      // "game|period" -> rows
    this.unreachableGames = new Set();
    this.notServedGames = new Set();
    this.lastFetch = new Map();   // game -> ms
  }

  unreachable(game) { return this.unreachableGames.has(game); }
  notServed(game) { return this.notServedGames.has(game); }

  /** At most every 20 s per game unless forced. Resolves once both periods are in. */
  async refresh(game, { force = false } = {}) {
    this.progress?.recheck?.().catch?.(() => {});
    const last = this.lastFetch.get(game);
    if (!force && last != null && this.now() - last < ARCADE_BOARD_MIN_MS) return;
    const base = String(this.base() || "").trim().replace(/\/+$/, "");
    if (!base || typeof this.fetchImpl !== "function") return;
    this.lastFetch.set(game, this.now());
    let answered = false;
    let notServed = false;
    for (const period of ARCADE_PERIODS) {
      let status = 0;
      let json = null;
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = setTimeout(() => controller?.abort(), 15_000);
      try {
        const url = `${base}/arcade/leaderboard?game=${encodeURIComponent(game)}&period=${encodeURIComponent(period)}&limit=${ARCADE_BOARD_LIMIT}`;
        const response = await this.fetchImpl(url, { headers: { Accept: "application/json" }, cache: "no-store", signal: controller?.signal });
        status = response.status;
        if (status >= 200 && status <= 299) json = JSON.parse(await readCappedText(response));
      } catch { json = null; if (status >= 200 && status <= 299) status = 0; }
      finally { clearTimeout(timer); }
      const answer = arcadeBoardAnswer({ status, json, game, period });
      if (answer.answered) answered = true;
      if (answer.notServed) notServed = true;
      if (answer.rows) this.boards.set(`${game}|${period}`, answer.rows);
    }
    if (answered) this.unreachableGames.delete(game); else this.unreachableGames.add(game);
    if (notServed) this.notServedGames.add(game); else if (answered) this.notServedGames.delete(game);
    try { this.onChange(); } catch { /* repaint only */ }
  }

  /** Highest score first, the earlier stamp on a tie, your own best merged in. */
  rows(game, period) {
    const since = periodSinceMs(period, this.now());
    return mergeOwnArcadeBest(this.boards.get(`${game}|${period}`) || [], { address: this.currentAddress(), best: this.progress?.best?.(game, since) || null });
  }
}

// --- Challenges (ARCADE.md §6) -------------------------------------------------------------------

export const ARCADE_CHALLENGE_SCHEME = "kachatarcade";
const SCORE_MAX = 10_000_000;

/** A value as K's URLQueryItem writes it: the same bytes, so a link is one link on every app. */
function queryValue(value) {
  return encodeURIComponent(String(value)).replace(/%(?:2B|2F|3F|3A|40|24|2C|3B)/g, (hex) => decodeURIComponent(hex));
}
function buildArcadeUrl(game, items) {
  const query = items.filter(([, value]) => value != null).map(([name, value]) => `${name}=${queryValue(value)}`).join("&");
  return `${ARCADE_CHALLENGE_SCHEME}://${game}${query ? `?${query}` : ""}`;
}
/** The items of a query, as URLComponents.queryItems reads them. */
function queryItems(query) {
  if (!query) return [];
  const items = [];
  for (const part of query.split("&")) {
    const at = part.indexOf("=");
    const name = at < 0 ? part : part.slice(0, at);
    let value = at < 0 ? null : part.slice(at + 1);
    try { value = value == null ? null : decodeURIComponent(value); } catch { value = null; }
    items.push([name, value]);
  }
  return items;
}

/** `kachatarcade://<game>?score=<n>&by=<address>&game=<game id>` (K ArcadeChallenge.url). */
export function arcadeChallengeUrl({ game, score, by, gameId }) {
  return buildArcadeUrl(game, [["score", score], ["by", by], ["game", gameId]]);
}

/**
 * A challenge link as `{ game, score, by, gameId, url }`, or null (K ArcadeChallenge(url:)). Links
 * come from other people's posts: only the game has to be right; a bad score, address or game id
 * is dropped, and `url` is rebuilt from what passed (audit: "rebuild from checked fields only").
 */
export function parseArcadeChallengeLink(raw) {
  const match = String(raw ?? "").trim().match(/^kachatarcade:\/\/([^/?#\s]+)(?:\/[^?#]*)?(?:\?([^#]*))?(?:#.*)?$/i);
  if (!match) return null;
  const game = arcadeGame(match[1])?.id;
  if (!game || match[1].toLowerCase() !== game) return null;
  const items = queryItems(match[2]);
  const value = (name) => items.find(([key]) => key === name)?.[1] ?? null;
  const rawScore = value("score");
  const score = rawScore != null && /^\d{1,8}$/.test(rawScore) && Number(rawScore) <= SCORE_MAX ? Number(rawScore) : null;
  const rawBy = value("by");
  const by = isAddress(rawBy) ? rawBy : null;
  const rawGameId = value("game");
  const gameId = rawGameId != null && /^[A-Za-z0-9-]{1,64}$/.test(rawGameId) ? rawGameId : null;
  return { game, score, by, gameId, url: buildArcadeUrl(game, [["score", score], ["by", by], ["game", gameId]]) };
}

/** "Beat 1,240 in Snake", or "Challenge: play Snake" without a score (K ArcadeChallenge.title). */
export function arcadeChallengeTitle(challenge) {
  const title = arcadeGame(challenge?.game)?.title || "";
  return challenge?.score == null ? `Challenge: play ${title}` : `Beat ${formatArcadeScore(challenge.score)} in ${title}`;
}

/** The first valid challenge in a post's text (K ArcadeChallenge.match), as `{ challenge, raw,
 *  bodyText }` - `bodyText` is the post without the link, which the card under it stands for - or
 *  null. Trailing prose punctuation is not part of the link. */
export function arcadeChallengeIn(text) {
  const value = String(text ?? "");
  if (!/kachatarcade:\/\//i.test(value)) return null;
  for (const match of value.matchAll(/kachatarcade:\/\/[^\s<>"']+/gi)) {
    const raw = match[0].replace(/[.,;:!?)\]}'"]+$/, "");
    const challenge = parseArcadeChallengeLink(raw);
    if (challenge) return { challenge, raw, bodyText: value.split(raw).join("").trim() };
  }
  return null;
}

/** Who the game names as the challenger: `by` only when it is the post's signer (`author`); a
 *  link from anywhere else names no one (audit 2026-11-24 #21). */
export function arcadeConfirmedBy(challenge, author) {
  return challenge?.by && author && sameAddress(challenge.by, author) ? challenge.by : null;
}

/** The banner over the game's home (K challengeText): "<who> scored 1,240 in Snake. Can you beat
 *  it?", "Someone scored ..." when the challenger isn't confirmed, nothing without a score. `who`
 *  is the display name of the confirmed challenger. */
export function arcadeChallengeBannerText({ challenge, who = null }) {
  if (challenge?.score == null) return null;
  const title = arcadeGame(challenge.game)?.title || "";
  return `${who || "Someone"} scored ${formatArcadeScore(challenge.score)} in ${title}. Can you beat it?`;
}

/** The post Share to KaPost writes (K ArcadeLinkRouter.shareText): the boast and the link. */
export function arcadeSharePostText({ game, score, by, gameId }) {
  const title = arcadeGame(game)?.title || "";
  return `I scored ${formatArcadeScore(score)} in ${title} on K. Think you can beat it?\n\n${arcadeChallengeUrl({ game, score, by, gameId })}`;
}

/** Desktop opened from a challenge: `?challenge=<the link>` (the form a web page can be reached
 *  by, as engine/chess-bot-links.js's botChallengeFromLaunchSearch). */
export function arcadeChallengeFromLaunchSearch(search) {
  try { return parseArcadeChallengeLink(new URLSearchParams(search).get("challenge")); } catch { return null; }
}

/** A challenge never pops a game (audit 2026-11-24 #11, K GamesView.takeArcadeChallenge): it
 *  waits while an arcade round is up, a bot game's board is up, or - with Chess open - an online
 *  game or seat is on. */
export function arcadeChallengeMayOpen({ arcadeRoundOpen = false, botGameOn = false, chessOpen = false, busyOnline = false } = {}) {
  return !arcadeRoundOpen && !botGameOn && !(chessOpen && busyOnline);
}
