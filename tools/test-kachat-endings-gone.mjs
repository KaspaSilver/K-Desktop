// K 522fd9f4 (owner, 2026-11-26): the Show .kachat Endings switch is gone and a .kachat name is
// always shown bare, @mentions in rooms and posts included; Set as Name fills in the bare name; the
// Usernames screen's header reads "Usernames" and its empty states show the "@" symbol.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { removeRetiredFeatureData, RETIRED_KACHAT_ENDINGS_KEY, RETIRED_FEATURES_DONE_KEY } from "../ui/retired-features.js";

const read = (...parts) => readFileSync(new URL(`../${parts.join("/")}`, import.meta.url), "utf8");
const html = read("index.html");
const app = read("ui", "app.js");
const live = read("ui", "kachat-names-live.js");
const market = read("ui", "kachat-market.js");
const rooms = read("ui", "broadcasts.js");
const kaposts = read("ui", "kaposts.js");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

test("no Show .kachat Endings switch, and names always show bare", () => {
  assert.doesNotMatch(html, /data-pref-kachat-endings|Show \.kachat Endings<\/strong>/);
  assert.doesNotMatch(app + live, /kachatShowsEndings|setKachatShowsEndings/);
  const body = live.slice(live.indexOf("export function kachatNameDisplay("), live.indexOf("export function kachatCachedDisplayLabel("));
  const kachatNameDisplay = new Function(`${body.replace("export ", "")}; return kachatNameDisplay;`)();
  assert.equal(kachatNameDisplay("alice"), "alice");
  assert.equal(kachatNameDisplay("alice.kachat"), "alice");
  assert.equal(kachatNameDisplay("Bob.KACHAT"), "Bob");
  assert.doesNotMatch(live, /kl-tile-suffix/, "marketplace tiles have no ending under the name");
  assert.doesNotMatch(market, /kmkt-search-suffix">\.kachat<\/span>/, "neither the search field nor the setup guide's field has an ending");
});

test("the switch's stored value is removed on every launch", () => {
  const store = new Map([[RETIRED_KACHAT_ENDINGS_KEY, "1"], [RETIRED_FEATURES_DONE_KEY, "1"]]);
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  removeRetiredFeatureData(storage);
  assert.equal(store.has(RETIRED_KACHAT_ENDINGS_KEY), false, "even where the Simple Mode cleanup already ran");
  assert.equal(RETIRED_KACHAT_ENDINGS_KEY, "kachat-show-name-endings-v1");
});

test("@mentions in rooms and posts are drawn as @alice; their links still name the username", () => {
  assert.match(rooms, /span\.textContent = value\.slice\(token\.start, token\.end\)\.replace\(\/\\\.kachat\$\/i, ""\);/);
  assert.match(rooms, /openMentionedProfile\(token\.name\);/);
  assert.match(kaposts, /deps\.escapeHtml\(value\.slice\(token\.start, token\.end\)\.replace\(\/\\\.kachat\$\/i, ""\)\)/);
  assert.match(kaposts, /const shown = b === mention\.end \? piece\.replace\(\/\\\.kachat\$\/i, ""\) : piece;/);
  assert.match(kaposts, /data-kaposts-mention="\$\{deps\.escapeHtml\(mention\.domain\.toLowerCase\(\)\)\}">\$\{shown\}<\/span>/);
});

test("Set as Name fills in the bare name; Copy keeps the ending", () => {
  assert.match(app, /data-chat-info-set-name="\$\{escapeHtml\(shown\)\}">Set as Name<\/button>/);
  assert.match(app, /data-chat-info-copy-domain="\$\{escapeHtml\(full\)\}"/);
});

test("the Usernames screen: its header reads Usernames, and @ where the wordmark was", () => {
  assert.match(market, /<h2 class="kmkt-hero-title">Usernames<\/h2>/);
  assert.match(market, /<h1 class="kaposts-title">Usernames<\/h1>/, "the screen's title too");
  assert.match(market, /label: "Usernames",\n\s*dismissOnBackdrop: false,/);
  assert.match(market, /export const KACHAT_AT_SVG = ICON\.atCircle;/);
  assert.match(market, /<span class="kachat-address-domains-mark" aria-hidden="true">\$\{ICON\.atCircle\}<\/span>/);
  assert.match(live, /<span class="kachat-address-domains-mark" aria-hidden="true">\$\{kit\.ICON\.atCircle\}<\/span>/);
  assert.match(app, /<span class="domains-kachat-mark" aria-hidden="true">\$\{KACHAT_AT_SVG\}<\/span>/);
});

test("the marketplace and its bell news show the bare name (K KachatNameLabel.display everywhere)", () => {
  // only the full name for copying and sending is written out by hand
  const handWritten = (live.match(/\}\.kachat`/g) || []).length;
  assert.equal(handWritten, 1, "kachatCachedLabel alone");
  assert.match(live, /return label \? `\$\{label\}\.kachat` : null;/);
  assert.match(live, /const display = kachatNameDisplay\(name\);/);
  assert.match(live, /label: `Claiming \$\{kachatNameDisplay\(p\.name\)\}`,/);
  const notifier = read("ui", "kachat-names-notifier.js");
  assert.doesNotMatch(notifier, /\}\.kachat`/);
  assert.match(notifier, /`New offer on \$\{kachatNameDisplay\(o\.name\)\}`/);
  assert.doesNotMatch(market, /\$\{esc\(typed\)\}\.kachat/);
});

console.log(`.kachat endings gone: ${passed} passed`);
