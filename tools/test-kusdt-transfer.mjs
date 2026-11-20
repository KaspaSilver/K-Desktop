// kUSDT sends and Combine Coins (engine/kusdt-transfer.js), built and signed by Trestly's own
// WebAssembly (kusdt/) with made-up coins and test keys, never broadcast: coin selection and
// mergeFirst, the funding loop and the shortfall, every post-build check against a tampered build,
// the "Not confirmed" conflict rule, the stale review, Try Again, and what a send notes. When the
// Kaspa WASM SDK loads in Node, the SDK's id of each built transaction is checked too. Run from the
// repo root:
//
//   node tools/test-kusdt-transfer.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const K = await import("../engine/kusdt.js");
const CORE = await import("../engine/kusdt-core.js");
const T = await import("../engine/kusdt-transfer.js");
const S = await import("../engine/kusdt-store.js");
const C = await import("../engine/kachat-names/codec.js");
const TX = await import("../engine/kachat-names/transaction.js");
const { SEND_OUTCOME_UNKNOWN, clearJustSpentOutpoints, noteSpentOutpoints } = await import("../engine/transactions.js");

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (error) { failures.push(`${name}: ${error?.stack || error}`); }
}

const core = CORE.createKusdtCore({ fetchWasm: async () => readFileSync(join(repo, "kusdt/kusdt_wasm_bg.wasm")), workerFactory: () => null });
let kaspa = null;
try {
  const mod = await import("../kaspa/kaspa.js");
  await mod.default({ module_or_path: readFileSync(join(repo, "kaspa/kaspa_bg.wasm")) });
  kaspa = mod;
} catch { kaspa = null; }
const { rpcTransaction } = await import("../engine/kachat-names/service.js");

const net = "testnet-10";
const dep = K.kusdtDeployment(net);
const tmpl = K.kusdtTemplate();
const skA = "01".repeat(32);
const keyA = schnorr.getPublicKey(C.unhex(skA));
const keyB = schnorr.getPublicKey(C.unhex("02".repeat(32)));
const addrA = K.addressOfOwner(keyA, net);
const addrB = K.addressOfOwner(keyB, net);
const txid = (n) => n.toString(16).padStart(2, "0").repeat(32);
const coin = (n, units, { index = 0, kas = 150_000_000n } = {}) => ({ transactionId: txid(n), index, state: K.plainState(keyA, units), kasSompi: kas, blockDaaScore: 100n });
const kasUtxo = (n, amount, { index = 0, owner = keyA, covenantId = null, isCoinbase = false, scriptVersion = 0 } = {}) => ({
  outpoint: { transactionId: txid(n), index }, amount: BigInt(amount), scriptPublicKey: C.hex(C.p2pkScript(owner)), scriptVersion,
  blockDaaScore: 5n, isCoinbase, covenantId,
});
const from = { address: addrA, holdingId: "chatting", label: "Chatting Address" };
const noHolds = { isHeld: () => false, excludeReserved: (u) => u };
const base = (extra = {}) => ({ from, secretKey: skA, network: net, runCore: core.runCore, ...noHolds, ...extra });
const key = (c) => `${c.transactionId}:${c.index}`;

function recordingCore({ refuse = () => null, rewrite = (a) => a } = {}) {
  const requests = [];
  const run = async (command, request) => {
    requests.push(request);
    const why = refuse(request, requests.length);
    if (why) throw new CORE.KusdtCoreError("refused", why);
    return rewrite(await core.runCore(command, request), requests.length);
  };
  run.requests = requests;
  return run;
}

// MARK: coin selection

await check("largest first, at most 3, never a held coin", () => {
  const coins = [coin(1, 1n), coin(2, 5n), coin(3, 3n), coin(4, 0n), coin(5, 4n)];
  const { picked, sum } = T.pickTokenCoins({ coins, amount: 8n });
  assert.deepEqual(picked.map((c) => c.state.amount), [5n, 4n]);
  assert.equal(sum, 9n);
  const held = T.pickTokenCoins({ coins, amount: 7n, isHeld: (k) => k === key(coins[1]) });
  assert.deepEqual(held.picked.map((c) => c.state.amount), [4n, 3n], "the held 5 is skipped");
  assert.throws(() => T.pickTokenCoins({ coins, amount: 13n }), (e) => e.code === "mergeFirst" && e.message === T.TRANSFER_MESSAGES.mergeFirst, "13 needs 4 coins");
  assert.throws(() => T.pickTokenCoins({ coins, amount: 14n }), (e) => e.code === "notEnoughToken");
  assert.throws(() => T.pickTokenCoins({ coins, amount: 12n, isHeld: (k) => k === key(coins[1]) }), (e) => e.code === "mergeFirst" || e.code === "notEnoughToken");
});

