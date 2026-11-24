// Trestly's own kUSDT transaction builders, run inside KaChat (port of KaPay iOS
// KaChatWallet/Services/Tokens/KusdtCore.swift, e188209 / 3d126db): a KCC-20 input's unlock script
// and compute budget come from running the token contract, which only their runtime does exactly.
// This is kusdt-open b70707c's bridge/packages/core/pkg-web, the same WebAssembly their wallet and
// KaPay run (kusdt/VERSION).
//
// How it's kept safe (as iOS):
// - The .wasm ships in the app (kusdt/) and its bytes are checked against KUSDT_WASM_SHA256 (the
//   one in kusdt-open's PROVENANCE.json and KaPay's pin) with crypto.subtle BEFORE anything
//   compiles; a mismatch refuses ("isn't the pinned one, so it won't run"). The loader
//   (kusdt/kusdt_wasm.js) is bundled by Vite, so its pin is the build-time one: kusdt/SHA256SUMS,
//   checked by tools/check-wasm.sh before every dev/build. Patched not to eval (the page's CSP has
//   no 'unsafe-eval') and never to fetch a .wasm of its own.
// - Loaded lazily, on the first kUSDT call, never at app start (7.9 MB).
// - It runs in a module Worker (engine/kusdt-core-worker.js): the builder never blocks the page,
//   and a call that doesn't answer in time is really stopped (the worker is terminated and a fresh
//   one starts on the next call). Where no Worker exists (Node tests, a browser without module
//   workers) it runs on the calling thread instead; then the timeout can't interrupt a running
//   call (WebAssembly is synchronous), but nothing is lost: the answer is waited for.
// - Requests carry a secret key only for the address being spent from, for that call; nothing is
//   kept. Nothing in the builder talks to the network.
//
// iOS limits (audit, 2026-11-20): the page may take 25 s to come up; one `run` 30 s (prepare 90 s
// and execute 240 s are Trestly's pool wallet calls, kept for the swap port). A start that failed
// is tried again after 10 s, so one failure doesn't turn kUSDT off for the session.

import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { parseExactJson, stringifyExact } from "./kusdt.js";

/** SHA-256 of kusdt/kusdt_wasm_bg.wasm (kusdt-open b70707c PROVENANCE.json `wasm`, KaPay
 *  `KusdtCore.pinned`). */
export const KUSDT_WASM_SHA256 = "a7be48e962dab57902924ea71fbad31b073cd2ba2197ebcf0de83b0f2a54fd53";

export const START_TIMEOUT_MS = 25_000;
export const CALL_TIMEOUT_MS = Object.freeze({ run: 30_000, prepare: 90_000, execute: 240_000 });
export const RETRY_AFTER_FAILURE_MS = 10_000;

/** iOS texts (KusdtCore.swift). */
export const CORE_MESSAGES = Object.freeze({
  noAnswer: "kUSDT's transaction builder gave no answer.",
  cantStart: "kUSDT's transaction builder couldn't start.",
  notPinned: "kUSDT's transaction builder isn't the pinned one, so it won't run.",
});

/** iOS `KusdtCore.CoreError`: `code` "unavailable" (the builder isn't there or didn't answer) or
 *  "refused" (it answered `{"error": …}`; the message is the builder's own words). */
export class KusdtCoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "KusdtCoreError";
    this.code = code;
  }
}

const unavailable = (message) => new KusdtCoreError("unavailable", message);

/** Lowercase hex SHA-256 of bytes: Web Crypto (async, off the main thread), or @noble/hashes where
 *  the page has no crypto.subtle (a plain-http LAN install is not a secure context). */
export async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  const digest = subtle ? new Uint8Array(await subtle.digest("SHA-256", bytes)) : nobleSha256(bytes);
  let out = "";
  for (const b of digest) out += (b < 16 ? "0" : "") + b.toString(16);
  return out;
}

/** The .wasm's URL, resolved against this module (whatever path the app is served under), as
 *  engine/wasm-loader.js does for the Kaspa SDK. Vite copies it to /assets with a content hash. */
function defaultWasmUrl() {
  return new URL("../kusdt/kusdt_wasm_bg.wasm", import.meta.url);
}

async function defaultFetchWasm() {
  const url = defaultWasmUrl();
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error(`Could not fetch the kUSDT WASM (HTTP ${response.status}) from ${url.pathname}`);
  return response.arrayBuffer();
}

