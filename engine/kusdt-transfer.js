// A kUSDT send, as kusdt-open's wallet makes one (`wallet/extension/src/kusdt/tokens.ts`
// `buildTransfer`, `build.ts` `buildFunded` and `checkBuilt`), with Trestly's own builder doing the
// build and the signing (engine/kusdt-core.js).
//
// Port of KaPay iOS KaChatWallet/Services/Tokens/KusdtTransfer.swift (e188209, afab8bd, 17bda71,
// 3d126db), with the parts of TokenWallet.noteSent, TokenSendView / TokenCombineView (the 2-minute
// stale review, the build generation, Try Again) and WalletService (holds, "Not confirmed") a send
// needs:
//   1. kUSDT coins of the sending address, at most 3 (more needs Combine Coins first): never one a
//      send from here is still holding, a "Not confirmed" send's coin first (so the two conflict and
//      at most one can land), then largest first;
//   2. outputs: the recipient's coin, and the rest back to the sender as a change coin, each
//      carrying the token's 1.5 KAS;
//   3. plain KAS coins of the same address pay what the coins' own KAS doesn't, and the fee
//      (largest first, one more while the builder asks for more), so no other address is linked; a
//      send of everything with no KAS here pays its fee from the tokens' own KAS;
//   4. before anything is sent: every token output is exactly the approved state at its
//      recomputed script with its 1.5 KAS, every other output pays the sender back, the
//      transaction's outputs are the checked ones one by one, the covenant binds only the token
//      outputs, the inputs are exactly the picked coins and this address's KAS coins, each once,
//      the fee worked out here is under 3 KAS, and the transaction's id worked out here is the
//      builder's. Anything off and nothing is sent.
//
// Dependency-injected: `getUtxos(addresses)` (engine.getUtxosWithCovenants: wRPC, covenant ids, no
// REST fallback), `runCore` (engine/kusdt-core.js), `store` (engine/kusdt-store.js), the engine for
// the submit. Nothing here broadcasts except `submitPrepared`.

import { schnorr } from "@noble/curves/secp256k1.js";
import {
  kusdtDeployment, kusdtTemplate, schnorrOwner, isOnCurveXOnly, plainState, stateToJson, stateJsonMatches,
  lockingScript, spkHex, outpointKey, jsonU64,
} from "./kusdt.js";
import { runCore as defaultRunCore, KusdtCoreError } from "./kusdt-core.js";
import { hex, unhex, unhex32, bytesEqual, p2pkScript } from "./kachat-names/codec.js";
import { makeTx, makeTxInput, makeTxOutput, makeOutpoint, makeCovenantBinding, txIdHex } from "./kachat-names/transaction.js";
import { activityId } from "./kusdt-store.js";
import { excludeJustSpentUtxos, excludeReservedUtxos, SEND_OUTCOME_UNKNOWN } from "./transactions.js";

// MARK: - Constants (iOS KusdtTransfer)

/** The most a covenant transaction's fee may be (kusdt-open `MAX_FEE`): 3 KAS. */
export const MAX_FEE = 300_000_000n;
/** Change the builder couldn't keep, above which one more KAS coin is tried (`ABSORB_LIMIT`). */
export const ABSORB_LIMIT = 5_000_000n;
/** The relay minimum, sompi per gram of normalized mass (kusdt-open tx.rs `MIN_FEERATE`). */
export const FEERATE = 100n;
export const MAX_TOKEN_INPUTS = 3;
/** The fee room Fund This Address adds on top of what a send needs (fees run 0.02 to 0.05 KAS). */
export const FUNDING_FEE_MARGIN = 20_000_000n;
/** KAS coins are added until they cover what the send needs plus this (0.5 KAS). */
export const FUNDING_COVER_MARGIN = 50_000_000n;
/** A shortfall is at least 0.1 KAS, rounded up to 0.01 KAS. */
export const MIN_SHORTFALL = 10_000_000n;
export const SHORTFALL_STEP = 1_000_000n;
/** A whole send with no KAS here: its fee from the coins' own KAS, the least that does, under the
 *  builder's 0.2 KAS change floor (0.02, 0.05, 0.1, 0.19 KAS). */
export const TOKEN_KAS_FEES = Object.freeze([2_000_000n, 5_000_000n, 10_000_000n, 19_000_000n]);
/** A review open longer than this is built again before it can be sent (iOS 120 s). */
export const REVIEW_STALE_MS = 120_000;
/** After a send, the balances are looked up again once the node has it (iOS 4 s). */
export const REFRESH_AFTER_SEND_MS = 4_000;

/** iOS texts (KusdtTransfer.Failure, TokenSendView), "KaPay" read as "KaChat" and "phone" as
 *  "device". */
