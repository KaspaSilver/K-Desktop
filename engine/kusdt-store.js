// kUSDT records kept on this device, per account: the history, the coins already seen (for
// "Received X kUSDT"), the coins a "Not confirmed" send spent, and the coins a send from here
// made that Trestly may not list yet.
//
// Port of KaPay iOS TokenWallet (Views/Tokens/WalletTokens.swift, afab8bd / 3d126db: `record`,
// `activityCap`, `seenKey`, `rememberSeen`, `pendingCoins`, `forgetLocalData`) and the
// unknown-outcome half of WalletService (`unknownOutcomeOutpoints`, `unknownOutcomeHold`,
// `rememberUnknownOutcome`, `conflictingOutpoint`). Storage is injected (anything with
// localStorage's getItem / setItem / removeItem), so the UI passes localStorage and tests a Map.
//
// Keys (iOS's names, `<account>` the account's address as the UI keys per-account data):
//   token_activity_kusdt_<account>   history rows, newest first, 300 at most
//   token_seen_kusdt_<account>       "txid:index" of every coin already known (absent: first look)
//   token_unknown_kusdt_<account>    { "txid:index": until-ms } coins of "Not confirmed" sends
//   token_expected_kusdt_<account>   coins a send from here made, checked until Trestly lists them
// and, cleared with them by `forgetAccount` (the UI's Address Visibility lists, iOS names):
//   token_hidden_kusdt_<account>, token_shown_kusdt_<account>, token_indices_<account>
// iOS keeps the unknown-outcome and expected lists in memory only; here they survive a reload, so
// a page reloaded right after "Not confirmed" still makes the next send conflict with it.

import { KUSDT_TOKEN_ID, outpointKey, makeState, stateToJson, stateFromJson } from "./kusdt.js";

/** At most this many history rows per account (iOS `activityCap`). */
export const ACTIVITY_CAP = 300;
/** How long a "Not confirmed" send's coins are remembered (iOS `unknownOutcomeHold`, 600 s). */
export const UNKNOWN_OUTCOME_HOLD_MS = 600_000;
/** An expected coin is checked until Trestly lists it, for 30 minutes at most (iOS `apply`). */
export const EXPECTED_MAX_AGE_MS = 1_800_000;
/** For 2 minutes an expected coin the node doesn't show yet still counts in the balance (not in
 *  what a send can spend), so the balance doesn't dip while the network catches up. */
export const EXPECTED_LANDING_MS = 120_000;
/** History kinds (iOS `TokenActivity.Kind`). */
export const ACTIVITY_KINDS = Object.freeze(["received", "sent", "swapped", "bridged", "combined"]);

/** Storage keys of `account` (iOS `token_<kind>_<token>_<account>`). */
export function kusdtStorageKeys(account) {
  const a = String(account);
  const t = KUSDT_TOKEN_ID;
  return {
    activity: `token_activity_${t}_${a}`,
    seen: `token_seen_${t}_${a}`,
    unknown: `token_unknown_${t}_${a}`,
    expected: `token_expected_${t}_${a}`,
    hidden: `token_hidden_${t}_${a}`,
    shown: `token_shown_${t}_${a}`,
    indices: `token_indices_${a}`,
  };
}

/** Removes every kUSDT record of `account` from `storage` (iOS `TokenWallet.forgetLocalData`):
 *  Delete Account and the other removals. */
export function forgetAccount(storage, account) {
  for (const key of Object.values(kusdtStorageKeys(account))) {
    try { storage?.removeItem?.(key); } catch { /* storage blocked */ }
  }
}

/** The history row id for what this device records: "txid:holding:kind", so a send noted twice (a
 *  lost answer, then Try Again) is one line. */
export function activityId(txid, holdingId, kind) { return `${String(txid).toLowerCase()}:${holdingId}:${kind}`; }

/** The transaction id of a row this device recorded, or null. */
export function activityTxid(row) {
  const first = String(row?.id ?? "").split(":")[0];
  return /^[0-9a-f]{64}$/i.test(first) ? first.toLowerCase() : null;
}

