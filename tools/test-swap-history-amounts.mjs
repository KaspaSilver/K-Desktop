// node tools/test-swap-history-amounts.mjs - swap history amounts (K 961fc05a ownHistoryAmount): an
// address history row counts what left this wallet, not every output that went to "others". A kUSDT
// swap spends Trestly's pool, which pays its whole balance back to itself, and that output read as
// Sent (-367,808 KAS for a swap of a few KAS, owner 2026-11-25).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ownHistoryAmount } from "../engine/history-amounts.js";

const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
const KAS = 100_000_000n;
const ME = "kaspa:qme";
const MY_OTHER = "kaspa:qmyother";
const POOL = "kaspa:pool";
const BOB = "kaspa:qbob";
const isOwn = (address) => address === MY_OTHER;
const input = (address, amount) => ({ previous_outpoint_address: address, previous_outpoint_amount: amount == null ? null : String(amount) });
const output = (address, amount) => ({ script_public_key_address: address, amount: String(amount) });
/** What the row showed before: outputs to anyone but this address and the wallet's others. */
const toOthersOf = (tx) => tx.outputs.filter((o) => o.script_public_key_address !== ME && o.script_public_key_address !== MY_OTHER).reduce((s, o) => s + BigInt(o.amount), 0n);
const changeOf = (tx) => tx.outputs.filter((o) => o.script_public_key_address === MY_OTHER).reduce((s, o) => s + BigInt(o.amount), 0n);
const amountOf = (tx) => ownHistoryAmount(tx, ME, { toOthers: toOthersOf(tx), ownChange: changeOf(tx), isOwnAddress: isOwn });

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

test("a buy: the pool's own balance going back to it isn't Sent; only what left the wallet is", () => {
  // 5 KAS in from me, the pool's 367,800 in; the pool gets 367,804.99, my 0.0099 change back
  const tx = {
    inputs: [input(ME, 5n * KAS), input(POOL, 367_800n * KAS)],
    outputs: [output(POOL, 367_804n * KAS + 99_000_000n), output(ME, 990_000n)],
  };
  assert.equal(toOthersOf(tx), 367_804n * KAS + 99_000_000n, "the old figure: the whole pool");
  const row = amountOf(tx);
  assert.equal(row.isOutgoing, true);
  // what left: 5 - 0.0099 = 4.9901; the fee (0.0001 KAS) is the pool's almost entirely
  const fee = 5n * KAS + 367_800n * KAS - (367_804n * KAS + 99_000_000n + 990_000n);
  const myShare = (fee * 5n * KAS) / (5n * KAS + 367_800n * KAS);
  assert.equal(row.amountSompi, 5n * KAS - 990_000n - myShare);
});

test("a sell that paid the wallet Kaspa is Received, by what it gained", () => {
  const tx = {
    inputs: [input(ME, 2n * KAS), input(POOL, 1_000n * KAS)],
    outputs: [output(POOL, 993n * KAS), output(ME, 9n * KAS - 10_000n)],
  };
  assert.deepEqual(amountOf(tx), { isOutgoing: false, amountSompi: 7n * KAS - 10_000n });
});

test("a plain send with only this wallet's coins: what went out, less change, less the whole fee", () => {
  const tx = {
    inputs: [input(ME, 10n * KAS)],
    outputs: [output(BOB, 1n * KAS), output(MY_OTHER, 9n * KAS - 2_000n)],
  };
  // paid = 10 - (8.99998) = 1.00002; fee 0.00002 off: 1, and never more than went to others (1)
  assert.deepEqual(amountOf(tx), { isOutgoing: true, amountSompi: 1n * KAS });
});

test("two of this wallet's addresses funding one send each show the whole send (audit L2)", () => {
  const tx = {
    inputs: [input(ME, 3n * KAS), input(MY_OTHER, 4n * KAS)],
    outputs: [output(BOB, 6n * KAS), output(ME, 1n * KAS - 5_000n)],
  };
  assert.deepEqual(amountOf(tx), { isOutgoing: true, amountSompi: 6n * KAS });
});

test("unknown amounts: one of ours keeps the caller's figure; an outside one takes no fee off", () => {
  assert.equal(amountOf({ inputs: [input(ME, null)], outputs: [output(BOB, KAS)] }), null);
  const tx = { inputs: [input(ME, 5n * KAS), input(POOL, null)], outputs: [output(POOL, 100n * KAS), output(ME, 1n * KAS)] };
  assert.deepEqual(amountOf(tx), { isOutgoing: true, amountSompi: 4n * KAS }, "5 in, 1 back, no fee share known");
  assert.equal(ownHistoryAmount({ inputs: [input(BOB, KAS)], outputs: [output(ME, KAS)] }, ME), null, "this address paid nothing in");
});

test("Manage Addresses' history rows use it, Sent or Moved worked out again, Received when it gained", () => {
  const rows = app.slice(app.indexOf("async function loadManageAddressTransactions("), app.indexOf("const row = document.createElement(\"button\");", app.indexOf("async function loadManageAddressTransactions(")));
  assert.match(rows, /const own = ownHistoryAmount\(tx, address, \{\n\s*toOthers: breakdown\.toOthers, ownChange: breakdown\.changeTotal,\n\s*isOwnAddress: \(other\) => Boolean\(ownAddressLabelFor\(other\)\),/);
  assert.match(rows, /breakdown\.moved = breakdown\.toOthers === 0n && breakdown\.changeTotal > 0n;/);
  assert.match(rows, /info = \{ isOutgoing: false, amountSompi: own\.amountSompi \};\n\s*breakdown = null;/);
});

console.log(`swap history amounts: ${passed} passed`);
