// node tools/test-ios-01f71184-wallet.mjs - K 01f71184 (release audit and smoothness fixes,
// 2026-11-27), the wallet side Desktop shares: address cards read "0 KAS" when empty; the Wallet
// card's worth is to the cent; Choose an Address lists regular addresses, then quantum ones with
// their tag; the Send To step says a resolved name once; Cold Storage keeps earlier Used answers,
// asks again about rows whose balance moved, and reloads once after activity without cutting a
// load short; Explorer rows never read "−0 KAS", kUSDT is to the cent, "K Message" / "Post"; a
// Trestly hold ends early only while this page still holds its coins; Swap's QR is made once; the
// contacts export says K.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fiatFixedText, addressCardKasText } from "../ui/wallet-balance.js";
import { recipientStatusHtml, ownAddressQuantumTagHtml, ownAddressSpendingOrder } from "../ui/send-kaspa-components.js";
import { coldUsedRecheck, coldActivityReloader } from "../ui/cold-cards.js";
import { shortKas, explorerKusdt, perspectiveAmount, TX_KINDS } from "../engine/explorer.js";
import { QUANTUM_INDEX_BASE } from "../engine/quantum.js";
import { heldOutpointKeys, noteSpentOutpoints, clearJustSpentOutpoints } from "../engine/transactions.js";
import { addressBookExportFileName, ADDRESS_BOOK_IMPORT_NOT_AN_EXPORT } from "../ui/address-book-store.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const app = read("ui/app.js");
const cold = read("ui/coldstorage.js");
const swaps = read("ui/swaps.js");
const explorerUi = read("ui/explorer.js");
const trade = read("engine/kusdt-trade.js");

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`ok - ${name}`); }

