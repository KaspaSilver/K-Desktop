// Money fixes from the 2026-11-25 audit (findings 1, 31, 32). Offline only: fake coins, an
// in-memory RPC that records what would be submitted, a fake Trestly; nothing leaves the machine.
//
//   #1  A send too big for one transaction is a chain whose earlier transactions pay the change
//       address. With change going anywhere but the source (a fresh quantum-safe slot), the last
//       one can't be signed - after the earlier ones went out. Refused before anything is signed
//       (SEND_NEEDS_COMPOUND); a failure after part of a chain went out carries submittedTxids, and
//       the app reveals the fresh change slot for it.
//   #31 Trestly's swap picks its own coins: a swap from an address whose coins a scheduled KaPost
//       or a send of K's own still needs is refused, and the trade runs in the address's send queue.
//   #32 The KaPost tip sheet holds the tip to the fee the card showed (SEND_FEE_CHANGED), as the
//       chat's payment sheet does.
//
// Run from the repo root:
//
//   node tools/test-money-audit-2026-11-25.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";

import * as Q from "../engine/quantum.js";
import { deriveSpendingWallet } from "../engine/wallet.js";
import {
  sendKaspa, SEND_NEEDS_COMPOUND, SEND_NEEDS_COMPOUND_MESSAGE, coinsInUseReason, setReservedOutpoints,
  noteSpentOutpoints, clearJustSpentOutpoints, enqueueSend,
} from "../engine/transactions.js";
import * as TR from "../engine/kusdt-trade.js";
import * as K from "../engine/kusdt.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const read = (...p) => readFileSync(join(repo, ...p), "utf8");

const r = {
  pass: 0, fail: 0, failures: [],
  check(ok, label) { if (ok) this.pass++; else { this.fail++; this.failures.push(label); } },
  eq(a, b, label) { this.check(a === b, `${label}: got ${String(a)}, expected ${String(b)}`); },
  async throws(fn, pred, label) {
    try { await fn(); this.check(false, `${label}: did not throw`); } catch (e) { this.check(pred(e), `${label}: threw ${e?.message ?? e}`); }
  },
};

const kaspa = await import("../kaspa/kaspa.js");
await kaspa.default({ module_or_path: readFileSync(join(repo, "kaspa/kaspa_bg.wasm")) });

const KAS = 100_000_000n;
// Public all-zero-entropy 24-word BIP39 test mnemonic - not a real wallet.
const WORDS = [...Array(23).fill("abandon"), "art"].join(" ");
const B = Q.QUANTUM_INDEX_BASE;

let txCounter = 0;
const fakeTxid = () => (0xd25000 + ++txCounter).toString(16).padStart(64, "0");
const coin = (address, amount) => ({
  address,
  outpoint: { transactionId: fakeTxid(), index: 0 },
  amount,
  scriptPublicKey: kaspa.payToAddressScript(address),
  blockDaaScore: 1000n,
  isCoinbase: false,
});
function stubRpc() {
  const rpc = {
    utxos: new Map(),
    submitted: [],
    async getUtxosByAddresses(addresses) {
      const list = (Array.isArray(addresses) ? addresses : addresses?.addresses || []).map(String);
      return { entries: list.flatMap((a) => rpc.utxos.get(a) || []) };
    },
    async submitTransaction({ transaction }) {
      rpc.submitted.push(transaction);
      return { transactionId: transaction.id };
    },
  };
  return rpc;
}
// The generator's PendingTransaction.submit only takes a real RpcClient: route it to the stub.
kaspa.PendingTransaction.prototype.submit = async function submitToStub(rpc) {
  return (await rpc.submitTransaction({ transaction: this.transaction })).transactionId;
};

const source = deriveSpendingWallet(kaspa, WORDS, 1);
const legacyOther = deriveSpendingWallet(kaspa, WORDS, 2);
const quantumChange = deriveSpendingWallet(kaspa, WORDS, B + 2);
const dest = deriveSpendingWallet(kaspa, WORDS, 0).address;

/** A 120 KAS send from 150 coins of 1 KAS: past one transaction's inputs, so the SDK chains it. */
async function bigSend(changeAddress) {
  const rpc = stubRpc();
  rpc.utxos.set(source.address, Array.from({ length: 150 }, () => coin(source.address, KAS)));
  let result = null;
  let error = null;
  try {
    result = await sendKaspa({ kaspa, rpc, privateKey: source.privateKey, sourceAddress: source.address, destinationAddress: dest, amountKas: "120", changeAddress });
  } catch (e) { error = e; }
  return { rpc, result, error };
}

