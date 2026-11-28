// Address Activity's rules (iOS 56b75c8, AddressActivityNotifier; KaPay 34f4b45 / 42470af). Pure,
// so tools/test-address-activity.mjs can run them without the app.
//
// The chatting address notifies only for a plain transfer: a transaction with a payload (a KaChat
// chat payment, a message, a handshake) is the chat's own news and stays quiet. Every address's
// catch-up counts only receives newer than its floor - the newest block time an earlier catch-up
// looked at, or when the address started being tracked - newest first and no more than the
// balance grew by, so older history is never announced again (KaPay 34f4b45). A receive is never
// announced when any of its inputs spends from one of our addresses: our own change, including
// what another app on the same seed sends (KaPay 42470af).

import { checkedSompiSum } from "../engine/amounts.js";

/** A transaction with no payload: plain KAS, not a KaChat chat payment, message or handshake
 *  (iOS isPlainTransfer). The REST API sends the payload as hex, "" or null when there is none. */
export function isPlainTransferTx(tx) {
  return !String(tx?.payload ?? "").trim();
}

/** A REST transaction's block time in ms, 0 when unknown. */
export function txBlockTimeMs(tx) {
  const value = Number(tx?.block_time ?? tx?.blockTime ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** How long a skipped block reward may still be accepted, so the floor waits below it (K 961fc05a,
 *  audit 2026-11-25 C1). */
export const UNACCEPTED_HOLD_MS = 10 * 60_000;

/** One catch-up look at an address (KaPay 34f4b45): `floor` is the newest block time (ms) already
 *  looked at (0 = none yet: the balance increase alone bounds it). Gives the floor to store (the
 *  newest fetched block time, never below `floor`; `floor` when nothing has one) and the txs that
 *  may count, newest first (one with no block time yet is the newest): those newer than the floor,
 *  and for the chatting address plain transfers only.
 *
 *  `belongsInHistory` (engine/sync.js transactionBelongsInHistory): no block reward the network
 *  didn't accept counts (K 961fc05a). A block a miner finds is merged by many later blocks, each
 *  carrying a coinbase paying them, and only the chain block's is accepted, so announcing them all
 *  pinged once per merging block. And the floor never moves past one this look skipped from the
 *  last ten minutes, which may still be accepted, so the next look sees it again (audit C1). */
export function catchUpCandidates(txs, floor, { chatting = false, belongsInHistory = () => true, now = Date.now() } = {}) {
  const list = Array.isArray(txs) ? txs : [];
  const previous = Number(floor) > 0 ? Number(floor) : 0;
  const belongs = (tx) => { try { return belongsInHistory(tx) !== false; } catch { return true; } };
  const times = list.map(txBlockTimeMs).filter((time) => time > 0);
  let nextFloor = times.length ? Math.max(...times) : previous;
  const held = list.filter((tx) => !belongs(tx)).map(txBlockTimeMs)
    .filter((time) => time > previous && now - Math.min(now, time) < UNACCEPTED_HOLD_MS);
  if (held.length) nextFloor = Math.min(nextFloor, Math.min(...held) - 1);
  nextFloor = Math.max(nextFloor, previous);
  const rank = (tx) => txBlockTimeMs(tx) || Number.MAX_SAFE_INTEGER;
  const candidates = list
    .filter(belongs)
    .filter((tx) => !(previous && txBlockTimeMs(tx) && txBlockTimeMs(tx) <= previous))
    .filter((tx) => !chatting || isPlainTransferTx(tx))
    .sort((a, b) => rank(b) - rank(a));
  return { nextFloor, candidates };
}

/** How many of an address's newest transactions a catch-up reads (K 01f71184 audit B6: 3, not 10:
 *  it runs on every check, and the chatting address's newest are mostly your own messages). */
export const CATCH_UP_TX_COUNT = 3;

/**
 * One catch-up look with the bell rule (K 01f71184, owner 2026-11-27): every receive to an own
 * address goes in Profile's bell, with notifications or Address Activity off too and whatever the
 * address's own switch; `rings` (Address Activity on and the address's switch on) decides only the
 * ping. Every address has a floor (audit R2): an address looked at for the first time (`storedFloor`
 * 0) only sets it, silently, when it is the chatting address or quiet - so turning quiet addresses'
 * receives into bell rows never files months-old ones. A ringing address's first look counts as it
 * always did (bounded by the balance increase). An empty answer on a first look sets the floor to
 * `now`. Gives `{ floorToSave (0 = keep), candidates, firstLookOnly }`.
 */
export function catchUpLook(txs, storedFloor, { chatting = false, rings = false, belongsInHistory = () => true, now = Date.now() } = {}) {
  const firstLook = !(Number(storedFloor) > 0);
  const { nextFloor, candidates } = catchUpCandidates(txs, storedFloor, { chatting, belongsInHistory, now });
  const floorToSave = nextFloor || (firstLook ? now : 0);
  const firstLookOnly = firstLook && (chatting || !rings);
  return { floorToSave, candidates: firstLookOnly ? [] : candidates, firstLookOnly };
}

/** What a REST transaction's outputs pay `address`, BigInt sompi: `readAddress(output)` and
 *  `readAmount(output)` read each output. Null when an amount or the sum is past u64 or negative
 *  (K 01f71184 audit R6): the transaction is skipped, never filed with a sum that can't be real. */
export function outputsSompiTo(tx, address, { readAddress, readAmount }) {
  const amounts = [];
  for (const output of Array.isArray(tx?.outputs) ? tx.outputs : []) {
    if (readAddress(output) === address) amounts.push(readAmount(output));
  }
  return checkedSompiSum(amounts);
}

function inputAddress(input) {
  return String(
    input?.previous_outpoint_address || input?.previousOutpointAddress ||
    input?.previous_outpoint_resolved?.script_public_key_address ||
    input?.previousOutpointResolved?.scriptPublicKeyAddress || "",
  ).trim();
}

/**
 * Whether `tx` spends from any of our addresses (KaPay 42470af spendsOwnFunds): true as soon as one
 * input is ours, false when every input is placed and none is, null when some input couldn't be
 * placed. An input the REST API left unresolved (usual for a transaction seconds old) is matched
 * against `recentOwnSpent` (outpoints "txid:index" our addresses just spent), then looked up in the
 * transaction that created it: `outputAddress(txid, index)` resolves to that output's address, or
 * null when it can't be read.
 */
export async function spendsOwnFunds(tx, ownAddresses, { recentOwnSpent = null, outputAddress = null } = {}) {
  const inputs = Array.isArray(tx?.inputs) ? tx.inputs : [];
  if (!inputs.length) return null;
  const unresolved = [];
  let unknown = false;
  for (const input of inputs) {
    const address = inputAddress(input);
    if (address) {
      if (ownAddresses.has(address)) return true;
      continue;
    }
    const hash = String(input?.previous_outpoint_hash ?? input?.previousOutpoint?.transactionId ?? "").trim();
    const index = Number(input?.previous_outpoint_index ?? input?.previousOutpoint?.index);
    if (!hash || !Number.isInteger(index) || index < 0) { unknown = true; continue; }
    if (recentOwnSpent?.has?.(`${hash}:${index}`)) return true;
    unresolved.push({ hash, index });
  }
  for (const { hash, index } of unresolved) {
    let address = null;
    try { address = outputAddress ? await outputAddress(hash, index) : null; } catch { address = null; }
    if (!address) { unknown = true; continue; }
    if (ownAddresses.has(address)) return true;
  }
  return unknown ? null : false;
}

// Transactions this app made whose KAS comes back to one of our addresses with no input from them
// (KaPay 3d126db KusdtTransfer.send `markOwnTransaction`): a kUSDT send or Combine Coins spends the
// token coins, which sit at their own contract address, so the KAS change or the KAS a combine gives
// back reads as someone else's payment to spendsOwnFunds. The send marks its id before it goes out,
// and the catch-up treats it as our own. Kept for an hour (a catch-up runs within minutes), in
// memory and, where there is one, in localStorage so a reload right after the send still knows it.
const OWN_TX_KEY = "kachat-own-txids-v1";
const OWN_TX_KEEP_MS = 60 * 60 * 1000;
const ownTxMarks = new Map(); // txid -> marked at (ms)
function ownTxStorage() {
  try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; }
}
function loadOwnTxMarks(now) {
  const storage = ownTxStorage();
  if (!storage) return;
  try {
    const stored = JSON.parse(storage.getItem(OWN_TX_KEY) || "{}") || {};
    for (const [txid, at] of Object.entries(stored)) {
      if (now - Number(at) < OWN_TX_KEEP_MS && !ownTxMarks.has(txid)) ownTxMarks.set(txid, Number(at));
    }
  } catch { /* unreadable: memory only */ }
}
function saveOwnTxMarks() {
  const storage = ownTxStorage();
  if (!storage) return;
  try { storage.setItem(OWN_TX_KEY, JSON.stringify(Object.fromEntries(ownTxMarks))); } catch { /* full or blocked */ }
}
function pruneOwnTxMarks(now) {
  for (const [txid, at] of ownTxMarks) if (now - at >= OWN_TX_KEEP_MS) ownTxMarks.delete(txid);
}

/** Marks `txid` as made here: its outputs to our addresses are never announced as received. */
export function markOwnTransaction(txid, now = Date.now()) {
  const id = String(txid || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) return;
  loadOwnTxMarks(now);
  ownTxMarks.set(id, now);
  pruneOwnTxMarks(now);
  saveOwnTxMarks();
}

/** Whether `txid` was marked by markOwnTransaction within the last hour. */
export function isMarkedOwnTransaction(txid, now = Date.now()) {
  const id = String(txid || "").trim().toLowerCase();
  if (!id) return false;
  loadOwnTxMarks(now);
  pruneOwnTxMarks(now);
  return ownTxMarks.has(id);
}
