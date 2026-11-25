// Cold Storage quantum-resistant (KCC-3) addresses for KasSigner v1.1 (K 961fc05a): KSPT 0x06
// requests and their replies, v1.1 reply frames, what a send from a quantum address spends, where
// its change goes and what comes back from the unit before anything is broadcast. Offline: the
// UTXOs are fake, the node is an in-memory recorder, nothing leaves the machine. Run from the repo
// root:
//
//   node tools/test-cold-storage-quantum.mjs
//
// The KasSigner vectors below are KasSigner v1.1's spec/vectors/v110/sdk (written by
// firmware/kassigner-fw/tests/sdk.rs from abandon 12, the public all-"abandon" test seed): K says
// its KsptCodec 0x06 is byte-identical to them for the sweep and single requests, and so is this
// port. When a KasSigner checkout sits next to this repo, the copies here are checked against it.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";

import {
  encodeUnsignedKspt, encodeUnsignedKsptV6, decodeKspt, unsignedToKsptBytes, buildUnsignedTransaction,
  broadcastSigned, estimateMaxAmount, previewAutomaticSelection, calculateMass, calculateFee, chunkQrFrames,
  QrFrameAccumulator, v11Frames, v11Digest, looksLikeKspt, isScriptHashAddress, bytesToHex, hexToBytes,
  KCC3_SIG_SCRIPT_LEN, QUANTUM_CHANGE_NEEDS_FRESH_ADDRESS, QUANTUM_SCRIPT_MISMATCH, UNEXPECTED_COVENANT,
} from "../ui/kspt.js";
import {
  COLD_QUANTUM_INDEX_BASE, normalizeQuantumRecords, unitMarksAsChange, quantumDefaultLabel, quantumAddressInput,
  parseUnitNumber, quantumIndexOf, afterQuantumRemoval, rankedChangeCandidates, pickFreshQuantumChange,
  ownChangeHistoryAmount,
} from "../ui/cold-quantum.js";
import { p2shScript, p2pkScript } from "../engine/kachat-names/codec.js";
import { quantumAddressForRedeem, QUANTUM_INDEX_BASE } from "../engine/quantum.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

const r = {
  pass: 0, fail: 0, failures: [],
  check(ok, label) { if (ok) this.pass++; else { this.fail++; this.failures.push(label); } },
  eq(a, b, label) { this.check(a === b, `${label}: got ${String(a)}, expected ${String(b)}`); },
  async throws(fn, pred, label) {
    try { await fn(); this.check(false, `${label}: did not throw`); } catch (e) { this.check(pred(e), `${label}: threw ${e?.message}`); }
  },
};

const kaspa = await import("../kaspa/kaspa.js");
await kaspa.default({ module_or_path: readFileSync(join(repo, "kaspa/kaspa_bg.wasm")) });

const KAS = 100_000_000n;
const RATE = 100n;
const NET = "mainnet";

// --- KasSigner v1.1 spec/vectors/v110/sdk ------------------------------------------------------
const VECTORS = {
  // A 22' sweep: two coins of abandon 12's KCC-3 receive 0 address (5 KAS and 0.5 KAS, outpoints
  // [4;32]:4 and [5;32]:5), the second hinted (0x46: chain 0, #0), to abandon 12's receive 0.
  "sweep.request": "4b53505406000000020100000000000000000000000000000000000000000000000000000000000000000000000000000404040404040404040404040404040404040404040404040404040404040404040000000065cd1d00000000000000000000000001000023aa201ea68b16641e8d5eff2c0b8a9ea963dd069630fadd859604da7ada91cfd29d428700000005050505050505050505050505050505050505050505050505050505050505050500000080f0fa0200000000000000000000000001000023aa201ea68b16641e8d5eff2c0b8a9ea963dd069630fadd859604da7ada91cfd29d4287000000100bc42000000000000022201bacea84ca721c95d67ecace19bc499a77c03726bc8739af637bcd89abaaf058ac46010000000000000000",
  // The unit's reply: each input signed, the redeem `<P> OP_CHECKSIG` written in.
  "sweep.reply.abandon12": "4b53505406000000020100000000000000000000000000000000000000000000000000000000000000000000000000000404040404040404040404040404040404040404040404040404040404040404040000000065cd1d00000000000000000000000001000023aa201ea68b16641e8d5eff2c0b8a9ea963dd069630fadd859604da7ada91cfd29d428701000186f00c3eb544a0f6cb4d6ef0963261f8bd095fc3c86ca67942e32f236df2021689f0f3ef905ae5aa4cbe4b3f41a067a6073b4a8d97214f6d4645c0e22cb9f4c5220020fa507ef4400da1016770879248322820e16cdea980b83261b5bb5d384f2e2b45ac05050505050505050505050505050505050505050505050505050505050505050500000080f0fa0200000000000000000000000001000023aa201ea68b16641e8d5eff2c0b8a9ea963dd069630fadd859604da7ada91cfd29d4287010001bda457f6a2f113b85aeb2b81c74f44dc23c920b676dd53a830a0d4d3eaaba9ae6390f61a6cdfa1ebd754b06a1bc7aecd0187cc64deef99a737c4f0d0d8497fbc220020fa507ef4400da1016770879248322820e16cdea980b83261b5bb5d384f2e2b45ac100bc42000000000000022201bacea84ca721c95d67ecace19bc499a77c03726bc8739af637bcd89abaaf058ac46010000000000000000",
  // A 44' spend: two coins, 4 KAS to zoo 12's receive 0, change to change 4; no hints.
  "single.request": "4b535054060000000202000000000000000000000000000000000000000000000000000000000000000000000000000001010101010101010101010101010101010101010101010101010101010101010100000000a3e11100000000000000000000000001000022201bacea84ca721c95d67ecace19bc499a77c03726bc8739af637bcd89abaaf058ac00000002020202020202020202020202020202020202020202020202020202020202020200000000c2eb0b00000000000000000000000001000022206259d1386d5e3c2c318dac760a179bb988eca841879d24791022ce805c725f8fac0000000084d71700000000000022204f2e4efeec55d8faaeb5fc41f70597fc68c135bfe81744ccfb2c126f8b5c5bc8ac3003ef0500000000000022200dfc8c6f84d339150652b66d1a5900bd086663875240ea714290c523bf346113ac",
  "single.reply.abandon12": "4b535054060000000202000000000000000000000000000000000000000000000000000000000000000000000000000001010101010101010101010101010101010101010101010101010101010101010100000000a3e11100000000000000000000000001000022201bacea84ca721c95d67ecace19bc499a77c03726bc8739af637bcd89abaaf058ac010001db42ec040a5e25f064b492b5a47ea0d22582c4e9a6b3ed2f58654c82dfecd2687edb4d7ec61995b0a68c71bf40406d55c9c80348930c3bde9bffd944eb271cd0000002020202020202020202020202020202020202020202020202020202020202020200000000c2eb0b00000000000000000000000001000022206259d1386d5e3c2c318dac760a179bb988eca841879d24791022ce805c725f8fac010001fd0875c6f4f2f9276ebb29f512f76da20b9b6da127c43756a91c3fe2fc5cf8fda2eb37c794465ce87746cad3e285aa653382f04d00ee67da99e95883305d401100000084d71700000000000022204f2e4efeec55d8faaeb5fc41f70597fc68c135bfe81744ccfb2c126f8b5c5bc8ac3003ef0500000000000022200dfc8c6f84d339150652b66d1a5900bd086663875240ea714290c523bf346113ac",
};
const vec = (name) => hexToBytes(VECTORS[name]);

