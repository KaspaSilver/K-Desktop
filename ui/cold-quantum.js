// Cold Storage's KasSigner quantum-resistant (KCC-3) addresses (K 961fc05a, owner 2026-11-25:
// "matching what hot wallet has"): the records, their names, where they sit in an account's index
// space, and which one takes a quantum source's change. Pure (no DOM, no WASM, no network: the
// probes are passed in), so tools/test-cold-storage-quantum.mjs runs it as is; ui/coldstorage.js
// wires it to the screen, the node and the REST server.
//
// A KCC-3 address is "Pay-to-Public-Key-Hash via P2SH": P2SH of `<P> OP_CHECKSIG`, P at
// m/22'/111111'/0'/<chain>/<n> on the unit - the hot wallet's KIP-22 scheme and path. A unit never
// exports a 22' kpub (it would show every key the addresses hide), so each address is added by scan
// or paste from the unit's address screen, with its number on the unit optional.

import { QUANTUM_INDEX_BASE } from "../engine/quantum.js";

/** Where an account's quantum addresses start in its index space (labels, hidden flags), clear of
 *  any receive index a kpub could reach: the hot wallet's base (K ColdStorageManager.quantumIndexBase). */
export const COLD_QUANTUM_INDEX_BASE = QUANTUM_INDEX_BASE;

/** The unit's two KCC-3 chains (m/22'/111111'/0'/<chain>/n). */
export const QUANTUM_CHAIN_RECEIVE = 0;
export const QUANTUM_CHAIN_CHANGE = 1;

/** The change-chain numbers KasSigner recognises as its own change when it shows the outputs
 *  (firmware `Keyring::kcc3_change_index`, CHANGE_DEPTH keys of its bank): #0 to #4. Change sent to
 *  any other address, a receive one included, shows on the unit as an ordinary payment. */
export const UNIT_MARKED_CHANGE_MAX = 4;

/** A KasSigner address number: below 2^31 (higher ones are hardened). */
const MAX_UNIT_INDEX = 0x7fffffff;

export function isColdQuantumIndex(index) {
  return Number.isInteger(index) && index >= COLD_QUANTUM_INDEX_BASE;
}

/** A stored record, sanitized: `{ address, unitIndex (number | null), chain (0 | 1), addedAt }`.
 *  Records saved before the chain was asked for read as receive, which is what they were sent as. */
export function normalizeQuantumRecord(raw) {
  const address = String(raw?.address || "").trim().toLowerCase();
  if (!address) return null;
  const n = raw?.unitIndex;
  const unitIndex = Number.isInteger(n) && n >= 0 && n <= MAX_UNIT_INDEX ? n : null;
  return {
    address,
    unitIndex,
    chain: raw?.chain === QUANTUM_CHAIN_CHANGE ? QUANTUM_CHAIN_CHANGE : QUANTUM_CHAIN_RECEIVE,
    addedAt: Number(raw?.addedAt) || 0,
  };
}

/** An account's records, sanitized, one per address, in the order added. */
export function normalizeQuantumRecords(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const record = normalizeQuantumRecord(raw);
    if (!record || seen.has(record.address)) continue;
    seen.add(record.address);
    out.push(record);
  }
  return out;
}

/** The unit will show change sent here as CHANGE, not as a payment to someone. */
export function unitMarksAsChange(record) {
  return record?.chain === QUANTUM_CHAIN_CHANGE && Number.isInteger(record.unitIndex) && record.unitIndex <= UNIT_MARKED_CHANGE_MAX;
}

/** The default name, by chain and number ("Quantum Address #3", "Quantum Change Address #0"). */
export function quantumDefaultLabel(chain, unitIndex) {
  const base = chain === QUANTUM_CHAIN_CHANGE ? "Quantum Change Address" : "Quantum Address";
  return Number.isInteger(unitIndex) ? `${base} #${unitIndex}` : base;
}

/** What a scanned or pasted address reads as: trimmed, a payment URI's query dropped
 *  ("kaspa:...?amount="), lower case. Whether it is a P2SH address of this network is the caller's
 *  check (it needs the SDK). */
export function quantumAddressInput(text) {
  let raw = String(text || "").trim();
  const query = raw.indexOf("?");
  if (query >= 0) raw = raw.slice(0, query);
  return raw.toLowerCase();
}

/** The typed address number: `{ ok: true, value }` (value null when empty), or `{ ok: false,
 *  message }` when it isn't a number the unit can have (K ColdQuantumNumberFields.parse). */
export function parseUnitNumber(text) {
  const digits = String(text ?? "").trim();
  if (!digits) return { ok: true, value: null };
  if (!/^[0-9]+$/.test(digits)) return { ok: false, message: "The address number must be a whole number." };
  const value = Number(digits);
  if (!Number.isSafeInteger(value) || value > MAX_UNIT_INDEX) {
    return { ok: false, message: "That number is too large: KasSigner's address numbers are below 2147483648." };
  }
  return { ok: true, value };
}

