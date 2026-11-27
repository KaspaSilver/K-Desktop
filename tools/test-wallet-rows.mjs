// Wallet's list below Send/Receive/Request/Swap, as K iOS WalletView has it: Chatting Address and
// Your Usernames, rows alike (Swap Stablecoins went in K 5.4), and no Manage Addresses tile (the Kaspa
// balance card's Tap to Manage opens it). Your Usernames' count is read again since the old Profile
// screen went (Build 310 left the count waiting for that screen's rows).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8");
const html = read("index.html");
const app = read("ui", "app.js");
const css = read("ui", "styles.css");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

const walletStart = html.indexOf('data-app-tab-screen="wallet"');
const wallet = html.slice(walletStart, html.indexOf("</section>", walletStart));

test("the rows alike, in K's order, after the actions (K 824a30bb: Request Payment and Buy/Sell History are rows)", () => {
  const rows = [...wallet.matchAll(/<button class="profile-card profile-recovery-row" type="button" (data-[a-z-]+)>[\s\S]*?<span>([^<]+)<\/span>/g)]
    .map((m) => [m[1], m[2]]);
  assert.deepEqual(rows, [
    ["data-open-chatting-address", "Chatting Address"],
    ["data-wallet-request", "Request Payment"],
    ["data-open-domains-screen", "Your Usernames"],
    ["data-wallet-swap-history", "Buy/Sell History"],
  ]);
  assert.ok(wallet.indexOf("data-wallet-sell") < wallet.indexOf("data-open-chatting-address"), "Buy and Sell are actions above them");
  assert.doesNotMatch(wallet, /data-wallet-swap>|Swap Stablecoins<\/span>|data-wallet-swap-action/);
  assert.equal((wallet.match(/class="profile-row-trailing"/g) || []).length, 4, "each with its chevron");
  assert.match(css, /\.wallet-screen \.profile-recovery-row > svg\.qr-glyph \{ fill: currentColor; stroke: none; \}/);
});

test("no Manage Addresses tile; Tap to Manage on the Kaspa card opens it", () => {
  assert.doesNotMatch(wallet, /data-open-spending-manage|wallet-square/);
  assert.doesNotMatch(app, /\[data-open-spending-manage\]/);
  assert.doesNotMatch(css, /\.wallet-square|\.wallet-swap-card|\.wallet-swap-icon/);
  assert.match(wallet, /data-wallet-kaspa-card role="button"[^>]*aria-label="Kaspa balance, open Manage Addresses"/);
  assert.match(read("ui", "kusdt-screens.js"), /\[data-wallet-kaspa-card\]"\)\?\.addEventListener\("click"/);
});

test("Your Usernames' count is read on Wallet, without the old Profile screen's rows", () => {
  const start = app.indexOf("function refreshOwnProfileSummary(");
  const body = app.slice(start, app.indexOf("\n}\n", start));
  assert.match(body, /if \(!engine\.address\) return;/);
  assert.match(body, /refreshKachatOwnedCount\(\);/);
  assert.match(app, /if \(screenTab === "profile" \|\| screenTab === "wallet"\) refreshOwnProfileSummary\(\);/);
});

console.log(`${passed}/3 passed`);
