// One trade on Trestly's pool, as K makes it: port of K iOS Services/Tokens/TrestlyTrade.swift
// (K 518fdc8c, kusdt-open SPEC §14-15). Swap's kUSDT side (ui/swaps.js) is its one caller here.
//
// 1. Trestly's own pinned code (kusdt/kusdt-wallet.js, engine/kusdt-wallet-core.js) checks the pool
//    and quotes: `prepare`, nothing signed or sent, no key.
// 2. K shows it (`ask`, the approval sheet). Decline, or a closed screen, ends it: nothing is sent.
// 3. Only on Approve is the address's key taken (`secretFor`), checked to be that address's own,
//    and handed to their `execute` to build, sign and send. The key's bytes are zeroed and the
//    request's copy dropped whatever happens (answer, refusal, time-out).
// 4. A pool that moved to a worse quote comes back as a requote: nothing was sent, their code
//    prepares again from scratch and the sheet asks again, showing what was seen before.
// Also as iOS: one trade per address at a time; a trade that may have gone out (no answer from
// `execute`, or their `maybeSent`) holds its address for 10 minutes, kept across reloads, ending
// early once a coin it had before is spent; and the coins a trade spent are held back like a send's
// own (engine/transactions.js noteSpentOutpoints), so the next send can't pick them.
//
// Amounts are exact: base units as BigInt (sompi for KAS, 10^-6 for kUSDT); their JSON writes
// them as digit strings. No DOM; dependency-injected for tools/test-swap-k54.mjs.

import { schnorr } from "@noble/curves/secp256k1.js";
import { schnorrOwner, kusdtUnitsFromText, formatKusdt } from "./kusdt.js";
import { hex, unhex32, bytesEqual } from "./kachat-names/codec.js";
import { sompiFromUserText, sanitizeAmountInput, kasTextFromSompi, groupedAmountText } from "./amounts.js";
import { KusdtCoreError } from "./kusdt-core.js";
import { coinsInUseReason, enqueueSend, heldOutpointKeys } from "./transactions.js";

/** A maybe-sent trade holds its address this long (iOS `holdSeconds`). */
export const TRADE_HOLD_MS = 600_000;
/** Where the holds are kept (iOS `kachat_trestly_maybe_sent_holds`): by address, not by account. */
export const TRADE_HOLDS_KEY = "kachat-trestly-maybe-sent-holds-v1";
/** iOS TrestlyProvider.Code. */
export const TRADE_CODE = Object.freeze({ rejected: 4001, unsupported: 4200, busy: -32002, invalid: -32602, failed: -32603 });

export const TRADE_MESSAGES = Object.freeze({
  declined: "You declined in K. Nothing was sent.",
  inFlight: "A trade from this address is still going. Wait for it to finish.",
  wrongKind: "K can't trade from this kind of address.",
  noKey: "K couldn't unlock this address's key.",
  notThisAccount: "This address doesn't belong to the account that's open now. Nothing was sent.",
  noResult: "Trestly's pool code gave no result.",
  mayHaveGone: "The trade may have gone through.",
  checkHistory: "Check the address's history before trying again.",
  nothingForAmount: "The pool gives nothing for this amount.",
  paused: "Trestly's pool is paused right now, so swaps are stopped for the moment.",
  breaker: "The pool's circuit breaker limits sells right now. Try a smaller amount, or again later.",
  // Trestly's code picks its own coins and can't be told which to leave (audit 2026-11-25 #31).
  coinsReserved: "A scheduled KaPost holds coins on this address, and a swap could spend them. Swap from another address, or wait for the post to go out (or cancel it in KaPost > Scheduled). Nothing was sent.",
  coinsHeld: "A send from this address hasn't reached a block yet. Try the swap again in a moment. Nothing was sent.",
});

export function heldMessage(minutes) {
  return `Your last trade from this address gave no answer and may still go through. Check the address's history. K takes trades from it again once that one shows on the network, or in about ${minutes} min.`;
}

/** A refusal or failure, as iOS TrestlyProvider.ProviderError: their code (or ours), their words,
 *  and whether the trade may have gone out anyway. */
export class TradeError extends Error {
  constructor(code, message, { maybeSent = false } = {}) {
    super(message);
    this.name = "TradeError";
    this.code = code;
    this.maybeSent = maybeSent;
  }
}

// MARK: - Exact amounts