export const TRANSFER_MESSAGES = Object.freeze({
  recipient: "kUSDT can only go to a regular Kaspa address.",
  notEnoughToken: "This address doesn't hold that much kUSDT.",
  mergeFirst: "That amount is spread over more than 3 kUSDT coins on this address. Send a smaller amount for now.",
  notEnoughKasForChangeCoin: "This address needs a little KAS: the network fee, plus 1.5 KAS for your change coin (the kUSDT you keep). That 1.5 KAS stays yours.",
  notEnoughKas: "This address needs a little KAS for the network fee.",
  noKey: "This address's key isn't available on this device.",
  feeTooHigh: "The network fee is above K's safety limit. Nothing was sent.",
  checkFailed: "The built transaction didn't match what you approved, so nothing was sent.",
  templateMissing: "K's kUSDT template is missing, so kUSDT can't be checked.",
  nothingToCombine: "This address holds its kUSDT in one coin already.",
  reviewStale: "The review was open a while, so the transaction was built again. Nothing was sent: check it and swipe again.",
  cantBuild: "The transaction couldn't be built. Nothing was sent.",
  notConfirmed: "Not confirmed: the network didn't answer. It may still go through. Try Again resends the same transaction, so it can't be paid twice.",
});

/** iOS `KusdtTransfer.Failure`: `code` is the case name; notEnoughKas carries `short` (sompi to
 *  add, for Fund This Address) and `forChangeCoin` (part of it is the change coin's 1.5 KAS). */
export class KusdtTransferError extends Error {
  constructor(code, extra = {}) {
    const message = code === "notEnoughKas"
      ? (extra.forChangeCoin ? TRANSFER_MESSAGES.notEnoughKasForChangeCoin : TRANSFER_MESSAGES.notEnoughKas)
      : (TRANSFER_MESSAGES[code] ?? code);
    super(message);
    this.name = "KusdtTransferError";
    this.code = code;
    Object.assign(this, extra);
  }
}
const fail = (code, extra) => new KusdtTransferError(code, extra);

// MARK: - Coins

const coinKey = (c) => outpointKey(c.transactionId, c.index);
const utxoKey = (u) => outpointKey(u.outpoint.transactionId, u.outpoint.index);

/** A coin a send from this app is holding (engine/transactions.js just-spent holds, 10 minutes). */
export function isHeldByEngine(key) {
  const [transactionId, index] = String(key).split(":");
  return excludeJustSpentUtxos([{ outpoint: { transactionId, index: Number(index) } }]).length === 0;
}

/** Step 1 (iOS `prepare`): the coins to spend for `amount`, at most 3 - never a held one, a "Not
 *  confirmed" send's coin first, then largest first. Throws mergeFirst when the address holds
 *  enough but in more than 3 coins, notEnoughToken when it doesn't. */
export function pickTokenCoins({ coins, amount, isHeld = () => false, unconfirmed = new Set() }) {
  const want = BigInt(amount);
  const rank = (c) => (unconfirmed.has(coinKey(c)) ? 1 : 0);
  const sorted = (coins || [])
    .filter((c) => c.state.amount > 0n && !isHeld(coinKey(c)))
    .sort((a, b) => (rank(b) - rank(a)) || (b.state.amount > a.state.amount ? 1 : b.state.amount < a.state.amount ? -1 : 0));
  const picked = [];
  let sum = 0n;
  for (const coin of sorted) {
    if (!(sum < want && picked.length < MAX_TOKEN_INPUTS)) break;
    picked.push(coin);
    sum += coin.state.amount;
  }
  if (sum < want) {
    throw fail(sorted.reduce((s, c) => s + c.state.amount, 0n) >= want ? "mergeFirst" : "notEnoughToken");
  }
  // the conflict rule (iOS 3d126db, audit 2026-11-20): an unconfirmed send's coin is always spent
  // when the address still has one, so that send and this one can't both land
  if (sorted.some((c) => rank(c)) && !picked.some((c) => rank(c))) throw fail("checkFailed");
  return { picked, sum };
}

/** Combine Coins' coins (iOS `prepareCombine`): the largest up to 3, a "Not confirmed" send's coin
 *  first (a KaChat tightening: iOS takes the 3 largest and only orders within them, so an
 *  unconfirmed coin outside them wasn't spent). Fewer than 2: nothingToCombine. */
export function pickCombineCoins({ coins, isHeld = () => false, unconfirmed = new Set() }) {
  const rank = (c) => (unconfirmed.has(coinKey(c)) ? 1 : 0);
  const largest = (coins || [])
    .filter((c) => c.state.amount > 0n && !isHeld(coinKey(c)))
    .sort((a, b) => (rank(b) - rank(a)) || (b.state.amount > a.state.amount ? 1 : b.state.amount < a.state.amount ? -1 : 0))
    .slice(0, MAX_TOKEN_INPUTS);
  if (largest.length <= 1) throw fail("nothingToCombine");
  return largest;
}

/** Step 3's coins: plain KAS coins of the sending address only - no covenant, not a mining
 *  reward, a version-0 Schnorr P2PK script of this very key (iOS checks the script's shape; the key
 *  is checked here too) - not held by another send or reserved by a scheduled KaPost, a "Not
 *  confirmed" send's coin first (the largest such: iOS `conflictingOutpoint`), then largest first. */
