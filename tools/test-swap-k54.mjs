// Swap as of K 5.4 (518fdc8c), with ChangeNOW, Trestly's pool code and the page all mocked: nothing
// here reaches api.changenow.io, api.trestly.io or a Kaspa node, and no key is real. Covers:
//   - comma decimals: "1,5" is 1.5 everywhere, never 15 (K audit 2026-11-24 #3);
//   - ChangeNOW's answer checked against the request, a missing payout address refused (#6);
//   - XRP destination tags: the payout tag's rules, `extraId` in the request only when given, the
//     deposit tag shown as required with Copy and kept in the swap record (#1);
//   - per-account history and agreements, and nothing kept without an account (#5);
//   - the kUSDT approval gate (engine/kusdt-trade.js): nothing is signed before Approve, a Decline
//     sends nothing, the key must be the address's own and leaves the request afterwards, a
//     requote is asked again, one trade per address, the spent coins held, and the 10-minute hold
//     after an unknown outcome (and its early end once a held coin is gone);
//   - Trestly's worker bridge allow-lists, the approval sheet's text and its arming;
//   - the coin list matches K's SwapCoin.curated, with kUSDT first in the picker.
// Run from the repo root:
//
//   node tools/test-swap-k54.mjs

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import { schnorr } from "@noble/curves/secp256k1.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const read = (...p) => readFileSync(join(repo, ...p), "utf8");

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (error) { failures.push(`${name}: ${error?.stack || error}`); }
}

// --- The page (for ui/swaps.js) ---------------------------------------------------------------------
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
globalThis.window = {
  setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
  clearTimeout: (id) => clearTimeout(id),
  open: () => {},
};
const handlers = {};
const root = {
  innerHTML: "",
  contains: () => false,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: (type, fn) => { handlers[type] = fn; },
};
globalThis.document = {
  activeElement: null,
  querySelector: (sel) => (sel === "[data-swaps-root]" ? root : null),
  addEventListener: () => {},
};

