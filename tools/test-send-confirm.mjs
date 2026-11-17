// node tools/test-send-confirm.mjs - which sends ask first (engine.confirmSpend). Since iOS 5.3 "no
// Face ID on sends" (owner, 2026-11-17) a plain Kaspa send - Send Kaspa, Max, a spending address's
// send - and .kas registration and profile saves go straight out; Send Domain still asks, and a
// refusal stops it before anything is built or connected, with SEND_CANCELLED.
import assert from "node:assert/strict";
import { KaspaEngine } from "../engine/index.js";

const engine = new KaspaEngine({ log: () => {} });
let built = 0;
// Stand-ins below the gate: reaching them means the send went ahead.
engine.requireWallet = () => {};
engine.requireSdk = () => {};
engine.connect = async () => { built += 1; throw new Error("reached the build"); };

const asked = [];
async function attempt(run) {
  try { await run(); return "sent"; }
  catch (error) { return error?.code === "SEND_CANCELLED" ? "cancelled" : "went ahead"; }
}

// No authorizer (tests, tools): as before.
assert.equal(await attempt(() => engine.send("kaspa:qpdest", "1.5")), "went ahead");

// An authorizer that refuses everything: plain sends never ask it.
engine.authorizeSpend = async (details) => { asked.push(details); return false; };
built = 0;
assert.equal(await attempt(() => engine.send("kaspa:qpdest", "1.5")), "went ahead");
assert.equal(await attempt(() => engine.sendMax("kaspa:qpdest", null, null, { expectedAmountSompi: 250000000n })), "went ahead");
assert.equal(await attempt(() => engine.sendFromSpending({ mnemonic: "x", index: 1, destinationAddress: "kaspa:qpdest", amountKas: "2" })), "went ahead");
assert.equal(await attempt(() => engine.sendMaxFromSpending({ mnemonic: "x", index: 1, destinationAddress: "kaspa:qpdest" })), "went ahead");
assert.equal(await attempt(() => engine.inscribeKnsDomain("alice")), "went ahead", ".kas registration doesn't ask");
await engine.confirmKnsProfileUpdate(3); // a .kas profile save doesn't ask (no throw)
assert.equal(asked.length, 0, "no plain send asked");

// Send Domain still asks, and a refusal builds nothing.
built = 0;
assert.equal(await attempt(() => engine.transferKnsDomain({ domain: "alice.kas", assetId: "a", toAddress: "kaspa:qpdest" })), "cancelled");
assert.equal(built, 0, "a refused Send Domain builds and connects nothing");
assert.deepEqual(asked.map((d) => [d.to, d.domain ?? null]), [["kaspa:qpdest", "alice.kas"]]);

// Confirmed: it goes ahead.
engine.authorizeSpend = async () => true;
assert.equal(await attempt(() => engine.transferKnsDomain({ domain: "alice.kas", assetId: "a", toAddress: "kaspa:qpdest" })), "went ahead");

console.log("send confirm: ok (plain sends and .kas saves go out; Send Domain asks, refusal builds nothing)");