export function fundingCoins(utxos, { owner, isHeld = () => false, unconfirmed = new Set(), excludeReserved = excludeReservedUtxos }) {
  const mine = hex(p2pkScript(owner));
  const plain = (utxos || []).filter((u) => u && u.covenantId == null && !u.isCoinbase
    && Number(u.scriptVersion ?? 0) === 0 && String(u.scriptPublicKey ?? "").toLowerCase() === mine);
  const unreserved = excludeReserved(plain).filter((u) => !isHeld(utxoKey(u)));
  let conflict = null;
  for (const u of unreserved) {
    if (unconfirmed.has(utxoKey(u)) && (conflict == null || BigInt(u.amount) > BigInt(conflict.amount))) conflict = u;
  }
  return [...unreserved].sort((a, b) => {
    if ((a === conflict) !== (b === conflict)) return a === conflict ? -1 : 1;
    const x = BigInt(a.amount); const y = BigInt(b.amount);
    return y > x ? 1 : y < x ? -1 : 0;
  });
}

/** What to add so the send can go (iOS `shortfall()`): what it needs plus a fee margin, less what's
 *  there; 0.1 KAS at least, rounded up to 0.01 KAS. Sompi. */
export function fundingShortfall(need, available) {
  const target = BigInt(need) + FUNDING_FEE_MARGIN;
  const short = target > BigInt(available) ? target - BigInt(available) : 0n;
  const base = short > MIN_SHORTFALL ? short : MIN_SHORTFALL;
  return (base + SHORTFALL_STEP - 1n) / SHORTFALL_STEP * SHORTFALL_STEP;
}

// MARK: - The builder's transaction

function u64Field(v, { missing = null } = {}) {
  if (v == null) {
    if (missing != null) return missing;
    throw fail("checkFailed");
  }
  const n = jsonU64(v);
  if (n == null) throw fail("checkFailed");
  return n;
}
function smallField(v, max, { missing = 0 } = {}) {
  if (v == null) return missing;
  const n = jsonU64(v);
  if (n == null || n > BigInt(max)) throw fail("checkFailed");
  return Number(n);
}
function hexField(v) {
  if (typeof v !== "string") throw fail("checkFailed");
  try { return unhex(v.toLowerCase()); } catch { throw fail("checkFailed"); }
}

/** The builder's transaction (the node's wRPC JSON form) as a version-1 core Tx
 *  (engine/kachat-names/transaction.js), with the storage mass filled in as KaChat's other
 *  version-1 transactions do (the id doesn't cover it; iOS `rpcTransaction`). Anything malformed
 *  throws checkFailed. */
export function builderTransactionToCoreTx(t, storageMass = 0n) {
  if (!t || typeof t !== "object" || !Array.isArray(t.inputs) || !Array.isArray(t.outputs)) throw fail("checkFailed");
  const version = smallField(t.version, 0xffff, { missing: -1 });
  if (version < 1) throw fail("checkFailed");
  const inputs = t.inputs.map((i) => {
    const op = i?.previousOutpoint;
    if (!op || typeof op.transactionId !== "string") throw fail("checkFailed");
    let txid;
    try { txid = unhex32(op.transactionId.toLowerCase()); } catch { throw fail("checkFailed"); }
    // version 1 counts no sig ops (compute budgets instead): anything else is not what was built
    if (smallField(i.sigOpCount, 0xff) !== 0) throw fail("checkFailed");
    return makeTxInput({
      outpoint: makeOutpoint(txid, smallField(op.index, 0xffffffff, { missing: -1 })),
      signatureScript: hexField(i.signatureScript),
      sequence: u64Field(i.sequence, { missing: 0n }),
      computeBudget: smallField(i.computeBudget, 0xffff),
    });
  });
  if (inputs.some((i) => i.outpoint.index < 0)) throw fail("checkFailed");
  const outputs = t.outputs.map((o) => {
    const spk = hexField(o?.scriptPublicKey);
    if (spk.length < 2) throw fail("checkFailed");
    let covenant = null;
    if (o.covenant != null) {
      if (typeof o.covenant !== "object") throw fail("checkFailed");
      const authorizingInput = smallField(o.covenant.authorizingInput, 0xffff);
      if (authorizingInput >= inputs.length) throw fail("checkFailed");
      let id;
      try { id = unhex32(String(o.covenant.covenantId ?? "").toLowerCase()); } catch { throw fail("checkFailed"); }
      covenant = makeCovenantBinding(authorizingInput, id);
    }
    return makeTxOutput({ value: u64Field(o.value), scriptVersion: (spk[0] << 8) | spk[1], script: spk.slice(2), covenant });
  });
  let subnetworkId;
  try { subnetworkId = unhex(String(t.subnetworkId ?? "0".repeat(40)).toLowerCase()); } catch { throw fail("checkFailed"); }
  if (subnetworkId.length !== 20) throw fail("checkFailed");
  return makeTx({
    version, inputs, outputs,
    lockTime: u64Field(t.lockTime, { missing: 0n }),
    subnetworkId,
    gas: u64Field(t.gas, { missing: 0n }),
    payload: t.payload == null ? new Uint8Array(0) : hexField(t.payload),
    storageMass: BigInt(storageMass),
  });
}