const calls = [];
let createAnswer = null;
window.fetch = async (url, init = {}) => {
  const text = String(url);
  calls.push({ url: text, method: init.method || "GET", body: init.body || null });
  const reply = (body) => ({ ok: true, status: 200, headers: { get: () => "" }, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
  if (text.includes("__swap")) return reply("on");
  if (text.includes("estimated-amount")) return reply({ fromAmount: 1.5, toAmount: 2.25 });
  if (init.method === "POST") return reply(createAnswer(JSON.parse(init.body)));
  return reply({});
};

const dataModule = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const STUBS = {
  "./portfolio.js": dataModule(`export const listPortfolios = () => []; export const addTransactionToPortfolio = () => {}; export const portfolioIdsContainingTx = () => new Set();`),
  "./dialogs.js": dataModule(`export const confirmDialog = async () => true;`),
  "../engine/endpoints.js": dataModule(`export const proxiedUrl = (url) => "/nc-proxy/" + encodeURIComponent(url); export const getEndpoint = () => "";`),
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/\/ui\/swaps\.js$/.test(context.parentURL || "") && STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
    if (/\.(css|png)$/.test(specifier)) return { url: dataModule(`export default "asset";`), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const Q = await import("../ui/swap-quote.js");
const TR = await import("../engine/kusdt-trade.js");
const K = await import("../engine/kusdt.js");
const CORE = await import("../engine/kusdt-core.js");
const BR = await import("../engine/kusdt-wallet-bridge.js");
const AP = await import("../ui/swap-approval.js");
const AM = await import("../engine/amounts.js");
const XRP = Q.CURATED_COINS.find((c) => c.ticker === "xrp");

// ---------------------------------------------------------------------------------------------------
// 1. Comma decimals
// ---------------------------------------------------------------------------------------------------
await check("comma decimals: \"1,5\" is 1.5, never 15, for ChangeNOW and both kUSDT sides", () => {
  assert.equal(Q.cleanSwapAmount("1,5"), "1.5");
  assert.equal(Q.cleanSwapAmount("1,5", 6), "1.5");
  assert.equal(Q.cleanSwapAmount("0,123456789"), "0.12345678", "8 places at most");
  assert.equal(Q.cleanSwapAmount("0,1234567", 6), "0.123456", "kUSDT: 6");
  assert.equal(Q.cleanSwapAmount("1,2,3"), "1.23", "one decimal point only");
  assert.equal(Q.cleanSwapAmount("١٫٥"), "1.5", "Arabic digits and separator");
  assert.equal(TR.kusdtSwapAmountIn("1,5", { buying: false }), 1_500_000n, "selling 1,5 kUSDT is 1.5 kUSDT");
  assert.equal(TR.kusdtSwapAmountIn("1,5", { buying: true }), 150_000_000n, "spending 1,5 KAS is 1.5 KAS");
  assert.equal(TR.kusdtSwapAmountIn("15", { buying: false }), 15_000_000n);
  assert.equal(TR.kusdtSwapAmountIn("0", { buying: true }), null);
  assert.equal(TR.kusdtSwapAmountIn("", { buying: false }), null);
  // ui/swaps.js cleans as it reads the field (no `.replace(",", ".")` of a single comma)
  const swapsSource = read("ui", "swaps.js");
  assert.match(swapsSource, /const value = cleanSwapAmount\(field\.value, decimalsFor\(coin\)\);/);
  assert.doesNotMatch(swapsSource, /\.replace\(",", "\."\)/);
});

await check("exact amounts: ChangeNOW's numbers as 10^-8 units, however JSON wrote them", () => {
  assert.equal(Q.scaledAmount("1.5"), 150_000_000n);
  assert.equal(Q.scaledAmount(1e-7), 10n);
  assert.equal(Q.scaledAmount("1.5E+3"), 150_000_000_000n);
  assert.equal(Q.scaledAmount(0.1 + 0.2), 30_000_000n, "cut at 8 places, no float drift into the comparison");
  assert.equal(Q.scaledAmount("abc"), null);
  assert.equal(Q.scaledAmount(""), null);
});

// ---------------------------------------------------------------------------------------------------
// 2. ChangeNOW's answer
// ---------------------------------------------------------------------------------------------------
await check("ChangeNOW's answer must be the exchange asked for; no payout address is refused", () => {
  const ask = { from: XRP, to: Q.KAS, amountText: "100", payoutAddress: "kaspa:qpayout", extraId: null };
  const good = { id: "x", payinAddress: "rDeposit", payoutAddress: "kaspa:qpayout", fromCurrency: "xrp", toCurrency: "kas", fromNetwork: "xrp", toNetwork: "kas", fromAmount: 100 };
  assert.equal(Q.answerMatches(good, ask), true);
  assert.equal(Q.answerMatches({ ...good, payoutAddress: "KASPA:QPAYOUT" }, ask), true, "letter case aside");
  assert.equal(Q.answerMatches({ ...good, payoutAddress: undefined }, ask), false, "no payout address: refused");
  assert.equal(Q.answerMatches({ ...good, payoutAddress: "" }, ask), false, "empty payout address: refused");
  assert.equal(Q.answerMatches({ ...good, payoutAddress: "kaspa:qsomeoneelse" }, ask), false, "another payout address");
  assert.equal(Q.answerMatches({ ...good, toCurrency: "btc" }, ask), false, "another coin");
  assert.equal(Q.answerMatches({ ...good, fromNetwork: "eth" }, ask), false, "another network");
  assert.equal(Q.answerMatches({ ...good, fromCurrency: undefined, toNetwork: null }, ask), true, "fields it leaves out aren't held against it");
  assert.equal(Q.answerMatches({ ...good, fromAmount: 100.99 }, ask), true, "within 1%");
  assert.equal(Q.answerMatches({ ...good, fromAmount: 101.01 }, ask), false, "more than 1% over");
  assert.equal(Q.answerMatches({ ...good, fromAmount: 98.9 }, ask), false, "more than 1% under");
  assert.equal(Q.answerMatches({ ...good, fromAmount: "abc" }, ask), false, "an unreadable amount");
  assert.equal(Q.answerMatches({ ...good, payoutExtraId: "999" }, { ...ask, extraId: "123" }), false, "another payout tag echoed");
  assert.equal(Q.answerMatches({ ...good, payoutExtraId: "123" }, { ...ask, extraId: "123" }), true);
});

// ---------------------------------------------------------------------------------------------------
// 3. XRP tags
// ---------------------------------------------------------------------------------------------------
await check("XRP: needs a tag; the payout tag is a whole number below 2^32", () => {
  assert.equal(Q.needsMemo(XRP), true);
  for (const coin of [Q.KAS, Q.KUSDT_COIN, ...Q.CURATED_COINS.filter((c) => c.ticker !== "xrp")]) assert.equal(Q.needsMemo(coin), false, coin.displayName);
  assert.equal(Q.isValidMemo(XRP, ""), true, "none is fine");
  assert.equal(Q.isValidMemo(XRP, " 123 "), true);
  assert.equal(Q.isValidMemo(XRP, "4294967295"), true);
  assert.equal(Q.isValidMemo(XRP, "4294967296"), false, "2^32");
  assert.equal(Q.isValidMemo(XRP, "12a"), false);
  assert.equal(Q.isValidMemo(XRP, "-1"), false);
  assert.equal(Q.isValidMemo(XRP, "1.5"), false);
  assert.equal(Q.payoutExtraIdFor(XRP, " 77 "), "77");
  assert.equal(Q.payoutExtraIdFor(XRP, "  "), null);
  assert.equal(Q.payoutExtraIdFor(Q.KAS, "77"), null, "only for a coin that takes one");
});

await check("XRP: extraId goes in the create request only when given", async () => {
  const bodies = [];
  const client = Q.createChangeNowClient({
    fetchImpl: async (url, init) => { bodies.push(JSON.parse(init.body || "{}")); return { ok: true, status: 200, headers: { get: () => "" }, text: async () => "{}" }; },
  });
  await client.create(Q.KAS, XRP, "10", "rPayout", "42");
  await client.create(Q.KAS, XRP, "10", "rPayout");
  assert.equal(bodies[0].extraId, "42");
  assert.ok(!("extraId" in bodies[1]), "no tag, no field");
});

// ---------------------------------------------------------------------------------------------------
// The screen (ui/swaps.js) against the mocked ChangeNOW
// ---------------------------------------------------------------------------------------------------
let account = "kaspa:qalice";
const addressesOf = { "kaspa:qalice": ["kaspa:qalice-0", "kaspa:qalice-1"], "kaspa:qbob": ["kaspa:qbob-0", "kaspa:qbob-1"] };
const toasts = [];
const deps = {
  engine: { drawQrFor: async () => {} },
  escapeHtml: (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  accountScopedKey: (key) => (account ? `kachat-account-data-v1:${account}:${key}` : key),
  nextFreshSpendingIndex: () => 1,
  spendingAddressAt: (index) => addressesOf[account]?.[index] || "",
  revealNextSwapAddress: async () => 1,
  showToast: (t) => toasts.push(t),
  currencySymbol: () => "$",
  copyTextToClipboard: async () => {},
  account: () => account,
};
const HISTORY = (who) => `kachat-account-data-v1:${who}:kachat-swap-history-v1`;
const AGREED = (who, kind = "changenow") => `kachat-account-data-v1:${who}:kachat-swap-agreement-${kind}-v1`;
store.set(AGREED("kaspa:qalice"), "1");

const swaps = await import("../ui/swaps.js");
swaps.initSwaps(deps);
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
await settle();
const el = (attrs) => ({ closest: (sel) => { const m = /^\[([^\]=]+)\]$/.exec(sel); if (!m || !(m[1] in attrs)) return null; const node = attrs[m[1]]; node.dataset ??= {}; return node; } });
const typeInto = async (field, value) => {
  const target = { value, dataset: { swapField: field }, readOnly: false };
  handlers.input({ target: el({ "data-swap-field": target }) });
  await settle();
  return target;
};
const typePayout = (value) => handlers.input({ target: el({ "data-swap-payout": { value } }) });
const typeTag = (value) => handlers.input({ target: el({ "data-swap-payout-tag": { value } }) });
const click = async (attr) => { handlers.click({ target: el({ [attr]: {} }) }); await settle(); };
const historyOf = (who) => JSON.parse(store.get(HISTORY(who)) || "[]");
const posts = () => calls.filter((c) => c.method === "POST");

await check("the field is cleaned as it's typed: 1,5 reaches ChangeNOW as 1.5", async () => {
  swaps.selectSwapCoin("xrp:xrp");
  const field = await typeInto("send", "1,5");
  assert.equal(field.value, "1.5", "the field shows the cleaned figure");
  await settle();
  const quote = calls.filter((c) => c.url.includes("estimated-amount")).pop();
  assert.ok(quote && decodeURIComponent(quote.url).includes("fromAmount=1.5"), "quoted for 1.5");
  assert.ok(!decodeURIComponent(quote.url).includes("fromAmount=15"), "never 15");
});

await check("XRP -> KAS: the deposit tag shows as required, with Copy, and is kept with the swap", async () => {
  createAnswer = (body) => ({ id: "ex-xrp", payinAddress: "rChangeNowShared", payinExtraId: " 987654 ", payoutAddress: body.address, fromCurrency: "xrp", toCurrency: "kas", fromAmount: Number(body.fromAmount), toAmount: 2.25, status: "waiting" });
  await typeInto("send", "1,5");
  await settle();
  await click("data-swap-create");
  await settle();
  const html = root.innerHTML;
  // its own deposit screen since K 824a30bb
  assert.match(html, /Send 1\.5 XRP/);
  assert.match(html, /to buy Kaspa/);
  assert.match(html, /Amount to Send[\s\S]*1\.5 XRP/);
  assert.match(html, /Destination Tag \(Memo\)/);
  assert.match(html, /data-swap-copy-tag="987654"/);
  assert.match(html, /Copy Destination Tag/);
  assert.match(html, /Required: send with this destination tag \(memo\), or the deposit can(?:'|&#39;)t be credited and may be lost\./);
  const record = historyOf("kaspa:qalice").find((s) => s.id === "ex-xrp");
  assert.equal(record?.payinExtraId, "987654", "the tag is in the swap record");
  assert.equal(record?.fromAmount, "1.5");
  assert.equal(record?.payoutAddress, "kaspa:qalice-1");
});

await check("KAS -> XRP: a payout tag field; a bad tag is refused before ChangeNOW; a good one goes as extraId", async () => {
  // Sell Kaspa, then XRP: the order (K 824a30bb, no flip)
  swaps.openSwapFlow("sell");
  handlers.click({ target: el({ "data-swap-choice": { dataset: { swapChoice: "xrp:xrp" } } }) });
  await settle();
  assert.doesNotMatch(root.innerHTML, /rChangeNowShared/, "a new order never shows the old deposit");
  assert.match(root.innerHTML, /Sell Kaspa for XRP/);
  assert.match(root.innerHTML, /data-swap-payout-tag/);
  assert.match(root.innerHTML, /Destination tag \(optional\)/);
  typePayout("rMyExchange");
  typeTag("12x");
  await typeInto("send", "10");
  const before = posts().length;
  await click("data-swap-create");
  assert.equal(posts().length, before, "nothing asked of ChangeNOW for a bad tag");
  assert.ok(toasts.includes(swaps.SWAP_TEXT.badTag));
  typeTag("4242");
  createAnswer = (body) => ({ id: "ex-kas-xrp", payinAddress: "kaspa:qdeposit", payoutAddress: body.address, payoutExtraId: body.extraId, fromAmount: 10, toAmount: 5, status: "new" });
  await typeInto("send", "10");
  await click("data-swap-create");
  await settle();
  const body = JSON.parse(posts().pop().body);
  assert.equal(body.extraId, "4242");
  assert.equal(body.address, "rMyExchange");
  const record = historyOf("kaspa:qalice").find((s) => s.id === "ex-kas-xrp");
  assert.equal(record?.payoutExtraId, "4242");
  assert.match(root.innerHTML, /to sell it for XRP/);
  assert.match(root.innerHTML, /data-swap-send-kas="ex-kas-xrp"/, "Kaspa in: Send KAS from K");
});

await check("an answer that doesn't match is refused: no deposit address shows, nothing is filed", async () => {
  createAnswer = () => ({ id: "ex-bad", payinAddress: "kaspa:qbaddeposit", payoutAddress: "rSomeoneElse", fromAmount: 10, toAmount: 5, status: "new" });
  await typeInto("send", "10");
  await click("data-swap-create");
  await settle();
  assert.doesNotMatch(root.innerHTML, /qbaddeposit/);
  assert.ok(!historyOf("kaspa:qalice").some((s) => s.id === "ex-bad"));
  assert.ok(toasts.includes(swaps.SWAP_TEXT.answerMismatch));
});

// ---------------------------------------------------------------------------------------------------
// 4. Per account
// ---------------------------------------------------------------------------------------------------
await check("history and agreements are per account; another account starts clean and is asked again", async () => {
  assert.ok(historyOf("kaspa:qalice").length >= 2);
  account = "kaspa:qbob";
  swaps.resetSwapsForAccount();
  // Buy Kaspa with XRP: where it lands, then the order, where the agreement is asked
  swaps.selectSwapCoin("xrp:xrp");
  await click("data-swap-continue");
  assert.equal(historyOf("kaspa:qbob").length, 0);
  assert.doesNotMatch(root.innerHTML, /rChangeNowShared|kaspa:qalice/, "nothing of the other account on screen");
  assert.match(root.innerHTML, /Before You Swap/, "ChangeNOW's agreement asked on this account");
  assert.match(root.innerHTML, /data-swap-agreement="changenow"/);
  const quotesBefore = calls.filter((c) => c.url.includes("estimated-amount")).length;
  await typeInto("send", "5");
  await settle();
  assert.equal(calls.filter((c) => c.url.includes("estimated-amount")).length, quotesBefore, "no quote before the agreement");
  // the keys are account-scoped, so removing the account (every key under its prefix) takes them
  const keys = [...store.keys()].filter((k) => k.includes("kachat-swap"));
  assert.ok(keys.every((k) => k.startsWith("kachat-account-data-v1:kaspa:q")), keys.join(", "));
  // no account: nothing read or kept under a bare key
  account = "";
  swaps.resetSwapsForAccount();
  assert.ok(![...store.keys()].some((k) => k === "kachat-swap-history-v1"));
  account = "kaspa:qalice";
  swaps.resetSwapsForAccount();
});

await check("each agreement is asked before its own kind: Trestly's for kUSDT, linking to /terms", async () => {
  swaps.selectSwapCoin("kusdt");
  assert.match(root.innerHTML, /data-swap-agreement="trestly"/);
  assert.match(root.innerHTML, /href="https:\/\/trestly\.io\/terms"/);
  assert.match(root.innerHTML.replaceAll("&#39;", "'"), /I understand Trestly is a third party, not K, and I agree to Trestly's Terms of Service\./);
  await click("data-swap-not-now");
  assert.match(root.innerHTML, /XRP/, "Not Now goes back to the coin picked before");
  assert.doesNotMatch(root.innerHTML, /data-swap-agreement=/, "ChangeNOW's is already accepted here");
});

// ---------------------------------------------------------------------------------------------------
// 5. The kUSDT approval gate (engine/kusdt-trade.js)
// ---------------------------------------------------------------------------------------------------
const hexOf = (b) => Buffer.from(b).toString("hex");
const skA = "01".repeat(32);
const skB = "02".repeat(32);
const ownerA = schnorr.getPublicKey(Buffer.from(skA, "hex"));
const addrA = K.addressOfOwner(ownerA, "mainnet");
const targetA = { label: "Chatting Address", address: addrA, spendingIndex: null };

function harness({ execute = () => ({ result: { txid: "a".repeat(64), amountOut: "260000", confirmed: true }, fee: "2000", steps: [], inputs: [`${"c".repeat(64)}:0`] }), key = skA } = {}) {
  const log = [];
  let clock = 1_000_000;
  const holdsStore = new Map();
  let present = [`${"b".repeat(64)}:1`, `${"b".repeat(64)}:2`];
  const executeRequests = [];
  const h = {
    log, executeRequests,
    spent: [],
    advance(ms) { clock += ms; },
    setPresent(list) { present = list; },
    trade: TR.createTrestlyTrade({
      walletCall: async (fn, request) => {
        log.push(`${fn}${request.wallet?.secret ? "+key" : ""}`);
        if (fn === "prepare") {
          assert.ok(!request.wallet.secret, "prepare never carries a key");
          return { kind: "swap", side: request.params.side, amountIn: request.params.amountIn, minOut: request.params.minOut, quote: "260000", feeAbout: "3000", feerate: 1, acceptedFee: null, tokenValue: "150000000", paused: false, breaker: null, belowMinimum: false, feeShare: false, blocked: false };
        }
        executeRequests.push({ object: request, text: JSON.stringify(request) });
        return execute(request, executeRequests.length);
      },
      network: () => "mainnet",
      apiUrl: () => "https://api.trestly.io/api/v1",
      storage: { getItem: (k) => holdsStore.get(k) ?? null, setItem: (k, v) => holdsStore.set(k, v), removeItem: (k) => holdsStore.delete(k) },
      now: () => clock,
      outpointsOf: async () => [...present],
      secretFor: () => { log.push("key"); return key; },
      noteSpentOutpoints: (keys) => h.spent.push(...keys),
      markOwnTransaction: (txid) => log.push(`own:${txid.slice(0, 4)}`),
      afterTrade: () => log.push("after"),
    }),
  };
  return h;
}
const params = { side: "buy", amountIn: "1000000000", minOut: String(TR.minimumOut(260000n)) };

await check("minimumOut is 1% under the quote and can't underflow", () => {
  assert.equal(TR.minimumOut(260000n), 257400n);
  assert.equal(TR.minimumOut(99n), 99n);
  assert.equal(TR.minimumOut(1n), 1n);
  assert.equal(TR.minimumOut(0n), 0n);
});

await check("Decline: nothing is signed or sent, and no key is ever taken", async () => {
  const h = harness();
  let asked = null;
  await assert.rejects(h.trade.run({ method: "kusdt_swap", params, target: targetA, native: true, ask: async (req) => { asked = req; return false; } }),
    (e) => e.code === TR.TRADE_CODE.rejected && /Nothing was sent/.test(e.message));
  assert.deepEqual(h.log, ["prepare"]);
  assert.equal(asked.native, true);
  assert.equal(asked.prepared.quote, "260000");
});

await check("a screen closed while the sheet was up counts as a Decline", async () => {
  const h = harness();
  await assert.rejects(h.trade.run({ method: "kusdt_swap", params, target: targetA, ask: async () => true, isClosed: () => true }), (e) => e.code === TR.TRADE_CODE.rejected);
  assert.ok(!h.log.includes("key") && !h.log.includes("execute+key"));
});

await check("Approve: the key is taken only after it, goes to execute once, and leaves the request after", async () => {
  const h = harness();
  const order = [];
  const done = await h.trade.run({ method: "kusdt_swap", params, target: targetA, native: true, ask: async () => { order.push(`ask after ${h.log.join(",")}`); return true; } });
  assert.deepEqual(order, ["ask after prepare"], "asked before any key");
  assert.deepEqual(h.log.slice(0, 3), ["prepare", "key", "execute+key"]);
  assert.ok(h.executeRequests[0].text.includes(skA), "execute had the key");
  assert.equal(h.executeRequests[0].object.wallet, undefined, "the request's copy is gone afterwards");
  assert.equal(JSON.parse(h.executeRequests[0].text).quoted, "260000", "execute holds Trestly's code to the quote approved");
  assert.equal(JSON.parse(h.executeRequests[0].text).shownFeerate, 1);
  assert.deepEqual(h.spent, [`${"c".repeat(64)}:0`], "the coins it spent are held like a send's");
  assert.ok(h.log.includes("after"));
  const rec = TR.swapRecord(done);
  assert.equal(rec.text, "Swapped 10 KAS for 0.26 kUSDT");
  assert.equal(rec.kusdtUnits, 260000n);
  assert.equal(rec.sold, false);
});

await check("a key that isn't the address's own (another account) is refused, nothing sent", async () => {
  const h = harness({ key: skB });
  await assert.rejects(h.trade.run({ method: "kusdt_swap", params, target: targetA, ask: async () => true }),
    (e) => /doesn't belong to the account that's open now\. Nothing was sent\./.test(e.message));
  assert.ok(!h.log.includes("execute+key"));
});

await check("the key is dropped from the request even when execute fails", async () => {
  const h = harness({ execute: () => ({ error: "The node refused it." }) });
  await assert.rejects(h.trade.run({ method: "kusdt_swap", params, target: targetA, ask: async () => true }), (e) => e.message === "The node refused it." && !e.maybeSent);
  assert.equal(h.executeRequests[0].object.wallet, undefined);
  assert.equal(h.trade.isBusy(addrA), false);
});

await check("a requote is asked again, showing what was seen; Decline then sends nothing more", async () => {
  const h = harness({ execute: (req, n) => (n === 1 ? { requote: "250000", seen: "260000", steps: [] } : { result: { txid: "d".repeat(64), amountOut: "250000" } }) });
  const asks = [];
  await assert.rejects(h.trade.run({ method: "kusdt_swap", params, target: targetA, ask: async (req) => { asks.push(req); return asks.length === 1; } }),
    (e) => e.code === TR.TRADE_CODE.rejected);
  assert.equal(asks.length, 2);
  assert.equal(asks[0].seen, null);
  assert.equal(asks[1].seen.quote, "260000", "the second sheet shows what was approved before");
  assert.deepEqual(h.log, ["prepare", "key", "execute+key", "prepare"]);
});

await check("one trade per address at a time", async () => {
  const h = harness();
  let release;
  const first = h.trade.run({ method: "kusdt_swap", params, target: targetA, ask: () => new Promise((r) => { release = r; }) });
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(h.trade.run({ method: "kusdt_swap", params, target: targetA, ask: async () => true }), (e) => e.code === TR.TRADE_CODE.busy);
  release(false);
  await assert.rejects(first);
});

await check("an unknown outcome holds the address for 10 minutes, its coins reserved; it ends early once one is spent", async () => {
  const h = harness({ execute: () => { throw new CORE.KusdtCoreError("maybeSent", "Trestly's pool code gave no answer."); } });
  await assert.rejects(h.trade.run({ method: "kusdt_swap", params, target: targetA, ask: async () => true }),
    (e) => e.maybeSent === true && /may have gone through/.test(e.message) && /Check the address's history/.test(e.message));
  assert.deepEqual(h.spent, [`${"b".repeat(64)}:1`, `${"b".repeat(64)}:2`], "the coins it had are reserved");
  assert.equal(await h.trade.heldMinutes(addrA), 10);
  const before = h.log.length;
  await assert.rejects(h.trade.run({ method: "kusdt_swap", params, target: targetA, ask: async () => true }),
    (e) => e.code === TR.TRADE_CODE.busy && /may still go through/.test(e.message));
  assert.equal(h.log.length, before, "a held address isn't even quoted");
  h.advance(4 * 60_000);
  assert.equal(await h.trade.heldMinutes(addrA), 6);
  h.setPresent([`${"b".repeat(64)}:2`]);
  assert.equal(await h.trade.heldMinutes(addrA), null, "a coin it had is gone: the trade landed, the hold ends");
});

await check("the hold runs out after 10 minutes, and their own maybeSent answer holds too", async () => {
  const h = harness({ execute: () => ({ error: "Sent, but the node didn't confirm.", maybeSent: true }) });
  await assert.rejects(h.trade.run({ method: "kusdt_swap", params, target: targetA, ask: async () => true }), (e) => e.maybeSent);
  h.advance(9 * 60_000);
  assert.equal(await h.trade.heldMinutes(addrA), 1);
  h.advance(60_001);
  assert.equal(await h.trade.heldMinutes(addrA), null);
});

await check("pool code that gives no answer to execute is 'may have gone out' (the wallet worker)", async () => {
  const W = await import("../engine/kusdt-wallet-core.js");
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const sha = await CORE.sha256Hex(bytes);
  const fake = () => {
    const w = { postMessage(m) {
      if (m.type === "init") setTimeout(() => w.onmessage({ data: { type: "ready", version: "test" } }), 0);
      if (m.type === "run") setTimeout(() => w.onmessage({ data: m.command === "prepare" ? { type: "answer", id: m.id, answer: '{"error":"paused","code":-32603}' } : { type: "error", id: m.id, error: "died" } }), 0);
    }, terminate() {} };
    return w;
  };
  const core = W.createKusdtWalletCore({ workerFactory: fake, fetchWasm: async () => bytes, expectedSha256: sha });
  const prepared = await core.walletCall("prepare", { method: "kusdt_swap" });
  assert.equal(prepared.error, "paused", "their refusal comes back whole");
  await assert.rejects(core.walletCall("execute", { method: "kusdt_swap" }), (e) => e.code === "maybeSent");
  const noWorker = W.createKusdtWalletCore({ workerFactory: () => null, fetchWasm: async () => bytes, expectedSha256: sha });
  await assert.rejects(noWorker.walletCall("prepare", {}), (e) => e.code === "unavailable", "never on the page's own thread");
});

await check("the kUSDT quote and rate are exact", () => {
  assert.equal(TR.kusdtQuoteText(260000n, { buying: true }), "0.26");
  assert.equal(TR.kusdtQuoteText(1_234_567_890n, { buying: false }), "12.3456789");
  assert.equal(TR.kusdtRateText({ buying: true, amountIn: 1_000_000_000n, quote: 260000n }), "1 KAS ≈ 0.02600000 kUSDT (Kaspa)");
  assert.equal(TR.kusdtRateText({ buying: false, amountIn: 1_000_000n, quote: 3_846_153_846n }), "1 kUSDT (Kaspa) ≈ 38.46153846 KAS");
});

// ---------------------------------------------------------------------------------------------------
// 6. The approval sheet, the worker bridge
// ---------------------------------------------------------------------------------------------------
await check("the approval sheet: Trestly's numbers exactly, its warnings, Approve off until armed and while blocked", () => {
  const esc = (s) => String(s);
  const prepared = { side: "buy", amountIn: "1000000000", quote: "260000", minOut: "257400", tokenValue: "150000000", feeAbout: "3000", paused: true, belowMinimum: true, blocked: true };
  const html = AP.approvalSheetHtml({ method: "kusdt_swap", prepared, seen: { quote: "270000" }, from: "Chatting Address", native: true }, { esc });
  for (const text of ["Through Trestly's pool", "Buy kUSDT", "You Pay", "10 KAS", "You Receive", "0.26 kUSDT", "You Saw", "0.27 kUSDT",
    "Minimum You Get", "0.2574 kUSDT", "Kept in Your Token", "1.5 KAS", "about 0.00003 KAS", AP.APPROVAL_TEXT.requote, AP.APPROVAL_TEXT.paused,
    AP.APPROVAL_TEXT.belowMinimum, AP.APPROVAL_TEXT.note, AP.APPROVAL_TEXT.nodes]) assert.ok(html.includes(text), text);
  assert.match(html, /data-swap-approval-approve disabled/, "Approve starts off");
  assert.equal(AP.approvalBlocked(prepared), true);
  assert.equal(AP.APPROVE_ARM_MS, 800);
  const breaker = AP.approvalWarnings({ breaker: JSON.stringify({ maxKasOut: "500000000", fit: "0" }) });
  assert.match(breaker[0], /at most 5 KAS more right now/);
  assert.equal(breaker[1], AP.APPROVAL_TEXT.noSellFits);
  const swaps = read("ui", "swaps.js");
  assert.match(swaps, /if \(button && !approvalBlocked\(request\.prepared\)\) button\.disabled = false;/, "armed after APPROVE_ARM_MS");
  assert.match(swaps, /if \(approve && !approve\.disabled && approval && !approvalBlocked\(approval\.request\.prepared\)\) answerApproval\(true\);/);
  assert.match(swaps, /if \(name === "approval"\) answerApproval\(false\);/, "closing declines");
});

await check("Trestly's worker reaches only its API host and the public Kaspa nodes", async () => {
  const api = ["api.trestly.io"];
  assert.equal(BR.allowedFetchUrl("https://api.trestly.io/api/v1/pool", api), true);
  assert.equal(BR.allowedFetchUrl("https://eric.kaspa.stream/v2/kaspa/mainnet/tls/wrpc/borsh", api), true);
  assert.equal(BR.allowedFetchUrl("https://evil.example/x", api), false);
  assert.equal(BR.allowedFetchUrl("http://api.trestly.io/api/v1/pool", api), false, "https only");
  assert.equal(BR.allowedFetchUrl("https://user:pw@api.trestly.io/", api), false);
  assert.equal(BR.allowedFetchUrl("https://kaspa.stream.evil.example/", api), false);
  assert.equal(BR.allowedSocketUrl("wss://maxim.kaspa.red/kaspa/mainnet/wrpc/json"), true);
  assert.equal(BR.allowedSocketUrl("wss://evil.example/"), false);
  assert.equal(BR.allowedSocketUrl("ws://maxim.kaspa.red/"), false);
  assert.equal(BR.apiHostOf("https://api.trestly.io/api/v1"), "api.trestly.io");
  let fetched = 0;
  const refused = await BR.relayFetch({ url: "https://evil.example/", method: "GET" }, { fetchImpl: async () => { fetched += 1; }, apiHosts: api });
  assert.match(refused.error, /doesn't let this reach evil\.example/);
  assert.equal(fetched, 0, "never even asked");
  let sent = null;
  const ok = await BR.relayFetch({ url: "https://api.trestly.io/api/v1/pool", method: "POST", headers: { "Content-Type": "application/json", Cookie: "x", Authorization: "y" }, body: "{}" },
    { fetchImpl: async (url, init) => { sent = init; return new Response('{"ok":1}', { status: 200, headers: { "content-type": "application/json" } }); }, apiHosts: api });
  assert.equal(ok.status, 200);
  assert.equal(ok.body, '{"ok":1}');
  assert.deepEqual(Object.keys(sent.headers), ["content-type"], "no cookies or credentials go out");
  assert.equal(sent.redirect, "error");
  assert.equal(sent.credentials, "omit");
  const big = await BR.relayFetch({ url: "https://api.trestly.io/x" }, { fetchImpl: async () => new Response("x".repeat(BR.MAX_ANSWER_BYTES + 1)), apiHosts: api });
  assert.equal(big.error, "answer too long");
  const memory = BR.createMemoryStore();
  memory.handle({ op: "set", values: { "kusdt.known.mainnet.ab": [1], other: 2 } });
  assert.deepEqual(memory.handle({ op: "get", keys: ["kusdt.known.mainnet.ab", "other"] }).value, { "kusdt.known.mainnet.ab": [1] });
  // the worker installs the bridge before their code runs
  const worker = read("engine", "kusdt-wallet-worker.js");
  assert.ok(worker.indexOf('import { bridge } from "./kusdt-wallet-install.js";') < worker.indexOf('import "../kusdt/kusdt-wallet.js";'));
  assert.match(read("engine", "kusdt-wallet-core.js"), /never on the page's own thread/);
  assert.doesNotMatch(read("engine", "kusdt-wallet-bridge.js"), /nc-proxy\//);
});

await check("Trestly's pool code is the pinned copy of K's", () => {
  const sums = read("kusdt", "SHA256SUMS");
  assert.match(sums, /^6631a35d5c0fc2ceb00ac08611379442e6a8fe75aec36dbcb530343ffd439cb2 {2}kusdt-wallet\.js$/m);
  assert.match(read("tools", "check-wasm.sh"), /"kusdt-wallet\.js"\]/);
  assert.ok(existsSync(join(repo, "kusdt", "kusdt-wallet.js")));
});

// ---------------------------------------------------------------------------------------------------
// 7. Coins, text
// ---------------------------------------------------------------------------------------------------
await check("the coin list is K's SwapCoin.curated, in order; kUSDT is first in the picker; every logo is there", () => {
  const curated = [
    "btc:btc", "eth:eth", "sol:sol", "xrp:xrp", "bnb:bsc", "trx:trx", "hype:hyperevm", "doge:doge", "ltc:ltc", "zec:zec", "xmr:xmr", "ada:ada", "bch:bch", "etc:etc",
    "usdt:eth", "usdt:trx", "usdt:bsc", "usdt:sol", "usdt:matic", "usdt:arbitrum", "usdt:op",
    "usdc:matic", "usdc:eth", "usdc:sol", "usdc:bsc", "usdc:algo", "usdc:op", "usdc:arbitrum", "usdc:base", "usdc:sui",
  ];
  assert.deepEqual(Q.CURATED_COINS.map((c) => `${c.ticker}:${c.network}`), curated);
  assert.deepEqual({ ...Q.KUSDT_COIN }, { ticker: "kusdt", network: "kaspa-trestly", displayName: "kUSDT (Kaspa)" });
  assert.equal(Q.coinByKey("kusdt:kaspa-trestly"), Q.KUSDT_COIN);
  assert.match(read("ui", "swaps.js"), /const rows = \[\{ kind: "coin", coin: KUSDT_COIN \}\];/);
  for (const t of ["ada", "bch", "bnb", "btc", "doge", "etc", "eth", "hype", "ltc", "sol", "trx", "usdc", "usdt", "xmr", "xrp", "zec"]) {
    assert.ok(existsSync(join(repo, "ui", "assets", "coins", `coin_${t}.png`)), t);
  }
});

await check("text: status names in words, whole sentences for Buy and Sell (#34, #35)", () => {
  assert.equal(Q.swapStatusName("finished"), "Finished");
  assert.equal(Q.swapStatusName("WAITING"), "Waiting");
  assert.equal(Q.swapStatusName("expired"), "Expired");
  assert.equal(Q.swapStatusName("some_new_state"), "Some_New_State");
  assert.equal(swaps.portfolioPromptText({ type: "buy", amountKas: 12.5, fiatValue: 3 }, "$"), "Buy 12.5 KAS at $3.00 - choose which portfolio to add it to.");
  assert.equal(swaps.portfolioPromptText({ type: "sell", amountKas: 1, fiatValue: 0.5 }, "$"), "Sell 1 KAS at $0.50 - choose which portfolio to add it to.");
  assert.doesNotMatch(read("ui", "swaps.js"), /\$\{prefill\.type === "buy" \? "Buy" : "Sell"\}/);
});

await check("the Wallet: Send, Receive, Buy, Sell (K 824a30bb); Request Payment and Buy/Sell History are cards", () => {
  const html = read("index.html");
  const app = read("ui", "app.js");
  const row = html.slice(html.indexOf('<div class="wallet-actions">'), html.indexOf("data-backup-hygiene-card"));
  const order = ["data-wallet-send", "data-wallet-receive", "data-wallet-buy", "data-wallet-sell"].map((m) => row.indexOf(m));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), "Send, Receive, Buy, Sell");
  assert.doesNotMatch(row, /data-wallet-request|data-wallet-swap-action/);
  assert.match(html, /data-wallet-request>[\s\S]*?<span>Request Payment<\/span>/);
  assert.match(html, /data-wallet-swap-history>[\s\S]*?<span>Buy\/Sell History<\/span>/);
  assert.doesNotMatch(app, /walletSwapAction\.hidden|tabAllowed/);
  // Buy first asks Crypto or Debit Card on mainnet (tools/test-debit-card-buy.mjs)
  assert.match(app, /\[data-wallet-buy\]"\)\?\.addEventListener\("click", \(\) => openBuyKaspa\(\)\);/);
  assert.match(app, /\[data-wallet-sell\]"\)\?\.addEventListener\("click", \(\) => openBuySell\("sell"\)\);/);
  assert.equal(AM.sanitizeAmountInput("1,5"), "1.5");
});

if (failures.length) {
  console.error(`test-swap-k54: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log(`test-swap-k54: ${passed} passed`);
process.exit(0);
