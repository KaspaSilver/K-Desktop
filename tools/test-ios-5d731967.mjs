// node tools/test-ios-5d731967.mjs - K 5d731967: scrolled down, Posts shows a round Back to Top button
// above the compose button (as a chat's jump to the newest message); one click goes to the top, and
// it hides there. On a computer, where Post is on the rail, it floats at the feed's bottom right.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const html = read("index.html");
const kaposts = read("ui/kaposts.js");
const css = read("ui/styles.css");

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }

test("a round button at the end of the Posts scroller, hidden until needed", () => {
  assert.match(html, /<div class="kaposts-toasts" data-kaposts-toasts><\/div>\s*<!--[\s\S]*?-->\s*<div class="kaposts-to-top-holder" data-kaposts-to-top-holder hidden>\s*<button class="kaposts-to-top" type="button" data-kaposts-to-top aria-label="Back to Top"/);
  assert.doesNotMatch(html, /Newest Posts/, "Build 363's pill is gone");
  assert.match(css, /\.kaposts-to-top-holder\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.kaposts-to-top \{\n\s+position: absolute; right: 8px; bottom: 0; width: 40px; height: 40px;/);
  assert.match(css, /@media \(max-width: 859px\) \{\n\s+\.kaposts-to-top-holder \{ position: fixed; z-index: 350; right: 28px; bottom: calc\(var\(--dock-inset, 80px\) \+ 16px \+ 56px \+ 12px\);/, "centred just above the compose button");
});
test("it shows on the feed once the top has scrolled away", () => {
  assert.match(kaposts, /const TO_TOP_AFTER_PX = 160;/);
  assert.match(kaposts, /threadStack\.length === 0 && !activePanel\n\s+&& scroller\.clientHeight > 0 && scroller\.scrollTop > TO_TOP_AFTER_PX;/);
  assert.match(kaposts, /contentScrollTop = contentScroller\.scrollTop;\n\s+syncFeedToTopButton\(\);/, "on every scroll");
  assert.match(kaposts, /scroller\.scrollTop = resetScroll \? 0 : previousTop;\n\s+syncFeedToTopButton\(\);/, "after every repaint");
  assert.match(kaposts, /if \(feedHeadEl\) feedHeadEl\.hidden = !showFeed;\n\s+syncFeedToTopButton\(\);/, "gone the moment a post or a section covers the feed");
});
test("a click goes to the top", () => {
  assert.match(kaposts, /if \(event\.target\.closest\("\[data-kaposts-to-top\]"\)\) \{\n\s+kapostsScrollEl\(\)\?\.scrollTo\(\{ top: 0, behavior: "smooth" \}\);\n\s+return;/);
});
console.log(`ios 5d731967: ${passed} passed`);