await test("address cards: an empty address reads 0 KAS, a funded one keeps eight decimals", () => {
  assert.equal(addressCardKasText(0), "0 KAS");
  assert.equal(addressCardKasText("0.00000000"), "0 KAS");
  assert.equal(addressCardKasText(1.5), "1.50000000 KAS");
  assert.equal(addressCardKasText("0.00000001", "TKAS"), "0.00000001 TKAS");
  assert.equal(addressCardKasText(null), "-- KAS");
  assert.equal(addressCardKasText("--"), "-- KAS");
  // Manage Addresses' cards (chatting first row, provisional and live rows, the live chatting cell)
  assert.equal((app.match(/addressCardKasText\(/g) || []).length, 4);
  assert.doesNotMatch(app, /spendingRowHtml\([^\n]*formatKasExact/);
  // Cold Storage's account and address cards
  assert.match(cold, /function cardAmountText\(sompi\) \{\n\s+return sompi === undefined \|\| sompi === null \? `-- \$\{KAS_UNIT\}` : addressCardKasText\(Number\(sompi\) \/ 1e8, KAS_UNIT\);/);
  assert.match(cold, /if \(cell\) cell\.textContent = cardAmountText\(entry\.balanceSompi\);/);
});

await test("the Wallet card's worth is to the cent, as the address cards", () => {
  assert.equal(fiatFixedText(0.13994, "$", { locale: "en-US" }), "$0.14");
  assert.equal(fiatFixedText(1234.5, "$", { locale: "en-US" }), "$1,234.50");
  assert.equal(fiatFixedText(0, "€", { locale: "en-US" }), "€0.00");
  assert.equal(fiatFixedText(0.00001234, "₿", { decimals: 8, locale: "en-US" }), "₿0.00001234");
  assert.equal(fiatFixedText(NaN, "$"), "");
  assert.match(app, /kasFiatTextNow\(Number\(total\) \/ 1e8, renderProfileAccountTotal, \{ decimals: 2 \}\)/);
  assert.match(app, /renderSpendingList\(\); \}, \{ decimals: 2 \}\);/);
  assert.match(app, /kasFiatText: \(kas, onPrice\) => \(IS_TESTNET \? null : kasFiatTextNow\(kas, onPrice, \{ decimals: 2 \}\)\)/);
  assert.match(app, /if \(decimals != null\) return fiatFixedText\(value, currencyMeta\(\)\.symbol, \{ decimals: selectedCurrency === "btc" \? 8 : decimals \}\);/);
});

await test("Choose an Address: regular addresses by number, then quantum ones, each quantum one tagged", () => {
  const q = (n) => QUANTUM_INDEX_BASE + n;
  const order = ownAddressSpendingOrder([{ index: q(1) }, { index: 7 }, { index: q(0) }, { index: 1 }, { index: 0 }]).map((e) => e.index);
  assert.deepEqual(order, [0, 1, 7, q(0), q(1)]);
  assert.equal(ownAddressQuantumTagHtml({ quantum: false }), "");
  assert.equal(ownAddressQuantumTagHtml({ quantum: true }), '<span class="quantum-tag safe">Quantum Protected</span>');
  assert.equal(ownAddressQuantumTagHtml({ quantum: true, spent: true, funded: true }), '<span class="quantum-tag warn">Not Quantum Protected</span>');
  assert.equal(ownAddressQuantumTagHtml({ quantum: true, spent: true }), '<span class="quantum-tag plain">Not Quantum Protected</span>');
  const parts = read("ui/send-kaspa-components.js");
  assert.match(parts, /const spending = ownAddressSpendingOrder\(spendingShown\)/);
  assert.match(parts, /\$\{r\.quantumTag \|\| ""\}\n\s+<code class="sk-source-address">/);
  assert.match(app, /quantumSpent: \(address\) => isQuantumAddressSpentLocally\(address\),/);
  assert.match(read("ui/styles.css"), /\.sk-source-copy > \.quantum-tag \{ align-self: flex-start;/);
});

await test("Send To says a resolved name once: the card, no Resolved line under it", () => {
  const resolved = { input: "alice", resolvedAddress: "kaspa:qabc", resolvedName: "alice" };
  assert.equal(recipientStatusHtml({ ...resolved, cardShown: true }), "");
  // a screen without the card (a name's transfer sheet) still says what it resolved to
  assert.match(recipientStatusHtml(resolved), /✓ Resolved: alice/);
  assert.match(recipientStatusHtml({ input: "kaspa:qx", valid: true, cardShown: true }), /Valid address/);
  assert.match(recipientStatusHtml({ input: "alice", resolving: true, cardShown: true }), /Looking up username/);
  assert.match(app, /recipientStatusHtml\(\{ \.\.\.\(status \|\| \{\}\), cardShown: true \}\)/);
  assert.doesNotMatch(app, /els\.resolvedHint\.innerHTML = `Resolved:/);
  assert.match(cold, /cardShown: Boolean\(deps\.addressCardHtml\),/);
});

await test("Cold Storage: earlier Used answers carry over; moved and unknown rows are asked again", () => {
  const entries = [
    { address: "a", balanceSompi: 0, everUsed: true },        // used and empty: stays used, not asked
    { address: "b", balanceSompi: 0, everUsed: false },       // unused, balance unchanged: not asked
    { address: "c", balanceSompi: 0, everUsed: false },       // held coins before: used, no request
    { address: "d", balanceSompi: 0, everUsed: undefined },   // last check failed / never asked
    { address: "e", balanceSompi: 0, everUsed: false },       // no balance known before: asked
    { address: "f", balanceSompi: 500, everUsed: false },     // funded now: used by its balance
  ];
  const before = new Map([["a", 0], ["b", 0], ["c", 1200], ["d", 0], ["f", 0]]);
  const { heldBefore, toProbe } = coldUsedRecheck(entries, before);
  assert.deepEqual(heldBefore.map((e) => e.address), ["c"]);
  assert.deepEqual(toProbe.map((e) => e.address), ["d", "e"]);
  assert.match(cold, /const balanceBefore = new Map\(detailEntries\.map\(\(e\) => \[e\.address, e\.balanceSompi\]\)\);/);
  assert.match(cold, /const \{ heldBefore, toProbe: pending \} = coldUsedRecheck\(detailEntries, balanceBefore\);/);
  assert.match(cold, /for \(const entry of heldBefore\) markUsed\(entry, true\);/);
  // the seeds still carry the session's and the saved answers into the reload
  assert.match(cold, /everUsed: useCache \? \(previous\.get\(address\)\?\.everUsed \?\? persisted\?\.used\?\.\[address\]\) : undefined,/);
});

await test("Cold Storage: activity reloads once after a second, and never cuts a load short", async () => {
  const pending = [];
  const timers = {
    setTimeout: (fn) => { pending.push(fn); return pending.length; },
    clearTimeout: (id) => { pending[id - 1] = null; },
  };
  let loads = 0;
  let finish = null;
  const request = coldActivityReloader(() => { loads += 1; return new Promise((r) => { finish = r; }); }, { timers });
  request(); request(); request();
  assert.equal(pending.filter(Boolean).length, 1, "three notices, one reload waiting");
  const run = pending.filter(Boolean)[0];
  pending.length = 0;
  const running = run();
  assert.equal(loads, 1);
  request(); request();
  assert.equal(pending.length, 0, "a notice during a load queues, it doesn't start or cancel one");
  finish();
  await running;
  assert.equal(pending.filter(Boolean).length, 1, "one more reload follows the load");
  assert.match(cold, /coldReloadAfterActivity\(\);\n\}/);
});

await test("Explorer rows: a fee-only net reads its digits, never −0 KAS", () => {
  assert.equal(shortKas(10_000), "0.0001 KAS");
  assert.equal(shortKas(12_345), "0.000123 KAS");
  assert.equal(shortKas(999_999), "0.01 KAS");
  assert.equal(shortKas(0), "0 KAS");
  assert.equal(shortKas(125_000_000), "1.25 KAS");
  assert.equal(shortKas(1_234_500_000_000), "12.3K KAS");
  const A = "kaspa:qa";
  const post = { inputs: [{ address: A, amount: 100_000_000 }], outputs: [{ address: A, amount: 99_990_000 }] };
  assert.equal(perspectiveAmount(post, A), "−0.0001 KAS");
});

await test("Explorer kUSDT is to the cent; under a cent keeps its digits", () => {
  assert.equal(explorerKusdt(2_659_812n), "2.66 kUSDT");
  assert.equal(explorerKusdt(1_000_000n), "1.00 kUSDT");
  assert.equal(explorerKusdt(1_004_999n), "1.00 kUSDT");
  assert.equal(explorerKusdt(1_005_000n), "1.01 kUSDT");
  assert.equal(explorerKusdt(4_000n), "0.004 kUSDT");
  assert.equal(explorerKusdt(0n), "0.00 kUSDT");
  assert.equal(explorerKusdt(1_234_567_890_000n), "1,234,567.89 kUSDT");
  assert.doesNotMatch(explorerUi, /formatKusdt\(|import \{[^}]*formatKusdt/);
  assert.equal((explorerUi.match(/explorerKusdt\b/g) || []).length, 5);
});

await test("Explorer kinds say K Message and Post", () => {
  assert.equal(TX_KINDS.kachatMessage.title, "K Message");
  assert.equal(TX_KINDS.kachatMessage.plural, "K Messages");
  assert.equal(TX_KINDS.kapost.title, "Post");
  assert.equal(TX_KINDS.kapost.plural, "Posts");
});

await test("a Trestly hold ends early only while this page still holds its coins", () => {
  clearJustSpentOutpoints();
  const key = `${"A".repeat(64)}:1`;
  noteSpentOutpoints([key], 1_000);
  assert.ok(heldOutpointKeys(2_000).has(key.toLowerCase()));
  assert.equal(heldOutpointKeys(1_000 + 600_001).size, 0, "a hold that ran out isn't held");
  clearJustSpentOutpoints();
  assert.match(trade, /const heldOutpoints = deps\.heldOutpoints \|\| heldOutpointKeys;/);
  assert.match(trade, /const stillReserved = Boolean\(reserved\) && \(held\.outpoints \|\| \[\]\)\.every\(\(o\) => reserved\.has\(String\(o\)\.toLowerCase\(\)\)\);/);
  assert.match(trade, /if \(held\.outpoints\?\.length && stillReserved && deps\.outpointsOf\) \{/);
});

await test("a hold's early end, end to end: after a reload the hold keeps its minutes", async () => {
  const { createTrestlyTrade } = await import("../engine/kusdt-trade.js");
  const store = new Map();
  const coin = `${"b".repeat(64)}:1`;
  store.set("kachat-trestly-maybe-sent-holds-v1", JSON.stringify({ addr: { until: 600_000, outpoints: [coin] } }));
  let reserved = new Set([coin]);
  const t = createTrestlyTrade({
    walletCall: async () => ({}), network: () => "mainnet", apiUrl: () => "",
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    now: () => 0, outpointsOf: async () => [], heldOutpoints: () => reserved, secretFor: () => null,
  });
  reserved = new Set();
  assert.equal(await t.heldMinutes("addr"), 10, "reloaded: the coin may have gone in a send, the hold stays");
  reserved = new Set([coin]);
  assert.equal(await t.heldMinutes("addr"), null, "still held here and gone from the node: the trade landed");
});

await test("Swap's deposit QR is made once and copied in on later draws", () => {
  assert.match(swaps, /const swapQrCache = new Map\(\);/);
  assert.match(swaps, /function paintSwapQrs\(root\) \{/);
  assert.equal((swaps.match(/paintSwapQrs\((rootEl|el)\);/g) || []).length, 2);
  assert.equal((swaps.match(/deps\.engine\.drawQrFor\(/g) || []).length, 1);
});

await test("old names: the contacts export says K", () => {
  assert.equal(ADDRESS_BOOK_IMPORT_NOT_AN_EXPORT, "That file isn't a K contacts export.");
  assert.match(addressBookExportFileName(Date.parse("2026-11-27T10:00:00Z")), /^K Contacts 2026-11-27T10-00-00Z\.json$/);
});

console.log(`ios 01f71184 wallet: ${passed} passed`);