await check("a 'Not confirmed' send's coin goes first, so the two sends conflict", () => {
  const coins = [coin(1, 1n), coin(2, 50n), coin(3, 30n)];
  const r = T.pickTokenCoins({ coins, amount: 10n, unconfirmed: new Set([key(coins[0])]) });
  assert.equal(r.picked[0], coins[0], "the small unconfirmed coin is spent though a large one would do");
  assert.equal(r.picked.length, 2);
});

await check("Combine Coins: the largest 3, an unconfirmed coin first, nothing with one coin", () => {
  const coins = [coin(1, 1n), coin(2, 5n), coin(3, 3n), coin(4, 4n)];
  assert.deepEqual(T.pickCombineCoins({ coins }).map((c) => c.state.amount), [5n, 4n, 3n]);
  assert.deepEqual(T.pickCombineCoins({ coins, unconfirmed: new Set([key(coins[0])]) }).map((c) => c.state.amount), [1n, 5n, 4n]);
  assert.throws(() => T.pickCombineCoins({ coins: [coin(1, 1n), coin(2, 0n)] }), (e) => e.code === "nothingToCombine");
});

// MARK: funding

await check("funding: plain Schnorr coins of this key only; a 'Not confirmed' coin first, then largest", () => {
  const utxos = [
    kasUtxo(1, 100n), kasUtxo(2, 900n), kasUtxo(3, 500n),
    kasUtxo(4, 9_999n, { owner: keyB }),            // another key's script
    kasUtxo(5, 9_999n, { covenantId: dep.covenantId }), // a covenant coin
    kasUtxo(6, 9_999n, { isCoinbase: true }),
    kasUtxo(7, 9_999n, { scriptVersion: 1 }),
    kasUtxo(8, 9_999n),                              // held by a send
    kasUtxo(9, 9_999n),                              // reserved by a scheduled KaPost
  ];
  const list = T.fundingCoins(utxos, {
    owner: keyA, isHeld: (k) => k === `${txid(8)}:0`, unconfirmed: new Set([`${txid(1)}:0`, `${txid(4)}:0`]),
    excludeReserved: (us) => us.filter((u) => u.outpoint.transactionId !== txid(9)),
  });
  assert.deepEqual(list.map((u) => u.amount), [100n, 900n, 500n]);
});

await check("the shortfall: need + 0.2 KAS - what's there, at least 0.1 KAS, up to 0.01 KAS", () => {
  assert.equal(T.fundingShortfall(150_000_000n, 0n), 170_000_000n);
  assert.equal(T.fundingShortfall(150_000_000n, 165_000_000n), 10_000_000n, "at least 0.1 KAS");
  assert.equal(T.fundingShortfall(150_000_000n, 100_000_001n), 70_000_000n, "69.999999 rounds up");
  assert.equal(T.fundingShortfall(0n, 500_000_000n), 10_000_000n);
  assert.equal(T.fundingShortfall(150_000_000n, 30_000_000n), 140_000_000n);
});

// MARK: builds with the real builder

