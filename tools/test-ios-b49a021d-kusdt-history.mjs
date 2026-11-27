// node tools/test-ios-b49a021d-kusdt-history.mjs - K b49a021d: kUSDT swaps go into Buy/Sell History
// with the ChangeNOW ones, marked Trestly, with their own details (the address, the transaction,
// View in Explorer, Add to Portfolio); Refresh Status asks the network, never ChangeNOW.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const swaps = read("ui/swaps.js");
const trade = read("engine/kusdt-trade.js");
const quote = read("ui/swap-quote.js");

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`ok - ${name}`); }

// swap-quote.js is plain: load it with its one browser import stubbed
const src = quote.replace(/^import[^;]+;$/gm, "");
const mod = await import(`data:text/javascript,${encodeURIComponent(src)}`).catch(() => null);

await test("the entry: its txid is its id, both addresses the one it traded from, Trestly", () => {
  assert.ok(mod, "swap-quote.js loads");
  const entry = mod.kusdtSwapHistoryEntry({ txid: "ab".repeat(32), bought: true, confirmed: true, kasText: "100", kusdtText: "2.61", address: "kaspa:qx", now: 5 });
  assert.deepEqual(
    { id: entry.id, from: `${entry.fromAmount} ${entry.fromTicker}`, to: `${entry.toAmount} ${entry.toTicker}`, payin: entry.payinAddress, payout: entry.payoutAddress, status: entry.status, provider: entry.provider },
    { id: "ab".repeat(32), from: "100 kas", to: "2.61 kusdt", payin: "kaspa:qx", payout: "kaspa:qx", status: "finished", provider: "trestly" },
  );
  const sold = mod.kusdtSwapHistoryEntry({ txid: "cd".repeat(32), bought: false, confirmed: false, kasText: "99", kusdtText: "2.5", address: "kaspa:qx" });
  assert.equal(`${sold.fromAmount} ${sold.fromTicker} → ${sold.toAmount} ${sold.toTicker}`, "2.5 kusdt → 99 kas");
  assert.equal(sold.status, "sending", "sending while it may still land");
  assert.equal(mod.kusdtSwapHistoryEntry({ txid: "" }), null);
  assert.equal(mod.displayTicker("kusdt"), "kUSDT");
  assert.equal(mod.displayTicker("usdc"), "USDC");
  assert.equal(mod.portfolioPrefill(entry).notes, `kUSDT swap (Trestly) ${"ab".repeat(32)}`);
  assert.equal(mod.portfolioPrefill(entry).type, "sell", "KAS went out");
  assert.equal(mod.portfolioPrefill({ ...entry, provider: undefined }).notes, `ChangeNOW swap ${"ab".repeat(32)}`);
});
await test("a finished kUSDT trade is recorded, for the account it ran on", () => {
  assert.match(trade, /txid, bought, confirmed, amountIn, amountOut,/);
  assert.match(swaps, /if \(account\(\) === startedOn\) \{\n\s+\/\/ and in Buy\/Sell History[^\n]*\n\s+try \{ recordKusdtSwap\(record, target\.address\); \}/);
  assert.match(swaps, /kasText: kasTextFromSompi\(kasUnits\), kusdtText: typedKusdt\(kusdtUnits\), address,/);
});
await test("its row says Trestly, ChangeNOW's say ChangeNOW", () => {
  assert.match(swaps, /function providerName\(swap\) \{ return swap\.provider === "trestly" \? "Trestly" : "ChangeNOW"; \}/);
  assert.match(swaps, /<small>\$\{esc\(dateText\(swap\.createdAt\)\)\} · \$\{esc\(providerName\(swap\)\)\}<\/small>/);
});
await test("its details: Swapped Through, the address, status, the transaction, Refresh Status and View in Explorer", () => {
  assert.match(swaps, /if \(swap\.provider === "trestly"\) \{\n\s+const txUrl = deps\.explorerTxUrl\?\.\(swap\.id\) \|\| "";/);
  assert.match(swaps, /Trestly's kUSDT pool on Kaspa/);
  assert.match(swaps, /<p class="swap-details-label">Transaction ID<\/p>/);
  assert.match(swaps, />View in Explorer<\/a>/);
});
await test("Refresh Status asks the network, never ChangeNOW", () => {
  assert.match(swaps, /const trestly = history\.find\(\(s\) => s\.id === id && s\.provider === "trestly"\);\n\s+if \(trestly\) \{\n\s+const accepted = await transactionAccepted\(id\);/);
  assert.match(swaps, /\/transactions\/\$\{encodeURIComponent\(txId\)\}\?inputs=false/);
  assert.match(swaps, /"Couldn't reach the network - try again"/);
});
console.log(`ios b49a021d kusdt history: ${passed} passed`);
