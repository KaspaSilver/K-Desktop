// The Explorer (K 961fc05a, Views/Explorer/ExplorerViews.swift + ExplorerChartView.swift): K's own
// block explorer, a dock screen of its own ("explorer"), which replaced KaChat Stats. Search as you
// type, the network live, the newest blocks and transactions, and a page for every transaction,
// block and address, from kaspa.stream's REST API (api.kaspa.stream; api-tn10.kaspa.stream on
// testnet-10). New blocks come live from K's own node (engine.addBlockScanClient: the node's
// block-added stream), and only while the Explorer's home is on screen in a visible tab; the block
// graph on the live card stops with it. K Activity is K's indexer's `/stats` (and the richer
// `/stats/activity` when served); network fees are Kaspalytics'. Explorer strings are English (K:
// "until the owner settles the design").
//
// Desktop differences, deliberate: nothing here is made up. K shows demo numbers where a source
// doesn't answer (the K Activity card before the indexer answers, the fee tile and fee chart
// without Kaspalytics); here the card says the indexer isn't serving them, the tile reads "–" and
// the chart offers Try Again. Kaspalytics sends no CORS headers, so it is read through the site's
// own /nc-proxy relay (engine/endpoints.js) where there is one.

import "./explorer.css";
import { cycleButtonHtml, cycleBarHtml, cycleChanged } from "./cycle-button.js";
import { blockDagAnimation } from "./send-kaspa-components.js";
import { kusdtCoinIconHtml, kaspaCoinIconHtml } from "./kusdt-icons.js";
import { alertDialog, infoSheet } from "./dialogs.js";
import kLogoUrl from "./assets/k-logo.png";
import kaspaLogoUrl from "./assets/kaspa-logo.png";
import { NETWORK_ID, KAS_UNIT, isValidKaspaAddress } from "../engine/network.js";
import { isProxyAvailable, proxiedUrl } from "../engine/endpoints.js";
import { fetchKasPriceHistory } from "../engine/prices.js";
import { parseChainPayload } from "../engine/kaposts.js";
import { formatKusdt, kusdtDollars } from "../engine/kusdt.js";
import {
  explorerApiBase, TX_KINDS, isKKind, classifyTransaction, readFully, transactionFromIndexed, blockFromNode,
  flexNumber, sompiFromKas, isNotAccepted, isInMempool, movedAmount, netFor, addressHistory, addressSummary,
  FIRST_ADDRESS_PAGE, LATER_ADDRESS_PAGE, nextPageCursor, queryKind, grouped, twoLines, shortId, ago,
  hashrateText, difficultyText, rewardText, compactUsd, compactKas, kasAmount, usdText, daysUntil, percentText,
  amountLine, perspectiveAmount, PERIODS, periodTitle, blockRewardSeries, marketCapSeries, hashrateRequests,
  hashratePoints, pricePoints, priceDays, METRICS, metricPeriods, metricFormat, metricAxisLabel, chartSummary,
  chartChange, nearestPoint, KASPALYTICS_FEES, kaspalyticsPoints, feeSeries, K_ACTIVITY_PERIODS,
  activityFromStats, activityFromRich, RICH_PERIOD_NAMES, K_PERIOD_TEXT, HASHRATE_UNITS, dailyKasEstimate,
  typedNumber, groupTyped,
} from "../engine/explorer.js";

const API_TIMEOUT_MS = 15_000;
/** The biggest page K asks for (40 transactions with their inputs) is well under this. */
const MAX_ANSWER_BYTES = 12 * 1024 * 1024;
/** The newest blocks the list keeps, and at most this many wait for the next flush (the newest). */
const KEPT_BLOCKS = 15;
const PENDING_CAP = 30;
const KEPT_TRANSACTIONS = 300;
const SEARCH_HINT = "Search for an address, a transaction or block ID, or a .kachat username.";
const UNREACHABLE = "kaspa.stream can't be reached right now.";

let deps = null;
let screenEl = null;
let homeEl = null;
let pageEl = null;
/** The Explorer's screen is the one showing. */
let active = false;

// ---------------------------------------------------------------------------------------------
// Glyphs (stroke, currentColor; SF Symbols K uses)
// ---------------------------------------------------------------------------------------------