let sendBuild = null;
await check("a partial send: recipient coin, change coin, KAS back, checked and signed", async () => {
  const run = recordingCore();
  const p = await T.prepareTransfer(base({
    coins: [coin(1, 5_000_000n), coin(2, 1_000_000n)], recipient: addrB, amount: 2_000_000n,
    getUtxos: async (a) => { assert.deepEqual(a, [addrA]); return [kasUtxo(20, 500_000_000n), kasUtxo(21, 10_000n)]; },
    runCore: run,
  }));
  sendBuild = { p, request: run.requests.at(-1) };
  assert.equal(p.kind, "send");
  assert.equal(p.amount, 2_000_000n);
  assert.equal(p.kasToRecipient, 150_000_000n, "the recipient's coin carries 1.5 KAS");
  assert.equal(p.changeIndex, 1);
  assert.deepEqual(p.inputKeys, [`${txid(1)}:0`, `${txid(20)}:0`], "the 5 kUSDT coin and the largest KAS coin");
  assert.ok(p.fee > 0n && p.fee < 10_000_000n);
  assert.equal(p.kasBack, 500_000_000n - 150_000_000n - p.fee, "the rest comes back");
  assert.equal(TX.txIdHex(p.coreTx), p.txid);
  const req = run.requests[0];
  assert.equal(req.network, "testnet-10");
  assert.equal(req.inputs[0].utxo.covenantId, dep.covenantId);
  assert.equal(req.outputs.length, 2);
  assert.ok(C.bytesEqual(C.unhex(req.outputs[1].state.owner), keyA), "change to the sender");
  if (kaspa) {
    const wasmTx = rpcTransaction(kaspa, p.coreTx);
    assert.equal(String(wasmTx.id).toLowerCase(), p.txid, "the Kaspa SDK's id is the builder's");
  }
});

await check("Combine Coins: no funding, the merged coins' KAS back less the fee", async () => {
  const run = recordingCore();
  const coins = [coin(1, 5_000_000n), coin(2, 1_000_000n), coin(3, 2_000_000n), coin(4, 500_000n)];
  const p = await T.prepareCombine(base({ coins, getUtxos: async () => [kasUtxo(20, 500_000_000n)], runCore: run }));
  assert.equal(p.kind, "combine");
  assert.equal(p.amount, 8_000_000n);
  assert.equal(p.recipient, addrA);
  assert.equal(p.changeIndex, null);
  assert.equal(run.requests[0].funding.length, 0, "the coins' own KAS pays");
  assert.equal(p.spentCoins.length, 3);
  assert.equal(p.kasBack, 3n * 150_000_000n - 150_000_000n - p.fee);
  if (kaspa) assert.equal(String(rpcTransaction(kaspa, p.coreTx).id).toLowerCase(), p.txid);
});

await check("a whole send with no KAS here: the fee from the tokens' own KAS, the least that does", async () => {
  const run = recordingCore();
  const p = await T.prepareTransfer(base({ coins: [coin(1, 5_000_000n)], recipient: addrB, amount: 5_000_000n, getUtxos: async () => [], runCore: run }));
  assert.equal(p.feeFromTokenKas, true);
  assert.equal(p.fee, 2_000_000n, "0.02 KAS");
  assert.equal(p.kasToRecipient, 148_000_000n);
  assert.equal(p.kasBack, 0n);
  // the ladder: the builder refusing the smaller fees takes the next
  const ladder = recordingCore({ refuse: (req, n) => (n <= 2 ? "the fee of 1 sompi exceeds the 0 sompi left: add funding" : null) });
  const q = await T.prepareTransfer(base({ coins: [coin(1, 5_000_000n)], recipient: addrB, amount: 5_000_000n, getUtxos: async () => [], runCore: ladder }));
  assert.deepEqual(ladder.requests.map((r) => r.outputs[0].value), [148_000_000n, 145_000_000n, 140_000_000n]);
  assert.equal(q.fee, 10_000_000n);
  const never = recordingCore({ refuse: () => "the fee did not settle" });
  await assert.rejects(T.prepareTransfer(base({ coins: [coin(1, 5_000_000n)], recipient: addrB, amount: 5_000_000n, getUtxos: async () => [], runCore: never })),
    (e) => e.code === "notEnoughKas" && e.forChangeCoin === false && e.message === T.TRANSFER_MESSAGES.notEnoughKas);
  assert.equal(never.requests.length, 4, "0.02, 0.05, 0.1, 0.19 KAS, then it stops");
});

