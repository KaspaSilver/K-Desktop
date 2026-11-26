// Owner, 2026-11-26: the Profile tab showed a second, full-height scrollbar beside the profile's
// own. The profile scrolls in its panel body; the posts area around it was 4px too tall because of
// the sticky compose button pulled up 72px. On the Profile tab that area never scrolls, and the
// button floats over it instead of taking room.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../ui/kaposts-drawer.css", import.meta.url), "utf8");
const styles = readFileSync(new URL("../ui/styles.css", import.meta.url), "utf8");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

test("on the Profile tab the area around the profile never scrolls", () => {
  assert.match(css, /\.kaposts-root-profile \.kaposts-content \{ position: relative; overflow-y: hidden; \}/);
  // the profile's own body does the scrolling (the panel fills the area)
  assert.match(styles, /\.kaposts-panel \{ flex: 1; min-height: 0; display: flex; flex-direction: column;/);
});

test("the compose button floats over it and takes no room", () => {
  const rule = css.slice(css.indexOf(".kaposts-root-compose {"), css.indexOf("}", css.indexOf(".kaposts-root-compose {")));
  assert.match(rule, /position: absolute; bottom: 16px; right: 30px; margin: 0;/);
  assert.doesNotMatch(rule, /position: sticky|-72px/);
  assert.match(css, /@media \(max-width: 620px\) \{ \.kaposts-root-compose \{ right: 16px; \} \}/);
});

console.log(`profile one scrollbar: ${passed} passed`);
