// KaChat iOS 148a5331: Leaderboard is a tab of its own (ChessLeaderboardTabView: 1v1, Tournaments,
// Bots), and Chess's screen has no Leaderboard card. On Desktop it's a dock item after KaPlay that
// opens the Chess screen on the Leaderboard's page, with no way back from it.
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

test("a Leaderboard dock item right after KaPlay; More holds it on a phone; Simple Mode hides it", () => {
  assert.equal(RAIL_ORDER[RAIL_ORDER.indexOf("chess") + 1], "leaderboard");
  assert.ok(dockLayoutFor(false).hub.includes("leaderboard"));
  assert.ok(CHILD_HIDDEN_TABS.includes("leaderboard"));
  assert.match(html, /data-app-tab="leaderboard" hidden>[\s\S]*?<span>Leaderboard<\/span>/);
});
test("it shows the Chess screen on the Leaderboard, which has no back there", () => {
  assert.match(app, /screenTab === "leaderboard" \? "chess" : screenTab/);
  assert.match(app, /showChessTournaments\(\{ root: screenTab === "leaderboard" \? "leaderboard" : "games" \}\)/);
  assert.match(chess, /headerHtml\("Leaderboard", \{ back: rootView !== "leaderboard" \}\)/);
  assert.match(chess, /viewByRoot\[rootView\] = view;/);
});
test("Chess has no Leaderboard card", () => {
  assert.doesNotMatch(chess, /data-chess-t-leaderboard/);
});

console.log(`ios 148a5331 leaderboard: ${passed} passed`);