function readJson(storage, key, fallback) {
  try {
    const text = storage?.getItem?.(key);
    if (text == null) return fallback;
    return JSON.parse(text);
  } catch { return fallback; }
}
function writeJson(storage, key, value) {
  try { storage?.setItem?.(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}
function bigOrNull(v) {
  try { return v == null ? null : BigInt(v); } catch { return null; }
}

/** A history row as kept: `{ id, kind, units: bigint, counterparty, date: ms, pending, holdingId,
 *  fee: bigint|null, outgoing: boolean|null }` (iOS `TokenActivity`; amounts as strings in
 *  storage). */
function rowFromStored(r) {
  if (!r || typeof r !== "object" || !ACTIVITY_KINDS.includes(r.kind)) return null;
  const units = bigOrNull(r.units);
  if (units == null) return null;
  return {
    id: String(r.id ?? ""), kind: r.kind, units, counterparty: String(r.counterparty ?? ""),
    date: Number(r.date) || 0, pending: !!r.pending, holdingId: String(r.holdingId ?? "chatting"),
    fee: bigOrNull(r.fee), outgoing: typeof r.outgoing === "boolean" ? r.outgoing : null,
  };
}
function rowToStored(r) {
  return {
    id: r.id, kind: r.kind, units: String(r.units), counterparty: r.counterparty, date: r.date, pending: !!r.pending,
    holdingId: r.holdingId, fee: r.fee == null ? null : String(r.fee), outgoing: r.outgoing ?? null,
  };
}

/** The per-account store. `storage`: localStorage-like. `account`: the account's key string.
 *  `now()`: the clock (ms). */
export function createKusdtStore({ storage, account, now = () => Date.now() }) {
  if (!account) throw new Error("kUSDT store: no account");
  const keys = kusdtStorageKeys(account);

  // MARK: History (iOS `record`, `activity(of:)`)

  /** Newest first. */
  function activity() {
    const rows = readJson(storage, keys.activity, []);
    return Array.isArray(rows) ? rows.map(rowFromStored).filter(Boolean) : [];
  }

  /** Adds (or replaces, by id) one row; newest first, ACTIVITY_CAP at most. */
  function record(row) {
    const r = {
      id: row.id ?? `${now()}-${Math.random().toString(36).slice(2)}`,
      kind: row.kind, units: BigInt(row.units), counterparty: String(row.counterparty ?? ""),
      date: row.date ?? now(), pending: !!row.pending, holdingId: row.holdingId ?? "chatting",
      fee: row.fee == null ? null : BigInt(row.fee), outgoing: row.outgoing ?? null,
    };
    if (!ACTIVITY_KINDS.includes(r.kind)) throw new Error(`kUSDT history: unknown kind ${r.kind}`);
    let rows = activity().filter((x) => x.id !== r.id);
    rows.unshift(r);
    rows.sort((a, b) => b.date - a.date);
    if (rows.length > ACTIVITY_CAP) rows = rows.slice(0, ACTIVITY_CAP);
    writeJson(storage, keys.activity, rows.map(rowToStored));
    return r;
  }

  /** The transactions this device made (sends, combines, swaps): their coins are never announced
   *  as received (a KaChat hardening of iOS's seen list, which can drop a send's outputs before
   *  the node shows them). */
  function ownTxids() {
    const out = new Set();
    for (const row of activity()) {
      if (row.kind === "received") continue;
      const txid = activityTxid(row);
      if (txid) out.add(txid);
    }
    return out;
  }

  // MARK: Seen coins (iOS `seenOutpoints`, `rememberSeen`)

  /** The coins known for the account, or null before its first look. */
  function seenOutpoints() {
    const list = readJson(storage, keys.seen, null);
    return Array.isArray(list) ? new Set(list.map(String)) : null;
  }

  /** The coins there now (`current`, "txid:index" keys of every verified coin), plus `found`
   *  (what Discover found): the list never outgrows the wallet. */
  function rememberSeen(current, found = current) {
    const present = new Set([...current].map(String));
    const set = new Set([...(seenOutpoints() ?? [])].filter((k) => present.has(k)));
    for (const k of found) set.add(String(k));
    writeJson(storage, keys.seen, [...set]);
  }

  /** Every output of a send from here: it can only be yours if it's change, or a send to yourself. */
  function markOutputsSeen(txid, outputCount) {
    const set = seenOutpoints() ?? new Set();
    for (let i = 0; i < outputCount; i += 1) set.add(outpointKey(txid, i));
    writeJson(storage, keys.seen, [...set]);
  }

  // MARK: "Not confirmed" (iOS `rememberUnknownOutcome`, `unknownOutcomeKeys`)

  function unknownMap() {
    const map = readJson(storage, keys.unknown, {});
    const t = now();
    const live = {};
    let changed = false;
    for (const [k, until] of Object.entries(map && typeof map === "object" ? map : {})) {
      if (Number(until) > t) live[k] = Number(until); else changed = true;
    }
    if (changed) writeJson(storage, keys.unknown, live);
    return live;
  }

  /** A send ended "Not confirmed": its coins (token and KAS), for UNKNOWN_OUTCOME_HOLD_MS. The
   *  next send or combine from them spends one of them too, so at most one of the two can land. */
  function rememberUnknownOutcome(outpointKeys) {
    const map = unknownMap();
    const until = now() + UNKNOWN_OUTCOME_HOLD_MS;
    for (const k of outpointKeys || []) map[String(k).toLowerCase()] = until;
    writeJson(storage, keys.unknown, map);
  }

  /** Every "txid:index" a "Not confirmed" send spent, still remembered. */
  function unknownOutcomeKeys() { return new Set(Object.keys(unknownMap())); }

  // MARK: Expected coins (iOS `PendingCoin`)

  /** `[{ holdingId, address, transactionId, index, state, since }]`. */
  function expectedCoins() {
    const list = readJson(storage, keys.expected, []);
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const e of list) {
      const state = stateFromJson(e?.state);
      if (!state || !/^[0-9a-f]{64}$/.test(String(e?.transactionId ?? ""))) continue;
      out.push({
        holdingId: String(e.holdingId ?? "chatting"), address: String(e.address ?? ""),
        transactionId: String(e.transactionId), index: Number(e.index) || 0, state, since: Number(e.since) || 0,
      });
    }
    return out;
  }

  function setExpectedCoins(list) {
    writeJson(storage, keys.expected, (list || []).map((e) => ({
      holdingId: e.holdingId, address: e.address, transactionId: String(e.transactionId).toLowerCase(),
      index: Number(e.index), since: Number(e.since),
      state: { ...stateToJson(makeState(e.state)), amount: String(e.state.amount) },
    })));
  }

  return {
    account, keys, activity, record, ownTxids,
    seenOutpoints, rememberSeen, markOutputsSeen,
    rememberUnknownOutcome, unknownOutcomeKeys,
    expectedCoins, setExpectedCoins,
    forget: () => forgetAccount(storage, account),
  };
}
