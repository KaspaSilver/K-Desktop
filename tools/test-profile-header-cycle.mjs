// Profile's header as K's (K 8cb4c88e kaPostsFixedTitle + ProfileAccountChip): Share in plain text
// top left with refresh and the bell on the right, then the large title with the account chip; and
// switching Posts / Replies keeps the banner, picture and name on screen (owner, 2026-11-24: the
// whole screen jumped, since the banner was drawn again and sizes itself when it loads).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../ui/kaposts-drawer.css", import.meta.url), "utf8");
const js = readFileSync(new URL("../ui/kaposts.js", import.meta.url), "utf8");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

test("the header is two rows: Share / refresh / bell, then the title and the chip", () => {
  assert.match(css, /grid-template-areas: "share \. \. refresh bell" "title chip \. \. \.";/);
  assert.match(css, /\.kaposts-title-share \{\n\s*grid-area: share;[^}]*border: 0;[^}]*background: transparent;/);
  assert.match(css, /\[data-kaposts-panel-title\] \{\n\s*grid-area: title;[^}]*font-size: 34px; font-weight: 700;/);
  assert.match(css, /> \.profile-account-chip \{\n\s*grid-area: chip;/);
});

test("a redraw that leaves the hero as it was keeps the one on screen", () => {
  assert.match(js, /let lastProfileHeroHtml = "";/);
  assert.match(js, /if \(keptHero && lastProfileHeroHtml === heroHtml\) \{\n\s*while \(keptHero\.nextSibling\) keptHero\.nextSibling\.remove\(\);\n\s*keptHero\.insertAdjacentHTML\("afterend", pageHtml\);/);
  assert.match(js, /panelBodyEl\.innerHTML = heroHtml \+ pageHtml;/);
});

console.log(`profile header and cycle: ${passed} passed`);
