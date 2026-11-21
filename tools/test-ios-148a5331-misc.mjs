// KaChat iOS 148a5331, the smaller parts: the Terms are the app's first screen; every Manage kUSDT
// row has a menu; the new app icon; request QRs always hold the kachat.app link; Edit Profile's
// "Get a .kachat name"; Posts/Replies change with a sideways swipe.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8");
const app = read("ui", "app.js");
const moderation = read("ui", "kapost-moderation.js");
const kusdt = read("ui", "kusdt-screens.js");
const live = read("ui", "kachat-names-live.js");
const html = read("index.html");
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

await test("the Terms come first, with no way past them, under KaChat's own key", () => {
  assert.match(app, /if \(!kaPostTermsAccepted\(\)\) askKaPostTerms\(\{ required: true \}\);/);
  assert.match(moderation, /export const KAPOST_TERMS_ACCEPTED_KEY = "kachat_terms_accepted_version";/);
  assert.match(moderation, /\$\{required \? "" : `<button class="kapost-terms-later"/);
  assert.match(moderation, /if \(event\.key !== "Escape" \|\| required\) return;/);
  assert.match(moderation, /You need to agree to use KaChat\./);
});

await test("every Manage kUSDT row has its menu; the Chatting Address's is Copy, QR, Combine", () => {
  assert.doesNotMatch(kusdt, /chatting-address-row-chevron kusdt-row-chevron/);
  assert.match(kusdt, /chatting \? null : \{ id: "rename"/);
  assert.match(kusdt, /chatting \? null : \{ id: "send-chatting"/);
  assert.match(kusdt, /chatting \? null : \{ id: "hide"/);
  assert.match(kusdt, /\{ id: "copy", title: "Copy Address"/);
});

await test("the new icon set is there and is the tab icon", () => {
  for (const name of ["icon-192.png", "icon-512.png", "icon-512-maskable.png", "apple-touch-icon.png", "icon-192-dark.png", "icon-512-dark.png", "icon-512-maskable-dark.png", "apple-touch-icon-dark.png"]) {
    assert.ok(statSync(join(here, "..", "public", "icons", name)).size > 1000, name);
  }
  assert.match(html, /<link rel="icon" type="image\/png" href="\/icons\/icon-192\.png" \/>/);
});

await test("a request's QR always holds its kachat.app link", () => {
  assert.match(app, /const payload = paymentRequestUniversalLink\(request\);/);
  assert.doesNotMatch(read("engine", "payment-request.js"), /export function paymentRequestKaPayLink/);
});

await test("Edit Profile's Get a .kachat name opens the .kachat screen", () => {
  assert.equal(live.split("data-kl-get-kachat-name>").length, 3); // both sections
  assert.match(live, /kit\.closeLayer\(layer\);\n        deps\(\)\.openKachatNames\?\.\(\);/);
  assert.match(app, /openKachatNames: \(\) => setActiveAppTab\("kachat-names"\),/);
});

await test("a sideways swipe picks Posts or Replies", async () => {
  // kaposts.js touches the DOM on import, so the rule is read from the source and run here.
  const src = read("ui", "kaposts.js");
  const body = src.slice(src.indexOf("export function profileTabAfterSwipe(dx, dy) {"));
  const fn = new Function(`return (${body.slice("export ".length, body.indexOf("\n}\n") + 2)})`)();
  assert.equal(fn(-80, 10), "replies");
  assert.equal(fn(80, 10), "posts");
  assert.equal(fn(-50, 0), null);
  assert.equal(fn(-80, 60), null);
});

console.log(`ios 148a5331 misc: ${passed} passed`);