// MARK: - Step 4: what was built is what was approved

/** The post-build checks (iOS `prepare` step 4 and `rpcTransaction`), on the builder's answer:
 *  `outputs` the approved token outputs `[{ state, value }]`, `picked` the token coins,
 *  `funding` every KAS coin of this address handed to the builder (node UTXO objects), `senderOwner`
 *  the sending key. Returns `{ txid, fee, builderFee, kasBack, coreTx, inputKeys, storageMass }`, or
 *  throws checkFailed / feeTooHigh. */
export function checkBuilt({ built, outputs, picked, funding, senderOwner, template, deployment, log = () => {} }) {
  if (!built || typeof built !== "object") throw fail("checkFailed");
  const txid = typeof built.txid === "string" ? built.txid.toLowerCase() : "";
  const builderFee = jsonU64(built.fee);
  const transaction = built.transaction;
  if (!/^[0-9a-f]{64}$/.test(txid) || builderFee == null || !transaction || typeof transaction !== "object") throw fail("checkFailed");
  if (builderFee > MAX_FEE) throw fail("feeTooHigh");

  // every token output is exactly the approved state at its recomputed script with its value; every
  // other output pays the sender back (its KAS change)
  const builtOutputs = built.outputs;
  if (!Array.isArray(builtOutputs) || builtOutputs.length < outputs.length) throw fail("checkFailed");
  const mine = spkHex(p2pkScript(senderOwner));
  let kasBack = 0n;
  builtOutputs.forEach((output, index) => {
    const script = String(output?.scriptPublicKey ?? "").toLowerCase();
    const value = jsonU64(output?.value);
    if (value == null) throw fail("checkFailed");
    if (index < outputs.length) {
      const expected = outputs[index];
      if (!output.token || !stateJsonMatches(output.token, expected.state) || value !== BigInt(expected.value)
        || script !== spkHex(lockingScript(expected.state, template))) throw fail("checkFailed");
    } else if (script !== mine) {
      throw fail("checkFailed");
    } else {
      kasBack += value;
    }
  });

  // ...and what is submitted is what was checked: the transaction's own outputs, one by one (the
  // builder reports both; nothing else ties them; audit, 2026-11-20)
  const sentOutputs = transaction.outputs;
  if (!Array.isArray(sentOutputs) || sentOutputs.length !== builtOutputs.length) throw fail("checkFailed");
  sentOutputs.forEach((sent, i) => {
    const checked = builtOutputs[i];
    const a = jsonU64(sent?.value);
    if (a == null || a !== jsonU64(checked.value)
      || String(sent?.scriptPublicKey ?? "").toLowerCase() !== String(checked.scriptPublicKey ?? "").toLowerCase()) throw fail("checkFailed");
  });

  // it spends exactly the coins picked here plus KAS coins of this address, each once
  const sentInputs = transaction.inputs;
  if (!Array.isArray(sentInputs)) throw fail("checkFailed");
  const inputKeys = sentInputs.map((i) => {
    const op = i?.previousOutpoint;
    const index = jsonU64(op?.index);
    if (typeof op?.transactionId !== "string" || index == null) throw fail("checkFailed");
    return outpointKey(op.transactionId, index);
  });
  const sentSet = new Set(inputKeys);
  if (sentSet.size !== sentInputs.length) throw fail("checkFailed");
  for (const coin of picked) if (!sentSet.has(coinKey(coin))) throw fail("checkFailed");
  // every other input is one of this address's KAS coins handed to the builder, and the fee is
  // worked out here from what goes in and out, not taken from the builder's word (KaPost's
  // audit, 2026-11-20)
  const amountByOutpoint = new Map();
  for (const coin of picked) amountByOutpoint.set(coinKey(coin), BigInt(coin.kasSompi));
  for (const u of funding) amountByOutpoint.set(utxoKey(u), BigInt(u.amount));
  let totalIn = 0n;
  for (const key of sentSet) {
    if (!amountByOutpoint.has(key)) throw fail("checkFailed");
    totalIn += amountByOutpoint.get(key);
  }
  // the token coins carry kUSDT's covenant; everything else (KAS back to you) none
  let totalOut = 0n;
  sentOutputs.forEach((output, index) => {
    totalOut += jsonU64(output.value);
    const boundTo = output.covenant && typeof output.covenant === "object" && typeof output.covenant.covenantId === "string"
      ? output.covenant.covenantId.toLowerCase() : null;
    if (index < outputs.length ? boundTo !== deployment.covenantId : boundTo !== null) throw fail("checkFailed");
    if (index >= outputs.length && output.covenant != null) throw fail("checkFailed");
  });
  if (totalIn < totalOut || totalIn - totalOut > MAX_FEE) throw fail("feeTooHigh");
  const fee = totalIn - totalOut;
  if (fee !== builderFee) log(`[kUSDT] builder fee ${builderFee} differs from inputs less outputs ${fee}`);

  // the transaction as it will be submitted, and its id worked out here: it must be the builder's,
  // the id the node's answer is held to (a KaChat addition, as .kachat names' submit checks)
  const storageMass = jsonU64(built.mass?.storage) ?? 0n;
  const coreTx = builderTransactionToCoreTx(transaction, storageMass);
  if (txIdHex(coreTx) !== txid) throw fail("checkFailed");
  return { txid, fee, builderFee, kasBack, coreTx, inputKeys, storageMass };
}

