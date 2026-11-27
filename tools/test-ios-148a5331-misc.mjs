// KaChat iOS 148a5331, the smaller parts: the Terms are the app's first screen; every Manage kUSDT
// row has a menu; the new app icon; request QRs always hold the kachat.app link; Edit Profile's
// "Get a username" (K 518fdc8c); Posts/Replies change with the cycle button, no sideways swipe.
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

await test("no Terms to agree to on the website (owner, 2026-11-21); the text stays readable in Settings", () => {
  for (const source of [app, moderation, read("ui", "broadcasts.js")]) {
    assert.doesNotMatch(source, /askKaPostTerms|kaPostTermsAccepted|acceptKaPostTerms|I Agree|You need to agree/);
  }
  assert.match(app, /infoSheet\(\{ title: "Terms of Use", html: kaPostTermsHtml\(\) \}\)/);
  assert.doesNotMatch(read("ui", "kapost-terms.css"), /kapost-terms-cover/);
});

await test("Manage kUSDT's cards (K 824a30bb): Copy, Send, Receive, Rename (not the Chatting Address); the ⋮ keeps the rest", () => {
  assert.doesNotMatch(kusdt, /chatting-address-row-chevron kusdt-row-chevron/);
  assert.match(kusdt, /chatting \? null : \{ id: "rename", title: "Rename" \}/);
  assert.match(kusdt, /chatting \? null : \{ id: "send-chatting"/);
  assert.match(kusdt, /chatting \? null : \{ id: "hide"/);
  assert.match(kusdt, /const hasMore = !chatting \|\| h\.coinCount > 1;/, "the Chatting Address's ⋮ only with Combine Coins");
});

await test("the new icon set is there and is the tab icon", () => {
  for (const name of ["icon-192.png", "icon-512.png", "icon-512-maskable.png", "apple-touch-icon.png"]) {
    assert.ok(statSync(join(here, "..", "public", "icons", name)).size > 1000, name);
  }
  assert.match(html, /<link rel="icon" type="image\/png" href="\/icons\/icon-192\.png" \/>/);
});

await test("a request's QR always holds its kachat.app link", () => {
  assert.match(app, /const payload = paymentRequestUniversalLink\(request\);/);
  assert.doesNotMatch(read("engine", "payment-request.js"), /export function paymentRequestKaPayLink/);
});

await test("Edit Profile's Get a username opens the Usernames screen", () => {
  assert.equal(live.split("data-kl-get-kachat-name>").length, 3); // both sections
  assert.match(live, /kit\.closeLayer\(layer\);\n        deps\(\)\.openKachatNames\?\.\(\);/);
  assert.match(app, /openKachatNames: \(\) => setActiveAppTab\("kachat-names"\),/);
});

await test("Posts / Replies change with the cycle button only, fading; no sideways swipe (K 518fdc8c)", async () => {
  const src = read("ui", "kaposts.js");
  assert.match(src, /cycleButtonHtml\(\{ name: "kaposts-profile", options: PROFILE_PAGES/);
  assert.match(src, /const PROFILE_PAGES = \[\["posts", "Posts"\], \["replies", "Replies"\]\];/);
  assert.match(src, /restartFade\(panelBodyEl\?\.querySelector\("\[data-kaposts-panel-list\]"\)\)/);
  assert.doesNotMatch(src, /profileSwipeTarget|wireProfileTabSwipe|slideProfileListIn|data-kaposts-profile-tab=/);
});

console.log(`ios 148a5331 misc: ${passed} passed`);