// --- helpers ----------------------------------------------------------------------------------

let txCounter = 0;
const fakeTxid = () => (0xc01d000 + ++txCounter).toString(16).padStart(64, "0");

/** In-memory engine: UTXOs by address, and a recorder for submitted transactions. */
function fakeEngine(utxosByAddress) {
  const engine = {
    kaspa,
    submitted: [],
    async balanceForAddress(address) {
      const entries = (utxosByAddress[address] || []).map((amount, i) => ({
        outpoint: { transactionId: fakeTxid(), index: i % 4 },
        amount,
        scriptPublicKey: kaspa.payToAddressScript(address),
        blockDaaScore: 1000n,
        isCoinbase: false,
      }));
      // the same coins every time this engine is asked (a build reads them fresh)
      engine.entries = engine.entries || {};
      engine.entries[address] = engine.entries[address] || entries;
      return { entries: engine.entries[address] };
    },
    async connect() {},
    async withRpc(fn) {
      return fn({ async submitTransaction({ transaction }) { engine.submitted.push(transaction); return { transactionId: transaction.id }; } });
    },
  };
  return engine;
}

/** A KCC-3 address from a key, as a unit derives it: P2SH of `0x20 <x-only> 0xAC`. */
function quantumKey(seedByte) {
  const privHex = seedByte.repeat(32);
  const xOnly = schnorr.getPublicKey(hexToBytes(privHex));
  const redeem = p2pkScript(xOnly);
  return { privHex, redeem, address: quantumAddressForRedeem(redeem, "kaspa") };
}

function pushU16(out, v) { out.push(v & 0xff, (v >> 8) & 0xff); }
function pushU32(out, v) { for (let i = 0; i < 4; i++) out.push((v >>> (8 * i)) & 0xff); }
function pushU64(out, v) { let b = BigInt(v); for (let i = 0; i < 8; i++) { out.push(Number(b & 0xffn)); b >>= 8n; } }
function pushScript(out, version, hex) {
  const s = hexToBytes(hex);
  pushU16(out, version);
  if (s.length < 255) out.push(s.length); else { out.push(0xff); pushU16(out, s.length); }
  out.push(...s);
}

/** A unit's 0x06 reply, written here independently of the code under test: each input with
 *  `signatures[i]` (hex, or null) at key position 0, SIGHASH_ALL unless given, and `redeems[i]`. */
function writeReplyV6(request, { signatures, redeems = [], sighash = 0x01, records = [], extraSignature = false }) {
  const out = [0x4b, 0x53, 0x50, 0x54, 0x06, 0x00];
  pushU16(out, request.txVersion);
  out.push(request.inputs.length, request.outputs.length);
  pushU64(out, request.lockTime);
  out.push(...hexToBytes(request.subnetworkIdHex));
  pushU64(out, request.gas);
  pushU16(out, 0);
  request.inputs.forEach((input, i) => {
    out.push(...hexToBytes(input.prevTxId));
    pushU32(out, input.prevIndex);
    pushU64(out, input.amountSompi);
    pushU64(out, input.sequence);
    out.push(input.sigOpCount);
    pushScript(out, input.spkVersion, input.spkScriptHex);
    const sig = signatures[i];
    if (!sig) out.push(0);
    else {
      out.push(extraSignature ? 2 : 1, 0, sighash, ...hexToBytes(sig));
      if (extraSignature) out.push(1, sighash, ...hexToBytes(sig));
    }
    const redeem = redeems[i] ? hexToBytes(redeems[i]) : new Uint8Array(0);
    pushU16(out, redeem.length);
    out.push(...redeem);
  });
  for (const output of request.outputs) {
    pushU64(out, output.valueSompi);
    pushScript(out, output.spkVersion, output.spkScriptHex);
  }
  for (const record of records) out.push(...record);
  return new Uint8Array(out);
}

/** What the unit signs: the SDK transaction broadcastSigned assembles, each input signed with
 *  `privHex` over its P2SH sighash. Returns the 64-byte signatures, hex. */
function unitSignatures(unsigned, privHex) {
  const tx = new kaspa.Transaction({
    version: unsigned.txVersion,
    inputs: unsigned.inputs.map((input) => ({
      previousOutpoint: { transactionId: input.prevTxId, index: input.prevIndex },
      signatureScript: "",
      sequence: input.sequence,
      sigOpCount: input.sigOpCount,
      utxo: {
        address: undefined,
        outpoint: { transactionId: input.prevTxId, index: input.prevIndex },
        amount: input.amountSompi,
        scriptPublicKey: new kaspa.ScriptPublicKey(input.spkVersion, input.spkScriptHex),
        blockDaaScore: 0n,
        isCoinbase: false,
      },
    })),
    outputs: unsigned.outputs.map((o) => ({ value: o.valueSompi, scriptPublicKey: new kaspa.ScriptPublicKey(o.spkVersion, o.spkScriptHex) })),
    lockTime: unsigned.lockTime,
    subnetworkId: unsigned.subnetworkIdHex,
    gas: unsigned.gas,
    payload: "",
  });
  const key = new kaspa.PrivateKey(privHex);
  return unsigned.inputs.map((_, i) => {
    const script = String(kaspa.createInputSignature(tx, i, key, kaspa.SighashType.All));
    return script.slice(2, 130); // 0x41 <64-byte signature> 0x01
  });
}

