// The account's kUSDT: balances by address, the refresh and its 90 s poll, Discover, the Address
// Visibility lists, the history, "Received X kUSDT" and what a send does to all of these.
//
// Port of KaPay iOS TokenWallet (KaChatWallet/Views/Tokens/WalletTokens.swift, 3d126db): the
// engine (engine/kusdt*.js) reads, checks and builds; this is the state the screens
// (ui/kusdt-screens.js) draw, kept for the account it was read for. Everything that awaits is tied
// to the account it started on (`deps.account()`, as ui/account-guard.js does): an answer that
// comes back after an account switch is dropped, never written into the other account.
//
// Where kUSDT lives (owner's call, 2026-11-19): the Chatting Address and the regular (legacy, key)
// spending addresses. Never a quantum-safe one: sending a token from it reveals its key, and
// Trestly's builder doesn't take one.
//
// Privacy (iOS audit 2026-11-20): a refresh asks Trestly's API about the Chatting Address and only
// the regular addresses that use kUSDT (holding it, listed, hidden while holding, waiting for a
// coin, or in its history), at most 4 at a time. Discover (Manage kUSDT, the Wallet's refresh
// sweep) looks wider. The API is read directly (engine/kusdt-balances.js): never through the
// /nc-proxy relay, a capped Cloudflare function.
//
// The pure helpers below are what tools/test-kusdt-ui.mjs checks in Node.

import { KUSDT_TOKEN, formatKusdt, canHoldKusdt, outpointKey } from "../engine/kusdt.js";
import { verifiedCoins, applyResults, findReceived, receivedNotification } from "../engine/kusdt-balances.js";
import { createKusdtStore, kusdtStorageKeys, forgetAccount as forgetKusdtStorage } from "../engine/kusdt-store.js";
import { submitPrepared, adjustHoldingsAfterSend, isHeldByEngine } from "../engine/kusdt-transfer.js";
import { isQuantumIndex, addressNumber } from "../engine/quantum.js";

// MARK: - Constants (iOS TokenWallet)

/** While the app is open, an account that uses kUSDT is checked this often (iOS startPolling; 30 s
 *  since K b0f0a4e6, when a Received kUSDT came minutes late at 90). */
export const KUSDT_POLL_MS = 30_000;
/** ...unless the balances are younger than this (iOS refreshIfStale(maxAge: 25)). */
export const KUSDT_POLL_MAX_AGE_MS = 25_000;
/** A new coin on the Chatting Address waits this long for a contact's Send Dollars notice before
 *  the wallet announces it itself, so the chat's notification is the only one (K noticeWait). */
export const KUSDT_NOTICE_WAIT_MS = 120_000;
/** A screen that opens refreshes balances older than this (iOS refreshIfStale default, 60 s). */
export const KUSDT_STALE_MS = 60_000;
/** Send Dollars runs Discover as it opens, unless one ran this recently for the account (KaChat iOS
 *  5b7c772c DollarTokenChooser, discoverIfStale(maxAge: 300)). */
export const KUSDT_DISCOVER_STALE_MS = 300_000;
/** Lookups run this many at a time (iOS lookUp). */
export const KUSDT_LOOKUP_BATCH = 4;
/** Discover looks this far past the last revealed regular address (iOS discoverHoldings). */
export const KUSDT_DISCOVER_PAST = 20;
/** Address Visibility pages (iOS TokenAddressVisibilityView.pageSize). */
export const KUSDT_VISIBILITY_PAGE = 50;
/** The Chatting Address's holding id; a regular address is "s<index>" (iOS TokenHolding.id). */
export const CHATTING_HOLDING_ID = "chatting";

/** §11: Manage Addresses keeps every address Manage kUSDT lists (iOS ManageAddressesView,
 *  owner's call 2026-11-20). */
export const KUSDT_LISTED_HIDE_MESSAGE = "This address is on your kUSDT list, so it stays here. Hide it from Manage kUSDT first.";
export const KUSDT_LISTED_ALERT_TITLE = "Shown for kUSDT";

// MARK: - Receive notes (iOS Views/Shared/AddressReceiveView.swift ReceiveNotes, 3d126db)

/** `kind` picks the icon and colour (iOS ReceiveNote.Kind). */
export const RECEIVE_NOTES = Object.freeze({
  fresh: { kind: "privateAddress", text: "A brand-new address of yours, never used or handed out: this payment can't be tied to your name." },
  spending: { kind: "privateAddress", text: "A spending address of yours: a payment here isn't tied to your name." },
  chatting: { kind: "publicAddress", text: "Your Chatting Address shows your .kachat name and identity: whoever pays here can see it's you." },
  quantum: { kind: "quantum", text: "A quantum-resistant address: its key stays hidden until it spends." },
  kaspaAndKusdt: { kind: "allowed", text: "Kaspa, and kUSDT on Kaspa, can be sent here." },
  kaspaOnly: { kind: "allowed", text: "Only Kaspa can be sent here." },
  noKusdtOnQuantum: { kind: "warning", text: "Don't send kUSDT here: it can't be traded from a quantum-resistant address. Use Receive for a regular one." },
  walletReceive: { kind: "info", text: "It lands in this account and shows in your spending total. Use it for everything except .kachat names." },
  chattingUse: { kind: "info", text: "Use for chatting and acquiring .kachat domains." },
  kusdtOnly: { kind: "allowed", text: "Only kUSDT on Kaspa, or KAS, can be sent here." },
  kusdtBridgeFirst: { kind: "warning", text: "Don't send USDT from Ethereum, BNB Chain or an exchange to this address: it would be lost. Bridge it to Kaspa on Trestly first." },
});

