// kUSDT's pure parts (engine/kusdt.js), the builder loader (engine/kusdt-core.js) and the
// per-account store (engine/kusdt-store.js), checked against Trestly's own WebAssembly where it
// can answer: the template, the 112-byte state and its locking script (`template`, `script`,
// `layout`). No network, no node. Run from the repo root:
//
//   node tools/test-kusdt-engine.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Worker as NodeWorker } from "node:worker_threads";
import { schnorr } from "@noble/curves/secp256k1.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const K = await import("../engine/kusdt.js");
const CORE = await import("../engine/kusdt-core.js");
const S = await import("../engine/kusdt-store.js");
const C = await import("../engine/kachat-names/codec.js");

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (error) { failures.push(`${name}: ${error?.stack || error}`); }
}

const wasmBytes = readFileSync(join(repo, "kusdt/kusdt_wasm_bg.wasm"));
const core = CORE.createKusdtCore({ fetchWasm: async () => wasmBytes, workerFactory: () => null });
const net = "testnet-10";
const keyA = schnorr.getPublicKey(C.unhex("01".repeat(32)));
const keyB = schnorr.getPublicKey(C.unhex("02".repeat(32)));

// MARK: template and state against the WASM

await check("pinned template loads and matches the WASM's own", async () => {
  const t = K.kusdtTemplate();
  assert.ok(t, "template");
  const w = await core.runCore("template", {});
  assert.equal(C.hex(t.templateHash), w.templateHash);
  assert.equal(C.hex(t.prefix), w.prefix);
  assert.equal(C.hex(t.suffix), w.suffix);
  assert.equal(t.prefix.length, 34);
  const layout = await core.runCore("layout", {});
  assert.equal(layout.contracts.KCC20.templateHash, w.templateHash, "layout's KCC20 is the same contract");
});

await check("a template that isn't the pinned one is refused", () => {
  const json = JSON.parse(readFileSync(join(repo, "kusdt/kusdt-kcc20-template.json"), "utf8"));
  assert.ok(K.loadTemplate(json));
  const flip = (s, i) => s.slice(0, i) + (s[i] === "0" ? "1" : "0") + s.slice(i + 1);
  assert.equal(K.loadTemplate({ ...json, suffix: flip(json.suffix, 100) }), null, "suffix changed");
  assert.equal(K.loadTemplate({ ...json, prefix: flip(json.prefix, 10) }), null, "prefix changed");
  assert.equal(K.loadTemplate({ ...json, templateHash: "00".repeat(32) }), null, "hash not at the prefix's end");
  assert.equal(K.loadTemplate({ ...json, suffix: "zz" }), null, "bad hex");
  assert.equal(K.loadTemplate(null), null);
});

await check("state encoding round-trips and its script is the WASM's", async () => {
  const t = K.kusdtTemplate();
  const states = [
    K.plainState(keyA, 0n),
    K.plainState(keyB, 12_500_000n),
    K.plainState(keyA, (1n << 63n) - 1n),
    K.makeState({ amount: 77n, owner: keyB, ownerScheme: K.OWNER_P2SH, borrowScheme: 1, borrowGuard: new Uint8Array(32).fill(7), extensionCommitment: new Uint8Array(32).fill(9) }),
  ];
  for (const s of states) {
    const bytes = K.encodeState(s);
    assert.equal(bytes.length, 112);
    assert.ok(K.sameState(K.decodeState(bytes), s), "decode(encode(s)) = s");
    const w = await core.runCore("script", { actor: "KCC20", state: K.stateToJson(s) });
    assert.equal(w.scriptPublicKey, K.spkHex(K.lockingScript(s, t)), `script of amount ${s.amount}`);
  }
  assert.equal(K.decodeState(new Uint8Array(111)), null);
  const bad = K.encodeState(states[1]); bad[9] = 0x21;
  assert.equal(K.decodeState(bad), null, "a wrong push length");
  const big = K.encodeState(states[1]); big[8] = 0x80;
  assert.equal(K.decodeState(big), null, "an amount at or above 2^63");
});

