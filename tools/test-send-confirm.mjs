// node tools/test-send-confirm.mjs - sends don't ask first. Since iOS 5.3 "no Face ID on sends"
// (owner, 2026-11-17) a plain Kaspa send - Send Kaspa, Max, a spending address's send - goes straight
// to the build. The one send that still asked, Send Domain, left with KNS (K 518fdc8c), and the
// engine's spend gate (confirmSpend / authorizeSpend) with it; Delete Account asks on its own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { KaspaEngine } from "../engine/index.js";

const engine = new KaspaEngine({ log: () => {} });
let built = 0;
// Stand-ins below any gate: reaching them means the send went ahead.
engine.requireWallet = () => {};
engine.requireSdk = () => {};
engine.connect = async () => { built += 1; throw new Error("reached the build"); };

async function attempt(run) {
  try { await run(); return "sent"; }
  catch (error) { return error?.code === "SEND_CANCELLED" ? "cancelled" : "went ahead"; }
}

assert.equal(await attempt(() => engine.send("kaspa:qpdest", "1.5")), "went ahead");
assert.equal(await attempt(() => engine.sendMax("kaspa:qpdest", null, null, { expectedAmountSompi: 250000000n })), "went ahead");
assert.equal(await attempt(() => engine.sendFromSpending({ mnemonic: "x", index: 1, destinationAddress: "kaspa:qpdest", amountKas: "2" })), "went ahead");
assert.equal(await attempt(() => engine.sendMaxFromSpending({ mnemonic: "x", index: 1, destinationAddress: "kaspa:qpdest" })), "went ahead");
assert.ok(built >= 1, "the sends reached the build");
assert.equal(typeof engine.confirmSpend, "undefined", "no spend gate left in the engine");

const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
assert.doesNotMatch(app, /engine\.authorizeSpend\s*=/);
assert.match(app, /authorizeKasSpend\(\{ confirm: \{ title: "Delete Account"/, "Delete Account still asks");

console.log("send confirm: ok (plain sends go out; Delete Account asks on its own)");
