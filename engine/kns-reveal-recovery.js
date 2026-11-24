// KNS reveal recovery (K 518fdc8c KNSRevealRecovery.swift, audit 2026-11-24 #4).
//
// KNS (.kas) left the app on 2026-11-23 (.kachat only), but a KNS commit whose reveal failed
// before then still holds the user's coins at a script (P2SH) address that only the saved redeem
// script can spend. This is the part of the old KNS write path that finishes those reveals, which
// returns the coins: a registration's or profile edit's reveal pays the address it always would
// have, and a domain transfer's reveal pays its 2 KAS (less the fee) back to the sender's change
// address. It starts nothing new and does something only for an account that still has a saved
// record; once every record is settled it does nothing. Remove it a few releases after no record
// is left in the field.
//
// Three kinds of record are finished here:
// - reveals owed (`kachat-account-data-v1:<account>:kachat-kns-pending-reveals-v1`): a registration
//   or profile edit, filed before its commit went out (Build 276 on);
// - the one older pending commit (`kachat-kns-pending-commit-v1`) builds before 276 wrote; it is
//   filed as a reveal owed once this account's key is shown to own it;
// - domain transfers (`kachat-kns-pending-transfer-v1:<network>`), keyed by asset id, signed by the
//   chatting key or a spending address's key (`source`).
//
// The redeem script (byte-identical to iOS/Android):
//   <push 32-byte x-only pubkey> OP_CHECKSIG OP_FALSE OP_IF
//     <push "kns"> OP_0 <push payload JSON>
//   OP_ENDIF
// The commit output pays into Blake2b256(redeem script) as a P2SH ScriptPublicKey; the reveal
// spends it with <signature><redeem script> as its signature script.

import { NETWORK } from "./network.js";
import { NETWORK_ID } from "./utils.js";
import { checkedUtxoAnswer } from "./amounts.js";

const KNS_TITLE_BYTES = new TextEncoder().encode("kns");
const OP_CHECKSIG = 0xac;
const OP_FALSE = 0x00;
const OP_IF = 0x63;
const OP_0 = 0x00;
const OP_ENDIF = 0x68;

export const KNS_ECONOMICS = Object.freeze({
  revealPriorityFeeSompi: 2_000_000n, // 0.02 KAS, added on top of the computed mass fee
  dustThresholdSompi: 10_000n,
});

/** A commit never seen on chain is dropped after this, and only after KNS_REVEAL_EMPTY_CHECKS looks
 *  in a row found nothing (iOS 83806b3d): the record is the only copy of the script that frees the
 *  coins, so a busy network or a lagging node must not lose it. */
export const KNS_REVEAL_MISSING_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
/** Empty looks in a row before a record goes: a commit once seen and now gone was spent by its
 *  reveal (here or on another device), but one lagging node mustn't drop it. */
export const KNS_REVEAL_EMPTY_CHECKS = 2;
/** Commits made just now were left to the send that made them (kept for records filed by an old
 *  build in the minutes before this one loaded). */
const KNS_REVEAL_LEFT_TO_SENDER_MS = 10 * 60 * 1000;

// --- redeem script + reveal ----------------------------------------------------------------

/** A transfer's payload (field order is part of the inscribed bytes). */
export function buildTransferPayload(assetId, toAddress) {
  return JSON.stringify({ op: "transfer", p: "domain", id: assetId, to: toAddress });
}

/** The 32-byte x-only public key the redeem script embeds, as hex. */
export function xOnlyPublicKeyHexFromPrivateKey(privateKey) {
  return privateKey.toPublicKey().toXOnlyPublicKey().toString();
}

/** The KNS redeem script for a payload, keeping the ScriptBuilder (it encodes the reveal's
 *  signature script) and the commit's P2SH script and address. */
export function buildKnsRedeemScript(kaspa, xOnlyPubkeyHex, payloadJson) {
  const builder = new kaspa.ScriptBuilder();
  builder.addData(xOnlyPubkeyHex); // hex string -> the raw 32 pubkey bytes
  builder.addOp(OP_CHECKSIG);
  builder.addOp(OP_FALSE);
  builder.addOp(OP_IF);
  builder.addData(KNS_TITLE_BYTES);
  builder.addOp(OP_0);
  builder.addData(new TextEncoder().encode(payloadJson));
  builder.addOp(OP_ENDIF);
  const commitScriptPublicKey = builder.createPayToScriptHashScript();
  const commitAddress = kaspa.addressFromScriptPublicKey(commitScriptPublicKey, NETWORK_ID);
  if (!commitAddress) throw new Error("Failed to derive a commit address from the KNS redeem script.");
  return {
    builder,
    redeemScriptHex: builder.toString(),
    commitScriptPublicKey,
    commitAddressString: commitAddress.toString(),
  };
}

