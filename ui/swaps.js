// Buy and Sell (K 824a30bb, owner 2026-11-26): the Wallet's Buy and Sell buttons and its Buy/Sell
// History card, and the Buy/Sell item in the dock. Step by step, as K's SwapView now goes: pick the coin
// ("What do you want to pay with?" / "What do you want for your Kaspa?"), then, buying, where the Kaspa
// lands (a fresh address, the default, or one of yours; with kUSDT the address that pays), then the
// order (You Pay / You Get), then ChangeNOW's deposit screen, checked every 10 s while it shows, and
// Purchase / Sale Complete with Add to Portfolio; a kUSDT order ends on Order Sent. Code names stay Swap.
// The desktop port of K iOS SwapView / SwapService as of K 5.4 (518fdc8c): ChangeNOW for coins on
// other networks, and kUSDT natively through Trestly's pool on Kaspa (engine/kusdt-trade.js).
//
// KAS is always one side of the pair; the other coin comes from the picker: kUSDT first, then the
// curated ChangeNOW list (ui/swap-quote.js).
// - ChangeNOW: neither side is sent automatically. Whichever coin is given up, the person pays it into
//   the ChangeNOW deposit address themselves (shown as a QR, with XRP's destination tag). Swapping
//   INTO KAS pays out to a fresh, never-used spending address by default. ChangeNOW's answer must be
//   the exchange asked for (payout address, coins, amount) before its deposit address shows, and the
//   deposit card is built from that exchange, never from the coins picked now (K audit 2026-11-24
//   #1, #2, #6).
// - kUSDT: Trestly's pinned code quotes (`prepare`, no key), the approval sheet shows the trade
//   (ui/swap-approval.js), and only on Approve is the address's key handed to their `execute`.
//   The approval is the confirmation, as a kUSDT send's swipe is: no password.
// Each kind sits behind its third party's agreement, asked before that kind is first used on this
// account (no quote goes out before it). History, agreements and choices are the account's own and
// reset with it (K audit 2026-11-24 #5); history and agreements go when the account is removed
// (they are account-scoped keys).
//
// The ChangeNOW API key never ships in the page: every ChangeNOW call goes to the same-origin relay,
// which attaches the server's key to the four swap calls only (tools/relay-guard.mjs). Trestly's API
// is reached straight from its worker, never through the relay.
//
// Styles: ui/swaps.css.

import "./swaps.css";
import { cycleChanged } from "./cycle-button.js";
import kaspaLogoUrl from "./assets/kaspa-logo.png";
import coinAda from "./assets/coins/coin_ada.png";
import coinBch from "./assets/coins/coin_bch.png";
import coinBnb from "./assets/coins/coin_bnb.png";
import coinBtc from "./assets/coins/coin_btc.png";
import coinDoge from "./assets/coins/coin_doge.png";
import coinEtc from "./assets/coins/coin_etc.png";
import coinEth from "./assets/coins/coin_eth.png";
import coinHype from "./assets/coins/coin_hype.png";
import coinLtc from "./assets/coins/coin_ltc.png";
import coinSol from "./assets/coins/coin_sol.png";
import coinTrx from "./assets/coins/coin_trx.png";
import coinUsdc from "./assets/coins/coin_usdc.png";
import coinUsdt from "./assets/coins/coin_usdt.png";
import coinXmr from "./assets/coins/coin_xmr.png";
import coinXrp from "./assets/coins/coin_xrp.png";
import coinZec from "./assets/coins/coin_zec.png";
import { listPortfolios, addTransactionToPortfolio, portfolioIdsContainingTx } from "./portfolio.js";
import { confirmDialog } from "./dialogs.js";
import { proxiedUrl } from "../engine/endpoints.js";
import { kusdtCoinIconHtml } from "./kusdt-icons.js";
import {
  KAS, KUSDT_COIN, CURATED_COINS, USDC_POLYGON, GROUPED_TICKERS, PINNED_GROUP_TICKERS, SWAP_UNAVAILABLE_TITLE,
  sameCoin, isTrestlyCoin, coinByKey, needsMemo, isValidMemo, payoutExtraIdFor, cleanSwapAmount, answerMatches,
  swapStatusName, formatQuotedAmount, createChangeNowClient, createSwapQuoter, rateLine, portfolioPrefill,
  swapSourceTxId, displayTicker, kusdtSwapHistoryEntry,
} from "./swap-quote.js";
import { getEndpoint } from "../engine/endpoints.js";
import {
  createTrestlyTrade, quoteKusdtSwap, kusdtSwapAmountIn, kusdtQuoteText, kusdtRateText, minimumOut, swapRecord as kusdtSwapRecord,
  kasAmountLabel, TRADE_CODE,
} from "../engine/kusdt-trade.js";
import { formatKusdt, typedKusdt, KUSDT_TOKEN } from "../engine/kusdt.js";
import { kasTextFromSompi } from "../engine/amounts.js";
import { approvalSheetHtml, approvalBlocked, APPROVE_ARM_MS } from "./swap-approval.js";

// Account-scoped (deps.accountScopedKey): they go with the account.
const HISTORY_KEY = "kachat-swap-history-v1";
/** One agreement per third party (K 5.4 SwapAgreementsView: ChangeNOW's and Trestly's, one box
 *  each). Bump the version when the text changes. */
const AGREEMENT_KEYS = Object.freeze({
  changenow: "kachat-swap-agreement-changenow-v1",
  trestly: "kachat-swap-agreement-trestly-v1",
});
/** Before K 5.4: ChangeNOW's terms, one box. The text changed, so it is asked again. */
const LEGACY_AGREED_KEY = "kachat-swap-disclaimer-agreed-v1";

export const CHANGENOW_TERMS_URL = "https://changenow.io/terms-of-use";

/** The two agreements (K 5.4 SwapAgreementsView), each its own third party K doesn't run. */
const AGREEMENTS = Object.freeze({
  changenow: {
    title: "ChangeNOW",
    subtitle: "Coins on other networks",
    text: "Swaps between Kaspa and coins on other networks (Bitcoin, Ethereum, USDC, USDT and others) are made by ChangeNOW, a third-party exchange. K only asks ChangeNOW for a quote and a deposit address and shows the swap's status; ChangeNOW does the exchange and sends the coins. K isn't responsible for failed, delayed or lost swaps. If one doesn't go through, contact ChangeNOW's support.",
    termsTitle: "Read ChangeNOW's Terms of Use",
    checkbox: "I understand ChangeNOW is a third party, not K, and I agree to ChangeNOW's Terms of Use.",
  },
  trestly: {
    title: "Trestly",
    subtitle: "kUSDT on Kaspa",
    text: "Swaps between KAS and kUSDT go through Trestly's pool on Kaspa. Trestly is a third party: it issues kUSDT and runs the pool, not K. Trestly's own code prices each swap and builds its transaction; K shows it to you, signs it with your address's key only after you approve, and sends it. Prices move, and the pool can be paused or limit sells. K isn't responsible for the pool, the token or a swap's outcome.",
    termsTitle: "Read Trestly's Terms of Service",
    checkbox: "I understand Trestly is a third party, not K, and I agree to Trestly's Terms of Service.",
  },
});

export const SWAP_TEXT = Object.freeze({
  answerMismatch: "ChangeNOW's answer doesn't match this swap, so K didn't show its deposit address. Nothing was sent.",
  noDeposit: "ChangeNOW didn't return a deposit address.",
  badTag: "This destination tag isn't valid. It's a whole number, with no letters or spaces.",
  tagHint: "Only if the receiving address needs one, as most exchanges do. Without it, the exchange can't credit your coins.",
  tagRequired: "Required: send with this destination tag (memo), or the deposit can't be credited and may be lost.",
  kusdtFromNote: "The swap's KAS and kUSDT both stay on this address.",
  swapFailed: "Swap failed",
});

/** Brand art for the coins that have it (iOS swapCoinLogoAssetNames, the same images). */
const COIN_LOGOS = {
  btc: coinBtc, eth: coinEth, sol: coinSol, xrp: coinXrp, bnb: coinBnb, trx: coinTrx, hype: coinHype,
  doge: coinDoge, ltc: coinLtc, ada: coinAda, bch: coinBch, etc: coinEtc, usdc: coinUsdc, usdt: coinUsdt,
  zec: coinZec, xmr: coinXmr,
};

