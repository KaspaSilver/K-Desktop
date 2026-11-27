// node tools/test-ios-b49a021d-menus.mjs - K b49a021d, the menus: More's sections are alphabetical,
// a section left over a minute ago is forgotten (More's next click is the menu), and the Posts menu
// is a glass card from the top, only as tall as its rows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const app = read("ui/app.js");
const kaposts = read("ui/kaposts.js");
const drawerCss = read("ui/kaposts-drawer.css");

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }

test("More's menu lists its sections alphabetically by the name shown", () => {
  assert.match(app, /function hubMenuTabs\(\) \{\n\s+return hubVisibleTabs\(\)\.slice\(\)\.sort\(\(a, b\) => tabFullName\(a\)\.localeCompare\(tabFullName\(b\)/);
  assert.match(app, /querySelector\("\[data-hub-menu\]"\)\.innerHTML = hubMenuTabs\(\)\.map/);
});
test("a section left over a minute ago is forgotten", () => {
  assert.match(app, /const HUB_REMEMBER_FOR_MS = 60_000;/);
  assert.match(app, /if \(tab === "hub"\) hubLeftAt = null;\n\s+else if \(currentAppTab === "hub" && lastHubSection && !hubLeftAt\) hubLeftAt = Date\.now\(\);\n\s+currentAppTab = tab;/);
  assert.match(app, /if \(currentAppTab === "hub" && hubSection\) \{ openHubMenu\(\); return; \}\n\s+forgetStaleHubSection\(\);/);
  // declared before setActiveAppTab, which runs during start-up
  assert.ok(app.indexOf("let hubLeftAt = null;") < app.indexOf("function setActiveAppTab("));
});
test("the Posts menu is a glass card, only as tall as its rows", async () => {
  const { kapostsDrawerWidth, kapostsDrawerDim } = await import("../ui/kaposts-format.js");
  assert.equal(kapostsDrawerWidth(400), 296);
  assert.equal(kapostsDrawerWidth(1000), 340);
  assert.equal(kapostsDrawerDim(0, 300), 0.3);
  assert.match(drawerCss, /\.kaposts-drawer-card \{\n\s+position: absolute; top: calc\([^;]+\+ 6px\); left: 12px;\n\s+width: min\(74vw, 340px\);/);
  assert.doesNotMatch(drawerCss, /\.kaposts-drawer-card \{[^}]*bottom: 0/, "no longer full height");
  assert.match(drawerCss, /border-radius: 26px;/);
  assert.match(drawerCss, /\.kaposts-drawer-row-icon \{\n\s+flex: 0 0 34px; width: 34px; height: 34px;/);
  assert.doesNotMatch(kaposts, /kaposts-drawer-divider/);
  assert.match(kaposts, /<span class="kaposts-drawer-row-icon" aria-hidden="true">/);
});
console.log(`ios b49a021d menus: ${passed} passed`);
