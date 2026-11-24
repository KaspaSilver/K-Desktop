// What Trestly's pool code (kusdt/kusdt-wallet.js) reaches, inside its own worker
// (engine/kusdt-wallet-worker.js). Port of K iOS KusdtWalletRelays.swift (KusdtNetRelay,
// KusdtStoreRelay) and KusdtCore.swift's offline rules (K 518fdc8c).
//
// Their code was built for KaPay's hidden web view: its `fetch` shim posts every request to
// `webkit.messageHandlers.kusdtNet`, and its `chrome.storage.local` shim to `kusdtStore`, each
// answering a Promise. This module is those two handlers, installed on the worker's global scope
// BEFORE their code runs (engine/kusdt-wallet-install.js is imported first):
// - kusdtNet: HTTPS only, to the Trestly API host and the public Kaspa node resolvers their node
//   client asks (`<name>.kaspa.stream`, `.red`, `.green`, `.blue`, kusdt-open's NODE_HOST). Straight
//   from the worker, never through /nc-proxy. No redirects, no cookies or credentials; only
//   Content-Type and Accept go out; requests at most 64 KB, answers read up to 4 MB.
// - kusdtStore: what their code keeps between calls (coins it knows, transactions it follows), in
//   the worker's memory only, keys starting "kusdt.", 512 KB per entry and 2 MB in all. Nothing
//   secret goes in it, and it goes with the worker (an account switch stops it).
// - WebSocket: only to wss://<name>.kaspa.(stream|red|green|blue), the public node a resolver names.
//
// No DOM. The pure parts are exported for tools/test-swap-k54.mjs.

export const NODE_HOST = /^[a-z0-9-]+\.kaspa\.(stream|red|green|blue)$/;
export const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 64 * 1024;
export const NET_TIMEOUT_MS = 30_000;
export const STORE_MAX_ENTRY_BYTES = 512 * 1024;
export const STORE_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

/** The host of a Trestly API URL ("https://api.trestly.io/api/v1" -> "api.trestly.io"), or null for
 *  anything but plain https. */
export function apiHostOf(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return u.hostname.toLowerCase();
  } catch { return null; }
}