/** An unsigned model from a decoded request (what the build would have made). */
function unsignedFromRequest(decoded, extra = {}) {
  return {
    txVersion: decoded.txVersion, lockTime: decoded.lockTime, subnetworkIdHex: decoded.subnetworkIdHex,
    gas: decoded.gas, payloadHex: decoded.payloadHex || null,
    inputs: decoded.inputs.map((i) => ({ prevTxId: i.prevTxId, prevIndex: i.prevIndex, amountSompi: i.amountSompi, sequence: i.sequence, sigOpCount: i.sigOpCount, spkVersion: i.spkVersion, spkScriptHex: i.spkScriptHex })),
    outputs: decoded.outputs.map((o) => ({ ...o })),
    ...extra,
  };
}

const shuffle = (xs, seed = 7) => {
  const out = [...xs];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) % 2147483648; const j = s % (i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
};

async function main() {
  // --- the vectors themselves, when KasSigner's checkout is next to this repo ---
  const vectorDir = join(repo, "..", "..", "..", "..", "KasSigner", "spec", "vectors", "v110", "sdk");
  const altDir = join(repo, "..", "KasSigner", "spec", "vectors", "v110", "sdk");
  const dir = [vectorDir, altDir].find((d) => existsSync(d));
  if (dir) {
    for (const name of Object.keys(VECTORS)) {
      r.eq(bytesToHex(readFileSync(join(dir, name))), VECTORS[name], `vector ${name} matches KasSigner's spec/vectors/v110/sdk`);
    }
    console.log(`KasSigner vectors checked against ${dir}`);
  } else {
    console.log("KasSigner checkout not found next to the repo: using the vectors' copies here");
  }

  // --- 0x06 encoder: byte-identical to KasSigner's writer ---
  {
    const sweep = decodeKspt(vec("sweep.request"));
    r.eq(sweep.version, 0x06, "sweep request: version 0x06");
    r.eq(sweep.signed, false, "sweep request: unsigned");
    r.eq(sweep.inputs.length, 2, "sweep request: two inputs");
    r.eq(sweep.inputs[0].hint, null, "sweep request: input 0 not hinted");
    r.eq(JSON.stringify(sweep.inputs[1].hint), JSON.stringify({ kind: "kcc3", chain: 0, addrIndex: 0 }), "sweep request: input 1 carries a 0x46 KCC-3 hint (receive #0)");
    r.eq(sweep.records.length, 1, "sweep request: one record");
    const again = encodeUnsignedKsptV6({ ...unsignedFromRequest(sweep), inputHints: sweep.inputs.map((i) => i.hint) });
    r.eq(bytesToHex(again), VECTORS["sweep.request"], "sweep request: encodeUnsignedKsptV6 writes KasSigner's bytes exactly");

    const single = decodeKspt(vec("single.request"));
    r.eq(single.records.length, 0, "single request: no records");
    const singleAgain = encodeUnsignedKsptV6(unsignedFromRequest(single));
    r.eq(bytesToHex(singleAgain), VECTORS["single.request"], "single request: encodeUnsignedKsptV6 writes KasSigner's bytes exactly");
    // the same transaction as 0x01 is what a regular Cold Storage send still shows
    const v1 = encodeUnsignedKspt(unsignedFromRequest(single));
    r.eq(v1[4], 0x01, "single as a regular send: version 0x01");
    r.eq(decodeKspt(v1).version, 0x01, "0x01 still decodes");
  }

  // --- 0x06 reply: the unit's redeem scripts, checked and assembled into what it signed ---
  {
    const reply = decodeKspt(vec("sweep.reply.abandon12"));
    r.eq(reply.version, 0x06, "sweep reply: version 0x06");
    r.check(reply.signed, "sweep reply: signed");
    for (const [i, input] of reply.inputs.entries()) {
      r.eq(input.signatures.length, 1, `sweep reply input ${i}: one signature`);
      r.eq(input.sighashType, 0x01, `sweep reply input ${i}: SIGHASH_ALL`);
      r.eq(input.redeemScriptHex?.length, 68, `sweep reply input ${i}: a 34-byte redeem`);
      r.eq(bytesToHex(p2shScript(hexToBytes(input.redeemScriptHex))), input.spkScriptHex, `sweep reply input ${i}: the redeem hashes to the input's P2SH lock`);
    }
    // broadcastSigned on the request as Desktop would have built it: the unit's real signatures
    // must verify (verifyKip22Spend inside it) over the transaction assembled here.
    const engine = fakeEngine({});
    const unsigned = unsignedFromRequest(decodeKspt(vec("sweep.request")), { isQuantumSource: true });
    const txid = await broadcastSigned({ engine, unsigned, decoded: reply });
    r.eq(engine.submitted.length, 1, "sweep reply: broadcast");
    const tx = engine.submitted[0];
    const scripts = [...tx.inputs].map((i) => String(i.signatureScript));
    r.eq(scripts[0], `41${reply.inputs[0].signatureHex}0122${reply.inputs[0].redeemScriptHex}`, "sweep reply: signature script is <sig+ALL> <push redeem>");
    r.eq(scripts[0].length / 2, Number(KCC3_SIG_SCRIPT_LEN), "sweep reply: signature script is the 101 bytes it was priced with");
    // KasSigner's covenant.kcc3.signed.json has the same 22' receive 0 signature-script tail
    r.check(scripts[1].endsWith("2220fa507ef4400da1016770879248322820e16cdea980b83261b5bb5d384f2e2b45ac"), "sweep reply: the redeem tail is KasSigner's KCC-3 receive 0");
    r.check(Boolean(txid), "sweep reply: a transaction id comes back");

    // the unit's single-key 0x06 reply to a plain spend goes out as a plain spend
    const singleEngine = fakeEngine({});
    const single = unsignedFromRequest(decodeKspt(vec("single.request")), { isQuantumSource: false });
    await broadcastSigned({ engine: singleEngine, unsigned: single, decoded: decodeKspt(vec("single.reply.abandon12")) });
    r.eq(String([...singleEngine.submitted[0].inputs][0].signatureScript).length / 2, 66, "single reply: a plain 66-byte signature script");

    // a quantum send's reply without the redeem (a unit that doesn't know KCC-3) is refused
    const bare = writeReplyV6(decodeKspt(vec("sweep.request")), { signatures: reply.inputs.map((i) => i.signatureHex) });
    await r.throws(() => broadcastSigned({ engine: fakeEngine({}), unsigned, decoded: decodeKspt(bare) }),
      (e) => e.message.startsWith(QUANTUM_SCRIPT_MISMATCH), "reply without the redeem: refused");
    // ... or with another key's redeem (it isn't what the address is the hash of)
    const other = quantumKey("77");
    const wrong = writeReplyV6(decodeKspt(vec("sweep.request")), {
      signatures: reply.inputs.map((i) => i.signatureHex), redeems: reply.inputs.map(() => bytesToHex(other.redeem)),
    });
    await r.throws(() => broadcastSigned({ engine: fakeEngine({}), unsigned, decoded: decodeKspt(wrong) }),
      (e) => e.message.startsWith(QUANTUM_SCRIPT_MISMATCH), "reply with another key's redeem: refused");
    // ... or with the right redeem and a signature for something else
    const swapped = writeReplyV6(decodeKspt(vec("sweep.request")), {
      signatures: [reply.inputs[1].signatureHex, reply.inputs[0].signatureHex], redeems: reply.inputs.map((i) => i.redeemScriptHex),
    });
    await r.throws(() => broadcastSigned({ engine: fakeEngine({}), unsigned, decoded: decodeKspt(swapped) }),
      (e) => /signature doesn't match/.test(e.message), "reply with signatures that don't verify: refused before broadcast");
    // ... or binding a covenant (0x43), which nothing here asks for
    const covenant = [0x43, 0, 0, 0, ...new Array(32).fill(0x5a)];
    const bound = writeReplyV6(decodeKspt(vec("sweep.request")), {
      signatures: reply.inputs.map((i) => i.signatureHex), redeems: reply.inputs.map((i) => i.redeemScriptHex), records: [covenant],
    });
    await r.throws(() => broadcastSigned({ engine: fakeEngine({}), unsigned, decoded: decodeKspt(bound) }),
      (e) => e.message === UNEXPECTED_COVENANT, "reply binding a covenant: refused");
    const coinBound = writeReplyV6(decodeKspt(vec("sweep.request")), {
      signatures: reply.inputs.map((i) => i.signatureHex), redeems: reply.inputs.map((i) => i.redeemScriptHex), records: [[0x49, 1, ...new Array(32).fill(0x5a)]],
    });
    await r.throws(() => broadcastSigned({ engine: fakeEngine({}), unsigned, decoded: decodeKspt(coinBound) }),
      (e) => e.message === UNEXPECTED_COVENANT, "reply naming a coin covenant: refused");
    // ... and a regular send's reply carrying a redeem is not what was signed for
    await r.throws(() => broadcastSigned({ engine: fakeEngine({}), unsigned: { ...unsigned, isQuantumSource: false }, decoded: reply }),
      (e) => /doesn't match what was sent/.test(e.message), "a redeem on a regular send's reply: refused");
  }

  // --- 0x06 parser refuses what KasSigner's refuses ---
  {
    const good = vec("sweep.reply.abandon12");
    const bad = (mutate) => { const b = new Uint8Array(good); mutate(b); return b; };
    await r.throws(() => decodeKspt(bad((b) => { b[5] = 1; })), (e) => /flags must be zero/.test(e.message), "parser: reserved flags");
    await r.throws(() => decodeKspt(new Uint8Array([...good, 0x50])), (e) => /unknown record/.test(e.message), "parser: an unknown record");
    await r.throws(() => decodeKspt(new Uint8Array([...good, 0x46, 1, 0, 0, 0, 0, 0, 0, 0, 0])), (e) => /repeats record/.test(e.message), "parser: a second hint on one input");
    await r.throws(() => decodeKspt(new Uint8Array([...good, 0x46, 7, 0, 0, 0, 0, 0, 0, 0, 0])), (e) => /doesn't exist/.test(e.message), "parser: a hint naming a missing input");
    await r.throws(() => decodeKspt(good.slice(0, good.length - 3)), (e) => /truncated/.test(e.message), "parser: truncated");
    const req = decodeKspt(vec("sweep.request"));
    // a P2SH input with neither a KCC-3 hint nor its redeem may be anyone's script: two signatures
    // pass the parser there, and the broadcast refuses the missing redeem
    r.eq(decodeKspt(writeReplyV6(req, { signatures: ["11".repeat(64), "22".repeat(64)], extraSignature: true })).inputs[0].signatures.length, 2,
      "parser: an unhinted P2SH input without its redeem isn't taken for single-key");
    const twoSigsHinted = writeReplyV6(req, { signatures: ["11".repeat(64), "22".repeat(64)], extraSignature: true, records: [[0x46, 0, 0, 0, 0, 0, 0, 0, 0, 0]] });
    await r.throws(() => decodeKspt(twoSigsHinted), (e) => /more than one signature/.test(e.message), "parser: two signatures on a KCC-3-hinted input");
    const twoSigsRedeem = writeReplyV6(req, { signatures: ["11".repeat(64), "22".repeat(64)], extraSignature: true, redeems: [bytesToHex(quantumKey("55").redeem), null] });
    await r.throws(() => decodeKspt(twoSigsRedeem), (e) => /more than one signature/.test(e.message), "parser: two signatures on an input carrying a KCC-3 redeem");
    const badRedeem = writeReplyV6(req, { signatures: ["11".repeat(64), null], redeems: ["51ac"], records: [[0x46, 0, 0, 0, 0, 0, 0, 0, 0, 0]] });
    await r.throws(() => decodeKspt(badRedeem), (e) => /redeem script its lock doesn't take/.test(e.message), "parser: a KCC-3-hinted input whose redeem isn't <P> OP_CHECKSIG");
    // a long-form script length below 255 is not canonical
    const at = 6 + 2 + 1 + 1 + 8 + 20 + 8 + 2 + 32 + 4 + 8 + 8 + 1 + 2; // input 0's spk length byte
    r.eq(good[at], 0x23, "parser: input 0's script length is where it should be");
    const longForm = new Uint8Array([...good.slice(0, at), 0xff, 0x23, 0x00, ...good.slice(at + 1)]);
    await r.throws(() => decodeKspt(longForm), (e) => /short form/.test(e.message), "parser: a script length not in its short form");
    const single = decodeKspt(vec("single.request"));
    const redeemOnP2pk = writeReplyV6(single, { signatures: ["11".repeat(64), "22".repeat(64)], redeems: [bytesToHex(quantumKey("55").redeem), null] });
    await r.throws(() => decodeKspt(redeemOnP2pk), (e) => /redeem script its lock doesn't take/.test(e.message), "parser: a redeem on a P2PK input");
  }

  // --- 0x06 encoder refuses a hint that can't be right ---
  {
    const single = unsignedFromRequest(decodeKspt(vec("single.request")));
    const sweep = unsignedFromRequest(decodeKspt(vec("sweep.request")));
    await r.throws(() => encodeUnsignedKsptV6({ ...single, inputHints: single.inputs.map(() => ({ kind: "kcc3", chain: 0, addrIndex: 0 })) }),
      (e) => /hint doesn't fit/.test(e.message), "encoder: a KCC-3 hint on a P2PK input");
    await r.throws(() => encodeUnsignedKsptV6({ ...sweep, inputHints: sweep.inputs.map(() => ({ kind: "kcc3", chain: 2, addrIndex: 0 })) }),
      (e) => /hint doesn't fit/.test(e.message), "encoder: chain 2");
    await r.throws(() => encodeUnsignedKsptV6({ ...sweep, inputHints: sweep.inputs.map(() => ({ kind: "kcc3", chain: 0, addrIndex: 0x80000000 })) }),
      (e) => /hint doesn't fit/.test(e.message), "encoder: a hardened number");
    await r.throws(() => encodeUnsignedKsptV6({ ...sweep, inputHints: [null] }), (e) => /2 inputs but 1 hints/.test(e.message), "encoder: hints for some inputs only");
    await r.throws(() => encodeUnsignedKsptV6({ ...sweep, outputs: [{ ...sweep.outputs[0], valueSompi: 29_000_000_000n * KAS + 1n }] }),
      (e) => /total supply/.test(e.message), "encoder: more than the supply");
  }

  // --- v1.1 reply frames, read beside v1.0.7's ---
  {
    const payload = vec("sweep.reply.abandon12");
    const frames = v11Frames(payload, { perFrame: 60 });
    r.check(frames.length > 2, `v1.1 frames: the reply in ${frames.length} frames`);
    r.eq(frames[0][0], 0x1b, "v1.1 frames: magic 0x1B");
    r.eq(frames[0].length, 8 + Math.ceil((payload.length + 3) / frames.length) - 3, "v1.1 frames: frame 0 carries the whole digest");
    r.eq(bytesToHex(frames[0].slice(4, 8)), bytesToHex(v11Digest(payload)), "v1.1 frames: frame 0 names the payload's SHA-256 digest");
    let acc = new QrFrameAccumulator(looksLikeKspt);
    let out = null;
    for (const f of shuffle([...frames, frames[1], frames[0]])) out = acc.addFrame(f) || out;
    r.eq(out && bytesToHex(out), bytesToHex(payload), "v1.1 frames: reassembled in any order, with repeats");
    // a single-code v1.1 reply (the unit uses v1.1 frames even when one code holds it)
    acc = new QrFrameAccumulator(looksLikeKspt);
    const one = v11Frames(payload, { perFrame: 1000 });
    r.eq(one.length, 1, "v1.1 single frame: one code");
    r.eq(bytesToHex(acc.addFrame(one[0]) || []), bytesToHex(payload), "v1.1 single frame: read at once");
    // two transmissions with the same count and tag never make a payload: the digest refuses it
    const other = new Uint8Array(payload); other[other.length - 1] ^= 1;
    const forged = v11Frames(other, { perFrame: 60 }).slice(1).map((f) => { const c = new Uint8Array(f); c[4] = frames[0][4]; return c; });
    acc = new QrFrameAccumulator(looksLikeKspt);
    out = null;
    for (const f of [frames[0], ...forged]) out = acc.addFrame(f) || out;
    r.eq(out, null, "v1.1 frames: frames of two transmissions are never joined");
    // a kpub (format 3) on screen is ignored and doesn't drop what's held
    acc = new QrFrameAccumulator(looksLikeKspt);
    acc.addFrame(frames[0]);
    acc.addFrame(new Uint8Array([0x1b, 3, 0, 1, 0, 0, 0, 0, 1, 2, 3]));
    r.eq(acc.progress?.received, 1, "v1.1 frames: another format is ignored");
    // a v1.0.7-shaped code while a v1.1 set is in progress doesn't wipe it
    acc.addFrame(new Uint8Array([0, 2, 3, 9, 9, 9]));
    r.eq(acc.progress?.received, 1, "v1.1 frames: a stray v1.0.7 shape doesn't wipe the set");
    for (const f of frames.slice(1)) out = acc.addFrame(f) || out;
    r.eq(out && bytesToHex(out), bytesToHex(payload), "v1.1 frames: the set still completes");
    // v1.0.7 frames (what K writes, and a 0x01 reply) still read
    acc = new QrFrameAccumulator(looksLikeKspt);
    const big = vec("single.reply.abandon12");
    out = null;
    for (const f of shuffle(chunkQrFrames(big))) out = acc.addFrame(f) || out;
    r.eq(out && bytesToHex(out), bytesToHex(big), "v1.0.7 frames: still reassemble");
    r.eq(bytesToHex(new QrFrameAccumulator(looksLikeKspt).addFrame(vec("sweep.request"))), VECTORS["sweep.request"], "a bare KSPT code: read as is");
  }

  // --- a send from a quantum address: every coin, priced at 101 bytes, change elsewhere, 0x06 ---
  const src = quantumKey("11");
  const changeQ = quantumKey("22");
  const dest = new kaspa.PrivateKey("5a".padEnd(62, "0") + "4e").toAddress(NET).toString();
  const plain = new kaspa.PrivateKey("5a".padEnd(62, "0") + "4d").toAddress(NET).toString();
  r.check(isScriptHashAddress({ kaspa }, src.address), "a KCC-3 address reads as P2SH");
  r.check(!isScriptHashAddress({ kaspa }, plain), "a regular address doesn't");
  {
    const engine = fakeEngine({ [src.address]: [3n * KAS, 2n * KAS, 1n * KAS, 50_000_000n, 20_000_000n] });
    const u = await buildUnsignedTransaction({
      engine, fromAddress: src.address, toAddress: dest, amountSompi: 1n * KAS, feeRateOverride: RATE,
      changeAddress: changeQ.address, quantumUnitIndex: 7, quantumUnitChain: 0,
    });
    r.eq(u.inputs.length, 5, "quantum send: every coin is spent, though one covers the amount");
    r.eq(u.coinsLeftBehind, 0, "quantum send: nothing left behind");
    r.check(u.isQuantumSource, "quantum send: marked as a quantum source");
    r.eq(u.changeAddress, changeQ.address, "quantum send: change to the fresh quantum address");
    r.eq(u.outputs[1].spkScriptHex, bytesToHex(p2shScript(changeQ.redeem)), "quantum send: the change output pays the fresh address");
    const fee = calculateFee(calculateMass(5, [34, 35], 0, 1, KCC3_SIG_SCRIPT_LEN), RATE);
    r.eq(u.feeSompi, fee, "quantum send: priced with the 101-byte signature script");
    r.check(fee > calculateFee(calculateMass(5, [34, 35], 0), RATE), "quantum send: dearer than a plain 66-byte input");
    const bytes = unsignedToKsptBytes(u);
    r.eq(bytes[4], 0x06, "quantum send: KSPT 0x06");
    const d = decodeKspt(bytes);
    r.check(d.inputs.every((i) => i.hint?.kind === "kcc3" && i.hint.chain === 0 && i.hint.addrIndex === 7), "quantum send: a 0x46 hint (#7, receive) on every input");
    r.check(d.inputs.every((i) => i.redeemScriptHex === null), "quantum send: no redeem script in the request");
    const noHint = decodeKspt(unsignedToKsptBytes({ ...u, quantumUnitIndex: null }));
    r.check(noHint.inputs.every((i) => i.hint === null) && noHint.records.length === 0, "Sign Without the Address Number: the same request with no hint");
    r.eq(bytesToHex(encodeUnsignedKsptV6({ ...u, inputHints: [] })), bytesToHex(unsignedToKsptBytes({ ...u, quantumUnitIndex: null })), "Sign Without the Address Number: exactly the hintless encoding");
    const changeChain = decodeKspt(unsignedToKsptBytes({ ...u, quantumUnitChain: 1 }));
    r.eq(changeChain.inputs[0].hint.chain, 1, "the hint sends the address's real chain");

    // the unit signs it; the reply goes out, and the spend verifies
    const sigs = unitSignatures(u, src.privHex);
    const reply = writeReplyV6(d, { signatures: sigs, redeems: u.inputs.map(() => bytesToHex(src.redeem)), records: d.inputs.map((_, i) => [0x46, i, 0, 0, 0, 0, 7, 0, 0, 0]) });
    // in v1.1 frames, scanned back
    const acc = new QrFrameAccumulator(looksLikeKspt);
    let scanned = null;
    for (const f of v11Frames(reply)) scanned = acc.addFrame(f) || scanned;
    const txid = await broadcastSigned({ engine, unsigned: u, decoded: decodeKspt(scanned) });
    r.check(Boolean(txid) && engine.submitted.length === 1, "quantum send: the unit's reply is broadcast");
    const sent = engine.submitted[0];
    const paid = [...sent.inputs].reduce((s, i) => s + BigInt(i.utxo.amount), 0n) - [...sent.outputs].reduce((s, o) => s + BigInt(o.value), 0n);
    r.eq(paid, u.feeSompi, "quantum send: the fee paid is the fee shown");
    // signed by the wrong key: refused before broadcast
    const wrongSigs = unitSignatures(u, changeQ.privHex);
    const wrongReply = writeReplyV6(d, { signatures: wrongSigs, redeems: u.inputs.map(() => bytesToHex(src.redeem)) });
    await r.throws(() => broadcastSigned({ engine: fakeEngine({}), unsigned: u, decoded: decodeKspt(wrongReply) }),
      (e) => /signature doesn't match/.test(e.message), "quantum send: another key's signatures are refused");
    const notAll = writeReplyV6(d, { signatures: sigs, redeems: u.inputs.map(() => bytesToHex(src.redeem)), sighash: 0x02 });
    await r.throws(() => broadcastSigned({ engine: fakeEngine({}), unsigned: u, decoded: decodeKspt(notAll) }),
      (e) => /doesn't cover the whole transaction/.test(e.message), "quantum send: only SIGHASH_ALL");
  }
  {
    // no fresh address: change can't come back onto the revealed key...
    const engine = fakeEngine({ [src.address]: [3n * KAS, 2n * KAS] });
    await r.throws(() => buildUnsignedTransaction({ engine, fromAddress: src.address, toAddress: dest, amountSompi: 1n * KAS, feeRateOverride: RATE }),
      (e) => e.message === QUANTUM_CHANGE_NEEDS_FRESH_ADDRESS, "quantum send: change back to the source is refused");
    // ...but the whole balance (no change) goes without one
    const max = await estimateMaxAmount({ engine, fromAddress: src.address, feeRateOverride: RATE, toAddress: dest });
    r.eq(max, 5n * KAS - calculateFee(calculateMass(2, [34, 35], 0, 1, KCC3_SIG_SCRIPT_LEN), RATE), "quantum Max: every coin, less a fee priced at 101 bytes an input");
    const u = await buildUnsignedTransaction({ engine, fromAddress: src.address, toAddress: dest, amountSompi: max, feeRateOverride: RATE });
    r.eq(u.outputs.length, 1, "quantum Max: one output, no change");
    r.eq(u.changeAddress, null, "quantum Max: no change address taken");
    // the preview prices what the build takes
    const preview = await previewAutomaticSelection({ engine, fromAddress: src.address, amountSompi: 1n * KAS, feeRateSompiPerGram: RATE, toAddress: dest });
    r.eq(preview.utxoKeys.length, 2, "quantum preview: every coin");
    r.eq(preview.feeSompi, calculateFee(calculateMass(2, [34, 35], 0, 1, KCC3_SIG_SCRIPT_LEN), RATE), "quantum preview: priced at 101 bytes");
    // a change address that isn't quantum, or change elsewhere for a regular source: refused
    await r.throws(() => buildUnsignedTransaction({ engine, fromAddress: src.address, toAddress: dest, amountSompi: 1n * KAS, feeRateOverride: RATE, changeAddress: plain }),
      (e) => /Invalid change address/.test(e.message), "quantum send: a regular change address is refused");
    const plainEngine = fakeEngine({ [plain]: [3n * KAS] });
    await r.throws(() => buildUnsignedTransaction({ engine: plainEngine, fromAddress: plain, toAddress: dest, amountSompi: 1n * KAS, feeRateOverride: RATE, changeAddress: changeQ.address }),
      (e) => /Invalid change address/.test(e.message), "regular send: change elsewhere is refused");
    // a regular send stays 0x01 with 66-byte pricing and coin control
    const regular = await buildUnsignedTransaction({ engine: plainEngine, fromAddress: plain, toAddress: dest, amountSompi: 1n * KAS, feeRateOverride: RATE });
    r.eq(unsignedToKsptBytes(regular)[4], 0x01, "regular send: still KSPT 0x01");
    r.check(!regular.isQuantumSource, "regular send: not a quantum source");
    r.eq(regular.feeSompi, calculateFee(calculateMass(1, [34, 34], 0), RATE), "regular send: 66-byte pricing as before");
  }
  {
    // more coins than one transaction takes: 32 go, the rest are named
    const amounts = Array.from({ length: 40 }, (_, i) => BigInt(i + 1) * 10_000_000n);
    const engine = fakeEngine({ [src.address]: amounts });
    const u = await buildUnsignedTransaction({ engine, fromAddress: src.address, toAddress: dest, amountSompi: 1n * KAS, feeRateOverride: RATE, changeAddress: changeQ.address });
    r.eq(u.inputs.length, 32, "quantum send of 40 coins: 32 inputs");
    r.eq(u.coinsLeftBehind, 8, "quantum send of 40 coins: 8 named as left behind");
    r.eq(u.inputs[31].amountSompi, 90_000_000n, "quantum send of 40 coins: the largest 32");
    r.eq(decodeKspt(unsignedToKsptBytes(u)).inputs.length, 32, "quantum send of 40 coins: encodes");
  }

  // --- the change pick (K freshQuantumChangeAddress) ---
  {
    const recs = normalizeQuantumRecords([
      { address: "kaspa:qsrc", unitIndex: 0, chain: 0 },
      { address: "kaspa:qrecv", unitIndex: 1, chain: 0 },
      { address: "kaspa:qchange9", unitIndex: 9, chain: 1 },
      { address: "kaspa:qchange3", unitIndex: 3, chain: 1 },
      { address: "kaspa:qchangeunknown", unitIndex: null, chain: 1 },
      { address: "KASPA:QCHANGE0", unitIndex: 0, chain: 1 },
      { address: "kaspa:qrecv", unitIndex: 5, chain: 0 }, // a duplicate: dropped
    ]);
    r.eq(recs.length, 6, "records: one per address, lowercased");
    r.eq(rankedChangeCandidates(recs, "kaspa:qsrc").join(","), "kaspa:qchange3,kaspa:qchange0,kaspa:qchange9,kaspa:qchangeunknown,kaspa:qrecv",
      "change candidates: change #0-4 first (in the order added), other change, then receive; never the source");
    const probes = (funded, used, spent) => ({
      fundedAddresses: async () => new Set(funded),
      usedState: async (a) => (a in used ? used[a] : false),
      spentState: async (a) => spent.includes(a),
    });
    let reserved = new Set();
    r.eq(await pickFreshQuantumChange({ records: recs, source: "kaspa:qsrc", reserved, ...probes([], {}, []) }), "kaspa:qchange3", "change pick: the unit-marked change address");
    r.check(reserved.has("kaspa:qchange3"), "change pick: reserved for the session");
    r.eq(await pickFreshQuantumChange({ records: recs, source: "kaspa:qsrc", reserved, ...probes([], {}, []) }), "kaspa:qchange0", "change pick: a second request takes the next");
    reserved = new Set();
    r.eq(await pickFreshQuantumChange({ records: recs, source: "kaspa:qsrc", reserved, ...probes(["kaspa:qchange3"], { "kaspa:qchange0": true }, []) }), "kaspa:qchange9",
      "change pick: funded and used addresses are skipped");
    reserved = new Set();
    r.eq(await pickFreshQuantumChange({ records: recs, source: "kaspa:qsrc", reserved, ...probes([], { "kaspa:qchange3": null }, ["kaspa:qchange0"]) }), "kaspa:qchange9",
      "change pick: a failed history read counts as used; a revealed key is never change");
    reserved = new Set();
    r.eq(await pickFreshQuantumChange({ records: recs, source: "kaspa:qsrc", reserved, fundedAddresses: async () => null, usedState: async () => false, spentState: async () => false }), null,
      "change pick: no pick when the balances can't be read");
    r.eq(await pickFreshQuantumChange({ records: recs.slice(0, 1), source: "kaspa:qsrc", reserved: new Set(), ...probes([], {}, []) }), null, "change pick: none when the source is the only one");
    r.check(unitMarksAsChange({ chain: 1, unitIndex: 4 }) && !unitMarksAsChange({ chain: 1, unitIndex: 5 }) && !unitMarksAsChange({ chain: 0, unitIndex: 0 }) && !unitMarksAsChange({ chain: 1, unitIndex: null }),
      "KasSigner marks change only on change-chain #0-4");
  }

  // --- records, names, numbers and the index space ---
  {
    r.eq(COLD_QUANTUM_INDEX_BASE, QUANTUM_INDEX_BASE, "quantum entries share the hot wallet's base (1,000,000)");
    r.eq(quantumDefaultLabel(0, null), "Quantum Address", "label: receive, no number");
    r.eq(quantumDefaultLabel(1, 0), "Quantum Change Address #0", "label: change #0");
    r.eq(quantumDefaultLabel(0, 3), "Quantum Address #3", "label: receive #3");
    r.eq(quantumAddressInput("  KASPA:PQXYZ?amount=1 "), "kaspa:pqxyz", "input: a payment URI's query dropped, lower case");
    r.eq(JSON.stringify(parseUnitNumber("")), JSON.stringify({ ok: true, value: null }), "number: empty is none");
    r.eq(parseUnitNumber(" 12 ").value, 12, "number: 12");
    r.eq(parseUnitNumber("2147483647").value, 2147483647, "number: the highest non-hardened");
    r.eq(parseUnitNumber("2147483648").ok, false, "number: hardened refused");
    r.eq(parseUnitNumber("1.5").ok, false, "number: not whole refused");
    r.eq(parseUnitNumber("-1").ok, false, "number: negative refused");
    const recs = normalizeQuantumRecords([{ address: "a" }, { address: "b" }, { address: "c" }]);
    r.eq(quantumIndexOf(recs, "B"), COLD_QUANTUM_INDEX_BASE + 1, "index: base + place in the list");
    r.eq(quantumIndexOf(recs, "z"), null, "index: null once not watched");
    const B = COLD_QUANTUM_INDEX_BASE;
    const moved = afterQuantumRemoval({ labels: { 3: "kpub row", [B]: "first", [B + 1]: "second", [B + 2]: "third" }, hidden: [5, B + 1, B + 2] }, 1);
    r.eq(JSON.stringify(moved.labels), JSON.stringify({ 3: "kpub row", [B]: "first", [B + 1]: "third" }), "stop watching: its label goes, the later ones move up");
    r.eq(JSON.stringify(moved.hidden), JSON.stringify([5, B + 1]), "stop watching: hidden flags move with their addresses");
  }

  // --- history: change to another address of the account isn't Sent ---
  {
    const own = new Set(["kaspa:qa", "kaspa:qb"]);
    const tx = (outs) => ({ outputs: outs.map(([to, amount]) => ({ script_public_key_address: to, amount })) });
    const sentRow = ownChangeHistoryAmount(tx([["kaspa:other", 100], ["kaspa:qa", 50]]), "kaspa:src", own);
    r.check(sentRow?.moved === false && sentRow.amountSompi === 100n, "history: a send's change to the account's quantum address isn't counted as Sent");
    const movedRow = ownChangeHistoryAmount(tx([["kaspa:qb", 900]]), "kaspa:src", own);
    r.check(movedRow?.moved === true && movedRow.amountSompi === 900n, "history: all of it to the account's own addresses is Moved");
    r.eq(ownChangeHistoryAmount(tx([["kaspa:other", 100], ["kaspa:src", 5]]), "kaspa:src", own), null, "history: a plain send keeps its usual figures");
  }
}

// --- the screens (ui/coldstorage.js imports CSS, so its source is read) ---
function screens() {
  const src = readFileSync(join(repo, "ui", "coldstorage.js"), "utf8");
  const fn = (name) => {
    const start = src.search(new RegExp(`(async )?function ${name}\\(`));
    if (start < 0) return "";
    let depth = 0;
    for (let i = src.indexOf("{", src.indexOf(")", start)); i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
    }
    return "";
  };
  r.check(/quantumAddresses: normalizeQuantumRecords\(raw\.quantumAddresses\)/.test(fn("normalizeAccount")), "screens: an account keeps its quantum addresses");
  r.check(/"Add Quantum-Resistant Address", "Scan a KCC-3 address from KasSigner's address screen\."/.test(fn("renderColdActionsSheet")), "screens: Address Actions > Add Quantum-Resistant Address");
  const addressSheet = fn("renderColdAddressSheet");
  r.check(/Edit Address Number/.test(addressSheet) && /Stop Watching/.test(addressSheet) && /isColdQuantumIndex\(i\)/.test(addressSheet), "screens: a quantum row's ⋯ has Edit Address Number and Stop Watching");
  const actions = fn("handleAddressAction");
  r.check(/stop-watching[\s\S]*balanceSompi \|\| 0\) > 0[\s\S]*confirmModal\(\{[\s\S]*Stop Watching This Address\?/.test(actions), "screens: Stop Watching asks first when the address holds coins");
  r.check(/currentIndexOf\(account, entry\)/.test(actions), "screens: rename and hide file under the row's current index");
  const quantumSheet = fn("renderColdQuantumSheet");
  r.check(/Receive Address/.test(quantumSheet) && /Change Address/.test(quantumSheet) && /placeholder="Optional"/.test(quantumSheet), "screens: the number (optional) and the Receive / Change chain");
  r.check(/parseUnitNumber\(form\.number\)/.test(fn("saveColdQuantumSheet")), "screens: the number is checked before saving");
  const visibility = fn("renderVisibility");
  r.check(/Quantum-Resistant Addresses/.test(visibility) && /visibilityPage === 0/.test(visibility), "screens: Address Visibility has the quantum section on its first page");
  r.check(/i <= account\.maxIndex/.test(fn("runAddressAction")), "screens: Generate More stays on the kpub's chain");
  r.check(/COLD_QUANTUM_INDEX_BASE \+ position/.test(fn("listColdWatchedAddresses")), "screens: quantum addresses are watched for Received KAS");
  r.check(/fetchBalancesBatch\(all\)/.test(fn("loadDetail")) && /coldQuantumSpentState/.test(fn("loadDetail")), "screens: quantum balances load with the rest, and the shield's spent state behind them");
  r.check(/coldQuantumShieldHtml\(entry\)/.test(fn("addressRowHtml")), "screens: the shield on a quantum row");
  const build = fn("sendBuild");
  r.check(/releaseQuantumChange\(flow\.reservedChange\)[\s\S]*freshQuantumChangeAddress\(flow\.fromAddress\)[\s\S]*changeAddress,[\s\S]*quantumUnitIndex:/.test(build), "screens: a quantum send's change is picked fresh (the old pick handed back) and the number sent");
  r.check(/!unsigned\.changeAddress[\s\S]*releaseQuantumChange\(changeAddress\)/.test(build), "screens: no change after all hands the pick back");
  r.check(/!send\.sent\) releaseQuantumChange\(send\.reservedChange\)/.test(fn("closeSendFlow")), "screens: closed before sending, the change address goes back");
  r.check(/markQuantumAddress\("used"/.test(fn("sendBroadcast")), "screens: sent, the change address is marked used");
  r.check(/QUANTUM_COMPOUND_NEEDS_FRESH_ADDRESS/.test(fn("setupSendCompound")), "screens: a quantum compound moves the coins to a fresh quantum address, or says why not");
  r.check(/showCoinControl: !send\.isCompound && !send\.isQuantumSource/.test(src), "screens: no coin control on a quantum source");
  r.check(/data-cold-send-no-number[\s\S]*quantumUnitIndex: null[\s\S]*chunkQrFrames\(unsignedToKsptBytes\(withoutHint\)\)/.test(src), "screens: Sign Without the Address Number re-encodes with no hint");
  r.check(/canCompound = !quantum \|\| \(activeAccount\(\)\?\.quantumAddresses\?\.length \|\| 0\) > 1/.test(fn("addressUtxoRowsHtml")), "screens: Compound on a quantum address only when the account has another");
  r.check(/ownChangeHistoryAmount\(tx, entry\.address, own\)/.test(fn("addressTxRowsHtml")), "screens: history counts change to the account's own addresses");
}

await main();
screens();
console.log(`cold storage quantum: ${r.pass} checks passed, ${r.fail} failed`);
if (r.fail) {
  for (const f of r.failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