// MARK: - Build

function keyBytes(secretKey) {
  if (secretKey instanceof Uint8Array) return Uint8Array.from(secretKey);
  try { return unhex32(String(secretKey ?? "").trim().toLowerCase()); } catch { return null; }
}

/** Builds, signs and checks a send (iOS `KusdtTransfer.prepare`). Nothing is sent. Arguments:
 *  `from` `{ address, holdingId, label }` (holdingId "chatting" or "s<index>", as iOS), `coins`
 *  that address's verified coins (kusdt-balances verifiedCoins), `recipient` an address, `amount`
 *  base units (BigInt), `secretKey` the From address's key (hex or bytes; for this build only),
 *  `getUtxos(addresses)` or `engine` (getUtxosWithCovenants), `store` (for the "Not confirmed"
 *  coins; or `unconfirmed`, a Set), `runCore`, `network`, `isHeld(key)`, `excludeReserved(utxos)`.
 *  Returns the Prepared review: `{ kind, txid, fee, kasToRecipient, kasBack, feeFromTokenKas,
 *  amount, recipient, from, spentCoins, inputKeys, outputCount, changeIndex, coreTx, transaction,
 *  preparedAt, network }`. Throws KusdtTransferError, or KusdtCoreError for the builder's own
 *  refusals (its words) and when it isn't available. */
