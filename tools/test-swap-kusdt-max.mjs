// "Available" and Max on a kUSDT swap (K 6b99c6dd): the Swap From address's KAS on a buy, its kUSDT
// on a sell; Max is all the kUSDT on a sell and, on a buy, the KAS less what Trestly's pool keeps
// back (the new coin's 1.5 KAS and its 0.3 KAS fee reserve, kusdt-wallet.js maxKasIn), with a note.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.window ??= globalThis;
const swaps = await import("../ui/swaps.js").catch(() => null);
const src = readFileSync(new URL("../ui/swaps.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
const trestly = readFileSync(new URL("../kusdt/kusdt-wallet.js", import.meta.url), "utf8");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

// ui/swaps.js imports CSS and images, which node can't load; the pure rules are read from the source
// then, evaluated on their own.
function pure() {
  if (swaps?.kusdtMaxSend) return swaps;
  const pick = (start, end) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));
  const body = pick("export const KUSDT_BUY_FEE_KEEP_SOMPI", "/** Reads the Swap From address's balances");
  const kasTextFromSompi = (s) => {
    const v = BigInt(s); const whole = v / 100_000_000n; const frac = (v % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : String(whole);
  };
  const typedKusdt = (u) => {
    const v = BigInt(u); const whole = v / 1_000_000n; const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : String(whole);
  };
  return new Function("KUSDT_TOKEN", "kasTextFromSompi", "typedKusdt",
    `${body.replace(/export /g, "")}; return { KUSDT_BUY_FEE_KEEP_SOMPI, KUSDT_BUY_KEEP_SOMPI, kusdtMaxSend, kusdtMaxText, kusdtBuyKeepNote };`,
  )({ kasPerCoinSompi: 150_000_000n }, kasTextFromSompi, typedKusdt);
}
const m = pure();

test("a buy keeps back 1.8 KAS, Trestly's own FEE_KEEP plus the coin's 1.5 KAS", () => {
  assert.match(trestly, /var FEE_KEEP = 30000000n;/);
  assert.equal(m.KUSDT_BUY_FEE_KEEP_SOMPI, 30_000_000n);
  assert.equal(m.KUSDT_BUY_KEEP_SOMPI, 180_000_000n);
});

test("Max: KAS less what's kept on a buy, never negative; all the kUSDT on a sell; unknown is null", () => {
  assert.equal(m.kusdtMaxSend({ buying: true, kasSompi: 1_000_000_000n }), 820_000_000n);
  assert.equal(m.kusdtMaxSend({ buying: true, kasSompi: 180_000_000n }), 0n);
  assert.equal(m.kusdtMaxSend({ buying: true, kasSompi: 98_809_891n }), 0n);
  assert.equal(m.kusdtMaxSend({ buying: true, kasSompi: null }), null);
  assert.equal(m.kusdtMaxSend({ buying: false, units: 12_500_000n }), 12_500_000n);
  assert.equal(m.kusdtMaxSend({ buying: false, units: null }), null);
});

test("Max types exact figures: KAS to 8 places, kUSDT to 6, no grouping", () => {
  assert.equal(m.kusdtMaxText(820_000_001n, true), "8.20000001");
  assert.equal(m.kusdtMaxText(1_234_567_890n, false), "1234.56789");
  assert.equal(m.kusdtMaxText(100_000_000n, true), "1");
});

test("the note says what stays behind and why", () => {
  assert.equal(m.kusdtBuyKeepNote(), "Max keeps 1.8 KAS back: 1.5 KAS goes inside your new kUSDT coin, and up to 0.3 KAS pays the network fee.");
});

test("the form shows Available and Max only on kUSDT swaps, the note only on a buy", () => {
  assert.match(src, /if \(kusdt\) \{\n\s*refreshKusdtBalances\(\);/);
  assert.match(src, /\$\{kusdt && kasIsSendSide \? `<p class="swap-max-note">/);
  assert.match(src, /<span class="swap-available">Available: /);
  assert.match(src, /data-swap-max>Max<\/button>/);
  // read again after each of the trade's follow-up lookups (K 961fc05a), once with no txid
  assert.match(src, /deps\.kusdt\.followTrade\(txid, \(\) => refreshKusdtBalances\(\{ force: true \}\)\)/, "read again as the trade is followed");
  assert.match(src, /refreshKusdtBalances\(\{ force: true \}\), 4500\)/, "one look for a trade with no txid");
});

test("the address's KAS leaves out coins a trade can't spend; kUSDT is that address's own", () => {
  assert.match(app, /balancesOf: async \(address\) => \{/);
  assert.match(app, /totalUtxoSompi\(excludeReservedUtxos\(excludeJustSpentUtxos\(excludeCovenantUtxos\(entries\)\)\)\)/);
  assert.match(app, /held\.filter\(\(h\) => h\.address === address\)/);
  assert.match(app, /if \(engine\.address !== owner\) return null;/);
});

console.log(`swap kUSDT max: ${passed} passed`);
