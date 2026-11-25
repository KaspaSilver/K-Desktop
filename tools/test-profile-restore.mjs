// A refresh on Profile comes back as your profile, not KaPost's feed. The remembered tab is put
// back (restoreLastAppTab) before KaPost starts, and setKaPostsRootMode does nothing until it has,
// so the profile is asked for again right after initKaPosts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
const kaposts = readFileSync(new URL("../ui/kaposts.js", import.meta.url), "utf8");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

test("KaPost ignores the root mode until it has started", () => {
  assert.match(kaposts, /export function setKaPostsRootMode\(mode\) \{\n\s*if \(!deps\) return;/);
});

test("the tab is restored before KaPost starts, and Profile is asked for again after", () => {
  const restore = app.indexOf("  restoreLastAppTab();\n");
  const init = app.indexOf("    initKaPosts({");
  const again = app.indexOf('if (document.body.dataset.appTab === "profile") { try { setKaPostsRootMode("myProfile"); }');
  assert.ok(restore > 0 && init > restore, "restore runs first");
  assert.ok(again > init, "profile asked for after initKaPosts");
  const between = app.slice(init, again);
  assert.match(between, /initKaPosts did not start/);
  assert.ok(!between.includes("initBroadcasts("), "right after initKaPosts, before the rooms start");
});

console.log(`profile restore: ${passed} passed`);
