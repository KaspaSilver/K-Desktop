// KaChat iOS 148a5331, behaviour: after a "Not confirmed" Cold Storage send the next automatic pick
// leads with that send's largest coin (ChatService.conflictingOutpoint); a room's page-back that
// fails part-way resumes on the next poll, giving up after three tries (deepBackfillResume).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { markColdUnknownOutcome, conflictingOutpointKey } = await import("../ui/kspt.js");
const kspt = readFileSync(new URL("../ui/kspt.js", import.meta.url), "utf8");
const coldstorage = readFileSync(new URL("../ui/coldstorage.js", import.meta.url), "utf8");
const rooms = readFileSync(new URL("../ui/broadcasts.js", import.meta.url), "utf8");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

const coin = (txid, index, kas) => ({ transactionId: txid, index, amountSompi: BigInt(kas) * 100_000_000n });

test("no Not-confirmed send: nothing to lead with", () => {
  assert.equal(conflictingOutpointKey([coin("aa", 0, 5)]), null);
});
test("the largest coin of a Not-confirmed send leads, and the memory runs out", () => {
  const now = Date.now();
  markColdUnknownOutcome(["AA:0", "bb:1"], now);
  const spendable = [coin("aa", 0, 2), coin("bb", 1, 7), coin("cc", 2, 50)];
  assert.equal(conflictingOutpointKey(spendable, now + 1000), "bb:1");
  assert.equal(conflictingOutpointKey([coin("cc", 2, 50)], now + 1000), null);
  assert.equal(conflictingOutpointKey(spendable, now + 11 * 60 * 1000), null);
});
test("the build and the preview lead with it; a coin-control pick is left alone", () => {
  assert.match(kspt, /if \(leadAt > 0\) sorted\.unshift\(\.\.\.sorted\.splice\(leadAt, 1\)\);/);
  assert.match(kspt, /const previewMissesLead = previewed && lead != null && !\(manualUtxoKeys \|\| \[\]\)\.includes\(lead\);/);
  assert.match(kspt, /selectUtxos\(spendable, amountSompi, feeRateSompiPerGram, 34, 34, conflictingOutpointKey\(spendable\)\)/);
  assert.match(kspt, /if \(error\?\.code === SEND_OUTCOME_UNKNOWN\) markColdUnknownOutcome\(spends\);/);
  assert.match(coldstorage, /previewed: !flow\.manualUtxoKeys && Boolean\(flow\.preview\?\.utxoKeys\),/);
});
test("a room's page-back resumes where it failed, three tries at most", () => {
  assert.match(rooms, /const BACKFILL_RESUME_TRIES = 3;/);
  assert.match(rooms, /if \(failures < BACKFILL_RESUME_TRIES\) deepBackfillResume\.set\(channel, \{ before, cutoff, failures \}\);\n        else deepBackfillResume\.delete\(channel\);/);
  assert.match(rooms, /const resume = deepBackfilled\.has\(channel\) \? deepBackfillResume\.get\(channel\) : null;/);
});

console.log(`ios 148a5331 coins and rooms: ${passed} passed`);