/** The payload JSON inside a KNS redeem script (hex), or null when it isn't one. Reads the layout
 *  above; the caller rebuilds the script from it and compares, so a misread can't be used. */
export function knsPayloadFromRedeemScript(redeemScriptHex) {
  const hex = String(redeemScriptHex || "").trim().toLowerCase();
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return null;
  const b = Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));
  if (b.length < 43 || b[0] !== 0x20 || b[33] !== OP_CHECKSIG || b[34] !== OP_FALSE || b[35] !== OP_IF) return null;
  if (b[36] !== 0x03 || b[37] !== 0x6b || b[38] !== 0x6e || b[39] !== 0x73 || b[40] !== OP_0) return null;
  let length;
  let start;
  const op = b[41];
  if (op >= 0x01 && op <= 0x4b) { length = op; start = 42; }
  else if (op === 0x4c) { length = b[42]; start = 43; }
  else if (op === 0x4d) { length = b[42] | (b[43] << 8); start = 44; }
  else return null;
  if (start + length + 1 !== b.length || b[start + length] !== OP_ENDIF) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(start, start + length));
  } catch {
    return null;
  }
}

// Sighash for a Kaspa input covers the previous outpoint, the SPENT output's script and amount and
// the tx-wide fields - not the redeem script - so createInputSignature works here as for a P2PK
// input once the input carries a `utxo` entry for the commit output. The output is the commit
// amount less the real fee (mass fee + priority fee).
const NATIVE_SUBNETWORK_ID_HEX = "00".repeat(20);
const SIGHASH_ALL = 0;

/** Builds, signs and submits the reveal that spends a commit output. `signer` ({ privateKey })
 *  must be the key whose x-only pubkey the redeem script embeds; it defaults to the chatting key. */