/** What a receive screen says (iOS's callers of AddressReceiveView): `{ privacy, notes }`.
 *  "wallet" (Wallet's Receive, a fresh regular address), "chatting" (the Chatting Address QR),
 *  "spending" / "quantum" (a spending address's QR), "kusdt-fresh" / "kusdt-chatting" /
 *  "kusdt-spending" (Receive kUSDT). */
export function receiveNotesFor(screen) {
  const N = RECEIVE_NOTES;
  switch (screen) {
    case "wallet": return { privacy: N.fresh, notes: [N.kaspaAndKusdt, N.walletReceive] };
    case "chatting": return { privacy: N.chatting, notes: [N.kaspaAndKusdt, N.chattingUse] };
    case "spending": return { privacy: N.spending, notes: [N.kaspaAndKusdt] };
    case "quantum": return { privacy: N.quantum, notes: [N.kaspaOnly, N.noKusdtOnQuantum] };
    case "kusdt-fresh": return { privacy: N.fresh, notes: [N.kusdtOnly, N.kusdtBridgeFirst] };
    case "kusdt-chatting": return { privacy: N.chatting, notes: [N.kusdtOnly, N.kusdtBridgeFirst] };
    case "kusdt-spending": return { privacy: N.spending, notes: [N.kusdtOnly, N.kusdtBridgeFirst] };
    default: return { privacy: null, notes: [] };
  }
}

// MARK: - Pure helpers

/** "chatting" or "s<index>" (iOS TokenHolding.id). */
export function holdingIdFor(index) {
  return index == null ? CHATTING_HOLDING_ID : `s${index}`;
}

/** The spending index of a holding id, or null for the Chatting Address (and anything else). */
export function indexOfHoldingId(id) {
  const m = /^s(\d+)$/.exec(String(id ?? ""));
  return m ? Number(m[1]) : null;
}

/** A regular (legacy, key) spending index: the only kind of spending address that holds kUSDT. */
export function isRegularIndex(index) {
  return Number.isInteger(index) && index >= 0 && !isQuantumIndex(index);
}

/** `list` in runs of `size` (the lookups' batches). */
export function chunked(list, size = KUSDT_LOOKUP_BATCH) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** The regular indices a refresh looks up (iOS refreshTargets): every one holding kUSDT, seen
 *  holding it before (`known`), checked on in Visibility (`shown`), hidden while holding it,
 *  waiting for an expected coin, or in the history - revealed ones only, in order. */
export function refreshTargetIndices({ holdings = [], known = [], shown = [], hidden = [], expected = [], activity = [], maxIndex = -1 }) {
  const indices = new Set();
  for (const h of holdings) if (h?.spendingIndex != null) indices.add(h.spendingIndex);
  for (const i of known) indices.add(Number(i));
  for (const i of shown) indices.add(Number(i));
  for (const id of hidden) { const i = indexOfHoldingId(id); if (i != null) indices.add(i); }
  for (const e of expected) { const i = indexOfHoldingId(e?.holdingId); if (i != null) indices.add(i); }
  for (const row of activity) { const i = indexOfHoldingId(row?.holdingId); if (i != null) indices.add(i); }
  return [...indices].filter((i) => isRegularIndex(i) && i <= maxIndex).sort((a, b) => a - b);
}

/** Whether Manage kUSDT lists a holding (iOS isListed): the Chatting Address always; a regular
 *  address holding kUSDT unless hidden; one without it only when checked on. */
export function isListedHolding(holding, { hidden = [], shown = [] } = {}) {
  if (holding?.spendingIndex == null) return true;
  if (holding.units > 0n) return !hidden.includes(holding.id);
  return shown.map(Number).includes(holding.spendingIndex);
}

/** The rows Manage kUSDT lists (iOS listedHoldings): the Chatting Address first (with or without
 *  kUSDT), then each regular address holding it unless hidden, and any without it that's checked
 *  on, in address order. `held`: holdings with units > 0; `addressAt(index)`: a regular address. */
