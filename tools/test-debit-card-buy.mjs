// Buy Kaspa with Debit Card on Desktop (owner, 2026-11-27; K bc0e6ba9 / 6d1971c8 / 824a30bb): the
// Wallet's Buy offers Crypto or Debit Card on mainnet (straight to crypto elsewhere); the debit card
// asks where the kUSDT lands (Fresh Address, the default, or the Chatting Address), copies it, and
// opens Trestly's buy page in a new tab, since Desktop embeds no sites.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
const fn = (name) => {
  const start = app.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  return app.slice(start, app.indexOf("\n}\n", start));
};
let passed = 0;
const test = (name, f) => { try { f(); passed += 1; console.log(`ok - ${name}`); } catch (e) { console.error(`not ok - ${name}`); throw e; } };

test("Buy: Crypto or Debit Card on mainnet, straight to crypto on testnet; the funding cards too", () => {
  const buy = fn("openBuyKaspa");
  assert.match(buy, /if \(IS_TESTNET\) \{ openBuySell\("buy", \{ toChatting \}\); return; \}/);
  assert.match(buy, /title: "Buy Kaspa with Crypto"/);
  assert.match(buy, /title: "Buy Kaspa with Debit Card"/);
  assert.match(app, /\[data-wallet-buy\]"\)\?\.addEventListener\("click", \(\) => openBuyKaspa\(\)\);/);
  assert.match(app, /openBuyKaspa\(\{ toChatting: true \}\);/);
});

test("Debit Card: where the kUSDT lands, copied, then Trestly's /buy in a new tab", () => {
  const card = fn("openDebitCardBuy");
  assert.match(card, /title: "Where should your kUSDT land\?"/);
  assert.match(card, /id: "fresh", title: "Fresh Address"/);
  assert.match(card, /id: "chatting", title: "Chatting Address"/);
  assert.match(card, /if \(toChatting\) options\.reverse\(\);/, "the funding card puts the Chatting Address first");
  assert.match(card, /getSpendingState\(owner\)\.maxIndex \+ 1/, "a regular address, never a quantum one");
  const copy = card.indexOf("copyTextToClipboard(address)");
  const open = card.indexOf('window.open(`${site}/buy`, "_blank", "noopener,noreferrer")');
  assert.ok(copy > 0 && open > copy, "copied before the tab opens");
  assert.match(card, /if \(!choice \|\| engine\.address !== owner\) return;/, "an account switch meanwhile does nothing");
  assert.match(headers, /frame-src 'none'/, "still no embedded sites");
});

console.log(`debit card buy: ${passed} passed`);
