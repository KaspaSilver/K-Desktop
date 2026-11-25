// node tools/test-node-fallback.mjs - the node connection rules ported from K 961fc05a (wRPC over
// wss, battery audit AUDIT_2026-11-25 B1/B3/B4/B7): the keepalive's cadence and its spared ask,
// offline waits, the block stream held off in a hidden page, and a resolver's /wrpc/json path taken
// as its /wrpc/borsh sibling. A real KaspaEngine; only the node is a fake.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
}
globalThis.localStorage = new MemoryStorage();

const K = await import("../engine/node-keepalive.js");
const { borshEndpoint } = await import("../engine/rpc.js");
const { KaspaEngine } = await import("../engine/index.js");
const engineSource = readFileSync(new URL("../engine/index.js", import.meta.url), "utf8");

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${name}`); }
  catch (error) { console.error(`FAIL ${name}\n`, error); process.exitCode = 1; }
}

await test("keepalive: 15 s, 45 s on cellular or Save-Data, under a proxy's ~100 s idle cut", () => {
  assert.equal(K.keepaliveIntervalMs({}), 15_000);
  assert.equal(K.keepaliveIntervalMs({ connection: { type: "wifi", saveData: false } }), 15_000);
  assert.equal(K.keepaliveIntervalMs({ connection: { type: "cellular" } }), 45_000);
  assert.equal(K.keepaliveIntervalMs({ connection: { saveData: true } }), 45_000);
  assert.equal(K.keepaliveIntervalMs(undefined), 15_000);
  assert.ok(K.KEEPALIVE_EXPENSIVE_MS < 100_000);
});

await test("keepalive: the ask is spared only when the node spoke within the interval", () => {
  const now = 1_000_000;
  assert.equal(K.keepaliveProbeDue({ now, lastNotificationAt: 0, intervalMs: 15_000 }), true, "never spoke");
  assert.equal(K.keepaliveProbeDue({ now, lastNotificationAt: now - 3_000, intervalMs: 15_000 }), false, "a block 3 s ago");
  assert.equal(K.keepaliveProbeDue({ now, lastNotificationAt: now - 15_000, intervalMs: 15_000 }), true, "a whole interval quiet");
  assert.equal(K.keepaliveProbeDue({ now, lastNotificationAt: now + 60_000, intervalMs: 15_000 }), true, "a clock gone backwards doesn't spare it");
});

await test("offline is only navigator.onLine === false", () => {
  assert.equal(K.browserOffline({ onLine: false }), true);
  assert.equal(K.browserOffline({ onLine: true }), false);
  assert.equal(K.browserOffline({}), false);
  assert.equal(K.browserOffline(undefined), false);
});

await test("block-added: held off after 30 s hidden, never while an outage scan reads it", () => {
  const now = 10_000_000;
  assert.equal(K.blockAddedSuspended({ hiddenSince: 0, now }), false, "showing");
  assert.equal(K.blockAddedSuspended({ hiddenSince: now - 5_000, now }), false, "a quick look at another tab");
  assert.equal(K.blockAddedSuspended({ hiddenSince: now - 30_000, now }), true);
  assert.equal(K.blockAddedSuspended({ hiddenSince: now - 600_000, now, outageClients: 1 }), false, "the indexer is down");
});

await test("a resolver's /wrpc/json path is taken as its /wrpc/borsh sibling", () => {
  assert.equal(borshEndpoint("wss://emma.kaspa.stream/kaspa/mainnet/wrpc/json"), "wss://emma.kaspa.stream/kaspa/mainnet/wrpc/borsh");
  assert.equal(borshEndpoint("WSS://Host.example/kaspa/mainnet/WRPC/JSON/"), "WSS://Host.example/kaspa/mainnet/WRPC/borsh/");
  assert.equal(borshEndpoint(" wss://a.kaspa.red/kaspa/testnet-10/wrpc/json?x=1 "), "wss://a.kaspa.red/kaspa/testnet-10/wrpc/borsh?x=1");
  assert.equal(borshEndpoint("wss://emma.kaspa.stream/kaspa/mainnet/wrpc/borsh"), "wss://emma.kaspa.stream/kaspa/mainnet/wrpc/borsh");
  assert.equal(borshEndpoint("wss://node.example:17110"), "wss://node.example:17110");
  assert.equal(borshEndpoint("wss://json.example/wrpc/jsonx"), "wss://json.example/wrpc/jsonx", "only the whole last segment");
  assert.equal(borshEndpoint("https://x/wrpc/json"), "https://x/wrpc/json", "not a wRPC URL");
  assert.match(engineSource, /new RpcClient\(\{ url: borshEndpoint\(endpoint\)/, "Test Connection dials the same URL");
});

function fakeRpc() {
  const rpc = { url: "wss://node.test/kaspa/mainnet/wrpc/borsh", asks: 0, async getServerInfo() { rpc.asks += 1; return { isSynced: true, networkId: "mainnet" }; } };
  return rpc;
}

await test("heartbeat: a node that pushed a block within the interval isn't asked", async () => {
  const engine = new KaspaEngine({ log: () => {} });
  const rpc = fakeRpc();
  engine.rpc = rpc;
  engine.blockScanRpc = rpc; // the block handler sits on the primary
  engine.lastNodeNotificationAt = 0;
  await engine.rpcHeartbeatTick();
  assert.equal(rpc.asks, 1, "a quiet node is asked");
  engine.handleBlockAddedEvent({ data: {} });
  assert.ok(Date.now() - engine.lastNodeNotificationAt < 1_000, "a block counts as the node speaking");
  await engine.rpcHeartbeatTick();
  assert.equal(rpc.asks, 1, "spared");
  assert.equal(engine.connectionState.primary, "ready");
  engine.lastNodeNotificationAt = Date.now() - 60_000;
  await engine.rpcHeartbeatTick();
  assert.equal(rpc.asks, 2, "quiet again: asked again");
});

await test("heartbeat: a block from a handler left on an old node doesn't count", () => {
  const engine = new KaspaEngine({ log: () => {} });
  engine.rpc = fakeRpc();
  engine.blockScanRpc = fakeRpc();
  engine.handleBlockAddedEvent({ data: {} });
  assert.equal(engine.lastNodeNotificationAt, 0);
});

await test("heartbeat: offline, no reconnect is tried; ticks never overlap", async () => {
  const engine = new KaspaEngine({ log: () => {} });
  engine.address = "kaspa:qtest";
  let connects = 0;
  engine.connect = async () => { connects += 1; throw new Error("unreachable"); };
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true });
  try {
    await engine.rpcHeartbeatTick();
    assert.equal(connects, 0, "offline: nothing dialled");
    Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
    await Promise.all([engine.rpcHeartbeatTick(), engine.rpcHeartbeatTick()]);
    assert.equal(connects, 1, "online: one attempt, not two at once");
  } finally {
    if (saved) Object.defineProperty(globalThis, "navigator", saved);
    else delete globalThis.navigator;
  }
});

await test("hidden page: the rooms' block stream stops after the grace and comes back on show", async () => {
  const engine = new KaspaEngine({ log: () => {} });
  const calls = [];
  engine.detachBroadcastBlockScan = async () => { calls.push("stop"); engine.blockScanHandler = null; };
  engine.startBroadcastBlockScan = async () => { calls.push("start"); engine.blockScanHandler = () => {}; engine.blockScanRpc = engine.rpc; };
  engine.rpc = fakeRpc();
  engine.blockScanChannels = new Set(["kaspa"]);
  engine.blockScanHandler = () => {};
  engine.blockScanRpc = engine.rpc;
  assert.equal(engine.blockScanWanted(), true);

  engine.pageHiddenSince = Date.now() - 5_000;
  engine.applyBlockScanSuspension();
  assert.deepEqual(calls, [], "still inside the grace");

  engine.pageHiddenSince = Date.now() - 31_000;
  engine.applyBlockScanSuspension();
  assert.equal(engine.blockScanWanted(), false);
  assert.deepEqual(calls, ["stop"], "unsubscribed on the node");
  assert.deepEqual([...engine.blockScanChannels], ["kaspa"], "the rooms' wish is kept");

  engine.pageHiddenSince = 0;
  engine.applyBlockScanSuspension();
  assert.deepEqual(calls, ["stop", "start"], "showing the page brings it back");
});

await test("hidden page: an outage scan keeps the stream, and its end lets the hold apply", async () => {
  const engine = new KaspaEngine({ log: () => {} });
  const calls = [];
  engine.detachBroadcastBlockScan = async () => { calls.push("stop"); engine.blockScanHandler = null; };
  engine.startBroadcastBlockScan = async () => { calls.push("start"); engine.blockScanHandler = () => {}; engine.blockScanRpc = engine.rpc; };
  engine.rpc = fakeRpc();
  engine.blockScanChannels = new Set(["kaspa"]);
  engine.blockScanHandler = () => {};
  engine.blockScanRpc = engine.rpc;
  const remove = engine.addBlockScanClient(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  engine.pageHiddenSince = Date.now() - 120_000;
  engine.applyBlockScanSuspension();
  assert.equal(engine.blockScanWanted(), true, "the indexer is down: the chain is the only source");
  assert.ok(!calls.includes("stop"));
  remove();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(engine.blockScanWanted(), false, "outage over, page still hidden: held off");
  assert.ok(calls.includes("stop"));
});

await test("the heartbeat reschedules itself at the keepalive's interval (no fixed setInterval)", () => {
  assert.match(engineSource, /this\.rpcHeartbeatTimer = window\.setTimeout\(async \(\) => \{[\s\S]{0,200}this\.rpcHeartbeatIntervalMs\(\)\)/);
  assert.doesNotMatch(engineSource, /window\.setInterval\(async \(\) => \{\s*if \(this\.failoverPromise\)/);
  assert.match(engineSource, /addEventListener\?\.\("online"/, "the online event reconnects at once");
});

console.log(`test-node-fallback: ${passed} passed`);
