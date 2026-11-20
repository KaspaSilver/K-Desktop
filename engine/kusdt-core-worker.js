// Trestly's kUSDT transaction builders (kusdt-open b70707c, bridge/packages/core/pkg-web), off the
// main thread: engine/kusdt-core.js starts this with `new Worker(new URL(...), { type: "module" })`,
// which Vite bundles as its own same-origin asset (CSP worker-src 'self'), the way
// engine/chess-bot-worker.js is. iOS runs the same WebAssembly in a hidden WKWebView
// (KaPay KusdtCore.swift, kusdt-core.html).
//
// Messages:
//   in  { type: "init", wasm: ArrayBuffer }  the .wasm bytes, already checked against the pinned
//                                             SHA-256 by kusdt-core.js and transferred here, so
//                                             what compiles is exactly what was checked
//   out { type: "ready", version } | { type: "failed", error }
//   in  { type: "run", id, command, request }  request: the JSON text
//   out { type: "answer", id, answer } | { type: "error", id, error }
//
// The loader (kusdt/kusdt_wasm.js) is patched never to fetch a .wasm of its own and never to eval
// (kusdt/VERSION). Nothing here talks to the network.

import init, { run, version } from "../kusdt/kusdt_wasm.js";

let ready = false;

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type === "init") {
    try {
      if (ready) { self.postMessage({ type: "ready", version: version() }); return; }
      const module = await WebAssembly.compile(message.wasm);
      await init({ module_or_path: module });
      ready = true;
      self.postMessage({ type: "ready", version: version() });
    } catch (error) {
      self.postMessage({ type: "failed", error: String(error?.message || error) });
    }
    return;
  }
  if (message.type === "run") {
    const { id } = message;
    if (!ready) { self.postMessage({ type: "error", id, error: "not started" }); return; }
    try {
      self.postMessage({ type: "answer", id, answer: run(String(message.command), String(message.request)) });
    } catch (error) {
      self.postMessage({ type: "error", id, error: String(error?.message || error) });
    }
  }
};