export async function prepareTransfer({
  from, coins, recipient, amount, secretKey,
  engine = null, getUtxos = null, store = null, unconfirmed = null,
  runCore = defaultRunCore, network, template = kusdtTemplate(),
  isHeld = isHeldByEngine, excludeReserved = excludeReservedUtxos,
  now = () => Date.now(), log = () => {}, kind = null,
}) {
  if (!template) throw fail("templateMissing");
  const deployment = kusdtDeployment(network);
  const senderKey = schnorrOwner(from?.address, deployment.network);
  if (!senderKey) throw fail("noKey");
  const recipientKey = schnorrOwner(recipient, deployment.network);
  if (!recipientKey || !isOnCurveXOnly(recipientKey)) throw fail("recipient");
  const want = BigInt(amount);
  if (want <= 0n) throw fail("notEnoughToken");
  const unknown = unconfirmed ?? store?.unknownOutcomeKeys?.() ?? new Set();
  const readUtxos = getUtxos ?? ((list) => engine.getUtxosWithCovenants(list));

  // 1. the coins, at most 3
  const { picked, sum } = pickTokenCoins({ coins, amount: want, isHeld, unconfirmed: unknown });

  // 2. the outputs
  const outputs = [{ state: plainState(recipientKey, want), value: deployment.tokenValue }];
  if (sum > want) outputs.push({ state: plainState(senderKey, sum - want), value: deployment.tokenValue });
  const kasIn = picked.reduce((s, c) => s + BigInt(c.kasSompi), 0n);
  const kasOut = outputs.reduce((s, o) => s + o.value, 0n);
  const need = kasOut > kasIn ? kasOut - kasIn : 0n;
  // more coins in than out (Combine Coins, or a send of everything from several coins): the extra
  // KAS pays the fee and comes back to this address as plain KAS
  const excess = kasIn > kasOut ? kasIn - kasOut : 0n;

  // the key of the sending address, for this one build
  const sk = keyBytes(secretKey);
  if (!sk) throw fail("noKey");
  try {
    if (!bytesEqual(schnorr.getPublicKey(sk), senderKey)) throw fail("noKey");
  } catch (error) {
    sk.fill(0);
    throw error instanceof KusdtTransferError ? error : fail("noKey");
  }
  const secretHex = hex(sk);
  sk.fill(0);

  // 3. KAS of the same address: plain Schnorr coins, not held by another send, largest first
  const utxos = await readUtxos([from.address]);
  const funding = fundingCoins(utxos, { owner: senderKey, isHeld, unconfirmed: unknown, excludeReserved });

  const inputsJson = picked.map((coin) => ({
    utxo: {
      transactionId: coin.transactionId, index: coin.index, amount: BigInt(coin.kasSompi),
      scriptPublicKey: spkHex(lockingScript(coin.state, template)),
      blockDaaScore: BigInt(coin.blockDaaScore ?? 0), isCoinbase: false, covenantId: deployment.covenantId,
    },
    state: stateToJson(coin.state),
    secretKey: secretHex,
  }));
  // All of the address's kUSDT goes (no change coin): with no KAS here to pay the fee, it comes out
  // of the KAS that travels with the tokens (kusdt-open `feeFromTokenKas`).
  const wholeSend = outputs.length === 1;
  let feeFromTokenKas = false;

  let n = 0;
  let covered = 0n;
  while (n < funding.length && covered + excess < need + FUNDING_COVER_MARGIN) {
    covered += BigInt(funding[n].amount);
    n += 1;
  }
  const available = funding.reduce((s, u) => s + BigInt(u.amount), 0n);
  const shortfall = () => fundingShortfall(need, available);
  if (n === 0 && need > 0n) throw fail("notEnoughKas", { short: shortfall(), forChangeCoin: !wholeSend });

  let built = null;
  const tokenKasFees = [...TOKEN_KAS_FEES];
  if (wholeSend && funding.length === 0 && excess === 0n) {
    feeFromTokenKas = true;
    n = 0;
  }
  for (let round = 0; round < 16; round += 1) {
    if (feeFromTokenKas) {
      // the fee taken from the coins' own KAS, the least that does; under the builder's 0.2 KAS
      // change floor, so nothing comes back as change
      const take = tokenKasFees[0];
      if (take == null || !(kasIn > take)) throw fail("notEnoughKas", { short: shortfall(), forChangeCoin: false });
      tokenKasFees.shift();
      outputs[0].value = kasIn - take;
    }
    const request = {
      network: deployment.network, feerate: FEERATE, changeAddress: from.address,
      funding: funding.slice(0, n).map((u) => ({
        utxo: {
          transactionId: String(u.outpoint.transactionId).toLowerCase(), index: Number(u.outpoint.index), amount: BigInt(u.amount),
          scriptPublicKey: `0000${String(u.scriptPublicKey).toLowerCase()}`,
          blockDaaScore: BigInt(u.blockDaaScore ?? 0), isCoinbase: false,
        },
        secretKey: secretHex,
      })),
      inputs: inputsJson,
      outputs: outputs.map((o) => ({ state: stateToJson(o.state), value: o.value })),
      redeem: [],
    };
    try {
      const answer = await runCore("transfer", request);
      const fee = jsonU64(answer.fee) ?? (1n << 64n);
      const feeMass = jsonU64(answer.mass?.feeMass) ?? 0n;
      const absorbed = fee > feeMass * FEERATE ? fee - feeMass * FEERATE : 0n;
      if (!feeFromTokenKas && absorbed > ABSORB_LIMIT && n < funding.length) { n += 1; continue; }
      built = answer;
      break;
    } catch (error) {
      if (!(error instanceof KusdtCoreError) || error.code !== "refused") throw error;
      const why = error.message;
      // the builder wants more KAS, or its fee didn't settle at this change: one more coin
      if (why.includes("add funding") || why.includes("fee did not settle")) {
        if (feeFromTokenKas) continue;
        if (n < funding.length) { n += 1; continue; }
        // a whole send whose KAS here isn't enough either: the fee from the tokens' KAS
        if (wholeSend) { feeFromTokenKas = true; n = 0; continue; }
        throw fail("notEnoughKas", { short: shortfall(), forChangeCoin: true });
      }
      throw error;
    }
  }
  if (!built) throw fail("checkFailed");

  // 4. what was built is what was approved
  const checked = checkBuilt({ built, outputs, picked, funding, senderOwner: senderKey, template, deployment, log });
  const isCombine = String(recipient).trim().toLowerCase() === String(from.address).trim().toLowerCase();
  return {
    kind: kind ?? (isCombine ? "combine" : "send"),
    network: deployment.network,
    txid: checked.txid,
    /** The network fee (sompi), exactly: inputs less outputs. */
    fee: checked.fee,
    /** KAS that goes to the recipient with the kUSDT (the new coin's 1.5 KAS). */
    kasToRecipient: outputs[0].value,
    /** Plain KAS the transaction pays back to the sending address. For Combine Coins, the KAS the
     *  merged coins held beyond the one coin's 1.5 KAS, less the fee. */
    kasBack: checked.kasBack,
    /** All of the address's kUSDT went and it had no KAS: the fee came out of the KAS that travels
     *  with the tokens, so the recipient's coin holds a little under 1.5 KAS. */
    feeFromTokenKas,
    amount: want,
    recipient: String(recipient).trim().toLowerCase(),
    recipientLabel: null,
    from: { address: from.address, holdingId: from.holdingId ?? "chatting", label: from.label ?? "" },
    spentCoins: picked,
    inputKeys: checked.inputKeys,
    outputCount: checked.coreTx.outputs.length,
    /** The change coin's output index, if there is one (yours: never announced as received). */
    changeIndex: outputs.length > 1 ? 1 : null,
    coreTx: checked.coreTx,
    transaction: built.transaction,
    preparedAt: now(),
  };
}

/** Combine Coins (iOS `prepareCombine`): the address's largest coins (up to 3) become one, sent to
 *  itself. Every kUSDT coin holds 1.5 KAS, so each coin merged away gives 1.5 KAS back to the
 *  address as plain KAS (less the fee, which that KAS pays: no funding needed). Built and checked
 *  like any send; `kasBack` is what comes back. More than 3 coins take another round. Same
 *  arguments as prepareTransfer, without `recipient` and `amount`. */
