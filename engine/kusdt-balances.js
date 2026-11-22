// Reading an address's kUSDT the way kusdt-open's wallet does (`wallet/extension/src/kusdt/verify.ts`).
//
// Port of KaPay iOS KaChatWallet/Services/Tokens/KusdtBalances.swift (e188209, 3d126db) and the
// balance half of TokenWallet (Views/Tokens/WalletTokens.swift: `apply`, `pendingCoins`,
// `scheduleFollowUpIfPending`, `announceNewCoins`, `isOwnTransfer`). Trestly's API says which coins
// the owner has (`GET {api}/tokens?owner=`, SPEC section 13), and each one is believed only once the
// node shows it:
//   1. the state is a plain coin of this address's key (`isPlainStateOf`),
//   2. its locking script is recomputed here from the state and the pinned template,
//   3. the node holds that exact outpoint at that script, carrying kUSDT's covenant id.
// Anything else is dropped. The API learns the address asked about; nothing else leaves the device.
//
// Dependency-injected: `getUtxos(addresses)` is the engine's wRPC read with covenant ids
// (engine.getUtxosWithCovenants - wRPC only: the REST API carries no covenant id, so there is no
// fallback), `fetchImpl` the fetch to Trestly. Trestly sends CORS `*`, so the API is read directly
// (never through the /nc-proxy relay): no cookies, no cache, no referrer.

import {
  kusdtDeployment, kusdtTemplate, schnorrOwner, isPlainStateOf, stateFromJson, lockingScript, coinAddress,
  outpointKey, parseExactJson, jsonU64,
} from "./kusdt.js";
import { hex } from "./kachat-names/codec.js";
import { EXPECTED_MAX_AGE_MS, EXPECTED_LANDING_MS } from "./kusdt-store.js";

/** The biggest honest answer (500 coins with their states) is well under this (iOS). */
export const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
/** iOS asks with a 15 s request timeout. */
export const API_TIMEOUT_MS = 15_000;
/** A pending coin the node doesn't show yet is looked for again after this (iOS 5 s). */
export const FOLLOW_UP_MS = 5_000;

/** iOS texts (KusdtBalances.Failure). */
export const BALANCE_MESSAGES = Object.freeze({
  templateMissing: "K's kUSDT template is missing, so kUSDT can't be checked.",
  badApiUrl: "The Trestly API address in Connection Settings isn't a valid https address.",
  noAnswer: "Trestly didn't answer.",
  httpStatus: (status) => `Trestly answered HTTP ${status}.`,
  unreadable: "Trestly's answer couldn't be read.",
});

export class KusdtBalanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "KusdtBalanceError";
    this.code = code;
  }
}

// MARK: - Trestly's API

/** One listed entry `{ transactionId, index, state|null }`, or null when its outpoint is unreadable
 *  (iOS `listed`). */
function listedEntry(entry) {
  const utxo = entry?.utxo;
  if (!utxo || typeof utxo !== "object") return null;
  const txid = typeof utxo.transactionId === "string" ? utxo.transactionId.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(txid)) return null;
  const index = jsonU64(utxo.index);
  if (index == null || index > 0xffffffffn) return null;
  return { transactionId: txid, index: Number(index), state: stateFromJson(entry.state) };
}

/** `GET {apiBase}/tokens?owner=<address>` -> `{ states: [{ transactionId, index, state }], unreadCount }`.
 *  https only, 4 MB at most, read with exact integers. Throws KusdtBalanceError. */
