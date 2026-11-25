// KaChat iOS 4703f59b, 6aa8b515, 47ee52b1 and 58cfbf6f: the app is called K; its chats tab is KaChat and its
// wallet tab Wallet (KaPay for a few hours, reverted in 58cfbf6f); the sign-in screen's K globe; a kUSDT payment card in a 1:1 chat no longer vanishes for the payer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8");
const app = read("ui", "app.js");
const html = read("index.html");
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

/** A top-level `function name(...) {...}` of ui/app.js, by brace matching. */
function fnSource(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is in ui/app.js`);
  let depth = 0;
  // the body, past a destructured parameter list
  for (let i = app.indexOf(") {", start) + 2; i < app.length; i += 1) {
    if (app[i] === "{") depth += 1;
    else if (app[i] === "}" && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

function tokenSandbox() {
  const store = new Map();
  const context = {
    engine: { address: "kaspa:qpayer" },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    accountScopedKey: (base, address = context.engine.address) => `acct:${address}:${base}`,
    state: { conversations: [] },
    activeConversationId: null,
    renderMessages() {},
    lastMessageFor: (entry) => entry.messages[entry.messages.length - 1],
    store,
  };
  vm.createContext(context);
  vm.runInContext([
    'const TOKEN_PAYMENT_BUBBLES_KEY = "kachat-token-payment-bubbles-v1";',
    fnSource("normalizePaymentTxId"), fnSource("isPaymentBubble"),
    fnSource("tokenPaymentBubbleTxIds"), fnSource("markTokenPaymentBubble"),
    fnSource("removeSuppressedPaymentMessages"),
    "this.api = { tokenPaymentBubbleTxIds, markTokenPaymentBubble, removeSuppressedPaymentMessages };",
  ].join("\n"), context);
  return context;
}

const TOKEN_TX = "a".repeat(64);
const KAS_TX = "b".repeat(64);
const bubble = (id, txid) => ({ id, txid, messageType: "payment", transport: "kaspa-payment", direction: "outgoing", createdAt: 1 });

await test("a kUSDT card survives the contract suppression; a plain contract payment still goes", () => {
  const box = tokenSandbox();
  const chat = { id: "c1", messages: [bubble("m1", TOKEN_TX.toUpperCase()), bubble("m2", KAS_TX)], hiddenMessageKeys: [] };
  box.state.conversations = [chat];
  box.api.markTokenPaymentBubble(TOKEN_TX.toUpperCase(), "kaspa:qpayer");
  const removed = box.api.removeSuppressedPaymentMessages(new Set([TOKEN_TX, KAS_TX]));
  assert.equal(removed, 1);
  assert.deepEqual(chat.messages.map((m) => m.id), ["m1"]);
  assert.ok(!chat.hiddenMessageKeys.includes(TOKEN_TX.toUpperCase()));
});

await test("the list is per wallet, lowercased, without repeats, and keeps the newest 2,000", () => {
  const box = tokenSandbox();
  box.api.markTokenPaymentBubble(TOKEN_TX, "kaspa:qpayer");
  box.api.markTokenPaymentBubble(TOKEN_TX.toUpperCase(), "kaspa:qpayer");
  assert.equal(box.api.tokenPaymentBubbleTxIds().size, 1);
  assert.equal(box.api.tokenPaymentBubbleTxIds("kaspa:qother").size, 0);
  for (let i = 0; i < 2005; i += 1) box.api.markTokenPaymentBubble(i.toString(16).padStart(64, "0"), "kaspa:qpayer");
  const kept = box.api.tokenPaymentBubbleTxIds();
  assert.equal(kept.size, 2000);
  assert.ok(!kept.has(TOKEN_TX), "the oldest went");
  // another wallet's token cards don't protect this one's
  const other = tokenSandbox();
  other.api.markTokenPaymentBubble(TOKEN_TX, "kaspa:qsomeoneelse");
  const chat = { id: "c1", messages: [bubble("m1", TOKEN_TX)], hiddenMessageKeys: [] };
  other.state.conversations = [chat];
  assert.equal(other.api.removeSuppressedPaymentMessages(new Set([TOKEN_TX])), 1);
});

await test("every token card is listed: the payer's, our own notice read back, and the payee's", () => {
  const record = fnSource("recordTokenPayment");
  assert.match(record, /markTokenPaymentBubble\(txid, owner\);/);
  const handle = fnSource("handleTokenPaymentNotice");
  assert.match(handle, /markTokenPaymentBubble\(txId, walletAddress\);/);
  // a token payment's txid is always suppressed as a covenant transaction: not a reason to drop its notice
  assert.doesNotMatch(handle, /isSuppressedPaymentTxId/);
  const check = fnSource("checkReceivedTokenNotice");
  assert.match(check, /markTokenNoticeFiled\(txId, walletAddress\);\n\s*markTokenPaymentBubble\(txId, walletAddress\);/);
});

await test("the chats tab is KaChat; the wallet tab is Wallet again (58cfbf6f); Settings keeps Chats and Wallet", () => {
  assert.match(html, /<h1 class="kaposts-title chats-list-title">KaChat<\/h1>/);
  assert.match(html, /<h1 class="kaposts-title">Wallet<\/h1>/);
  assert.match(html, /data-app-tab="wallet">[\s\S]*?<span>Wallet<\/span>/);
  assert.match(html, /data-app-tab="chats"[^>]*>[\s\S]*?<span>KaChat<\/span>/);
  assert.match(html, /<p class="settings-group-label">Wallet<\/p>/);
  assert.match(html, /<p class="settings-group-label">Chats<\/p>/);
  assert.match(app, /wallet: "Wallet", kachat: ".kachat" \};/);
  const kusdt = read("ui", "kusdt-screens.js");
  assert.doesNotMatch(kusdt, /KaPay tab/);
  // K 5.4: Swap Stablecoins went; the Wallet's Swap button is named instead.
  assert.equal((kusdt.match(/Swap on the Wallet tab/g) || []).length, 2);
  assert.doesNotMatch(kusdt, /Swap Stablecoins on the Wallet tab/);
  assert.doesNotMatch(html, /KaPay<\/(span|h1)>/);
});

await test("sign-in shows the K globe over the new motto, smaller beside saved accounts (58cfbf6f)", () => {
  assert.match(html, /<h1 class="logged-out-logo"><img src="\.\/ui\/assets\/k-logo\.png" alt="K"/);
  assert.match(html, /<p class="logged-out-tagline">Digital Freedom on the Kaspa Network<\/p>/);
  assert.doesNotMatch(html, /Secure messaging on Kaspa BlockDAG/);
  assert.ok(readFileSync(join(here, "..", "ui", "assets", "k-logo.png")).length > 1000);
  assert.match(app, /classList\.toggle\("has-saved-accounts", accounts\.length > 0\)/);
  const css = read("ui", "styles.css");
  assert.match(css, /--onboarding-bg: #070d0e;/);
  assert.match(css, /\.has-saved-accounts \.logged-out-content > h1\.logged-out-logo \{ width: 76px; height: 76px; \}/);
  assert.match(css, /\.logged-out-content > h1\.logged-out-logo \{[^}]*width: 132px; height: 132px;/);
});

await test("the app is K: page title, home-screen name and the sentences that mean the app", () => {
  assert.match(html, /<title>K<\/title>/);
  assert.match(html, /apple-mobile-web-app-title" content="K"/);
  for (const file of ["manifest.json"]) {
    const manifest = JSON.parse(read("public", file));
    assert.equal(manifest.name, "K");
    assert.equal(manifest.short_name, "K");
  }
  for (const line of ["Welcome to K", "How K Uses Kaspa", "Think of it like your phone number on K.",
    "K is having trouble syncing right now.", "Open in K", "Unlock K", "Tap to open this public chat room."]) {
    assert.ok(app.includes(line), line);
  }
  assert.ok(read("ui", "kapost-moderation.js").includes("K has no tolerance for objectionable content"));
});

await test("KaChat stays where it names something real", () => {
  assert.match(app, /"Shared a KaChat profile"/);
  assert.match(app, /kachatLink: "KaChat Link"/);
  // the Nextcloud folder is "K" since K 961fc05a; "KaChat" is the old one it moves from
  assert.match(read("ui", "nextcloud.js"), /const DEFAULT_BACKUP_FOLDER = "K";\nconst LEGACY_BACKUP_FOLDER = "KaChat";/);
  assert.match(read("engine", "sync.js"), /export const DEFAULT_KASIA_ALIAS = "KaChat";/);
  assert.match(read("engine", "name-services.js"), /serviceName: "KaChat Names"/);
  // the hidden username password managers file the password under is unchanged
  assert.match(html, /autocomplete="username" value="KaChat"/);
});

console.log(`${passed}/7 passed`);