const svg = (body, extra = "") => `<svg class="kx-i" viewBox="0 0 24 24" aria-hidden="true"${extra}>${body}</svg>`;
const ICONS = {
  arrows: svg('<path d="M4 8h15M15 4l4 4-4 4"/><path d="M20 16H5M9 12l-4 4 4 4"/>'),
  lock: svg('<rect x="5" y="10.5" width="14" height="10" rx="2.2" fill="currentColor" stroke="none"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>'),
  wave: svg('<path d="M7.5 12.5V6.8a1.4 1.4 0 0 1 2.8 0V11"/><path d="M10.3 11V5.2a1.4 1.4 0 0 1 2.8 0V11"/><path d="M13.1 11V6.2a1.4 1.4 0 0 1 2.8 0V12"/><path d="M15.9 12V9a1.4 1.4 0 0 1 2.8 0v4.5a7 7 0 0 1-7 7h-.6a6 6 0 0 1-4.9-2.6l-2.6-3.8a1.4 1.4 0 0 1 2.3-1.6l1.2 1.6"/>'),
  bell: svg('<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15Z" fill="currentColor" stroke="none"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
  post: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M8 9h8M8 12.5h8M8 16h5"/>'),
  hash: svg('<path d="M9.5 4 7.5 20M16.5 4l-2 16M4.5 9h15M3.8 15h15"/>'),
  at: svg('<circle cx="12" cy="12" r="3.6"/><path d="M15.6 12v1.4a2.6 2.6 0 0 0 5.2 0V12a8.8 8.8 0 1 0-3.4 6.9"/>'),
  dollar: svg('<path d="M15.8 8.2c-.5-1.4-1.9-2.2-3.8-2.2-2.2 0-3.8 1.1-3.8 2.8 0 3.9 7.8 2 7.8 6 0 1.8-1.7 3-4 3-1.9 0-3.5-.9-4-2.4M12 3.8V6M12 17.8V20"/>'),
  swap: svg('<path d="M5 9a7 7 0 0 1 12.5-3.2L19.5 8"/><path d="M19.8 3.8V8h-4.3"/><path d="M19 15a7 7 0 0 1-12.5 3.2L4.5 16"/><path d="M4.2 20.2V16h4.3"/>'),
  board: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.3h18M3 14.7h18M9 4v16M15 4v16"/>'),
  controller: svg('<path d="M7 7h10a5 5 0 0 1 4.8 6.4l-1 3.4a2.4 2.4 0 0 1-4.2.8L15 15.5H9l-1.6 2.1a2.4 2.4 0 0 1-4.2-.8l-1-3.4A5 5 0 0 1 7 7Z"/><path d="M8 10v3M6.5 11.5h3M15.5 11h.01M17.5 12.5h.01"/>'),
  hammer: svg('<path d="M13.5 6.5 17 3l4 4-3.5 3.5"/><path d="M15.5 8.5 5 19a1.4 1.4 0 0 1-2-2L13.5 6.5"/><path d="M13.5 6.5 11 4l2-1.5 4.5 4.5"/>'),
  cube: svg('<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>'),
  bolt: svg('<path d="M13 2.5 5 13.5h6l-1 8 8-11h-6Z" fill="currentColor" stroke="none"/>'),
  tray: svg('<path d="M3 13.5 5.5 5h13l2.5 8.5V19a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5.5Z"/><path d="M3 13.5h5l1 2.5h6l1-2.5h5"/>'),
  gauge: svg('<path d="M4.2 17.5a9 9 0 1 1 15.6 0"/><path d="m12 13.5-3.5-4"/><circle cx="12" cy="13.5" r="1.3" fill="currentColor"/>'),
  chart: svg('<path d="M5 20V12M10 20V6M15 20v-9M20 20V4"/>'),
  hexgrid: svg('<circle cx="8" cy="8" r="2.6"/><circle cx="16" cy="8" r="2.6"/><circle cx="12" cy="15" r="2.6"/><circle cx="4" cy="15" r="2.6"/><circle cx="20" cy="15" r="2.6"/>'),
  search: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>'),
  clear: svg('<circle cx="12" cy="12" r="9.5" fill="currentColor" stroke="none"/><path d="m9 9 6 6M15 9l-6 6" style="stroke:var(--bg,#000)"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/><path d="M3.5 5.5v3.5H7"/>'),
  chevron: svg('<path d="m9 5 7 7-7 7"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
  qr: svg('<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/>'),
  info: svg('<circle cx="12" cy="12" r="9.5" fill="currentColor" stroke="none"/><path d="M12 11v6M12 7.6h.01" style="stroke:var(--on-accent,#fff)"/>'),
  xseal: svg('<path d="M12 2.8 14.4 4.6l3-.1.9 2.9 2.4 1.8-1 2.8 1 2.8-2.4 1.8-.9 2.9-3-.1L12 21.2l-2.4-1.8-3 .1-.9-2.9-2.4-1.8 1-2.8-1-2.8 2.4-1.8.9-2.9 3 .1Z"/><path d="m9.5 9.5 5 5M14.5 9.5l-5 5"/>'),
  check: svg('<path d="M12 2.8 14.4 4.6l3-.1.9 2.9 2.4 1.8-1 2.8 1 2.8-2.4 1.8-.9 2.9-3-.1L12 21.2l-2.4-1.8-3 .1-.9-2.9-2.4-1.8 1-2.8-1-2.8 2.4-1.8.9-2.9 3 .1Z"/><path d="m8.5 12.2 2.4 2.4 4.6-4.8"/>'),
  hourglass: svg('<path d="M7 3h10M7 21h10M8 3v3.5a4 4 0 0 0 1.6 3.2L12 11.5l2.4-1.8A4 4 0 0 0 16 6.5V3M8 21v-3.5a4 4 0 0 1 1.6-3.2l2.4-1.8 2.4 1.8a4 4 0 0 1 1.6 3.2V21"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  merge: svg('<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7c0 5 6 5 6 10M18 7c0 5-6 5-6 10"/>'),
  down: svg('<path d="M17 7 7 17M7 9v8h8"/>'),
  up: svg('<path d="M7 17 17 7M9 7h8v8"/>'),
  question: svg('<path d="M9.6 9.4a2.5 2.5 0 0 1 4.85.85c0 1.7-2.45 2.2-2.45 3.75"/><path d="M12 17.2h.01"/>'),
  magnifierBang: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5M10.5 7.5v3.6M10.5 13.6h.01"/>'),
  wifiBang: svg('<path d="M2.5 9a14 14 0 0 1 15-2.6M5.5 12.5a9.5 9.5 0 0 1 9-2M8.6 15.8a5 5 0 0 1 4.5-1.2"/><path d="M19.5 10v5M19.5 18.5h.01"/>'),
  back: svg('<path d="m15 5-7 7 7 7"/>'),
};
const kaspaLogoImg = (size) => `<img class="kx-kaspa-logo" src="${kaspaLogoUrl}" alt="" width="${size}" height="${size}">`;

const esc = (v) => (deps?.escapeHtml ? deps.escapeHtml(String(v ?? "")) : String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
const kindOf = (kind) => TX_KINDS[kind] || TX_KINDS.other;

// ---------------------------------------------------------------------------------------------
// kaspa.stream (K ExplorerAPI)
// ---------------------------------------------------------------------------------------------

class ExplorerFailure extends Error {
  constructor(code, status = 0) {
    super(code === "notFound" ? "Not found on the network."
      : code === "server" ? `kaspa.stream answered with an error (${status}).`
      : code === "badAnswer" ? "kaspa.stream sent something K couldn't read."
      : UNREACHABLE);
    this.code = code;
    this.status = status;
  }
}

const apiBase = () => explorerApiBase(NETWORK_ID);

/** One kaspa.stream answer: `{ json, headers }`. Nothing kept between lookups (no cookies). */
async function apiRequest(path, query = {}) {
  const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
  const url = `${apiBase()}${path}${params.toString() ? `?${params}` : ""}`;
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" }, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    throw new ExplorerFailure("unreachable");
  }
  if (response.status === 404) throw new ExplorerFailure("notFound", 404);
  if (!response.ok) throw new ExplorerFailure("server", response.status);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ANSWER_BYTES) throw new ExplorerFailure("badAnswer");
  let text;
  try { text = await response.text(); } catch { throw new ExplorerFailure("unreachable"); }
  if (text.length > MAX_ANSWER_BYTES) throw new ExplorerFailure("badAnswer");
  try { return { json: JSON.parse(text), headers: response.headers }; } catch { throw new ExplorerFailure("badAnswer"); }
}
const apiGet = async (path, query) => (await apiRequest(path, query)).json;

/** The virtual chain's blue score for confirmations, asked again when it's over ten seconds old. */
async function currentBlueScore() {
  if (live.blueScore && Date.now() - live.blueScoreAt < 10_000) return live.blueScore;
  try {
    const fresh = flexNumber((await apiGet("/info/virtual-chain-blue-score"))?.blueScore);
    if (fresh) { live.blueScore = Math.max(live.blueScore || 0, fresh); live.blueScoreAt = Date.now(); }
  } catch { /* the last one known */ }
  return live.blueScore;
}

async function fetchTransaction(id) {
  // seconds old: kaspa.stream hasn't indexed it yet, but the node already sent it
  try {
    const raw = await apiGet(`/transactions/${id}`, { inputs: true, outputs: true, resolve_previous_outpoints: "light" });
    const blue = await currentBlueScore();
    return transactionFromIndexed(raw, { virtualBlueScore: blue, network: NETWORK_ID, full: true, parsePost: parseChainPayload });
  } catch (error) {
    if (error?.code !== "notFound") throw error;
    const seen = liveTransaction(id);
    if (seen) return readFully(seen, { network: NETWORK_ID, parsePost: parseChainPayload });
    throw error;
  }
}

async function fetchBlock(hash) {
  try {
    return blockFromNode(await apiGet(`/blocks/${hash}`, { includeTransactions: true }), { network: NETWORK_ID });
  } catch (error) {
    if (error?.code !== "notFound") throw error;
    const seen = live.latestBlocks.find((b) => b.id === hash);
    if (seen) return seen;
    throw error;
  }
}

/** One page of an address's history, newest first, and where the next page starts. */
async function fetchAddressPage(address, before, limit = LATER_ADDRESS_PAGE) {
  const { json, headers } = await apiRequest(`/addresses/${address}/full-transactions-page`, {
    limit, resolve_previous_outpoints: "light", before: before ?? undefined,
  });
  if (!Array.isArray(json)) throw new ExplorerFailure("badAnswer");
  const blue = await currentBlueScore();
  const txs = json.map((raw) => transactionFromIndexed(raw, { virtualBlueScore: blue, network: NETWORK_ID }));
  return { transactions: txs, next: nextPageCursor(json.length, limit, headers.get("x-next-page-before")) };
}

async function fetchAddress(address) {
  const [balance, count, page, kusdt, name] = await Promise.all([
    apiGet(`/addresses/${address}/balance`),
    apiGet(`/addresses/${address}/transactions-count`).catch(() => null),
    fetchAddressPage(address, null, FIRST_ADDRESS_PAGE),
    Promise.resolve().then(() => deps.kusdtUnits?.(address)).catch(() => null),
    Promise.resolve().then(() => deps.nameFor?.(address)).catch(() => null),
  ]);
  return {
    address,
    username: name || null,
    balance: flexNumber(balance?.balance),
    kusdtUnits: kusdt == null ? null : BigInt(kusdt),
    transactionCount: Number.isFinite(Number(count?.total)) ? Number(count.total) : null,
    transactions: page.transactions,
    nextPageBefore: page.next,
    ...addressSummary(page.transactions, address, { nextPageBefore: page.next }),
  };
}

/** What a 64-character id is, with light calls; the node's copy when kaspa.stream hasn't indexed it
 *  yet. Throws when kaspa.stream couldn't be asked and nothing was found, so "not found" means not
 *  found. -> { type: "transaction", kind } | { type: "block" } | { type: "notFound" } */
async function identify(id) {
  let unreachable = null;
  try {
    const tx = await apiGet(`/transactions/${id}`, { inputs: false, outputs: true });
    const covenants = (tx?.outputs || []).map((o) => o?.covenant_id).filter(Boolean);
    return { type: "transaction", kind: classifyTransaction({ payloadHex: tx?.payload, subnetwork: tx?.subnetwork_id, covenants, network: NETWORK_ID }).kind };
  } catch (error) { if (error?.code !== "notFound") unreachable = error; }
  const seenTx = liveTransaction(id);
  if (seenTx) return { type: "transaction", kind: seenTx.kind };
  try {
    await apiRequest(`/blocks/${id}`, { includeTransactions: false });
    return { type: "block" };
  } catch (error) { if (error?.code !== "notFound") unreachable = unreachable || error; }
  if (live.latestBlocks.some((b) => b.id === id)) return { type: "block" };
  if (unreachable) throw unreachable;
  return { type: "notFound" };
}

/** What a submitted search finds (K ExplorerAPI.search): a route or null. */
async function search(raw) {
  const text = String(raw || "").trim();
  const lower = text.toLowerCase();
  if (lower.startsWith("kaspa:") || lower.startsWith("kaspatest:")) {
    return isValidKaspaAddress(lower) ? { type: "address", id: lower } : null;
  }
  if (lower.length === 64 && /^[0-9a-f]+$/.test(lower)) {
    let found = null;
    try { found = await identify(lower); } catch { found = null; }
    if (found?.type === "transaction") return { type: "tx", id: lower };
    if (found?.type === "block") return { type: "block", id: lower };
    return null;
  }
  try {
    const resolved = await deps.resolveName?.(text);
    if (resolved?.address) return { type: "address", id: resolved.address };
  } catch { /* not found */ }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Live network (K ExplorerLive): blocks from K's node, numbers from kaspa.stream
// ---------------------------------------------------------------------------------------------

const live = {
  stats: null,
  latestBlocks: [],
  latestTransactions: [],
  failed: false,
  pending: [],
  daaAnchor: null,
  blocksPerSecond: 10,
  rateStart: null,
  blueScore: null,
  blueScoreAt: 0,
  difficulty: 0,
  slow: null,
  slowAt: 0,
  restAt: 0,
  mempool: 0,
  loop: null,
  tick: 0,
  refreshing: null,
  removeBlockClient: null,
  dag: null,
};

function liveTransaction(id) {
  return live.latestTransactions.find((tx) => tx.id === id)
    || live.latestBlocks.flatMap((b) => b.transactions).find((tx) => tx.id === id) || null;
}

/** The home is up and the browser tab is showing: the only time the feed runs. */
function running() {
  return active && routes.length === 0 && (typeof document === "undefined" || document.visibilityState !== "hidden");
}

function updateLive() {
  if (running()) startLive(); else stopLive();
}

function startLive() {
  if (live.loop) return;
  // K's node, block by block (client "explorer"): subscribed while the home shows, dropped after
  try { live.removeBlockClient = deps.addBlockClient?.(receiveBlock) || null; } catch { live.removeBlockClient = null; }
  live.tick = 0;
  live.loop = setInterval(liveTick, 1000);
  liveTick();
  try { live.dag?.start(); } catch { /* no canvas */ }
  screenEl?.classList.add("kx-running");
}

function stopLive() {
  if (!live.loop) return;
  clearInterval(live.loop);
  live.loop = null;
  live.rateStart = null;
  live.pending = [];
  const remove = live.removeBlockClient;
  live.removeBlockClient = null;
  try { remove?.(); } catch { /* engine gone */ }
  try { live.dag?.stop(); } catch { /* no canvas */ }
  screenEl?.classList.remove("kx-running");
}

function liveTick() {
  flush();
  // in its own promise, so a slow kaspa.stream never holds up the once-a-second flush
  if (live.tick % 10 === 0 && !live.refreshing) {
    live.refreshing = refreshNetwork().catch(() => {}).finally(() => { live.refreshing = null; });
  }
  live.tick += 1;
  paintHomeClock();
}

/** A block from the node's stream: buffered, reaching the screen once a second. */
function receiveBlock(block) {
  if (!live.loop) return;
  live.pending.push(block);
  if (live.pending.length <= PENDING_CAP) return;
  live.pending.sort((a, b) => flexNumber(b?.header?.daaScore) - flexNumber(a?.header?.daaScore));
  live.pending.length = PENDING_CAP;
}

/** The DAA score now, run on from the newest block at the measured rate. */
function liveDaaScore(now = Date.now()) {
  const anchor = live.daaAnchor;
  if (!anchor) return 0;
  return anchor.score + Math.floor(Math.max(0, Math.min((now - anchor.at) / 1000, 5)) * live.blocksPerSecond);
}

function flush() {
  if (!live.pending.length) { publishStats(); return; }
  const fresh = live.pending;
  live.pending = [];
  const now = Date.now();
  const daa = (raw) => flexNumber(raw?.header?.daaScore);
  const newest = fresh.reduce((best, raw) => (daa(raw) > daa(best) ? raw : best), fresh[0]);
  const newestScore = daa(newest);
  if (newestScore >= (live.daaAnchor?.score || 0)) {
    live.daaAnchor = { score: newestScore, at: now };
    const start = live.rateStart;
    if (start && newestScore > start.score && now - start.at >= 10_000) {
      live.blocksPerSecond = (newestScore - start.score) / ((now - start.at) / 1000);
      live.rateStart = { score: newestScore, at: now };
    } else if (!start) {
      live.rateStart = { score: newestScore, at: now };
    }
    const blue = flexNumber(newest?.header?.blueScore);
    if (blue >= (live.blueScore || 0)) { live.blueScore = blue; live.blueScoreAt = now; }
    live.difficulty = Number(newest?.verboseData?.difficulty) || live.difficulty;
  }
  const seen = new Set(live.latestBlocks.map((b) => b.id));
  // below the 15th block shown: it would fall off the list at once
  const lowestShown = live.latestBlocks.length >= KEPT_BLOCKS ? live.latestBlocks[live.latestBlocks.length - 1].daaScore : 0;
  const kept = fresh
    .filter((raw) => daa(raw) >= lowestShown)
    .sort((a, b) => daa(b) - daa(a))
    .map((raw) => { try { return blockFromNode(raw, { network: NETWORK_ID, addressOf: deps.addressOfOutput }); } catch { return null; } })
    .filter((b) => b?.id && !seen.has(b.id) && seen.add(b.id))
    .slice(0, KEPT_BLOCKS);
  if (kept.length) {
    live.latestBlocks = [...kept, ...live.latestBlocks].sort((a, b) => b.daaScore - a.daaScore).slice(0, KEPT_BLOCKS);
    mergeTransactions(kept.flatMap((b) => b.transactions).filter((tx) => tx.kind !== "coinbase"));
  }
  publishStats();
  if (kept.length) paintHome();
}

function mergeTransactions(fresh) {
  if (!fresh.length) return;
  const seen = new Set(live.latestTransactions.map((tx) => tx.id));
  const merged = [...live.latestTransactions];
  for (const tx of fresh) if (!seen.has(tx.id)) { seen.add(tx.id); merged.push(tx); }
  merged.sort((a, b) => b.time - a.time);
  live.latestTransactions = merged.slice(0, KEPT_TRANSACTIONS);
}

/** kaspa.stream's numbers (the scores every 10 s while no block has come, the rest every minute),
 *  K Activity and the fees, and the node's mempool. */
async function refreshNetwork() {
  const now = Date.now();
  if (!live.latestBlocks.length || now - live.restAt > 60_000) {
    const [dag, blue] = await Promise.all([
      apiGet("/info/blockdag").catch(() => null),
      apiGet("/info/virtual-chain-blue-score").catch(() => null),
    ]);
    const score = flexNumber(dag?.virtualDaaScore);
    if (score > (live.daaAnchor?.score || 0)) {
      live.daaAnchor = { score, at: Date.now() };
      live.difficulty = Number(dag?.difficulty) || live.difficulty;
    }
    const blueScore = flexNumber(blue?.blueScore);
    if (blueScore) { live.blueScore = Math.max(live.blueScore || 0, blueScore); live.blueScoreAt = Date.now(); }
    live.restAt = now;
  }
  if (!live.slow || now - live.slowAt > 60_000) await refreshSlow();
  await refreshKStats();
  try {
    const size = await deps.nodeMempoolSize?.();
    if (Number.isFinite(Number(size))) live.mempool = Number(size);
  } catch { /* keep the last one */ }
  live.failed = !live.slow;
  publishStats();
  paintHome();
}

async function refreshSlow() {
  const [hashrate, reward, halving, supply, price, fees] = await Promise.all([
    apiGet("/info/hashrate", { stringOnly: false }).catch(() => null),
    apiGet("/info/blockreward", { stringOnly: false }).catch(() => null),
    apiGet("/info/halving").catch(() => null),
    apiGet("/info/coinsupply").catch(() => null),
    apiGet("/info/price", { stringOnly: false }).catch(() => null),
    apiGet("/info/fee-estimate").catch(() => null),
  ]);
  if (!hashrate || !reward || !supply || !price) return;
  const kasOf = (text) => { try { return Number(BigInt(String(text ?? "0"))) / 1e8; } catch { return 0; } };
  live.slow = {
    hashrate: (Number(hashrate.hashrate) || 0) * 1e12, // TH/s
    rewardKas: Number(reward.blockreward) || 0,
    nextDrop: Number(halving?.nextHalvingTimestamp) ? Number(halving.nextHalvingTimestamp) * 1000 : Date.now(),
    circulatingKas: kasOf(supply.circulatingSupply),
    maxKas: kasOf(supply.maxSupply),
    price: Number(price.price) || 0,
    feerate: Number(fees?.normalBuckets?.[0]?.feerate) || 0,
    priority: Number(fees?.priorityBucket?.feerate) || 0,
  };
  live.slowAt = Date.now();
}

/** Pages opened while the home's feed isn't running still want the price and the supply. */
async function ensureStats() {
  if (live.slow) return;
  await refreshSlow().catch(() => {});
  if (!live.daaAnchor) {
    const dag = await apiGet("/info/blockdag").catch(() => null);
    const score = flexNumber(dag?.virtualDaaScore);
    if (score) live.daaAnchor = { score, at: Date.now() };
  }
  publishStats();
}

function publishStats() {
  const slow = live.slow;
  const anchor = live.daaAnchor;
  if (!slow || !anchor) return;
  live.stats = {
    daaScore: anchor.score,
    blueScore: live.blueScore || 0,
    blocksPerSecond: live.blocksPerSecond,
    hashrate: slow.hashrate,
    mempoolSize: live.mempool,
    normalFeerate: slow.feerate,
    priorityFeerate: slow.priority,
    circulatingKas: slow.circulatingKas,
    maxKas: slow.maxKas,
    priceUSD: slow.price,
    blockRewardSompi: sompiFromKas(slow.rewardKas),
    rewardKas: slow.rewardKas,
    nextRewardDrop: slow.nextDrop,
  };
}

const priceUsd = () => live.stats?.priceUSD || live.slow?.price || 0;
const usdOf = (sompi) => usdText((Number(sompi) || 0) / 1e8 * priceUsd());

// ---------------------------------------------------------------------------------------------
// K's own numbers (K ExplorerKStats): K Activity from K's indexer, network fees from Kaspalytics
// ---------------------------------------------------------------------------------------------

const kStats = {
  activity: {},
  periods: [...K_ACTIVITY_PERIODS],
  served: false,
  /** The first indexer read has finished (the card says "not serving" only after it). */
  attempted: false,
  fetchedAt: 0,
  richUnavailable: false,
  richRetryAt: 0,
  dailyFees: [],
  lastDayAverageFee: null,
  kaspalyticsAt: 0,
};

function indexerBase() {
  let url = String(deps?.indexerBase?.() || "").trim();
  while (url.endsWith("/")) url = url.slice(0, -1);
  return url || null;
}

/** `{ value, status }`: the answer, or null with the HTTP status when there was one. */
async function fetchJson(url, maxBytes = 2 * 1024 * 1024) {
  let response;
  try { response = await fetch(url, { headers: { Accept: "application/json" }, credentials: "omit", signal: AbortSignal.timeout(API_TIMEOUT_MS) }); }
  catch { return { value: null, status: null }; }
  if (!response.ok) return { value: null, status: response.status };
  try {
    const text = await response.text();
    if (text.length > maxBytes) return { value: null, status: response.status };
    return { value: JSON.parse(text), status: response.status };
  } catch { return { value: null, status: response.status }; }
}

/** At most once a minute (Kaspalytics at most once an hour, mainnet only). */
async function refreshKStats({ force = false } = {}) {
  if (!force && Date.now() - kStats.fetchedAt < 60_000) return;
  kStats.fetchedAt = Date.now();
  if (NETWORK_ID === "mainnet" && Date.now() - kStats.kaspalyticsAt > 3_600_000) await loadKaspalytics();
  const base = indexerBase();
  try { if (base) await loadActivity(base); } finally { kStats.attempted = true; }
}

/** Kaspalytics sends no CORS headers: read through the site's own relay where there is one. */
async function kaspalyticsJson(url) {
  let target = url;
  try { if (await isProxyAvailable()) target = proxiedUrl(url); } catch { /* direct */ }
  return (await fetchJson(target, 4 * 1024 * 1024)).value;
}

async function loadKaspalytics() {
  const total = await kaspalyticsJson(`${KASPALYTICS_FEES}/total`);
  const points = kaspalyticsPoints(total, "Fees");
  if (!points.length) return;
  kStats.dailyFees = points;
  const average = kaspalyticsPoints(await kaspalyticsJson(`${KASPALYTICS_FEES}/average`), "Fee");
  if (average.length) kStats.lastDayAverageFee = sompiFromKas(average[average.length - 1].value);
  kStats.kaspalyticsAt = Date.now();
}

async function loadActivity(base) {
  if (!kStats.richUnavailable && Date.now() >= kStats.richRetryAt) {
    const rich = {};
    let notServed = false;
    for (const period of K_ACTIVITY_PERIODS) {
      const answer = await fetchJson(`${base}/stats/activity?period=${RICH_PERIOD_NAMES[period]}`);
      const window = answer.value ? activityFromRich(period, answer.value) : null;
      if (!window) { notServed = answer.status === 404; break; }
      rich[period] = window;
    }
    if (Object.keys(rich).length === K_ACTIVITY_PERIODS.length) {
      kStats.activity = rich;
      kStats.periods = [...K_ACTIVITY_PERIODS];
      kStats.served = true;
      return;
    }
    // not served (yet): /stats; asked again next session after a 404, else in an hour
    if (notServed) kStats.richUnavailable = true; else kStats.richRetryAt = Date.now() + 3_600_000;
  }
  const stats = (await fetchJson(`${base}/stats`)).value;
  const parsed = activityFromStats(stats);
  if (!parsed) return;
  kStats.activity = parsed.activity;
  kStats.periods = parsed.periods;
  kStats.served = true;
}

// ---------------------------------------------------------------------------------------------
// The home (K ExplorerView)
// ---------------------------------------------------------------------------------------------

const home = {
  page: "blocks",
  kPeriod: "day",
  query: "",
  focused: false,
  searching: false,
  typed: { type: "none" },
  typedToken: 0,
  typedTimer: null,
  recent: [],
};
const HOME_PAGES = [["blocks", "Blocks"], ["transactions", "Transactions"], ["kActivity", "K Activity"]];

function homeSkeletonHtml() {
  return `
    <div class="kaposts-header kx-header"><h1 class="kaposts-title">Explorer</h1></div>
    <label class="kx-search">
      <span class="kx-search-icon">${ICONS.search}</span>
      <input type="search" data-kx-search placeholder="Search Kaspa" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="search" aria-label="Search Kaspa">
      <span class="kx-search-trailing" data-kx-search-trailing></span>
    </label>
    <p class="kx-unreachable" data-kx-unreachable hidden>${ICONS.wifiBang}<span>${UNREACHABLE}</span></p>
    <div class="kx-results" data-kx-results hidden></div>
    <div class="kx-main" data-kx-main>
      <div class="kx-live" data-kx-live>
        <canvas class="kx-live-dag" data-kx-dag aria-hidden="true"></canvas>
        <div class="kx-live-shade" aria-hidden="true"></div>
        <div class="kx-live-row">
          <div class="kx-live-left">
            <span class="kx-live-badge"><span class="kx-live-dot" data-kx-live-dot></span>Live</span>
            <strong class="kx-live-daa" data-kx-daa>–</strong>
            <span class="kx-live-caption">DAA Score</span>
          </div>
          <div class="kx-live-right">
            <strong class="kx-live-bps" data-kx-bps>–</strong>
            <span class="kx-live-caption">blocks / second</span>
          </div>
        </div>
      </div>
      <div class="kx-tiles" data-kx-tiles></div>
      <div data-kx-supply></div>
      <div data-kx-kactivity></div>
      <div data-kx-pagebar></div>
      <div data-kx-list></div>
      <p class="kx-credit">Live blocks from K's node · data from kaspa.stream</p>
    </div>`;
}

/** Writes `html` into `el` only when it changed: a repaint every second mustn't blink or steal hovers. */
function setHtml(el, html) {
  if (!el || el.__kxHtml === html) return;
  el.__kxHtml = html;
  el.innerHTML = html;
}

function paintHome() {
  if (!homeEl || !active || routes.length) return;
  const stats = live.stats;
  const unreachable = homeEl.querySelector("[data-kx-unreachable]");
  if (unreachable) unreachable.hidden = !live.failed;
  const bps = homeEl.querySelector("[data-kx-bps]");
  if (bps) bps.textContent = stats ? stats.blocksPerSecond.toFixed(1) : "–";
  setHtml(homeEl.querySelector("[data-kx-tiles]"), tilesHtml(stats));
  setHtml(homeEl.querySelector("[data-kx-supply]"), supplyHtml(stats));
  setHtml(homeEl.querySelector("[data-kx-kactivity]"), kActivityCardHtml());
  setHtml(homeEl.querySelector("[data-kx-pagebar]"), cycleBarHtml({ name: "kx-home-page", options: HOME_PAGES, value: home.page }));
  setHtml(homeEl.querySelector("[data-kx-list]"), latestListHtml());
  homeEl.querySelector("[data-kx-live]")?.classList.toggle("kx-redacted", !stats);
  paintHomeClock();
}

/** The parts that move every second: the DAA score and the rows' ages. */
function paintHomeClock() {
  if (!homeEl || !active || routes.length) return;
  const daa = homeEl.querySelector("[data-kx-daa]");
  if (daa) daa.textContent = live.stats ? grouped(liveDaaScore()) : "–";
  homeEl.querySelectorAll("[data-kx-ago]").forEach((el) => { el.textContent = ago(Number(el.dataset.kxAgo)); });
}

function tileHtml({ icon, title, value, detail, chart = null }) {
  const iconHtml = icon === "kaspa" ? kaspaLogoImg(22) : `<span class="kx-tile-icon">${ICONS[icon] || ""}</span>`;
  const inner = `
    <span class="kx-tile-head">${iconHtml}<span class="kx-tile-title">${esc(title)}</span>${chart ? `<span class="kx-chev">${ICONS.chevron}</span>` : ""}</span>
    <span class="kx-tile-value">${esc(value)}</span>
    ${detail ? `<span class="kx-tile-detail">${esc(detail)}</span>` : ""}`;
  return chart
    ? `<button type="button" class="kx-tile kx-tile-button" data-kx-open="chart:${chart}">${inner}</button>`
    : `<div class="kx-tile">${inner}</div>`;
}

/** What the Network Fee tile's number is: Kaspalytics' last full day. */
function feeTile() {
  const sompi = kStats.lastDayAverageFee;
  if (sompi == null) return { value: "–", detail: "not available yet" };
  return { value: metricFormat("networkFees", sompi / 1e8, KAS_UNIT), detail: "average, yesterday" };
}

function tilesHtml(stats) {
  const dash = "–";
  const fee = feeTile();
  return [
    tileHtml({ icon: "bolt", title: "Hashrate", value: stats ? hashrateText(stats.hashrate) : dash, detail: "whole network", chart: "hashrate" }),
    tileHtml({ icon: "tray", title: "Mempool", value: stats ? grouped(stats.mempoolSize) : dash, detail: "transactions waiting" }),
    tileHtml({ icon: "gauge", title: "Network Fee", value: fee.value, detail: fee.detail, chart: "networkFees" }),
    tileHtml({ icon: "kaspa", title: "KAS Price", value: stats ? `$${stats.priceUSD.toFixed(4)}` : dash, detail: "US dollars", chart: "price" }),
    tileHtml({ icon: "hammer", title: "Block Reward", value: stats ? rewardText(stats.blockRewardSompi, KAS_UNIT) : dash, detail: stats ? `per block, lower in ${daysUntil(stats.nextRewardDrop)}` : "per block", chart: "blockReward" }),
    tileHtml({ icon: "chart", title: "Market Cap", value: stats ? compactUsd(stats.circulatingKas * stats.priceUSD) : dash, detail: "US dollars", chart: "marketCap" }),
  ].join("");
}

function supplyHtml(stats) {
  const mined = stats && stats.maxKas > 0 ? stats.circulatingKas / stats.maxKas : 0;
  return `
    <div class="kx-card kx-supply${stats ? "" : " kx-redacted"}">
      <div class="kx-supply-head">
        <span class="kx-supply-title"><span class="kx-accent-icon">${ICONS.hexgrid}</span>Circulating Supply</span>
        <span class="kx-muted kx-num">${stats ? `${(mined * 100).toFixed(2)}%` : "–"}</span>
      </div>
      <div class="kx-progress"><span style="width:${(Math.min(1, mined) * 100).toFixed(2)}%"></span></div>
      <div class="kx-supply-foot">
        <span class="kx-num kx-strong">${stats ? esc(compactKas(stats.circulatingKas * 1e8, KAS_UNIT)) : "–"}</span>
        <span class="kx-muted">of ${stats ? esc(compactKas(stats.maxKas * 1e8, KAS_UNIT)) : "–"}</span>
      </div>
    </div>`;
}

function kindBadgeHtml(kind, size = 36) {
  return `<span class="kx-kind" style="--kx-size:${size}px">${ICONS[kindOf(kind).icon] || ICONS.cube}</span>`;
}

/** K Activity (K ExplorerKActivityCard): what K's protocols put on chain in the window the cycle
 *  button picks, against the window before, a bar per hour / day / month, and each kind's count.
 *  Only what the indexer serves; nothing while it serves nothing. */
function kActivityCardHtml() {
  const periods = kStats.periods.length ? kStats.periods : [...K_ACTIVITY_PERIODS];
  const shown = periods.includes(home.kPeriod) ? home.kPeriod : periods[0];
  const activity = kStats.activity[shown] || null;
  const options = periods.map((p) => [p, periodTitle(p)]);
  const head = `
    <div class="kx-kact-head">
      <img class="kx-klogo" src="${kLogoUrl}" alt="" width="22" height="22">
      <strong>K Activity</strong>
      ${cycleButtonHtml({ name: "kx-kperiod", options, value: shown, hint: "Switches the time period" })}
    </div>`;
  if (!activity) {
    return `<div class="kx-card kx-kact">${head}
      <p class="kx-muted kx-small">${kStats.attempted ? "K's indexer isn't serving these numbers right now." : "Loading K's numbers…"}</p></div>`;
  }
  const text = K_PERIOD_TEXT[activity.period] || K_PERIOD_TEXT.day;
  const change = activity.change != null && text.comparison
    ? `<span class="kx-kact-change"><span class="kx-change">${activity.change >= 0 ? ICONS.up : ICONS.down}${esc(percentText(activity.change))}</span><span class="kx-muted kx-small">${esc(text.comparison)}</span></span>`
    : "";
  const bars = Array.isArray(activity.bars) && activity.bars.length ? (() => {
    const peak = Math.max(1, ...activity.bars);
    return `
      <div class="kx-kact-bars${activity.bars.length > 24 ? " dense" : ""}" role="img" aria-label="${esc(text.meaning)}">
        ${activity.bars.map((count, i) => `<span style="height:${Math.max(3, Math.round(44 * count / peak))}px"${i === activity.bars.length - 1 ? ' class="now"' : ""}></span>`).join("")}
      </div>
      <div class="kx-kact-ends kx-muted"><span>${esc(text.start)}</span><span>${esc(text.end)}</span></div>`;
  })() : "";
  const top = Math.max(1, activity.ranked[0]?.count || 1);
  const kinds = activity.ranked.map(({ kind, count }) => `
    <div class="kx-kact-kind">
      ${kindBadgeHtml(kind, 26)}
      <div class="kx-kact-kind-body">
        <div class="kx-kact-kind-line"><span>${esc(kindOf(kind).plural)}</span><strong class="kx-num">${grouped(count)}</strong></div>
        <span class="kx-kact-meter"><span style="width:${Math.max(2, (count / top) * 100).toFixed(1)}%"></span></span>
      </div>
    </div>`).join("");
  return `
    <div class="kx-card kx-kact">
      ${head}
      <div class="kx-kact-totals">
        <span class="kx-kact-total"><strong class="kx-num">${grouped(activity.total)}</strong><span class="kx-muted kx-small">transactions</span></span>
        ${change}
      </div>
      ${bars}
      <div class="kx-divider"></div>
      <div class="kx-kact-kinds">${kinds}</div>
    </div>`;
}

function loadingRowHtml() {
  return `<div class="kx-loading-row"><span class="initial-sync-spinner" aria-hidden="true"></span></div>`;
}

function blockRowHtml(block) {
  const n = block.transactionIds.length;
  return `
    <button type="button" class="kx-row" data-kx-open="block:${esc(block.id)}">
      <span class="kx-cube">${ICONS.cube}</span>
      <span class="kx-row-body"><strong class="kx-num">${grouped(block.blueScore)}</strong><span class="kx-mono">${esc(shortId(block.id))}</span></span>
      <span class="kx-row-end"><span class="kx-row-strong">${n === 1 ? "1 transaction" : `${grouped(n)} transactions`}</span><span class="kx-muted kx-num" data-kx-ago="${block.time}">${esc(ago(block.time))}</span></span>
    </button>`;
}

/** A transaction's row: its kind, id, amount and age; an unaccepted one dimmed, its amount struck
 *  through. `perspective`: an address page's own address, whose net the amount is. */
function txRowHtml(tx, { showsAge = true, perspective = null } = {}) {
  const notAccepted = isNotAccepted(tx);
  const amount = perspective && tx.tokenUnits == null
    ? perspectiveAmount(tx, perspective, KAS_UNIT)
    : amountLine(tx, { short: true, unit: KAS_UNIT, formatKusdt });
  const incoming = perspective ? netFor(tx, perspective).isIncoming : false;
  return `
    <button type="button" class="kx-row${notAccepted ? " kx-not-accepted" : ""}" data-kx-open="tx:${esc(tx.id)}">
      ${kindBadgeHtml(tx.kind, 36)}
      <span class="kx-row-body">
        <span class="kx-row-title"><strong>${esc(kindOf(tx.kind).title)}</strong>${isInMempool(tx) ? '<span class="kx-pill kx-pill-orange">Pending</span>' : ""}</span>
        <span class="kx-row-sub"><span class="kx-mono">${esc(shortId(tx.id))}</span>${notAccepted ? '<span class="kx-pill">Not Accepted</span>' : ""}</span>
      </span>
      <span class="kx-row-end">
        <span class="kx-row-strong kx-num${perspective && incoming && !notAccepted ? " kx-in" : ""}${notAccepted ? " kx-struck" : ""}">${esc(amount)}</span>
        ${showsAge ? `<span class="kx-muted kx-num" data-kx-ago="${tx.time}">${esc(ago(tx.time))}</span>` : ""}
      </span>
    </button>`;
}

function latestListHtml() {
  if (home.page === "blocks") {
    return `<div class="kx-card kx-list">${live.latestBlocks.length ? live.latestBlocks.map(blockRowHtml).join("") : loadingRowHtml()}</div>`;
  }
  const all = live.latestTransactions;
  const txs = (home.page === "kActivity" ? all.filter((tx) => isKKind(tx.kind)) : all).slice(0, 25);
  if (!txs.length) {
    const note = home.page === "kActivity" && all.length
      ? '<p class="kx-muted kx-small kx-pad">No K transactions in the newest blocks yet. They show here as they land.</p>'
      : loadingRowHtml();
    return `<div class="kx-card kx-list">${note}</div>`;
  }
  return `<div class="kx-card kx-list">${txs.map((tx) => txRowHtml(tx)).join("")}</div>`;
}

// --- Search -----------------------------------------------------------------------------------

function paintSearch() {
  if (!homeEl) return;
  const trailing = homeEl.querySelector("[data-kx-search-trailing]");
  setHtml(trailing, home.searching
    ? '<span class="initial-sync-spinner" aria-hidden="true"></span>'
    : home.query
      ? `<button type="button" class="kx-icon-button kx-clear" data-kx-clear aria-label="Clear">${ICONS.clear}</button>`
      : '<button type="button" class="kx-link-button" data-kx-paste>Paste</button>');
  const results = homeEl.querySelector("[data-kx-results]");
  const main = homeEl.querySelector("[data-kx-main]");
  const typed = home.query.trim();
  let html = "";
  if (typed) html = liveResultsHtml(typed);
  else if (home.focused) html = suggestionsHtml();
  if (results) { results.hidden = !html; setHtml(results, html); }
  if (main) main.hidden = Boolean(typed) || home.focused;
}

function suggestionsHtml() {
  const own = deps.ownAddress?.() || "";
  const recent = home.recent.length ? `
    <div class="kx-section-head"><span class="kx-section-title">Recent</span><button type="button" class="kx-link-button" data-kx-recent-clear>Clear</button></div>
    <div class="kx-card kx-list">${home.recent.map((item, i) => `
      <button type="button" class="kx-row kx-row-compact" data-kx-recent="${i}">
        <span class="kx-muted kx-glyph">${ICONS.clock}</span><span class="kx-mono">${esc(shortId(item))}</span>
      </button>`).join("")}</div>` : "";
  return `
    ${own ? `
      <p class="kx-section-title">Your Account</p>
      <div class="kx-card kx-list">
        <button type="button" class="kx-row" data-kx-open="address:${esc(own)}">
          ${avatarHtml(own, 34)}
          <span class="kx-row-body"><strong>Chatting Address</strong><span class="kx-mono">${esc(shortId(own))}</span></span>
          <span class="kx-chev">${ICONS.chevron}</span>
        </button>
      </div>` : ""}
    ${recent}
    <p class="kx-muted kx-small kx-hint">${SEARCH_HINT}</p>`;
}

function avatarHtml(address, size) {
  let inner = "";
  try { inner = deps.avatarHtml?.(address, "kx-avatar-img") || ""; } catch { inner = ""; }
  return `<span class="kx-avatar" style="--kx-size:${size}px">${inner || '<span class="kx-avatar-img avatar-fallback">K</span>'}</span>`;
}

function liveResultsHtml(text) {
  const m = home.typed;
  const note = (line) => `<p class="kx-muted kx-pad">${esc(line)}</p>`;
  let row;
  switch (m.type) {
    case "username":
      row = matchRowHtml({ address: m.address, title: `@${m.name}`, trailing: null }); break;
    case "address":
      row = matchRowHtml({ address: m.address, title: m.name ? `@${m.name}` : "Address", trailing: m.balance != null ? kasAmount(m.balance, KAS_UNIT) : null }); break;
    case "transaction":
      row = `<button type="button" class="kx-row" data-kx-typed="tx:${esc(m.id)}">${kindBadgeHtml(m.kind, 34)}
        <span class="kx-row-body"><strong>${esc(kindOf(m.kind).title)}</strong><span class="kx-mono">${esc(shortId(m.id))}</span></span>
        <span class="kx-chev">${ICONS.chevron}</span></button>`; break;
    case "block":
      row = `<button type="button" class="kx-row" data-kx-typed="block:${esc(m.id)}"><span class="kx-accent-icon kx-big-glyph">${ICONS.cube}</span>
        <span class="kx-row-body"><strong>Block</strong><span class="kx-mono">${esc(shortId(m.id))}</span></span>
        <span class="kx-chev">${ICONS.chevron}</span></button>`; break;
    case "noUsername": row = note(`No username ${m.name}`); break;
    case "notAnAddress": row = note("That isn't a valid Kaspa address."); break;
    case "notFound": row = note("No transaction or block with that ID."); break;
    case "unreachable": row = note(UNREACHABLE); break;
    default:
      row = `<div class="kx-looking"><span class="initial-sync-spinner" aria-hidden="true"></span><span class="kx-muted">Looking up ${esc(text.length > 40 ? shortId(text) : text)}…</span></div>`;
  }
  return `<div class="kx-card kx-list">${row}</div><p class="kx-muted kx-small kx-hint">${SEARCH_HINT}</p>`;
}

/** A found address: its picture, name (or "Address"), the address, and its balance. */
function matchRowHtml({ address, title, trailing }) {
  return `
    <button type="button" class="kx-row" data-kx-typed="address:${esc(address)}">
      ${avatarHtml(address, 34)}
      <span class="kx-row-body"><strong>${esc(title)}</strong><span class="kx-mono">${esc(shortId(address))}</span></span>
      ${trailing ? `<span class="kx-row-strong kx-muted kx-num">${esc(trailing)}</span>` : ""}
      <span class="kx-chev">${ICONS.chevron}</span>
    </button>`;
}

/** Works out what's typed, a moment after typing stops (K lookUpTyped): an address (checked, with
 *  its .kachat name and balance), a transaction or block id, or a .kachat username. */
function scheduleLookUp() {
  clearTimeout(home.typedTimer);
  const token = ++home.typedToken;
  const text = home.query.trim();
  if (!text) { home.typed = { type: "none" }; paintSearch(); return; }
  home.typed = { type: "lookingUp" };
  paintSearch();
  home.typedTimer = setTimeout(() => { lookUpTyped(text, token).catch(() => {}); }, 350);
}

async function lookUpTyped(text, token) {
  const current = () => token === home.typedToken;
  const { kind, value } = queryKind(text);
  let match;
  if (kind === "address") {
    if (!isValidKaspaAddress(value)) { if (current()) { home.typed = { type: "notAnAddress" }; paintSearch(); } return; }
    let cached = null;
    try { cached = deps.cachedNameFor?.(value) || null; } catch { cached = null; }
    home.typed = { type: "address", address: value, name: cached, balance: null };
    paintSearch();
    const [balance, name] = await Promise.all([
      apiGet(`/addresses/${value}/balance`).catch(() => null),
      Promise.resolve().then(() => deps.nameFor?.(value)).catch(() => null),
    ]);
    match = { type: "address", address: value, name: name || cached, balance: balance ? flexNumber(balance.balance) : null };
  } else if (kind === "id") {
    try {
      const found = await identify(value);
      match = found.type === "transaction" ? { type: "transaction", id: value, kind: found.kind }
        : found.type === "block" ? { type: "block", id: value } : { type: "notFound" };
    } catch { match = { type: "unreachable" }; }
  } else {
    let resolved = null;
    try { resolved = await deps.resolveName?.(text); } catch { resolved = null; }
    match = resolved?.address ? { type: "username", name: resolved.name || text, address: resolved.address } : { type: "noUsername", name: text };
  }
  if (!current()) return;
  home.typed = match;
  paintSearch();
}

function rememberSearch(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return;
  home.recent = [trimmed, ...home.recent.filter((r) => r !== trimmed)].slice(0, 6);
}

function clearSearch({ blur = true } = {}) {
  home.query = "";
  home.typed = { type: "none" };
  home.typedToken += 1;
  clearTimeout(home.typedTimer);
  const input = homeEl?.querySelector("[data-kx-search]");
  if (input) { input.value = ""; if (blur) input.blur(); }
  if (blur) home.focused = false;
  paintSearch();
}

function openTyped(route) {
  rememberSearch(home.query);
  clearSearch();
  openRoute(route);
}

async function runSearch(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed || home.searching) return;
  home.searching = true;
  paintSearch();
  let route = null;
  try { route = await search(trimmed); } finally { home.searching = false; paintSearch(); }
  if (route) {
    rememberSearch(trimmed);
    clearSearch();
    openRoute(route);
  } else {
    alertDialog({ title: "Nothing Found", message: SEARCH_HINT }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// Pages (K ExplorerPage): a stack over the home
// ---------------------------------------------------------------------------------------------

/** `{ type: "tx" | "block" | "address" | "chart", id, value, failure, ...page state }` */
let routes = [];
let homeScrollTop = 0;

function parseRoute(text) {
  const at = String(text || "").indexOf(":");
  if (at < 0) return null;
  const type = text.slice(0, at);
  const id = text.slice(at + 1);
  return ["tx", "block", "address", "chart"].includes(type) && id ? { type, id } : null;
}

function openRoute(route) {
  if (!route) return;
  if (!routes.length) homeScrollTop = screenEl?.scrollTop || 0;
  else routes[routes.length - 1].scrollTop = screenEl?.scrollTop || 0;
  const entry = { ...route, value: null, failure: null, scrollTop: 0 };
  if (route.type === "block") entry.page = "transactions";
  if (route.type === "address") { entry.page = "history"; entry.more = []; entry.nextBefore = undefined; entry.loadingMore = false; }
  if (route.type === "chart") Object.assign(entry, { period: "month", points: [], loading: true, failed: false, feeSource: null, selected: null });
  if (route.type === "tx") entry.showPayload = false;
  routes.push(entry);
  updateLive();
  showPage();
  loadRoute(entry);
}

function back() {
  routes.pop();
  if (!routes.length) {
    pageEl.hidden = true;
    homeEl.hidden = false;
    setHtml(pageEl, "");
    if (screenEl) screenEl.scrollTop = homeScrollTop;
    updateLive();
    paintHome();
    return;
  }
  showPage();
  if (screenEl) screenEl.scrollTop = routes[routes.length - 1].scrollTop || 0;
}

/** Back to the home (the dock's Explorer clicked again, or a new session). */
function backToHome() {
  if (!routes.length) return;
  routes = [];
  back();
}

function showPage() {
  if (!pageEl || !homeEl) return;
  homeEl.hidden = true;
  pageEl.hidden = false;
  renderPage();
  if (screenEl) screenEl.scrollTop = 0;
}

async function loadRoute(entry) {
  entry.failure = null;
  if (entry.type === "chart") { await loadChart(entry); return; }
  try {
    if (entry.type === "tx") entry.value = await fetchTransaction(entry.id);
    else if (entry.type === "block") entry.value = await fetchBlock(entry.id);
    else if (entry.type === "address") [entry.value] = await Promise.all([fetchAddress(entry.id), ensureStats()]);
    if (entry.type === "tx") ensureStats().then(() => { if (routes.at(-1) === entry) renderPage(); }).catch(() => {});
  } catch (error) {
    entry.failure = error?.message || UNREACHABLE;
  }
  if (routes.at(-1) === entry) renderPage();
}

const PAGE_TITLES = { tx: "Transaction", block: "Block", address: "Address" };

function pageHeaderHtml(entry) {
  const title = entry.type === "chart" ? METRICS[entry.id]?.title || "" : PAGE_TITLES[entry.type];
  const backTo = routes.length > 1 ? "Back" : "Explorer";
  const copy = entry.type !== "chart" && entry.value
    ? `<button type="button" class="kx-icon-button" data-kx-copy="${esc(entry.id)}" aria-label="Copy" title="Copy">${ICONS.copy}</button>`
    : '<span class="kx-header-spacer" aria-hidden="true"></span>';
  return `
    <div class="kx-page-header">
      <button type="button" class="kx-back" data-kx-back aria-label="Back">${ICONS.back}<span>${backTo}</span></button>
      <strong class="kx-page-title">${esc(title)}</strong>
      ${copy}
    </div>`;
}

function renderPage() {
  const entry = routes.at(-1);
  if (!entry || !pageEl) return;
  let body;
  if (entry.type === "chart") body = chartPageHtml(entry);
  else if (entry.failure) {
    body = `
      <div class="kx-failure">
        <span class="kx-failure-icon">${ICONS.magnifierBang}</span>
        <p class="kx-muted">${esc(entry.failure)}</p>
        <button type="button" class="primary-button" data-kx-retry>Try Again</button>
      </div>`;
  } else if (!entry.value) body = `<div class="kx-page-loading"><span class="initial-sync-spinner" aria-hidden="true"></span></div>`;
  else if (entry.type === "tx") body = transactionPageHtml(entry);
  else if (entry.type === "block") body = blockPageHtml(entry);
  else body = addressPageHtml(entry);
  pageEl.__kxHtml = null;
  pageEl.innerHTML = `${pageHeaderHtml(entry)}<div class="kx-page-body">${body}</div>`;
  if (entry.type === "chart") wireChart(entry);
}

function detailRowHtml(title, valueHtml, { open = null } = {}) {
  const inner = `<span class="kx-detail-title">${esc(title)}</span><span class="kx-detail-value">${valueHtml}</span>${open ? `<span class="kx-chev">${ICONS.chevron}</span>` : ""}`;
  return open
    ? `<button type="button" class="kx-detail kx-detail-button" data-kx-open="${esc(open)}">${inner}</button>`
    : `<div class="kx-detail">${inner}</div>`;
}

function copyValueHtml(value) {
  return `<button type="button" class="kx-copy-value" data-kx-copy="${esc(value)}" title="Copy"><span class="kx-mono">${esc(shortId(value))}</span>${ICONS.copy}</button>`;
}

const fullTime = (ms) => new Date(ms).toLocaleString("en-US", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });

function statusPillHtml(tx) {
  if (isNotAccepted(tx)) return `<span class="kx-pill kx-pill-lg">${ICONS.xseal}Not Accepted</span>`;
  if (isInMempool(tx)) return `<span class="kx-pill kx-pill-lg kx-pill-orange">${ICONS.hourglass}In the Mempool</span>`;
  // seconds old: in a block, not yet counted by kaspa.stream
  if (!tx.confirmations) return `<span class="kx-pill kx-pill-lg kx-pill-green">${ICONS.check}In a Block</span>`;
  return `<span class="kx-pill kx-pill-lg kx-pill-green">${ICONS.check}Confirmed · ${grouped(tx.confirmations)} confirmations</span>`;
}

// --- Transaction (K ExplorerTransactionView) ---------------------------------------------------

function transactionPageHtml(entry) {
  const tx = entry.value;
  const own = String(deps.ownAddress?.() || "").toLowerCase();
  const moved = movedAmount(tx);
  const whatItIs = `
    <div class="kx-card kx-pad-card kx-what">
      <p class="kx-what-line"><span class="kx-accent-icon">${ICONS.info}</span><span>${esc(kindOf(tx.kind).explanation)}</span></p>
      ${isNotAccepted(tx) ? `<p class="kx-what-line kx-muted"><span class="kx-glyph">${ICONS.xseal}</span><span>${tx.kind === "coinbase"
        ? "Not accepted, so it paid nothing. Every block that merges a found block carries a reward for it; only one of them is accepted."
        : "Not accepted by the network, so it moved nothing."}</span></p>` : ""}
      ${tx.decoded ? `<div class="kx-decoded${tx.kind === "kapost" ? "" : " kx-mono-block"}">${esc(tx.decoded)}</div>` : ""}
    </div>`;
  const details = `
    <div class="kx-card kx-details">
      ${detailRowHtml("Transaction ID", copyValueHtml(tx.id))}
      ${tx.blockHash ? detailRowHtml("Block", `<span class="kx-mono">${esc(shortId(tx.blockHash))}</span>`, { open: `block:${tx.blockHash}` }) : ""}
      ${detailRowHtml("Time", esc(fullTime(tx.time)))}
      ${detailRowHtml("Network Fee", `<span class="kx-num">${esc(tx.fee == null ? "–" : kasAmount(tx.fee, KAS_UNIT))}</span>`)}
      ${detailRowHtml("Mass", `<span class="kx-num">${grouped(tx.mass)}</span>`)}
    </div>`;
  const ioCard = (title, items, marksChange) => `
    <p class="kx-section-title">${esc(title)}</p>
    <div class="kx-card kx-list">${items.map((io) => {
      if (!io.address) {
        // not known (read off the node) or no address (a script): nothing to open
        return `<div class="kx-row kx-row-static"><span class="kx-unknown">${ICONS.question}</span>
          <span class="kx-row-body"><span class="kx-muted">${marksChange ? `Output #${io.index}` : `Input #${io.index}`}</span></span>
          <span class="kx-row-strong kx-num">${esc(marksChange ? kasAmount(io.amount, KAS_UNIT) : "–")}</span></div>`;
      }
      const isYou = io.address.toLowerCase() === own;
      const isChange = marksChange && io.index > 0 && io.address === tx.inputs[0]?.address;
      const tags = [isYou ? '<span class="kx-tag kx-tag-you">You</span>' : "", isChange ? '<span class="kx-tag">Change</span>' : ""].join("");
      return `<button type="button" class="kx-row" data-kx-open="address:${esc(io.address)}">
        ${avatarHtml(io.address, 34)}
        <span class="kx-row-body">${tags ? `<span class="kx-tags">${tags}</span>` : ""}<span class="kx-mono">${esc(shortId(io.address))}</span></span>
        <span class="kx-row-strong kx-num">${esc(kasAmount(io.amount, KAS_UNIT))}</span>
      </button>`;
    }).join("")}</div>`;
  const payload = tx.payloadHex ? `
    <div class="kx-card kx-pad-card">
      <button type="button" class="kx-payload-toggle" data-kx-payload-toggle aria-expanded="${entry.showPayload}">
        <strong>Payload</strong><span class="kx-muted kx-small">${grouped(tx.payloadHex.length / 2)} bytes</span>
        <span class="kx-chev kx-chev-down${entry.showPayload ? " open" : ""}">${ICONS.chevron}</span>
      </button>
      ${entry.showPayload ? `<pre class="kx-payload">${esc(tx.payloadHex)}</pre>
        <button type="button" class="kx-link-button" data-kx-copy="${esc(tx.payloadHex)}">${ICONS.copy}Copy Payload</button>` : ""}
    </div>` : "";
  return `
    <div class="kx-hero">
      ${kindBadgeHtml(tx.kind, 58)}
      <strong class="kx-hero-kind">${esc(kindOf(tx.kind).title)}</strong>
      <span class="kx-hero-amount kx-num">${esc(amountLine(tx, { unit: KAS_UNIT, formatKusdt }))}</span>
      ${tx.tokenUnits == null && moved != null ? `<span class="kx-muted">${esc(usdOf(moved))}</span>` : ""}
      ${statusPillHtml(tx)}
    </div>
    ${whatItIs}
    ${details}
    ${tx.inputs.length ? ioCard("From", tx.inputs, false) : ""}
    ${ioCard("To", tx.outputs, true)}
    ${payload}`;
}

// --- Block (K ExplorerBlockView) -------------------------------------------------------------

function blockPageHtml(entry) {
  const block = entry.value;
  const pages = [
    ["transactions", `Transactions · ${block.transactionIds.length}`],
    ["parents", `Parents · ${block.parents.length}`],
    ["children", `Children · ${block.children.length}`],
  ];
  let list;
  if (entry.page === "transactions") {
    list = `<div class="kx-card kx-list">${block.transactions.map((tx) => txRowHtml(tx, { showsAge: false })).join("") || '<p class="kx-muted kx-pad">No transactions.</p>'}</div>`;
  } else {
    const hashes = entry.page === "parents" ? block.parents : block.children;
    list = hashes.length
      ? `<div class="kx-card kx-list">${hashes.map((hash) => `<button type="button" class="kx-row kx-row-compact" data-kx-open="block:${esc(hash)}"><span class="kx-accent-icon">${ICONS.cube}</span><span class="kx-mono">${esc(shortId(hash))}</span><span class="kx-chev">${ICONS.chevron}</span></button>`).join("")}</div>`
      : `<p class="kx-muted kx-small kx-center">${entry.page === "children" ? "No children yet: newer blocks will point to this one." : "No parents."}</p>`;
  }
  return `
    <div class="kx-hero">
      <span class="kx-cube kx-cube-lg">${ICONS.cube}</span>
      <span class="kx-hero-amount kx-num">${grouped(block.blueScore)}</span>
      <span class="kx-muted">Blue Score</span>
      <span class="kx-pills">
        <span class="kx-pill kx-pill-lg${block.isChainBlock ? " kx-pill-accent" : ""}">${block.isChainBlock ? ICONS.link : ICONS.merge}${block.isChainBlock ? "Chain Block" : "Merged Block"}</span>
        <span class="kx-pill kx-pill-lg">${ICONS.clock}${esc(ago(block.time))}</span>
      </span>
    </div>
    <div class="kx-card kx-details">
      ${detailRowHtml("Block Hash", copyValueHtml(block.id))}
      ${detailRowHtml("DAA Score", `<span class="kx-num">${grouped(block.daaScore)}</span>`)}
      ${detailRowHtml("Time", esc(fullTime(block.time)))}
      ${detailRowHtml("Merge Set", `${block.mergeSetBlues} blue · ${block.mergeSetReds} red`)}
      ${detailRowHtml("Difficulty", `<span class="kx-num">${esc(difficultyText(block.difficulty))}</span>`)}
    </div>
    ${cycleBarHtml({ name: "kx-block-page", options: pages, value: entry.page })}
    <div class="${cycleChanged("page:kx-block", entry.page) ? "cycle-fade" : ""}">${list}</div>`;
}

// --- Address (K ExplorerAddressView) ---------------------------------------------------------

function addressPageHtml(entry) {
  const info = entry.value;
  const isYou = info.address.toLowerCase() === String(deps.ownAddress?.() || "").toLowerCase();
  const history = addressHistory([...info.transactions, ...entry.more]);
  const cursor = entry.nextBefore === undefined ? info.nextPageBefore : entry.nextBefore;
  const units = info.kusdtUnits ?? 0n;
  const summaryDetail = info.summaryCoversMonth ? "last 30 days" : `newest ${info.transactions.length} transactions`;
  let list;
  if (entry.page === "history") {
    list = `
      <div class="kx-card kx-list">${history.length ? history.map((tx) => txRowHtml(tx, { perspective: info.address })).join("") : '<p class="kx-muted kx-small kx-pad">No transactions yet.</p>'}</div>
      <div class="kx-history-foot">
        ${cursor != null ? `<button type="button" class="kx-load-more" data-kx-load-more${entry.loadingMore ? " disabled" : ""}>${entry.loadingMore ? '<span class="initial-sync-spinner" aria-hidden="true"></span>' : "Load More"}</button>` : ""}
        ${info.transactionCount != null ? `<span class="kx-muted kx-small">${grouped(history.length)} of ${grouped(info.transactionCount)} transactions</span>` : ""}
      </div>`;
  } else {
    // Kaspa and kUSDT, always both: kUSDT shows at 0 too (owner, 2026-11-25)
    list = `
      <div class="kx-card kx-list">
        <div class="kx-row kx-row-static">${kaspaCoinIconHtml(36)}<span class="kx-row-body"><strong>Kaspa</strong><span class="kx-muted kx-small">Kaspa's own coin</span></span>
          <span class="kx-row-end"><span class="kx-row-strong kx-num">${esc(kasAmount(info.balance, KAS_UNIT))}</span><span class="kx-muted kx-small kx-num">${esc(usdOf(info.balance))}</span></span></div>
        <div class="kx-row kx-row-static">${kusdtCoinIconHtml(36)}<span class="kx-row-body"><strong>kUSDT</strong><span class="kx-muted kx-small">A dollar token on Kaspa</span></span>
          <span class="kx-row-end"><span class="kx-row-strong kx-num">${esc(formatKusdt(units))}</span><span class="kx-muted kx-small kx-num">${esc(kusdtDollars(units))}</span></span></div>
      </div>`;
  }
  return `
    <div class="kx-hero">
      ${avatarHtml(info.address, 72)}
      ${info.username ? `<strong class="kx-hero-name">@${esc(info.username)}</strong>` : isYou ? '<strong class="kx-hero-name">Your Chatting Address</strong>' : ""}
      <span class="kx-two-lines kx-mono">${esc(twoLines(info.address))}</span>
      <span class="kx-chips">
        <button type="button" class="kx-chip" data-kx-copy="${esc(info.address)}">${ICONS.copy}Copy</button>
        <button type="button" class="kx-chip" data-kx-qr>${ICONS.qr}QR Code</button>
      </span>
    </div>
    <div class="kx-card kx-pad-card kx-balance">
      <span class="kx-caps kx-muted">Balance</span>
      <strong class="kx-balance-amount kx-num">${esc(kasAmount(info.balance, KAS_UNIT))}</strong>
      <span class="kx-muted">${esc(usdOf(info.balance))}</span>
      ${info.kusdtUnits != null ? `<div class="kx-divider"></div><span class="kx-balance-token">${kusdtCoinIconHtml(20)}<strong class="kx-num">${esc(formatKusdt(info.kusdtUnits))}</strong></span>` : ""}
    </div>
    <div class="kx-tiles">
      ${tileHtml({ icon: "down", title: "Received", value: compactKas(info.received30d, KAS_UNIT), detail: summaryDetail })}
      ${tileHtml({ icon: "up", title: "Sent", value: compactKas(info.sent30d, KAS_UNIT), detail: summaryDetail })}
    </div>
    ${cycleBarHtml({ name: "kx-address-page", options: [["history", "History"], ["assets", "Assets"]], value: entry.page })}
    <div class="${cycleChanged("page:kx-address", entry.page) ? "cycle-fade" : ""}">${list}</div>`;
}

async function loadMore(entry) {
  const info = entry.value;
  const cursor = entry.nextBefore === undefined ? info.nextPageBefore : entry.nextBefore;
  if (cursor == null || entry.loadingMore) return;
  entry.loadingMore = true;
  renderPage();
  try {
    const page = await fetchAddressPage(info.address, cursor);
    const known = new Set([...info.transactions, ...entry.more].map((tx) => tx.id));
    entry.more = [...entry.more, ...page.transactions.filter((tx) => !known.has(tx.id))];
    entry.nextBefore = page.next;
  } catch { /* the button stays for another try */ }
  entry.loadingMore = false;
  if (routes.at(-1) === entry) renderPage();
}

function showQr(address) {
  const html = `
    <div class="kx-qr">
      <canvas data-kx-qr-canvas width="220" height="220"></canvas>
      <p class="kx-mono kx-qr-address">${esc(address)}</p>
    </div>`;
  infoSheet({ title: "Address", html }).catch(() => {});
  // the sheet is in the page on the next frame
  requestAnimationFrame(() => {
    const canvas = document.querySelector("[data-kx-qr-canvas]");
    if (canvas) Promise.resolve(deps.drawQr?.(canvas, address)).catch(() => {});
  });
}

// ---------------------------------------------------------------------------------------------
// Charts (K ExplorerChartView): drawn here in SVG
// ---------------------------------------------------------------------------------------------

async function loadChart(entry) {
  const period = entry.period;
  entry.loading = true;
  entry.failed = false;
  if (routes.at(-1) === entry) renderPage();
  let fresh = [];
  try {
    switch (entry.id) {
      case "hashrate": {
        const plan = hashrateRequests(period);
        const answers = await Promise.all(plan.paths.map((path) => apiGet(path).catch((error) => (period === "allTime" ? Promise.reject(error) : []))));
        fresh = hashratePoints(answers.flat(), plan.since);
        ensureStats().then(() => { if (routes.at(-1) === entry) paintMining(entry); }).catch(() => {});
        break;
      }
      case "price":
        fresh = pricePoints(await fetchKasPriceHistory(priceDays(period), { currency: "usd" }));
        break;
      case "marketCap": {
        const [prices] = await Promise.all([fetchKasPriceHistory(priceDays(period), { currency: "usd" }), ensureStats()]);
        fresh = marketCapSeries(pricePoints(prices), live.stats?.circulatingKas || live.slow?.circulatingKas || 0);
        break;
      }
      case "networkFees":
        await refreshKStats({ force: !kStats.dailyFees.length });
        fresh = feeSeries(kStats.dailyFees, period) || [];
        entry.feeSource = fresh.length ? "kaspalytics" : null;
        break;
      case "blockReward":
        fresh = blockRewardSeries(period);
        break;
      default: fresh = [];
    }
  } catch { fresh = []; }
  if (entry.period !== period) return;
  entry.points = fresh;
  entry.loading = false;
  entry.failed = !fresh.length;
  entry.selected = null;
  if (routes.at(-1) === entry) renderPage();
}

const bucketName = (date, period) => {
  const d = new Date(date);
  if (period === "day") return d.toLocaleString("en-US", { weekday: "short", hour: "numeric" });
  if (period === "allTime") return d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric" });
};
const pointDate = (date, period) => new Date(date).toLocaleString("en-US", period === "allTime"
  ? { month: "short", day: "numeric", year: "numeric" }
  : { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const axisDate = (date, period) => {
  const d = new Date(date);
  if (period === "day") return d.toLocaleString("en-US", { hour: "numeric" });
  if (period === "week") return d.toLocaleString("en-US", { weekday: "short" });
  if (period === "month") return d.toLocaleString("en-US", { month: "short", day: "numeric" });
  return String(d.getFullYear());
};

function headline(entry) {
  const metric = METRICS[entry.id] || {};
  const points = entry.points;
  const selected = entry.selected;
  if (!points.length) return { big: "–", sub: "" };
  if (metric.bars) {
    const total = points.reduce((s, p) => s + p.value, 0);
    return {
      big: metricFormat(entry.id, selected ? selected.value : total, KAS_UNIT),
      sub: selected ? esc(bucketName(selected.date, entry.period)) : `Total ${esc(periodTitle(entry.period))}`,
    };
  }
  const shown = selected || points[points.length - 1];
  const change = chartChange(points, shown.value);
  return {
    big: metricFormat(entry.id, shown.value, KAS_UNIT),
    sub: `<span class="kx-change">${change >= 0 ? ICONS.up : ICONS.down}${esc(percentText(change))}</span><span class="kx-muted">${esc(selected ? pointDate(selected.date, entry.period) : periodTitle(entry.period))}</span>`,
  };
}

const CHART_HEIGHT = 260;
const PAD = { left: 6, right: 62, top: 12, bottom: 24 };

/** The geometry a chart is drawn and read with. */
function chartGeometry(entry, width) {
  const metric = METRICS[entry.id] || {};
  const points = entry.points;
  const values = points.map((p) => p.value);
  const high = Math.max(...values);
  const low = Math.min(...values);
  let yMin;
  let yMax;
  if (metric.bars) { yMin = 0; yMax = (high || 1) * 1.08; }
  else {
    const pad = Math.max((high - low) * 0.08, high * 0.0005);
    yMin = Math.max(0, low - pad);
    yMax = high + pad || 1;
  }
  const plotW = Math.max(40, width - PAD.left - PAD.right);
  const plotH = CHART_HEIGHT - PAD.top - PAD.bottom;
  const t0 = points[0].date;
  const t1 = points[points.length - 1].date;
  const xOf = metric.bars
    ? (i) => PAD.left + (i + 0.5) * (plotW / points.length)
    : (date) => PAD.left + (t1 > t0 ? (date - t0) / (t1 - t0) : 0.5) * plotW;
  const yOf = (v) => PAD.top + (1 - (v - yMin) / (yMax - yMin || 1)) * plotH;
  return { metric, points, yMin, yMax, plotW, plotH, t0, t1, xOf, yOf, width };
}

/** A Catmull-Rom curve through the points, as cubic Béziers (K's .catmullRom). */
function smoothPath(xy) {
  if (xy.length < 2) return "";
  let d = `M${xy[0][0].toFixed(1)},${xy[0][1].toFixed(1)}`;
  for (let i = 0; i < xy.length - 1; i += 1) {
    const p0 = xy[i - 1] || xy[i];
    const p1 = xy[i];
    const p2 = xy[i + 1];
    const p3 = xy[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/** Steps that change at each point (K's .stepEnd, the block reward). */
function steppedPath(xy) {
  if (!xy.length) return "";
  let d = `M${xy[0][0].toFixed(1)},${xy[0][1].toFixed(1)}`;
  for (let i = 1; i < xy.length; i += 1) d += `H${xy[i][0].toFixed(1)}V${xy[i][1].toFixed(1)}`;
  return d;
}

function chartSvg(entry, width) {
  const g = chartGeometry(entry, width);
  const ticks = [0, 1, 2, 3].map((i) => g.yMin + (g.yMax - g.yMin) * (i / 3));
  const grid = ticks.map((v) => {
    const y = g.yOf(v).toFixed(1);
    return `<line class="kx-grid" x1="${PAD.left}" x2="${PAD.left + g.plotW}" y1="${y}" y2="${y}"/>`
      + `<text class="kx-axis" x="${PAD.left + g.plotW + 6}" y="${y}" dy="0.35em">${esc(metricAxisLabel(entry.id, v))}</text>`;
  }).join("");
  const xLabels = [0, 0.5, 1].map((f, i) => {
    const date = g.t0 + (g.t1 - g.t0) * f;
    const anchor = i === 0 ? "start" : i === 2 ? "end" : "middle";
    const x = PAD.left + g.plotW * f;
    return `<text class="kx-axis" x="${x.toFixed(1)}" y="${CHART_HEIGHT - 6}" text-anchor="${anchor}">${esc(axisDate(date, entry.period))}</text>`;
  }).join("");
  let marks;
  if (g.metric.bars) {
    const slot = g.plotW / g.points.length;
    const barW = Math.max(1, slot * (g.points.length > 40 ? 0.8 : 0.7));
    marks = g.points.map((p, i) => {
      const x = g.xOf(i) - barW / 2;
      const y = g.yOf(p.value);
      const h = Math.max(0, g.yOf(0) - y);
      return `<rect class="kx-bar" data-kx-bar="${i}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2"/>`;
    }).join("");
  } else {
    const xy = g.points.map((p) => [g.xOf(p.date), g.yOf(p.value)]);
    const line = g.metric.stepped ? steppedPath(xy) : smoothPath(xy);
    const floor = (PAD.top + g.plotH).toFixed(1);
    const area = `${line}L${xy[xy.length - 1][0].toFixed(1)},${floor}L${xy[0][0].toFixed(1)},${floor}Z`;
    marks = `<defs><linearGradient id="kx-area-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" style="stop-color:var(--kaspa);stop-opacity:.35"/><stop offset="1" style="stop-color:var(--kaspa);stop-opacity:.02"/></linearGradient></defs>`
      + `<path class="kx-area" d="${area}" fill="url(#kx-area-fill)"/><path class="kx-line" d="${line}"/>`
      + `<line class="kx-rule" data-kx-rule x1="0" x2="0" y1="${PAD.top}" y2="${floor}" visibility="hidden"/>`
      + `<circle class="kx-dot" data-kx-dot r="5" cx="0" cy="0" visibility="hidden"/>`;
  }
  return `<svg class="kx-chart-svg" data-kx-chart-svg width="${width}" height="${CHART_HEIGHT}" viewBox="0 0 ${width} ${CHART_HEIGHT}" role="img" aria-label="${esc(g.metric.title || "")}">${grid}${marks}${xLabels}</svg>`;
}

function chartPageHtml(entry) {
  const metric = METRICS[entry.id];
  if (!metric) return "";
  const head = headline(entry);
  const periods = metricPeriods(entry.id).map((p) => [p.id, p.title]);
  let plot;
  if (!entry.points.length && entry.loading) plot = `<div class="kx-chart-state"><span class="initial-sync-spinner" aria-hidden="true"></span></div>`;
  else if (!entry.points.length) plot = `<div class="kx-chart-state"><p class="kx-muted">This chart couldn't load.</p><button type="button" class="kx-link-button" data-kx-retry>Try Again</button></div>`;
  else plot = `<div class="kx-chart-plot${entry.loading ? " loading" : ""}" data-kx-chart-plot></div>`;
  const summary = chartSummary(entry.points, { bars: metric.bars });
  const redacted = entry.points.length ? "" : " kx-redacted";
  return `
    <div class="kx-chart-head${redacted}">
      <strong class="kx-chart-big kx-num" data-kx-chart-big>${esc(head.big)}</strong>
      <span class="kx-chart-sub" data-kx-chart-sub>${head.sub}</span>
    </div>
    <div class="kx-card kx-pad-card kx-chart-card">
      ${plot}
      <div class="kx-chart-cycle">${cycleButtonHtml({ name: "kx-chart-period", options: periods, value: entry.period, hint: "Switches the time period" })}</div>
    </div>
    <div class="kx-summary${redacted}">
      ${[["High", summary.high], ["Low", summary.low], ["Average", summary.average]].map(([t, v]) => `
        <div class="kx-summary-tile"><span class="kx-muted kx-small kx-strong">${t}</span><strong class="kx-num">${esc(metricFormat(entry.id, v, KAS_UNIT))}</strong></div>`).join("")}
    </div>
    ${metric.bars ? `<p class="kx-muted kx-small kx-note">${entry.period === "allTime" ? "Per month" : "Per day"}</p>` : ""}
    ${entry.id === "hashrate" ? `<div data-kx-mining>${miningHtml()}</div>` : ""}
    ${entry.id === "networkFees" && entry.feeSource === "kaspalytics" ? '<p class="kx-muted kx-small kx-note">Daily totals for all of Kaspa · Data: Kaspalytics</p>' : ""}
    <p class="kx-muted kx-small kx-note">${esc(metric.explanation)}</p>`;
}

/** Draws the chart at the card's width and lets the pointer read any point (K: drag to read). */
function wireChart(entry) {
  const plot = pageEl.querySelector("[data-kx-chart-plot]");
  if (!plot || !entry.points.length) return;
  const draw = () => {
    const width = Math.max(200, Math.floor(plot.clientWidth || 480));
    if (plot.__kxWidth === width) return;
    plot.__kxWidth = width;
    plot.innerHTML = chartSvg(entry, width);
    attachReader(entry, plot, width);
  };
  draw();
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => { if (!plot.isConnected) { observer.disconnect(); return; } draw(); });
    observer.observe(plot);
  }
}

function attachReader(entry, plot, width) {
  const svgEl = plot.querySelector("[data-kx-chart-svg]");
  if (!svgEl) return;
  const g = chartGeometry(entry, width);
  const big = pageEl.querySelector("[data-kx-chart-big]");
  const sub = pageEl.querySelector("[data-kx-chart-sub]");
  const rule = svgEl.querySelector("[data-kx-rule]");
  const dot = svgEl.querySelector("[data-kx-dot]");
  const paint = () => {
    const head = headline(entry);
    if (big) big.textContent = head.big;
    if (sub) sub.innerHTML = head.sub;
    const sel = entry.selected;
    if (g.metric.bars) {
      svgEl.querySelectorAll("[data-kx-bar]").forEach((bar) => {
        bar.classList.toggle("dim", Boolean(sel) && g.points[Number(bar.dataset.kxBar)] !== sel);
      });
      return;
    }
    const show = sel ? "visible" : "hidden";
    rule?.setAttribute("visibility", show);
    dot?.setAttribute("visibility", show);
    if (sel) {
      const x = g.xOf(sel.date).toFixed(1);
      rule?.setAttribute("x1", x);
      rule?.setAttribute("x2", x);
      dot?.setAttribute("cx", x);
      dot?.setAttribute("cy", g.yOf(sel.value).toFixed(1));
    }
  };
  const pick = (event) => {
    const rect = svgEl.getBoundingClientRect();
    const x = event.clientX - rect.left;
    let next;
    if (g.metric.bars) {
      const i = Math.floor((x - PAD.left) / (g.plotW / g.points.length));
      next = g.points[Math.min(g.points.length - 1, Math.max(0, i))];
    } else {
      const f = Math.min(1, Math.max(0, (x - PAD.left) / g.plotW));
      next = nearestPoint(g.points, g.t0 + (g.t1 - g.t0) * f);
    }
    if (next !== entry.selected) { entry.selected = next; paint(); }
  };
  const clear = () => { if (entry.selected) { entry.selected = null; paint(); } };
  svgEl.addEventListener("pointerdown", (event) => { try { svgEl.setPointerCapture(event.pointerId); } catch { /* fine */ } pick(event); });
  svgEl.addEventListener("pointermove", pick);
  svgEl.addEventListener("pointerup", (event) => { if (event.pointerType !== "mouse") clear(); });
  svgEl.addEventListener("pointercancel", clear);
  svgEl.addEventListener("pointerleave", clear);
}

// --- Mining Estimate (K ExplorerMiningEstimate; moved here from Portfolio's hashrate screen) -----

const mining = { text: "", unit: "th" };

function miningDaily() {
  const amount = typedNumber(mining.text);
  const scale = HASHRATE_UNITS.find((u) => u.key === mining.unit)?.scale ?? 1e12;
  return dailyKasEstimate({ yourHs: amount == null ? null : amount * scale, networkHs: live.stats?.hashrate ?? live.slow?.hashrate, rewardKas: live.stats?.rewardKas ?? live.slow?.rewardKas });
}

function payoutsHtml() {
  const daily = miningDaily();
  if (daily == null) return '<p class="kx-muted kx-small">Enter your hashrate to estimate earnings.</p>';
  const price = priceUsd();
  const row = (title, kas) => `
    <div class="kx-payout"><span class="kx-muted">${title}</span>
      <span class="kx-payout-values"><strong class="kx-num">${esc(new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(kas))} ${esc(KAS_UNIT)}</strong>${price > 0 ? `<span class="kx-muted kx-small kx-num">${esc(usdText(kas * price))}</span>` : ""}</span></div>`;
  const network = live.stats?.hashrate ?? live.slow?.hashrate;
  const reward = live.stats?.rewardKas ?? live.slow?.rewardKas;
  // 30 days, not a calendar month: the reward steps down monthly anyway
  return `
    <div class="kx-payouts">${row("Per day", daily)}${row("Per week", daily * 7)}${row("Per month", daily * 30)}</div>
    <p class="kx-muted kx-small">At ${esc(hashrateText(network))} network hashrate and a ${esc(`${Number(reward).toFixed(4)} ${KAS_UNIT}`)} block reward. Before pool fees, power and luck, and both figures move.</p>`;
}

function miningHtml() {
  return `
    <div class="kx-card kx-pad-card kx-mining">
      <strong>Mining Estimate</strong>
      <div class="kx-mining-entry">
        <input class="field-input kx-mining-input" type="text" inputmode="decimal" placeholder="0" aria-label="Your hashrate" data-kx-mining-input value="${esc(mining.text)}">
        <div class="settings-segmented" role="group" aria-label="Hashrate unit">
          ${HASHRATE_UNITS.map((u) => `<button type="button" class="settings-segmented-option${mining.unit === u.key ? " active" : ""}" data-kx-mining-unit="${u.key}">${u.label}</button>`).join("")}
        </div>
      </div>
      <div data-kx-payouts>${payoutsHtml()}</div>
    </div>`;
}

function paintMining() {
  const block = pageEl?.querySelector("[data-kx-payouts]");
  if (block) block.innerHTML = payoutsHtml();
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

async function copy(value) {
  try {
    if (deps.copyText) await deps.copyText(value);
    else await navigator.clipboard.writeText(String(value));
    deps.showToast?.("Copied");
  } catch (error) {
    deps.showToast?.(error?.message || "Couldn't copy", { style: "error" });
  }
}

function onClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const cycle = target.closest("button.cycle-button[data-cycle]");
  if (cycle) {
    const next = cycle.dataset.cycleNext;
    const entry = routes.at(-1);
    switch (cycle.dataset.cycle) {
      case "kx-home-page": home.page = next; paintHome(); return;
      case "kx-kperiod": home.kPeriod = next; paintHome(); return;
      case "kx-block-page": if (entry) { entry.page = next; renderPage(); } return;
      case "kx-address-page": if (entry) { entry.page = next; renderPage(); } return;
      case "kx-chart-period": if (entry) { entry.period = next; entry.selected = null; loadChart(entry); } return;
      default: return;
    }
  }
  const typed = target.closest("[data-kx-typed]");
  if (typed) { openTyped(parseRoute(typed.dataset.kxTyped)); return; }
  const open = target.closest("[data-kx-open]");
  if (open) {
    // a suggestion row opens without leaving the search half-typed
    if (open.closest("[data-kx-results]")) clearSearch();
    openRoute(parseRoute(open.dataset.kxOpen));
    return;
  }
  if (target.closest("[data-kx-back]")) { back(); return; }
  const copyButton = target.closest("[data-kx-copy]");
  if (copyButton) { copy(copyButton.dataset.kxCopy); return; }
  if (target.closest("[data-kx-retry]")) { const entry = routes.at(-1); if (entry) { if (entry.type !== "chart") { entry.value = null; renderPage(); } loadRoute(entry); } return; }
  if (target.closest("[data-kx-payload-toggle]")) { const entry = routes.at(-1); if (entry) { entry.showPayload = !entry.showPayload; renderPage(); } return; }
  if (target.closest("[data-kx-load-more]")) { const entry = routes.at(-1); if (entry) loadMore(entry); return; }
  if (target.closest("[data-kx-qr]")) { const entry = routes.at(-1); if (entry?.value?.address) showQr(entry.value.address); return; }
  const unit = target.closest("[data-kx-mining-unit]");
  if (unit) {
    mining.unit = unit.dataset.kxMiningUnit;
    unit.parentElement?.querySelectorAll("[data-kx-mining-unit]").forEach((b) => b.classList.toggle("active", b === unit));
    paintMining();
    return;
  }
  if (target.closest("[data-kx-clear]")) { clearSearch({ blur: false }); homeEl?.querySelector("[data-kx-search]")?.focus(); return; }
  if (target.closest("[data-kx-paste]")) {
    Promise.resolve(navigator.clipboard?.readText?.()).then((text) => {
      const pasted = String(text || "").trim();
      if (!pasted) return;
      const input = homeEl?.querySelector("[data-kx-search]");
      if (input) input.value = pasted;
      home.query = pasted;
      runSearch(pasted);
    }).catch(() => {});
    return;
  }
  if (target.closest("[data-kx-recent-clear]")) { home.recent = []; paintSearch(); return; }
  const recent = target.closest("[data-kx-recent]");
  if (recent) {
    const item = home.recent[Number(recent.dataset.kxRecent)];
    if (!item) return;
    const input = homeEl?.querySelector("[data-kx-search]");
    if (input) input.value = item;
    home.query = item;
    runSearch(item);
  }
}

function onInput(event) {
  const target = event.target;
  if (target?.matches?.("[data-kx-search]")) {
    home.query = target.value;
    scheduleLookUp();
    return;
  }
  if (target?.matches?.("[data-kx-mining-input]")) {
    // grouped as you type: "1200000" is a number you'd have to count
    const before = target.value;
    const caret = target.selectionStart ?? before.length;
    const digitsBefore = before.slice(0, caret).replace(/[^\d.]/g, "").length;
    const after = groupTyped(before);
    if (after !== before) {
      target.value = after;
      let pos = 0;
      let seen = 0;
      while (pos < after.length && seen < digitsBefore) { if (/[\d.]/.test(after[pos])) seen += 1; pos += 1; }
      try { target.setSelectionRange(pos, pos); } catch { /* not a text field */ }
    }
    mining.text = target.value;
    paintMining();
  }
}

function onKeydown(event) {
  if (event.target?.matches?.("[data-kx-search]") && event.key === "Enter") {
    event.preventDefault();
    runSearch(event.target.value);
  }
}

function onFocusIn(event) {
  if (event.target?.matches?.("[data-kx-search]")) { home.focused = true; paintSearch(); }
}

function onFocusOut(event) {
  if (!event.target?.matches?.("[data-kx-search]")) return;
  // after a click on a suggestion has landed
  setTimeout(() => {
    if (document.activeElement?.matches?.("[data-kx-search]")) return;
    home.focused = false;
    paintSearch();
  }, 180);
}

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

function build() {
  screenEl = document.querySelector("[data-explorer]");
  if (!screenEl || screenEl.__kxBuilt) return Boolean(screenEl);
  screenEl.__kxBuilt = true;
  screenEl.classList.add("kx-screen");
  screenEl.innerHTML = '<div class="kx-home" data-kx-home></div><div class="kx-page" data-kx-page hidden></div>';
  homeEl = screenEl.querySelector("[data-kx-home]");
  pageEl = screenEl.querySelector("[data-kx-page]");
  homeEl.innerHTML = homeSkeletonHtml();
  const canvas = homeEl.querySelector("[data-kx-dag]");
  // 30 fps is plenty for the card; still while the Explorer doesn't show
  try { live.dag = canvas ? blockDagAnimation(canvas, { minIntervalMs: 1000 / 30 }) : null; } catch { live.dag = null; }
  screenEl.addEventListener("click", onClick);
  screenEl.addEventListener("input", onInput);
  screenEl.addEventListener("keydown", onKeydown);
  screenEl.addEventListener("focusin", onFocusIn);
  screenEl.addEventListener("focusout", onFocusOut);
  // a click on a search result keeps the field focused until it has landed
  screenEl.addEventListener("mousedown", (event) => {
    if (event.target instanceof Element && event.target.closest("[data-kx-results] button")) event.preventDefault();
  });
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", updateLive);
  return true;
}

/** deps: { escapeHtml, showToast, copyText, ownAddress, avatarHtml(address, className),
 *  addBlockClient(fn) -> remove (engine.addBlockScanClient), addressOfOutput(output),
 *  nodeMempoolSize(), nameFor(address), cachedNameFor(address), resolveName(text) -> { address, name },
 *  kusdtUnits(address) -> BigInt, drawQr(canvas, text), indexerBase() } */
export function initExplorer(dependencies) {
  deps = dependencies || {};
  build();
  // the startup tab restore can show the Explorer before this ran: start it for real now
  if (screenEl && !screenEl.hidden) showExplorer();
}

/** The Explorer came on: its home's feed runs while it shows (and the tab is visible). */
export function showExplorer() {
  if (!deps || !build()) return;
  active = true;
  paintSearch();
  paintHome();
  updateLive();
}

/** The Explorer went off screen: the block subscription is dropped and the graph stands still. */
export function hideExplorer() {
  active = false;
  stopLive();
}

/** The dock's Explorer clicked while it already shows: back to the home. */
export function explorerToHome() {
  backToHome();
}