/** Whether their code may fetch `url` (iOS KusdtNetRelay.allowed). */
export function allowedFetchUrl(url, apiHosts = []) {
  let u;
  try { u = new URL(String(url || "")); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (apiHosts.map((h) => String(h || "").toLowerCase()).includes(host)) return true;
  return NODE_HOST.test(host);
}

/** Whether their node client may open a WebSocket to `url` (iOS's offline rule list). */
export function allowedSocketUrl(url) {
  let u;
  try { u = new URL(String(url || "")); } catch { return false; }
  if (u.protocol !== "wss:" || u.username || u.password) return false;
  return NODE_HOST.test(u.hostname.toLowerCase());
}

/** One request of their `fetch` shim: `{ url, method, headers, body }` -> `{ status, headers, body }`
 *  or `{ error }` (iOS KusdtNetRelay.userContentController). */
export async function relayFetch(message, { fetchImpl, apiHosts = [], timeoutMs = NET_TIMEOUT_MS } = {}) {
  const url = typeof message?.url === "string" ? message.url : "";
  if (!url || url.length > 2048) return { error: "bad request" };
  if (!allowedFetchUrl(url, apiHosts)) {
    let host = "that address";
    try { host = new URL(url).hostname || host; } catch { /* unreadable */ }
    return { error: `K doesn't let this reach ${host}.` };
  }
  const method = String(message?.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") return { error: "method not allowed" };
  const headers = {};
  for (const [key, value] of Object.entries(message?.headers || {})) {
    const k = String(key).toLowerCase();
    // only what a JSON API needs: never cookies or credentials
    if ((k === "content-type" || k === "accept") && typeof value === "string" && value.length <= 200) headers[k] = value;
  }
  let body;
  if (method === "POST" && typeof message?.body === "string") {
    if (new TextEncoder().encode(message.body).length > MAX_REQUEST_BYTES) return { error: "request too long" };
    body = message.body;
  }
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(url, {
      method, headers, body, redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
      signal: controller?.signal,
    });
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > MAX_ANSWER_BYTES) return { error: "answer too long" };
    // read up to the cap and no further, whatever the server says its length is
    let text = "";
    let size = 0;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ANSWER_BYTES) { try { await reader.cancel(); } catch { /* gone */ } return { error: "answer too long" }; }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } else {
      text = await response.text();
      size = new TextEncoder().encode(text).length;
      if (size > MAX_ANSWER_BYTES) return { error: "answer too long" };
    }
    const out = { "content-length": String(size) };
    const type = response.headers?.get?.("content-type");
    if (type) out["content-type"] = type;
    const etag = response.headers?.get?.("etag");
    if (etag) out.etag = etag;
    return { status: response.status, headers: out, body: text };
  } catch (error) {
    return { error: String(error?.message || error || "no answer") };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Their `chrome.storage.local`, kept in memory (iOS KusdtStoreRelay's rules: "kusdt." keys only,
 *  512 KB per entry, 2 MB in all; values kept as JSON text). Answers `{ value }` or `{ error }`. */
export function createMemoryStore() {
  const all = new Map();
  const total = () => [...all].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    handle(message) {
      const op = message?.op;
      if (op === "get") {
        const value = {};
        for (const key of (Array.isArray(message.keys) ? message.keys : []).slice(0, 64)) {
          const text = all.get(String(key));
          if (text != null) { try { value[key] = JSON.parse(text); } catch { /* unreadable */ } }
        }
        return { value };
      }
      if (op === "set") {
        const before = new Map(all);
        for (const [key, value] of Object.entries(message.values || {})) {
          if (!key.startsWith("kusdt.") || key.length > 256 || value === null || value === undefined) continue;
          let text;
          try { text = JSON.stringify(value); } catch { continue; }
          if (text === undefined || text.length > STORE_MAX_ENTRY_BYTES) continue;
          all.set(key, text);
        }
        // over the total cap: the write is refused rather than growing without bound
        if (total() > STORE_MAX_TOTAL_BYTES) {
          all.clear();
          for (const [k, v] of before) all.set(k, v);
          return { error: "store full" };
        }
        return { value: {} };
      }
      if (op === "remove") {
        for (const key of (Array.isArray(message.keys) ? message.keys : [])) if (String(key).startsWith("kusdt.")) all.delete(String(key));
        return { value: {} };
      }
      return { error: "bad op" };
    },
    get size() { return all.size; },
  };
}

/** Installs the handlers on `scope` (the worker's global scope) before their code runs. Returns
 *  `setApiHosts(hosts)`: the Trestly API hosts their `fetch` may reach. */
export function installKusdtWalletBridge(scope = globalThis) {
  const nativeFetch = typeof scope.fetch === "function" ? scope.fetch.bind(scope) : null;
  let apiHosts = [];
  const store = createMemoryStore();
  scope.webkit = Object.freeze({
    messageHandlers: Object.freeze({
      kusdtNet: Object.freeze({
        postMessage: (message) => (nativeFetch
          ? relayFetch(message, { fetchImpl: nativeFetch, apiHosts })
          : Promise.resolve({ error: "no network here" })),
      }),
      kusdtStore: Object.freeze({ postMessage: (message) => Promise.resolve(store.handle(message)) }),
    }),
  });
  const NativeWebSocket = scope.WebSocket;
  if (typeof NativeWebSocket === "function") {
    class GuardedWebSocket extends NativeWebSocket {
      constructor(url, protocols) {
        if (!allowedSocketUrl(url)) throw new Error("K doesn't let this reach that address.");
        super(url, protocols);
      }
    }
    scope.WebSocket = GuardedWebSocket;
  }
  return {
    setApiHosts(hosts) { apiHosts = (hosts || []).map((h) => String(h || "").toLowerCase()).filter(Boolean); },
    get apiHosts() { return [...apiHosts]; },
  };
}