// SF Symbols, drawn as strokes like the rest of the app's icons.
const svg = (paths, cls = "") => `<svg${cls ? ` class="${cls}"` : ""} viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  swap: svg('<path d="M4 8h15M15 4l4 4-4 4"/><path d="M20 16H5M9 12l-4 4 4 4"/>'),           // arrow.left.arrow.right
  flip: svg('<path d="M8 20V4M4 8l4-4 4 4"/><path d="M16 4v16M12 16l4 4 4-4"/>'),              // arrow.up.arrow.down
  chevronDown: svg('<path d="m6 9 6 6 6-6"/>', "swap-chevron"),
  chevronRight: svg('<path d="m9 6 6 6-6 6"/>'),
  check: svg('<path d="m5 12 5 5L20 7"/>', "swap-check"),
  trash: svg('<path d="M3.5 6.5h17"/><path d="M18.5 6.5V19a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V6.5"/><path d="M8.5 6.5V4.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v2"/>'),
  plusCircle: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
  safari: svg('<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>'),
  arrowDownCircle: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v9M8.5 13 12 16.5 15.5 13"/>'),
  arrowRightCircle: svg('<circle cx="12" cy="12" r="9.5"/><path d="M7.5 12h9M13 8.5l3.5 3.5-3.5 3.5"/>'),
  chartPie: svg('<path d="M21.18 15.9A10 10 0 1 1 8.1 2.82"/><path d="M22 12A10 10 0 0 0 12 2v10Z"/>'),
  warning: svg('<path d="M12 3.5 2.5 20h19Z"/><path d="M12 10v4.5M12 17.2v.1"/>'),
  doc: svg('<path d="M6.5 3h7.8L18.5 7.2V20a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v4.5h4.5M8.5 12h7M8.5 16h7"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  circle: svg('<circle cx="12" cy="12" r="9"/>'),
  checkCircle: svg('<circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5-6"/>'),
};

let deps = null;
let rootEl = null;
let started = false;
let trade = null;

// ---------------------------------------------------------------------------
// State (iOS SwapService)
// ---------------------------------------------------------------------------
let availability = "checking";    // ChangeNOW on this site: "checking" | "on" | "off" | "needs-key"
// A KaChat someone runs for themselves (localhost, Kaspa Quick Start) whose relay has no key of its
// own takes the ChangeNOW API key they paste here ("bring-your-own" from the relay probe). The key
// stays in this browser only and rides on the four swap calls to this KaChat's own relay, which
// passes it to ChangeNOW. A site other people open never asks for one (its relay answers "off").
let ownKeyMode = false;
const PASTED_KEY_STORAGE = "kachat-changenow-own-key-v1";
const PASTED_KEY_HEADER = "x-kachat-changenow-key"; // tools/relay-guard.mjs CHANGENOW_CLIENT_KEY_HEADER
const PASTED_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
let pastedKeyError = "";
function pastedKey() {
  try { return String(localStorage.getItem(PASTED_KEY_STORAGE) || "").trim(); } catch { return ""; }
}
function savePastedKey(key) {
  try {
    if (key) localStorage.setItem(PASTED_KEY_STORAGE, key);
    else localStorage.removeItem(PASTED_KEY_STORAGE);
  } catch { /* storage blocked: the key then lasts as long as the page */ }
}
let history = [];
let agreements = { changenow: false, trestly: false };
let agreementChecked = false;      // the open agreement's checkbox
let coinBeforeTrestly = null;      // the ChangeNOW coin to go back to when Trestly's agreement is put off
// Where the screen is (K SwapView Start + its path): the root page, then the steps after it.
// Roots: "home" (the dock item's: Buy Kaspa, Sell Kaspa, Buy/Sell History), "buy", "sell", "history".
// Steps: { kind: "destination" | "form" | "deposit" | "complete" | "kusdtDone", id?, message? }.
let flowStart = "home";
let flowPath = [];
let toChattingStart = false;       // opened to fund the chatting address: bought Kaspa lands there
let payoutToChatting = false;      // the buy's Kaspa lands on the Chatting Address
let destinationChoosing = false;   // Choose an Address on the "where" step
let destinationEntries = null;     // that step's list of your addresses, once read
let coinListState = { query: "", expanded: new Set() };
let depositTimer = null;
// True = KAS is what you send. iOS default false: most people open Swap to acquire KAS.
let kasIsSendSide = false;
let otherCoin = USDC_POLYGON;
let amountText = "";               // "You Send"
let receiveAmountText = "";        // "You Get"
let editedSide = "send";           // which card was typed last; the other is the quote's figure
let payoutAddressText = "";
let payoutExtraIdText = "";        // the payout's tag, for a coin that takes one (XRP)
let toAddressOverrideIndex = null;
let toAddress = "";
const IDLE_ESTIMATE = Object.freeze({ status: "idle", fromAmount: null, toAmount: null, errorMessage: null, rateText: null });
let estimateState = IDLE_ESTIMATE;
// The exchange ChangeNOW created, with the coins it was made for: { transaction, fromCoin, toCoin }.
let createState = { status: "idle", result: null, errorMessage: null };
let estimateTimer = null;
let estimateToken = 0;
// kUSDT (Trestly)
let kusdtFrom = null;              // { label, address, spendingIndex } or null: the Chatting Address
let kusdtQuote = null;             // { quote: bigint, amountIn: bigint, buying, address }
let approval = null;               // { request, resolve, timer }
// The Swap From address's balances, for "Available" and Max (K 6b99c6dd): { key, at, kasSompi, units }
let kusdtBalances = { key: "", at: 0, kasSompi: null, units: null };
const KUSDT_BALANCE_STALE_MS = 30_000;

const client = createChangeNowClient({
  fetchImpl: (url, init) => {
    const key = ownKeyMode ? pastedKey() : "";
    return window.fetch(url, key ? { ...init, headers: { ...(init?.headers || {}), [PASTED_KEY_HEADER]: key } } : init);
  },
  urlFor: (url) => proxiedUrl(url),
});
const quoter = createSwapQuoter(client);

// ---------------------------------------------------------------------------
// Available and Max on a kUSDT swap (K 6b99c6dd SwapService.kusdtMaxSend)
// ---------------------------------------------------------------------------
/** What a KAS-for-kUSDT buy keeps back, exactly as Trestly's pool works out its own max
 *  (`maxKasIn` in kusdt/kusdt-wallet.js): the KAS inside the new kUSDT coin (1.5 KAS) and
 *  `FEE_KEEP` (0.3 KAS) for the network fee. Less, and the pool refuses a Max buy. */
export const KUSDT_BUY_FEE_KEEP_SOMPI = 30_000_000n;
export const KUSDT_BUY_KEEP_SOMPI = KUSDT_TOKEN.kasPerCoinSompi + KUSDT_BUY_FEE_KEEP_SOMPI;
/** The most "You Send" can be: all the address's kUSDT on a sell; on a buy its KAS less what the
 *  pool keeps back. null while the balance isn't known. */
export function kusdtMaxSend({ buying, kasSompi, units }) {
  if (buying) {
    if (kasSompi == null) return null;
    const kas = BigInt(kasSompi);
    return kas > KUSDT_BUY_KEEP_SOMPI ? kas - KUSDT_BUY_KEEP_SOMPI : 0n;
  }
  return units == null ? null : BigInt(units);
}
/** Max's figure as the field types it: KAS to 8 places, kUSDT to 6, no grouping. */
export function kusdtMaxText(max, buying) {
  return buying ? kasTextFromSompi(max) : typedKusdt(max);
}
/** Why Max on a buy is less than the balance (owner, 2026-11-24: "max does not actually pull"). */
export function kusdtBuyKeepNote() {
  return `Max keeps ${kasTextFromSompi(KUSDT_BUY_KEEP_SOMPI)} KAS back: ${kasTextFromSompi(KUSDT_TOKEN.kasPerCoinSompi)} KAS goes inside your new kUSDT coin, and up to ${kasTextFromSompi(KUSDT_BUY_FEE_KEEP_SOMPI)} KAS pays the network fee.`;
}
/** Reads the Swap From address's balances when it changed or they're stale; redraws once they land. */
function refreshKusdtBalances({ force = false } = {}) {
  if (!isKusdt() || !deps?.kusdt?.balancesOf) return;
  const target = kusdtTarget();
  if (!target?.address) return;
  const key = `${account()}|${target.address}`;
  if (!force && kusdtBalances.key === key && Date.now() - kusdtBalances.at < KUSDT_BALANCE_STALE_MS) return;
  const keep = kusdtBalances.key === key ? kusdtBalances : { kasSompi: null, units: null };
  kusdtBalances = { key, at: Date.now(), kasSompi: keep.kasSompi, units: keep.units };
  deps.kusdt.balancesOf(target.address).then((read) => {
    if (!read || kusdtBalances.key !== key) return;
    kusdtBalances = { key, at: Date.now(), kasSompi: read.kasSompi ?? null, units: read.units ?? null };
    if (isKusdt() && currentStep().kind === "form") renderFormLight();
  }).catch(() => {});
}
function currentKusdtBalances() {
  const target = kusdtTarget();
  return target && kusdtBalances.key === `${account()}|${target.address}` ? kusdtBalances : { kasSompi: null, units: null };
}

function fromCoin() { return kasIsSendSide ? KAS : otherCoin; }
function toCoin() { return kasIsSendSide ? otherCoin : KAS; }
function isKusdt() { return isTrestlyCoin(otherCoin); }
function kindOf(coin) { return isTrestlyCoin(coin) ? "trestly" : "changenow"; }
function currentKind() { return kindOf(otherCoin); }
const esc = (value) => deps.escapeHtml(String(value ?? ""));
const account = () => String(deps?.account?.() || "").trim();

// ---------------------------------------------------------------------------
// Availability: the relay answers /nc-proxy/__swap with "on" when the server has a key.
// ---------------------------------------------------------------------------
function relayRoot() {
  let base = "/";
  try { base = import.meta.env.BASE_URL || "/"; } catch { base = "/"; }
  return `${base}nc-proxy/`;
}
let probing = null;
function probeAvailability() {
  if (probing) return probing;
  probing = (async () => {
    try {
      const response = await window.fetch(`${relayRoot()}__swap`, { cache: "no-store" });
      const body = (await response.text()).trim();
      ownKeyMode = response.ok && body === "bring-your-own";
      availability = response.ok && body === "on" ? "on" : ownKeyMode ? (pastedKey() ? "on" : "needs-key") : "off";
    } catch {
      availability = "off";
    }
    probing = null;
    render();
  })();
  return probing;
}
/** What a failed swap call says. On your own KaChat a refused key is named as such: the way out is
 *  "Use a different key" under the form. */
function swapErrorText(error, fallback) {
  if (ownKeyMode && (error?.status === 401 || error?.status === 403)) return "ChangeNOW didn't accept your API key. Use a different key below.";
  return error?.message || fallback;
}
/** A call came back "no key here": the screen says so instead of a failed quote. */
function noteUnavailable(error) {
  if (!error?.unavailable) return false;
  // On your own KaChat the relay had no usable key from this page: ask for it again.
  availability = ownKeyMode ? "needs-key" : "off";
  render();
  return true;
}

// ---------------------------------------------------------------------------
// Storage: the account's own (no account, nothing is read or kept).
// ---------------------------------------------------------------------------
function scoped(key) {
  return account() ? deps.accountScopedKey(key) : null;
}
function loadState() {
  const read = (key) => { const k = scoped(key); if (!k) return null; try { return localStorage.getItem(k); } catch { return null; } };
  agreements = { changenow: read(AGREEMENT_KEYS.changenow) === "1", trestly: read(AGREEMENT_KEYS.trestly) === "1" };
  try { const legacy = scoped(LEGACY_AGREED_KEY); if (legacy) localStorage.removeItem(legacy); } catch { /* not stored */ }
  try { history = JSON.parse(read(HISTORY_KEY) || "[]") || []; } catch { history = []; }
  if (!Array.isArray(history)) history = [];
  history.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}
function saveHistory() {
  history.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  const key = scoped(HISTORY_KEY);
  if (!key) return;
  try { localStorage.setItem(key, JSON.stringify(history)); } catch { /* storage full or blocked */ }
}
function acceptAgreement(kind) {
  agreements = { ...agreements, [kind]: true };
  const key = scoped(AGREEMENT_KEYS[kind]);
  if (key) { try { localStorage.setItem(key, "1"); } catch { /* storage blocked: asked again next time */ } }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
function fmt8(text) {
  if (text === "" || text == null) return String(text ?? "");
  const n = Number(text);
  return Number.isFinite(n) ? n.toFixed(8) : String(text);
}
/** iOS statusColor: finished green, failed/refunded red, everything in between orange. */
function statusClass(status) {
  if (status === "finished") return "ok";
  if (status === "failed" || status === "refunded") return "bad";
  return "warn";
}
/** iOS Text(date, style: .date): "October 22, 2026". */
function dateText(ms) {
  return new Date(Number(ms) || Date.now()).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}
function shortMiddle(text) {
  const value = String(text || "");
  return value.length > 20 ? `${value.slice(0, 12)}...${value.slice(-6)}` : value;
}

function coinIcon(coin) {
  if (isTrestlyCoin(coin)) return `<span class="swap-coin-icon kusdt">${kusdtCoinIconHtml(20)}</span>`;
  if (coin.ticker === "kas") return `<img class="swap-coin-icon" src="${kaspaLogoUrl}" alt="" />`;
  const logo = COIN_LOGOS[coin.ticker];
  if (logo) return `<img class="swap-coin-icon round" src="${logo}" alt="" />`;
  return `<span class="swap-coin-icon text">${esc(coin.ticker.toUpperCase())}</span>`;
}

// ---------------------------------------------------------------------------
// Payout address (iOS refreshToAddress): a preview of the next legacy slot until the swap is real.
// ---------------------------------------------------------------------------
function refreshToAddress() {
  try {
    const index = toAddressOverrideIndex ?? deps.nextFreshSpendingIndex();
    toAddress = index == null ? "" : (deps.spendingAddressAt(index) || "");
  } catch { toAddress = ""; }
}

/** The kUSDT swap's address: the Chatting Address unless another was picked. */
function kusdtTarget() {
  if (kusdtFrom) return kusdtFrom;
  const chatting = account();
  return chatting ? { label: "Chatting Address", address: chatting, spendingIndex: null } : null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function currentStep() {
  return flowPath.length ? flowPath[flowPath.length - 1] : { kind: flowStart };
}
function stepTitle(step) {
  switch (step.kind) {
    case "home": return "Buy/Sell";
    case "buy": case "destination": return "Buy Kaspa";
    case "sell": return "Sell Kaspa";
    case "history": return "Buy/Sell History";
    case "form": return kasIsSendSide ? `Sell Kaspa for ${otherCoin.displayName}` : `Buy Kaspa with ${otherCoin.displayName}`;
    case "deposit": return "Send Payment";
    case "complete": return history.find((x) => x.id === step.id)?.toTicker === "kas" ? "Purchase Complete" : "Sale Complete";
    case "kusdtDone": return "Order Sent";
    default: return "Buy/Sell";
  }
}
/** The step's page: back goes one step up (a deposit, a completion and Order Sent have none: Done). */
function render() {
  if (!rootEl || !deps) return;
  const step = currentStep();
  const finished = step.kind === "deposit" || step.kind === "complete" || step.kind === "kusdtDone";
  const canBack = !finished && (flowPath.length > 0 || flowStart !== "home");
  const header = `<div class="kaposts-header swap-flow-header">
      ${canBack ? `<button type="button" class="swap-flow-back" data-swap-back aria-label="Back">${svg('<path d="M15 5 8 12l7 7"/>')}</button>` : ""}
      <h1 class="kaposts-title">${esc(stepTitle(step))}</h1>
      ${finished && step.kind === "deposit" ? `<button type="button" class="swap-link strong swap-flow-done" data-swap-done>Done</button>` : ""}
    </div>`;
  const kind = currentKind();
  const overlay = step.kind === "form" && !agreements[kind] ? renderAgreement(kind) : "";
  const fade = cycleChanged("page:swap", `${flowStart}:${flowPath.length}:${step.kind}`) ? " cycle-fade" : "";
  rootEl.innerHTML = `<div class="swap-root">${header}<div class="swap-page${fade}">${renderStep(step)}</div>${overlay}</div>`;
  rootEl.querySelectorAll("[data-swap-qr]").forEach((qr) => {
    if (qr.dataset.swapQr) deps.engine.drawQrFor(qr, qr.dataset.swapQr, { dark: "#06110f", light: "#ffffff" }).catch(() => {});
  });
  syncDepositPolling(step);
}
function renderStep(step) {
  switch (step.kind) {
    case "home": return renderHome();
    case "buy": return renderCoinChoice("What do you want to pay with?");
    case "sell": return renderCoinChoice("What do you want for your Kaspa?");
    case "history": return renderHistory();
    case "destination": return renderDestination();
    case "form": return renderSwapPage();
    case "deposit": return renderDeposit(step.id);
    case "complete": return renderComplete(step.id);
    case "kusdtDone": return renderSent(step.message);
    default: return "";
  }
}

/** The dock item's page: the Wallet's Buy and Sell buttons and its Buy/Sell History card. */
function renderHome() {
  const row = (attr, title, subtitle, icon) => `<button type="button" class="profile-card swap-home-row" ${attr}>
      <span class="swap-home-icon" aria-hidden="true">${icon}</span>
      <span class="swap-home-copy"><strong>${esc(title)}</strong><small>${esc(subtitle)}</small></span>
      ${ICONS.chevronRight}
    </button>`;
  return `<div class="swap-home">
    ${row('data-swap-start="buy"', "Buy Kaspa", "Pay with another coin, like kUSDT or Bitcoin.", svg('<path d="M12 5v14M5 12h14"/>'))}
    ${row('data-swap-start="sell"', "Sell Kaspa", "Get another coin for your Kaspa.", svg('<path d="M5 12h14"/>'))}
    ${row('data-swap-start="history"', "Buy/Sell History", "Your orders and where each one is.", svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'))}
  </div>`;
}

/** What to pay with (Buy) or what to get (Sell), K SwapCoinChoiceList: kUSDT, then USD Coin and
 *  Tether folded by network, then the rest; search, since the list is long. */
function coinChoiceRows() {
  const query = String(coinListState.query || "").trim().toLowerCase();
  const every = [KUSDT_COIN, ...PINNED_GROUP_TICKERS.flatMap((t) => CURATED_COINS.filter((c) => c.ticker === t)),
    ...CURATED_COINS.filter((c) => !GROUPED_TICKERS[c.ticker])];
  if (query) {
    return every.filter((c) => c.displayName.toLowerCase().includes(query) || c.ticker.toLowerCase().includes(query))
      .map((coin) => ({ kind: "coin", coin }));
  }
  const rows = [];
  const seen = new Set();
  for (const coin of every) {
    const siblings = every.filter((c) => c.ticker === coin.ticker);
    if (GROUPED_TICKERS[coin.ticker] && siblings.length > 1 && !isTrestlyCoin(coin)) {
      if (seen.has(coin.ticker)) continue;
      seen.add(coin.ticker);
      rows.push({ kind: "group", ticker: coin.ticker, count: siblings.length, coin });
      if (coinListState.expanded.has(coin.ticker)) for (const c of siblings) rows.push({ kind: "network", coin: c });
    } else rows.push({ kind: "coin", coin });
  }
  return rows;
}
function coinSymbol(coin) { return isTrestlyCoin(coin) ? "kUSDT" : coin.ticker.toUpperCase(); }
function renderCoinChoiceList() {
  return coinChoiceRows().map((row) => {
    if (row.kind === "group") {
      const open = coinListState.expanded.has(row.ticker);
      return `<button type="button" class="profile-card swap-choice-row" data-swap-choice-group="${esc(row.ticker)}" aria-expanded="${open}">
          ${coinIcon(row.coin)}<span class="swap-choice-copy"><strong>${esc(GROUPED_TICKERS[row.ticker])}</strong><small>${esc(`${row.ticker.toUpperCase()} on ${row.count} networks`)}</small></span>
          <span class="swap-picker-chevron${open ? " open" : ""}">${ICONS.chevronDown}</span>
        </button>`;
    }
    const coin = row.coin;
    return `<button type="button" class="profile-card swap-choice-row${row.kind === "network" ? " indented" : ""}" data-swap-choice="${esc(isTrestlyCoin(coin) ? "kusdt" : `${coin.ticker}:${coin.network}`)}">
        ${coinIcon(coin)}<span class="swap-choice-copy"><strong>${esc(coin.displayName)}</strong><small>${esc(coinSymbol(coin))}</small></span>
        ${ICONS.chevronRight}
      </button>`;
  }).join("");
}
function renderCoinChoice(question) {
  return `<div class="swap-choice">
    <h2 class="swap-step-question">${esc(question)}</h2>
    <input class="field-input swap-search" type="search" data-swap-choice-search placeholder="Search coins" value="${esc(coinListState.query)}" autocomplete="off" />
    <div class="swap-choice-list" data-swap-choice-list>${renderCoinChoiceList()}</div>
  </div>`;
}

/** Buying: "Where should your Kaspa land?" (K SwapDestinationStep). Through ChangeNOW: a fresh
 *  address (the default: the purchase stays apart from your username and chats) or one of yours,
 *  the Chatting Address too. With kUSDT: the address that pays, since Trestly's trade lands its
 *  Kaspa on the same one. */
function renderDestination() {
  if (isKusdt()) {
    const st = sheetState.destinationKusdt;
    if (!st) { loadKusdtDestinations(); }
    const current = kusdtTarget()?.address;
    const rows = (st?.choices || []).map((c, i) => {
      const on = c.address === current;
      return `<button type="button" class="profile-card swap-dest-row${on ? " picked" : ""}" data-swap-dest-kusdt="${i}" aria-pressed="${on}">
        <span class="swap-kusdt-from-mark${on ? " on" : ""}">${on ? ICONS.checkCircle : ICONS.circle}</span>
        <span class="swap-address-copy"><strong>${esc(c.label)}</strong><small class="mono">${esc(shortMiddle(c.address))}</small><small>${esc(formatKusdt(c.units ?? 0n))}</small></span>
      </button>`;
    }).join("");
    return `<div class="swap-dest">
      <h2 class="swap-step-question">Where should your Kaspa land?</h2>
      <p class="swap-step-note">kUSDT is paid from one address, and your Kaspa lands on that same address.</p>
      ${st && !st.loading ? rows : `<div class="swap-checking"><span class="kaposts-spinner" aria-hidden="true"></span></div>`}
      <button type="button" class="primary-button swap-continue" data-swap-continue>Continue</button>
    </div>`;
  }
  const picked = destinationChoosing ? (payoutToChatting ? account() : (toAddressOverrideIndex != null ? toAddress : null)) : null;
  const canContinue = !destinationChoosing || Boolean(picked);
  let body;
  if (destinationChoosing) {
    if (!destinationEntries) loadDestinationEntries();
    const chatting = account();
    const rows = [];
    if (chatting) rows.push(`<button type="button" class="profile-card swap-dest-row${payoutToChatting ? " picked" : ""}" data-swap-dest-chatting>
        <span class="swap-kusdt-from-mark${payoutToChatting ? " on" : ""}">${payoutToChatting ? ICONS.checkCircle : ICONS.circle}</span>
        <span class="swap-address-copy"><strong>Chatting Address</strong><small class="mono">${esc(shortMiddle(chatting))}</small></span>
      </button>`);
    for (const e of destinationEntries || []) {
      const on = !payoutToChatting && toAddressOverrideIndex === e.index;
      rows.push(`<button type="button" class="profile-card swap-dest-row${on ? " picked" : ""}" data-swap-dest-index="${e.index}">
        <span class="swap-kusdt-from-mark${on ? " on" : ""}">${on ? ICONS.checkCircle : ICONS.circle}</span>
        <span class="swap-address-copy"><strong>${esc(e.label)} <b class="${e.used ? "used" : "unused"}">${e.used ? "Used" : "Unused"}</b></strong><small class="mono">${esc(e.shortAddress)}</small><small>${esc(formatQuotedAmount(e.kas))} KAS</small></span>
      </button>`);
    }
    body = destinationEntries ? rows.join("") : `${rows.join("")}<div class="swap-checking"><span class="kaposts-spinner" aria-hidden="true"></span></div>`;
  } else {
    body = `<div class="profile-card swap-dest-fresh">
        <p>A new address that has never been used, so this purchase stays apart from your username and chats.</p>
        ${toAddress ? `<code>${esc(toAddress)}</code>` : ""}
      </div>`;
  }
  return `<div class="swap-dest">
    <h2 class="swap-step-question">Where should your Kaspa land?</h2>
    <div class="swap-dest-pills">
      <button type="button" class="swap-pill${destinationChoosing ? "" : " selected"}" data-swap-dest-fresh>Fresh Address</button>
      <button type="button" class="swap-pill${destinationChoosing ? " selected" : ""}" data-swap-dest-choose>Choose an Address</button>
    </div>
    ${body}
    <button type="button" class="primary-button swap-continue" data-swap-continue ${canContinue ? "" : "disabled"}>Continue</button>
  </div>`;
}
async function loadKusdtDestinations() {
  const st = { choices: [], loading: true };
  sheetState.destinationKusdt = st;
  let choices = [];
  try { choices = (await deps.kusdt?.fromChoices?.()) || []; } catch { choices = []; }
  if (sheetState.destinationKusdt !== st) return;
  // the Chatting Address first, then every address holding kUSDT, most first (K kusdtChoices)
  st.choices = choices.filter((c, i) => c.spendingIndex == null || (c.units != null && BigInt(c.units) > 0n) || i === 0);
  st.loading = false;
  if (currentStep().kind === "destination") render();
}
async function loadDestinationEntries() {
  const marker = {};
  loadDestinationEntries.marker = marker;
  const entries = await deps.listSpendingAddresses().catch(() => []);
  if (loadDestinationEntries.marker !== marker) return;
  destinationEntries = entries.filter((e) => !e.hidden);
  if (currentStep().kind === "destination") render();
}

/** A ChangeNOW order's deposit (K SwapDepositScreen): what to send and where, the status from
 *  Waiting for payment on, the transaction ID. Drawn from the exchange made, never the coins picked
 *  now (K audit 2026-11-24 #2). */
function depositStatus(swap, to) {
  const status = String(swap.status || "").toLowerCase();
  const problem = ["failed", "refunded", "expired", "verifying"].includes(status);
  const lines = {
    confirming: ["Payment received", "Waiting for it to confirm."],
    exchanging: ["Exchanging", "ChangeNOW is converting your coins."],
    sending: [`Sending your ${to.displayName}`, "Almost done."],
    failed: [swapStatusName(status), "ChangeNOW couldn't finish this order. Check it on ChangeNOW."],
    refunded: [swapStatusName(status), "ChangeNOW sent the coins back."],
    expired: [swapStatusName(status), "Nothing arrived in time. Start a new order."],
    verifying: [swapStatusName(status), "ChangeNOW is checking this order."],
  };
  const [title, detail] = lines[status] || ["Waiting for payment", "Send the amount above. This screen updates by itself."];
  return `<div class="profile-card swap-deposit-status${problem ? " problem" : ""}">
      ${problem ? `<span class="swap-deposit-warn">${ICONS.warning}</span>` : `<span class="kaposts-spinner small" aria-hidden="true"></span>`}
      <span><strong>${esc(title)}</strong><small>${esc(detail)}</small></span>
    </div>`;
}
function coinOf(ticker, network) {
  if (ticker === "kas") return KAS;
  if (isTrestlyCoin({ ticker, network })) return KUSDT_COIN;
  return coinByKey(`${ticker}:${network}`) || { ticker, network, displayName: String(ticker || "").toUpperCase() };
}
function groupedFigure(text) {
  const raw = String(text ?? "");
  const [whole, frac] = raw.split(".");
  if (!/^\d+$/.test(whole || "")) return raw;
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac != null ? `.${frac}` : ""}`;
}
function renderDeposit(id) {
  const swap = history.find((x) => x.id === id);
  if (!swap) return `<div class="swap-checking"><span class="kaposts-spinner" aria-hidden="true"></span></div>`;
  const from = coinOf(swap.fromTicker, swap.fromNetwork);
  const to = coinOf(swap.toTicker, swap.toNetwork);
  const payin = String(swap.payinAddress || "");
  return `<div class="swap-deposit">
    <div class="swap-deposit-head">
      <h2>${esc(`Send ${groupedFigure(swap.fromAmount)} ${from.displayName}`)}</h2>
      <p>${esc(to.ticker === "kas" ? "to buy Kaspa" : `to sell it for ${to.displayName}`)}</p>
    </div>
    ${depositStatus(swap, to)}
    ${payin ? `<button type="button" class="swap-qr-button" data-swap-copy="${esc(payin)}" aria-label="Copy deposit address"><canvas class="swap-qr" data-swap-qr="${esc(payin)}" width="200" height="200"></canvas></button>` : ""}
    <div class="profile-card swap-deposit-card"><small>Deposit Address</small><code>${esc(payin)}</code>
      <button type="button" class="swap-copy-pill" data-swap-copy="${esc(payin)}">${ICONS.copy}<span>Copy Address</span></button></div>
    <div class="profile-card swap-deposit-card"><small>Amount to Send</small><strong class="swap-deposit-amount">${esc(`${groupedFigure(swap.fromAmount)} ${from.displayName}`)}</strong>
      <button type="button" class="swap-copy-pill" data-swap-copy-amount="${esc(swap.fromAmount)}">${ICONS.copy}<span>Copy Amount</span></button></div>
    ${swap.payinExtraId ? depositTagBox(swap.payinExtraId) : ""}
    ${from.ticker === "kas" ? `<button type="button" class="primary-button swap-send-kas" data-swap-send-kas="${esc(swap.id)}">Send KAS from K</button>` : ""}
    <div class="profile-card swap-deposit-card"><small>Transaction ID</small><code>${esc(swap.id)}</code>
      <span class="swap-deposit-id-actions">
        <button type="button" class="swap-copy-pill" data-swap-copy-id="${esc(swap.id)}">${ICONS.copy}<span>Copy ID</span></button>
        <a class="swap-link strong" href="https://changenow.io/exchange/txs/${encodeURIComponent(swap.id)}" target="_blank" rel="noopener noreferrer">View on ChangeNOW</a>
      </span></div>
    ${swap.toAmount ? `<p class="swap-step-note centered">${esc(`You get about ${groupedFigure(swap.toAmount)} ${to.displayName}, sent to ${shortMiddle(swap.payoutAddress)}.`)}</p>` : ""}
  </div>`;
}
/** Checks ChangeNOW every 10 s while the deposit screen shows; a finished order becomes Complete. */
function syncDepositPolling(step) {
  const wanted = step.kind === "deposit" && started && !document.hidden && Boolean(rootEl?.isConnected) && isScreenShown();
  if (!wanted) { if (depositTimer) { window.clearTimeout(depositTimer); depositTimer = null; } return; }
  if (depositTimer) return;
  const id = step.id;
  depositTimer = window.setTimeout(async () => {
    depositTimer = null;
    const status = await refreshSwapStatus(id);
    const now = currentStep();
    if (now.kind !== "deposit" || now.id !== id) return;
    if (String(status || "").toLowerCase() === "finished") flowPath[flowPath.length - 1] = { kind: "complete", id };
    render();
  }, 10_000);
}
function isScreenShown() {
  const screen = rootEl?.closest?.("[data-app-tab-screen]");
  return !screen || !screen.hidden;
}
function renderComplete(id) {
  const swap = history.find((x) => x.id === id);
  const from = swap ? coinOf(swap.fromTicker, swap.fromNetwork) : null;
  const to = swap ? coinOf(swap.toTicker, swap.toNetwork) : null;
  return `<div class="swap-finish">
    <span class="swap-finish-mark" aria-hidden="true">${ICONS.checkCircle}</span>
    <h2>${esc(swap?.toTicker === "kas" ? "Purchase Complete" : "Sale Complete")}</h2>
    ${swap ? `<p>${esc(`You paid ${groupedFigure(swap.fromAmount)} ${from.displayName}`)}${swap.toAmount ? `<br>${esc(`You got about ${groupedFigure(swap.toAmount)} ${to.displayName}`)}` : ""}</p>` : ""}
    ${swap ? `<button type="button" class="primary-button swap-finish-button" data-swap-add-portfolio="${esc(swap.id)}" ${swap.addedToPortfolio ? "disabled" : ""}>${swap.addedToPortfolio ? "Added to Portfolio" : "Add to Portfolio"}</button>` : ""}
    <button type="button" class="secondary-button swap-finish-button" data-swap-done>Done</button>
  </div>`;
}
/** A kUSDT order Trestly's pool took (K SwapSentScreen). */
function renderSent(message) {
  return `<div class="swap-finish">
    <span class="swap-finish-mark" aria-hidden="true">${ICONS.checkCircle}</span>
    <h2>Order Sent</h2>
    <p>${esc(message || "")}</p>
    <button type="button" class="primary-button swap-finish-button" data-swap-done>Done</button>
  </div>`;
}
/** The pair picked on the coin screen (K choosePair): Kaspa is always one side, so which side it's on
 *  sets the direction. Buying goes on to "where", selling straight to the order. */
function choosePair(coin, kasSends) {
  if (kasIsSendSide !== kasSends) flipDirection();
  setOtherCoin(coin);
  amountText = "";
  receiveAmountText = "";
  editedSide = "send";
  clearCreatedSwap();
  toAddressOverrideIndex = null;
  payoutToChatting = !kasSends && toChattingStart;
  destinationChoosing = payoutToChatting;
  destinationEntries = null;
  delete sheetState.destinationKusdt;
  refreshToAddress();
  flowPath.push({ kind: kasSends ? "form" : "destination" });
  rescheduleEstimate();
  render();
}

/** The kind's agreement (K 5.4 SwapAgreementsView, one card): its third party, its terms, one box. */
function renderAgreement(kind) {
  const a = AGREEMENTS[kind];
  const termsUrl = kind === "trestly" ? trestlyTermsUrl() : CHANGENOW_TERMS_URL;
  const icon = kind === "trestly" ? kusdtCoinIconHtml(30) : `<span class="swap-agreement-icon" aria-hidden="true">${ICONS.swap}</span>`;
  return `<div class="swap-disclaimer-overlay">
    <div class="swap-disclaimer-card" role="dialog" aria-modal="true" aria-labelledby="swap-disclaimer-title" data-swap-agreement="${kind}">
      <strong id="swap-disclaimer-title">Before You Swap</strong>
      <p class="swap-disclaimer-lead">This swap uses a service K doesn't run. Read and agree before you continue.</p>
      <div class="swap-agreement-head">${icon}<span><strong>${esc(a.title)}</strong><small>${esc(a.subtitle)}</small></span></div>
      <p class="swap-disclaimer-text">${esc(a.text)}</p>
      <a class="swap-link strong swap-terms-link" href="${esc(termsUrl)}" target="_blank" rel="noopener noreferrer">${ICONS.doc}<span>${esc(a.termsTitle)}</span></a>
      <label class="swap-terms-check">
        <input type="checkbox" data-swap-terms ${agreementChecked ? "checked" : ""} />
        <span>${esc(a.checkbox)}</span>
      </label>
      <div class="swap-disclaimer-actions">
        <button type="button" class="linklike-button muted" data-swap-not-now>Not Now</button>
        <button type="button" class="linklike-button strong" data-swap-agree ${agreementChecked ? "" : "disabled"}>I Agree</button>
      </div>
      ${kind === "changenow" ? `<button type="button" class="swap-link swap-agreement-other" data-swap-pick-kusdt>Swap kUSDT instead</button>` : ""}
    </div>
  </div>`;
}

/** `/terms` on Trestly's site for this network (trestly.io on mainnet). */
function trestlyTermsUrl() {
  const site = String(deps?.kusdt?.siteUrl?.() || "https://trestly.io");
  try {
    const u = new URL(site);
    if (u.protocol !== "https:") return "https://trestly.io/terms";
    return `${u.origin}/terms`;
  } catch { return "https://trestly.io/terms"; }
}

function renderSwapPage() {
  if (isKusdt() || availability === "on") return renderSwapForm();
  // ChangeNOW isn't reachable from this site: kUSDT still is.
  const other = `<div class="swap-unavailable-actions">
      <button type="button" class="secondary-button" data-swap-pick-kusdt>Swap kUSDT Instead</button>
      <button type="button" class="swap-link strong" data-swap-back>Choose Another Coin</button>
    </div>`;
  if (availability === "needs-key") {
    return `<div class="hub-empty swap-unavailable swap-own-key">
      <span class="swap-unavailable-icon" aria-hidden="true">${ICONS.swap}</span>
      <h3>Add Your ChangeNOW API Key</h3>
      <p>This K runs on your own computer, so ChangeNOW swaps use your own ChangeNOW API key. Create a free ChangeNOW partner account, copy its API key and paste it here. It stays in this browser and goes only to ChangeNOW, through this K.</p>
      <input class="field-input swap-own-key-input" type="password" data-swap-own-key placeholder="ChangeNOW API key" autocomplete="off" autocapitalize="none" spellcheck="false" />
      ${pastedKeyError ? `<p class="field-error">${esc(pastedKeyError)}</p>` : ""}
      <button type="button" class="primary-button" data-swap-own-key-save>Save Key</button>
      <a class="swap-link" href="https://changenow.io/affiliate" target="_blank" rel="noopener noreferrer">Get a ChangeNOW API key</a>
      ${other}
    </div>`;
  }
  if (availability === "checking") return `<div class="swap-checking"><span class="kaposts-spinner" aria-hidden="true"></span></div>`;
  return `<div class="hub-empty swap-unavailable">
      <span class="swap-unavailable-icon" aria-hidden="true">${ICONS.swap}</span>
      <h3>${esc(SWAP_UNAVAILABLE_TITLE)}</h3>
      <p>This site is not connected to ChangeNOW at the moment, so ${esc(otherCoin.displayName)} can't be swapped. Please try again later.</p>
      <button type="button" class="secondary-button" data-swap-retry>Try Again</button>
      ${other}
    </div>`;
}

/** One amount card (iOS swapAmountCard). `quoting` marks the card whose figure is being fetched
 *  for the other card's input: a spinner where the number will land, not an empty field. A card
 *  that isn't `editable` shows the quote (kUSDT's You Get: the pool quotes from what you send). */
function amountCard({ label, coin, value, field, quoting, editable = true, available = null, max = false }) {
  // the coin was picked on its own step (K 824a30bb): no picker here
  const badge = `<span class="swap-coin-badge">${coinIcon(coin)}<span>${esc(coin.displayName)}</span></span>`;
  const input = quoting
    ? `<span class="swap-amount-quoting"><span class="kaposts-spinner small" aria-hidden="true"></span></span>`
    : `<input class="swap-amount-input" type="text" inputmode="decimal" autocomplete="transaction-amount" placeholder="0.00" aria-label="${esc(label)}" data-swap-field="${field}" value="${esc(value)}"${editable ? "" : " readonly tabindex=\"-1\""} />`;
  const head = available != null
    ? `<div class="swap-card-head"><p class="profile-card-label">${esc(label)}</p><span class="swap-available">Available: ${esc(available)}</span></div>`
    : `<p class="profile-card-label">${esc(label)}</p>`;
  const maxButton = max ? `<button type="button" class="swap-max" data-swap-max>Max</button>` : "";
  return `<div class="profile-card swap-card">${head}<div class="swap-card-row">${input}${maxButton}${badge}</div></div>`;
}

function rateText() {
  if (estimateState.status === "success") {
    if (estimateState.rateText) return estimateState.rateText;
    return rateLine({
      fromAmount: estimateState.fromAmount,
      toAmount: estimateState.toAmount,
      fromLabel: kasIsSendSide ? "KAS" : otherCoin.displayName,
      toLabel: kasIsSendSide ? otherCoin.displayName : "KAS",
    });
  }
  if (estimateState.status === "failed") return estimateState.errorMessage || "Unavailable";
  return "N/A";
}

function renderSwapForm() {
  const busy = createState.status === "creating";
  const kusdt = isKusdt();
  const canSwap = estimateState.status === "success" && !busy && (!kusdt || kusdtQuote != null);
  const loading = estimateState.status === "loading";
  const needsPayout = toCoin().ticker !== "kas" && !kusdt;
  const target = kusdt ? kusdtTarget() : null;
  // kUSDT swaps spend what K holds: the balance beside "You Send", and Max (K 6b99c6dd). A
  // ChangeNOW coin is paid from elsewhere.
  let available = null;
  let canMax = false;
  if (kusdt) {
    refreshKusdtBalances();
    const balances = currentKusdtBalances();
    if (kasIsSendSide) available = balances.kasSompi == null ? null : `${kasTextFromSompi(balances.kasSompi)} KAS`;
    else available = balances.units == null ? null : formatKusdt(balances.units);
    const max = kusdtMaxSend({ buying: kasIsSendSide, ...balances });
    canMax = max != null && max > 0n;
  }
  return `
    ${amountCard({ label: "You Pay", coin: fromCoin(), value: amountText, field: "send", quoting: editedSide === "get" && loading, available, max: canMax })}
    ${kusdt && kasIsSendSide ? `<p class="swap-max-note">${esc(kusdtBuyKeepNote())}</p>` : ""}
    ${amountCard({ label: "You Get", coin: toCoin(), value: receiveAmountText, field: "get", quoting: editedSide === "send" && loading, editable: !kusdt })}
    ${needsPayout ? `<input class="field-input swap-payout-input" type="text" data-swap-payout placeholder="Receive ${esc(toCoin().displayName)} at" value="${esc(payoutAddressText)}" autocomplete="off" autocapitalize="none" spellcheck="false" />` : ""}
    ${needsPayout && needsMemo(toCoin()) ? `<div class="swap-payout-tag">
      <input class="field-input swap-payout-input" type="text" inputmode="numeric" data-swap-payout-tag placeholder="Destination tag (optional)" value="${esc(payoutExtraIdText)}" autocomplete="off" autocapitalize="none" spellcheck="false" />
      <small>${esc(SWAP_TEXT.tagHint)}</small>
    </div>` : ""}
    ${kusdt && kasIsSendSide ? `<div class="profile-card swap-address-row">
      <span class="swap-address-copy"><small>Swap From (kUSDT Lands Here)</small><strong>${esc(target ? `${target.label} · ${shortMiddle(target.address)}` : "")}</strong></span>
      <button type="button" class="swap-link strong" data-swap-kusdt-from>Change</button>
    </div>` : ""}
    <div class="profile-card swap-rate-card"><small>Rate</small><span class="${estimateState.status === "failed" ? "bad" : ""}">${esc(rateText())}</span></div>
    <button type="button" class="primary-button swap-go-wide${canSwap ? "" : " disabled"}" data-swap-create ${canSwap ? "" : "disabled"}>${busy ? `<span class="kaposts-spinner small" aria-hidden="true"></span>` : (kasIsSendSide ? "Sell Kaspa" : "Buy Kaspa")}</button>
    ${kusdt
      ? `<a class="swap-powered" href="${esc(trestlyTermsUrl())}" target="_blank" rel="noopener noreferrer">Powered by Trestly</a>`
      : `<a class="swap-powered" href="https://changenow.io/terms-of-use/changenow-terms" target="_blank" rel="noopener noreferrer">Powered by ChangeNOW</a>`}
    ${ownKeyMode && !kusdt ? `<button type="button" class="swap-link swap-own-key-change" data-swap-own-key-change>Using your own API key · Use a different key</button>` : ""}`;
}

/** ChangeNOW's deposit tag (XRP's destination tag), which the deposit must carry: shown large, with
 *  Copy and why it's required (K audit 2026-11-24 #1). */
function depositTagBox(tag) {
  return `<div class="swap-tag-box" role="note">
    <span class="swap-tag-head">${ICONS.warning}<strong>Destination Tag (Memo)</strong></span>
    <button type="button" class="swap-tag-value" data-swap-copy-tag="${esc(tag)}" aria-label="Copy destination tag">${esc(tag)}</button>
    <p>${esc(SWAP_TEXT.tagRequired)}</p>
    <button type="button" class="swap-link strong swap-tag-copy" data-swap-copy-tag="${esc(tag)}">${ICONS.copy}<span>Copy Destination Tag</span></button>
  </div>`;
}

function historyLine(swap) {
  const trestly = swap.provider === "trestly";
  return `${esc(swap.fromAmount)} ${esc(displayTicker(swap.fromTicker))} → ${esc(trestly ? swap.toAmount : fmt8(swap.toAmount))} ${esc(displayTicker(swap.toTicker))}`;
}
/** Which service ran it (K b49a021d): kUSDT swaps go through Trestly's pool on Kaspa. */
function providerName(swap) { return swap.provider === "trestly" ? "Trestly" : "ChangeNOW"; }

/** A kUSDT swap goes into Buy/Sell History with the ChangeNOW ones (K b49a021d recordKusdtSwap). */
function recordKusdtSwap(record, address) {
  if (!record?.txid || !account() || history.some((s) => s.id === record.txid)) return;
  if (record.amountIn == null || record.amountOut == null) return;
  const kasUnits = record.bought ? record.amountIn : record.amountOut;
  const kusdtUnits = record.bought ? record.amountOut : record.amountIn;
  const entry = kusdtSwapHistoryEntry({
    txid: record.txid, bought: record.bought, confirmed: record.confirmed,
    kasText: kasTextFromSompi(kasUnits), kusdtText: typedKusdt(kusdtUnits), address,
  });
  if (!entry) return;
  history.unshift(entry);
  saveHistory();
}

/** Whether the network accepted a transaction: true, false (not known to the REST API) or null (no
 *  answer). A kUSDT swap's Refresh Status asks this, never ChangeNOW (K b49a021d). */
async function transactionAccepted(txId) {
  const base = String(getEndpoint("kaspaApi") || "").trim().replace(/\/+$/, "");
  if (!base || !/^[0-9a-fA-F]{64}$/.test(String(txId || ""))) return null;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), 10_000);
  try {
    const response = await fetch(`${base}/transactions/${encodeURIComponent(txId)}?inputs=false&outputs=false&resolve_previous_outpoints=no`, { headers: { Accept: "application/json" }, cache: "no-store", signal: controller?.signal });
    if (response.status === 404) return false;
    if (response.status !== 200) return null;
    const json = await response.json();
    return json?.is_accepted === true;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function renderHistory() {
  if (!history.length) return `<div class="swap-history-empty">No swaps yet.</div>`;
  return `<div class="swap-history-list">${history.map((swap) => `
    <div class="swap-history-item">
      <button type="button" class="profile-card swap-history-row" data-swap-open="${esc(swap.id)}">
        <span class="swap-history-copy">
          <strong>${historyLine(swap)}</strong>
          <small>${esc(dateText(swap.createdAt))} · ${esc(providerName(swap))}</small>
        </span>
        <span class="swap-status ${statusClass(swap.status)}">${esc(swapStatusName(swap.status))}</span>
      </button>
      <button type="button" class="swap-history-delete" data-swap-delete="${esc(swap.id)}" aria-label="Delete swap">${ICONS.trash}</button>
    </div>`).join("")}</div>`;
}

/** Redraws without touching what is being typed in: the screen is drawn off-page and swapped in
 *  around the focused field, which stays the same element (value, caret, keyboard). Rebuilding
 *  it on every keystroke - and focusing the new copy - made the page jump on phones each time
 *  Safari scrolled the new field into view. */
const FIELD_SELECTORS = { payout: "[data-swap-payout]", "payout-tag": "[data-swap-payout-tag]" };
function focusedFieldName(active) {
  if (!rootEl?.contains(active)) return null;
  if (active.dataset?.swapField) return active.dataset.swapField;
  if (active.matches?.("[data-swap-payout]")) return "payout";
  if (active.matches?.("[data-swap-payout-tag]")) return "payout-tag";
  return null;
}
function renderFormLight() {
  const active = document.activeElement;
  const field = focusedFieldName(active);
  if (!field) { render(); return; }
  const live = rootEl;
  const draft = document.createElement("div");
  rootEl = draft;
  try { render(); } finally { rootEl = live; }
  const twin = draft.querySelector(FIELD_SELECTORS[field] || `[data-swap-field="${field}"]`);
  if (!twin) { render(); return; }
  patchAround(live, draft, active, twin, { root: true });
}
/** Makes `oldNode` match `newNode` except along the path to `keep`, which stays in the page. The
 *  screen root keeps its own attributes: the draft is a bare <div>. */
function patchAround(oldNode, newNode, keep, newKeep, { root = false } = {}) {
  if (!root) syncAttributes(oldNode, newNode, oldNode === keep);
  if (oldNode === keep) return;
  const oldPath = [...oldNode.childNodes].find((n) => n === keep || n.contains?.(keep));
  const newKids = [...newNode.childNodes];
  const newPath = newKids.find((n) => n === newKeep || n.contains?.(newKeep));
  if (!oldPath || !newPath) { oldNode.replaceChildren(...newKids); return; }
  for (const n of [...oldNode.childNodes]) if (n !== oldPath) n.remove();
  const at = newKids.indexOf(newPath);
  for (const n of newKids.slice(0, at)) oldNode.insertBefore(n, oldPath);
  for (const n of newKids.slice(at + 1)) oldNode.appendChild(n);
  patchAround(oldPath, newPath, keep, newKeep);
}
function syncAttributes(oldEl, newEl, isKept) {
  if (oldEl.nodeType !== 1) return;
  for (const { name } of [...oldEl.attributes]) if (!newEl.hasAttribute(name)) oldEl.removeAttribute(name);
  for (const { name, value } of [...newEl.attributes]) {
    if (isKept && name === "value") continue; // the typed text is the field's own
    if (oldEl.getAttribute(name) !== value) oldEl.setAttribute(name, value);
  }
}

// ---------------------------------------------------------------------------
// Choices (iOS SwapService.flipDirection / setOtherCoin / setAmountText ...)
// ---------------------------------------------------------------------------
/** The pair changed, so the quoted side's figure is for a different pair: blank it until the new
 *  quote lands; the typed side stays as the input. */
function clearQuotedAmount() {
  if (editedSide === "send") receiveAmountText = "";
  else amountText = "";
}

/** The created exchange's deposit card goes once the coin, direction or account changes: it
 *  belongs to the exchange made, not to the coins picked now (K audit 2026-11-24 #2). */
function clearCreatedSwap() {
  if (createState.status === "creating") return;
  createState = { status: "idle", result: null, errorMessage: null };
}

function flipDirection() {
  kasIsSendSide = !kasIsSendSide;
  clearCreatedSwap();
  clearQuotedAmount();
  // kUSDT quotes from what is sent, in that coin's units: the figure typed for the other coin goes
  if (isKusdt()) { amountText = ""; receiveAmountText = ""; editedSide = "send"; }
  rescheduleEstimate();
}

function setOtherCoin(coin) {
  if (!coin) return;
  if (!sameCoin(coin, otherCoin)) {
    clearCreatedSwap();
    payoutExtraIdText = "";
    // Trestly's agreement put off goes back to the ChangeNOW coin picked before
    if (isTrestlyCoin(coin) && !isTrestlyCoin(otherCoin)) coinBeforeTrestly = otherCoin;
    agreementChecked = false;
  }
  const wasKusdt = isKusdt();
  otherCoin = coin;
  // Trestly's pool quotes from what you send, so a typed "You Get" moves to "You Send"; and a
  // figure typed in one coin's units isn't the other's
  if (isTrestlyCoin(coin) !== wasKusdt) { amountText = ""; receiveAmountText = ""; editedSide = "send"; }
  else if (isTrestlyCoin(coin) && editedSide === "get") { amountText = ""; editedSide = "send"; }
  kusdtQuote = null;
  clearQuotedAmount();
  rescheduleEstimate();
}

/** How many decimals the field for `coin` takes: kUSDT 6, the rest 8. */
function decimalsFor(coin) { return isTrestlyCoin(coin) ? 6 : 8; }

// ---------------------------------------------------------------------------
// Live quote (iOS rescheduleEstimate): debounced, re-fires on every relevant change. Nothing goes to
// a third party before its agreement.
// ---------------------------------------------------------------------------
function rescheduleEstimate() {
  if (estimateTimer) window.clearTimeout(estimateTimer);
  const token = ++estimateToken;
  kusdtQuote = null;
  if (!agreements[currentKind()]) {
    estimateState = IDLE_ESTIMATE;
    renderFormLight();
    return;
  }
  if (isKusdt()) { rescheduleKusdtEstimate(token); return; }
  const typed = cleanSwapAmount(editedSide === "send" ? amountText : receiveAmountText);
  if (!(Number(typed) > 0)) {
    estimateState = IDLE_ESTIMATE;
    renderFormLight();
    return;
  }
  const from = fromCoin();
  const to = toCoin();
  const side = editedSide;
  renderFormLight();
  estimateTimer = window.setTimeout(async () => {
    if (token !== estimateToken) return;
    estimateState = { ...IDLE_ESTIMATE, status: "loading" };
    renderFormLight();
    try {
      const quote = await quoter.quote({ side, from, to, amountText: typed });
      if (token !== estimateToken) return;
      // Both figures are ChangeNOW's; only the quoted card's text is replaced.
      if (side === "send") receiveAmountText = quote.getText;
      else amountText = quote.sendText;
      estimateState = { ...IDLE_ESTIMATE, status: "success", fromAmount: quote.fromAmount, toAmount: quote.toAmount };
    } catch (error) {
      if (token !== estimateToken) return;
      if (noteUnavailable(error)) return;
      estimateState = { ...IDLE_ESTIMATE, status: "failed", errorMessage: swapErrorText(error, "Unavailable") };
    }
    renderFormLight();
  }, 500);
}

/** kUSDT: Trestly's `prepare` for what was typed (nothing signed, no key), with no minimum, so the
 *  pool's own quote lands in "You Get". A paused pool or its circuit breaker says so instead. */
function rescheduleKusdtEstimate(token) {
  const buying = kasIsSendSide;
  const amountIn = kusdtSwapAmountIn(amountText, { buying });
  const target = kusdtTarget();
  if (amountIn == null || !target || !trade) {
    receiveAmountText = "";
    estimateState = IDLE_ESTIMATE;
    renderFormLight();
    return;
  }
  receiveAmountText = "";
  renderFormLight();
  estimateTimer = window.setTimeout(async () => {
    if (token !== estimateToken) return;
    estimateState = { ...IDLE_ESTIMATE, status: "loading" };
    renderFormLight();
    try {
      const quote = await quoteKusdtSwap(trade, { buying, amountIn, target });
      if (token !== estimateToken) return;
      kusdtQuote = { quote, amountIn, buying, address: target.address };
      receiveAmountText = kusdtQuoteText(quote, { buying });
      estimateState = { ...IDLE_ESTIMATE, status: "success", rateText: kusdtRateText({ buying, amountIn, quote, kusdtLabel: KUSDT_COIN.displayName }) };
    } catch (error) {
      if (token !== estimateToken) return;
      receiveAmountText = "";
      estimateState = { ...IDLE_ESTIMATE, status: "failed", errorMessage: String(error?.message || "Unavailable") };
    }
    renderFormLight();
  }, 500);
}

// ---------------------------------------------------------------------------
// Create / status (iOS executeSwap, refreshSwapStatusAsync)
// ---------------------------------------------------------------------------
async function executeSwap() {
  if (createState.status === "creating") return;
  if (!agreements[currentKind()]) { render(); return; }
  if (isKusdt()) { executeKusdtSwap(); return; }
  // `amountText` is what was typed under You Send, or the quote's answer for a typed You Get: the
  // exchange is always created from the send amount (standard flow), so for a You Get target the
  // deposit is the quoted figure and the payout floats with the rate, like any typed send.
  const amountStr = cleanSwapAmount(amountText);
  if (!(Number(amountStr) > 0)) return;
  const from = fromCoin();
  const to = toCoin();
  // the payout's tag, for a coin that may need one (K audit 2026-11-24 #1)
  const extraId = payoutExtraIdFor(to, payoutExtraIdText);
  if (extraId && !isValidMemo(to, extraId)) {
    createState = { status: "failed", result: null, errorMessage: SWAP_TEXT.badTag };
    deps.showToast?.(SWAP_TEXT.badTag);
    render();
    return;
  }
  // The account the swap is for: a switch while it is being created must not pay out to, or file
  // the swap under, the account switched to.
  const startedOn = account();
  if (!startedOn) return;
  const historyKey = deps.accountScopedKey(HISTORY_KEY);
  const sameAccount = () => account() === startedOn;
  createState = { status: "creating", result: null, errorMessage: null };
  render();
  try {
    let payoutAddress = "";
    if (to.ticker === "kas") {
      // A fresh, never-used spending address (the next legacy slot, iOS 28ecee0), reserved now that
      // the swap is real - unless one was picked on the "where" step (the Chatting Address too).
      if (payoutToChatting) {
        payoutAddress = startedOn;
      } else if (toAddressOverrideIndex != null) {
        payoutAddress = deps.spendingAddressAt(toAddressOverrideIndex) || "";
      } else {
        const freshIndex = await deps.revealNextSwapAddress();
        if (!sameAccount()) return;
        payoutAddress = freshIndex != null ? (deps.spendingAddressAt(freshIndex) || "") : "";
      }
    } else {
      payoutAddress = payoutAddressText.trim();
    }
    if (!payoutAddress) {
      createState = { status: "failed", result: null, errorMessage: `Enter an address to receive the ${to.displayName}.` };
      deps.showToast?.(createState.errorMessage);
      render();
      return;
    }
    const response = await client.create(from, to, amountStr, payoutAddress, extraId);
    const payin = String(response?.payinAddress ?? "").trim();
    // ChangeNOW's answer must be the exchange asked for: its payout address, both coins and the
    // amount. Otherwise its deposit address isn't shown, nor kept (K audit 2026-11-24 #6).
    const matches = Boolean(payin) && answerMatches(response, { from, to, amountText: amountStr, payoutAddress, extraId });
    if (!sameAccount()) {
      // Created for the account that was open: it goes into that account's history, and the screen
      // (already the other account's) is left alone.
      if (matches) {
        try {
          const stored = JSON.parse(localStorage.getItem(historyKey) || "[]");
          const list = Array.isArray(stored) ? stored : [];
          list.unshift(swapRecord(response, from, to, amountStr, payoutAddress, extraId));
          localStorage.setItem(historyKey, JSON.stringify(list));
        } catch { /* storage full or blocked */ }
      }
      return;
    }
    if (!payin || !matches) {
      createState = { status: "failed", result: null, errorMessage: payin ? SWAP_TEXT.answerMismatch : SWAP_TEXT.noDeposit };
      deps.showToast?.(createState.errorMessage);
      render();
      return;
    }
    const transaction = swapRecord(response, from, to, amountStr, payoutAddress, extraId);
    history.unshift(transaction);
    saveHistory();
    createState = { status: "success", result: { transaction, fromCoin: from, toCoin: to }, errorMessage: null };
    amountText = "";
    receiveAmountText = "";
    editedSide = "send";
    estimateState = IDLE_ESTIMATE;
    toAddressOverrideIndex = null;
    payoutToChatting = false;
    refreshToAddress();
    // its deposit screen (K: a ChangeNOW exchange made goes on to SwapDepositScreen)
    flowPath.push({ kind: "deposit", id: transaction.id });
  } catch (error) {
    if (!sameAccount()) return; // the other account's screen has nothing to do with it
    if (noteUnavailable(error)) { createState = { status: "idle", result: null, errorMessage: null }; return; }
    createState = { status: "failed", result: null, errorMessage: swapErrorText(error, SWAP_TEXT.swapFailed) };
    deps.showToast?.(createState.errorMessage);
  }
  render();
}

/** The history record (iOS SwapTransaction), with ChangeNOW's deposit tag and the payout's. */
export function swapRecord(response, from, to, amountStr, payoutAddress, extraId = null) {
  const payinTag = String(response?.payinExtraId ?? "").trim();
  return {
    id: String(response.id),
    fromTicker: from.ticker, fromNetwork: from.network,
    toTicker: to.ticker, toNetwork: to.network,
    fromAmount: amountStr,
    toAmount: response.toAmount != null ? String(response.toAmount) : "",
    payinAddress: String(response.payinAddress).trim(),
    payoutAddress,
    status: response.status || "new",
    createdAt: Date.now(),
    kasSendTxId: null,
    addedToPortfolio: false,
    payinExtraId: payinTag || null,
    payoutExtraId: extraId || null,
  };
}

/** kUSDT: Trestly's code prepares the swap with a minimum 1% under the quote, the approval sheet
 *  shows it, and only on Approve is it signed with the address's key and sent (engine/kusdt-trade.js). */
async function executeKusdtSwap() {
  const buying = kasIsSendSide;
  const amountIn = kusdtSwapAmountIn(amountText, { buying });
  const target = kusdtTarget();
  const q = kusdtQuote;
  if (!trade || amountIn == null || !target || !q || q.amountIn !== amountIn || q.buying !== buying || q.address !== target.address) return;
  const startedOn = account();
  createState = { status: "creating", result: null, errorMessage: null };
  render();
  try {
    const done = await trade.run({
      method: "kusdt_swap",
      params: { side: buying ? "buy" : "sell", amountIn: String(amountIn), minOut: String(minimumOut(q.quote)) },
      target,
      native: true,
      ask: (request) => askApproval(request),
      isClosed: () => !started || account() !== startedOn,
    });
    const record = kusdtSwapRecord(done);
    try { deps.kusdt?.noteSwap?.({ record, target, owner: startedOn }); } catch { /* the notice's own problem */ }
    if (account() === startedOn) {
      // and in Buy/Sell History, with the ChangeNOW swaps (K b49a021d)
      try { recordKusdtSwap(record, target.address); } catch { /* the history's own problem */ }
      // its own screen (K SwapSentScreen), from the order page
      if (currentStep().kind === "form") flowPath.push({ kind: "kusdtDone", message: record?.text || "Swap sent" });
      else deps.showToast?.(record?.text || "Swap sent");
      amountText = "";
      receiveAmountText = "";
      kusdtQuote = null;
      estimateState = IDLE_ESTIMATE;
      // The address's KAS and kUSDT moved: read again after each of the wallet's lookups, which
      // follow the trade until its coins show (K 961fc05a TokenWallet.followTrade); a trade with
      // no txid gets one look.
      const txid = typeof done?.result?.txid === "string" ? done.result.txid : null;
      if (txid && deps.kusdt?.followTrade) deps.kusdt.followTrade(txid, () => refreshKusdtBalances({ force: true }));
      else window.setTimeout(() => refreshKusdtBalances({ force: true }), 4500);
    }
    createState = { status: "idle", result: null, errorMessage: null };
  } catch (error) {
    if (error?.code === TRADE_CODE.rejected) {
      createState = { status: "idle", result: null, errorMessage: null };
    } else {
      const message = String(error?.message || SWAP_TEXT.swapFailed);
      createState = { status: account() === startedOn ? "failed" : "idle", result: null, errorMessage: message };
      if (account() === startedOn) deps.showToast?.(message);
    }
  }
  render();
}

// --- The approval (K TrestlyApprovalSheet, `native`) ------------------------------------------
/** Shows the approval and waits for Approve (true) or Decline; closing the sheet declines. */
function askApproval(request) {
  answerApproval(false);
  return new Promise((resolve) => {
    approval = { request, resolve, timer: null };
    const el = openSheet("approval", approvalSheetHtml(request, { esc, iconHtml: kusdtCoinIconHtml(36) }), "swap-sheet-tall");
    // Approve wakes a moment after the sheet appears, and never for a trade the pool would refuse
    const current = approval;
    current.timer = window.setTimeout(() => {
      if (approval !== current) return;
      const button = el.querySelector("[data-swap-approval-approve]");
      if (button && !approvalBlocked(request.prepared)) button.disabled = false;
    }, APPROVE_ARM_MS);
  });
}
/** Answers the open approval once; later calls do nothing. */
function answerApproval(approved) {
  const open = approval;
  if (!open) return;
  approval = null;
  if (open.timer) window.clearTimeout(open.timer);
  const el = sheetEls.get("approval");
  if (el) el.hidden = true;
  try { open.resolve(approved === true); } catch { /* answered */ }
}

/** Fresh status from ChangeNOW (history updated either way); null when it could not be reached. */
async function refreshSwapStatus(id) {
  // A kUSDT swap asks the network whether its transaction was accepted (K b49a021d).
  const trestly = history.find((s) => s.id === id && s.provider === "trestly");
  if (trestly) {
    const accepted = await transactionAccepted(id);
    if (accepted == null) return null;
    if (accepted && trestly.status !== "finished") { trestly.status = "finished"; saveHistory(); }
    return trestly.status;
  }
  try {
    const response = await client.status(id);
    const status = response?.status || null;
    if (!status) return null;
    const swap = history.find((s) => s.id === id);
    if (swap) { swap.status = status; saveHistory(); }
    return status;
  } catch (error) {
    noteUnavailable(error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sheets: coin picker, address pickers (+ actions), swap details, Add to Portfolio, the approval.
// Each is a `.modal-backdrop` with its card as the only child, so on a phone it rises from the
// bottom like every other sheet in the app; `data-close` is the control a drag-down presses.
// ---------------------------------------------------------------------------
const sheetEls = new Map();   // name -> backdrop element
const sheetState = {};        // name -> that sheet's state
function openSheet(name, html, extraClass = "") {
  let el = sheetEls.get(name);
  if (!el) {
    el = document.createElement("div");
    el.className = "modal-backdrop swap-sheet-backdrop";
    el.dataset.swapSheet = name;
    el.innerHTML = `<section class="contact-modal swap-sheet" role="dialog" aria-modal="true" data-swap-sheet-body></section>`;
    el.addEventListener("click", (event) => { if (event.target === el) closeSheet(name); });
    sheetEls.set(name, el);
  }
  // Always the topmost: a sheet opened from another sheet sits above it.
  document.body.appendChild(el);
  const body = el.querySelector("[data-swap-sheet-body]");
  body.className = `contact-modal swap-sheet${extraClass ? ` ${extraClass}` : ""}`;
  body.innerHTML = html;
  el.hidden = false;
  el.querySelectorAll("[data-swap-qr]").forEach((qr) => {
    if (qr.dataset.swapQr) deps.engine.drawQrFor(qr, qr.dataset.swapQr, { dark: "#06110f", light: "#ffffff" }).catch(() => {});
  });
  return el;
}
function isSheetOpen(name) {
  const el = sheetEls.get(name);
  return Boolean(el && !el.hidden && el.isConnected);
}
function closeSheet(name) {
  const el = sheetEls.get(name);
  if (el) el.hidden = true;
  delete sheetState[name];
  // closing the approval declines it
  if (name === "approval") answerApproval(false);
}
function closeAllSheets() {
  for (const name of [...sheetEls.keys()]) closeSheet(name);
}

function sheetHeader(title, { closeLabel = "Cancel" } = {}) {
  return `<div class="swap-sheet-header">
    <button type="button" class="swap-link" data-swap-sheet-close data-close>${esc(closeLabel)}</button>
    <h2>${esc(title)}</h2>
    <span class="swap-sheet-spacer" aria-hidden="true"></span>
  </div>`;
}

// --- Coin picker (iOS SwapCoinPickerView): kUSDT first ----------------------------------------
function coinPickerRows() {
  const rows = [{ kind: "coin", coin: KUSDT_COIN }];
  const st = sheetState.coin;
  for (const ticker of PINNED_GROUP_TICKERS) {
    const displayName = GROUPED_TICKERS[ticker];
    if (!displayName) continue;
    rows.push({ kind: "group", ticker, displayName });
    if (st.expanded.has(ticker)) for (const coin of CURATED_COINS) if (coin.ticker === ticker) rows.push({ kind: "network", coin });
  }
  for (const coin of CURATED_COINS) if (!GROUPED_TICKERS[coin.ticker]) rows.push({ kind: "coin", coin });
  const query = String(st.query || "").trim().toLowerCase();
  if (!query) return rows;
  return rows.filter((row) => {
    const name = row.kind === "group" ? row.displayName : row.coin.displayName;
    const ticker = row.kind === "group" ? row.ticker : row.coin.ticker;
    return name.toLowerCase().includes(query) || ticker.toLowerCase().includes(query);
  });
}
function renderCoinPicker({ keepSearchFocus = false } = {}) {
  const st = sheetState.coin;
  if (!st) return;
  const list = coinPickerRows().map((row) => {
    if (row.kind === "group") {
      const representative = CURATED_COINS.find((c) => c.ticker === row.ticker);
      const expanded = st.expanded.has(row.ticker);
      return `<button type="button" class="swap-picker-row" data-swap-group="${esc(row.ticker)}" aria-expanded="${expanded}">${coinIcon(representative)}<span class="swap-picker-name">${esc(row.displayName)}</span>${otherCoin.ticker === row.ticker ? ICONS.check : ""}<span class="swap-picker-chevron${expanded ? " open" : ""}">${ICONS.chevronDown}</span></button>`;
    }
    const coin = row.coin;
    return `<button type="button" class="swap-picker-row${row.kind === "network" ? " indented" : ""}" data-swap-coin="${esc(`${coin.ticker}:${coin.network}`)}">${coinIcon(coin)}<span class="swap-picker-name">${esc(coin.displayName)}</span>${sameCoin(coin, otherCoin) ? ICONS.check : ""}</button>`;
  }).join("");
  const el = openSheet("coin", `${sheetHeader("Choose Coin")}
    <input class="field-input swap-search" type="search" data-swap-coin-search placeholder="Search coins" value="${esc(st.query || "")}" autocomplete="off" />
    <div class="swap-picker-list">${list}</div>`, "swap-sheet-tall");
  if (keepSearchFocus) {
    const input = el.querySelector("[data-swap-coin-search]");
    input?.focus();
    try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* not supported */ }
  }
}

// --- kUSDT: which address swaps (K 5.4 KusdtSwapFromPicker) ------------------------------------
async function openKusdtFromPicker() {
  sheetState["kusdt-from"] = { choices: [], loading: true };
  renderKusdtFromPicker();
  let choices = [];
  try { choices = (await deps.kusdt?.fromChoices?.()) || []; } catch { choices = []; }
  const st = sheetState["kusdt-from"];
  if (!st) return;
  st.choices = choices;
  st.loading = false;
  renderKusdtFromPicker();
}
function renderKusdtFromPicker() {
  const st = sheetState["kusdt-from"];
  if (!st) return;
  const current = kusdtTarget()?.address;
  const rows = st.choices.map((c, i) => {
    const on = c.address === current;
    const kas = c.kasSompi == null ? "--" : kasAmountLabel(c.kasSompi);
    return `<button type="button" class="swap-picker-row address swap-kusdt-from-row" data-swap-kusdt-pick="${i}" aria-pressed="${on}">
      <span class="swap-kusdt-from-mark${on ? " on" : ""}">${on ? ICONS.checkCircle : ICONS.circle}</span>
      <span class="swap-address-copy"><small>${esc(c.label)}</small><strong>${esc(shortMiddle(c.address))}</strong><small>${esc(`${kas} · ${formatKusdt(c.units ?? 0n)}`)}</small></span>
    </button>`;
  }).join("");
  openSheet("kusdt-from", `${sheetHeader("Swap From")}
    <p class="swap-picker-footer">${esc(SWAP_TEXT.kusdtFromNote)}</p>
    ${st.loading && !st.choices.length
      ? `<div class="swap-checking"><span class="kaposts-spinner" aria-hidden="true"></span></div>`
      : `<div class="swap-picker-list">${rows}</div>`}`, "swap-sheet-tall");
}

// --- Address picker (iOS SwapAddressPickerView) ----------------------------------------------
async function openAddressPicker() {
  sheetState.address = { entries: [], loading: true, generating: false };
  renderAddressPicker();
  const entries = await deps.listSpendingAddresses().catch(() => []);
  if (!sheetState.address) return;
  sheetState.address.entries = entries;
  sheetState.address.loading = false;
  renderAddressPicker();
}
function renderAddressPicker() {
  const st = sheetState.address;
  if (!st) return;
  // A swap payout goes to a FRESH address - reusing one publishes the link between this swap and
  // everything that address has done - so used ones are filtered out, not merely marked. The
  // badge stays on each row: "used" comes from a network check that can fail.
  const selectable = st.entries.filter((e) => !e.hidden && !e.used);
  const rows = selectable.map((e) => `<button type="button" class="swap-picker-row address" data-swap-address="${e.index}">
      <span class="swap-address-copy"><small>${esc(e.label)} <b class="${e.used ? "used" : "unused"}">${e.used ? "Used" : "Unused"}</b></small><strong>${esc(e.shortAddress)}</strong></span>
      <span class="swap-address-kas">${esc(formatQuotedAmount(e.kas))} KAS</span>
    </button>`).join("");
  openSheet("address", `${sheetHeader("Choose Address")}
    ${st.loading && !st.entries.length
      ? `<div class="swap-checking"><span class="kaposts-spinner" aria-hidden="true"></span></div>`
      : `<div class="swap-picker-section">
          <button type="button" class="swap-picker-row generate" data-swap-generate-address ${st.generating ? "disabled" : ""}>${ICONS.plusCircle}<span class="swap-picker-name">Generate New Address</span>${st.generating ? `<span class="kaposts-spinner small" aria-hidden="true"></span>` : ""}</button>
        </div>
        <p class="swap-picker-footer">A swap pays out to an address you have not used before, so the payout cannot be tied to your earlier activity. Generate one if none are free.</p>
        <p class="swap-picker-header">Unused Addresses</p>
        <div class="swap-picker-list">${selectable.length ? rows : `<p class="swap-picker-empty">Every address here has been used. Generate a new one above.</p>`}</div>`}`, "swap-sheet-tall");
}
/** Tap an address: look at it first, or take it (iOS addressActionsSheet). */
function openAddressActions(entry) {
  sheetState["address-actions"] = { entry };
  openSheet("address-actions", `<div class="swap-actions-head">
      <strong>${esc(entry.label)}</strong>
      <small>${esc(entry.shortAddress)}</small>
      <button type="button" class="modal-close swap-actions-close" data-swap-sheet-close data-close aria-label="Close">×</button>
    </div>
    <div class="cold-action-rows">
      ${actionRow({ attr: "data-swap-address-explorer", title: "View in Explorer", subtitle: "Check its history before you send a swap to it.", icon: ICONS.safari })}
      ${actionRow({ attr: "data-swap-address-use", title: "Use for This Swap", subtitle: "ChangeNOW pays the swapped KAS out to this address.", icon: ICONS.arrowDownCircle })}
    </div>`);
}
function actionRow({ attr, title, subtitle, icon, warn = false }) {
  return `<button type="button" class="cold-action-row${warn ? " cold-action-row-warn" : ""}" ${attr}>
      <span class="cold-action-icon" aria-hidden="true">${icon}</span>
      <span class="cold-action-copy"><strong>${esc(title)}</strong><small>${esc(subtitle)}</small></span>
    </button>`;
}

// --- Swap details (iOS SwapDetailView) -------------------------------------------------------
function renderSwapDetails(id) {
  const swap = history.find((s) => s.id === id);
  if (!swap) { closeSheet("details"); return; }
  const refreshing = Boolean(sheetState.details?.id === id && sheetState.details.refreshing);
  sheetState.details = { id, refreshing };
  const statusRow = `<p class="swap-details-label">Status</p>
      <div class="swap-details-group swap-details-status"><strong class="swap-status ${statusClass(swap.status)}">${esc(swapStatusName(swap.status))}</strong>${swap.status === "finished" ? `<button type="button" class="swap-link strong" data-swap-add-portfolio="${esc(swap.id)}">Add to Portfolio</button>` : ""}</div>`;
  const refreshButton = `<button type="button" class="swap-details-action" data-swap-refresh="${esc(swap.id)}" ${refreshing ? "disabled" : ""}><span>Refresh Status</span>${refreshing ? `<span class="kaposts-spinner small" aria-hidden="true"></span>` : ""}</button>`;
  // A kUSDT swap through Trestly's pool on Kaspa (K b49a021d): the address it traded from, its
  // status and its Kaspa transaction. No deposit address or exchange id: nothing went to a third party.
  if (swap.provider === "trestly") {
    const txUrl = deps.explorerTxUrl?.(swap.id) || "";
    openSheet("details", `${sheetHeader("Swap Details", { closeLabel: "Done" })}
    <div class="swap-details">
      <div class="swap-details-group">
        <div class="swap-details-head">
          <strong>${historyLine(swap)}</strong>
          <small>${esc(dateText(swap.createdAt))}</small>
        </div>
      </div>
      <p class="swap-details-label">Swapped Through</p>
      <div class="swap-details-group"><span class="swap-details-text">Trestly's kUSDT pool on Kaspa</span></div>
      <p class="swap-details-label">Address</p>
      <div class="swap-details-group"><button type="button" class="swap-mono-button light" data-swap-copy="${esc(swap.payoutAddress)}">${esc(swap.payoutAddress)}</button></div>
      ${statusRow}
      <p class="swap-details-label">Transaction ID</p>
      <div class="swap-details-group"><button type="button" class="swap-mono-button light" data-swap-copy-txid="${esc(swap.id)}">${esc(swap.id)}</button></div>
      <div class="swap-details-group swap-details-actions">
        ${refreshButton}
        ${txUrl ? `<a class="swap-details-action" href="${esc(txUrl)}" target="_blank" rel="noopener noreferrer">View in Explorer</a>` : ""}
      </div>
    </div>`, "swap-sheet-tall");
    return;
  }
  openSheet("details", `${sheetHeader("Swap Details", { closeLabel: "Done" })}
    <div class="swap-details">
      <div class="swap-details-group">
        <div class="swap-details-head">
          <strong>${historyLine(swap)}</strong>
          <small>${esc(dateText(swap.createdAt))}</small>
        </div>
        <canvas class="swap-qr" data-swap-qr="${esc(swap.payinAddress)}" width="180" height="180"></canvas>
      </div>
      <p class="swap-details-label">Deposit Address</p>
      <div class="swap-details-group"><button type="button" class="swap-mono-button light" data-swap-copy="${esc(swap.payinAddress)}">${esc(swap.payinAddress)}</button></div>
      ${swap.payinExtraId ? `<div class="swap-details-group">${depositTagBox(swap.payinExtraId)}</div>` : ""}
      <p class="swap-details-label">Payout Address</p>
      <div class="swap-details-group"><button type="button" class="swap-mono-button light" data-swap-copy="${esc(swap.payoutAddress)}">${esc(swap.payoutAddress)}</button>${swap.payoutExtraId ? `<small class="swap-details-tag">Destination Tag: ${esc(swap.payoutExtraId)}</small>` : ""}</div>
      ${statusRow}
      <p class="swap-details-label">ChangeNOW Exchange ID</p>
      <div class="swap-details-group"><button type="button" class="swap-mono-button light" data-swap-copy-id="${esc(swap.id)}">${esc(swap.id)}</button></div>
      <div class="swap-details-group swap-details-actions">
        ${refreshButton}
        <a class="swap-details-action" href="https://changenow.io/exchange/txs/${encodeURIComponent(swap.id)}" target="_blank" rel="noopener noreferrer">View on ChangeNOW</a>
      </div>
    </div>`, "swap-sheet-tall");
}

// --- Add to Portfolio (iOS 9df2847: chooses the portfolio on a half sheet) --------------------
/** One whole sentence per side (K audit 2026-11-24 #34). */
export function portfolioPromptText(prefill, symbol) {
  const amount = formatQuotedAmount(prefill.amountKas);
  const price = `${symbol}${Number(prefill.fiatValue).toFixed(2)}`;
  return prefill.type === "buy"
    ? `Buy ${amount} KAS at ${price} - choose which portfolio to add it to.`
    : `Sell ${amount} KAS at ${price} - choose which portfolio to add it to.`;
}
function openAddToPortfolio(swap) {
  const prefill = portfolioPrefill(swap);
  if (!prefill) { deps.showToast?.("Couldn't read this swap's amounts"); return; }
  const sourceTxId = swapSourceTxId(swap.id);
  // Portfolios that already hold this swap are flagged while the choice is being made, rather than
  // the ledger quietly counting it twice.
  const duplicates = portfolioIdsContainingTx(sourceTxId);
  const portfolios = listPortfolios();
  sheetState.portfolio = { swapId: swap.id, prefill, sourceTxId, portfolios };
  const line = portfolioPromptText(prefill, deps.currencySymbol());
  openSheet("portfolio", `<div class="swap-actions-head">
      <strong>Add to Portfolio</strong>
      <small>${esc(line)}</small>
      <button type="button" class="modal-close swap-actions-close" data-swap-sheet-close data-close aria-label="Close">×</button>
    </div>
    <div class="cold-action-rows swap-portfolio-rows">
      ${portfolios.map((p) => {
        const duplicate = duplicates.has(p.id);
        return actionRow({
          attr: `data-swap-portfolio-pick="${esc(p.id)}"`,
          title: p.name,
          subtitle: duplicate ? "Already holds this swap - adding it again double-counts it." : "The swap lands in this portfolio.",
          icon: duplicate ? ICONS.warning : ICONS.chartPie,
          warn: duplicate,
        });
      }).join("")}
    </div>`);
}
function confirmAddToPortfolio(portfolioId) {
  const st = sheetState.portfolio;
  if (!st) return;
  addTransactionToPortfolio(portfolioId, { ...st.prefill, sourceTxId: st.sourceTxId });
  const swap = history.find((s) => s.id === st.swapId);
  if (swap) { swap.addedToPortfolio = true; saveHistory(); }
  const name = st.portfolios.find((p) => p.id === portfolioId)?.name || "portfolio";
  closeSheet("portfolio");
  deps.showToast?.(`Added to ${name}`);
  render(); // Purchase / Sale Complete reads Added to Portfolio
}

// ---------------------------------------------------------------------------
// Shared actions
// ---------------------------------------------------------------------------
async function copyAddress(value) {
  try { await deps.copyTextToClipboard(value); deps.showToast?.(deps.addressCopiedToastText(value)); } catch { /* clipboard refused */ }
}
async function copyExchangeId(value) {
  try { await deps.copyTextToClipboard(value); deps.showToast?.("Exchange ID copied"); } catch { /* clipboard refused */ }
}
async function copyTag(value) {
  try { await deps.copyTextToClipboard(value); deps.showToast?.("Destination tag copied"); } catch { /* clipboard refused */ }
}

/** "Not Now" on an agreement: Trestly's put off goes back to the ChangeNOW coin picked before (or
 *  leaves Swap); ChangeNOW's leaves Swap. */
function putOffAgreement() {
  const kind = currentKind();
  agreementChecked = false;
  if (kind === "trestly" && coinBeforeTrestly && !isTrestlyCoin(coinBeforeTrestly)) {
    setOtherCoin(coinBeforeTrestly);
    render();
    return;
  }
  // the order isn't left waiting behind its agreement: the dock's Buy/Sell starts over
  flowPath = [];
  flowStart = "home";
  deps.leaveSwap?.();
  render();
}

// ---------------------------------------------------------------------------
// Public API (ui/app.js)
// ---------------------------------------------------------------------------
/** The screen came up: the payout preview is re-derived, and a site that had no key is asked again. */
export function refreshSwaps() {
  if (!started) return;
  refreshToAddress();
  if (availability !== "on") probeAvailability();
  render();
}

/** Swap with this coin picked ("kusdt", or "ticker:network"): the Wallet's kUSDT screens. */
export function selectSwapCoin(key) {
  if (!started) return;
  const coin = key === "kusdt" ? KUSDT_COIN : coinByKey(key);
  if (!coin) return;
  // straight on the order for that coin, as K's kUSDT screens open Swap
  flowStart = isTrestlyCoin(coin) ? "sell" : "buy";
  flowPath = [];
  choosePair(coin, isTrestlyCoin(coin));
}

/** Another account (or none): nothing of the last one's swap stays on screen or goes into the next
 *  one's requests - its history, agreements, picked addresses, typed payout and tag, quote, created
 *  exchange, and any approval waiting (declined) (K audit 2026-11-24 #5). */
export function resetSwapsForAccount() {
  if (!started) return;
  closeAllSheets();
  answerApproval(false);
  loadState();
  agreementChecked = false;
  coinBeforeTrestly = null;
  createState = { status: "idle", result: null, errorMessage: null };
  amountText = "";
  receiveAmountText = "";
  editedSide = "send";
  payoutAddressText = "";
  payoutExtraIdText = "";
  estimateState = IDLE_ESTIMATE;
  estimateToken += 1;
  if (estimateTimer) window.clearTimeout(estimateTimer);
  kusdtFrom = null;
  kusdtQuote = null;
  toAddressOverrideIndex = null;
  payoutToChatting = false;
  flowStart = "home";
  flowPath = [];
  refreshToAddress();
  render();
}

/** Opens the flow where the Wallet asked (K SwapView Start): "buy", "sell", "history" or "home".
 *  `toChatting`: opened to fund the chatting address, so bought Kaspa is set to land there. */
export function openSwapFlow(start = "home", { toChatting = false } = {}) {
  if (!started) return;
  flowStart = ["buy", "sell", "history"].includes(start) ? start : "home";
  flowPath = [];
  toChattingStart = Boolean(toChatting);
  coinListState = { query: "", expanded: new Set() };
  clearCreatedSwap();
  render();
}

export function initSwaps(dependencies) {
  deps = dependencies;
  rootEl = document.querySelector("[data-swaps-root]");
  if (!rootEl) return;
  started = true;
  if (deps.kusdt?.tradeDeps) {
    try { trade = createTrestlyTrade(deps.kusdt.tradeDeps); } catch { trade = null; }
  }
  loadState();
  refreshToAddress();
  probeAvailability();

  rootEl.addEventListener("input", (event) => {
    const field = event.target.closest("[data-swap-field]");
    if (field) {
      if (field.readOnly) return;
      // Cleaned as every amount field is: "1,5" is 1.5, never 15 (K audit 2026-11-24 #3).
      const coin = field.dataset.swapField === "send" ? fromCoin() : toCoin();
      const value = cleanSwapAmount(field.value, decimalsFor(coin));
      if (field.value !== value) field.value = value;
      if (field.dataset.swapField === "send") {
        // "You Send" typed: the You Get figure is stale until the quote lands.
        amountText = value;
        editedSide = "send";
        receiveAmountText = "";
      } else {
        // "You Get" typed: the quote fills You Send with what that costs.
        receiveAmountText = value;
        editedSide = "get";
        amountText = "";
      }
      rescheduleEstimate();
      return;
    }
    const payout = event.target.closest("[data-swap-payout]");
    if (payout) { payoutAddressText = payout.value; return; }
    const tag = event.target.closest("[data-swap-payout-tag]");
    if (tag) payoutExtraIdText = tag.value;
  });
  rootEl.addEventListener("change", (event) => {
    if (event.target.closest("[data-swap-terms]")) { agreementChecked = event.target.checked; render(); }
  });
  rootEl.addEventListener("click", async (event) => {
    if (event.target.closest("[data-swap-retry]")) { availability = "checking"; render(); probeAvailability(); return; }
    if (event.target.closest("[data-swap-max]")) {
      // Max: "You Send" becomes all that can go (K 6b99c6dd SwapService.setMaxAmount)
      const max = isKusdt() ? kusdtMaxSend({ buying: kasIsSendSide, ...currentKusdtBalances() }) : null;
      if (max == null || max <= 0n) return;
      amountText = kusdtMaxText(max, kasIsSendSide);
      editedSide = "send";
      receiveAmountText = "";
      const field = rootEl.querySelector('[data-swap-field="send"]');
      if (field) field.value = amountText;
      rescheduleEstimate();
      return;
    }
    if (event.target.closest("[data-swap-own-key-save]")) {
      const key = String(rootEl.querySelector("[data-swap-own-key]")?.value || "").trim();
      if (!PASTED_KEY_RE.test(key)) { pastedKeyError = "That doesn't look like a ChangeNOW API key - copy it again from your ChangeNOW account."; render(); return; }
      pastedKeyError = "";
      savePastedKey(key);
      availability = "on";
      render();
      rescheduleEstimate();
      return;
    }
    if (event.target.closest("[data-swap-own-key-change]")) {
      savePastedKey("");
      pastedKeyError = "";
      availability = "needs-key";
      render();
      return;
    }
    if (event.target.closest("[data-swap-back]")) {
      if (flowPath.length) flowPath.pop(); else flowStart = "home";
      render();
      return;
    }
    if (event.target.closest("[data-swap-done]")) {
      flowPath = [];
      flowStart = "home";
      deps.leaveSwap?.();
      render();
      return;
    }
    const startButton = event.target.closest("[data-swap-start]");
    if (startButton) { openSwapFlow(startButton.dataset.swapStart); return; }
    const group = event.target.closest("[data-swap-choice-group]");
    if (group) {
      const ticker = group.dataset.swapChoiceGroup;
      if (coinListState.expanded.has(ticker)) coinListState.expanded.delete(ticker); else coinListState.expanded.add(ticker);
      const list = rootEl.querySelector("[data-swap-choice-list]");
      if (list) list.innerHTML = renderCoinChoiceList(); else render();
      return;
    }
    const choice = event.target.closest("[data-swap-choice]");
    if (choice) {
      const coin = choice.dataset.swapChoice === "kusdt" ? KUSDT_COIN : coinByKey(choice.dataset.swapChoice);
      if (coin) choosePair(coin, currentStep().kind === "sell");
      return;
    }
    if (event.target.closest("[data-swap-dest-fresh]")) {
      destinationChoosing = false;
      payoutToChatting = false;
      toAddressOverrideIndex = null;
      refreshToAddress();
      render();
      return;
    }
    if (event.target.closest("[data-swap-dest-choose]")) { destinationChoosing = true; render(); return; }
    if (event.target.closest("[data-swap-dest-chatting]")) {
      payoutToChatting = true;
      toAddressOverrideIndex = null;
      render();
      return;
    }
    const destIndex = event.target.closest("[data-swap-dest-index]");
    if (destIndex) {
      payoutToChatting = false;
      toAddressOverrideIndex = Number(destIndex.dataset.swapDestIndex);
      refreshToAddress();
      render();
      return;
    }
    const destKusdt = event.target.closest("[data-swap-dest-kusdt]");
    if (destKusdt) {
      const c = sheetState.destinationKusdt?.choices?.[Number(destKusdt.dataset.swapDestKusdt)];
      if (!c) return;
      kusdtFrom = c.spendingIndex == null ? null : { label: c.label, address: c.address, spendingIndex: c.spendingIndex };
      kusdtQuote = null;
      render();
      return;
    }
    if (event.target.closest("[data-swap-continue]")) {
      if (destinationChoosing && !isKusdt() && !payoutToChatting && toAddressOverrideIndex == null) return;
      flowPath.push({ kind: "form" });
      rescheduleEstimate();
      render();
      return;
    }
    const copyAmount = event.target.closest("[data-swap-copy-amount]");
    if (copyAmount) {
      try { await deps.copyTextToClipboard(copyAmount.dataset.swapCopyAmount); deps.showToast?.("Amount copied"); } catch { /* clipboard refused */ }
      return;
    }
    const sendKas = event.target.closest("[data-swap-send-kas]");
    if (sendKas) {
      const swap = history.find((x) => x.id === sendKas.dataset.swapSendKas);
      if (swap) deps.sendKasTo?.({ address: swap.payinAddress, amountText: swap.fromAmount });
      return;
    }
    const addPortfolio = event.target.closest("[data-swap-add-portfolio]");
    if (addPortfolio && rootEl.contains(addPortfolio)) {
      const swap = history.find((x) => x.id === addPortfolio.dataset.swapAddPortfolio);
      if (swap) openAddToPortfolio(swap);
      return;
    }
    if (event.target.closest("[data-swap-agree]")) {
      if (!agreementChecked) return;
      acceptAgreement(currentKind());
      agreementChecked = false;
      render();
      rescheduleEstimate();
      return;
    }
    if (event.target.closest("[data-swap-not-now]")) { putOffAgreement(); return; }
    if (event.target.closest("[data-swap-pick-kusdt]")) { setOtherCoin(KUSDT_COIN); render(); return; }
    if (event.target.closest("[data-swap-flip]")) { flipDirection(); return; }
    if (event.target.closest("[data-swap-create]")) { executeSwap(); return; }
    if (event.target.closest("[data-swap-pick-coin]")) {
      sheetState.coin = { query: "", expanded: new Set() };
      renderCoinPicker();
      return;
    }
    if (event.target.closest("[data-swap-kusdt-from]")) { openKusdtFromPicker(); return; }
    if (event.target.closest("[data-swap-change-address]")) { openAddressPicker(); return; }
    if (event.target.closest("[data-swap-open-spending]")) { deps.openSpendingAddresses?.(); return; }
    const copyTagButton = event.target.closest("[data-swap-copy-tag]");
    if (copyTagButton) { copyTag(copyTagButton.dataset.swapCopyTag); return; }
    const copy = event.target.closest("[data-swap-copy]");
    if (copy) { copyAddress(copy.dataset.swapCopy); return; }
    const copyId = event.target.closest("[data-swap-copy-id]");
    if (copyId) { copyExchangeId(copyId.dataset.swapCopyId); return; }
    const refresh = event.target.closest("[data-swap-refresh]");
    if (refresh) {
      const status = await refreshSwapStatus(refresh.dataset.swapRefresh);
      deps.showToast?.(status ? `Status: ${swapStatusName(status)}` : "Couldn't reach ChangeNOW - try again");
      render();
      return;
    }
    const open = event.target.closest("[data-swap-open]");
    if (open) { renderSwapDetails(open.dataset.swapOpen); return; }
    const del = event.target.closest("[data-swap-delete]");
    if (del) {
      const ok = await confirmDialog({
        title: "Delete this swap?",
        message: "This only removes it from your local history - it doesn't affect the actual exchange.",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!ok) return;
      history = history.filter((s) => s.id !== del.dataset.swapDelete);
      saveHistory();
      render();
    }
  });

  document.addEventListener("click", async (event) => {
    const backdrop = event.target.closest?.("[data-swap-sheet]");
    if (!backdrop || backdrop.hidden) return;
    const name = backdrop.dataset.swapSheet;

    if (name === "approval") {
      if (event.target.closest("[data-swap-approval-decline]")) { answerApproval(false); return; }
      const approve = event.target.closest("[data-swap-approval-approve]");
      if (approve && !approve.disabled && approval && !approvalBlocked(approval.request.prepared)) answerApproval(true);
      return;
    }
    if (event.target.closest("[data-swap-sheet-close]")) { closeSheet(name); return; }

    if (name === "coin") {
      const group = event.target.closest("[data-swap-group]");
      if (group && sheetState.coin) {
        const ticker = group.dataset.swapGroup;
        if (sheetState.coin.expanded.has(ticker)) sheetState.coin.expanded.delete(ticker);
        else sheetState.coin.expanded.add(ticker);
        renderCoinPicker();
        return;
      }
      const coinRow = event.target.closest("[data-swap-coin]");
      if (coinRow) {
        const picked = coinByKey(coinRow.dataset.swapCoin);
        closeSheet("coin");
        if (picked) { setOtherCoin(picked); render(); }
      }
      return;
    }

    if (name === "kusdt-from") {
      const row = event.target.closest("[data-swap-kusdt-pick]");
      const st = sheetState["kusdt-from"];
      if (!row || !st) return;
      const choice = st.choices[Number(row.dataset.swapKusdtPick)];
      closeSheet("kusdt-from");
      if (!choice) return;
      kusdtFrom = choice.spendingIndex == null ? null : { label: choice.label, address: choice.address, spendingIndex: choice.spendingIndex };
      kusdtQuote = null;
      rescheduleEstimate();
      render();
      return;
    }

    if (name === "address") {
      const st = sheetState.address;
      if (!st) return;
      if (event.target.closest("[data-swap-generate-address]")) {
        if (st.generating) return;
        st.generating = true;
        renderAddressPicker();
        try { await deps.revealNextSwapAddress(); } catch { /* the toast came from the reveal */ }
        const entries = await deps.listSpendingAddresses().catch(() => st.entries);
        if (sheetState.address !== st) return;
        st.entries = entries;
        st.generating = false;
        renderAddressPicker();
        return;
      }
      const row = event.target.closest("[data-swap-address]");
      if (row) {
        const entry = st.entries.find((e) => e.index === Number(row.dataset.swapAddress));
        if (entry) openAddressActions(entry);
      }
      return;
    }

    if (name === "address-actions") {
      const entry = sheetState["address-actions"]?.entry;
      if (!entry) return;
      if (event.target.closest("[data-swap-address-explorer]")) {
        closeSheet("address-actions");
        window.open(deps.explorerAddressUrl(entry.address), "_blank", "noopener,noreferrer");
        return;
      }
      if (event.target.closest("[data-swap-address-use]")) {
        closeSheet("address-actions");
        closeSheet("address");
        toAddressOverrideIndex = entry.index;
        refreshToAddress();
        render();
      }
      return;
    }

    if (name === "details") {
      const copyTagButton = event.target.closest("[data-swap-copy-tag]");
      if (copyTagButton) { copyTag(copyTagButton.dataset.swapCopyTag); return; }
      const copy = event.target.closest("[data-swap-copy]");
      if (copy) { copyAddress(copy.dataset.swapCopy); return; }
      const copyId = event.target.closest("[data-swap-copy-id]");
      if (copyId) { copyExchangeId(copyId.dataset.swapCopyId); return; }
      const copyTxid = event.target.closest("[data-swap-copy-txid]");
      if (copyTxid) {
        try { await deps.copyTextToClipboard(copyTxid.dataset.swapCopyTxid); deps.showToast?.("Transaction ID copied"); } catch { /* clipboard refused */ }
        return;
      }
      const refresh = event.target.closest("[data-swap-refresh]");
      if (refresh) {
        const st = sheetState.details;
        const isTrestly = history.some((s) => s.id === refresh.dataset.swapRefresh && s.provider === "trestly");
        if (!st || st.refreshing) return;
        st.refreshing = true;
        renderSwapDetails(st.id);
        const status = await refreshSwapStatus(refresh.dataset.swapRefresh);
        if (sheetState.details?.id === st.id && isSheetOpen("details")) {
          sheetState.details.refreshing = false;
          renderSwapDetails(st.id);
        }
        deps.showToast?.(status ? `Status: ${swapStatusName(status)}` : isTrestly ? "Couldn't reach the network - try again" : "Couldn't reach ChangeNOW - try again");
        render();
        return;
      }
      const addTo = event.target.closest("[data-swap-add-portfolio]");
      if (addTo) {
        const swap = history.find((s) => s.id === addTo.dataset.swapAddPortfolio);
        closeSheet("details");
        if (swap) openAddToPortfolio(swap);
      }
      return;
    }

    if (name === "portfolio") {
      const pick = event.target.closest("[data-swap-portfolio-pick]");
      if (pick) confirmAddToPortfolio(pick.dataset.swapPortfolioPick);
    }
  });
  document.addEventListener("input", (event) => {
    const search = event.target.closest?.("[data-swap-coin-search]");
    if (search && sheetState.coin) { sheetState.coin.query = search.value; renderCoinPicker({ keepSearchFocus: true }); }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const open = [...sheetEls.entries()].filter(([, el]) => !el.hidden && el.isConnected);
    if (!open.length) return;
    // The topmost one: the last in the page.
    open.sort(([, a], [, b]) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    closeSheet(open[open.length - 1][0]);
  });

  render();
}
