// node tools/test-ios-d88891ea.mjs - K d88891ea (K's audit 2026-11-27), the parts Desktop shares: Swap's
// deposit can't be paid twice and stops polling at an end; renames save once; room mentions since
// join and a week, the bell's newest kept, deletes leave it; expired names on every address, one
// read at a time; 64-hex Explorer lookups only on Search; name reminders follow push; old names.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const app = read("ui/app.js");
const swaps = read("ui/swaps.js");
const rooms = read("ui/broadcasts.js");
const live = read("ui/kachat-names-live.js");
const explorer = read("ui/explorer.js");
const inline = read("ui/inline-rename.js");
const kaposts = read("ui/kaposts.js");

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }

test("M1: the deposit is sent from K once, and the send is recorded on the swap", () => {
  assert.match(swaps, /if \(swap\.kasSendTxId\) \{\n\s+return `<div class="profile-card swap-deposit-card"><small>Sent from K<\/small>/);
  assert.match(swaps, /if \(status !== "new" && status !== "waiting"\) return "";/);
  assert.match(swaps, /now\.kasSendTxId = txid \|\| "sent";/);
  assert.match(app, /onClosed\(\{ sent: sendKaspaSentThisOpen, txid: sendKaspaSentTxIdThisOpen \}\)/);
  assert.match(app, /openSendKaspaModal\(\{ paymentRequest: makePaymentRequest\(\{ address, amountSompi \}\), onClosed \}\);/);
});
test("L18: polling stops at any end, and saves only a change", () => {
  assert.match(swaps, /const SWAP_END_STATES = new Set\(\["finished", "failed", "refunded", "expired"\]\);/);
  assert.match(swaps, /if \(swap && swap\.status !== status\) \{ swap\.status = status; saveHistory\(\); \}/);
});
test("M6/L20: a rename saves once as it ends; Escape keeps the name", () => {
  assert.doesNotMatch(inline, /addEventListener\("input"/);
  assert.match(inline, /if \(!cancelled && input\.value !== current\)/);
});
test("M8/L10: room mentions since join and a week; the bell keeps its newest; a delete takes its row", () => {
  assert.match(rooms, /if \(at && \(at < weekAgo \|\| \(joined && at < joined\)\)\) continue;/);
  assert.match(app, /globalNotifications\.sort\(\(a, b\) => Number\(b\.timestamp \|\| 0\) - Number\(a\.timestamp \|\| 0\)\);\n\s+globalNotifications = globalNotifications\.slice\(0, NOTIF_CENTER_MAX\);/);
  assert.match(rooms, /deps\.removeMentions\?\.\(\[\.\.\.wanted\]\);/);
  assert.match(app, /removeMentions: \(txIds\) => removeMentionNotifications\(txIds\),/);
});
test("M5/L19: expired names on every address of the wallet, one read at a time", () => {
  assert.match(live, /\(await rt\.actions\.ownNamesAndOffers\(\{ heldOnly: true \}\)\)\.names/);
  assert.match(app, /if \(refreshKachatExpiredBanner\.running\) \{ refreshKachatExpiredBanner\.again = true; return; \}/);
});
test("L5: a 64-hex id is looked up only on Search, and never this account's key", () => {
  assert.match(explorer, /if \(queryKind\(text\)\.kind === "id"\) \{ home\.typed = \{ type: "idOnSearch" \}; paintSearch\(\); return; \}/);
  assert.match(explorer, /ownSecret = Boolean\(deps\.isOwnSecretHex\?\.\(trimmed\)\);/);
  assert.match(app, /return Boolean\(engine\.privateKeyHex\) && hex === String\(engine\.privateKeyHex\)\.toLowerCase\(\);/);
});
test("L9: name reminders follow Web Push turning on or off", () => {
  assert.match(app, /onStatus: \(\) => \{ renderWebPushStatus\(\); try \{ kachatNamesNotificationSettingsChanged\(\); \}/);
});
test("old names: Posts, Arcade and @alice in what people read", () => {
  assert.doesNotMatch(kaposts, /title: "KaPost"/);
  assert.match(kaposts, /<strong>Search Posts<\/strong>/);
  assert.match(kaposts, /Arcade Challenge/);
  assert.doesNotMatch(read("index.html"), /alice\.kachat/);
});
console.log(`ios d88891ea: ${passed} passed`);