export function listedHoldingsOf({ held = [], hidden = [], shown = [], chattingAddress = "", addressAt = () => null }) {
  const byId = new Map(held.map((h) => [h.id, h]));
  const out = [];
  const chatting = byId.get(CHATTING_HOLDING_ID);
  if (chatting) out.push(chatting);
  else if (chattingAddress) out.push(makeHolding(null, chattingAddress, 0n, 0));
  const indices = new Set(held.filter((h) => h.spendingIndex != null && !hidden.includes(h.id)).map((h) => h.spendingIndex));
  for (const i of shown) indices.add(Number(i));
  for (const index of [...indices].sort((a, b) => a - b)) {
    const holding = byId.get(holdingIdFor(index));
    if (holding) { out.push(holding); continue; }
    const address = addressAt(index);
    if (address) out.push(makeHolding(index, address, 0n, 0));
  }
  return out;
}

/** Visibility's checkmark, clicked (iOS toggleListed): an address holding kUSDT is hidden or
 *  shown, one without it is put on the list or taken off. The Chatting Address always stays.
 *  Returns the new `{ hidden, shown }`. */
export function toggleListedSets(holding, { hidden = [], shown = [] } = {}) {
  if (holding?.spendingIndex == null) return { hidden: [...hidden], shown: [...shown] };
  if (holding.units > 0n) {
    const set = new Set(hidden);
    if (set.has(holding.id)) set.delete(holding.id); else set.add(holding.id);
    return { hidden: [...set].sort(), shown: [...shown] };
  }
  const set = new Set(shown.map(Number));
  if (set.has(holding.spendingIndex)) set.delete(holding.spendingIndex); else set.add(holding.spendingIndex);
  return { hidden: [...hidden], shown: [...set].sort((a, b) => a - b) };
}

/** Hide All (iOS hideAllListed): only the Chatting Address stays; nothing is lost. */
export function hideAllListedSets(held = []) {
  return { hidden: held.filter((h) => h.spendingIndex != null && h.units > 0n).map((h) => h.id).sort(), shown: [] };
}

/** "Chatting Address", "Address #3", or "2 Addresses" (iOS heldOnText); "--" before anything is
 *  known. `held`: holdings with units > 0. */
export function heldOnText(held, labelOf) {
  if (held == null) return "--";
  if (held.length === 1) return labelOf(held[0]);
  return `${held.length} Addresses`;
}

/** KAS held with the coins (iOS kasHeld): 1.5 KAS a coin. Sompi. */
export function kasHeldSompi(held = []) {
  return held.reduce((s, h) => s + BigInt(h.coinCount || 0), 0n) * KUSDT_TOKEN.kasPerCoinSompi;
}

/** Used, as Manage Addresses says it (iOS TokenManageView.isUsed): the Chatting Address always;
 *  another once it holds or has held kUSDT here, or has any Kaspa history. */
export function isHoldingUsed(holding, { usedIndices = new Set(), activity = [] } = {}) {
  if (holding?.spendingIndex == null) return true;
  return holding.units > 0n || holding.coinCount > 0 || usedIndices.has(holding.spendingIndex)
    || activity.some((row) => row.holdingId === holding.id);
}

/** "kaspa:qyp4abcdef...123456": the first 14, "...", the last 6 (Manage kUSDT rows). */
export function shortKusdtAddress(address) {
  const a = String(address || "");
  return a.length > 20 ? `${a.slice(0, 14)}...${a.slice(-6)}` : a;
}

/** "kaspa:qyp4abcdefgh…123456": 16 + "…" + 6 (Visibility rows). */
export function visibilityShortAddress(address) {
  const a = String(address || "");
  return a.length > 22 ? `${a.slice(0, 16)}…${a.slice(-6)}` : a;
}

/** "1.5 KAS" etc.: KAS with up to 8 decimals, trailing zeros dropped, grouped like iOS
 *  KaspaUnit.amount. */
