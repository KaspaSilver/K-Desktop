// node tools/test-relay-direct-first.mjs - hosts that send their own CORS headers (the KaChat
// indexer, api.kaspa.org, gate.io, dotk) are asked directly; the same-origin relay, a Cloudflare
// Pages Function on desktop.kachat.app capped at 100,000 calls a day, is only a fallback (2026-11-19).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(repo, "engine/endpoints.js"), "utf8");
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const { directFirst } = await import("../engine/endpoints.js");

let failures = 0;
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.log(`FAIL - ${name}\n`, error); }
}
const ok = (status = 200) => ({ status });
const boom = () => { throw new TypeError("Failed to fetch"); };

await test("the direct answer is used and the relay never asked", async () => {
  let relayed = 0;
  const res = await directFirst("a.test", "GET", async () => ok(), async () => { relayed += 1; return ok(); });
  assert.equal(res.status, 200);
  assert.equal(relayed, 0);
});
await test("a direct GET refused (CORS) goes through the relay, which then carries the host for 5 minutes", async () => {
  let t = 0;
  let direct = 0;
  let relayed = 0;
  const d = async () => { direct += 1; boom(); };
  const r = async () => { relayed += 1; return ok(); };
  assert.equal((await directFirst("b.test", "GET", d, r, () => t)).status, 200);
  assert.deepEqual([direct, relayed], [1, 1]);
  t = 4 * 60_000;
  await directFirst("b.test", "GET", d, r, () => t);
  assert.deepEqual([direct, relayed], [1, 2], "relay straight away");
  t = 6 * 60_000;
  await directFirst("b.test", "GET", d, r, () => t);
  assert.deepEqual([direct, relayed], [2, 3], "direct again after 5 minutes");
});
await test("a server that is down doesn't double into relay calls", async () => {
  let t = 0;
  let relayed = 0;
  const r = async () => { relayed += 1; return ok(502); };
  await assert.rejects(directFirst("c.test", "GET", boom, r, () => t));
  await assert.rejects(directFirst("c.test", "GET", boom, r, () => t));
  assert.equal(relayed, 1, "one relay try per minute");
  t = 61_000;
  await assert.rejects(directFirst("c.test", "GET", boom, r, () => t));
  assert.equal(relayed, 2);
});
await test("a POST is never repeated through the relay", async () => {
  let relayed = 0;
  await assert.rejects(directFirst("d.test", "POST", boom, async () => { relayed += 1; return ok(); }));
  assert.equal(relayed, 0);
});
await test("no relay on this site: the direct error stands", async () => {
  await assert.rejects(directFirst("e.test", "GET", boom, async () => null));
});
await test("the indexer and the Kaspa APIs are direct-first; the rest stay relayed", () => {
  const re = new RegExp(/const DIRECT_FIRST_HOST_RE = \/(.+)\/i;/.exec(source)[1], "i");
  for (const host of ["indexer.kachat.app", "api.kaspa.org", "api-tn10.kaspa.org", "api.gateio.ws"]) assert.ok(re.test(host), host);
  for (const host of ["api.dotk.name", "kaspaname.com", "adam.kaspa.green", "finance.yahoo.com", "indexer.kasia.wtf"]) assert.ok(!re.test(host), host);
  assert.match(source, /if \(DIRECT_FIRST_HOST_RE\.test\(parsed\.hostname\)\) \{/);
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log(`relay direct-first: ${passed} passed`);
