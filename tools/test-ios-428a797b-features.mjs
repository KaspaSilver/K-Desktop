// K 428a797b's new behaviour on Desktop (Build 320): Contains domain on the chatting address, Cold
// Storage's total in the balance card with its worth, kpubs off the clipboard after 30 s, hidden
// cold addresses quiet, Portfolio keeps its screen, push says it's K and carries KaPost blocks, and
// one notification per message in rooms and KaPost.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildRegistrationFields } from "../ui/web-push-core.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const app = read("ui/app.js");
const cold = read("ui/coldstorage.js");
const portfolio = read("ui/portfolio.js");
const kaposts = read("ui/kaposts.js");
const rooms = read("ui/broadcasts.js");
const css = read("ui/styles.css");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

test("the chatting address shows Contains domain, and is asked about first", () => {
  assert.match(app, /function chattingAddressRowHtml\(hasDomain = false\) \{/);
  // the card's Used, then Contains username (K 824a30bb ManagedAddressCard)
  assert.match(app, /<span class="address-card-usage used">Used<\/span>\n\s*\$\{domainTag\}/);
  assert.match(app, /const domainLookup = \[\.\.\.\(engine\.address \? \[engine\.address\] : \[\]\), \.\.\.enriched\.map\(\(e\) => e\.address\)\];/);
  assert.match(app, /kachatOwnersOfNames\(domainLookup\)/);
  assert.match(app, /chattingAddressRowHtml\(domainOwning\.has\(engine\.address\)\)/);
});

test("Cold Storage's total is a balance card with its worth on mainnet", () => {
  assert.match(cold, /\$\{balanceCardHtml\("Total Balance", totalSompi\)\}/);
  assert.doesNotMatch(cold, /cold-summary-balance/);
  assert.match(app, /kasFiatText: \(kas, onPrice\) => \(IS_TESTNET \? null : kasFiatTextNow\(kas, onPrice\)\),/);
  assert.match(css, /\.address-balance-card \{/);
});

test("a copied kpub leaves the clipboard after 30 seconds, from every copy", () => {
  assert.doesNotMatch(cold, /writeText\(account\.kpub\)/);
  assert.equal((cold.match(/copyKpub\(account\.kpub\);/g) || []).length, 2);
  // the kpub QR screen copies it with a click anywhere (K b49a021d), the card's Copy kpub too
  assert.match(cold, /const account = accounts\.find\(\(a\) => a\.id === kpubScreen\.dataset\.accountId\);\n\s*if \(account\) copyKpub\(account\.kpub\);/);
  // only while the clipboard still holds the kpub (audit 2026-11-27, tools/test-audit-2026-11-27-cold.mjs)
  assert.match(cold, /kpubClipboardTimer = window\.setTimeout\(async \(\) => \{[\s\S]*?if \(!coldClipboardStillHolds\(current, kpub\)\) return;\s*navigator\.clipboard\?\.writeText\(" "\)/);
});

test("hidden cold addresses stay quiet, and the push list follows the switches", () => {
  assert.match(cold, /notify: account\.receiveNotifications !== false, hidden: hidden\.has\(index\)/);
  assert.match(cold, /\$\{a\.id\}:\$\{a\.maxIndex\}:\$\{a\.hidden\.join\("\."\)\}/);
  assert.match(app, /if \(entry\.notify === false \|\| entry\.hidden\) continue;/);
  assert.match(app, /if \(entry\.notify === false \|\| entry\.hidden\) muted\.add\(entry\.address\);/);
  // 3, plus (K 961fc05a) a quantum address added, one no longer watched, one hidden or shown, and
  // an account removed, and (audit 2026-11-27) a funded hidden address un-hidden
  assert.equal((cold.match(/deps\.onWatchedAddressesChanged\?\.\(\);/g) || []).length, 8);
  assert.match(app, /onWatchedAddressesChanged: \(\) => \{ try \{ scheduleWebPushSync\(\); \}/);
});

test("Portfolio comes back on the screen it was left on; an account switch resets it", () => {
  const refresh = portfolio.slice(portfolio.indexOf("export function refreshPortfolio() {"), portfolio.indexOf("export function resetPortfolioForAccount"));
  assert.doesNotMatch(refresh, /view = "main"/);
  const reset = portfolio.slice(portfolio.indexOf("export function resetPortfolioForAccount"), portfolio.indexOf("export function resetPortfolioForAccount") + 600);
  assert.match(reset, /view = "main";/);
});

test("push registration says it's K and carries the KaPost blocks", () => {
  const xonly = "ab".repeat(32);
  const fields = buildRegistrationFields({
    endpoint: "https://push.example/abc", p256dh: "p", authSecret: "a", watchedAddresses: [],
    kaposts: { pubkey: `02${"cd".repeat(32)}` }, kapostsBlockedPubkeys: [xonly, xonly.toUpperCase(), "nothex", `02${xonly}`],
  });
  assert.equal(fields.app, "k");
  assert.deepEqual(fields.kaposts_blocked_pubkeys, [xonly]);
  const signedOut = buildRegistrationFields({ endpoint: "https://push.example/abc", p256dh: "p", authSecret: "a", kapostsBlockedPubkeys: [xonly] });
  assert.deepEqual(signedOut.kaposts_blocked_pubkeys, [], "no KaPost identity, no list");
  assert.match(app, /kapostsBlockedPubkeys: \(\(\) => \{ try \{ return kaPostsHiddenXOnlyKeys\(\); \}/);
});

test("rooms ring once per message, only while it's news; KaPost once per person, post and kind", () => {
  assert.match(rooms, /const ROOM_BANNER_MAX_AGE_MS = 3 \* 60_000;/);
  assert.match(rooms, /Date\.now\(\) - Number\(row\.blockTime \|\| 0\) <= ROOM_BANNER_MAX_AGE_MS/);
  assert.match(rooms, /for \(const row of pingable\) \{/);
  assert.doesNotMatch(rooms, /pingable\.slice\(0, 3\)/);
  assert.doesNotMatch(kaposts, /fresh\.slice\(0, 5\)/);
  const start = kaposts.indexOf("function claimKaPostsBanner(");
  const claim = new Function(`const KAPOSTS_BANNER_WINDOW_MS = 15 * 60_000; const kaPostsBannerLedger = new Map(); ${kaposts.slice(start, kaposts.indexOf("\n}\n", start) + 2)} return claimKaPostsBanner;`)();
  assert.equal(claim("a|p|vote|upvote", 0), true);
  assert.equal(claim("a|p|vote|upvote", 60_000), false, "the same like again inside 15 minutes");
  assert.equal(claim("a|p|reply|", 60_000), true, "another kind rings");
  assert.equal(claim("a|p|vote|upvote", 16 * 60_000), true, "after the window");
});

console.log(`ios 428a797b features: ${passed} passed`);
