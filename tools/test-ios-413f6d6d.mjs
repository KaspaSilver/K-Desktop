// node tools/test-ios-413f6d6d.mjs - KaChat iOS 413f6d6d, ported in Build 299: contact names (the
// editor opens empty unless you named them, needs a name, has a clear button and Use Their Domain
// Name; User Info's field takes the saved name), Set as Name in User Info's .kachat Names, Share
// Profile under the share circle, Request Payment's Show Request As QR, and the funding text.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const app = read("ui/app.js");
const book = read("ui/address-book.js");
const html = read("index.html");

let failures = 0;
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.log(`FAIL - ${name}\n`, error); }
}

await test("the contact editor opens with only a name you gave them, and needs a name to save", () => {
  assert.match(book, /export function openAddressBookEditor\(\{ address = null, presetName = null \} = \{\}\)/);
  assert.match(book, /name: existing \? existing\.name : String\(presetName \|\| ""\)\.trim\(\),/);
  assert.match(book, /return Boolean\(editorEffectiveAddress\(\)\) && Boolean\(String\(editorState\?\.name \|\| ""\)\.trim\(\)\);/);
  assert.doesNotMatch(book, /lookupFilledName/, "a resolved domain no longer fills the name");
  assert.doesNotMatch(app, /suggestedName/);
  assert.match(app, /presetName: contact\.nameIsCustom \? contact\.name : null/);
});
await test("a clear button and Use Their Username (K 518fdc8c), the bare name (K 824a30bb)", () => {
  assert.match(book, /data-ab-editor-name-clear aria-label="Clear"/);
  assert.match(book, /Use Their Username <span class="ab-use-domain-name">\(\$\{esc\(suggestion\)\}\)<\/span>/);
  assert.match(book, /if \(s\.resolvedAddress && s\.resolvedName\) suggestion = String\(s\.resolvedName\)\.trim\(\);/);
  assert.match(book, /suggestion = String\(suggestion \|\| ""\)\.trim\(\)\.replace\(\/\\\.kachat\$\/i, ""\);/, "never alice.kachat");
  assert.match(app, /kachatNameFor: \(address\) => \(kachatNamesUiEnabled\(\) \? kachatCachedLabel\(address\) : null\),/);
});
await test("User Info's name field takes the name the editor saved", () => {
  assert.match(app, /const given = now\?\.nameIsCustom \? now\.name : addressBookName\(address\);/);
});
await test("Set as Name fills the field without saving; the one in the field reads Their Name", () => {
  // the bare name, never the ending (K 522fd9f4)
  assert.match(app, /data-chat-info-set-name="\$\{escapeHtml\(shown\)\}">Set as Name<\/button>/);
  assert.match(app, /typed === shown \? `<span class="chat-info-their-name">/);
  assert.match(app, /if \(chatInfoNameInput\) chatInfoNameInput\.value = setName\.dataset\.chatInfoSetName;\n\s+closeChatInfoSheet\(\);/);
  assert.match(app, /const canSet = !isSelf && !isKachatBot\(address\);/);
});
await test("Share is a capsule beside Add as Contact under the bio (K 2251f15c), and shares", () => {
  assert.match(html, /<div class="chat-info-header-actions" data-chat-info-header-actions>[\s\S]*?data-chat-info-address-book>[\s\S]*?data-chat-info-share aria-label="Share this profile"[\s\S]*?<span>Share<\/span>\s*<\/button>/);
  assert.doesNotMatch(html, /chat-info-share-caption/, "the big round Share Profile button is gone");
});
// KaChat iOS 148a5331 retired KaPay: every request's QR holds its kachat.app link (kapay:// links
// older apps made are still read, engine/payment-request.js PAY_LINK_RE).
await test("Show Request As QR: the kachat.app link, always", async () => {
  const { makePaymentRequest, paymentRequestUniversalLink } = await import("../engine/payment-request.js");
  const address = "kaspa:qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn5abcde";
  const request = makePaymentRequest({ address, amountSompi: 150_000_000n, memo: "Coffee" });
  assert.match(app, /const payload = paymentRequestUniversalLink\(request\);/);
  assert.ok(paymentRequestUniversalLink(request).startsWith("https://"));
  assert.match(app, /secondaryTitle: "Show Request As QR",/);
  assert.doesNotMatch(app, /to pay in KaPay/);
  assert.match(app, /Scan it with an iPhone's camera to pay in K, with everything filled in\./);
  assert.match(read("ui/send-steps.js"), /if \(step\.secondaryButton\) step\.secondaryButton\.disabled = !ok;/);
});
await test("a sheet over another closes alone on Escape", () => {
  assert.match(app, /if \(\[\.\.\.document\.querySelectorAll\("\[data-payment-request-sheet\]"\)\]\.pop\(\) !== backdrop\) return;/);
});
await test("no funding or node step (K 824a30bb): the fees step says what 5 Kaspa buys; the guide ends on Share", () => {
  assert.doesNotMatch(app, /title: "Fund Your Chatting Address"|title: "Connect to a Node"/);
  assert.match(app, /The fee you pay goes to miners which secure the network\. 5 Kaspa lets you send around 2,500 messages\.", extra: "change-address" \}/);
  assert.match(app, /\{ icon: SETUP_ICONS\.share, title: "Share Your Chatting Address", body: "Send it to someone so they can find and message you on K\.", extra: "share" \},\n\];/);
  assert.match(app, /title: "Get a Username", value: "", caption: "Claim a username, like @alice/);
  assert.match(app, /if \(completed && wasOnboardingRun\) void runPostOnboardingSync\(\{ quiet: true \}\);/, "no progress screen after the guide");
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log(`ios 413f6d6d: ${passed} passed`);