export async function fetchTokenStates(apiBase, address, { fetchImpl = globalThis.fetch, timeoutMs = API_TIMEOUT_MS } = {}) {
  const base = String(apiBase ?? "").trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(`${base}/tokens`);
  } catch {
    throw new KusdtBalanceError("api", BALANCE_MESSAGES.badApiUrl);
  }
  if (url.protocol !== "https:") throw new KusdtBalanceError("api", BALANCE_MESSAGES.badApiUrl);
  url.searchParams.set("owner", String(address));
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  timer?.unref?.();
  let response;
  let bytes;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller?.signal,
    });
    if (!response || typeof response.status !== "number") throw new KusdtBalanceError("api", BALANCE_MESSAGES.noAnswer);
    if (response.status < 200 || response.status > 299) throw new KusdtBalanceError("api", BALANCE_MESSAGES.httpStatus(response.status));
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > MAX_ANSWER_BYTES) throw new KusdtBalanceError("api", BALANCE_MESSAGES.unreadable);
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof KusdtBalanceError) throw error;
    throw new KusdtBalanceError("api", BALANCE_MESSAGES.noAnswer);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (bytes.length > MAX_ANSWER_BYTES) throw new KusdtBalanceError("api", BALANCE_MESSAGES.unreadable);
  let json;
  try { json = parseExactJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { json = null; }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new KusdtBalanceError("api", BALANCE_MESSAGES.unreadable);
  const states = (Array.isArray(json.states) ? json.states : []).map(listedEntry).filter(Boolean);
  const unreadCount = Array.isArray(json.unread) ? json.unread.length : 0;
  return { states, unreadCount };
}

// MARK: - Verified coins

/** The address's verified kUSDT coins (iOS `KusdtBalances.fetch`):
 *  `{ address, coins: [{ transactionId, index, state, kasSompi, blockDaaScore }], listedByAPI: Set,
 *  uncheckedCount, units }`. `expected`: coins a send from here made that Trestly may not list yet
 *  (`[{ transactionId, index, state }]`), checked on the node like the listed ones. An address that
 *  isn't a Schnorr key address of `network` holds none KaChat can use, and isn't asked about.
 *  `getUtxos(addresses)` (or `engine.getUtxosWithCovenants`): node UTXOs as plain objects with
 *  `scriptPublicKey` (script hex), `scriptVersion`, `covenantId`. */
export async function verifiedCoins({
  engine = null, getUtxos = null, apiBase = null, address, expected = [], network, template = kusdtTemplate(),
  fetchImpl = globalThis.fetch, log = () => {},
}) {
  const deployment = kusdtDeployment(network);
  const owner = schnorrOwner(address, deployment.network);
  const empty = { address, coins: [], listedByAPI: new Set(), uncheckedCount: 0, units: 0n };
  if (!owner) return empty;
  if (!template) throw new KusdtBalanceError("templateMissing", BALANCE_MESSAGES.templateMissing);
  const readUtxos = getUtxos ?? ((list) => engine.getUtxosWithCovenants(list));
  const answer = await fetchTokenStates(apiBase ?? deployment.apiBase, address, { fetchImpl });

  // 1 and 2: plain coins of this key, with their scripts and addresses worked out here
  const wanted = [];
  // one entry per outpoint: an API that lists a coin twice can't make it count twice
  const seen = new Set();
  for (const entry of answer.states) {
    const key = outpointKey(entry.transactionId, entry.index);
    if (!entry.state || !isPlainStateOf(entry.state, owner) || seen.has(key)) continue;
    seen.add(key);
    const script = lockingScript(entry.state, template);
    const at = coinAddress(script, deployment.network);
    if (!at) continue;
    wanted.push({ transactionId: entry.transactionId, index: entry.index, state: entry.state, script, address: at });
  }
  const listedByAPI = new Set(wanted.map((w) => outpointKey(w.transactionId, w.index)));
  for (const e of expected || []) {
    const key = outpointKey(e.transactionId, e.index);
    if (listedByAPI.has(key) || !e.state || !isPlainStateOf(e.state, owner) || seen.has(key)) continue;
    seen.add(key);
    const script = lockingScript(e.state, template);
    const at = coinAddress(script, deployment.network);
    if (!at) continue;
    wanted.push({ transactionId: String(e.transactionId).toLowerCase(), index: Number(e.index), state: e.state, script, address: at });
  }
  if (!wanted.length) return { ...empty, listedByAPI, uncheckedCount: answer.unreadCount };

  // 3: the node, one read for every address (never the REST fallback: it carries no covenant id)
  const utxos = await readUtxos([...new Set(wanted.map((w) => w.address))]);
  // the first UTXO the node lists at that outpoint, as iOS (`utxos.first(where:)`)
  const byOutpoint = new Map();
  for (const u of utxos || []) {
    const key = outpointKey(u?.outpoint?.transactionId ?? "", u?.outpoint?.index ?? -1);
    if (!byOutpoint.has(key)) byOutpoint.set(key, u);
  }
  const covenant = deployment.covenantId;
  const coins = [];
  for (const w of wanted) {
    const u = byOutpoint.get(outpointKey(w.transactionId, w.index));
    if (!u || String(u.scriptPublicKey ?? "").toLowerCase() !== hex(w.script)
      || Number(u.scriptVersion ?? 0) !== 0
      || String(u.covenantId ?? "").toLowerCase() !== covenant) continue;
    coins.push({
      transactionId: w.transactionId, index: w.index, state: w.state,
      kasSompi: BigInt(u.amount), blockDaaScore: BigInt(u.blockDaaScore ?? 0),
    });
  }
  if (coins.length < wanted.length) log(`[kUSDT] ${wanted.length - coins.length} of ${wanted.length} listed coins weren't on the node as listed: not shown`);
  return { address, coins, listedByAPI, uncheckedCount: answer.unreadCount, units: coins.reduce((s, c) => s + c.state.amount, 0n) };
}