await check("not enough KAS: the shortfall, with or without the change coin", async () => {
  await assert.rejects(
    T.prepareTransfer(base({ coins: [coin(1, 5_000_000n)], recipient: addrB, amount: 1_000_000n, getUtxos: async () => [], runCore: recordingCore() })),
    (e) => e.code === "notEnoughKas" && e.short === 170_000_000n && e.forChangeCoin === true && e.message === T.TRANSFER_MESSAGES.notEnoughKasForChangeCoin,
  );
  // KAS here, but the builder still wants more and there's no more: forChangeCoin
  const short = recordingCore({ refuse: () => "inputs hold 1 sompi, outputs need 2: add funding" });
  await assert.rejects(
    T.prepareTransfer(base({ coins: [coin(1, 5_000_000n)], recipient: addrB, amount: 1_000_000n, getUtxos: async () => [kasUtxo(20, 151_000_000n)], runCore: short })),
    (e) => e.code === "notEnoughKas" && e.short === 19_000_000n && e.forChangeCoin === true,
  );
  // a whole send whose KAS here isn't enough: falls back to the tokens' own KAS, without that coin
  const fallback = recordingCore({ refuse: (req) => (req.funding.length ? "add funding" : null) });
  const p = await T.prepareTransfer(base({ coins: [coin(1, 5_000_000n)], recipient: addrB, amount: 5_000_000n, getUtxos: async () => [kasUtxo(20, 1_000n)], runCore: fallback }));
  assert.equal(p.feeFromTokenKas, true);
  assert.equal(fallback.requests.at(-1).funding.length, 0);
});

await check("the funding loop: covers need + 0.5 KAS, one more coin per 'add funding' or absorbed change over 0.05 KAS", async () => {
  const utxos = [kasUtxo(20, 100_000_000n), kasUtxo(21, 80_000_000n), kasUtxo(22, 60_000_000n), kasUtxo(23, 40_000_000n)];
  const run = recordingCore();
  await T.prepareTransfer(base({ coins: [coin(1, 5_000_000n)], recipient: addrB, amount: 1_000_000n, getUtxos: async () => utxos, runCore: run }));
  assert.equal(run.requests[0].funding.length, 3, "1 + 0.8 KAS < 2 KAS, + 0.6 covers 1.5 + 0.5");
  const more = recordingCore({ refuse: (req, n) => (n === 1 ? "the fee of 5 sompi exceeds the 4 sompi left: add funding" : null) });
  await T.prepareTransfer(base({ coins: [coin(1, 5_000_000n)], recipient: addrB, amount: 1_000_000n, getUtxos: async () => utxos, runCore: more }));
  assert.deepEqual(more.requests.map((r) => r.funding.length), [3, 4]);
  const absorbing = recordingCore({ rewrite: (a, n) => (n === 1 ? { ...a, fee: Number(T.FEERATE) * Number(a.mass.feeMass) + 5_000_001 } : a) });
  await T.prepareTransfer(base({ coins: [coin(1, 5_000_000n)], recipient: addrB, amount: 1_000_000n, getUtxos: async () => utxos, runCore: absorbing }));
  assert.deepEqual(absorbing.requests.map((r) => r.funding.length), [3, 4], "change the builder couldn't keep: one more coin");
  const other = recordingCore({ refuse: () => "a secret key does not own its token input" });
  await assert.rejects(T.prepareTransfer(base({ coins: [coin(1, 5_000_000n)], recipient: addrB, amount: 1_000_000n, getUtxos: async () => utxos, runCore: other })),
    (e) => e instanceof CORE.KusdtCoreError && e.code === "refused" && /does not own/.test(e.message));
});

await check("refused before any build: the recipient, the key, the template", async () => {
  const p2sh = K.coinAddress(K.lockingScript(K.plainState(keyB, 1n), tmpl), net);
  const args = { coins: [coin(1, 5n)], amount: 1n, getUtxos: async () => [] };
  await assert.rejects(T.prepareTransfer(base({ ...args, recipient: p2sh })), (e) => e.code === "recipient" && e.message === T.TRANSFER_MESSAGES.recipient);
  await assert.rejects(T.prepareTransfer(base({ ...args, recipient: K.addressOfOwner(keyB, "mainnet") })), (e) => e.code === "recipient", "the other network");
  const offCurve = C.unhex("ff".repeat(32));
  await assert.rejects(T.prepareTransfer(base({ ...args, recipient: K.addressOfOwner(offCurve, net) })), (e) => e.code === "recipient", "a key no one can sign for");
  await assert.rejects(T.prepareTransfer(base({ ...args, recipient: addrB, secretKey: "02".repeat(32) })), (e) => e.code === "noKey", "another address's key");
  await assert.rejects(T.prepareTransfer(base({ ...args, recipient: addrB, secretKey: "nope" })), (e) => e.code === "noKey");
  await assert.rejects(T.prepareTransfer(base({ ...args, recipient: addrB, from: { address: p2sh } })), (e) => e.code === "noKey", "a script address can't send");
  await assert.rejects(T.prepareTransfer(base({ ...args, recipient: addrB, template: null })), (e) => e.code === "templateMissing");
});