export async function prepareCombine(args) {
  const deployment = kusdtDeployment(args.network);
  const unknown = args.unconfirmed ?? args.store?.unknownOutcomeKeys?.() ?? new Set();
  const largest = pickCombineCoins({ coins: args.coins, isHeld: args.isHeld ?? isHeldByEngine, unconfirmed: unknown });
  const amount = largest.reduce((s, c) => s + c.state.amount, 0n);
  return prepareTransfer({
    ...args, network: deployment.network, coins: largest, recipient: args.from.address, amount, unconfirmed: unknown, kind: "combine",
  });
}

// MARK: - The review

/** Whether a review has been open too long to send as is (iOS: 120 s). A "Not confirmed" send's
 *  Try Again is exempt: it resends the same transaction. */
export function isReviewStale(prepared, now = Date.now()) {
  return now - Number(prepared?.preparedAt ?? 0) > REVIEW_STALE_MS;
}

/** What the review says after a stale one was built again (iOS TokenSendView.send): the fee went
 *  up (the UI shows engine/transactions.js sendFeeChangedError(rebuilt.fee)), or "built again". */
export function staleReviewOutcome(old, rebuilt) {
  if (!rebuilt) return { code: "cantBuild", message: TRANSFER_MESSAGES.cantBuild };
  if (rebuilt.fee > old.fee) return { code: "feeChanged", feeSompi: rebuilt.fee };
  return { code: "reviewStale", message: TRANSFER_MESSAGES.reviewStale };
}

/** The review's build generation (iOS `prepareGeneration`): every build and leaving the review bumps
 *  it, so a build that finishes after the review changed (Back, a new amount) is dropped, never
 *  sent. `begin(key)` -> `{ isCurrent(keyNow) }`; `invalidate()` on Back. Keys compare as
 *  "from|recipient|amount". */
export function createPrepareGate() {
  let generation = 0;
  const keyText = (k) => (k == null ? "" : `${k.from ?? ""}|${String(k.recipient ?? "").toLowerCase()}|${k.amount ?? ""}`);
  return {
    begin(key) {
      generation += 1;
      const mine = generation;
      const text = keyText(key);
      return { generation: mine, isCurrent: (keyNow = key) => mine === generation && keyText(keyNow) === text };
    },
    invalidate() { generation += 1; },
    get generation() { return generation; },
  };
}

// MARK: - Send

/** Sends a prepared transfer (iOS `KusdtTransfer.send`, TokenSendView.send). The engine's submit
 *  holds every coin it spends and, if a node's answer is lost, looks the transaction up by its id
 *  before anything fails, so it never sends twice. A review older than 2 minutes isn't sent
 *  (reviewStale: build it again with prepareTransfer and show it; staleReviewOutcome says what to
 *  tell the person) - unless this is Try Again after "Not confirmed" (`retryingUnknown`), which
 *  resends the very same signed transaction. On SEND_OUTCOME_UNKNOWN the coins it spent are
 *  remembered (store.rememberUnknownOutcome), so the next send or combine from that address spends
 *  one of them too and at most one lands; the error is rethrown with `notConfirmedMessage`.
 *  `markOwnTransaction(txid)`: its KAS change comes back with no input from your addresses, so the
 *  UI's "Received KAS" watch must treat it as yours. `ownTokenAddress(address)` -> `{ id, address,
 *  label }` | null for noteSent. Returns `{ txid, ...noteSent }`. */
export async function submitPrepared(prepared, {
  engine, store, retryingUnknown = false, now = Date.now(), markOwnTransaction = null, ownTokenAddress = () => null,
  toSdkTransaction = null, log = () => {},
}) {
  if (!retryingUnknown && isReviewStale(prepared, now)) throw fail("reviewStale");
  const kaspa = engine?.kaspa;
  if (!kaspa || typeof engine.submitRpcTransaction !== "function") throw new Error("Load Rusty Kaspa WASM first.");
  // the id is worked out again from the very transaction that goes out
  if (txIdHex(prepared.coreTx) !== prepared.txid) throw fail("checkFailed");
  const toSdk = toSdkTransaction ?? (await import("./kachat-names/service.js")).rpcTransaction;
  const wasmTx = toSdk(kaspa, prepared.coreTx);
  let sdkId = "";
  try { sdkId = String(wasmTx?.id ?? "").toLowerCase(); } catch { sdkId = ""; }
  // the SDK's own v1 id must be the core's: anything else is a conversion bug, caught before the
  // transaction leaves the app
  if (sdkId && sdkId !== prepared.txid) throw fail("checkFailed");
  // its KAS change comes back with no input from your addresses: not a "Received KAS"
  try { markOwnTransaction?.(prepared.txid); } catch { /* the watch's own problem */ }
  let txid;
  try {
    txid = String(await engine.submitRpcTransaction(wasmTx, { expectedTxId: prepared.txid, spends: prepared.inputKeys }) ?? "").toLowerCase();
  } catch (error) {
    if (error?.code === SEND_OUTCOME_UNKNOWN) {
      // It may have landed. Its coins stay where they are (not dropped as if sent): the next send
      // from this address spends one of them too, so this one and any later one conflict and at
      // most one lands, even after Back (audit, 2026-11-20). Try Again resends this transaction.
      store?.rememberUnknownOutcome?.(prepared.inputKeys);
      try { error.notConfirmedMessage = TRANSFER_MESSAGES.notConfirmed; } catch { /* frozen */ }
    }
    throw error;
  }
  if (txid !== prepared.txid) {
    const error = new Error(`The node answered with ${txid || "no transaction"}, not ${prepared.txid}.`);
    error.code = "submitMismatch";
    throw error;
  }
  log(`[kUSDT] sent ${txid.slice(0, 12)}`);
  return { txid, ...noteSent(prepared, { store, ownTokenAddress, now }) };
}

