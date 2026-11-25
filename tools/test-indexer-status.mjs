// K 8cb4c88e: Settings > Connection Status shows Node Status and, below it, Indexer Status:
// Connected, Degraded (a request failed within the last two minutes) or Disconnected (down after
// failures in a row), with one /metrics request when the screen opens.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createIndexerHealth, indexerConnectionState, checkIndexerNow,
  INDEXER_FAILURE_SPACING_MS, INDEXER_FAILURE_WINDOW_MS,
} from "../engine/indexer-health.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8");
const app = read("ui", "app.js");
const html = read("index.html");
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

const URL_A = "https://indexer.example.test";

await test("Connected, Degraded for two minutes after a failure, Disconnected once down, Not set with none", () => {
  let clock = 1_000_000;
  const health = createIndexerHealth({ now: () => clock, storage: null });
  assert.equal(indexerConnectionState("", { health }), "notSet");
  assert.equal(indexerConnectionState(URL_A, { health }), "connected");
  health.recordFailure(`${URL_A}/metrics`);
  assert.equal(indexerConnectionState(URL_A, { health }), "degraded");
  clock += INDEXER_FAILURE_WINDOW_MS + 1;
  assert.equal(indexerConnectionState(URL_A, { health }), "connected", "older than two minutes");
  health.recordFailure(URL_A);
  assert.equal(indexerConnectionState(URL_A, { health }), "degraded");
  health.recordAnswer(URL_A);
  assert.equal(indexerConnectionState(URL_A, { health }), "connected", "an answer ends it");
  for (let i = 0; i < 3; i += 1) { health.recordFailure(URL_A); clock += INDEXER_FAILURE_SPACING_MS; }
  assert.equal(indexerConnectionState(URL_A, { health }), "disconnected");
});

await test("one /metrics request when the screen opens; never throws", async () => {
  const calls = [];
  await checkIndexerNow(`${URL_A}/`, { fetchImpl: async (url, init) => { calls.push([url, init.cache]); return { status: 200 }; } });
  assert.deepEqual(calls, [[`${URL_A}/metrics`, "no-store"]]);
  await checkIndexerNow(URL_A, { fetchImpl: async () => { throw new Error("offline"); } });
  calls.length = 0;
  await checkIndexerNow("", { fetchImpl: async (url) => { calls.push(url); } });
  assert.equal(calls.length, 0, "no indexer, no request");
});

await test("Node Status, then Indexer Status, in Connection Status", () => {
  const overlay = html.slice(html.indexOf("data-connection-overlay"));
  const node = overlay.indexOf("<strong>Node Status</strong>");
  const indexer = overlay.indexOf("<strong>Indexer Status</strong>");
  assert.ok(node > 0 && indexer > node, "Indexer Status below Node Status");
  assert.doesNotMatch(overlay.slice(0, indexer), /<strong>Status<\/strong>/);
  assert.match(overlay, /data-connection-indexer-status-dot aria-hidden="true"><\/span><span data-connection-indexer-status-text>Checking…<\/span>/);
});

await test("the row reads the state, checks once on open and again every 2 s while open", () => {
  const render = app.slice(app.indexOf("function renderIndexerStatus()"), app.indexOf("document.querySelector(\"[data-close-connection-overlay]\")"));
  for (const word of ['"Connected"', '"Degraded"', '"Disconnected"', '"Checking…"']) assert.ok(render.includes(word), word);
  assert.match(render, /indexerConnectionState\(getEndpoint\("kasiaIndexer"\)\)/);
  const open = app.slice(app.indexOf("function openConnectionOverlay()"), app.indexOf("function closeConnectionOverlay()"));
  assert.match(open, /checkIndexerNow\(indexerUrl\)\.then/);
  assert.match(open, /\}, 2000\);/);
  const close = app.slice(app.indexOf("function closeConnectionOverlay()"), app.indexOf("function renderIndexerStatus()"));
  assert.match(close, /window\.clearInterval\(indexerStatusTimer\)/);
  assert.match(app, /\/\/ and the message indexer's, below it \(K 8cb4c88e\)\n  renderIndexerStatus\(\);/);
});

console.log(`indexer status (K 8cb4c88e): ${passed} passed`);
