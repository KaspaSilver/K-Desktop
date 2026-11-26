// The node registry keeps a bounded number of node records (audit 2026-11-25): it used to keep one
// per node URL forever, read and rewritten on every connect.
//
//   node tools/test-node-registry-cap.mjs
import assert from "node:assert/strict";
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const { recordFailover, getNodeRegistrySnapshot, MAX_ENDPOINT_RECORDS } = await import("../engine/rpc.js");

const KEY = "kachat.browser.node-registry.v1";
const endpoints = {};
// 100 nodes: even ones answered at time i, odd ones only failed (more recently than any success).
for (let i = 0; i < 100; i += 1) {
  const url = `wss://node-${i}.example/kaspa/mainnet/wrpc/borsh`;
  endpoints[url] = i % 2 === 0
    ? { endpoint: url, successes: 1, failures: 0, lastSuccessAt: 1000 + i, lastFailureAt: 0 }
    : { endpoint: url, successes: 0, failures: 3, lastSuccessAt: 0, lastFailureAt: 9000 + i };
}
const lastGood = "wss://node-0.example/kaspa/mainnet/wrpc/borsh"; // the oldest success
store.set(KEY, JSON.stringify({ version: 2, lastGoodEndpoint: lastGood, endpoints, failovers: [] }));

recordFailover({ from: "a", to: "", success: false, error: "x" }); // any save prunes
const saved = JSON.parse(store.get(KEY));
const kept = Object.keys(saved.endpoints);
assert.equal(MAX_ENDPOINT_RECORDS, 30);
assert.equal(kept.length, MAX_ENDPOINT_RECORDS, "capped");
assert.ok(kept.includes(lastGood), "the last good node is always kept");
// The 49 other answering nodes outrank the failure-only ones: the 29 most recent of them stay.
for (let i = 98; i >= 42; i -= 2) assert.ok(kept.includes(`wss://node-${i}.example/kaspa/mainnet/wrpc/borsh`), `node ${i} kept`);
assert.ok(!kept.some((u) => /node-\d*[13579]\./.test(u)), "failure-only nodes go first");
assert.equal(getNodeRegistrySnapshot().endpointCount, MAX_ENDPOINT_RECORDS);

// Under the cap nothing is dropped.
store.set(KEY, JSON.stringify({ version: 2, lastGoodEndpoint: "", endpoints: { a: { endpoint: "a", lastFailureAt: 1 } }, failovers: [] }));
recordFailover({ from: "a", to: "", success: false });
assert.deepEqual(Object.keys(JSON.parse(store.get(KEY)).endpoints), ["a"]);
console.log("node registry cap: ok");
