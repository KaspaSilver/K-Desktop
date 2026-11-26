// Leaderboard (KaChat iOS 148a5331 made it a tab of its own; K 428a797b put it back inside
// KaPlay > Chess as a card under Bots; K 518fdc8c drew it on Chess's own screen and deleted the
// separate leaderboard screens): no dock item, and a saved spot asking for it opens KaPlay.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RAIL_ORDER, dockLayoutFor } from "../ui/dock-arrangement.js";

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
  assert.doesNotMatch(html, /data-app-tab="leaderboard"/);
  assert.match(app, /if \(tab === "leaderboard"\) tab = "chess";/);
  assert.doesNotMatch(chess, /rootView|viewByRoot/);
});
test("the leaderboard is on Chess's screen, under the Play card; no leaderboard screens (K 518fdc8c)", () => {
  const home = chess.slice(chess.indexOf("function renderHome() {"), chess.indexOf("async function openPlaySheet()"));
  assert.ok(home.indexOf("data-chess-t-play") > 0 && home.indexOf("${boardHtml()}") > home.indexOf("data-chess-t-play"));
  assert.match(chess, /<h2>Leaderboard<\/h2>/);
  assert.doesNotMatch(chess, /data-chess-t-leaderboard|name: "leaderboard"|renderLeaderboardPage|function renderLeaderboard\(|chess-t-square/);
  assert.doesNotMatch(read("ui/chess-bots.js"), /function renderBoards?\(|openChessBotBoards|"boards"/);
});

console.log(`leaderboard in KaPlay: ${passed} passed`);