/** A kUSDT send went out (iOS `TokenWallet.noteSent`): the coins it made that are yours (its
 *  change, or kUSDT sent to another of your addresses) are expected until Trestly lists them, the
 *  history gets its line (a combine, or a send and its arrival when it went to another of yours),
 *  and every output it made is marked seen (your own change is never announced as received).
 *  Returns `{ spentKeys, expected, refreshAfterMs, ownRecipient }`: the UI drops `spentKeys` from the
 *  coins it shows (adjustHoldingsAfterSend) and looks the balances up again after refreshAfterMs. */
export function noteSent(prepared, { store, ownTokenAddress = () => null, now = Date.now() }) {
  const spentKeys = prepared.spentCoins.map(coinKey);
  const spent = new Set(spentKeys);
  const txid = prepared.txid;
  // noted once: a resend of the same transaction ("already known") adds nothing twice
  const expected = (store?.expectedCoins?.() ?? [])
    .filter((e) => !spent.has(outpointKey(e.transactionId, e.index)) && String(e.transactionId).toLowerCase() !== txid);
  const spentUnits = prepared.spentCoins.reduce((s, c) => s + c.state.amount, 0n);
  const fromOwner = schnorrOwner(prepared.from.address, prepared.network);
  if (prepared.changeIndex != null && spentUnits > prepared.amount && fromOwner) {
    expected.push({
      holdingId: prepared.from.holdingId, address: prepared.from.address, transactionId: txid, index: prepared.changeIndex,
      state: plainState(fromOwner, spentUnits - prepared.amount), since: now,
    });
  }
  let ownRecipient = null;
  try { ownRecipient = ownTokenAddress(prepared.recipient) ?? null; } catch { ownRecipient = null; }
  const recipientOwner = ownRecipient ? schnorrOwner(ownRecipient.address, prepared.network) : null;
  if (ownRecipient && recipientOwner) {
    expected.push({
      holdingId: ownRecipient.id, address: ownRecipient.address, transactionId: txid, index: 0,
      state: plainState(recipientOwner, prepared.amount), since: now,
    });
  }
  if (store) {
    store.setExpectedCoins(expected);
    if (prepared.recipient.toLowerCase() === prepared.from.address.toLowerCase()) {
      store.record({
        id: activityId(txid, prepared.from.holdingId, "combined"), kind: "combined", units: prepared.amount,
        counterparty: String(prepared.spentCoins.length), date: now, holdingId: prepared.from.holdingId, fee: prepared.fee,
      });
    } else {
      const to = ownRecipient?.label || prepared.recipientLabel || prepared.recipient;
      store.record({
        id: activityId(txid, prepared.from.holdingId, "sent"), kind: "sent", units: prepared.amount,
        counterparty: to, date: now, holdingId: prepared.from.holdingId, fee: prepared.fee,
      });
      if (ownRecipient) {
        store.record({
          id: activityId(txid, ownRecipient.id, "received"), kind: "received", units: prepared.amount,
          counterparty: prepared.from.label ?? "", date: now, holdingId: ownRecipient.id,
        });
      }
    }
    store.markOutputsSeen(txid, prepared.outputCount);
  }
  return { spentKeys, expected, refreshAfterMs: REFRESH_AFTER_SEND_MS, ownRecipient };
}

/** The balances shown right after a send, before the refresh (iOS noteSent's `holdings` update):
 *  `holdings` `[{ holdingId, address, units, coinCount }]`. */
export function adjustHoldingsAfterSend(holdings, prepared, ownRecipient = null) {
  let list = holdings.map((h) => ({ ...h }));
  const from = list.find((h) => h.holdingId === prepared.from.holdingId);
  if (from) {
    from.units = from.units > prepared.amount ? from.units - prepared.amount : 0n;
    from.coinCount = Math.max(0, from.coinCount - prepared.spentCoins.length + (prepared.changeIndex == null ? 0 : 1));
  }
  if (ownRecipient) {
    const to = list.find((h) => h.holdingId === ownRecipient.id);
    if (to) {
      to.units += prepared.amount;
      to.coinCount += 1;
    } else {
      list.push({ holdingId: ownRecipient.id, address: ownRecipient.address, units: prepared.amount, coinCount: 1 });
    }
  }
  list = list.filter((h) => h.units > 0n || h.coinCount > 0);
  return list;
}