await check("coin addresses are P2SH on the network's prefix", () => {
  const s = K.plainState(keyA, 1n);
  const script = K.lockingScript(s, K.kusdtTemplate());
  assert.ok(K.coinAddress(script, "mainnet").startsWith("kaspa:p"));
  assert.ok(K.coinAddress(script, net).startsWith("kaspatest:p"));
});

// MARK: owners and addresses

await check("only Schnorr key addresses of the network hold kUSDT", () => {
  const a = K.addressOfOwner(keyA, net);
  assert.ok(C.bytesEqual(K.schnorrOwner(a, net), keyA));
  assert.ok(K.canHoldKusdt(a, net));
  assert.equal(K.schnorrOwner(a, "mainnet"), null, "the other network's address");
  assert.equal(K.schnorrOwner(a.toUpperCase(), net) != null, true, "upper case reads");
  const p2sh = K.coinAddress(K.lockingScript(K.plainState(keyA, 1n), K.kusdtTemplate()), net);
  assert.equal(K.schnorrOwner(p2sh, net), null, "a script (P2SH / quantum-safe) address");
  assert.equal(K.schnorrOwner("kaspatest:qqqq", net), null, "garbage");
  assert.equal(K.schnorrOwner("", net), null);
});

await check("an x-only key off the curve is caught", () => {
  assert.ok(K.isOnCurveXOnly(keyA));
  assert.equal(K.isOnCurveXOnly(new Uint8Array(32)), false);
  assert.equal(K.isOnCurveXOnly(new Uint8Array(32).fill(0xff)), false);
});

await check("plain-coin test", () => {
  const plain = K.plainState(keyA, 5n);
  assert.ok(K.isPlainStateOf(plain, keyA));
  assert.equal(K.isPlainStateOf(plain, keyB), false, "another key's");
  assert.equal(K.isPlainStateOf({ ...plain, ownerScheme: K.OWNER_P2SH }, keyA), false, "a script owner");
  assert.equal(K.isPlainStateOf({ ...plain, borrowScheme: 1 }, keyA), false, "borrowing on");
  assert.equal(K.isPlainStateOf({ ...plain, borrowGuard: new Uint8Array(32).fill(1) }, keyA), false, "a borrow guard");
  assert.equal(K.isPlainStateOf({ ...plain, extensionCommitment: new Uint8Array(32).fill(1) }, keyA), false, "an extension");
  assert.equal(K.isPlainStateOf(null, keyA), false);
});

await check("API states parse as iOS reads them", () => {
  const owner = C.hex(keyA);
  assert.equal(K.stateFromJson({ amount: 5, owner, ownerScheme: 0 }).amount, 5n, "defaults for the rest");
  assert.equal(K.stateFromJson({ amount: "18446744073709551615", owner, ownerScheme: 0 }), null, "over 2^63");
  assert.equal(K.stateFromJson({ amount: "9223372036854775807", owner, ownerScheme: 0 }).amount, (1n << 63n) - 1n);
  assert.equal(K.stateFromJson({ amount: -1, owner, ownerScheme: 0 }), null, "negative");
  assert.equal(K.stateFromJson({ amount: 1.5, owner, ownerScheme: 0 }), null, "a fraction");
  assert.equal(K.stateFromJson({ amount: true, owner, ownerScheme: 0 }), null, "a Bool");
  assert.equal(K.stateFromJson({ amount: "1e3", owner, ownerScheme: 0 }), null, "not digits");
  assert.equal(K.stateFromJson({ amount: 1, owner: owner.slice(2), ownerScheme: 0 }), null, "short owner");
  assert.equal(K.stateFromJson({ amount: 1, owner, ownerScheme: 256 }), null, "scheme over a byte");
  assert.equal(K.stateFromJson({ amount: 1, owner, ownerScheme: 0, borrowScheme: 300 }), null, "borrow over a byte");
});

// MARK: amounts