/** A base-unit amount from their JSON (a digit string, or a safe integer), else null (iOS
 *  `TrestlyApproval.number`). */
export function tradeUnits(v) {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "string" && /^\d{1,30}$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return null;
}

/** 1% under the quote: the least the swap goes ahead for if the pool moves before it lands (iOS
 *  `SwapService.minimumOut`). Never underflows. */
export function minimumOut(quote) {
  const q = BigInt(quote);
  return q - q / 100n;
}

/** What "You Send" means for a kUSDT swap, in base units: sompi when KAS is sent (a buy), kUSDT
 *  units when kUSDT is (a sell). The field is cleaned first, as every amount field is ("1,5" is
 *  1.5, never 15 - K audit 2026-11-24 #3). Null for nothing or zero. */
export function kusdtSwapAmountIn(text, { buying }) {
  if (buying) {
    const sompi = sompiFromUserText(sanitizeAmountInput(text, 8));
    return sompi != null && sompi > 0n ? sompi : null;
  }
  const units = kusdtUnitsFromText(sanitizeAmountInput(text, 6));
  return units != null && units > 0n ? units : null;
}

/** "12.5 KAS", exact. */
export function kasAmountLabel(sompi) {
  return `${groupedAmountText(kasTextFromSompi(sompi))} KAS`;
}