// MARK: - Holdings and expected coins (iOS TokenWallet.apply)

/** Balances from a refresh's results (`[{ holdingId, address, result }]`, `result` from
 *  verifiedCoins) and the expected coins (kusdt-store `expectedCoins()`), at `now`:
 *  - expected coins are let go once Trestly lists them, or after 30 minutes;
 *  - one sent in the last 2 minutes that the node doesn't show yet still counts in the balance (not
 *    in what a send can spend), so the balance doesn't dip while the network catches up;
 *  - `isHeld(key)`: coins a send from here has just spent stay out (never counted again, never
 *    picked again; engine.getUtxosWithCovenants already leaves them out).
 *  Returns `{ holdings: [{ holdingId, address, units, coinCount, coins }], expected, followUpMs }`:
 *  `coins` are what a send from that address can spend, `expected` the list to keep, and
 *  `followUpMs` set when a refresh is due again shortly. */
export function applyResults({ results, expected = [], now = Date.now(), isHeld = () => false }) {
  const listed = new Set();
  for (const r of results) for (const k of r.result?.listedByAPI ?? []) listed.add(k);
  const keyOf = (e) => outpointKey(e.transactionId, e.index);
  const kept = expected.filter((e) => !listed.has(keyOf(e)) && now - e.since <= EXPECTED_MAX_AGE_MS);
  const verified = new Set(results.flatMap((r) => (r.result?.coins ?? []).map(keyOf)));
  const landing = kept.filter((e) => !verified.has(keyOf(e)) && now - e.since < EXPECTED_LANDING_MS);
  const holdings = [];
  for (const r of results) {
    const live = (r.result?.coins ?? []).filter((c) => !isHeld(keyOf(c)));
    const extra = landing.filter((e) => e.address === r.address);
    if (!live.length && !extra.length) continue;
    const units = live.reduce((s, c) => s + c.state.amount, 0n) + extra.reduce((s, e) => s + e.state.amount, 0n);
    holdings.push({ holdingId: r.holdingId, address: r.address, units, coinCount: live.length + extra.length, coins: live });
  }
  return { holdings, expected: kept, followUpMs: landing.length ? FOLLOW_UP_MS : null };
}

// MARK: - Received (iOS TokenWallet.announceNewCoins)

/** Whether the transaction that made a coin was your own (iOS `isOwnTransfer`): it spent a coin of
 *  yours, or an input came from one of your addresses. `inputs`: `[{ hash, index, address }]` of
 *  its inputs' previous outpoints, or null when the REST API can't say: then `fallback`. */
export function isOwnTransfer(inputs, { known, ownAddresses, fallback }) {
  if (!Array.isArray(inputs) || !inputs.length) return fallback;
  for (const input of inputs) {
    if (input?.hash != null && input?.index != null && known.has(outpointKey(input.hash, input.index))) return true;
    if (input?.address && ownAddresses.has(String(input.address).toLowerCase())) return true;
  }
  return false;
}

