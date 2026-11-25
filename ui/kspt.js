// KSPT ("Kaspa Signable Partial Transaction") — the compact binary transport format KasSigner's
// firmware scans/displays for air-gapped signing, plus the unsigned-transaction build/broadcast
// engine around it. Port of iOS's KsptCodec.swift + QrFrameChunker.swift + ColdStorageSendEngine
// .swift (themselves verified against KasSigner's own `bootloader/src/wallet/pskt.rs` and
// `kassee/src/kspt.rs`) — field order, widths, mass math, and selection policy must match those
// exactly, or the device rejects the QR or the network rejects the fee.
//
// KSPT wire layout (all multi-byte integers little-endian):
//   Header:  magic(4)="KSPT"  version(1)=0x01  flags(1) [bit0: signed, bit1: has redeem script]
//   Global:  txVersion(2)  numInputs(1)  numOutputs(1)  lockTime(8)  subnetworkId(20)  gas(8)
//            payloadLen(2)  payload(payloadLen)
//   Input:   prevTxId(32)  prevIndex(4)  amount(8)  sequence(8)  sigOpCount(1)
//            spkVersion(2)  spkLen(1)  spkScript(spkLen)
//            [if signed: sigLen(1)  signature(sigLen)  sighashType(1)]
//   Output:  value(8)  spkVersion(2)  spkLen(1)  spkScript(spkLen)
//
// That is version 0x01, what every KasSigner reads, and what every send from a regular address
// still goes as. KasSigner v1.1's canonical version 0x06 (K 961fc05a KsptCodec.encodeUnsignedV6,
// KasSigner crates/kassigner-protocol/src/kspt/mod.rs and writer.rs) carries its quantum-resistant
// (KCC-3) inputs, and is what a send from a Cold Storage quantum address goes as:
//   Header:  magic(4)="KSPT"  version(1)=0x06  flags(1)=0x00
//   Global:  as 0x01
//   Input:   prevTxId(32)  prevIndex(4)  amount(8)  sequence(8)  sigOpCount(1)
//            spkVersion(2)  spkLen(1 | 0xFF u16)  spkScript
//            sigCount(1)  sigCount x [pubkeyPos(1) sighashType(1) signature(64)]  (ascending pos)
//            redeemLen(u16)  redeem(redeemLen)
//   Output:  value(8)  spkVersion(2)  spkLen(1 | 0xFF u16)  spkScript
//   Records: 0x43 covenant(out u8, authInput u16, id 32)   0x44 / 0x45 hint(idx, cosigner, chain, addr u32)
//            0x46 KCC-3 input hint(idx, chain, addr u32)  0x47 / 0x48 account hint(idx, chain, addr u32)
//            0x49 coin covenant(in u8, id 32)
// A script length is one byte below 255, else 0xFF and a u16 of at least 255 (the short form is
// required). One hint of any kind per input and per output, one covenant per output and per coin.
// A KCC-3 (m/22') address is P2SH of `0x20 <32-byte x-only key> 0xAC`. K never knows that key: the
// request carries an empty redeem script and a 0x46 hint, and the unit writes the redeem into its
// reply. Checked byte for byte against KasSigner's spec/vectors/v110/sdk (tools/test-cold-storage-
// quantum.mjs).

import { sha256 } from "@noble/hashes/sha2.js";
import { getEndpoint } from "../engine/endpoints.js";
import { KIP22_SIGNATURE_SCRIPT_SIZE, isP2shScript, kip22SignatureScript, verifyKip22Spend } from "../engine/quantum.js";
import { isNetworkAddress, otherNetworkReason, isValidKaspaAddress as isWellFormedKaspaAddress, lowercasedKaspaAddress } from "../engine/network.js";
import { submitConfirmingAcceptance, transactionSpends, excludeCovenantUtxos, excludeJustSpentUtxos, SEND_OUTCOME_UNKNOWN } from "../engine/transactions.js";
import { maxFeerate, p2shScript } from "../engine/kachat-names/codec.js";

// Matches firmware MAX_INPUTS=32 as of KasSigner v1.0.5 (was 8; devices on older
// firmware reject >8-input — and pre-1.0.5, even >5-input — transactions).
export const KSPT_MAX_INPUTS = 32;
export const KSPT_MAX_OUTPUTS = 4;

const MAGIC = [0x4b, 0x53, 0x50, 0x54]; // "KSPT"
const KSPT_VERSION = 0x01;
const FLAG_SIGNED = 0x01;
const FLAG_REDEEM = 0x02;

// KSPT 0x06 (K 961fc05a KsptCodec): KasSigner v1.1's `Profile::ESP32S3` (profile.rs), which every
// board uses unchanged apart from frame counts, and firmware/kassigner-fw/src/limits.rs (MAX_INPUTS
// 32, MAX_OUTPUTS 8). Only for 0x06: a unit on v1.0.x reads 0x01 within the limits above.
export const KSPT_VERSION_V6 = 0x06;
export const KSPT_MAX_INPUTS_V6 = 32;
export const KSPT_MAX_OUTPUTS_V6 = 8;
const KSPT_MAX_SCRIPT_V6 = 512;
const KSPT_MAX_REDEEM_V6 = 1024;
const KSPT_MAX_PAYLOAD_V6 = 768;
const KSPT_MAX_SIGS_PER_INPUT_V6 = 5;
/** Total supply in sompi: a value, or a running total, above it is refused (KasSigner's
 *  `checked_add_value`, upstream's `check_transaction_output_value_ranges`). */
const KSPT_MAX_SOMPI = 29_000_000_000n * 100_000_000n;
/** The length of KCC-3's redeem script, `0x20 <P> 0xAC`. */
export const KCC3_REDEEM_LENGTH = 34;
const LEN_ESCAPE = 0xff;
const SIGNATURE_LENGTH = 64;
const REC_COVENANT = 0x43;
const REC_HINT_IN = 0x44;
const REC_HINT_OUT = 0x45;
const REC_KCC3_HINT_IN = 0x46;
const REC_ACCOUNT_HINT_IN = 0x47;
const REC_ACCOUNT_HINT_OUT = 0x48;
const REC_COIN_COVENANT = 0x49;

// Post-"Toccata" minimum relay fee rate (sompi per mass-gram) — KaspaFeePolicy on iOS.
export const MIN_RELAY_FEE_PER_GRAM = 100n;
// Standard Schnorr signature script size (0x41 push + 64-byte sig + 0x01 sighash).
const SCHNORR_SIG_SCRIPT_LEN = 66n;
// A KCC-3 (quantum-resistant) input's: the signature as above, then the 34-byte redeem
// `<P> OP_CHECKSIG` pushed (1 + 34) - the hot wallet's KIP-22 size (K 961fc05a kcc3SigScriptLen).
export const KCC3_SIG_SCRIPT_LEN = BigInt(KIP22_SIGNATURE_SCRIPT_SIZE);
// KIP-9 storage mass (iOS KasiaTransactionBuilder.storageMass / fitsStorageMass). Whether a
// change output can stand is decided by the transaction's storage mass, not a flat floor: the old
// 0.2 KAS CHANGE_DUST_THRESHOLD handed up to 0.2 KAS of change to the miners for change the
// network (and KasSigner, whose own dust rule is the same storage-mass test) would accept.
const STORAGE_MASS_PARAMETER = 1_000_000_000_000n; // C = 10^12
export const MAX_STANDARD_MASS = 100_000n;
// The most a send may fold into its fee when its change can't stand as an output. A change output
// is only ever too small for storage mass below about 0.1 KAS (its own term is C / change), so a
// larger remainder that doesn't fit means the recipient amount is what breaks the budget, and
// folding it would pay the whole change to the miners. Anything over this is refused.
export const MAX_FOLDED_CHANGE_SOMPI = 10_000_000n; // 0.1 KAS
export const SMALL_SEND_MASS_MESSAGE = "This amount can't be sent from these coins without giving most of the change away as a network fee. Try a slightly larger amount, or compound this address first.";
const NATIVE_SUBNETWORK_ID_HEX = "00".repeat(20);