function defaultWorkerFactory() {
  if (typeof Worker !== "function") return null;
  return new Worker(new URL("./kusdt-core-worker.js", import.meta.url), { type: "module" });
}

async function defaultLoadLoader() {
  return import("../kusdt/kusdt_wasm.js");
}

function withTimeout(promise, ms, onTimeout) {
  if (!(ms > 0) || !Number.isFinite(ms)) return promise;
  let timer;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => { try { onTimeout?.(); } finally { reject(unavailable(CORE_MESSAGES.noAnswer)); } }, ms);
    timer?.unref?.();
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/** One builder, started lazily. Options are for tests and tools:
 *  `fetchWasm()` -> ArrayBuffer|Uint8Array (default: fetch the bundled .wasm),
 *  `workerFactory()` -> Worker|null (default: the module worker; null runs on this thread),
 *  `loadLoader()` -> the kusdt_wasm.js module (the on-thread fallback),
 *  `expectedSha256` (default KUSDT_WASM_SHA256), `startTimeoutMs`, `now()`, `log(line)`. */
export function createKusdtCore({
  fetchWasm = defaultFetchWasm,
  workerFactory = defaultWorkerFactory,
  loadLoader = defaultLoadLoader,
  expectedSha256 = KUSDT_WASM_SHA256,
  startTimeoutMs = START_TIMEOUT_MS,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  let starting = null;   // Promise<backend> while a start runs or after it succeeded
  let backend = null;    // { kind: "worker"|"thread", call(command, requestText, timeoutMs), stop(), version }
  let loadError = null;
  let loadFailedAt = 0;

  const reset = () => {
    try { backend?.stop?.(); } catch { /* already gone */ }
    backend = null;
    starting = null;
  };

  async function startWorker(worker, bytes) {
    const pending = new Map();
    let nextId = 0;
    let dead = false;
    const failAll = (message) => {
      dead = true;
      for (const p of pending.values()) p.reject(unavailable(message));
      pending.clear();
    };
    const ready = new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        const m = event.data || {};
        if (m.type === "ready") { resolve(String(m.version ?? "")); return; }
        if (m.type === "failed") { reject(new Error(m.error || "failed")); return; }
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.type === "answer") p.resolve(String(m.answer ?? ""));
        else {
          // a builder that threw (a Rust panic traps the module): this instance isn't trusted for
          // another call, so the next one starts a fresh worker
          p.reject(unavailable(CORE_MESSAGES.noAnswer));
          if (backend?.worker === worker) reset();
        }
      };
      worker.onerror = (event) => {
        event?.preventDefault?.();
        reject(new Error(event?.message || "worker error"));
        failAll(CORE_MESSAGES.cantStart);
        if (backend?.worker === worker) reset();
      };
      worker.onmessageerror = () => { failAll(CORE_MESSAGES.noAnswer); if (backend?.worker === worker) reset(); };
    });
    // transferred, not copied: the worker compiles exactly the bytes checked above
    const buffer = bytes.buffer.byteLength === bytes.byteLength ? bytes.buffer : bytes.slice().buffer;
    worker.postMessage({ type: "init", wasm: buffer }, [buffer]);
    const version = await withTimeout(ready, startTimeoutMs, () => worker.terminate?.());
    return {
      kind: "worker",
      worker,
      version,
      stop: () => { failAll(CORE_MESSAGES.noAnswer); worker.terminate?.(); },
      call(command, requestText, timeoutMs) {
        if (dead) return Promise.reject(unavailable(CORE_MESSAGES.noAnswer));
        const id = ++nextId;
        const answer = new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          try { worker.postMessage({ type: "run", id, command, request: requestText }); }
          catch (error) { pending.delete(id); reject(unavailable(CORE_MESSAGES.noAnswer)); }
        });
        // no answer in time: the worker is stopped, and the next call starts a fresh one
        return withTimeout(answer, timeoutMs, () => { pending.delete(id); if (backend?.worker === worker) reset(); });
      },
    };
  }

  async function startOnThread(bytes) {
    const loader = await loadLoader();
    const module = await WebAssembly.compile(bytes);
    await loader.default({ module_or_path: module });
    return {
      kind: "thread",
      version: String(loader.version?.() ?? ""),
      stop: () => {},
      call: async (command, requestText) => {
        try { return loader.run(command, requestText); }
        catch { reset(); throw unavailable(CORE_MESSAGES.noAnswer); }
      },
    };
  }

  async function start() {
    let raw;
    try { raw = await fetchWasm(); }
    catch (error) { log(`[kUSDT] the builder's .wasm couldn't be read: ${error?.message || error}`); throw unavailable(CORE_MESSAGES.cantStart); }
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    // checked before anything compiles: a different file never runs (iOS KusdtCore.start)
    if (await sha256Hex(bytes) !== expectedSha256) {
      log("[kUSDT] the builder's .wasm is not the pinned one: refused");
      throw unavailable(CORE_MESSAGES.notPinned);
    }
    let worker = null;
    try { worker = workerFactory?.() ?? null; } catch { worker = null; }
    if (worker) {
      try {
        const b = await startWorker(worker, bytes);
        log(`[kUSDT] builder ready in a worker (${b.version || "?"})`);
        return b;
      } catch (error) {
        try { worker.terminate?.(); } catch { /* gone */ }
        log(`[kUSDT] builder worker failed to start: ${error?.message || error}`);
        throw unavailable(CORE_MESSAGES.cantStart);
      }
    }
    try {
      const b = await withTimeout(startOnThread(bytes), startTimeoutMs);
      log(`[kUSDT] builder ready on this thread (${b.version || "?"})`);
      return b;
    } catch (error) {
      log(`[kUSDT] builder failed to start: ${error?.message || error}`);
      throw unavailable(CORE_MESSAGES.cantStart);
    }
  }

  async function load() {
    if (backend) return backend;
    if (loadError) {
      // a start that failed a while ago is tried again; one that just failed answers at once
      if (now() - loadFailedAt <= RETRY_AFTER_FAILURE_MS) throw unavailable(loadError);
      loadError = null;
    }
    if (!starting) {
      starting = start().then((b) => { backend = b; return b; }, (error) => {
        starting = null;
        loadError = error?.message || CORE_MESSAGES.cantStart;
        loadFailedAt = now();
        throw error instanceof KusdtCoreError ? error : unavailable(CORE_MESSAGES.cantStart);
      });
    }
    return starting;
  }

  /** Runs one builder command on a request (an object: BigInts are written as exact JSON
   *  integers; or a JSON string). Answers the parsed result (16+ digit integers as digit strings),
   *  or throws KusdtCoreError: "refused" with the builder's own error, "unavailable" otherwise. */
  async function runCore(command, request = {}, { timeoutMs = CALL_TIMEOUT_MS.run } = {}) {
    const b = await load();
    const text = typeof request === "string" ? request : stringifyExact(request);
    const answer = await b.call(String(command), text, timeoutMs);
    let parsed;
    try { parsed = parseExactJson(answer); } catch { parsed = null; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw unavailable(CORE_MESSAGES.noAnswer);
    if (typeof parsed.error === "string") throw new KusdtCoreError("refused", parsed.error);
    return parsed;
  }

  /** Like runCore, but answers the parsed object as it is, an `error` field included: Trestly's
   *  pool code (engine/kusdt-wallet-core.js) refuses with `{ error, code?, maybeSent? }`, which
   *  its caller reads whole. Throws KusdtCoreError "unavailable" when nothing usable came back. */
  async function callRaw(command, request = {}, { timeoutMs = CALL_TIMEOUT_MS.run } = {}) {
    const b = await load();
    const text = typeof request === "string" ? request : stringifyExact(request);
    const answer = await b.call(String(command), text, timeoutMs);
    let parsed;
    try { parsed = parseExactJson(answer); } catch { parsed = null; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw unavailable(CORE_MESSAGES.noAnswer);
    return parsed;
  }

  return {
    runCore,
    callRaw,
    /** Starts the builder now (it otherwise starts on the first call). */
    preload: () => load().then(() => true),
    /** "worker" | "thread" | null (not started). */
    get mode() { return backend?.kind ?? null; },
    get version() { return backend?.version ?? null; },
    /** Stops the builder; the next call starts it again. */
    reset,
  };
}

const shared = createKusdtCore({ log: (line) => { try { console.info(line); } catch { /* no console */ } } });

/** The app's builder (lazy, shared): see createKusdtCore().runCore. */
export function runCore(command, request, options) { return shared.runCore(command, request, options); }
export const kusdtCore = shared;