// MARK: every post-build check refuses a tampered build

await check("the post-build checks refuse every tampering", async () => {
  const run = recordingCore();
  const picked = [coin(1, 5_000_000n)];
  const funding = [kasUtxo(20, 500_000_000n)];
  await T.prepareTransfer(base({ coins: picked, recipient: addrB, amount: 2_000_000n, getUtxos: async () => funding, runCore: run }));
  const built = await core.runCore("transfer", run.requests.at(-1));
  const outputs = [
    { state: K.plainState(keyB, 2_000_000n), value: dep.tokenValue },
    { state: K.plainState(keyA, 3_000_000n), value: dep.tokenValue },
  ];
  const args = { outputs, picked, funding, senderOwner: keyA, template: tmpl, deployment: dep };
  const ok = T.checkBuilt({ built, ...args });
  assert.equal(ok.txid, built.txid);
  const clone = () => JSON.parse(JSON.stringify(built));
  const refuses = (name, mutate, code = "checkFailed", extra = {}) => {
    const b = clone();
    mutate(b);
    assert.throws(() => T.checkBuilt({ built: b, ...args, ...extra }), (e) => e.code === code, name);
  };
  const otherScript = `0000${C.hex(C.p2pkScript(keyB))}`;
  refuses("recipient amount", (b) => { b.outputs[0].token.amount += 1; });
  refuses("recipient owner", (b) => { b.outputs[0].token.owner = C.hex(keyA); });
  refuses("change owner", (b) => { b.outputs[1].token.owner = C.hex(keyB); });
  refuses("token borrow guard", (b) => { b.outputs[0].token.borrowGuard = "11".repeat(32); });
  refuses("token value", (b) => { b.outputs[0].value -= 1; });
  refuses("token script", (b) => { b.outputs[0].scriptPublicKey = otherScript; });
  refuses("token missing", (b) => { delete b.outputs[1].token; });
  refuses("fewer outputs than approved", (b) => { b.outputs = b.outputs.slice(0, 1); b.transaction.outputs = b.transaction.outputs.slice(0, 1); });
  refuses("KAS change to someone else", (b) => { b.outputs[2].scriptPublicKey = otherScript; b.transaction.outputs[2].scriptPublicKey = otherScript; });
  refuses("transaction output value differs from the checked one", (b) => { b.transaction.outputs[2].value -= 1; });
  refuses("transaction output script differs", (b) => { b.transaction.outputs[2].scriptPublicKey = otherScript; });
  refuses("transaction has an extra output", (b) => { b.transaction.outputs.push({ ...b.transaction.outputs[2] }); });
  refuses("an input spent twice", (b) => { b.transaction.inputs.push(b.transaction.inputs[1]); });
  refuses("an input that isn't this address's", (b) => { b.transaction.inputs[1].previousOutpoint.transactionId = txid(99); });
  refuses("the picked coin not spent", (b) => { b.transaction.inputs[0].previousOutpoint.index = 7; });
  refuses("covenant on the KAS change", (b) => { b.transaction.outputs[2].covenant = { authorizingInput: 0, covenantId: dep.covenantId }; });
  refuses("token output without its covenant", (b) => { b.transaction.outputs[1].covenant = null; });
  refuses("token output bound to another covenant", (b) => { b.transaction.outputs[0].covenant.covenantId = dep.poolId; });
  refuses("covenant authorized by a missing input", (b) => { b.transaction.outputs[0].covenant.authorizingInput = 9; });
  refuses("a payload added (the id changes)", (b) => { b.transaction.payload = "00"; });
  refuses("the builder's id isn't the transaction's", (b) => { b.txid = txid(98); });
  refuses("a sig op count on version 1", (b) => { b.transaction.inputs[1].sigOpCount = 1; });
  refuses("bad hex", (b) => { b.transaction.inputs[1].signatureScript = "zz"; });
  refuses("compute budget past 16 bits", (b) => { b.transaction.inputs[0].computeBudget = 70_000; });
  refuses("no txid", (b) => { delete b.txid; });
  refuses("the builder's fee over 3 KAS", (b) => { b.fee = 300_000_001; }, "feeTooHigh");
  refuses("inputs less outputs over 3 KAS", (b) => {
    const big = { ...funding[0], amount: 5_000_000_000n };
    void big;
    b.outputs[2].value = 1; b.transaction.outputs[2].value = 1;
  }, "feeTooHigh", { funding: [{ ...funding[0], amount: 5_000_000_000n }] });
  refuses("outputs worth more than the inputs", (b) => { b.outputs[2].value += 1_000_000_000; b.transaction.outputs[2].value += 1_000_000_000; }, "feeTooHigh");
  // and the untouched build passes with the fee worked out here
  assert.equal(ok.fee, 500_000_000n + 150_000_000n - 2n * 150_000_000n - BigInt(built.outputs[2].value));
});

