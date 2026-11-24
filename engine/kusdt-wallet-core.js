// Trestly's pool code, started lazily in its own worker (engine/kusdt-wallet-worker.js), as K iOS's
// KusdtCore.wallet (K 518fdc8c). The same WebAssembly bytes as the kUSDT send builder, checked
// against the pinned SHA-256 before anything compiles (engine/kusdt-core.js createKusdtCore); a
// second instance, so a send's builder never shares a worker with code that reaches the network.
//
// `walletCall("prepare" | "execute", request)` answers their object as is (`error`, `code`,
// `maybeSent` included). Time limits as iOS: prepare 90 s, execute 240 s; a call that doesn't
// answer in time stops the worker (a fresh one starts on the next call), and for `execute` that
// is "it may have gone out" (KusdtCoreError code "maybeSent").
//
// Never on the page: a browser without module workers can't trade kUSDT here (their code
// replaces `fetch` on the scope it runs in).

import { createKusdtCore, CALL_TIMEOUT_MS, CORE_MESSAGES, KusdtCoreError } from "./kusdt-core.js";

export const WALLET_MESSAGES = Object.freeze({
  noAnswer: "Trestly's pool code gave no answer.",
  cantStart: "Trestly's pool code couldn't start in K.",
});

function defaultWalletWorker() {
  if (typeof Worker !== "function") return null;
  return new Worker(new URL("./kusdt-wallet-worker.js", import.meta.url), { type: "module" });
}

/** Options as createKusdtCore's, plus `workerFactory` (default: the wallet worker). */
export function createKusdtWalletCore({ workerFactory = defaultWalletWorker, log = () => {}, ...rest } = {}) {
  const core = createKusdtCore({
    ...rest,
    workerFactory,
    // never on the page's own thread: their code would replace the page's fetch
    loadLoader: async () => { throw new Error("Trestly's pool code runs only in a worker"); },
    log,
  });

  async function walletCall(fn, request) {
    if (fn !== "prepare" && fn !== "execute") throw new KusdtCoreError("unavailable", "bad call");
    try {
      return await core.callRaw(fn, request, { timeoutMs: CALL_TIMEOUT_MS[fn] });
    } catch (error) {
      // From here on `execute` holds the key: no answer (time ran out, the worker died) may mean
      // the trade went out anyway (iOS KusdtCore.CoreError.maybeSent).
      if (fn === "execute") throw new KusdtCoreError("maybeSent", WALLET_MESSAGES.noAnswer);
      if (error?.message === CORE_MESSAGES.noAnswer) throw new KusdtCoreError("unavailable", WALLET_MESSAGES.noAnswer);
      if (error instanceof KusdtCoreError && error.message !== CORE_MESSAGES.cantStart) throw error;
      throw new KusdtCoreError("unavailable", WALLET_MESSAGES.cantStart);
    }
  }

  return { walletCall, reset: () => core.reset(), get mode() { return core.mode; } };
}

let shared = null;
/** The app's pool code (lazy, shared). */
export function kusdtWalletCore() {
  if (!shared) shared = createKusdtWalletCore({ log: (line) => { try { console.info(line); } catch { /* no console */ } } });
  return shared;
}