await check("amount text as iOS writes and reads it", () => {
  assert.equal(K.formatKusdt(12_500_000n), "12.50 kUSDT");
  assert.equal(K.formatKusdt(1_250_000_000n), "1,250.00 kUSDT");
  assert.equal(K.plainKusdt(1n), "0.000001");
  assert.equal(K.plainKusdt(250_000n), "0.25");
  assert.equal(K.plainKusdt(125_500_000n), "125.50");
  assert.equal(K.typedKusdt(125_500_000n), "125.5");
  assert.equal(K.typedKusdt(125_000_000n), "125");
  assert.equal(K.typedKusdt(125_000_000n, { keepCents: true }), "125.00");
  assert.equal(K.kusdtDollars(125_505_000n), "$125.50", "half to even down");
  assert.equal(K.kusdtDollars(125_515_000n), "$125.52", "half to even up");
  assert.equal(K.kusdtDollars(1_234_567_890_000n), "$1,234,567.89");
  assert.equal(K.kusdtUnitsFromText("12.5"), 12_500_000n);
  assert.equal(K.kusdtUnitsFromText("1,250.25"), 1_250_250_000n);
  assert.equal(K.kusdtUnitsFromText(".5"), 500_000n);
  assert.equal(K.kusdtUnitsFromText("0.000001"), 1n);
  assert.equal(K.kusdtUnitsFromText("0.0000001"), null, "7 decimals");
  assert.equal(K.kusdtUnitsFromText("0"), null, "zero");
  assert.equal(K.kusdtUnitsFromText(""), null);
  assert.equal(K.kusdtUnitsFromText("1.2.3"), null);
  assert.equal(K.kusdtUnitsFromText("-1"), null);
  assert.equal(K.kusdtUnitsFromText("1e3"), null);
  assert.equal(K.kusdtUnitsFromText("18446744073709.551615"), (1n << 64n) - 1n, "u64 max");
  assert.equal(K.kusdtUnitsFromText("18446744073709.551616"), null, "past u64");
});

// MARK: exact JSON

await check("exact JSON both ways", () => {
  assert.equal(K.stringifyExact({ a: 18446744073709551615n, b: [1n, "x"], c: undefined, d: null }), '{"a":18446744073709551615,"b":[1,"x"],"d":null}');
  const parsed = K.parseExactJson('{"a":18446744073709551615,"b":9007199254740993,"c":12,"s":"123456789012345678","f":1.5,"e":1.2345678901234567e16}');
  assert.equal(parsed.a, "18446744073709551615");
  assert.equal(parsed.b, "9007199254740993", "above 2^53 stays exact");
  assert.equal(parsed.c, 12);
  assert.equal(parsed.s, "123456789012345678", "a string is untouched");
  assert.equal(parsed.f, 1.5);
  assert.equal(parsed.e, "12345678901234567");
  assert.equal(K.jsonU64(parsed.a), (1n << 64n) - 1n);
  assert.equal(K.jsonU64(parsed.b), 9007199254740993n);
  assert.equal(K.jsonU64(1.5), null);
  assert.equal(K.jsonU64(true), null);
  assert.equal(K.jsonU64(-1), null);
  assert.equal(K.jsonU64("18446744073709551616"), null);
});

await check("a u64 above 2^53 crosses the builder exactly", async () => {
  // the builder reads a state amount exactly and writes its script; a rounded amount would give
  // another script
  const s = K.plainState(keyA, 9_007_199_254_740_993n);
  const w = await core.runCore("script", { actor: "KCC20", state: K.stateToJson(s) });
  assert.equal(w.scriptPublicKey, K.spkHex(K.lockingScript(s, K.kusdtTemplate())));
});

// MARK: the loader

await check("the builder answers, refuses with its own words, and reports it runs here", async () => {
  await assert.rejects(core.runCore("transfer", {}), (e) => e instanceof CORE.KusdtCoreError && e.code === "refused" && /missing field/.test(e.message));
  await assert.rejects(core.runCore("no-such-command", {}), (e) => e.code === "refused");
  assert.equal(core.mode, "thread");
  assert.equal(core.version, "0.1.0");
});