async function main() {
  // MARK: #1 A chain with change at another address is refused before anything is signed
  for (const [label, change] of [["fresh quantum-safe change", quantumChange.address], ["another legacy address's change", legacyOther.address]]) {
    const { rpc, error } = await bigSend(change);
    r.eq(error?.code, SEND_NEEDS_COMPOUND, `#1 ${label}: refused as SEND_NEEDS_COMPOUND`);
    r.eq(error?.message, SEND_NEEDS_COMPOUND_MESSAGE, `#1 ${label}: says to compound, nothing sent`);
    r.check(/Compound UTXOs/.test(error?.message || "") && /Nothing was sent/.test(error?.message || ""), `#1 ${label}: message names Compound UTXOs`);
    r.eq(error?.noRetry, true, `#1 ${label}: not retried`);
    r.eq(rpc.submitted.length, 0, `#1 ${label}: nothing submitted`);
  }
  // Change back to the source: the chain is sound (every transaction is signed by the source key).
  for (const [label, change] of [["no change address", null], ["change to the source", source.address]]) {
    const { rpc, result, error } = await bigSend(change);
    r.check(!error, `#1 ${label}: the chained send goes (${error?.message || ""})`);
    r.check((result?.txids?.length || 0) > 1, `#1 ${label}: more than one transaction (${result?.txids?.length})`);
    r.eq(rpc.submitted.length, result?.txids?.length, `#1 ${label}: every transaction submitted`);
  }
  // A failure after part of a chain went out carries submittedTxids, signing included.
  {
    const realSign = kaspa.PendingTransaction.prototype.sign;
    let signs = 0;
    kaspa.PendingTransaction.prototype.sign = function failSecond(...args) {
      signs += 1;
      if (signs === 2) throw new Error("The transaction is partially signed");
      return realSign.apply(this, args);
    };
    try {
      const { rpc, error } = await bigSend(null);
      r.check(Boolean(error), "#1 sign failure mid-chain: throws");
      r.eq(rpc.submitted.length, 1, "#1 sign failure mid-chain: the first transaction went out");
      r.eq(error?.submittedTxids?.length, 1, "#1 sign failure mid-chain: the error carries the submitted txid");
      r.eq(String(error?.submittedTxids?.[0] || ""), String(rpc.submitted[0]?.id || "-"), "#1 sign failure mid-chain: it is that transaction's id");
    } finally {
      kaspa.PendingTransaction.prototype.sign = realSign;
    }
  }
  // The app reveals the fresh change slot on a part-sent failure, not only on an unknown outcome.
  const app = read("ui", "app.js");
  const keep = app.slice(app.indexOf("function keepChangeVisibleIfOutcomeUnknown("), app.indexOf("function rotatePrimarySpendingTo("));
  r.check(/error\?\.submittedTxids/.test(keep) && /SEND_OUTCOME_UNKNOWN \|\| partSent/.test(keep), "#1 keepChangeVisibleIfOutcomeUnknown reveals the slot when submittedTxids is set");

  // MARK: #31 Coins promised elsewhere
  clearJustSpentOutpoints();
  setReservedOutpoints([]);
  const a = `${"a1".repeat(32)}:0`;
  const b = `${"b2".repeat(32)}:1`;
  r.eq(coinsInUseReason([a, b]), null, "#31 free coins: no reason");
  setReservedOutpoints([b]);
  r.eq(coinsInUseReason([a, b]), "reserved", "#31 a scheduled KaPost's coin: reserved");
  r.eq(coinsInUseReason([a]), null, "#31 a reserved coin elsewhere doesn't count");
  setReservedOutpoints([]);
  noteSpentOutpoints([a], 1_000);
  r.eq(coinsInUseReason([a, b], 2_000), "held", "#31 a coin a send just spent: held");
  r.eq(coinsInUseReason([a, b], 1_000 + 600_001), null, "#31 the hold runs out");
  r.eq(coinsInUseReason([b], 2_000), null, "#31 a held coin no longer listed doesn't count");
  clearJustSpentOutpoints();

  const sk = "01".repeat(32);
  const address = K.addressOfOwner(schnorr.getPublicKey(Buffer.from(sk, "hex")), "mainnet");
  const target = { label: "Chatting Address", address, spendingIndex: null };
  const present = [`${"c3".repeat(32)}:0`, `${"c3".repeat(32)}:1`];
  const params = { side: "buy", amountIn: "1000000000", minOut: "257400" };
  function makeTrade(extra = {}) {
    const log = [];
    const holds = new Map();
    const trade = TR.createTrestlyTrade({
      walletCall: async (fn) => {
        log.push(fn);
        if (fn === "prepare") return { kind: "swap", side: "buy", amountIn: params.amountIn, minOut: params.minOut, quote: "260000", feeAbout: "3000", feerate: 1, acceptedFee: null, paused: false, breaker: null, belowMinimum: false, feeShare: false, blocked: false };
        return { result: { txid: "d".repeat(64), amountOut: "260000", confirmed: true }, fee: "2000", steps: [], inputs: [present[0]] };
      },
      network: () => "mainnet",
      apiUrl: () => "https://api.trestly.io/api/v1",
      storage: { getItem: (k) => holds.get(k) ?? null, setItem: (k, v) => holds.set(k, v), removeItem: (k) => holds.delete(k) },
      outpointsOf: async () => [...present],
      secretFor: () => { log.push("key"); return sk; },
      noteSpentOutpoints: (keys) => log.push(`spent:${keys.length}`),
      ...extra,
    });
    return { trade, log };
  }

  setReservedOutpoints([present[1]]);
  {
    const { trade, log } = makeTrade();
    await r.throws(() => trade.run({ method: "kusdt_swap", params, target, ask: async () => true }),
      (e) => e.message === TR.TRADE_MESSAGES.coinsReserved, "#31 a swap from an address with a scheduled post's coin is refused");
    r.eq(log.join(","), "", "#31 refused before Trestly's prepare, no key");
  }
  setReservedOutpoints([]);
  noteSpentOutpoints([present[0]]);
  {
    const { trade, log } = makeTrade();
    await r.throws(() => trade.run({ method: "kusdt_swap", params, target, ask: async () => true }),
      (e) => e.message === TR.TRADE_MESSAGES.coinsHeld, "#31 a swap while a send's coin is in flight is refused");
    r.eq(log.join(","), "", "#31 held: nothing prepared or signed");
  }
  clearJustSpentOutpoints();
  {
    // A post scheduled while the approval sheet was up: refused at Approve, before the key.
    const { trade, log } = makeTrade();
    await r.throws(() => trade.run({ method: "kusdt_swap", params, target, ask: async () => { setReservedOutpoints([present[0]]); return true; } }),
      (e) => e.message === TR.TRADE_MESSAGES.coinsReserved, "#31 coins reserved during the sheet: refused at Approve");
    r.check(!log.includes("key") && !log.includes("execute"), "#31 refused at Approve before any key");
    setReservedOutpoints([]);
  }
  {
    // The trade waits for a send already running from that address (the real send queue).
    const { trade, log } = makeTrade();
    let finishSend = () => {};
    const send = enqueueSend(address, () => new Promise((resolve) => { finishSend = resolve; }));
    const running = trade.run({ method: "kusdt_swap", params, target, ask: async () => true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    r.check(!log.includes("execute"), "#31 the trade waits in the address's send queue");
    finishSend();
    await send;
    const done = await running;
    r.eq(done?.result?.txid, "d".repeat(64), "#31 after the send, the trade goes");
    r.check(log.indexOf("spent:1") > log.indexOf("execute"), "#31 the trade's coins are held");
    // and a send queued behind the trade starts only after it
    const order = [];
    const { trade: t2 } = makeTrade({ walletCall: async (fn) => {
      if (fn === "prepare") return { kind: "swap", side: "buy", amountIn: params.amountIn, minOut: params.minOut, quote: "260000", feerate: 1, acceptedFee: null };
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("trade");
      return { result: { txid: "e".repeat(64), amountOut: "260000" }, steps: [], inputs: [] };
    } });
    const tradeRun = t2.run({ method: "kusdt_swap", params, target, ask: async () => {
      // the send is queued after the trade has been approved
      setTimeout(() => { enqueueSend(address, async () => { order.push("send"); }); }, 5);
      return true;
    } });
    await tradeRun;
    await new Promise((resolve) => setTimeout(resolve, 30));
    r.eq(order.join(","), "trade,send", "#31 a send queued during the trade waits for it");
  }
  r.check(/coinsInUseReason/.test(read("engine", "kusdt-trade.js")) && /enqueueSend/.test(read("engine", "kusdt-trade.js")), "#31 the trade defaults to K's checks and queue");

  // MARK: #32 The tip sheet holds the fee its card showed
  const tipStart = app.indexOf("async function sendTipNow(");
  const tipEnd = app.indexOf("tipModal?.querySelectorAll(\"[data-close-tip]\")", tipStart);
  const tipSend = app.slice(tipStart, tipEnd);
  r.check(/const expectedFeeSompi = max \? null : tipTotalFeeSompi\(\);/.test(tipSend), "#32 the shown total fee is taken, none at Max");
  r.check(/changeAddress: tipFresh\?\.address \|\| null,\s*expectedFeeSompi,/.test(tipSend), "#32 from a spending address the fee is held");
  r.check(/payload, exactAmount: true, extraFeeSompi, manualUtxos: manualKeys, expectedFeeSompi \}/.test(tipSend), "#32 a tip with a payload holds the fee");
  r.check(/\{ extraFeeSompi, manualUtxos: manualKeys, expectedFeeSompi \}\);/.test(tipSend), "#32 a plain tip holds the fee");
  const feeChanged = tipSend.slice(tipSend.indexOf("error?.code === SEND_FEE_CHANGED"));
  r.check(/filter\(\(entry\) => entry\.id !== message\.id\)/.test(feeChanged.slice(0, 600)) && /tipScheduleFee\(\)/.test(feeChanged.slice(0, 900)), "#32 SEND_FEE_CHANGED: no failed bubble, the fee is worked out again");
}

await main();
console.log(`money audit 2026-11-25: ${r.pass} checks passed, ${r.fail} failed`);
if (r.fail) {
  for (const failure of r.failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