// MARK: the conflict rule, the store and submit

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

function fakeEngine({ outcome = "sent", answerTxid = null } = {}) {
  const calls = [];
  return {
    calls,
    kaspa: kaspa ?? {},
    async submitRpcTransaction(wasmTx, opts) {
      calls.push({ wasmTx, opts });
      if (outcome === "unknown") {
        const e = new Error("This may have gone through, but the network didn't confirm it. Check your balance before sending again.");
        e.code = SEND_OUTCOME_UNKNOWN;
        e.txid = opts.expectedTxId;
        throw e;
      }
      if (outcome === "refused") throw new Error("rejected: insufficient fee");
      return answerTxid ?? opts.expectedTxId;
    },
  };
}
const sdk = kaspa ? null : (_k, tx) => ({ id: TX.txIdHex(tx) });

await check("after 'Not confirmed', the next send and combine spend that send's token and KAS coins", async () => {
  clearJustSpentOutpoints();
  const store = S.createKusdtStore({ storage: memoryStorage(), account: "kaspa:acct" });
  const coins = [coin(1, 1_000_000n), coin(2, 9_000_000n), coin(3, 8_000_000n), coin(4, 7_000_000n)];
  const utxos = [kasUtxo(20, 900_000_000n), kasUtxo(21, 300_000_000n)];
  // a first send would take the 9 kUSDT coin and the 9 KAS coin; say it took coin 1 and KAS 21
  store.rememberUnknownOutcome([key(coins[0]), `${txid(21)}:0`]);
  const run = recordingCore();
  const p = await T.prepareTransfer(base({ coins, recipient: addrB, amount: 500_000n, getUtxos: async () => utxos, runCore: run, store }));
  assert.ok(p.inputKeys.includes(key(coins[0])), "the unconfirmed send's token coin");
  assert.equal(run.requests[0].funding[0].utxo.transactionId, txid(21), "its KAS coin first, though smaller");
  const c = await T.prepareCombine(base({ coins, getUtxos: async () => utxos, runCore: recordingCore(), store }));
  assert.ok(c.inputKeys.includes(key(coins[0])), "Combine spends it too, though it isn't among the 3 largest");
});

await check("submit: held coins, the id checked, history and expected coins noted, outputs seen", async () => {
  clearJustSpentOutpoints();
  const store = S.createKusdtStore({ storage: memoryStorage(), account: "kaspa:acct" });
  const p = await T.prepareTransfer(base({ coins: [coin(1, 5_000_000n)], recipient: addrB, amount: 2_000_000n, getUtxos: async () => [kasUtxo(20, 500_000_000n)], store }));
  const engine = fakeEngine();
  const marked = [];
  const r = await T.submitPrepared(p, { engine, store, now: p.preparedAt + 1_000, markOwnTransaction: (t) => marked.push(t), toSdkTransaction: sdk });
  assert.equal(r.txid, p.txid);
  assert.deepEqual(marked, [p.txid], "its KAS change isn't 'Received KAS'");
  assert.equal(engine.calls[0].opts.expectedTxId, p.txid);
  assert.deepEqual(engine.calls[0].opts.spends, p.inputKeys, "every coin it spends is held by the engine's submit");
  assert.deepEqual(r.spentKeys, [`${txid(1)}:0`]);
  assert.equal(r.refreshAfterMs, 4_000);
  const exp = store.expectedCoins();
  assert.equal(exp.length, 1);
  assert.equal(exp[0].index, 1, "the change coin is expected");
  assert.equal(exp[0].state.amount, 3_000_000n);
  const rows = store.activity();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, `${p.txid}:chatting:sent`);
  assert.equal(rows[0].counterparty, addrB);
  assert.equal(rows[0].fee, p.fee);
  assert.ok(store.seenOutpoints().has(`${p.txid}:0`) && store.seenOutpoints().has(`${p.txid}:2`));
  // noted once: the same send noted again (a lost answer, then Try Again) adds nothing twice
  await T.submitPrepared(p, { engine, store, now: p.preparedAt + 2_000, toSdkTransaction: sdk });
  assert.equal(store.activity().length, 1);
  assert.equal(store.expectedCoins().length, 1);
});