// ---------------------------------------------------------------------------
// Hex / byte helpers
// ---------------------------------------------------------------------------

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex) {
  const clean = String(hex || "").trim();
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function pushU16LE(arr, value) {
  const v = Number(value) & 0xffff;
  arr.push(v & 0xff, (v >> 8) & 0xff);
}

function pushU32LE(arr, value) {
  const v = Number(value) >>> 0;
  for (let i = 0; i < 4; i++) arr.push((v >>> (8 * i)) & 0xff);
}

function pushU64LE(arr, value) {
  let v = BigInt(value);
  for (let i = 0; i < 8; i++) { arr.push(Number(v & 0xffn)); v >>= 8n; }
}

class ByteReader {
  constructor(bytes) { this.bytes = bytes; this.offset = 0; }
  get position() { return this.offset; }
  get remaining() { return this.bytes.length - this.offset; }
  skip(n) { this.offset += n; }
  /** 0x06's script length: one byte, or 0xFF then a u16 that must be at least 255. */
  readScriptLen() {
    const at = this.offset;
    const first = this.readU8();
    if (first !== LEN_ESCAPE) return first;
    const long = this.readU16LE();
    if (long < LEN_ESCAPE) throw new Error(`KSPT script length at byte ${at} isn't in its short form`);
    return long;
  }
  readBytes(n) {
    if (n < 0 || this.offset + n > this.bytes.length) throw new Error("KSPT payload is truncated");
    const slice = this.bytes.slice(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }
  readU8() { return this.readBytes(1)[0]; }
  readU16LE() { const b = this.readBytes(2); return b[0] | (b[1] << 8); }
  readU32LE() { const b = this.readBytes(4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; }
  readU64LE() {
    const b = this.readBytes(8);
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
    return v;
  }
}

// ---------------------------------------------------------------------------
// KSPT codec
// ---------------------------------------------------------------------------

export function looksLikeKspt(bytes) {
  return bytes.length >= 4 && MAGIC.every((m, i) => bytes[i] === m);
}

/** inputs: [{prevTxId, prevIndex, amountSompi, sequence, sigOpCount, spkVersion, spkScriptHex}]
 *  outputs: [{valueSompi, spkVersion, spkScriptHex}] — returns Uint8Array. */
export function encodeUnsignedKspt({ txVersion = 0, lockTime = 0n, subnetworkIdHex = NATIVE_SUBNETWORK_ID_HEX, gas = 0n, payloadHex = null, inputs, outputs }) {
  if (inputs.length < 1 || inputs.length > KSPT_MAX_INPUTS) throw new Error(`KSPT supports 1-${KSPT_MAX_INPUTS} inputs, got ${inputs.length}`);
  if (outputs.length < 1 || outputs.length > KSPT_MAX_OUTPUTS) throw new Error(`KSPT supports 1-${KSPT_MAX_OUTPUTS} outputs, got ${outputs.length}`);

  const out = [...MAGIC, KSPT_VERSION, 0x00]; // unsigned, no redeem script
  const payloadBytes = payloadHex ? (hexToBytes(payloadHex) || new Uint8Array(0)) : new Uint8Array(0);
  if (payloadBytes.length > 128) throw new Error(`KSPT payload must be <=128 bytes, got ${payloadBytes.length}`);

  pushU16LE(out, txVersion);
  out.push(inputs.length, outputs.length);
  pushU64LE(out, lockTime);
  const subnetworkBytes = hexToBytes(subnetworkIdHex);
  if (!subnetworkBytes || subnetworkBytes.length !== 20) throw new Error("subnetworkId must be 20 bytes");
  out.push(...subnetworkBytes);
  pushU64LE(out, gas);
  pushU16LE(out, payloadBytes.length);
  out.push(...payloadBytes);

  for (const input of inputs) {
    const txIdBytes = hexToBytes(input.prevTxId);
    if (!txIdBytes || txIdBytes.length !== 32) throw new Error("prevTxId must be 32 bytes");
    out.push(...txIdBytes);
    pushU32LE(out, input.prevIndex);
    pushU64LE(out, input.amountSompi);
    pushU64LE(out, input.sequence ?? 0n);
    out.push(Number(input.sigOpCount ?? 1) & 0xff);
    pushU16LE(out, input.spkVersion ?? 0);
    const spkBytes = hexToBytes(input.spkScriptHex) || new Uint8Array(0);
    if (spkBytes.length > 64) throw new Error(`scriptPublicKey must be <=64 bytes, got ${spkBytes.length}`);
    out.push(spkBytes.length, ...spkBytes);
  }

  for (const output of outputs) {
    pushU64LE(out, output.valueSompi);
    pushU16LE(out, output.spkVersion ?? 0);
    const spkBytes = hexToBytes(output.spkScriptHex) || new Uint8Array(0);
    if (spkBytes.length > 64) throw new Error(`scriptPublicKey must be <=64 bytes, got ${spkBytes.length}`);
    out.push(spkBytes.length, ...spkBytes);
  }

  return new Uint8Array(out);
}

/** Reads a 0x01 payload (unchanged) or a 0x06 one (K 961fc05a); any other version throws. Both
 *  answer the same shape: `version`, `signed`, the globals, `inputs` (each with `signatureHex` /
 *  `sighashType` of its key-position-0 signature, `signatures`, `redeemScriptHex` and `hint`),
 *  `outputs`, and `records` (0x06's, in the order read; empty on 0x01). */
export function decodeKspt(bytes) {
  if (!looksLikeKspt(bytes)) throw new Error("Not a KSPT payload (bad magic)");
  if (bytes.length < 5) throw new Error("KSPT payload is truncated");
  if (bytes[4] === KSPT_VERSION_V6) return decodeKsptV6(bytes);
  const reader = new ByteReader(bytes);
  reader.skip(4);

  const version = reader.readU8();
  if (version !== KSPT_VERSION) throw new Error(`Unsupported KSPT version ${version}`);
  const flags = reader.readU8();
  const signed = (flags & FLAG_SIGNED) !== 0;
  if (flags & FLAG_REDEEM) throw new Error("Multisig/redeem-script KSPT isn't supported");

  const txVersion = reader.readU16LE();
  const numInputs = reader.readU8();
  const numOutputs = reader.readU8();
  if (numInputs < 1 || numInputs > KSPT_MAX_INPUTS) throw new Error(`KSPT supports 1-${KSPT_MAX_INPUTS} inputs, got ${numInputs}`);
  if (numOutputs < 1 || numOutputs > KSPT_MAX_OUTPUTS) throw new Error(`KSPT supports 1-${KSPT_MAX_OUTPUTS} outputs, got ${numOutputs}`);
  const lockTime = reader.readU64LE();
  const subnetworkIdHex = bytesToHex(reader.readBytes(20));
  const gas = reader.readU64LE();
  const payloadLen = reader.readU16LE();
  if (payloadLen > 128) throw new Error(`KSPT payload must be <=128 bytes, got ${payloadLen}`);
  const payloadHex = bytesToHex(reader.readBytes(payloadLen));

  const inputs = [];
  for (let i = 0; i < numInputs; i++) {
    const prevTxId = bytesToHex(reader.readBytes(32));
    const prevIndex = reader.readU32LE();
    const amountSompi = reader.readU64LE();
    const sequence = reader.readU64LE();
    const sigOpCount = reader.readU8();
    const spkVersion = reader.readU16LE();
    const spkLen = reader.readU8();
    if (spkLen > 64) throw new Error(`scriptPublicKey must be <=64 bytes, got ${spkLen}`);
    const spkScriptHex = bytesToHex(reader.readBytes(spkLen));

    let signatureHex = null;
    let sighashType = null;
    if (signed) {
      const sigLen = reader.readU8();
      if (sigLen > 64) throw new Error(`signature must be <=64 bytes, got ${sigLen}`);
      if (sigLen > 0) {
        signatureHex = bytesToHex(reader.readBytes(sigLen));
        sighashType = reader.readU8();
      }
    }
    inputs.push({
      prevTxId, prevIndex, amountSompi, sequence, sigOpCount, spkVersion, spkScriptHex, signatureHex, sighashType,
      redeemScriptHex: null,
      signatures: signatureHex ? [{ pubkeyPos: 0, sighashType: sighashType ?? 0, signatureHex }] : [],
      hint: null,
    });
  }

  const outputs = [];
  for (let i = 0; i < numOutputs; i++) {
    const valueSompi = reader.readU64LE();
    const spkVersion = reader.readU16LE();
    const spkLen = reader.readU8();
    if (spkLen > 64) throw new Error(`scriptPublicKey must be <=64 bytes, got ${spkLen}`);
    const spkScriptHex = bytesToHex(reader.readBytes(spkLen));
    outputs.push({ valueSompi, spkVersion, spkScriptHex });
  }

  return { version: KSPT_VERSION, signed, txVersion, lockTime, subnetworkIdHex, gas, payloadHex, inputs, outputs, records: [] };
}

// --- KSPT 0x06 (K 961fc05a KsptCodec.encodeUnsignedV6 / decodeV6) -------------------------------

/** `0x20 <32-byte x-only key> 0xAC`: KCC-3's redeem script. */
export function isKcc3Redeem(script) {
  return script.length === KCC3_REDEEM_LENGTH && script[0] === 0x20 && script[KCC3_REDEEM_LENGTH - 1] === 0xac;
}

/** Schnorr P2PK (`0x20 <32> 0xAC`) or ECDSA P2PK (`0x21 <33> 0xAB`). */
function isPayToPubKeyBytes(script) {
  return (script.length === 34 && script[0] === 0x20 && script[33] === 0xac)
    || (script.length === 35 && script[0] === 0x21 && script[34] === 0xab);
}

/** `OP_BLAKE2B OP_DATA_32 <hash> OP_EQUAL`. */
function isPayToScriptHashBytes(script) {
  return script.length === 35 && script[0] === 0xaa && script[1] === 0x20 && script[34] === 0x87;
}

/** KasSigner's `is_hint_level`: chain 0 or 1, a non-hardened index. */
function isHintLevel(chain, index) {
  return (chain === 0 || chain === 1) && Number.isInteger(index) && index >= 0 && index < 0x80000000;
}

function addKsptValue(total, value) {
  const v = BigInt(value);
  if (v < 0n || v > KSPT_MAX_SOMPI) throw new Error("KSPT amounts exceed the total supply");
  const sum = total + v;
  if (sum > KSPT_MAX_SOMPI) throw new Error("KSPT amounts exceed the total supply");
  return sum;
}

/** spkVersion(2), the length in its canonical form (one byte below 255, else 0xFF and a u16),
 *  then the script. */
function pushScriptV6(out, version, script) {
  if (script.length > KSPT_MAX_SCRIPT_V6) throw new Error(`KSPT script is too large (${script.length} bytes)`);
  pushU16LE(out, version ?? 0);
  if (script.length < LEN_ESCAPE) out.push(script.length);
  else { out.push(LEN_ESCAPE); pushU16LE(out, script.length); }
  out.push(...script);
}

/**
 * Builds an unsigned 0x06 request, as KasSigner's `write_draft` does for the same transaction: every
 * input with no signatures and an empty redeem script, then the records, all 0x46 (KCC-3) hints in
 * input order, then all 0x47 (account) hints in input order.
 *
 * `inputHints` is empty (no hints) or one entry per input, each null or `{ kind: "kcc3" | "account",
 * chain, addrIndex }`. A "kcc3" input's lock must be P2SH (`aa20 <32> 87`); an "account" input's
 * lock must be P2PK. A hint's chain is 0 (receive) or 1 (change) and its index below 2^31, as
 * KasSigner's SDK refuses otherwise. Limits are v1.1's profile, and a value or the running total of
 * inputs or outputs above the total supply is refused, as the unit would.
 */
export function encodeUnsignedKsptV6({ txVersion = 0, lockTime = 0n, subnetworkIdHex = NATIVE_SUBNETWORK_ID_HEX, gas = 0n, payloadHex = null, inputs, inputHints = [], outputs }) {
  if (inputs.length < 1 || inputs.length > KSPT_MAX_INPUTS_V6) throw new Error(`KSPT supports 1-${KSPT_MAX_INPUTS} inputs (${KSPT_MAX_INPUTS_V6} on KasSigner v1.1), got ${inputs.length}`);
  if (outputs.length < 1 || outputs.length > KSPT_MAX_OUTPUTS_V6) throw new Error(`KSPT supports 1-${KSPT_MAX_OUTPUTS} outputs (${KSPT_MAX_OUTPUTS_V6} on KasSigner v1.1), got ${outputs.length}`);
  if (inputHints.length && inputHints.length !== inputs.length) throw new Error(`KSPT has ${inputs.length} inputs but ${inputHints.length} hints`);
  const hints = inputHints.length ? inputHints : inputs.map(() => null);

  let payloadBytes = new Uint8Array(0);
  if (payloadHex) {
    payloadBytes = hexToBytes(payloadHex);
    if (!payloadBytes) throw new Error("payload must be hex");
  }
  if (payloadBytes.length > KSPT_MAX_PAYLOAD_V6) throw new Error(`KSPT payload is too large (${payloadBytes.length} bytes)`);
  const subnetworkBytes = hexToBytes(subnetworkIdHex);
  if (!subnetworkBytes || subnetworkBytes.length !== 20) throw new Error("subnetworkId must be 20 bytes");

  const out = [...MAGIC, KSPT_VERSION_V6, 0x00]; // flags: reserved in 0x06
  pushU16LE(out, txVersion);
  out.push(inputs.length, outputs.length);
  pushU64LE(out, lockTime);
  out.push(...subnetworkBytes);
  pushU64LE(out, gas);
  pushU16LE(out, payloadBytes.length);
  out.push(...payloadBytes);

  let totalIn = 0n;
  inputs.forEach((input, i) => {
    const txIdBytes = hexToBytes(input.prevTxId);
    if (!txIdBytes || txIdBytes.length !== 32) throw new Error("prevTxId must be 32 bytes");
    const spkBytes = hexToBytes(input.spkScriptHex);
    if (!spkBytes) throw new Error("scriptPublicKey must be hex");
    totalIn = addKsptValue(totalIn, input.amountSompi);
    const hint = hints[i];
    if (hint) {
      const fits = hint.kind === "kcc3" ? isPayToScriptHashBytes(spkBytes)
        : hint.kind === "account" ? isPayToPubKeyBytes(spkBytes) : false;
      if (!fits || !isHintLevel(hint.chain, hint.addrIndex)) throw new Error(`KSPT input ${i}'s hint doesn't fit its address`);
    }
    out.push(...txIdBytes);
    pushU32LE(out, input.prevIndex);
    pushU64LE(out, input.amountSompi);
    pushU64LE(out, input.sequence ?? 0n);
    out.push(Number(input.sigOpCount ?? 1) & 0xff);
    pushScriptV6(out, input.spkVersion ?? 0, spkBytes);
    out.push(0x00);   // no signatures
    pushU16LE(out, 0); // no redeem script: the unit supplies KCC-3's
  });

  let totalOut = 0n;
  for (const output of outputs) {
    const spkBytes = hexToBytes(output.spkScriptHex);
    if (!spkBytes) throw new Error("scriptPublicKey must be hex");
    totalOut = addKsptValue(totalOut, output.valueSompi);
    pushU64LE(out, output.valueSompi);
    pushScriptV6(out, output.spkVersion ?? 0, spkBytes);
  }

  // The writer's fixed record order: covenants, coin covenants, 0x44, 0x46, 0x47, 0x45, 0x48. K
  // writes no covenants and no group or output hints, so 0x46s then 0x47s.
  for (const [kind, marker] of [["kcc3", REC_KCC3_HINT_IN], ["account", REC_ACCOUNT_HINT_IN]]) {
    hints.forEach((hint, i) => {
      if (hint?.kind !== kind) return;
      out.push(marker, i);
      pushU32LE(out, hint.chain);
      pushU32LE(out, hint.addrIndex);
    });
  }
  return new Uint8Array(out);
}

/**
 * Reads a canonical 0x06 payload as KasSigner's `parse` does (mod.rs), refusing what it refuses:
 * reserved flags, zero inputs or outputs, counts and lengths past the profile, a non-canonical script
 * length, amounts past the supply, a repeated or descending signature position, unknown records,
 * repeated records, records naming an index the payload lacks, a covenant naming an input it lacks,
 * and trailing bytes. Then, for safety, more than one signature (or one not at position 0) on a
 * single-key input (a P2PK lock, a KCC-3 redeem, or a 0x46 hint), a redeem script on an input whose
 * lock isn't P2SH, and a redeem on a KCC-3-hinted input that isn't `0x20 <32> 0xAC`. The redeem's
 * hash is NOT checked against the input's lock here: broadcastSigned does that.
 */
function decodeKsptV6(bytes) {
  const r = new ByteReader(bytes);
  r.skip(4); // magic
  r.readU8(); // 0x06
  const flags = r.readU8();
  if (flags !== 0) throw new Error(`KSPT 0x06 flags must be zero, got ${flags}`);

  const txVersion = r.readU16LE();
  const numInputs = r.readU8();
  const numOutputs = r.readU8();
  const lockTime = r.readU64LE();
  const subnetworkIdHex = bytesToHex(r.readBytes(20));
  const gas = r.readU64LE();
  const payloadLen = r.readU16LE();
  if (numInputs < 1 || numInputs > KSPT_MAX_INPUTS_V6) throw new Error(`KSPT supports 1-${KSPT_MAX_INPUTS_V6} inputs on KasSigner v1.1, got ${numInputs}`);
  if (numOutputs < 1 || numOutputs > KSPT_MAX_OUTPUTS_V6) throw new Error(`KSPT supports 1-${KSPT_MAX_OUTPUTS_V6} outputs on KasSigner v1.1, got ${numOutputs}`);
  if (payloadLen > KSPT_MAX_PAYLOAD_V6) throw new Error(`KSPT payload is too large (${payloadLen} bytes)`);
  const payloadHex = bytesToHex(r.readBytes(payloadLen));

  const raw = [];
  let totalIn = 0n;
  for (let i = 0; i < numInputs; i++) {
    const prevTxId = bytesToHex(r.readBytes(32));
    const prevIndex = r.readU32LE();
    const amountSompi = r.readU64LE();
    totalIn = addKsptValue(totalIn, amountSompi);
    const sequence = r.readU64LE();
    const sigOpCount = r.readU8();
    const spkVersion = r.readU16LE();
    const spkLen = r.readScriptLen();
    if (spkLen > KSPT_MAX_SCRIPT_V6) throw new Error(`KSPT script is too large (${spkLen} bytes)`);
    const spk = r.readBytes(spkLen);
    const sigCount = r.readU8();
    if (sigCount > KSPT_MAX_SIGS_PER_INPUT_V6) throw new Error(`KSPT input ${i} carries ${sigCount} signatures, more than ${KSPT_MAX_SIGS_PER_INPUT_V6}`);
    const signatures = [];
    for (let s = 0; s < sigCount; s++) {
      const pubkeyPos = r.readU8();
      const sighashType = r.readU8();
      const signatureHex = bytesToHex(r.readBytes(SIGNATURE_LENGTH));
      if (signatures.some((sig) => sig.pubkeyPos === pubkeyPos)) throw new Error(`KSPT input ${i} has two signatures at key position ${pubkeyPos}`);
      const last = signatures[signatures.length - 1];
      if (last && pubkeyPos < last.pubkeyPos) throw new Error(`KSPT input ${i}'s signature at position ${pubkeyPos} is out of order`);
      signatures.push({ pubkeyPos, sighashType, signatureHex });
    }
    const redeemLen = r.readU16LE();
    if (redeemLen > KSPT_MAX_REDEEM_V6) throw new Error(`KSPT redeem script must be <=${KSPT_MAX_REDEEM_V6} bytes, got ${redeemLen}`);
    const redeem = r.readBytes(redeemLen);
    raw.push({ prevTxId, prevIndex, amountSompi, sequence, sigOpCount, spkVersion, spk, signatures, redeem });
  }

  const outputs = [];
  let totalOut = 0n;
  for (let i = 0; i < numOutputs; i++) {
    const valueSompi = r.readU64LE();
    totalOut = addKsptValue(totalOut, valueSompi);
    const spkVersion = r.readU16LE();
    const spkLen = r.readScriptLen();
    if (spkLen > KSPT_MAX_SCRIPT_V6) throw new Error(`KSPT script is too large (${spkLen} bytes)`);
    outputs.push({ valueSompi, spkVersion, spkScriptHex: bytesToHex(r.readBytes(spkLen)) });
  }

  // Records, in any order; one hint of any kind per input and per output, one covenant per output
  // and per coin (mod.rs `validate_records`).
  const records = [];
  const hintedIn = new Set();
  const hintedOut = new Set();
  const bound = new Set();
  const coins = new Set();
  const hints = new Map();
  const hexByte = (m) => `0x${m.toString(16).padStart(2, "0")}`;
  while (r.remaining > 0) {
    const at = r.position;
    const marker = r.readU8();
    const outOfRange = (index) => new Error(`KSPT record ${hexByte(marker)} at byte ${at} names index ${index}, which doesn't exist`);
    const repeated = () => new Error(`KSPT repeats record ${hexByte(marker)} at byte ${at}`);
    if (marker === REC_COVENANT) {
      const outputIndex = r.readU8();
      const authorizingInput = r.readU16LE();
      const covenantIdHex = bytesToHex(r.readBytes(32));
      if (outputIndex >= numOutputs) throw outOfRange(outputIndex);
      if (authorizingInput >= numInputs) throw new Error(`KSPT binds output ${outputIndex} to input ${authorizingInput}, which doesn't exist`);
      if (bound.has(outputIndex)) throw repeated();
      bound.add(outputIndex);
      records.push({ type: "covenant", outputIndex, authorizingInput, covenantIdHex });
    } else if (marker === REC_HINT_IN || marker === REC_HINT_OUT) {
      const index = r.readU8();
      const cosigner = r.readU32LE();
      const chain = r.readU32LE();
      const addrIndex = r.readU32LE();
      const isIn = marker === REC_HINT_IN;
      if (index >= (isIn ? numInputs : numOutputs)) throw outOfRange(index);
      const set = isIn ? hintedIn : hintedOut;
      if (set.has(index)) throw repeated();
      set.add(index);
      records.push({ type: isIn ? "inputHint" : "outputHint", index, cosigner, chain, addrIndex });
    } else if (marker === REC_KCC3_HINT_IN || marker === REC_ACCOUNT_HINT_IN || marker === REC_ACCOUNT_HINT_OUT) {
      const index = r.readU8();
      const chain = r.readU32LE();
      const addrIndex = r.readU32LE();
      const isOut = marker === REC_ACCOUNT_HINT_OUT;
      if (index >= (isOut ? numOutputs : numInputs)) throw outOfRange(index);
      const set = isOut ? hintedOut : hintedIn;
      if (set.has(index)) throw repeated();
      set.add(index);
      if (marker === REC_KCC3_HINT_IN) {
        records.push({ type: "kcc3InputHint", index, chain, addrIndex });
        hints.set(index, { kind: "kcc3", chain, addrIndex });
      } else if (marker === REC_ACCOUNT_HINT_IN) {
        records.push({ type: "accountInputHint", index, chain, addrIndex });
        hints.set(index, { kind: "account", chain, addrIndex });
      } else {
        records.push({ type: "accountOutputHint", index, chain, addrIndex });
      }
    } else if (marker === REC_COIN_COVENANT) {
      const inputIndex = r.readU8();
      const covenantIdHex = bytesToHex(r.readBytes(32));
      if (inputIndex >= numInputs) throw outOfRange(inputIndex);
      if (coins.has(inputIndex)) throw repeated();
      coins.add(inputIndex);
      records.push({ type: "coinCovenant", inputIndex, covenantIdHex });
    } else {
      throw new Error(`KSPT has an unknown record ${hexByte(marker)} at byte ${at}`);
    }
  }

  const inputs = raw.map((input, i) => {
    const hint = hints.get(i) || null;
    if (input.redeem.length && !isPayToScriptHashBytes(input.spk)) throw new Error(`KSPT input ${i} carries a redeem script its lock doesn't take`);
    if (hint?.kind === "kcc3" && input.redeem.length && !isKcc3Redeem(input.redeem)) throw new Error(`KSPT input ${i} carries a redeem script its lock doesn't take`);
    const singleKey = isPayToPubKeyBytes(input.spk) || isKcc3Redeem(input.redeem) || hint?.kind === "kcc3";
    if (singleKey && (input.signatures.length > 1 || input.signatures.some((s) => s.pubkeyPos !== 0))) {
      throw new Error(`KSPT input ${i} has one key but more than one signature, or one at another position`);
    }
    const first = input.signatures.find((s) => s.pubkeyPos === 0) || null;
    return {
      prevTxId: input.prevTxId,
      prevIndex: input.prevIndex,
      amountSompi: input.amountSompi,
      sequence: input.sequence,
      sigOpCount: input.sigOpCount,
      spkVersion: input.spkVersion,
      spkScriptHex: bytesToHex(input.spk),
      signatureHex: first?.signatureHex ?? null,
      sighashType: first?.sighashType ?? null,
      redeemScriptHex: input.redeem.length ? bytesToHex(input.redeem) : null,
      signatures: input.signatures,
      hint,
    };
  });

  return {
    version: KSPT_VERSION_V6,
    // 0x06 has no signed flag: signed when any input carries a signature
    signed: inputs.some((input) => input.signatures.length > 0),
    txVersion, lockTime, subnetworkIdHex, gas, payloadHex, inputs, outputs, records,
  };
}

// ---------------------------------------------------------------------------
// Multi-frame (animated) QR chunking — QrFrameChunker port, symmetric with
// KasSigner's own raw-byte scheme (kassee/src/qr.rs):
//   <=134 bytes: no wrapper — the raw payload is a single QR frame.
//   otherwise: [frameNum(1)][totalFrames(1)][fragLen(1)][fragment], balanced across
//   frames, capped at 64 frames, zero-padded to a minimum of 20 bytes per frame.
// ---------------------------------------------------------------------------

const SINGLE_FRAME_MAX = 134;
const MAX_FRAME_DATA = 106;
const MAX_FRAMES = 64;
const MIN_FRAME_SIZE = 20;
const FRAME_HEADER_SIZE = 3;

export function chunkQrFrames(bytes) {
  if (bytes.length <= SINGLE_FRAME_MAX) return [bytes];

  const totalFrames = Math.ceil(bytes.length / MAX_FRAME_DATA);
  if (totalFrames > MAX_FRAMES) throw new Error(`Payload too large to chunk into QR frames (${bytes.length} bytes)`);
  const perFrame = Math.ceil(bytes.length / totalFrames);

  const frames = [];
  let offset = 0;
  for (let frameNum = 0; frameNum < totalFrames; frameNum++) {
    const end = Math.min(offset + perFrame, bytes.length);
    const fragment = bytes.slice(offset, end);
    if (fragment.length > 255) throw new Error("Chunk fragment overflowed a single byte length field");
    const frame = [frameNum, totalFrames, fragment.length, ...fragment];
    while (frame.length < MIN_FRAME_SIZE) frame.push(0);
    frames.push(new Uint8Array(frame));
    offset = end;
  }
  return frames;
}

/** KasSigner v1.1's frame layout (K 961fc05a QrFrameChunker.V11, KasSigner
 *  crates/kassigner-protocol/src/frame.rs): `[0x1B, format, index, total, tag]`, frame 0 three more
 *  digest bytes, then the fragment; the fragments in index order are the payload, and the first four
 *  bytes of its SHA-256 must be the digest frame 0 named. */
export const QR_V11 = Object.freeze({
  magic: 0x1b,
  formatKspt: 1,
  // every format value frame.rs defines (Kspt, Pskb, Kpub, Descriptor, Container, Opaque)
  knownFormats: Object.freeze([1, 2, 3, 4, 5, 0xff]),
  headerLen: 5,
  digestLen: 4,
  firstHeaderLen: 8,
  // A unit shows a few frames for a reply; this only bounds what a stray code can claim.
  maxFrames: 64,
});

export function isV11Frame(bytes) {
  return bytes.length >= QR_V11.headerLen && bytes[0] === QR_V11.magic && QR_V11.knownFormats.includes(bytes[1]);
}

/** The digest a v1.1 transmission names: the first four bytes of the payload's SHA-256. */
export function v11Digest(payload) {
  return sha256(payload).slice(0, QR_V11.digestLen);
}

/** frame.rs `write_split`: a payload as a unit shows it, split evenly with frame 0's three extra
 *  header bytes counted against its fragment. `perFrame` is the unit's bytes per frame past the
 *  5-byte header. K writes v1.0.7 frames; this is for the tests, to build a unit's reply. */
export function v11Frames(payload, { format = QR_V11.formatKspt, perFrame = 225 } = {}) {
  const extra = QR_V11.firstHeaderLen - QR_V11.headerLen;
  if (!payload.length || perFrame <= 0) return [];
  const total = Math.max(1, Math.ceil((payload.length + extra) / perFrame));
  const per = Math.ceil((payload.length + extra) / total);
  const digest = v11Digest(payload);
  const frames = [];
  for (let i = 0; i < total; i++) {
    const start = Math.max(0, i * per - extra);
    const end = Math.min(Math.max(0, (i + 1) * per - extra), payload.length);
    if (start >= end) break;
    frames.push(new Uint8Array([QR_V11.magic, format, i, total, ...(i === 0 ? digest : [digest[0]]), ...payload.slice(start, end)]));
  }
  return frames;
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Reassembles frames scanned in any order/with duplicates. `isComplete` identifies a payload
 *  that arrived as a single unwrapped frame (pass looksLikeKspt).
 *
 *  Two frame layouts are read, never mixed in one set (K 961fc05a QrFrameChunker.Accumulator):
 *  - v1.0.7's `[index, total, fragLen, fragment]` (what K writes, and what a KasSigner shows for a
 *    single-key 0x01 request's reply);
 *  - v1.1's (QR_V11), which the unit uses for every other reply, every 0x06 (quantum) one included,
 *    even when it fits one code. A complete v1.1 set must match the digest frame 0 named, so frames
 *    of two transmissions are never joined into a transaction nobody sent.
 *  A v1.0.7 frame can't be taken for a v1.1 one: index 0x1B needs a total of 28 or more, and no
 *  v1.1 format byte is in 28...64. `v11Format` is the v1.1 format to collect; frames of any other
 *  format are something else in view and are ignored. */
export class QrFrameAccumulator {
  constructor(isComplete, { v11Format = QR_V11.formatKspt } = {}) {
    this.isComplete = isComplete;
    this.v11Format = v11Format;
    this.layout = null; // "v107" | "v11" | null
    this.totalFrames = null;
    this.received = new Map();
    // v1.1 only: the stream's tag (the digest's first byte, in every frame), and the whole digest
    // once frame 0 has been seen.
    this.tag = null;
    this.digest = null;
  }

  addFrame(bytes) {
    if (this.isComplete(bytes)) return bytes;
    if (isV11Frame(bytes)) return this.addV11(bytes);
    return this.addV107(bytes);
  }

  addV107(bytes) {
    if (bytes.length < FRAME_HEADER_SIZE) return null;

    const frameNum = bytes[0];
    const total = bytes[1];
    const fragLen = bytes[2];
    if (total < 2 || total > MAX_FRAMES || frameNum >= total || fragLen === 0) return null;
    if (bytes.length < FRAME_HEADER_SIZE + fragLen) return null;

    // A v1.1 set in progress names its payload; a bare shape match here is more likely something
    // else in view than the unit switching layouts, so it doesn't wipe it.
    if (this.layout === "v11") return null;
    // A frame from a different scan (mismatched total) — reset rather than mixing
    // two different transactions' fragments together.
    if (this.totalFrames !== total) this.reset();
    this.layout = "v107";
    this.totalFrames = total;
    this.received.set(frameNum, bytes.slice(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + fragLen));
    return this.assembled();
  }

  addV11(bytes) {
    const format = bytes[1];
    const index = bytes[2];
    const total = bytes[3];
    // Another kind of payload (a kpub, a PSKB...) on screen: not ours, and not a reason to drop
    // what we hold.
    if (format !== this.v11Format) return null;
    if (total < 1 || index >= total || total > QR_V11.maxFrames) return null;
    const header = index === 0 ? QR_V11.firstHeaderLen : QR_V11.headerLen;
    if (bytes.length < header) return null;
    const frameTag = bytes[QR_V11.headerLen - 1];
    const frameDigest = index === 0 ? bytes.slice(QR_V11.headerLen - 1, header) : null;
    const fragment = bytes.slice(header);

    // Another transmission: the count or tag changed, or frame 0 names another digest (the unit
    // rebuilt its reply, or a second screen is in view). Start over with it.
    const held = this.received.get(index);
    if (this.layout !== "v11" || this.totalFrames !== total || this.tag !== frameTag) this.reset();
    else if (frameDigest && this.digest && !sameBytes(frameDigest, this.digest)) this.reset();
    else if (held && !sameBytes(held, fragment)) this.reset(); // a sender never changes a frame
    this.layout = "v11";
    this.totalFrames = total;
    this.tag = frameTag;
    if (frameDigest) this.digest = frameDigest;
    this.received.set(index, fragment);

    const payload = this.assembled();
    if (!payload) return null;
    // Complete: it must be the payload frame 0 named.
    if (!this.digest || !sameBytes(v11Digest(payload), this.digest)) {
      this.reset();
      return null;
    }
    return payload;
  }

  assembled() {
    if (this.totalFrames === null || this.received.size < this.totalFrames) return null;

    const pieces = [];
    let length = 0;
    for (let i = 0; i < this.totalFrames; i++) {
      const piece = this.received.get(i);
      if (!piece) return null;
      pieces.push(piece);
      length += piece.length;
    }
    const out = new Uint8Array(length);
    let offset = 0;
    for (const piece of pieces) { out.set(piece, offset); offset += piece.length; }
    return out;
  }

  get progress() {
    return this.totalFrames === null ? null : { received: this.received.size, total: this.totalFrames };
  }

  get receivedFrameIndices() { return new Set(this.received.keys()); }

  reset() {
    this.layout = null;
    this.totalFrames = null;
    this.received.clear();
    this.tag = null;
    this.digest = null;
  }
}

// ---------------------------------------------------------------------------
// Mass / fee (KaspaMass port) — verified reference: 1 input, two 34-byte
// outputs, no payload -> mass 2036.
// ---------------------------------------------------------------------------

// `sigScriptLen`: the signature-script size per input - 66 for a Schnorr input, 101 for a
// quantum-safe (KIP-22) one that pushes its redeem script too (iOS estimateFee(signatureScriptSize:),
// engine/quantum.js KIP22_SIGNATURE_SCRIPT_SIZE).
export function calculateMass(numInputs, outputScriptLens, payloadSize = 0, sigOpCountPerInput = 1, sigScriptLen = SCHNORR_SIG_SCRIPT_LEN) {
  const n = BigInt(numInputs);
  const totalSigScriptBytes = n * BigInt(sigScriptLen);

  let byteSize = 2n; // version (u16)
  byteSize += 8n; // input count
  byteSize += n * (36n + 8n + 8n) + totalSigScriptBytes; // outpoint + sigscript-len field + sequence, + sigscript bytes
  byteSize += 8n; // output count

  let scriptPubKeyMass = 0n;
  for (const scriptLen of outputScriptLens) {
    byteSize += 8n + 2n + 8n + BigInt(scriptLen); // value + scriptVersion + scriptLen + script
    scriptPubKeyMass += (2n + BigInt(scriptLen)) * 10n;
  }

  byteSize += 8n;  // lockTime
  byteSize += 20n; // subnetworkId
  byteSize += 8n;  // gas
  byteSize += 32n; // payload hash (fixed 32 bytes regardless of payload length)
  byteSize += 8n;  // payload length
  byteSize += BigInt(payloadSize);

  const sigOpMass = n * BigInt(sigOpCountPerInput) * 1000n;
  const computeMass = byteSize + scriptPubKeyMass + sigOpMass;

  // Post-"Toccata" RPC minimum-standard-fee policy: fee floor is
  // 100 sompi * max(computeMass, 2 * transactionByteSize).
  const doubled = byteSize * 2n;
  return computeMass > doubled ? computeMass : doubled;
}

/** KIP-9 storage mass of spending `inputAmounts` into `outputAmounts` (sompi, BigInt), as
 *  consensus computes it for one-script-per-UTXO transfers:
 *    relaxed (one output, or one input, or exactly two of each): max(0, H(outs) - H(ins))
 *    otherwise:                                                  max(0, H(outs) - |I| * C / mean(ins))
 *  where H(xs) = sum of C / x. Port of iOS KasiaTransactionBuilder.storageMass. */
export function storageMass(inputAmounts, outputAmounts) {
  const c = STORAGE_MASS_PARAMETER;
  const harmonic = (amounts) => amounts.reduce((sum, a) => sum + c / (BigInt(a) > 0n ? BigInt(a) : 1n), 0n);
  const harmonicOuts = harmonic(outputAmounts);
  const relaxed = outputAmounts.length === 1 || inputAmounts.length === 1
    || (outputAmounts.length === 2 && inputAmounts.length === 2);
  if (relaxed) {
    const harmonicIns = harmonic(inputAmounts);
    return harmonicOuts > harmonicIns ? harmonicOuts - harmonicIns : 0n;
  }
  const sumIns = inputAmounts.reduce((sum, a) => sum + BigInt(a), 0n);
  const count = BigInt(Math.max(inputAmounts.length, 1));
  const meanIns = sumIns / count > 0n ? sumIns / count : 1n;
  const arithmeticIns = BigInt(inputAmounts.length) * (c / meanIns);
  return harmonicOuts > arithmeticIns ? harmonicOuts - arithmeticIns : 0n;
}

/** Whether the transaction stays within the standard storage-mass budget. A zero-value output
 *  never fits, whatever the arithmetic says. Port of iOS fitsStorageMass. */
export function fitsStorageMass(inputAmounts, outputAmounts) {
  if (!outputAmounts.every((a) => BigInt(a) > 0n)) return false;
  return storageMass(inputAmounts, outputAmounts) <= MAX_STANDARD_MASS;
}

export function calculateFee(mass, rateSompiPerGram) {
  const rate = BigInt(rateSompiPerGram);
  return mass * (rate > MIN_RELAY_FEE_PER_GRAM ? rate : MIN_RELAY_FEE_PER_GRAM);
}

/** Reference mass (1 input, two standard 34-byte P2PK outputs) — converts a user-entered
 *  total fee into a sompi-per-gram rate in the send form's fee editor. */
export const REFERENCE_MASS_FOR_FEE_EDITOR = calculateMass(1, [34, 34], 0);

/** Live quoted fee rate (sompi per mass-gram): the network's "normal" bucket quote or the
 *  protocol minimum, whichever is higher. Falls back to the minimum on any failure. */
export async function fetchQuotedFeeRateSompiPerGram() {
  try {
    const base = String(getEndpoint("kaspaApi") || "https://api.kaspa.org").replace(/\/+$/, "");
    const response = await fetch(`${base}/info/fee-estimate`, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) return MIN_RELAY_FEE_PER_GRAM;
    const decoded = await response.json();
    const quoted = decoded?.normalBuckets?.[0]?.feerate;
    // One server answering NaN, infinity or 1e30 is ignored rather than paid (KaPay 953b255).
    if (!Number.isFinite(quoted) || quoted < 0 || quoted > maxFeerate) return MIN_RELAY_FEE_PER_GRAM;
    const rate = BigInt(Math.ceil(quoted));
    return rate > MIN_RELAY_FEE_PER_GRAM ? rate : MIN_RELAY_FEE_PER_GRAM;
  } catch {
    return MIN_RELAY_FEE_PER_GRAM;
  }
}

// ---------------------------------------------------------------------------
// UTXO plumbing
// ---------------------------------------------------------------------------

/** Normalizes a wasm/rpc UTXO entry into the plain shape the engine works with. */
function normalizeUtxo(entry) {
  const outpoint = entry.outpoint || entry.entry?.outpoint || {};
  const spk = entry.scriptPublicKey || entry.entry?.scriptPublicKey || {};
  return {
    transactionId: String(outpoint.transactionId || ""),
    index: Number(outpoint.index ?? 0),
    amountSompi: BigInt(entry.amount ?? entry.entry?.amount ?? 0),
    spkVersion: Number(spk.version ?? 0),
    spkScriptHex: String(spk.script ?? ""),
    isCoinbase: Boolean(entry.isCoinbase ?? entry.entry?.isCoinbase),
    blockDaaScore: entry.blockDaaScore ?? entry.entry?.blockDaaScore ?? 0n,
  };
}

export function utxoKey(utxo) {
  return `${utxo.transactionId}:${utxo.index}`;
}

/** Fresh spendable set at `address`. Deliberately no coinbase filtering — the node's UTXO-set
 *  query only returns mature, spendable outputs, matching iOS/Android exactly. */
export async function fetchSpendableUtxos(engine, address) {
  const balance = await engine.balanceForAddress(address);
  // never a coin a send just spent, nor one a covenant locks (KaPay 5848fb0)
  return excludeCovenantUtxos(excludeJustSpentUtxos(balance.entries || [])).map(normalizeUtxo);
}

/** A usable recipient: a valid address of the running network (IOS-003). */
export function isValidKaspaAddress(engine, address) {
  const clean = lowercasedKaspaAddress(address);
  // the plain check first: the SDK panics on a wrong-length payload (iOS 5.3 Bech32)
  if (!isNetworkAddress(clean) || !isWellFormedKaspaAddress(clean)) return false;
  try {
    engine.kaspa.payToAddressScript(clean);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Selection (KaspaUtxoSelector port) — always prices as if there will be a change
// output: if change ends up dust and gets dropped, the real required fee is only
// lower, so this never underpays the network.
// ---------------------------------------------------------------------------

// After a "Not confirmed" send (its answer was lost), the next automatic pick leads with the largest
// of its coins, so the new send and the unconfirmed one conflict and at most one lands (KaPay's
// rule, KaChat iOS 148a5331 ChatService.conflictingOutpoint in ColdStorageSendEngine). A coin-control
// pick is the person's own and is left as it is. Remembered as long as a send holds its coins.
const UNKNOWN_OUTCOME_MS = 10 * 60 * 1000;
const unknownOutcomeCoins = new Map(); // "txid:index" -> remembered until (ms)
export function markColdUnknownOutcome(keys, now = Date.now()) {
  for (const key of keys || []) unknownOutcomeCoins.set(String(key).toLowerCase(), now + UNKNOWN_OUTCOME_MS);
}
/** The coin an automatic pick leads with, or null: the largest of `spendable` a "Not confirmed"
 *  send used. */
export function conflictingOutpointKey(spendable, now = Date.now()) {
  for (const [key, until] of unknownOutcomeCoins) if (until <= now) unknownOutcomeCoins.delete(key);
  if (!unknownOutcomeCoins.size) return null;
  let best = null;
  for (const utxo of spendable || []) {
    if (!unknownOutcomeCoins.has(utxoKey(utxo).toLowerCase())) continue;
    if (!best || utxo.amountSompi > best.amountSompi) best = utxo;
  }
  return best ? utxoKey(best) : null;
}

function selectUtxos(utxos, amountSompi, feeRateSompiPerGram, recipientScriptLen, changeScriptLen, leadingKey = null, sigScriptLen = SCHNORR_SIG_SCRIPT_LEN) {
  const sorted = [...utxos].sort((a, b) => (a.amountSompi > b.amountSompi ? -1 : a.amountSompi < b.amountSompi ? 1 : 0));
  const leadAt = leadingKey ? sorted.findIndex((u) => utxoKey(u) === leadingKey) : -1;
  if (leadAt > 0) sorted.unshift(...sorted.splice(leadAt, 1));
  const selected = [];
  let totalSelected = 0n;
  let estimatedFee = 0n;
  const outputScriptLens = [recipientScriptLen, changeScriptLen];

  for (const utxo of sorted) {
    selected.push(utxo);
    totalSelected += utxo.amountSompi;
    const mass = calculateMass(selected.length, outputScriptLens, 0, 1, sigScriptLen);
    estimatedFee = calculateFee(mass, feeRateSompiPerGram);
    if (totalSelected >= amountSompi + estimatedFee) break;
  }

  let finalAmount = amountSompi;
  let requiredAmount = amountSompi + estimatedFee;

  if (totalSelected < requiredAmount) {
    // "Max Send" leeway: within 2000 sompi, trim the amount down rather than failing.
    if (totalSelected > estimatedFee && requiredAmount - totalSelected < 2000n) {
      finalAmount = totalSelected - estimatedFee;
    } else {
      return null;
    }
  }

  const changeSompi = totalSelected - finalAmount - estimatedFee;
  return { utxos: selected, feeSompi: estimatedFee, finalAmount, changeSompi };
}

function buildManualSelection(utxos, amountSompi, feeRateSompiPerGram, recipientScriptLen, changeScriptLen, sigScriptLen = SCHNORR_SIG_SCRIPT_LEN) {
  if (!utxos.length) return null;
  const totalSelected = utxos.reduce((sum, u) => sum + u.amountSompi, 0n);
  const mass = calculateMass(utxos.length, [recipientScriptLen, changeScriptLen], 0, 1, sigScriptLen);
  const estimatedFee = calculateFee(mass, feeRateSompiPerGram);

  let finalAmount = amountSompi;
  const requiredAmount = amountSompi + estimatedFee;
  if (totalSelected < requiredAmount) {
    if (totalSelected > estimatedFee && requiredAmount - totalSelected < 2000n) {
      finalAmount = totalSelected - estimatedFee;
    } else {
      return null;
    }
  }

  const changeSompi = totalSelected - finalAmount - estimatedFee;
  return { utxos, feeSompi: estimatedFee, finalAmount, changeSompi };
}

// ---------------------------------------------------------------------------
// Build / preview / max / compound
// ---------------------------------------------------------------------------

function scriptFor(engine, address) {
  const spk = engine.kaspa.payToAddressScript(String(address).trim());
  return { version: Number(spk.version ?? 0), scriptHex: String(spk.script) };
}

/** A pay-to-script-hash address: its script is `OP_BLAKE2B <32> OP_EQUAL` (K 961fc05a
 *  ColdStorageManager.isScriptHashAddress). Cold Storage's only P2SH addresses are KasSigner's
 *  quantum-resistant (KCC-3) ones. False for anything that doesn't read as an address. */
export function isScriptHashAddress(engine, address) {
  try { return isP2shScript(scriptFor(engine, address).scriptHex); } catch { return false; }
}

/** The signature-script length one input from a source of this script will carry, for pricing:
 *  101 for a KCC-3 (P2SH) source, 66 for a plain one (K 961fc05a signatureScriptLength). */
function sigScriptLenFor(sourceScriptHex) {
  return isP2shScript(sourceScriptHex) ? KCC3_SIG_SCRIPT_LEN : SCHNORR_SIG_SCRIPT_LEN;
}

// K 961fc05a ColdSendError wording. A quantum source's send has change and the account has no
// unused quantum address to take it: change back to the source would sit behind the key the spend
// reveals, which the hot wallet refuses too (IOS-104).
export const QUANTUM_CHANGE_NEEDS_FRESH_ADDRESS = "This send puts this address's key on chain, so its change can't come back here. Add an unused quantum-resistant address from KasSigner first (a change address, #0 to #4, is best), or send the whole balance.";
export const QUANTUM_COMPOUND_NEEDS_FRESH_ADDRESS = "Compounding puts this address's key on chain, so its coins move to an unused quantum-resistant address of this account. Add one from KasSigner first (a change address, #0 to #4, is best).";
export const QUANTUM_SCRIPT_MISMATCH = "KasSigner didn't return the key script for this quantum-resistant address, so it won't be broadcast. Check the unit runs KasSigner v1.1 or later and holds this address.";
export const UNEXPECTED_COVENANT = "The signed transaction adds covenant terms this send never asked for, so it won't be broadcast.";

const byAmountDescending = (a, b) => (a.amountSompi > b.amountSompi ? -1 : a.amountSompi < b.amountSompi ? 1 : 0);

/** The coins a quantum source's transaction takes (K 961fc05a quantumSourceCoins): all of them up
 *  to the input cap, the largest first, a coin a "Not confirmed" send spent leading. Any coin left
 *  at the address would sit behind the key this spend puts on chain. */
export function quantumSourceCoins(spendable, leadingKey = null) {
  const sorted = [...spendable].sort(byAmountDescending);
  const leadAt = leadingKey ? sorted.findIndex((u) => utxoKey(u) === leadingKey) : -1;
  if (leadAt > 0) sorted.unshift(...sorted.splice(leadAt, 1));
  return sorted.slice(0, KSPT_MAX_INPUTS);
}

/** Builds (but does not sign) a transfer. `manualUtxoKeys`, if given, fixes the exact input
 *  set (re-resolved against this call's own fresh fetch by outpoint, so a UTXO spent since
 *  the picker was shown can't silently get included). Returns the unsigned model used for
 *  KSPT encoding, verification, and broadcast.
 *
 *  A KasSigner quantum-resistant (KCC-3, P2SH) source (K 961fc05a): every coin it has goes (up to
 *  KSPT_MAX_INPUTS; `coinsLeftBehind` counts the rest), coin control has no say, each input is
 *  priced with its 101-byte signature script, and change goes to `changeAddress` - another quantum
 *  address of the account - never back onto the key this spend reveals. `quantumUnitIndex` /
 *  `quantumUnitChain` are the address's number on the unit, sent as the request's KCC-3 hint. */
export async function buildUnsignedTransaction({ engine, fromAddress, toAddress, amountSompi, feeRateOverride = null, manualUtxoKeys = null, previewed = false, changeAddress = null, quantumUnitIndex = null, quantumUnitChain = 0 }) {
  if (amountSompi <= 0n) throw new Error("Amount must be greater than zero");
  let recipientScript, changeScript, sourceScript;
  // The script ignores the prefix: the other network's address would pay this chain's script
  // for that key (IOS-003), so it is refused here as well as in the form.
  { const reason = otherNetworkReason(toAddress); if (reason) throw new Error(reason); }
  try { recipientScript = scriptFor(engine, toAddress); } catch { throw new Error("Invalid recipient address"); }
  try { sourceScript = scriptFor(engine, fromAddress); } catch { throw new Error("Invalid source address"); }
  const isQuantumSource = isP2shScript(sourceScript.scriptHex);
  if (changeAddress) {
    // Only a quantum source's change goes elsewhere, and only to another quantum address of this
    // network: anything else here is a caller's mistake, refused rather than paid to.
    const reason = otherNetworkReason(changeAddress);
    if (reason) throw new Error(reason);
    try { changeScript = scriptFor(engine, changeAddress); } catch { throw new Error("Invalid change address"); }
    if (!isQuantumSource || !isP2shScript(changeScript.scriptHex)) throw new Error("Invalid change address");
  } else {
    changeScript = sourceScript;
  }
  const sigScriptLen = sigScriptLenFor(sourceScript.scriptHex);

  const spendable = await fetchSpendableUtxos(engine, fromAddress);
  if (!spendable.length) throw new Error("No spendable UTXOs at this address");

  const feeRate = feeRateOverride ?? await fetchQuotedFeeRateSompiPerGram();

  let selection;
  let coinsLeftBehind = 0;
  const lead = conflictingOutpointKey(spendable);
  // `previewed`: the keys are the review's automatic preview, not a coin-control pick. A preview
  // without the coin to lead with (the earlier send ended after it was shown) is chosen again.
  const previewMissesLead = previewed && lead != null && !(manualUtxoKeys || []).includes(lead);
  const recipientLen = recipientScript.scriptHex.length / 2;
  const changeLen = changeScript.scriptHex.length / 2;
  if (isQuantumSource) {
    // A quantum source spends every coin it can: this spend puts its key on chain, and any coin
    // left at the address would sit behind that key. Only past one transaction's input cap do
    // coins stay, and the signing step says so.
    const all = quantumSourceCoins(spendable, lead);
    coinsLeftBehind = spendable.length - all.length;
    selection = buildManualSelection(all, amountSompi, feeRate, recipientLen, changeLen, sigScriptLen);
  } else if (manualUtxoKeys && manualUtxoKeys.length && !previewMissesLead) {
    const freshByKey = new Map(spendable.map((u) => [utxoKey(u), u]));
    const resolved = manualUtxoKeys.map((k) => freshByKey.get(k)).filter(Boolean);
    selection = buildManualSelection(resolved, amountSompi, feeRate, recipientLen, changeLen, sigScriptLen);
  } else {
    selection = selectUtxos(spendable, amountSompi, feeRate, recipientLen, changeLen, lead, sigScriptLen);
  }
  if (!selection) throw new Error("Insufficient funds to cover that amount plus the network fee");
  if (selection.utxos.length > KSPT_MAX_INPUTS) {
    throw new Error(`This send would need ${selection.utxos.length} UTXOs, but KasSigner only supports ${KSPT_MAX_INPUTS} inputs per transaction. Send a smaller amount or consolidate this address first.`);
  }

  const { outputs, changeSompi, feeSompi, foldedChangeSompi } = planSendOutputs(selection, recipientScript, changeScript);
  // Never change back onto the key this spend reveals (IOS-104, as the hot wallet).
  if (isQuantumSource && changeSompi > 0n && changeScript.scriptHex === sourceScript.scriptHex) {
    throw new Error(QUANTUM_CHANGE_NEEDS_FRESH_ADDRESS);
  }

  return {
    fromAddress,
    toAddress,
    txVersion: 0,
    lockTime: 0n,
    subnetworkIdHex: NATIVE_SUBNETWORK_ID_HEX,
    gas: 0n,
    payloadHex: null,
    inputs: selection.utxos.map((utxo) => ({
      prevTxId: utxo.transactionId,
      prevIndex: utxo.index,
      amountSompi: utxo.amountSompi,
      sequence: 0n,
      sigOpCount: 1,
      spkVersion: utxo.spkVersion,
      spkScriptHex: utxo.spkScriptHex,
    })),
    outputs,
    finalAmountSompi: selection.finalAmount,
    // what is actually paid: every input sompi no output carries (a folded remainder included)
    feeSompi,
    // the network fee the transaction needs on its own, and the change that couldn't stand as an
    // output and was added to it (0n when the change was kept)
    baseFeeSompi: selection.feeSompi,
    foldedChangeSompi,
    changeSompi,
    // A KCC-3 source: the request goes as KSPT 0x06 (unsignedToKsptBytes), and its reply must carry
    // the unit's redeem script for every input (broadcastSigned).
    isQuantumSource,
    quantumUnitIndex: isQuantumSource && Number.isInteger(quantumUnitIndex) ? quantumUnitIndex : null,
    quantumUnitChain: quantumUnitChain === 1 ? 1 : 0,
    // where the change went (null when there is none)
    changeAddress: changeSompi > 0n ? (changeAddress || fromAddress) : null,
    coinsLeftBehind,
  };
}

/** The outputs for a selection (iOS ColdStorageSendEngine, IOS-013 / DSK-021): the recipient,
 *  plus the change whenever the transaction's storage mass allows it. Change that can't stand is
 *  folded into the fee only up to MAX_FOLDED_CHANGE_SOMPI; a bigger one is refused. The fee
 *  reported is inputs - outputs, so what's shown is what's paid. */
export function planSendOutputs(selection, recipientScript, changeScript) {
  const outputs = [{ valueSompi: selection.finalAmount, spkVersion: recipientScript.version, spkScriptHex: recipientScript.scriptHex }];
  let changeSompi = 0n;
  if (selection.changeSompi > 0n) {
    const inputAmounts = selection.utxos.map((u) => u.amountSompi);
    if (fitsStorageMass(inputAmounts, [selection.finalAmount, selection.changeSompi])) {
      changeSompi = selection.changeSompi;
      outputs.push({ valueSompi: selection.changeSompi, spkVersion: changeScript.version, spkScriptHex: changeScript.scriptHex });
    } else if (selection.changeSompi > MAX_FOLDED_CHANGE_SOMPI) {
      throw new Error(SMALL_SEND_MASS_MESSAGE);
    }
  }
  const inputTotal = selection.utxos.reduce((sum, u) => sum + u.amountSompi, 0n);
  const outputTotal = outputs.reduce((sum, o) => sum + o.valueSompi, 0n);
  const feeSompi = inputTotal >= outputTotal ? inputTotal - outputTotal : selection.feeSompi;
  const foldedChangeSompi = feeSompi > selection.feeSompi ? feeSompi - selection.feeSompi : 0n;
  return { outputs, changeSompi, feeSompi, foldedChangeSompi };
}

/** Live preview of what automatic selection would pick — lets the form show an already-exact
 *  fee and pass this same set into the real build so the two can't diverge. Standard 34-byte
 *  script lengths, matching iOS (this only needs the input count to be right). */
export async function previewAutomaticSelection({ engine, fromAddress, amountSompi, feeRateSompiPerGram, toAddress = null }) {
  if (amountSompi <= 0n) return null;
  let spendable;
  try { spendable = await fetchSpendableUtxos(engine, fromAddress); } catch { return null; }
  if (!spendable.length) return null;
  // A quantum source spends all its coins (see the build), so that is what's priced (K 961fc05a),
  // with its 101-byte signature scripts and a P2SH change output.
  if (isScriptHashAddress(engine, fromAddress)) {
    let recipientLen = 34;
    try { if (toAddress) recipientLen = scriptFor(engine, toAddress).scriptHex.length / 2; } catch { /* the standard length */ }
    const all = quantumSourceCoins(spendable, conflictingOutpointKey(spendable));
    const selection = buildManualSelection(all, amountSompi, feeRateSompiPerGram, recipientLen, 35, KCC3_SIG_SCRIPT_LEN);
    if (!selection) return null;
    return { utxoKeys: selection.utxos.map(utxoKey), feeSompi: selection.feeSompi };
  }
  // the same lead the build takes, so the review shows the coins it will spend
  const selection = selectUtxos(spendable, amountSompi, feeRateSompiPerGram, 34, 34, conflictingOutpointKey(spendable));
  if (!selection) return null;
  return { utxoKeys: selection.utxos.map(utxoKey), feeSompi: selection.feeSompi };
}

/** Max sendable (full balance minus estimated fee, no change) — prices with every spendable
 *  UTXO as the input count, or the fixed coin-control subset when one is set. A quantum source
 *  prices the coins its send takes - all of them, up to the input cap - each with its 101-byte
 *  signature script (K 961fc05a). */
export async function estimateMaxAmount({ engine, fromAddress, feeRateOverride = null, manualUtxoKeys = null, toAddress = null }) {
  const spendable = await fetchSpendableUtxos(engine, fromAddress);
  if (!spendable.length) throw new Error("No spendable UTXOs at this address");

  const quantum = isScriptHashAddress(engine, fromAddress);
  let utxosToUse = spendable;
  if (quantum) {
    // coin control has no say on a quantum source: the build takes these, whatever was picked
    utxosToUse = quantumSourceCoins(spendable, conflictingOutpointKey(spendable));
  } else if (manualUtxoKeys && manualUtxoKeys.length) {
    const freshByKey = new Map(spendable.map((u) => [utxoKey(u), u]));
    utxosToUse = manualUtxoKeys.map((k) => freshByKey.get(k)).filter(Boolean);
    if (!utxosToUse.length) return 0n;
  } else {
    // Only as much as ONE transaction can actually spend. Automatic selection takes UTXOs
    // largest-first and stops when the amount is covered, so the most a single send can move is
    // the largest KSPT_MAX_INPUTS of them. Summing all of them, which is what this used to do,
    // offered a Max that could not be built: the build needs every UTXO to reach it, hits the
    // input cap, and refuses - and the reader only finds that out after pressing Build. Compound
    // is the way to spend the rest, and it is a press away in the same menu.
    utxosToUse = [...spendable]
      .sort(byAmountDescending)
      .slice(0, KSPT_MAX_INPUTS);
  }

  const totalBalance = utxosToUse.reduce((sum, u) => sum + u.amountSompi, 0n);
  const feeRate = feeRateOverride ?? await fetchQuotedFeeRateSompiPerGram();
  let outputLens = [34, 34];
  if (quantum) {
    // the recipient's real script (a P2SH one is a byte longer), and a P2SH change
    let recipientLen = 34;
    try { if (toAddress) recipientLen = scriptFor(engine, toAddress).scriptHex.length / 2; } catch { /* the standard length */ }
    outputLens = [recipientLen, 35];
  }
  const mass = calculateMass(Math.max(utxosToUse.length, 1), outputLens, 0, 1, quantum ? KCC3_SIG_SCRIPT_LEN : SCHNORR_SIG_SCRIPT_LEN);
  const fee = calculateFee(mass, feeRate);
  return totalBalance > fee ? totalBalance - fee : 0n;
}

/** Compound: the largest up-to-KSPT_MAX_INPUTS spendable UTXOs (one KasSigner-signable
 *  transaction's worth), plus whether more remain for another round. */
export async function compoundInputs({ engine, fromAddress }) {
  const spendable = await fetchSpendableUtxos(engine, fromAddress);
  if (!spendable.length) throw new Error("No spendable UTXOs at this address");
  const sorted = [...spendable].sort(byAmountDescending);
  const capped = sorted.slice(0, KSPT_MAX_INPUTS);
  return { utxoKeys: capped.map(utxoKey), hasMore: sorted.length > KSPT_MAX_INPUTS };
}

/** KSPT-encodes an unsigned build for display as an (animated) QR sequence. A quantum (KCC-3)
 *  source goes as KSPT 0x06 - only KasSigner v1.1 and later read it - with a KCC-3 hint per input
 *  when the address's number is known and no redeem script: the unit supplies `<P> OP_CHECKSIG`
 *  when it signs. Everything else stays 0x01, which every KasSigner reads (K 961fc05a toKspt).
 *  "Sign Without the Address Number" encodes `{ ...unsigned, quantumUnitIndex: null }`. */
export function unsignedToKsptBytes(unsigned) {
  const fields = {
    txVersion: unsigned.txVersion,
    lockTime: unsigned.lockTime,
    subnetworkIdHex: unsigned.subnetworkIdHex,
    gas: unsigned.gas,
    payloadHex: unsigned.payloadHex,
    inputs: unsigned.inputs,
    outputs: unsigned.outputs,
  };
  if (unsigned.isQuantumSource) {
    const hint = Number.isInteger(unsigned.quantumUnitIndex)
      ? { kind: "kcc3", chain: unsigned.quantumUnitChain === 1 ? 1 : 0, addrIndex: unsigned.quantumUnitIndex }
      : null;
    return encodeUnsignedKsptV6({ ...fields, inputHints: unsigned.inputs.map(() => hint) });
  }
  return encodeUnsignedKspt(fields);
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

/** Merges a scanned signed-KSPT response's per-input Schnorr signatures back into the
 *  unsigned build and broadcasts. Verifies every input outpoint AND every output
 *  amount/script against what was actually sent for signing first — a compromised or
 *  malfunctioning device altering the destination or amount must fail loudly here.
 *
 *  A quantum (KCC-3) source's reply (K 961fc05a broadcastSigned) must carry, for every input, the
 *  unit's `<P> OP_CHECKSIG` whose hash is that input's P2SH lock, pushed after the signature; the
 *  whole spend is then checked offline (each signature against its sighash, engine/quantum.js
 *  verifyKip22Spend) before it goes out. A reply binding covenants is never what was asked for. */
export async function broadcastSigned({ engine, unsigned, decoded }) {
  if (!decoded.signed) throw new Error("Scanned transaction is not signed");
  // Nothing this app builds binds a covenant: a reply that does is not what was signed for.
  if ((decoded.records || []).some((record) => record.type === "covenant" || record.type === "coinCovenant")) {
    throw new Error(UNEXPECTED_COVENANT);
  }
  if (decoded.inputs.length !== unsigned.inputs.length) throw new Error("Signed transaction has a different number of inputs");
  if (decoded.outputs.length !== unsigned.outputs.length) throw new Error("Signed transaction has a different number of outputs");

  decoded.outputs.forEach((decodedOutput, index) => {
    const original = unsigned.outputs[index];
    if (decodedOutput.valueSompi !== original.valueSompi || decodedOutput.spkScriptHex !== original.spkScriptHex) {
      throw new Error(`Signed transaction's output ${index} doesn't match what was sent for signing, so it won't be broadcast`);
    }
  });

  let quantumRedeem = null;
  const signedInputs = unsigned.inputs.map((input, index) => {
    const decodedInput = decoded.inputs[index];
    if (decodedInput.prevTxId !== input.prevTxId || decodedInput.prevIndex !== input.prevIndex) {
      throw new Error(`Signed transaction's input ${index} doesn't match what was sent for signing`);
    }
    if (!decodedInput.signatureHex) throw new Error(`Input ${index} wasn't signed`);
    const sigBytes = hexToBytes(decodedInput.signatureHex);
    if (!sigBytes || sigBytes.length !== 64) throw new Error(`Unexpected signature length (${sigBytes?.length ?? 0} bytes, expected 64)`);

    // Only SIGHASH_ALL (IOS-019): a NONE / ANYONECANPAY signature doesn't commit to the outputs,
    // so anyone seeing it in the mempool could redirect the funds.
    const sighashType = decodedInput.sighashType ?? 0x01;
    if (sighashType !== 0x01) {
      throw new Error(`Input ${index} was signed with a signature type that doesn't cover the whole transaction, so it won't be broadcast`);
    }

    // Standard P2PK signature script: push-64 opcode + 64-byte Schnorr sig + 1-byte sighash.
    const sighash = sighashType.toString(16).padStart(2, "0");
    let sigScriptHex = `41${decodedInput.signatureHex}${sighash}`;

    // A quantum (KCC-3) input: then the redeem the unit supplied, `<P> OP_CHECKSIG`, pushed. It
    // must be exactly the script this input's address is the hash of - checked here, since a wrong
    // one would only fail at the node, and the codec doesn't hash.
    const redeem = decodedInput.redeemScriptHex ? hexToBytes(decodedInput.redeemScriptHex) : null;
    if (unsigned.isQuantumSource) {
      if (!redeem || !isKcc3Redeem(redeem) || bytesToHex(p2shScript(redeem)) !== String(input.spkScriptHex).toLowerCase()) {
        throw new Error(`${QUANTUM_SCRIPT_MISMATCH} (#${index})`);
      }
      if (quantumRedeem && bytesToHex(quantumRedeem) !== bytesToHex(redeem)) throw new Error(`${QUANTUM_SCRIPT_MISMATCH} (#${index})`);
      quantumRedeem = redeem;
      sigScriptHex = bytesToHex(kip22SignatureScript(hexToBytes(sigScriptHex), redeem));
    } else if (redeem) {
      // a plain single-key input never carries one
      throw new Error(`Signed transaction's input ${index} doesn't match what was sent for signing`);
    }

    return {
      previousOutpoint: { transactionId: input.prevTxId, index: input.prevIndex },
      signatureScript: sigScriptHex,
      sequence: input.sequence,
      sigOpCount: input.sigOpCount,
      utxo: {
        address: undefined,
        outpoint: { transactionId: input.prevTxId, index: input.prevIndex },
        amount: input.amountSompi,
        scriptPublicKey: new engine.kaspa.ScriptPublicKey(input.spkVersion, input.spkScriptHex),
        blockDaaScore: 0n,
        isCoinbase: false,
      },
    };
  });

  const tx = new engine.kaspa.Transaction({
    version: unsigned.txVersion,
    inputs: signedInputs,
    outputs: unsigned.outputs.map((output) => ({
      value: output.valueSompi,
      scriptPublicKey: new engine.kaspa.ScriptPublicKey(output.spkVersion, output.spkScriptHex),
    })),
    lockTime: unsigned.lockTime,
    subnetworkId: unsigned.subnetworkIdHex,
    gas: unsigned.gas,
    payload: unsigned.payloadHex || "",
  });
  tx.finalize();
  // Every quantum input's signature, checked offline against the sighash computed here, as the hot
  // wallet checks its own KIP-22 spends: a reply signed for anything else never goes out.
  if (unsigned.isQuantumSource) {
    try { verifyKip22Spend(tx, quantumRedeem); }
    catch { throw new Error("KasSigner's signature doesn't match this transaction, so it won't be broadcast."); }
  }

  await engine.connect();
  // A submit whose answer was lost but whose transaction the network has counts as sent
  // (iOS IOS-014): the person must not be told to sign and send it again.
  let localId = null;
  try { localId = tx.id ? String(tx.id) : null; } catch { localId = null; }
  const spends = transactionSpends(tx);
  const txid = await submitConfirmingAcceptance({
    withRpc: engine.withRpc.bind(engine),
    submit: (rpc, { allowOrphan = false } = {}) => rpc.submitTransaction({ transaction: tx, allowOrphan }),
    txid: localId,
    // Every submit holds its coins back, sent or with an unknown outcome (KaPay 1652437: Cold
    // Storage too), so no build here picks them again before a block shows them spent.
    spends,
    // a signed send never waits in a node's orphan pool (KaPay 5848fb0)
    escalateOrphan: false,
    label: "Cold storage broadcast",
    log: typeof engine.log === "function" ? engine.log : () => {},
  }).catch((error) => {
    // "Not confirmed": the next automatic pick leads with one of these coins.
    if (error?.code === SEND_OUTCOME_UNKNOWN) markColdUnknownOutcome(spends);
    throw error;
  });
  return txid || tx.id;
}