/** Where `address` sits in its account's index space now (base + its place in the list), or null
 *  once it's no longer watched. Labels and hidden flags are filed by this index, which moves when an
 *  earlier one is removed, so an edit resolves it by address at the moment it saves. */
export function quantumIndexOf(records, address) {
  const lowered = String(address || "").toLowerCase();
  const position = (records || []).findIndex((r) => r.address === lowered);
  return position < 0 ? null : COLD_QUANTUM_INDEX_BASE + position;
}

/** Labels and hidden flags after the quantum address at `position` stops being watched: its own
 *  go, the ones after it move up a place with their addresses, everything else stays. `labels` is
 *  `{ index: label }`, `hidden` an array of indices. */
export function afterQuantumRemoval({ labels = {}, hidden = [] }, position) {
  const removed = COLD_QUANTUM_INDEX_BASE + position;
  const shifted = (index) => {
    if (!isColdQuantumIndex(index) || index < removed) return index;
    return index === removed ? null : index - 1;
  };
  const nextLabels = {};
  for (const [key, label] of Object.entries(labels || {})) {
    const moved = shifted(Number(key));
    if (moved !== null && Number.isFinite(moved)) nextLabels[moved] = label;
  }
  const nextHidden = [];
  for (const index of hidden || []) {
    const moved = shifted(Number(index));
    if (moved !== null && Number.isFinite(moved) && !nextHidden.includes(moved)) nextHidden.push(moved);
  }
  return { labels: nextLabels, hidden: nextHidden };
}

/** 0: change chain #0-4 (the unit marks them CHANGE), 1: other change-chain, 2: the rest. */
export function changeRank(record) {
  if (unitMarksAsChange(record)) return 0;
  return record?.chain === QUANTUM_CHAIN_CHANGE ? 1 : 2;
}

/** The candidates for a quantum source's change, best first: the account's other quantum
 *  addresses not reserved by another request, by changeRank, then in the order added. */
export function rankedChangeCandidates(records, source, reserved = new Set()) {
  const from = String(source || "").toLowerCase();
  return (records || [])
    .map((record, offset) => ({ record, offset }))
    .filter(({ record }) => record.address !== from && !reserved.has(record.address))
    .sort((a, b) => (changeRank(a.record) - changeRank(b.record)) || (a.offset - b.offset))
    .map(({ record }) => record.address);
}

/**
 * Where a send from a quantum address puts its change, and where Compound moves a quantum address's
 * coins (K 961fc05a freshQuantumChangeAddress): another quantum address of the same account that
 * holds nothing, has never been used and has never spent - the spend makes the source's key
 * public. Change-chain #0-4 first, the ones KasSigner itself marks as CHANGE; then other change-
 * chain addresses; receive addresses last. Everything is read fresh:
 * - `fundedAddresses(candidates)` -> Set of those holding coins, or null when it can't be read
 *   (then there is no pick);
 * - `usedState(address)` -> true / false / null (null, a read that failed, counts as used);
 * - `spentState(address)` -> true when a spend put its key on chain (never change, whatever else).
 * The pick is added to `reserved` (lowercased addresses) so a second request built before this
 * one's change shows on chain can't take it. Null when there is none.
 */
export async function pickFreshQuantumChange({ records, source, reserved, fundedAddresses, usedState, spentState }) {
  const ranked = rankedChangeCandidates(records, source, reserved);
  if (!ranked.length) return null;
  let funded = null;
  try { funded = await fundedAddresses(ranked); } catch { funded = null; }
  if (!(funded instanceof Set)) return null;
  for (const candidate of ranked) {
    if (funded.has(candidate)) continue;
    let used = null;
    try { used = await usedState(candidate); } catch { used = null; }
    if (used !== false) continue;
    let spent = null;
    try { spent = await spentState(candidate); } catch { spent = null; }
    if (spent === true) continue;
    // another build may have taken it while this one was reading
    if (reserved.has(candidate)) continue;
    reserved.add(candidate);
    return candidate;
  }
  return null;
}

/**
 * An outgoing history row's figures, counting the account's own addresses (K 961fc05a
 * ColdStorageAddressTransactionHistoryView.transactionRow): change to another of the account's
 * addresses - a quantum send's change goes to a fresh quantum address - is its own, not Sent.
 * `ownAddresses` is the account's addresses, lowercased. Returns null when no output went to
 * another address of the account (the row keeps its usual figures); else `{ moved, amountSompi }`:
 * Moved with what reached the account's other addresses when nothing left the account, otherwise
 * Sent with what went to others.
 */
export function ownChangeHistoryAmount(tx, address, ownAddresses) {
  const self = String(address || "").toLowerCase();
  let toOthers = 0n;
  let ownChange = 0n;
  for (const output of tx?.outputs || []) {
    const to = String(output?.script_public_key_address || "").toLowerCase();
    if (!to || to === self) continue;
    const amount = BigInt(output?.amount || 0);
    if (ownAddresses.has(to)) ownChange += amount;
    else toOthers += amount;
  }
  if (ownChange === 0n) return null;
  return toOthers === 0n ? { moved: true, amountSompi: ownChange } : { moved: false, amountSompi: toOthers };
}
