// K 35b112ce + 48f5c357 (owner, 2026-11-26): Kasshi is its own card, no longer one of the Websites;
// the Chats page pill reads "Private Chats". K signs in to Kasshi inside its in-app browser; Desktop
// embeds no sites (frame-src 'none'), so its Kasshi screen opens kasshi.io in a new tab, where the K
// Extension is the window.kachat provider. (The rooms rule is in test-public-chats-page.mjs.)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RAIL_ORDER } from "../ui/dock-arrangement.js";
import { hubCardForSlug, hubSlugForAppTab } from "../ui/hub-links.js";

const read = (...p) => readFileSync(new URL(`../${p.join("/")}`, import.meta.url), "utf8");
const html = read("index.html");
const headers = read("public", "_headers");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

test("Kasshi is a dock item and a Hub link of its own, after Websites", () => {
  assert.equal(RAIL_ORDER.indexOf("kasshi"), RAIL_ORDER.indexOf("apps") + 1);
  assert.match(html, /<button class="sidebar-tab" type="button" data-app-tab="kasshi" hidden>[\s\S]*?<span>Kasshi<\/span>/);
  assert.deepEqual(hubCardForSlug("kasshi"), { slug: "kasshi", tab: "kasshi", label: "Kasshi", blurb: "Watch and listen, and pay the creator in KAS." });
  assert.equal(hubSlugForAppTab("kasshi"), "kasshi");
});

test("its screen opens kasshi.io in a new tab; Websites no longer lists it", () => {
  const screen = html.slice(html.indexOf('data-app-tab-screen="kasshi"'), html.indexOf('data-app-tab-screen="apps"'));
  assert.match(screen, /<h1 class="kaposts-title">Kasshi<\/h1>/);
  assert.match(screen, /<a class="primary-button kasshi-open" href="https:\/\/kasshi\.io" target="_blank" rel="noopener" data-kasshi-open>Open Kasshi<\/a>/);
  assert.match(screen, /K Extension/);
  const websites = html.slice(html.indexOf('data-app-tab-screen="apps"'), html.indexOf("</div>", html.indexOf("apps-screen-grid")));
  assert.doesNotMatch(websites, /kasshi\.io|KasShi/);
  assert.match(headers, /frame-src 'none'/, "still no embedded sites");
});

test("the Chats page pill reads Private Chats", () => {
  assert.match(html, /<span class="cycle-button-title">Private Chats<\/span>/);
  assert.match(read("ui", "app.js"), /\{ id: "chats", title: "Private Chats" \}/);
});

console.log(`ios 35b112ce: ${passed} passed`);
