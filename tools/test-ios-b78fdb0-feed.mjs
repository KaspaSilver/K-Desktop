// node tools/test-ios-b78fdb0-feed.mjs - KaPost iOS b78fdb0, first part (Build 300): a scheduled
// cancel drops only on NOT_FOUND, a request address never reuses a send's change slot, logs shorten
// tx ids, one vote / delete per post at a time, cooldown off by default, the 0.2 KAS tip minimum with
// failures as toasts, wrapped toasts, and Popular holding its order while it ranks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const app = read("ui/app.js");
const feed = read("ui/kaposts.js");

let failures = 0;
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.log(`FAIL - ${name}\n`, error); }
}

await test("the indexer's own error code rides on the error", () => {
  assert.equal((read("engine/kaposts.js").match(/error\.apiCode = typeof json\?\.code === "string" \? json\.code : null;/g) || []).length, 2);
});
await test("a request's fresh address is reserved in line with the sends' change picks", () => {
  const start = app.indexOf("async function reserveFreshSpendingAddresses(count)");
  const body = app.slice(start, app.indexOf("\n}\n", start));
  assert.match(body, /const reserve = changeSlotPicks\.then\(async \(\) => \{/);
  assert.match(body, /changeSlotPicks = reserve\.catch\(\(\) => \{\}\);/);
});
await test("a transaction id in a log line is cut to 12 characters; longer hex is left", async () => {
  const { shortenLogTxIds } = await import("../ui/log-addresses.js");
  const txid = "0123456789ab".padEnd(64, "c");
  assert.equal(shortenLogTxIds(`sent ${txid}`), "sent 0123456789ab…");
  assert.equal(shortenLogTxIds(`https://explorer/txs/${txid}?x=1`), "https://explorer/txs/0123456789ab…?x=1");
  assert.equal(shortenLogTxIds("f".repeat(128)), "f".repeat(128));
  assert.match(app, /const line = shortenLogTxIds\(shortenLogAddresses\(/);
});
await test("one vote and one delete per post at a time", () => {
  assert.match(feed, /if \(post\.remoteId && votesInFlight\.has\(post\.remoteId\)\) return;/);
  assert.match(feed, /\.finally\(\(\) => votesInFlight\.delete\(held\)\)/);
  assert.match(feed, /post\.pendingDeletion \|\| deletesInFlight\.has\(post\.remoteId\)\) return;/);
  assert.match(feed, /\} finally \{\n\s+deletesInFlight\.delete\(post\.remoteId\);/);
});
await test("cooldown before post is off unless switched on, under a new key", () => {
  assert.match(app, /const KAPOSTS_COOLDOWN_KEY = "kachat-kaposts-cooldown-v2";/);
  assert.match(app, /return localStorage\.getItem\(KAPOSTS_COOLDOWN_KEY\) === "1"; \} catch \{ return false; \}/);
});
await test("tips: 0.2 KAS at least, a saved smaller one reads as 0.2, failures are red toasts", async () => {
  const { KAPOSTS_TIP_MIN_SOMPI } = await import("../ui/kaposts-format.js");
  assert.equal(KAPOSTS_TIP_MIN_SOMPI, 20_000_000);
  assert.match(app, /return sompi > 0 \? \{ sompi: Math\.max\(sompi, KAPOSTS_TIP_MIN_SOMPI\) \} : null;/);
  assert.match(app, /The smallest tip the network takes is \$\{minimumText\}\./);
  assert.match(app, /Tip didn't send: the smallest tip the network takes is \$\{trimKas8\(KAPOSTS_TIP_MIN_SOMPI \/ 1e8\)\} \$\{KAS_UNIT\}\. Change your default tip in Settings > Customization > Tipping\./);
  assert.match(app, /if \(failure\) showKaPostsActionToast\(failure, null, \{ failure: true \}\);/);
  // a failure is a red toast; only a default over 10 KAS opens the tip screen, saying so (K 518fdc8c)
  assert.doesNotMatch(app, /openTipModal\(\{ address, name, tip, onTipped, error(?!: INSTANT_TIP_LIMIT_NOTICE \})/);
  assert.match(app, /"Tip didn't send\. Try again in a moment\."/);
});
await test("the tip field saves on its checkmark, not while typing", () => {
  assert.match(app, /data-kaposts-tip-amount value="\$\{escapeHtml\(initialText\)\}" readonly \/>/);
  assert.match(app, /amount\.addEventListener\("input", \(\) => \{ tooSmall\.hidden = true; paintUnit\(\); \}\);/);
  assert.match(app, /amount\.addEventListener\("blur", finishEditing\);/);
});
await test("a failure toast stays 6 s", () => {
  assert.match(feed, /\}, failure \? 6000 : 4000\);/);
});
await test("Popular holds its rows while it ranks and re-ranks once; it also sweeps on Feed off a metered line", () => {
  assert.match(feed, /if \(popularOrderHold\) \{/);
  assert.match(feed, /if \(activeFeedTab === "popular"\) popularOrderHold = visibleFeedPosts\(\)\.map\(\(p\) => p\.id\);/);
  assert.match(feed, /if \(wasHeld && activeFeedTab === "popular"\) renderFeed\(\);/);
  assert.match(feed, /return !\(connection && \(connection\.saveData \|\| connection\.type === "cellular"\)\);/);
  assert.match(feed, /if \(!finished\) popularSweptAt = 0;/);
  assert.match(feed, /if \(popularDeepening\) popularSweepRearm = true;/);
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log(`ios b78fdb0 feed: ${passed} passed`);