await check("a .wasm that isn't the pinned one never compiles, and is tried again after 10 s", async () => {
  let t = 1_000;
  let fetches = 0;
  const tampered = Uint8Array.from(wasmBytes); tampered[tampered.length - 1] ^= 1;
  let compiled = false;
  const bad = CORE.createKusdtCore({
    fetchWasm: async () => { fetches += 1; return tampered; }, workerFactory: () => null, now: () => t,
    loadLoader: async () => { compiled = true; return import("../kusdt/kusdt_wasm.js"); },
  });
  await assert.rejects(bad.runCore("template", {}), (e) => e.code === "unavailable" && e.message === CORE.CORE_MESSAGES.notPinned);
  assert.equal(compiled, false, "nothing loaded");
  await assert.rejects(bad.runCore("template", {}), (e) => e.message === CORE.CORE_MESSAGES.notPinned);
  assert.equal(fetches, 1, "a start that just failed answers at once");
  t += 10_001;
  await assert.rejects(bad.runCore("template", {}));
  assert.equal(fetches, 2, "tried again after 10 s");
});

await check("an unreadable .wasm is 'couldn't start'", async () => {
  const bad = CORE.createKusdtCore({ fetchWasm: async () => { throw new Error("404"); }, workerFactory: () => null });
  await assert.rejects(bad.runCore("template", {}), (e) => e.code === "unavailable" && e.message === CORE.CORE_MESSAGES.cantStart);
});