export async function buildAndSubmitKnsReveal({
  engine,
  commitTxId,
  commitOutputIndex = 0,
  commitAmountSompi,
  commitScriptPublicKey,
  builder,
  revealTargetAddress,
  revealAmountSompi,
  signer = null,
  revealPriorityFeeSompi = KNS_ECONOMICS.revealPriorityFeeSompi,
  log = () => {},
}) {
  const kaspa = engine?.kaspa;
  const privateKey = signer?.privateKey || engine?.privateKey;
  if (!kaspa || !privateKey) throw new Error("Load a wallet before revealing a KNS inscription.");

  const utxoEntry = {
    address: undefined,
    outpoint: { transactionId: commitTxId, index: commitOutputIndex },
    amount: commitAmountSompi,
    scriptPublicKey: commitScriptPublicKey,
    blockDaaScore: 0n,
    isCoinbase: false,
  };
  const revealTargetScriptPublicKey = kaspa.payToAddressScript(revealTargetAddress);
  // A Schnorr signature is always 64 bytes (+1 sighash-type byte), so a dummy one sizes the mass.
  const placeholderSigScript = builder.encodePayToScriptHashSignatureScript("00".repeat(65));

  const draftTx = new kaspa.Transaction({
    version: 0,
    inputs: [{
      previousOutpoint: { transactionId: commitTxId, index: commitOutputIndex },
      signatureScript: placeholderSigScript,
      sequence: 0n,
      sigOpCount: 1,
      utxo: utxoEntry,
    }],
    outputs: [{ value: revealAmountSompi, scriptPublicKey: revealTargetScriptPublicKey }],
    lockTime: 0n,
    subnetworkId: NATIVE_SUBNETWORK_ID_HEX,
    gas: 0n,
    payload: "",
  });

  log("Estimating KNS reveal transaction fee...");
  const massFee = kaspa.calculateTransactionFee(NETWORK_ID, draftTx, 1);
  if (massFee == null) throw new Error("Could not calculate the reveal transaction's network fee.");
  const totalFee = massFee + BigInt(revealPriorityFeeSompi ?? KNS_ECONOMICS.revealPriorityFeeSompi);
  const finalOutputValue = BigInt(commitAmountSompi) - totalFee;
  if (finalOutputValue < KNS_ECONOMICS.dustThresholdSompi) {
    throw new Error("Commit amount is too small to cover the reveal transaction's fee.");
  }
  draftTx.outputs = [{ value: finalOutputValue, scriptPublicKey: revealTargetScriptPublicKey }];

  log("Signing KNS reveal transaction...");
  const signatureHex = kaspa.createInputSignature(draftTx, 0, privateKey, SIGHASH_ALL);
  draftTx.inputs = [{
    previousOutpoint: { transactionId: commitTxId, index: commitOutputIndex },
    signatureScript: builder.encodePayToScriptHashSignatureScript(signatureHex),
    sequence: 0n,
    sigOpCount: 1,
    utxo: utxoEntry,
  }];
  draftTx.finalize();

  log("Broadcasting KNS reveal transaction...");
  const submit = (rpc) => rpc.submitTransaction({ transaction: draftTx, allowOrphan: false });
  // A node that hasn't seen the commit yet calls the reveal an orphan / unknown outpoint: a few
  // short waits cover that.
  let response = null;
  for (let attempt = 1; ; attempt++) {
    try {
      response = await engine.withRpc(submit, { retries: 1, label: "KNS reveal broadcast" });
      break;
    } catch (error) {
      const message = String(error?.message || error || "").toLowerCase();
      const commitNotSeen = message.includes("orphan") || (message.includes("outpoint") && !message.includes("already"));
      if (!commitNotSeen || attempt >= 3) throw error;
      log(`KNS reveal attempt ${attempt} did not find the commit yet (${error?.message || error}); retrying.`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  return { txid: response?.transactionId || draftTx.id, actualRevealAmountSompi: finalOutputValue, fee: totalFee };
}

/** A reveal refused because its input is already spent: only this key can spend the commit, so
 *  an earlier reveal of ours already went through. */
function isAlreadyRevealedError(error) {
  const m = String(error?.message || error || "").toLowerCase();
  return m.includes("already spent") || m.includes("already in the mempool") || m.includes("double spend") || m.includes("already accepted");
}

/** The unspent outputs at a commit address, or null when the node gave no answer. */
async function commitOutputsAt(engine, commitAddressString) {
  const lookup = async (rpc) => checkedUtxoAnswer(await rpc.getUtxosByAddresses([commitAddressString]));
  try {
    const found = await engine.withRpc(lookup, { retries: 1, label: "KNS commit lookup" });
    return Array.isArray(found?.entries) ? found.entries : [];
  } catch {
    return null;
  }
}

/** The bookkeeping for a look that found nothing at the commit address: "drop" (a commit seen and
 *  now gone twice in a row was spent; one never seen is dropped once 30 days old and missing twice
 *  in a row) or the record's new `emptyChecks`. */
function emptyLookOutcome(record) {
  const emptyChecks = (Number(record.emptyChecks) || 0) + 1;
  const old = Date.now() - Number(record.createdAt || 0) >= KNS_REVEAL_MISSING_LIFETIME_MS;
  if (emptyChecks >= KNS_REVEAL_EMPTY_CHECKS && (record.commitSeen === true || old)) return "drop";
  return emptyChecks;
}

const bigintToString = (_, v) => (typeof v === "bigint" ? v.toString() : v);

// --- reveals owed (registrations and profile edits) -----------------------------------------

const KNS_REVEALS_BASE_KEY = "kachat-kns-pending-reveals-v1";
const knsRevealsKey = (account) => `kachat-account-data-v1:${account}:${KNS_REVEALS_BASE_KEY}`;
/** The single pending commit builds before 276 kept (no account, no reveal-owed list). */
export const LEGACY_PENDING_COMMIT_KEY = "kachat-kns-pending-commit-v1";

function readKnsReveals(account) {
  try {
    const parsed = JSON.parse(globalThis.localStorage.getItem(knsRevealsKey(account)) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
function writeKnsReveals(account, list) {
  try {
    if (list.length) globalThis.localStorage.setItem(knsRevealsKey(account), JSON.stringify(list, bigintToString));
    else globalThis.localStorage.removeItem(knsRevealsKey(account));
  } catch { /* storage unavailable: the record stays as it was */ }
}
function dropKnsReveal(account, id) {
  writeKnsReveals(account, readKnsReveals(account).filter((record) => record.id !== id));
}
function updateKnsReveal(account, id, fields) {
  const list = readKnsReveals(account);
  const i = list.findIndex((record) => record.id === id);
  if (i < 0) return;
  list[i] = { ...list[i], ...fields };
  writeKnsReveals(account, list);
}
/** This account's reveals owed. */
export function pendingKnsReveals(account) { return readKnsReveals(account); }

/** Files the pre-276 pending commit as a reveal owed by this account, when this account's key
 *  rebuilds its redeem script byte for byte (it embeds the key and the payload); then the old
 *  record goes. Another account's record is left for that account. */
function adoptLegacyPendingCommit(engine) {
  let legacy = null;
  try { legacy = JSON.parse(globalThis.localStorage.getItem(LEGACY_PENDING_COMMIT_KEY) || "null"); } catch { legacy = null; }
  if (!legacy || typeof legacy !== "object") return false;
  const payloadJson = knsPayloadFromRedeemScript(legacy.redeemScriptHex);
  if (!payloadJson || legacy.commitAmountSompi == null || !legacy.revealTargetAddress) {
    try { globalThis.localStorage.removeItem(LEGACY_PENDING_COMMIT_KEY); } catch { /* fine */ }
    return false;
  }
  let rebuilt;
  try {
    rebuilt = buildKnsRedeemScript(engine.kaspa, xOnlyPublicKeyHexFromPrivateKey(engine.privateKey), payloadJson);
  } catch {
    return false;
  }
  if (rebuilt.redeemScriptHex.toLowerCase() !== String(legacy.redeemScriptHex).toLowerCase()) return false;
  const account = engine.address;
  const list = readKnsReveals(account).filter((record) => record.id !== rebuilt.commitAddressString);
  list.push({
    id: rebuilt.commitAddressString,
    kind: legacy.kind || "legacy",
    payloadJson,
    commitAddressString: rebuilt.commitAddressString,
    commitAmountSompi: String(legacy.commitAmountSompi),
    revealTargetAddress: legacy.revealTargetAddress,
    revealAmountSompi: String(legacy.revealAmountSompi ?? legacy.commitAmountSompi),
    createdAt: Number(legacy.createdAt) || Date.now(),
  });
  writeKnsReveals(account, list);
  if (readKnsReveals(account).some((record) => record.id === rebuilt.commitAddressString)) {
    try { globalThis.localStorage.removeItem(LEGACY_PENDING_COMMIT_KEY); } catch { /* fine */ }
  }
  return true;
}

const knsRevealsResuming = new Set();
/** Finishes this account's reveals left by an earlier run. Each unspent output at a filed commit
 *  address is revealed the way the original would have been. A record goes once its reveal landed,
 *  once its commit - seen on chain before - is found gone twice in a row, or once a commit never
 *  seen is 30 days old and found missing twice in a row (iOS 83806b3d commitSeen / emptyChecks). A
 *  look that got no answer changes nothing. Returns how many reveals went out. */
export async function resumePendingKnsReveals({ engine, log = () => {} }) {
  const account = engine?.address;
  if (!engine?.kaspa || !engine?.privateKey || !account || knsRevealsResuming.has(account)) return 0;
  adoptLegacyPendingCommit(engine);
  if (!readKnsReveals(account).length) return 0;
  knsRevealsResuming.add(account);
  let finished = 0;
  try {
    await engine.connect();
    for (const record of readKnsReveals(account)) {
      if (engine.address !== account) break;
      if (Date.now() - Number(record.createdAt || 0) < KNS_REVEAL_LEFT_TO_SENDER_MS) continue;
      const xOnly = xOnlyPublicKeyHexFromPrivateKey(engine.privateKey);
      const { builder, commitScriptPublicKey, commitAddressString } = buildKnsRedeemScript(engine.kaspa, xOnly, record.payloadJson);
      if (commitAddressString !== record.commitAddressString) { dropKnsReveal(account, record.id); continue; }
      const found = await commitOutputsAt(engine, commitAddressString);
      if (found === null) continue; // no answer: next time
      const wanted = BigInt(record.commitAmountSompi);
      const owed = found.filter((entry) => BigInt(entry?.amount ?? 0) === wanted);
      if (!owed.length) {
        const outcome = emptyLookOutcome(record);
        if (outcome === "drop") dropKnsReveal(account, record.id);
        else updateKnsReveal(account, record.id, { emptyChecks: outcome });
        continue;
      }
      if (record.commitSeen !== true || Number(record.emptyChecks) > 0) updateKnsReveal(account, record.id, { commitSeen: true, emptyChecks: 0 });
      let allIn = true;
      for (const entry of owed) {
        try {
          const reveal = await buildAndSubmitKnsReveal({
            engine, commitTxId: entry.outpoint.transactionId, commitOutputIndex: Number(entry.outpoint.index) || 0, commitAmountSompi: wanted,
            commitScriptPublicKey, builder, revealTargetAddress: record.revealTargetAddress, revealAmountSompi: BigInt(record.revealAmountSompi), log,
          });
          log(`KNS reveal finished: ${reveal.txid}`);
          finished += 1;
        } catch (error) {
          if (isAlreadyRevealedError(error)) continue;
          allIn = false;
          log(`KNS reveal still waiting: ${error?.message || error}`);
        }
      }
      if (allIn) dropKnsReveal(account, record.id);
    }
  } finally {
    knsRevealsResuming.delete(account);
  }
  return finished;
}

// --- domain transfers -------------------------------------------------------------------------
// A transfer was written down before its commit went out ({ [assetId]: record } per network), the
// commit txid added once it had. Everything needed to rebuild the redeem script is in the record:
// the payload from (assetId, recipient) and the key from `source` ({ kind: "identity" } or
// { kind: "spending", index }, plus the signer's `address`).
//
// The storage is pluggable (the browser extension uses chrome.storage.local):
// setKnsPendingStorage({ getItem, setItem, removeItem }), each may return a value or a Promise.

const PENDING_TRANSFER_KEY_PREFIX = "kachat-kns-pending-transfer-v1";

const localStorageAdapter = Object.freeze({
  getItem(key) {
    try { return globalThis.localStorage ? globalThis.localStorage.getItem(key) : null; } catch { return null; }
  },
  setItem(key, value) {
    if (!globalThis.localStorage) throw new Error("No storage is available.");
    globalThis.localStorage.setItem(key, value);
  },
  removeItem(key) {
    try { globalThis.localStorage?.removeItem(key); } catch { /* nothing to remove */ }
  },
});
let pendingStorage = localStorageAdapter;

/** Plugs in the storage pending-transfer records are kept in; null restores localStorage. */
export function setKnsPendingStorage(adapter) {
  if (adapter && (typeof adapter.getItem !== "function" || typeof adapter.setItem !== "function" || typeof adapter.removeItem !== "function")) {
    throw new Error("A KNS pending storage adapter needs getItem, setItem and removeItem.");
  }
  pendingStorage = adapter || localStorageAdapter;
}

/** The storage key holding the pending transfers of `network` ("mainnet" | "testnet"). */
export function pendingKnsTransferKey(network = NETWORK) {
  return `${PENDING_TRANSFER_KEY_PREFIX}:${network}`;
}

async function readPendingTransfers() {
  let raw = null;
  try { raw = await pendingStorage.getItem(pendingKnsTransferKey()); } catch { raw = null; }
  if (!raw) return {};
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writePendingTransfers(map) {
  const key = pendingKnsTransferKey();
  if (!Object.keys(map).length) { await pendingStorage.removeItem(key); return; }
  await pendingStorage.setItem(key, JSON.stringify(map, bigintToString));
}

async function patchPendingTransfer(assetId, patch) {
  const map = await readPendingTransfers();
  if (!map[assetId]) return null;
  map[assetId] = { ...map[assetId], ...patch, updatedAt: Date.now() };
  await writePendingTransfers(map);
  return map[assetId];
}

async function clearPendingKnsTransfer(assetId) {
  const map = await readPendingTransfers();
  const key = String(assetId || "").trim();
  if (!(key in map)) return;
  delete map[key];
  await writePendingTransfers(map);
}

/** Every unfinished transfer on this network; `sourceAddress` keeps those one address started. */
export async function listPendingKnsTransfers({ sourceAddress = null } = {}) {
  const records = Object.values(await readPendingTransfers()).filter((r) => r && r.kind === "transfer" && r.network === NETWORK);
  return sourceAddress ? records.filter((r) => r.source?.address === sourceAddress) : records;
}

/**
 * Finishes one unfinished transfer: rebuilds its redeem script from the signer's key and the
 * recorded payload, finds the commit output at the P2SH address (else the recorded commit txid,
 * which may still be in the mempool) and reveals it, which moves the domain as asked and pays the
 * 2 KAS less the fee back to the record's change address.
 * Returns "revealed" | "settled" (already revealed, or dropped as gone) | "waiting".
 */
export async function resumeKnsTransfer({ engine, record, signer, log = () => {} }) {
  const privateKey = signer?.privateKey;
  const sourceAddress = signer?.address;
  if (!engine?.kaspa || !privateKey || !sourceAddress || !record?.assetId) return "waiting";
  if (record.source?.address && record.source.address !== sourceAddress) return "waiting";
  const payloadJson = buildTransferPayload(record.assetId, record.recipient);
  const { builder, commitScriptPublicKey, commitAddressString } = buildKnsRedeemScript(engine.kaspa, xOnlyPublicKeyHexFromPrivateKey(privateKey), payloadJson);
  if (record.commitAddress && record.commitAddress !== commitAddressString) return "waiting";

  const found = await commitOutputsAt(engine, commitAddressString);
  if (found === null) return "waiting";
  const wantAmount = record.commitAmountSompi != null ? BigInt(record.commitAmountSompi) : null;
  const entry = found.find((e) => e?.outpoint?.transactionId === record.commitTxId)
    || found.find((e) => wantAmount != null && BigInt(e?.amount ?? 0) === wantAmount)
    || found[0]
    || null;

  let commitTxId;
  let commitOutputIndex;
  let commitAmountSompi;
  if (entry) {
    if (record.commitSeen !== true || Number(record.emptyChecks) > 0) await patchPendingTransfer(record.assetId, { commitSeen: true, emptyChecks: 0 }).catch(() => {});
    commitTxId = entry.outpoint.transactionId;
    commitOutputIndex = Number(entry.outpoint.index) || 0;
    commitAmountSompi = BigInt(entry.amount);
  } else {
    // Nothing unspent at the commit address: revealed already (seen before, gone now), still only
    // in the mempool (try the recorded txid), or never sent.
    const look = emptyLookOutcome(record);
    if (look === "drop") {
      await clearPendingKnsTransfer(record.assetId).catch(() => {});
      return "settled";
    }
    await patchPendingTransfer(record.assetId, { emptyChecks: look }).catch(() => {});
    if (!record.commitTxId || record.commitAmountSompi == null) return "waiting";
    commitTxId = record.commitTxId;
    commitOutputIndex = Number(record.commitOutputIndex) || 0;
    commitAmountSompi = BigInt(record.commitAmountSompi);
  }

  let outcome = "revealed";
  try {
    const reveal = await buildAndSubmitKnsReveal({
      engine,
      commitTxId,
      commitOutputIndex,
      commitAmountSompi,
      commitScriptPublicKey,
      builder,
      revealTargetAddress: record.revealTargetAddress || sourceAddress,
      revealAmountSompi: commitAmountSompi, // pre-fee placeholder; real value = commit - fee
      signer: { privateKey, address: sourceAddress },
      revealPriorityFeeSompi: record.revealPriorityFeeSompi != null ? BigInt(record.revealPriorityFeeSompi) : KNS_ECONOMICS.revealPriorityFeeSompi,
      log,
    });
    log(`KNS transfer reveal finished: ${reveal.txid}`);
  } catch (error) {
    if (!isAlreadyRevealedError(error)) {
      await patchPendingTransfer(record.assetId, { status: "reveal-failed", lastError: error?.message || String(error) }).catch(() => {});
      log(`KNS transfer reveal still waiting: ${error?.message || error}`);
      return "waiting";
    }
    outcome = "settled"; // our earlier reveal is in (only this key can spend the commit)
  }
  await clearPendingKnsTransfer(record.assetId).catch(() => {});
  return outcome;
}

const knsTransfersResuming = new Set();
/** Finishes every unfinished transfer this account can sign: `signerFor(record)` returns
 *  { privateKey, address } for a record the loaded account started, else null (another account's,
 *  or a spending key that can't be derived right now - left for later). Returns how many went out. */
export async function resumePendingKnsTransfers({ engine, signerFor, log = () => {} }) {
  const account = engine?.address;
  if (!engine?.kaspa || !account || typeof signerFor !== "function" || knsTransfersResuming.has(account)) return 0;
  const records = await listPendingKnsTransfers();
  if (!records.length) return 0;
  knsTransfersResuming.add(account);
  let finished = 0;
  try {
    for (const record of records) {
      if (engine.address !== account) break;
      if (Date.now() - Number(record.createdAt || 0) < KNS_REVEAL_LEFT_TO_SENDER_MS) continue;
      let signer = null;
      try { signer = signerFor(record); } catch { signer = null; }
      if (!signer) continue;
      await engine.connect();
      if (await resumeKnsTransfer({ engine, record, signer, log }) === "revealed") finished += 1;
    }
  } finally {
    knsTransfersResuming.delete(account);
  }
  return finished;
}