/** The figure a quote puts under "You Get": "12.5" (KAS) or "0.26" (kUSDT), plain, exact. */
export function kusdtQuoteText(quote, { buying }) {
  const q = BigInt(quote);
  if (!buying) return kasTextFromSompi(q);
  const whole = q / 1_000_000n;
  const frac = String(q % 1_000_000n).padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/** The rate line, "1 KAS ≈ 0.04123456 kUSDT (Kaspa)", worked out exactly (8 places, cut, not
 *  rounded): a buy pays sompi for kUSDT units, a sell the other way. */
export function kusdtRateText({ buying, amountIn, quote, kusdtLabel = "kUSDT (Kaspa)" }) {
  const a = BigInt(amountIn);
  const q = BigInt(quote);
  if (a <= 0n) return "N/A";
  // per whole coin of what is sent, in whole coins of what comes back, times 10^8 for 8 places
  const scaled = buying
    ? (q * 100_000_000n * 100_000_000n) / (a * 1_000_000n)
    : (q * 1_000_000n * 100_000_000n) / (a * 100_000_000n);
  const text = `${scaled / 100_000_000n}.${String(scaled % 100_000_000n).padStart(8, "0")}`;
  return buying ? `1 KAS ≈ ${text} ${kusdtLabel}` : `1 ${kusdtLabel} ≈ ${text} KAS`;
}

/** What a finished swap says (iOS `TrestlyTrade.recordSwap`): the text for the toast and the
 *  notification ("Swapped 10 KAS for 0.26 kUSDT", or "Swap sent: …" when it went out and wasn't seen
 *  accepted in time), and the kUSDT side for the address's history. Null without a txid. */
export function swapRecord(done) {
  const txid = done?.result?.txid;
  const amountIn = tradeUnits(done?.prepared?.amountIn);
  const amountOut = tradeUnits(done?.result?.amountOut);
  if (typeof txid !== "string" || amountIn == null || amountOut == null) return null;
  const bought = done.prepared.side === "buy";
  const kas = kasAmountLabel(bought ? amountIn : amountOut);
  const kusdt = formatKusdt(bought ? amountOut : amountIn);
  const confirmed = done.result.confirmed !== false;
  const paid = bought ? kas : kusdt;
  const got = bought ? kusdt : kas;
  return {
    txid, bought, confirmed, amountIn, amountOut,
    title: confirmed ? "Swap Complete" : "Swap Sent",
    text: confirmed ? `Swapped ${paid} for ${got}` : `Swap sent: ${paid} for ${got}`,
    kusdtUnits: bought ? amountOut : amountIn,
    sold: !bought,
    fee: tradeUnits(done.fee),
  };
}

// MARK: - The trade

/**
 * @param {object} deps
 * @param {function} deps.walletCall        ("prepare"|"execute", request) => Promise<object>
 * @param {function} deps.network           () => "mainnet" | "testnet-10" (Trestly's names)
 * @param {function} deps.apiUrl            () => the Trestly API URL
 * @param {object}   [deps.storage]         localStorage-like, for the holds
 * @param {function} [deps.now]
 * @param {function} [deps.outpointsOf]     (address) => Promise<string[]>: "txid:index" of every coin
 *                                          the node lists there now, held-back ones included
 * @param {function} deps.secretFor         (target) => hex | Uint8Array | null: the address's key
 * @param {function} [deps.noteSpentOutpoints] (keys) => void
 * @param {function} [deps.markOwnTransaction] (txid) => void
 * @param {function} [deps.afterTrade]      ({ txid, address }) => void: balances looked up again until
 *                                           the trade's coins show (K 961fc05a followTrade); no txid
 *                                           for a trade that may have gone out
 * @param {function} [deps.coinsInUse]      (keys) => "reserved" | "held" | null: whether a scheduled
 *                                          KaPost or a send of K's own has any of these coins
 *                                          (default engine/transactions.js coinsInUseReason; null: no check)
 * @param {function} [deps.queue]           (address, task) => Promise: the per-address send queue
 *                                          (default engine/transactions.js enqueueSend; null: none)
 * @param {function} [deps.heldOutpoints]   () => Set of "txid:index" this page still holds back
 *                                          (default engine/transactions.js heldOutpointKeys)
 */
export function createTrestlyTrade(deps) {
  const now = deps.now || (() => Date.now());
  const inFlight = new Set();
  const coinsInUse = deps.coinsInUse === undefined ? coinsInUseReason : deps.coinsInUse;
  const queue = deps.queue === undefined ? enqueueSend : deps.queue;
  const heldOutpoints = deps.heldOutpoints || heldOutpointKeys;

  // MARK: Holds (iOS `MaybeSentHold`)
  function readHolds() {
    try {
      const v = JSON.parse(deps.storage?.getItem?.(TRADE_HOLDS_KEY) || "null");
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch { return {}; }
  }
  function writeHolds(all) {
    const t = now();
    const live = {};
    for (const [address, h] of Object.entries(all)) if (Number(h?.until) > t) live[address] = { until: Number(h.until), outpoints: (h.outpoints || []).map(String) };
    try {
      if (Object.keys(live).length) deps.storage?.setItem?.(TRADE_HOLDS_KEY, JSON.stringify(live));
      else deps.storage?.removeItem?.(TRADE_HOLDS_KEY);
    } catch { /* storage full or blocked */ }
  }
  function hold(address, outpoints) {
    const all = readHolds();
    all[address] = { until: now() + TRADE_HOLD_MS, outpoints: [...(outpoints || [])] };
    writeHolds(all);
  }
  function release(address) {
    const all = readHolds();
    delete all[address];
    writeHolds(all);
  }
  /** Minutes left on this address's hold, or null when it may trade: no hold, the hold ran out, or a
   *  coin it had before is gone from the node (the earlier trade landed). A gone coin counts only
   *  while this page still holds the hold's coins back: then no send of K's could have spent it.
   *  After a reload that hold is gone, a send may have taken one, and the hold lasts its ten
   *  minutes (K 01f71184 TrestlyTrade.heldMinutes, release audit Low). */
  async function heldMinutes(address) {
    const held = readHolds()[address];
    if (!held) return null;
    const left = Number(held.until) - now();
    if (!(left > 0)) { release(address); return null; }
    let reserved = null;
    try { reserved = heldOutpoints(); } catch { reserved = null; }
    const stillReserved = Boolean(reserved) && (held.outpoints || []).every((o) => reserved.has(String(o).toLowerCase()));
    if (held.outpoints?.length && stillReserved && deps.outpointsOf) {
      let present = null;
      try { present = new Set((await deps.outpointsOf(address)).map(String)); } catch { present = null; }
      if (present && held.outpoints.some((o) => !present.has(String(o)))) { release(address); return null; }
    }
    return Math.max(1, Math.ceil(left / 60_000));
  }

  // MARK: Calls into their code
  function maybeSentMessage(why) {
    return `${why} ${TRADE_MESSAGES.mayHaveGone} ${TRADE_MESSAGES.checkHistory}`;
  }
  async function call(fn, request) {
    let answer;
    try {
      answer = await deps.walletCall(fn, request);
    } catch (error) {
      if (error instanceof KusdtCoreError && error.code === "maybeSent") throw new TradeError(TRADE_CODE.failed, maybeSentMessage(error.message), { maybeSent: true });
      throw new TradeError(TRADE_CODE.failed, String(error?.message || error));
    }
    if (typeof answer?.error === "string") {
      const code = typeof answer.code === "number" ? answer.code : TRADE_CODE.failed;
      if (answer.maybeSent === true) throw new TradeError(code, maybeSentMessage(answer.error), { maybeSent: true });
      throw new TradeError(code, answer.error);
    }
    return answer;
  }

  /** The address's side of a request (no key: that is added only on Approve). */
  function walletFor(target) {
    const owner = schnorrOwner(target?.address, deps.network());
    if (!owner) throw new TradeError(TRADE_CODE.failed, TRADE_MESSAGES.wrongKind);
    return { network: deps.network(), address: target.address, ownerHex: hex(owner), apiUrl: String(deps.apiUrl() || "") };
  }

  /** Refuses a trade from an address where a scheduled KaPost's signed transaction or one of K's own
   *  sends still needs a coin the node lists there: Trestly's code picks coins itself and takes no
   *  list to leave out (audit 2026-11-25 #31). Without the hook, or the coins, nothing is checked. */
  function refuseCoinsInUse(coins) {
    if (!coinsInUse || !coins?.length) return;
    let reason = null;
    try { reason = coinsInUse(coins); } catch { reason = null; }
    if (reason === "reserved") throw new TradeError(TRADE_CODE.busy, TRADE_MESSAGES.coinsReserved);
    if (reason === "held") throw new TradeError(TRADE_CODE.busy, TRADE_MESSAGES.coinsHeld);
  }
  async function coinsAt(address) {
    try { return (await deps.outpointsOf?.(address)) || []; } catch { return []; }
  }

  /** Their `prepare` alone: the quote and its checks, nothing signed or sent. */
  async function prepare(method, params, target) {
    return call("prepare", { method, params: params ?? null, wallet: walletFor(target) });
  }

  /** The key as bytes, checked to be `target`'s own; null (nothing kept) otherwise. */
  function keyBytesFor(target, owner) {
    let raw = null;
    try { raw = deps.secretFor(target); } catch { raw = null; }
    let bytes = null;
    try {
      if (raw instanceof Uint8Array) bytes = Uint8Array.from(raw);
      else if (raw) bytes = unhex32(String(raw).trim().toLowerCase());
    } catch { bytes = null; }
    raw = null;
    if (!bytes) throw new TradeError(TRADE_CODE.failed, TRADE_MESSAGES.noKey);
    let signer = null;
    try { signer = schnorr.getPublicKey(bytes); } catch { signer = null; }
    // The key must be this address's own: a target picked on another account (the account switched
    // while Swap kept it) would pair this account's key with the other's address (K audit
    // 2026-11-24 #5).
    if (!signer || !bytesEqual(signer, owner)) {
      bytes.fill(0);
      throw new TradeError(TRADE_CODE.failed, TRADE_MESSAGES.notThisAccount);
    }
    return bytes;
  }

  /**
   * The whole trade. `ask(approval)` shows it and answers true (Approve) or false; `isClosed()`
   * stops it when the screen that asked has gone (or the account changed). Resolves
   * `{ result, prepared, fee }`; throws TradeError (code TRADE_CODE.rejected for a Decline).
   */
  async function run({ method, params = null, target, native = false, ask, isClosed = () => false }) {
    const address = String(target?.address || "");
    if (inFlight.has(address)) throw new TradeError(TRADE_CODE.busy, TRADE_MESSAGES.inFlight);
    inFlight.add(address);
    try {
      const minutes = await heldMinutes(address);
      if (minutes != null) throw new TradeError(TRADE_CODE.busy, heldMessage(minutes));
      const wallet = walletFor(target);
      const owner = schnorrOwner(address, deps.network());
      // Coins K has promised elsewhere: refused before the sheet asks, and again at Approve.
      if (coinsInUse) refuseCoinsInUse(await coinsAt(address));
      let prepared = await call("prepare", { method, params, wallet });
      let seen = null;

      for (;;) {
        let approved = false;
        try { approved = await ask({ method, prepared, seen, from: target.label, native }); } catch { approved = false; }
        if (approved !== true || isClosed()) throw new TradeError(TRADE_CODE.rejected, TRADE_MESSAGES.declined);

        // From here to their answer, in the address's send queue like any send of K's, so a send
        // and a trade never pick the same coin (audit 2026-11-25 #31).
        const executeOnce = async () => {
          // the address's coins as they were before the trade: if it gives no answer these are held,
          // and the hold ends early once one of them is spent (the trade landed)
          const coinsBefore = await coinsAt(address);
          if (isClosed()) throw new TradeError(TRADE_CODE.rejected, TRADE_MESSAGES.declined);
          refuseCoinsInUse(coinsBefore);

          const bytes = keyBytesFor(target, owner);
          const request = {
            method, params, wallet: { ...wallet, secret: hex(bytes) },
            shownFeerate: prepared.feerate ?? null,
            acceptedFee: prepared.acceptedFee ?? null,
            quoted: method === "kusdt_removeLiquidity"
              ? { kasOut: prepared.kasOut ?? null, tokensOut: prepared.tokensOut ?? null }
              : (prepared.quote ?? null),
          };
          try {
            const answer = await call("execute", request);
            // the coins it spent are held like a send's own (10 minutes), before the queue lets the
            // next send pick
            const spent = (Array.isArray(answer?.inputs) ? answer.inputs : []).map(String).filter((o) => o.length > 65 && o.length < 80);
            if (spent.length) { try { deps.noteSpentOutpoints?.(spent); } catch { /* best effort */ } }
            return answer;
          } catch (error) {
            if (error instanceof TradeError && error.maybeSent) {
              // it may have gone out: hold this address's coins and its trades (iOS audit 2026-11-21 #1)
              hold(address, coinsBefore);
              if (coinsBefore.length) { try { deps.noteSpentOutpoints?.(coinsBefore); } catch { /* best effort */ } }
              try { deps.afterTrade?.({ txid: null, address }); } catch { /* the screen's */ }
            }
            throw error;
          } finally {
            // the key leaves this function's hands whether execute answers, throws or times out
            request.wallet.secret = null;
            delete request.wallet;
            bytes.fill(0);
          }
        };
        const done = queue ? await queue(address, executeOnce) : await executeOnce();

        for (const step of Array.isArray(done.steps) ? done.steps : []) { try { deps.markOwnTransaction?.(String(step)); } catch { /* best effort */ } }
        if (done.requote != null) {
          // The pool moved and pays less than approved: nothing was sent. Their code prepares again
          // from scratch, so the sheet shows the new quote with its own warnings, fee and minimum.
          seen = method === "kusdt_removeLiquidity"
            ? { kasOut: prepared.kasOut ?? "0", tokensOut: prepared.tokensOut ?? "0" }
            : { quote: prepared.quote ?? "0" };
          prepared = await call("prepare", { method, params, wallet });
          continue;
        }
        const result = done.result;
        if (!result || typeof result !== "object") throw new TradeError(TRADE_CODE.failed, TRADE_MESSAGES.noResult);
        if (typeof result.txid === "string") { try { deps.markOwnTransaction?.(result.txid); } catch { /* best effort */ } }
        try { deps.afterTrade?.({ txid: typeof result.txid === "string" ? result.txid : null, address }); } catch { /* the screen's */ }
        return { result, prepared, fee: done.fee ?? null };
      }
    } finally {
      inFlight.delete(address);
    }
  }

  return { prepare, run, heldMinutes, isBusy: (address) => inFlight.has(String(address || "")), walletFor };
}

/** The pool's quote for a typed "You Send" (iOS SwapService.rescheduleKusdtEstimate): `prepare` with
 *  no minimum. Resolves the quote (BigInt base units of what comes back); throws TradeError for a
 *  paused pool, its circuit breaker or nothing to give. */
export async function quoteKusdtSwap(trade, { buying, amountIn, target }) {
  const prepared = await trade.prepare("kusdt_swap", { side: buying ? "buy" : "sell", amountIn: String(amountIn), minOut: "0" }, target);
  const quote = tradeUnits(prepared?.quote);
  if (quote == null || quote <= 0n) throw new TradeError(TRADE_CODE.failed, TRADE_MESSAGES.nothingForAmount);
  if (prepared.paused === true) throw new TradeError(TRADE_CODE.failed, TRADE_MESSAGES.paused);
  if (typeof prepared.breaker === "string") throw new TradeError(TRADE_CODE.failed, TRADE_MESSAGES.breaker);
  return quote;
}
