// Registering a .kas domain and editing its profile go out like any plain send, with no password
// (owner, 2026-11-17, iOS 5.3 "no Face ID on sends" - iOS never asked here). Send Domain still asks
// (tools/test-send-confirm.mjs).
import assert from "node:assert/strict";
import { KaspaEngine } from "../engine/index.js";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

function fakeEngine(answer) {
  const asked = [];
  const steps = [];
  const engine = Object.create(KaspaEngine.prototype);
  engine.authorizeSpend = async (details) => { asked.push(details); return answer; };
  engine.requireWallet = () => { steps.push("requireWallet"); };
  engine.connect = async () => { steps.push("connect"); throw new Error("stop here"); };
  return { engine, asked, steps };
}

await test("registering a domain doesn't ask; it goes straight to the build", async () => {
  const { engine, asked, steps } = fakeEngine(false);
  await assert.rejects(engine.inscribeKnsDomain(" MyName "), /stop here/);
  assert.equal(asked.length, 0);
  assert.deepEqual(steps, ["requireWallet", "connect"]);
});

await test("profile saves don't ask, one field or a batch", async () => {
  const { engine, asked } = fakeEngine(false);
  await assert.rejects(engine.submitKnsProfileField("asset", "bio", "hi"), /stop here/);
  await engine.confirmKnsProfileUpdate(3);
  await assert.rejects(engine.submitKnsProfileFields("asset", { bio: "a", x: "b" }), /stop here/);
  await assert.rejects(engine.submitKnsProfileFields("asset", { bio: "a", x: "b" }, { confirmed: true }), /stop here/);
  assert.equal(asked.length, 0);
});

await test("Send Domain still asks", async () => {
  const { engine, asked, steps } = fakeEngine(false);
  await assert.rejects(engine.transferKnsDomain({ domain: "alice.kas", assetId: "a", toAddress: "kaspa:qpdest" }), (error) => error.code === "SEND_CANCELLED");
  assert.equal(asked.length, 1);
  assert.deepEqual(steps, []);
});

console.log(`\n${passed} passed`);
