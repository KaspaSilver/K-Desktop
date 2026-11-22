// Leaderboard (KaChat iOS 148a5331 made it a tab of its own; K 428a797b put it back inside
// KaPlay > Chess as a card under Bots): no dock item, and a saved spot asking for it opens KaPlay.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RAIL_ORDER, dockLayoutFor } from "../ui/dock-arrangement.js";
import { CHILD_HIDDEN_TABS } from "../ui/childmode.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const app = read("ui/app.js");
const chess = read("ui/chess-tournaments.js");
const html = read("index.html");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

test("no Leaderboard dock item anywhere", () => {
  assert.ok(!RAIL_ORDER.includes("leaderboard"));
  assert.ok(!dockLayoutFor(false).hub.includes("leaderboard"));
  assert.ok(!CHILD_HIDDEN_TABS.includes("leaderboard"));
  assert.doesNotMatch(html, /data-app-tab="leaderboard"/);
  assert.match(app, /if \(tab === "leaderboard"\) tab = "chess";/);
  assert.doesNotMatch(chess, /rootView|viewByRoot/);
});
test("a Leaderboard card after Bots on the Chess screen, with a way back", () => {
  const bots = chess.indexOf("data-chess-t-bots>");
  const card = chess.indexOf("data-chess-t-leaderboard>");
  assert.ok(bots > 0 && card > bots);
  assert.match(chess, /<strong>Leaderboard<\/strong><small>Who's on top in 1v1 and tournaments, this month or all time, and against each bot\.<\/small>/);
  assert.match(chess, /headerHtml\("Leaderboard", \{ back: true \}\)/);
  assert.match(chess, /closest\("\[data-chess-t-leaderboard\]"\)\) \{\n[^\n]*\n\s*view = \{ \.\.\.view, name: "leaderboard"/);
});

console.log(`leaderboard in KaPlay: ${passed} passed`);