await check("a send to another of your addresses: expected there, and both history lines", async () => {
  const store = S.createKusdtStore({ storage: memoryStorage(), account: "kaspa:acct" });
  const p = await T.prepareTransfer(base({ coins: [coin(1, 5_000_000n)], recipient: addrB, amount: 2_000_000n, getUtxos: async () => [kasUtxo(20, 500_000_000n)], store }));
  const own = { id: "s4", address: addrB, label: "Address #5" };
  const r = await T.submitPrepared(p, { engine: fakeEngine(), store, now: p.preparedAt, toSdkTransaction: sdk, ownTokenAddress: (a) => (a === addrB ? own : null) });
  assert.deepEqual(store.expectedCoins().map((e) => [e.holdingId, e.index, e.state.amount]), [["chatting", 1, 3_000_000n], ["s4", 0, 2_000_000n]]);
  const rows = store.activity();
  assert.deepEqual(rows.map((x) => x.id).sort(), [`${p.txid}:chatting:sent`, `${p.txid}:s4:received`].sort());
  assert.equal(rows.find((x) => x.kind === "sent").counterparty, "Address #5");
  assert.equal(rows.find((x) => x.kind === "received").counterparty, "Chatting Address");
  const holdings = T.adjustHoldingsAfterSend([{ holdingId: "chatting", address: addrA, units: 5_000_000n, coinCount: 1 }], p, r.ownRecipient);
  assert.deepEqual(holdings.map((h) => [h.holdingId, h.units, h.coinCount]), [["chatting", 3_000_000n, 1], ["s4", 2_000_000n, 1]]);
});

await check("Combine noted as 'combined', with the coin count", async () => {
  const store = S.createKusdtStore({ storage: memoryStorage(), account: "kaspa:acct" });
  const c = await T.prepareCombine(base({ coins: [coin(1, 1n), coin(2, 2n)], getUtxos: async () => [], store }));
  await T.submitPrepared(c, { engine: fakeEngine(), store, now: c.preparedAt, toSdkTransaction: sdk, ownTokenAddress: (a) => (a === addrA ? { id: "chatting", address: addrA, label: "Chatting Address" } : null) });
  const row = store.activity()[0];
  assert.equal(row.kind, "combined");
  assert.equal(row.counterparty, "2");
  assert.deepEqual(store.expectedCoins().map((e) => [e.index, e.state.amount]), [[0, 3n]]);
});

await check("'Not confirmed': its coins remembered, the message, Try Again resends the same transaction even when stale", async () => {
  clearJustSpentOutpoints();
  const store = S.createKusdtStore({ storage: memoryStorage(), account: "kaspa:acct" });
  const p = await T.prepareTransfer(base({ coins: [coin(1, 5_000_000n)], recipient: addrB, amount: 2_000_000n, getUtxos: async () => [kasUtxo(20, 500_000_000n)], store }));
  const lost = fakeEngine({ outcome: "unknown" });
  await assert.rejects(T.submitPrepared(p, { engine: lost, store, now: p.preparedAt, toSdkTransaction: sdk }),
    (e) => e.code === SEND_OUTCOME_UNKNOWN && e.notConfirmedMessage === T.TRANSFER_MESSAGES.notConfirmed);
  assert.deepEqual([...store.unknownOutcomeKeys()].sort(), [...p.inputKeys].sort());
  assert.equal(store.activity().length, 0, "nothing noted as sent");
  const later = p.preparedAt + 10 * 60_000;
  await assert.rejects(T.submitPrepared(p, { engine: fakeEngine(), store, now: later, toSdkTransaction: sdk }), (e) => e.code === "reviewStale", "a plain swipe on an old review isn't sent");
  const retry = fakeEngine();
  const r = await T.submitPrepared(p, { engine: retry, store, now: later, retryingUnknown: true, toSdkTransaction: sdk });
  assert.equal(r.txid, p.txid, "the same transaction");
  assert.equal(retry.calls.length, 1);
});