await check("the patched loader never fetches a .wasm of its own and never evals", async () => {
  const src = readFileSync(join(repo, "kusdt/kusdt_wasm.js"), "utf8");
  assert.equal(/new URL\('kusdt_wasm_bg\.wasm'/.test(src), false);
  assert.match(src, /flat === "return this"/);
  const loader = await import("../kusdt/kusdt_wasm.js");
  void loader;
});

// The worker protocol, through node:worker_threads standing in for a browser module Worker.
function nodeWorkerFactory({ hang = false } = {}) {
  return () => {
    const bootstrap = `
      import { parentPort } from "node:worker_threads";
      const self = globalThis.self = globalThis;
      self.postMessage = (m) => parentPort.postMessage(m);
      parentPort.on("message", (data) => {
        if (${hang} && data.type === "run") return; // never answers
        self.onmessage?.({ data });
      });
      await import(${JSON.stringify(new URL("../engine/kusdt-core-worker.js", import.meta.url).href)});
    `;
    const w = new NodeWorker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`));
    const shim = {
      onmessage: null, onerror: null, onmessageerror: null, terminated: false,
      postMessage: (m, transfer) => w.postMessage(m, transfer),
      terminate: () => { shim.terminated = true; w.terminate(); },
    };
    w.on("message", (data) => shim.onmessage?.({ data }));
    w.on("error", (e) => shim.onerror?.({ message: e.message, preventDefault() {} }));
    workers.push(shim);
    return shim;
  };
}
const workers = [];

await check("in a worker: answers, refusals, and a call with no answer stops the worker", async () => {
  const wcore = CORE.createKusdtCore({ fetchWasm: async () => Uint8Array.from(wasmBytes), workerFactory: nodeWorkerFactory() });
  const t = await wcore.runCore("template", {});
  assert.equal(t.templateHash, C.hex(K.kusdtTemplate().templateHash));
  assert.equal(wcore.mode, "worker");
  await assert.rejects(wcore.runCore("transfer", {}), (e) => e.code === "refused");
  wcore.reset();

  const hung = CORE.createKusdtCore({ fetchWasm: async () => Uint8Array.from(wasmBytes), workerFactory: nodeWorkerFactory({ hang: true }) });
  const started = Date.now();
  await assert.rejects(hung.runCore("template", {}, { timeoutMs: 300 }), (e) => e.code === "unavailable" && e.message === CORE.CORE_MESSAGES.noAnswer);
  assert.ok(Date.now() - started < 5_000);
  const last = workers[workers.length - 1];
  assert.equal(last.terminated, true, "the worker that didn't answer was stopped");
  assert.equal(hung.mode, null, "the next call starts a fresh one");
});

// MARK: the store

function memoryStorage() {
  const m = new Map();
  return {
    map: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

await check("history: newest first, one line per id, 300 at most", () => {
  const storage = memoryStorage();
  let t = 1_000;
  const store = S.createKusdtStore({ storage, account: "kaspa:acct", now: () => t });
  for (let i = 0; i < 305; i += 1) {
    t += 1;
    store.record({ id: S.activityId(i.toString(16).padStart(64, "0"), "chatting", "sent"), kind: "sent", units: BigInt(i), counterparty: "x", fee: 1000n });
  }
  const rows = store.activity();
  assert.equal(rows.length, S.ACTIVITY_CAP);
  assert.equal(rows[0].units, 304n, "newest first");
  assert.equal(rows[rows.length - 1].units, 5n, "the oldest dropped");
  t += 1;
  store.record({ id: rows[3].id, kind: "sent", units: 999n, counterparty: "again" });
  const again = store.activity();
  assert.equal(again.length, S.ACTIVITY_CAP, "same id: replaced, not added");
  assert.equal(again[0].units, 999n);
  assert.equal(again.filter((r) => r.id === rows[3].id).length, 1);
  assert.equal(S.activityTxid(again[0]), again[0].id.split(":")[0]);
  assert.ok(store.ownTxids().has(again[0].id.split(":")[0]));
  assert.throws(() => store.record({ kind: "stolen", units: 1n }));
});

await check("seen coins: none before the first look, then exactly what's there plus what's found", () => {
  const storage = memoryStorage();
  const store = S.createKusdtStore({ storage, account: "kaspa:acct" });
  assert.equal(store.seenOutpoints(), null);
  store.rememberSeen(["a:0", "b:1"]);
  assert.deepEqual([...store.seenOutpoints()].sort(), ["a:0", "b:1"]);
  store.markOutputsSeen("c".repeat(64), 2);
  assert.ok(store.seenOutpoints().has(`${"c".repeat(64)}:1`));
  store.rememberSeen(["b:1"], ["b:1", "d:0"]);
  assert.deepEqual([...store.seenOutpoints()].sort(), ["b:1", "d:0"], "gone coins drop out");
});

await check("'Not confirmed' coins are remembered for 10 minutes, then forgotten", () => {
  const storage = memoryStorage();
  let t = 5_000;
  const store = S.createKusdtStore({ storage, account: "kaspa:acct", now: () => t });
  store.rememberUnknownOutcome(["AA:1", "bb:2"]);
  assert.deepEqual([...store.unknownOutcomeKeys()].sort(), ["aa:1", "bb:2"]);
  t += S.UNKNOWN_OUTCOME_HOLD_MS - 1;
  assert.equal(store.unknownOutcomeKeys().size, 2);
  t += 2;
  assert.equal(store.unknownOutcomeKeys().size, 0);
});

await check("expected coins survive a reload; forgetAccount clears every kUSDT key of that account only", () => {
  const storage = memoryStorage();
  const store = S.createKusdtStore({ storage, account: "kaspa:one" });
  const other = S.createKusdtStore({ storage, account: "kaspa:two" });
  store.setExpectedCoins([{ holdingId: "s3", address: "kaspa:x", transactionId: "ab".repeat(32), index: 1, state: K.plainState(keyA, 9_007_199_254_740_993n), since: 42 }]);
  const back = S.createKusdtStore({ storage, account: "kaspa:one" }).expectedCoins();
  assert.equal(back.length, 1);
  assert.equal(back[0].state.amount, 9_007_199_254_740_993n, "exact");
  assert.ok(C.bytesEqual(back[0].state.owner, keyA));
  store.record({ id: "x", kind: "received", units: 1n });
  store.rememberSeen(["a:0"]);
  store.rememberUnknownOutcome(["a:0"]);
  other.record({ id: "y", kind: "received", units: 1n });
  for (const k of ["hidden", "shown", "indices"]) storage.setItem(S.kusdtStorageKeys("kaspa:one")[k], "[]");
  S.forgetAccount(storage, "kaspa:one");
  for (const key of Object.values(S.kusdtStorageKeys("kaspa:one"))) assert.equal(storage.getItem(key), null, key);
  assert.equal(other.activity().length, 1, "another account's history stays");
});

for (const w of workers) { try { w.terminate(); } catch { /* gone */ } }

if (failures.length) {
  for (const f of failures) console.log(`FAIL ${f}`);
}
console.log(`kusdt engine: ${passed} checks passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
