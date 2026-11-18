// node tools/test-send-max-fee.mjs - Build 297: Max's fee reaches Review. An amount change re-checks
// the recipient, and that check used to report "no recipient" for a moment before the same address
// again; the "no recipient" cleared the fee Max had just worked out, so Review showed "--" with the
// Total spinning and nothing could be sent. The check now reports the recipient once, and Max puts
// its own fee back after filling the amount.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(repo, "ui/app.js"), "utf8");

let failures = 0;
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.log(`FAIL - ${name}\n`, error); }
}

const validity = (() => {
  const start = app.indexOf("async function updateValidity()");
  return app.slice(start, app.indexOf("\n  }\n", start));
})();

test("an amount change never reports 'no recipient' before an address it already had", () => {
  const addressBranch = validity.indexOf("if (/^kaspa(test)?:/.test(raw)) {");
  assert.ok(addressBranch > 0);
  const before = validity.slice(0, addressBranch);
  assert.doesNotMatch(before.replace(/if \(!raw\) \{ setValidRecipient\(null\);/, ""), /setValidRecipient\(null\)/,
    "nothing clears the recipient on the way to the address check");
  assert.match(validity, /setValidRecipient\(valid \? raw : null\);/);
});
test("no address, a new name and anything else still mean no recipient", () => {
  assert.match(validity, /if \(!raw\) \{ setValidRecipient\(null\);/);
  assert.match(validity, /if \(engine\.looksLikeName\(raw\)\) \{\n\s+setValidRecipient\(null\);/);
  assert.match(validity, /setValidRecipient\(null\);\n\s+if \(els\.submit\) els\.submit\.disabled = true;\n\s+setRecipientStatus\(\{ input: raw, valid: false \}\);/);
});
test("Max puts its fee back after filling the amount, for Send and for Compound", () => {
  const start = app.indexOf("async function fillMaxAmountNow()");
  const max = app.slice(start, app.indexOf("\n}\n", start));
  assert.match(max, /maxFee = \{ base: sendKaspaBaseFeeKas, sdkBase: sendKaspaSdkBaseKas \};/);
  assert.equal((max.match(/stopSendKaspaFeeEstimate\(\);\n\s+keepMaxFee\(\);/g) || []).length, 2);
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log(`send max fee: ${passed} passed`);
