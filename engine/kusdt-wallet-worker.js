// Trestly's pool code (kusdt/kusdt-wallet.js, pinned in kusdt/SHA256SUMS) for Swap's kUSDT trades,
// in a module worker of its own: K iOS runs it in the hidden KusdtCore web view beside the builder
// (KusdtCore.wallet). Started by engine/kusdt-wallet-core.js through engine/kusdt-core.js's
// createKusdtCore, so it speaks the builder worker's protocol:
//   in  { type: "init", wasm: ArrayBuffer }   the .wasm bytes, checked against the pinned SHA-256
//   out { type: "ready", version } | { type: "failed", error }
//   in  { type: "run", id, command: "prepare"|"execute", request }   request: the JSON text
//   out { type: "answer", id, answer } | { type: "error", id, error }
// Their answer is JSON text, carrying `error` (maybe `code`, `maybeSent`) when they refused.
//
// Never on the page: their code replaces `fetch` and `chrome` on the scope it runs in. Here those
// go through engine/kusdt-wallet-bridge.js's allow-lists, installed first (import order matters).
// A key comes in only with an `execute` request, for that call.

import { bridge } from "./kusdt-wallet-install.js";
import "../kusdt/kusdt-wallet.js";
import init, { version } from "../kusdt/kusdt_wasm.js";
import { apiHostOf } from "./kusdt-wallet-bridge.js";

let ready = false;

/** The Trestly API host of this request's wallet: the only API host their `fetch` may reach. */
function allowApiOf(requestText) {
  try {
    const host = apiHostOf(JSON.parse(requestText)?.wallet?.apiUrl);
    bridge.setApiHosts(host ? [host] : []);
  } catch {
    bridge.setApiHosts([]);
  }
}

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type === "init") {
    try {
      if (!ready) {
        const module = await WebAssembly.compile(message.wasm);
        await init({ module_or_path: module });
        ready = true;
      }
      if (!globalThis.kapayWallet) throw new Error("Trestly's pool code didn't load");
      self.postMessage({ type: "ready", version: version() });
    } catch (error) {
      self.postMessage({ type: "failed", error: String(error?.message || error) });
    }
    return;
  }
  if (message.type === "run") {
    const { id } = message;
    const fn = String(message.command);
    if (!ready || (fn !== "prepare" && fn !== "execute")) { self.postMessage({ type: "error", id, error: "bad call" }); return; }
    try {
      const text = String(message.request);
      allowApiOf(text);
      const answer = await globalThis.kapayWallet[fn](text);
      self.postMessage({ type: "answer", id, answer: String(answer) });
    } catch (error) {
      self.postMessage({ type: "error", id, error: String(error?.message || error) });
    }
  }
};