export function kasAmountText(sompi, unit = "KAS") {
  let v = BigInt(sompi ?? 0);
  const negative = v < 0n;
  if (negative) v = -v;
  const whole = (v / 100_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (v % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""} ${unit}`;
}

/** A history row's fee (iOS TokenActivityRow.feeText): four decimals, eight under 0.001 KAS. */
export function kusdtFeeText(sompi, unit = "KAS") {
  const v = BigInt(sompi ?? 0);
  const digits = v < 100_000n ? 8 : 4; // 0.001 KAS = 100,000 sompi
  const scale = 10n ** BigInt(8 - digits);
  // rounded half up at the digit shown, as String(format: "%.4f")
  const rounded = digits === 8 ? v : (v + scale / 2n) / scale;
  const whole = digits === 8 ? v / 100_000_000n : rounded / (10n ** BigInt(digits));
  const frac = digits === 8 ? (v % 100_000_000n).toString().padStart(8, "0") : (rounded % (10n ** BigInt(digits))).toString().padStart(digits, "0");
  return `${whole}.${frac} ${unit}`;
}

/** The fresh regular slot Receive kUSDT and Generate New Address use (iOS freshReceiveAddress):
 *  past every revealed regular slot, skipping one already holding kUSDT. */
export function freshRegularIndex(maxIndex, takenIndices = []) {
  const taken = new Set(takenIndices.map(Number));
  let index = Math.max(-1, Number(maxIndex)) + 1;
  while (taken.has(index)) index += 1;
  return index;
}

/** §11, Manage Addresses' Hide on `index`: the refusal text when Manage kUSDT lists it, else null. */
export function manageAddressesHideRefusal(index, listedIndices) {
  return listedIndices?.has?.(Number(index)) ? KUSDT_LISTED_HIDE_MESSAGE : null;
}

/** §11, Manage Addresses opened: the hidden list with every kUSDT-listed address shown again
 *  (iOS showKusdtListedAddresses). Returns the same array when nothing changes. */
export function reshowListedHidden(hidden = [], listedIndices = new Set()) {
  if (!hidden.some((i) => listedIndices.has(Number(i)))) return hidden;
  return hidden.filter((i) => !listedIndices.has(Number(i)));
}

/** §11, Manage Addresses' Hide All: every revealed address hidden but the kUSDT-listed ones. */
export function hideAllKeepingListed(revealed = [], listedIndices = new Set()) {
  return revealed.filter((i) => !listedIndices.has(Number(i)));
}

/** Whether the 90 s poll checks now (iOS startPolling): the page is showing, an account is open,
 *  Address Activity notifications are on, and the account uses kUSDT. */
export function shouldPoll({ visible, account, notificationsEnabled, usesTokens }) {
  return Boolean(visible && account && notificationsEnabled && usesTokens);
}

/** One holding (iOS TokenHolding): `units` BigInt, `coinCount` coins. */
export function makeHolding(spendingIndex, address, units, coinCount) {
  return { id: holdingIdFor(spendingIndex), spendingIndex: spendingIndex ?? null, address, units: BigInt(units), coinCount: Number(coinCount) || 0 };
}

// MARK: - The wallet

/**
 * The kUSDT state. `deps`:
 *   account()                   the active account's address (engine.address), read on every check
 *   network                     "mainnet" | "testnet-10"
 *   storage                     localStorage-like
 *   apiBase()                   Trestly's API base (Connection Settings, engine/endpoints.js trestlyApi)
 *   engine                      the KaspaEngine (getUtxosWithCovenants, submitRpcTransaction, kaspa)
 *   fetchImpl                   fetch for Trestly (direct, never the relay)
 *   maxSpendingIndex()          the active account's last revealed regular index
 *   spendingAddressAt(index)    a regular address of the active account (memoized), or null
 *   spendingAddressesInRange(start, end) -> Promise<Map(index -> address)> (Discover)
 *   revealSpendingSlot(index, owner)    puts a slot on Manage Addresses' list (Discover, Generate)
 *   spendingLabel(index)        "Address #3" or the label given to it
 *   ownAddresses()              every address of the account (findReceived)
 *   fetchTransactionInputs(txid) -> [{ hash, index, address }] | null
 *   notificationsEnabled()      Settings > Notifications > Address Activity
 *   notify({ title, body })     the desktop notification and the bell
 *   isNoticeFiled(txid)         a contact's Send Dollars the chat already filed and announced
 *                               (token_payment_notice): no second "Received kUSDT" banner
 *   markOwnTransaction(txid)    ui/address-activity.js: a send's KAS change isn't "Received KAS"
 *   isVisible()                 the page is showing (the poll)
 *   log(line)
 */
export function createKusdtWallet(deps) {
  const now = deps.now || (() => Date.now());
  const log = (line) => { try { deps.log?.(line); } catch { /* the log never stops a refresh */ } };
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) { try { fn(); } catch { /* one screen's paint */ } } };

  let loadedAccount = null;
  let holdings = null;         // [{ id, spendingIndex, address, units, coinCount }], null until known
  let coins = new Map();       // holdingId -> verified coins a send can spend
  let lastError = null;
  let lastRefreshed = 0;
  let lastDiscovered = 0;
  let discoveryRuns = 0; // Discovers running for the loaded account (the "Checking" state)
  let refreshing = false;
  let inFlight = null;         // { account, promise }
  let refreshAgain = false;
  let applyGeneration = 0;
  let followUpTimer = null;
  let pollTimer = null;
  const stores = new Map();

  const account = () => String(deps.account?.() || "").trim();
  function storeFor(owner) {
    if (!owner) return null;
    if (!stores.has(owner)) stores.set(owner, createKusdtStore({ storage: deps.storage, account: owner, now }));
    return stores.get(owner);
  }
  function readList(key) {
    try {
      const v = JSON.parse(deps.storage?.getItem?.(key) || "null");
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }
  function writeList(key, list) {
    try { deps.storage?.setItem?.(key, JSON.stringify(list)); } catch { /* storage full or blocked */ }
  }
  const keys = (owner = account()) => kusdtStorageKeys(owner);
  const hiddenIds = (owner = account()) => (owner ? readList(keys(owner).hidden).map(String) : []);
  const shownIndices = (owner = account()) => (owner ? readList(keys(owner).shown).map(Number).filter(Number.isInteger) : []);
  const knownIndices = (owner = account()) => (owner ? readList(keys(owner).indices).map(Number).filter(Number.isInteger) : []);

  function resetMemory(owner) {
    holdings = null;
    coins = new Map();
    lastError = null;
    lastRefreshed = 0;
    lastDiscovered = 0;
    discoveryRuns = 0;
    loadedAccount = owner;
    if (followUpTimer) { clearTimeout(followUpTimer); followUpTimer = null; }
  }
  /** The figures in memory belong to the active account, or there are none. */
  function current() {
    const owner = account();
    if (owner !== loadedAccount) resetMemory(owner);
    return owner;
  }

  const labelOf = (h) => (h.spendingIndex == null ? "Chatting Address" : (deps.spendingLabel?.(h.spendingIndex) || `Address #${addressNumber(h.spendingIndex)}`));

  function targetsFor(owner) {
    const store = storeFor(owner);
    const indices = refreshTargetIndices({
      holdings: holdings || [], known: knownIndices(owner), shown: shownIndices(owner), hidden: hiddenIds(owner),
      expected: store.expectedCoins(), activity: store.activity(), maxIndex: Number(deps.maxSpendingIndex?.() ?? -1),
    });
    const targets = [{ spendingIndex: null, address: owner }];
    for (const index of indices) {
      const address = deps.spendingAddressAt?.(index);
      if (address) targets.push({ spendingIndex: index, address });
    }
    return targets;
  }

  /** The lookups, four at a time (iOS lookUp). Any one failing fails them all, so a partial answer
   *  is never shown as the whole balance. */
  async function lookUp(targets, owner, progress = null) {
    const expected = storeFor(owner).expectedCoins();
    const out = [];
    for (const batch of chunked(targets, KUSDT_LOOKUP_BATCH)) {
      const answers = await Promise.all(batch.map(async (target) => ({
        holdingId: holdingIdFor(target.spendingIndex),
        spendingIndex: target.spendingIndex,
        address: target.address,
        result: await verifiedCoins({
          engine: deps.engine, getUtxos: deps.getUtxos || null, apiBase: deps.apiBase?.(), address: target.address,
          expected: expected.filter((e) => e.address === target.address), network: deps.network,
          fetchImpl: deps.fetchImpl || globalThis.fetch, log,
        }),
      })));
      out.push(...answers);
      try { progress?.(batch[batch.length - 1]?.spendingIndex ?? null, out.filter((r) => r.result.coins.length).length); } catch { /* the screen's */ }
      if (account() !== owner) break;
    }
    return out;
  }

  /** The figures from a lookup (iOS apply). */
  function applyLookups(results, owner) {
    const store = storeFor(owner);
    const applied = applyResults({ results, expected: store.expectedCoins(), now: now(), isHeld: deps.isHeld || isHeldByEngine });
    store.setExpectedCoins(applied.expected);
    const indexOf = new Map(results.map((r) => [r.holdingId, r.spendingIndex]));
    const list = applied.holdings.map((h) => ({ ...makeHolding(indexOf.get(h.holdingId) ?? indexOfHoldingId(h.holdingId), h.address, h.units, h.coinCount) }));
    list.sort((a, b) => (a.spendingIndex ?? -1) - (b.spendingIndex ?? -1));
    applyGeneration += 1;
    // the regular addresses seen holding it, remembered so a refresh after a reload looks them up
    const seen = list.map((h) => h.spendingIndex).filter((i) => i != null);
    const known = new Set(knownIndices(owner));
    if (seen.some((i) => !known.has(i))) writeList(keys(owner).indices, [...new Set([...known, ...seen])].sort((a, b) => a - b));
    holdings = list;
    coins = new Map(applied.holdings.map((h) => [h.holdingId, h.coins]));
    return applied.followUpMs;
  }

  function allCoins() { return [...coins.values()].flat(); }

  /** Coins on the Chatting Address waiting for a chat notice: outpoint -> when first seen. */
  const awaitingNotice = new Map();
  /** "Received X kUSDT" for what a refresh found (iOS announceNewCoins). */
  async function announce(previous, owner) {
    const store = storeFor(owner);
    const currentList = (holdings || []).map((h) => ({ holdingId: h.id, coins: coins.get(h.id) || [] }));
    let found;
    try {
      found = await findReceived({
        store, current: currentList, previous, now: now(),
        fetchTransactionInputs: (txid) => deps.fetchTransactionInputs?.(txid) ?? null,
        ownAddresses: deps.ownAddresses?.() || [owner],
        // On the Chatting Address a coin may be a contact's Send Dollars whose chat notice comes a
        // little after it: wait for that notice (up to two minutes) so there's one ping, not two.
        holdForNotice: (coin, holdingId) => {
          const key = `${String(coin.transactionId).toLowerCase()}:${coin.index}`;
          let filed = false;
          try { filed = Boolean(deps.isNoticeFiled?.(String(coin.transactionId || "").toLowerCase())); } catch { filed = false; }
          // with notifications off there is no second ping to spare, so no wait for the history row
          let ringing = true;
          try { ringing = deps.notificationsEnabled?.() !== false; } catch { ringing = true; }
          if (filed || !ringing || holdingId !== CHATTING_HOLDING_ID) { awaitingNotice.delete(key); return false; }
          const firstSeen = awaitingNotice.get(key) ?? now();
          awaitingNotice.set(key, firstSeen);
          if (now() - firstSeen < KUSDT_NOTICE_WAIT_MS) return true;
          awaitingNotice.delete(key);
          return false;
        },
      });
    } catch (error) { log(`[kUSDT] received check failed: ${error?.message || error}`); return; }
    if (account() !== owner || !found.received.length) return;
    emit(); // the new history rows
    if (!deps.notificationsEnabled?.()) return;
    // a contact's Send Dollars the chat already showed and announced: no second banner (KaChat iOS
    // 5b7c772c isNoticeBubble); its history row stays
    const announced = found.received.filter((r) => {
      try { return !deps.isNoticeFiled?.(String(r.transactionId || "").toLowerCase()); } catch { return true; }
    });
    if (!announced.length) return;
    const ids = [...new Set(announced.map((r) => r.holdingId))];
    const labels = (holdings || []).filter((h) => ids.includes(h.id)).map(labelOf);
    const note = receivedNotification(announced, labels.length ? labels : ids.map(() => "address"), (u) => formatKusdt(u));
    try { deps.notify?.(note); } catch { /* the notification's own problem */ }
  }

  function scheduleFollowUp(ms, owner) {
    if (!ms || followUpTimer) return;
    followUpTimer = setTimeout(() => {
      followUpTimer = null;
      if (account() === owner) refresh().catch(() => {});
    }, ms);
    followUpTimer?.unref?.();
  }

  async function runRefresh(owner) {
    refreshing = true;
    emit();
    const generation = applyGeneration;
    try {
      const results = await lookUp(targetsFor(owner), owner);
      // the account may have changed while the lookups ran
      if (account() !== owner) return;
      // Discover applied newer answers meanwhile: look again rather than overwrite them
      if (applyGeneration !== generation) { refreshAgain = true; return; }
      const previous = allCoins();
      const followUp = applyLookups(results, owner);
      lastError = null;
      lastRefreshed = now();
      emit();
      await announce(previous, owner);
      scheduleFollowUp(followUp, owner);
    } catch (error) {
      if (account() === owner) lastError = String(error?.message || error || "Trestly didn't answer.");
      log(`[kUSDT] lookup failed: ${error?.message || error}`);
    } finally {
      if (loadedAccount === owner) { refreshing = false; emit(); }
    }
  }

  /** One refresh at a time per account (iOS refresh): a second caller waits for the one running
   *  and one more runs after it, so a follow-up is never lost and two never overwrite each other. */
  async function refresh() {
    const owner = current();
    if (!owner) return;
    if (inFlight && inFlight.account === owner) {
      refreshAgain = true;
      await inFlight.promise;
      return;
    }
    const promise = runRefresh(owner);
    inFlight = { account: owner, promise };
    try { await promise; } finally { if (inFlight?.promise === promise) inFlight = null; }
    if (refreshAgain && account() === owner) {
      refreshAgain = false;
      await refresh();
    }
  }

  async function refreshIfStale(maxAge = KUSDT_STALE_MS) {
    const owner = current();
    if (!owner) return;
    if (holdings && lastRefreshed && now() - lastRefreshed < maxAge) return;
    await refresh();
  }

  /** Finds the addresses holding kUSDT (iOS discoverHoldings): the Chatting Address and the
   *  regular addresses from the first to 20 past the last revealed, each checked on the node. The
   *  furthest one holding some is revealed (just that slot). Reports `(checkingNumber, found)`;
   *  returns how many hold some, or null when the lookup failed. */
  async function discover(progress = null) {
    const owner = current();
    if (!owner) return 0;
    // looking from the first moment, the derivation included, so a From step with nothing held
    // says "Checking" rather than "none" meanwhile
    discoveryRuns += 1;
    emit();
    try {
      return await runDiscover(owner, progress);
    } finally {
      if (loadedAccount === owner && discoveryRuns > 0) { discoveryRuns -= 1; emit(); }
    }
  }
  async function runDiscover(owner, progress) {
    if (inFlight && inFlight.account === owner) { try { await inFlight.promise; } catch { /* its own */ } }
    if (account() !== owner) return 0;
    const maxIndex = Number(deps.maxSpendingIndex?.() ?? -1);
    const last = maxIndex + KUSDT_DISCOVER_PAST;
    let derived = new Map();
    try { derived = await deps.spendingAddressesInRange?.(0, Math.max(last, 0) + 1) || new Map(); } catch { derived = new Map(); }
    if (account() !== owner) return 0;
    const targets = [{ spendingIndex: null, address: owner }];
    for (const index of [...derived.keys()].map(Number).filter(isRegularIndex).sort((a, b) => a - b)) {
      const address = derived.get(index);
      if (address) targets.push({ spendingIndex: index, address });
    }
    refreshing = true;
    emit();
    let results;
    try {
      results = await lookUp(targets, owner, (index, found) => progress?.(index == null ? 0 : addressNumber(index), found));
    } catch (error) {
      if (account() === owner) { lastError = String(error?.message || error); refreshing = false; emit(); }
      return null;
    }
    const found = results.filter((r) => r.result.coins.length).length;
    if (account() !== owner) return found;
    // what Discover finds was there already: known from now on, never announced as received
    const keysFound = results.flatMap((r) => r.result.coins.map((c) => outpointKey(c.transactionId, c.index)));
    storeFor(owner).rememberSeen(keysFound, keysFound);
    const furthest = Math.max(-1, ...results.filter((r) => r.result.coins.length && r.spendingIndex != null).map((r) => r.spendingIndex));
    if (furthest > maxIndex) {
      try { await deps.revealSpendingSlot?.(furthest, owner); } catch { /* shown on the next Discover */ }
    }
    if (account() !== owner) return found;
    applyLookups(results, owner);
    lastError = null;
    lastRefreshed = now();
    lastDiscovered = lastRefreshed;
    refreshing = false;
    emit();
    return found;
  }

  /** Discover, unless one ran in the last `maxAge` ms for this account (KaChat iOS 5b7c772c
   *  discoverIfStale: Send Dollars opens it every time; once in a while is enough). One running
   *  already is waited for rather than started twice. */
  let discoverInFlight = null; // { account, promise }
  async function discoverIfStale(maxAge = KUSDT_DISCOVER_STALE_MS) {
    const owner = current();
    if (!owner) return null;
    if (lastDiscovered && now() - lastDiscovered < maxAge) return null;
    if (discoverInFlight && discoverInFlight.account === owner) return discoverInFlight.promise;
    const promise = discover();
    discoverInFlight = { account: owner, promise };
    try { return await promise; } finally { if (discoverInFlight?.promise === promise) discoverInFlight = null; }
  }

  // MARK: Reads

  /** Every holding with kUSDT, hidden ones included (the total, Send's From). null until known. */
  function heldHoldings() {
    current();
    return holdings ? holdings.filter((h) => h.units > 0n) : null;
  }
  function balance() {
    const held = heldHoldings();
    return held ? held.reduce((s, h) => s + h.units, 0n) : null;
  }
  function listed() {
    const owner = current();
    return listedHoldingsOf({
      held: heldHoldings() || [], hidden: hiddenIds(owner), shown: shownIndices(owner),
      chattingAddress: owner, addressAt: (i) => deps.spendingAddressAt?.(i) || null,
    });
  }
  /** The regular slots Manage kUSDT lists (§11: Manage Addresses always shows these). */
  function listedSpendingIndices() {
    return new Set(listed().map((h) => h.spendingIndex).filter((i) => i != null));
  }
  function isListed(holding) {
    const owner = current();
    return isListedHolding(holding, { hidden: hiddenIds(owner), shown: shownIndices(owner) });
  }
  function toggleListed(holding) {
    const owner = current();
    if (!owner) return;
    const next = toggleListedSets(holding, { hidden: hiddenIds(owner), shown: shownIndices(owner) });
    writeList(keys(owner).hidden, next.hidden);
    writeList(keys(owner).shown, next.shown);
    emit();
  }
  function hideAll() {
    const owner = current();
    if (!owner) return;
    const next = hideAllListedSets(heldHoldings() || []);
    writeList(keys(owner).hidden, next.hidden);
    writeList(keys(owner).shown, next.shown);
    emit();
  }
  function hiddenCount() {
    return (heldHoldings() || []).filter((h) => !isListed(h)).length;
  }
  function addShown(index) {
    const owner = current();
    if (!owner || !isRegularIndex(index)) return;
    const shown = new Set(shownIndices(owner));
    shown.add(index);
    writeList(keys(owner).shown, [...shown].sort((a, b) => a - b));
    emit();
  }
  function holdingById(id) {
    const owner = current();
    const found = (holdings || []).find((h) => h.id === id);
    if (found) return found;
    const index = indexOfHoldingId(id);
    if (id === CHATTING_HOLDING_ID) return owner ? makeHolding(null, owner, 0n, 0) : null;
    const address = index != null ? deps.spendingAddressAt?.(index) : null;
    return address ? makeHolding(index, address, 0n, 0) : null;
  }
  function coinsOf(holding) { current(); return coins.get(holding?.id) || []; }
  function activity(holding = null) {
    const owner = current();
    if (!owner) return [];
    const rows = storeFor(owner).activity();
    return holding ? rows.filter((r) => r.holdingId === holding.id) : rows;
  }
  /** Whether this account uses kUSDT at all (iOS accountUsesTokens): the 90 s poll runs only then. */
  function usesTokens() {
    const owner = current();
    if (!owner) return false;
    const store = storeFor(owner);
    return Boolean((heldHoldings() || []).length || shownIndices(owner).length || store.activity().length
      || store.expectedCoins().length || knownIndices(owner).length);
  }
  /** A fresh regular address to receive on (iOS freshReceiveAddress): derived only. */
  function freshReceive() {
    current();
    const taken = (heldHoldings() || []).map((h) => h.spendingIndex).filter((i) => i != null);
    const index = freshRegularIndex(Number(deps.maxSpendingIndex?.() ?? -1), taken);
    const address = deps.spendingAddressAt?.(index);
    return address ? { index, address } : null;
  }
  /** Generate New Address (iOS generateFreshAddress): the next unused regular address, revealed and
   *  checked on in Manage kUSDT's list. Answers its number, or null. */
  async function generateFresh() {
    const owner = current();
    const fresh = freshReceive();
    if (!owner || !fresh) return null;
    await deps.revealSpendingSlot?.(fresh.index, owner);
    if (account() !== owner) return null;
    addShown(fresh.index);
    return addressNumber(fresh.index);
  }
  /** The address a send went to, if it's one of yours that holds kUSDT (iOS ownTokenAddress). */
  function ownTokenAddress(address) {
    const owner = account();
    const target = String(address || "").trim().toLowerCase();
    if (!owner || !target) return null;
    if (owner.toLowerCase() === target) return { id: CHATTING_HOLDING_ID, address: owner, label: "Chatting Address" };
    const max = Number(deps.maxSpendingIndex?.() ?? -1);
    for (let i = 0; i <= max; i += 1) {
      const a = deps.spendingAddressAt?.(i);
      if (a && a.toLowerCase() === target) return { id: holdingIdFor(i), address: a, label: labelOf(makeHolding(i, a, 0n, 0)) };
    }
    return null;
  }

  // MARK: Sends

  /** Sends a prepared transfer or combine (engine/kusdt-transfer.js submitPrepared), writing to the
   *  store of the account it was built on; then its coins leave the balances at once and the
   *  balances are looked up again once the node has it (iOS noteSent). */
  async function submit(prepared, { retryingUnknown = false } = {}) {
    const owner = prepared?.owner || account();
    if (!owner || account() !== owner) throw new Error("The account changed while this was open. Nothing was sent.");
    const store = storeFor(owner);
    const result = await submitPrepared(prepared, {
      engine: deps.engine, store, retryingUnknown, now: now(),
      markOwnTransaction: (txid) => deps.markOwnTransaction?.(txid),
      ownTokenAddress: (address) => ownTokenAddress(address),
      log,
    });
    if (loadedAccount === owner && account() === owner && holdings) {
      const spent = new Set(result.spentKeys);
      for (const [id, list] of coins) coins.set(id, list.filter((c) => !spent.has(outpointKey(c.transactionId, c.index))));
      const adjusted = adjustHoldingsAfterSend(holdings.map((h) => ({ ...h, holdingId: h.id })), prepared, result.ownRecipient);
      holdings = adjusted.map((h) => makeHolding(indexOfHoldingId(h.holdingId ?? h.id), h.address, h.units, h.coinCount))
        .sort((a, b) => (a.spendingIndex ?? -1) - (b.spendingIndex ?? -1));
      emit();
    }
    const timer = setTimeout(() => { if (account() === owner) refresh().catch(() => {}); }, result.refreshAfterMs);
    timer?.unref?.();
    return result;
  }

  // MARK: Polling

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      const owner = account();
      if (!shouldPoll({ visible: deps.isVisible?.() ?? true, account: owner, notificationsEnabled: deps.notificationsEnabled?.(), usesTokens: usesTokens() })) return;
      refreshIfStale(KUSDT_POLL_MAX_AGE_MS).catch(() => {});
    }, KUSDT_POLL_MS);
    pollTimer?.unref?.();
  }
  function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

  /** An account removed from this device (Delete Account and the other removals): its kUSDT
   *  records go (engine/kusdt-store.js forgetAccount), and the figures in memory if they're its. */
  function forgetAccount(owner) {
    const clean = String(owner || "").trim();
    if (!clean) return;
    forgetKusdtStorage(deps.storage, clean);
    stores.delete(clean);
    if (loadedAccount === clean) { resetMemory(null); emit(); }
  }

  return {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    refresh, refreshIfStale, discover, discoverIfStale, submit, startPolling, stopPolling, forgetAccount,
    heldHoldings, balance, listed, listedSpendingIndices, isListed, toggleListed, hideAll, hiddenCount,
    holdingById, coinsOf, activity, usesTokens, freshReceive, generateFresh, ownTokenAddress, addShown,
    labelOf, heldOnText: () => heldOnText(heldHoldings(), labelOf), kasHeld: () => kasHeldSompi(heldHoldings() || []),
    storeFor, canHold: (address) => canHoldKusdt(address, deps.network),
    get account() { return current(); },
    get error() { current(); return lastError; },
    get refreshing() { current(); return refreshing; },
    /** A Discover is looking (Send Dollars runs one as it opens, so its From step with no kUSDT
     *  says it's still checking rather than "none"). */
    get discovering() { current(); return discoveryRuns > 0; },
    get lastRefreshed() { current(); return lastRefreshed; },
    get known() { current(); return holdings != null; },
  };
}