await check("the 2-minute review, the outcome after a rebuild, and the build generation", async () => {
  const p = { preparedAt: 1_000, fee: 4_000_000n };
  assert.equal(T.isReviewStale(p, 1_000 + 120_000), false);
  assert.equal(T.isReviewStale(p, 1_000 + 120_001), true);
  assert.deepEqual(T.staleReviewOutcome(p, { fee: 5_000_000n }), { code: "feeChanged", feeSompi: 5_000_000n });
  assert.equal(T.staleReviewOutcome(p, { fee: 4_000_000n }).message, T.TRANSFER_MESSAGES.reviewStale);
  assert.equal(T.staleReviewOutcome(p, null).message, T.TRANSFER_MESSAGES.cantBuild);
  const gate = T.createPrepareGate();
  const k = { from: addrA, recipient: addrB, amount: 5n };
  const first = gate.begin(k);
  assert.equal(first.isCurrent(), true);
  const second = gate.begin(k);
  assert.equal(first.isCurrent(), false, "a newer build replaces it");
  assert.equal(second.isCurrent({ ...k, amount: 6n }), false, "the amount changed meanwhile");
  gate.invalidate();
  assert.equal(second.isCurrent(), false, "Back");
});

await check("submit refuses an SDK conversion with another id, and an answer with another id", async () => {
  const store = S.createKusdtStore({ storage: memoryStorage(), account: "kaspa:acct" });
  const p = await T.prepareTransfer(base({ coins: [coin(1, 5_000_000n)], recipient: addrB, amount: 2_000_000n, getUtxos: async () => [kasUtxo(20, 500_000_000n)], store }));
  const engine = fakeEngine();
  await assert.rejects(T.submitPrepared(p, { engine, store, now: p.preparedAt, toSdkTransaction: () => ({ id: txid(5) }) }), (e) => e.code === "checkFailed");
  assert.equal(engine.calls.length, 0, "nothing left the app");
  const tampered = { ...p, coreTx: { ...p.coreTx, payload: Uint8Array.of(1) } };
  await assert.rejects(T.submitPrepared(tampered, { engine, store, now: p.preparedAt, toSdkTransaction: sdk }), (e) => e.code === "checkFailed");
  assert.equal(engine.calls.length, 0);
  await assert.rejects(T.submitPrepared(p, { engine: fakeEngine({ answerTxid: txid(6) }), store, now: p.preparedAt, toSdkTransaction: sdk }), (e) => e.code === "submitMismatch");
  const refused = fakeEngine({ outcome: "refused" });
  await assert.rejects(T.submitPrepared(p, { engine: refused, store, now: p.preparedAt, toSdkTransaction: sdk }), /insufficient fee/);
  assert.equal(store.unknownOutcomeKeys().size, 0, "a refusal isn't 'Not confirmed'");
});

await check("coins a send from here is holding are never picked (the engine's holds)", async () => {
  clearJustSpentOutpoints();
  noteSpentOutpoints([`${txid(2)}:0`, `${txid(20)}:0`]);
  const run = recordingCore();
  const p = await T.prepareTransfer({
    from, secretKey: skA, network: net, runCore: run, excludeReserved: (u) => u,
    coins: [coin(1, 1_000_000n), coin(2, 9_000_000n)], recipient: addrB, amount: 500_000n,
    getUtxos: async () => [kasUtxo(20, 900_000_000n), kasUtxo(21, 300_000_000n)],
  });
  assert.deepEqual(p.inputKeys, [`${txid(1)}:0`, `${txid(21)}:0`]);
  clearJustSpentOutpoints();
});

if (failures.length) for (const f of failures) console.log(`FAIL ${f}`);
console.log(`kusdt transfer: ${passed} checks passed, ${failures.length} failed; Kaspa SDK id check ${kaspa ? "ran" : "skipped (the Kaspa WASM didn't load in Node)"}`);
process.exit(failures.length ? 1 : 0);