/** A token coin doesn't land on your address (it sits at its own contract address), so the Kaspa
 *  watch never sees it arrive. Each refresh compares the coins it found with the ones known before
 *  (kusdt-store) and returns the new ones as received, recording them in the history. Never
 *  announced: the first look on this device (it only learns what's there), what Discover finds
 *  (the caller remembers those with `store.rememberSeen` instead), and coins from your own
 *  transfers (the transaction spent a coin of yours, paid from one of your addresses, or was made
 *  here). `current`: `[{ holdingId, coins }]` now; `previous`: the coins of the refresh before;
 *  `fetchTransactionInputs(txid)` -> `[{ hash, index, address }]` | null (REST, resolved previous
 *  outpoints); `ownAddresses`: every address of the account. Returns
 *  `{ received: [{ holdingId, units, transactionId, index }], firstLook }`. */
export async function findReceived({ store, current, previous = [], fetchTransactionInputs = async () => null, ownAddresses = [], now = Date.now(), holdForNotice = () => false }) {
  const keyOf = (c) => outpointKey(c.transactionId, c.index);
  const all = current.flatMap((h) => h.coins ?? []);
  const known = store.seenOutpoints();
  // Coins waiting for their chat notice stay "new", so a later refresh looks at them again
  // (K b0f0a4e6 TokenWallet.noticeWait): `holdForNotice(coin, holdingId)` says which.
  const held = new Set();
  const remember = () => store.rememberSeen(all.map(keyOf).filter((k) => !held.has(k)));
  if (known == null) { remember(); return { received: [], firstLook: true }; }
  const fresh = all.filter((c) => !known.has(keyOf(c)));
  if (!fresh.length) { remember(); return { received: [], firstLook: false }; }

  // a coin we knew that's gone now: something of ours was spent in this window
  const previousKeys = new Set(previous.map(keyOf));
  const currentKeys = new Set(all.map(keyOf));
  const ownCoinSpent = [...previousKeys].some((k) => !currentKeys.has(k));
  const own = new Set([...ownAddresses].map((a) => String(a).toLowerCase()));
  const madeHere = store.ownTxids();
  const freshKeys = new Set(fresh.map(keyOf));
  const checked = new Map();
  const received = [];
  try {
    for (const h of current) {
      for (const coin of h.coins ?? []) {
        if (!freshKeys.has(keyOf(coin))) continue;
        let mine = checked.get(coin.transactionId);
        if (mine === undefined) {
          if (madeHere.has(String(coin.transactionId).toLowerCase())) mine = true;
          else {
            let inputs = null;
            try { inputs = await fetchTransactionInputs(coin.transactionId); } catch { inputs = null; }
            mine = isOwnTransfer(inputs, { known, ownAddresses: own, fallback: ownCoinSpent });
          }
          checked.set(coin.transactionId, mine);
        }
        if (!mine && coin.state.amount > 0n) {
          let wait = false;
          try { wait = Boolean(holdForNotice(coin, h.holdingId)); } catch { wait = false; }
          if (wait) { held.add(keyOf(coin)); continue; }
          received.push({ holdingId: h.holdingId, units: coin.state.amount, transactionId: coin.transactionId, index: coin.index });
          store.record({
            id: `${String(coin.transactionId).toLowerCase()}:${h.holdingId}:received`, kind: "received",
            units: coin.state.amount, counterparty: "", date: now, holdingId: h.holdingId,
          });
        }
      }
    }
  } finally {
    remember();
  }
  return { received, firstLook: false };
}

/** The notification for what `findReceived` found (iOS `postReceived`): `{ title, body }` with
 *  `labels` the received-on addresses' names in order. */
export function receivedNotification(received, labels, formatAmount) {
  const total = received.reduce((s, r) => s + r.units, 0n);
  // Just "Received 1.00 kUSDT" (K b0f0a4e6): no "On your Chatting Address" line.
  return { title: `Received ${formatAmount(total)}`, body: "" };
}
