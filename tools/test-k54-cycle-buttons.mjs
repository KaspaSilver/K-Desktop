// node tools/test-k54-cycle-buttons.mjs - K 518fdc8c's cycle buttons, Chess screen and connection
// dot on Desktop: the cycle button (next and round again, dots up to six choices and "3/14" past
// that, its screen-reader label), no page tab bars or segmented page switches left where K has the
// button, the chess leaderboard's fourteen stops in K's order, the connection dot only at the top of
// Settings and on the dock's Settings icon, Edit Profile's Username section first, Connection
// Settings' cards, and the two small audit fixes (#26 the chain feed's block handler, #27 the
// Chats list's rebuild that waits at most a second).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cycleOptions, cycleNextValue, cycleIndex, cyclePosition, cycleAccessibleLabel, cycleButtonHtml, cycleBarHtml,
  cycleButtonInnerHtml, cycleChanged, CYCLE_DOTS_MAX,
} from "../ui/cycle-button.js";
import { chessBoardChoices, CHESS_BOTS } from "../engine/chess-bot.js";
import { coalescedRunner } from "../ui/chat-unread.js";
import { createKaPostLiveFeed } from "../engine/kaposts-chain-fallback.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8");
const html = read("index.html");
const app = read("ui", "app.js");
const kaposts = read("ui", "kaposts.js");
const chess = read("ui", "chess-tournaments.js");
const bots = read("ui", "chess-bots.js");
const uiJs = readdirSync(join(here, "..", "ui")).filter((f) => f.endsWith(".js")).map((f) => [f, read("ui", f)]);
const styles = read("ui", "styles.css");
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}
/** A function's source, read out of a file that can't be imported under node. */
function fnSource(source, name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} exists`);
  let depth = 0;
  for (let i = source.indexOf(") {", start) + 2; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} never closes`);
}

// --- The component ---------------------------------------------------------------------------------

await test("each click goes to the next choice, and round again after the last", () => {
  const feeds = [["following", "Following"], ["feed", "Feed"], ["popular", "Popular"]];
  assert.equal(cycleNextValue(feeds, "following"), "feed");
  assert.equal(cycleNextValue(feeds, "feed"), "popular");
  assert.equal(cycleNextValue(feeds, "popular"), "following", "wraps");
  assert.equal(cycleNextValue(feeds, "popular", -1), "feed", "the left arrow steps back");
  assert.equal(cycleNextValue(feeds, "following", -1), "popular", "and wraps back too");
  assert.equal(cycleNextValue(feeds, "nope"), "following", "an unknown value starts at the first");
  assert.equal(cycleNextValue([], "x"), null);
  assert.equal(cycleIndex(feeds, "popular"), 2);
  assert.deepEqual(cycleOptions(["a", { id: "b", title: "B" }, ["c", "C"]]).map((o) => `${o.id}/${o.title}`), ["a/a", "b/B", "c/C"]);
});

await test("dots for six choices or fewer, \"3/14\" past that", () => {
  assert.equal(CYCLE_DOTS_MAX, 6);
  const six = Array.from({ length: 6 }, (_, i) => String(i));
  const seven = Array.from({ length: 7 }, (_, i) => String(i));
  assert.deepEqual(cyclePosition(six, "5"), { kind: "dots", index: 5, count: 6 });
  assert.equal(cyclePosition(seven, "2").text, "3/7");
  const dotsHtml = cycleButtonInnerHtml([["a", "A"], ["b", "B"], ["c", "C"]], "b");
  assert.equal((dotsHtml.match(/<i/g) || []).length, 3, "a dot per choice");
  assert.match(dotsHtml, /<i><\/i><i class="on"><\/i><i><\/i>/, "the second one lit");
  assert.doesNotMatch(dotsHtml, /cycle-button-count/);
  const board = chessBoardChoices();
  const countHtml = cycleButtonInnerHtml(board, board[2].id);
  assert.match(countHtml, /<span class="cycle-button-count" aria-hidden="true">3\/14<\/span>/);
  assert.doesNotMatch(countHtml, /cycle-button-dots/);
  assert.match(countHtml, /arrow|<svg class="cycle-button-icon"/, "the circling arrows");
});

await test("a button: its label, its next choice, keyboard-reachable", () => {
  const button = cycleButtonHtml({ name: "test-a", options: [["posts", "Posts"], ["replies", "Replies"]], value: "replies", attrs: "data-x" });
  assert.match(button, /^<button type="button" class="cycle-button"/, "a real button: Enter and Space work, and Tab reaches it");
  assert.match(button, /data-cycle="test-a"/);
  assert.match(button, /data-cycle-value="replies" data-cycle-next="posts" data-cycle-prev="posts"/);
  assert.match(button, /aria-label="Replies, 2 of 2\. Switches to the next page"/);
  assert.match(button, / data-x>/);
  assert.equal(cycleAccessibleLabel([["m", "This month"], ["a", "All time"]], "m", "Switches the leaderboard period"), "This month, 1 of 2. Switches the leaderboard period");
  assert.match(cycleBarHtml({ name: "test-b", options: ["x", "y"], value: "x" }), /^<div class="cycle-bar"><button/);
  // titles are escaped
  assert.match(cycleButtonHtml({ name: "test-c", options: [["x", "<b>"]], value: "x" }), /&lt;b&gt;/);
  const source = read("ui", "cycle-button.js");
  assert.match(source, /event\.key === "ArrowRight" \|\| event\.key === "ArrowDown"/, "the arrows step");
  assert.match(source, /:focus-visible|refocus/, "focus follows a repaint");
  assert.match(read("ui", "cycle-button.css"), /\.cycle-button:focus-visible \{ outline: 2px solid var\(--kaspa-ink\)/);
});

await test("the title fades only when the choice changed (a repaint on a timer doesn't blink)", () => {
  assert.equal(cycleChanged("k", "a"), false, "first sight");
  assert.equal(cycleChanged("k", "a"), false, "same again");
  assert.equal(cycleChanged("k", "b"), true, "changed");
  const first = cycleButtonHtml({ name: "fade", options: ["a", "b"], value: "a" });
  const again = cycleButtonHtml({ name: "fade", options: ["a", "b"], value: "a" });
  const next = cycleButtonHtml({ name: "fade", options: ["a", "b"], value: "b" });
  assert.doesNotMatch(first + again, /cycle-changed/);
  assert.match(next, /class="cycle-button cycle-changed"/);
  assert.match(read("ui", "cycle-button.css"), /\.cycle-fade \{ animation: cycle-fade-in \.25s ease-in-out; \}/);
});

// --- Where it replaced tabs -----------------------------------------------------------------------

await test("no page tab bars or segmented page switches left (index.html and ui/*.js)", () => {
  const gone = [
    /kaposts-feed-tab\b/, /data-kaposts-feed-tab=/, /data-kaposts-profile-tab=/, /class="domains-tabs/, /class="domains-tab\b/,
    /connection-tabs/, /data-connection-tab=/, /chats-tab-bar/, /chats-tab-button/, /chess-t-tabs/, /kstats-tabs/,
    /swap-tab-bar/, /data-swap-tab="(swap|history)"/, /data-manage-address-tab=/, /data-spending-detail-tab=/, /data-cold-tab="/,
    /data-chess-t-period=/, /data-chess-bot-period=/, /data-arcade-period="\$\{id\}"/, /aria-label="Leaderboard period"/,
    /kaposts-search-scope" role="tablist"/, /data-kaposts-search-scope="(posts|people)"/, /role="tab"[^>]*data-kstats-page/,
  ];
  for (const [file, src] of [["index.html", html], ...uiJs]) {
    for (const pattern of gone) assert.doesNotMatch(src, pattern, `${file}: ${pattern}`);
  }
  // and nothing swipes between pages
  assert.doesNotMatch(app, /function attachTabSwipe|attachTabSwipe\(/);
  assert.doesNotMatch(kaposts, /function attachFeedPager|attachFeedPager\(\)|wireProfileTabSwipe|profileSwipeTarget/);
  // the old underline styles went with them
  assert.doesNotMatch(styles, /^\.domains-tabs \{|^\.chats-tab-bar \{|^\.kaposts-feed-tabs \{|^\.connection-tabs \{/m);
});

await test("each place K lists has the cycle button", () => {
  // KaPost's three feeds, beside the title (the phone header has the same button)
  assert.match(html, /<div class="kaposts-feed-head" data-kaposts-feed-head>\s*<button class="cycle-button kaposts-feed-cycle"[^>]*data-kaposts-feed-cycle/);
  assert.match(kaposts, /const FEED_CHOICES = \[\["following", "Following"\], \["feed", "Feed"\], \["popular", "Popular"\]\];/);
  assert.match(kaposts, /<h1 class="kaposts-title">KaPost<\/h1>\n\s*<button class="cycle-button kaposts-feed-cycle"/);
  assert.match(kaposts, /selectFeedTab\(button\.dataset\.cycleNext\)/);
  // a profile's Posts / Replies, and KaPost Search's Posts / People (audit #37)
  assert.match(kaposts, /cycleButtonHtml\(\{ name: "kaposts-profile"/);
  assert.match(kaposts, /const SEARCH_SCOPES = \[\["posts", "Posts"\], \["people", "People"\]\];/);
  assert.match(kaposts, /data-cycle="kaposts-search" data-kaposts-search-scope/);
  // an address's pages: Manage Addresses (chatting and spending) and Cold Storage
  assert.match(html, /data-cycle="manage-address" data-manage-address-cycle/);
  assert.match(html, /data-cycle="spending-address" data-spending-detail-cycle/);
  assert.match(app, /const ADDRESS_PAGES = \[\["transactions", "History"\], \["utxos", "UTXOs"\], \["kachat", "Usernames"\]\];/);
  assert.match(read("ui", "coldstorage.js"), /cycleBarHtml\(\{ name: "cold-address", options: COLD_ADDRESS_PAGES/);
  // Stats, Swap, Chess's 1v1 / Tournaments pages
  assert.match(read("ui", "kachat-stats.js"), /cycleBarHtml\(\{ name: "kstats-page", options: PAGES/);
  assert.match(read("ui", "swaps.js"), /cycleBarHtml\(\{ name: "swap-page", options: \[\["swap", "Swap"\], \["history", "Swap History"\]\]/);
  assert.match(chess, /const kindPages = \(duel\) => \[\["play", duel \? "1v1" : "Tournaments"\], \["active", "Active"\], \["finished", "Finished"\]\];/);
  assert.match(chess, /cycleBarHtml\(\{ name: `chess-kind-\$\{view\.mode\}`/);
  // every leaderboard's This month / All time: the arcade's and Chess's
  assert.match(read("ui", "arcade.js"), /cycleButtonHtml\(\{ name: `arcade-period-\$\{gameId\}`, options, value: period, hint: "Switches the leaderboard period"/);
  assert.match(chess, /cycleButtonHtml\(\{ name: "chess-board", options: BOARD_CHOICES/);
});

await test("Connection Settings: a card per connection, each its own page (K has no tabs there)", () => {
  for (const page of ["indexer", "node", "domains", "explorer"]) {
    assert.match(html, new RegExp(`<button type="button" class="connection-card" data-connection-card="${page}">`));
    assert.match(html, new RegExp(`data-connection-panel="${page}" hidden`), `${page}'s page starts hidden`);
  }
  assert.match(html, /<div class="connection-settings-head" data-connection-settings-head hidden>/, "Save only on a page");
  const show = fnSource(app, "showConnectionPage");
  assert.match(show, /if \(cards\) cards\.hidden = Boolean\(connectionPage\);/);
  assert.match(fnSource(app, "connectionPageBack"), /showConnectionPage\(null, \{ bar: true \}\)/);
  assert.match(app, /if \(connectionPageBack\(\)\) return;\n  showSettingsCategory/, "Back goes to the cards first");
  assert.match(app, /\/\/ Save keeps it and goes back to the cards \(K pageScreen's Save\)\.\n  showConnectionPage\(null, \{ bar: true \}\);/);
  const host = new Function(`${fnSource(app, "connectionHost")}; return connectionHost;`)();
  assert.equal(host("https://indexer.kachat.app/path"), "indexer.kachat.app");
  assert.equal(host("api.kaspa.org"), "api.kaspa.org");
  assert.equal(host(""), "Not set");
});

// --- Chess ----------------------------------------------------------------------------------------

await test("the chess leaderboard's 14 stops, in K's order", () => {
  const stops = chessBoardChoices();
  assert.equal(CHESS_BOTS.length, 5);
  assert.equal(stops.length, 14);
  assert.deepEqual(stops.map((s) => s.id), [
    "duel:month", "duel:all", "tournament:month", "tournament:all",
    "bot1:month", "bot1:all", "bot2:month", "bot2:all", "bot3:month", "bot3:all",
    "bot4:month", "bot4:all", "bot5:month", "bot5:all",
  ]);
  assert.equal(stops[0].title, "1v1 · This month");
  assert.equal(stops[3].title, "Tournaments · All time");
  assert.equal(stops[4].title, "Kaspa Silver · This month");
  assert.equal(stops[13].title, "Yonatan Sompolinsky · All time");
  assert.deepEqual(stops.filter((s) => s.kind === "bot").map((s) => s.level), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  assert.equal(cyclePosition(stops, "bot1:month").text, "5/14");
  assert.equal(cycleNextValue(stops, "bot5:all"), "duel:month", "round again");
});

await test("Chess's screen: a Play card whose Play opens 1v1, Tournament or Bots; the board under it", () => {
  const home = fnSource(chess, "renderHome");
  assert.match(home, /<div class="arcade-hero chess-t-play-card">/);
  assert.match(home, /data-chess-t-play>Play<\/button>/);
  assert.match(home, /\$\{boardHtml\(\)\}/);
  assert.doesNotMatch(home, /data-chess-t-mode|data-chess-t-bots|data-chess-t-leaderboard/, "no cards to the old screens");
  const sheet = fnSource(chess, "openPlaySheet");
  assert.match(sheet, /title: "Choose your game"/);
  assert.match(sheet, /\{ id: "duel", title: "1v1"[^}]*\},\n\s*\{ id: "tournament", title: "Tournament"[^}]*\},\n\s*\{ id: "bots", title: "Bots"/);
  assert.match(fnSource(chess, "playChess"), /openKind\(choice\);\n\s*else if \(choice === "bots"\) openBots\(\);/);
  const board = fnSource(chess, "boardHtml");
  assert.match(board, /rows\.slice\(0, 10\)/, "top ten, as K");
  assert.match(board, /chessBotBoardRows\(choice\.level, choice\.period\)/);
  assert.match(board, /T\.duelLeaderboard\(rowsOfPeriod\)/);
  assert.match(board, /T\.tournamentLeaderboard\(rowsOfPeriod\)/);
  assert.match(board, /data-chess-t-user=/, "a row opens the player");
  // the separate leaderboard screens are gone (audit #41)
  assert.doesNotMatch(chess, /renderLeaderboardPage|function renderLeaderboard\(|name: "leaderboard"|name: "board"/);
  assert.doesNotMatch(bots, /function renderBoards\(|function renderBoard\(|openChessBotBoards|screen === "boards"/);
  // kept: the invite text and the held challenges
  assert.match(chess, /open KaPlay >/);
  assert.match(chess, /heldArcadeChallenge/);
});

// --- The connection dot ---------------------------------------------------------------------------

await test("the connection dot is only at the top of Settings and on the dock's Settings icon", () => {
  assert.doesNotMatch(html, /data-service-health-led|data-mirror-health-led|data-mirror-health-button|data-service-health-button/);
  assert.equal((html.match(/data-settings-health-led/g) || []).length, 1, "the top of Settings");
  const settingsTab = html.slice(html.indexOf('<button class="sidebar-tab" type="button" data-app-tab="settings"'));
  const settingsButton = settingsTab.slice(0, settingsTab.indexOf("</button>"));
  assert.match(settingsButton, /<span class="sidebar-tab-badge dot dock-connection-dot busy" data-dock-connection-dot aria-hidden="true"><\/span>/,
    "on the Settings dock button: the left dock and the phone bottom bar are the same buttons");
  assert.equal((html.match(/data-dock-connection-dot/g) || []).length, 1);
  assert.match(fnSource(app, "paintConnectionDots"), /querySelectorAll\("\[data-settings-health-led\], \[data-dock-connection-dot\]"\)/);
  for (const [file, src] of uiJs) assert.doesNotMatch(src, /service-health-led busy|mirror-health/, file);
});

await test("green connected, orange connecting, red once the drop lasted 8 s", () => {
  const dotFor = new Function(`${fnSource(app, "connectionDotFor")}; return connectionDotFor;`)();
  assert.deepEqual(dotFor({ stateName: "ready" }), { state: "ready", label: "Connected" });
  assert.deepEqual(dotFor({ stateName: "busy", latencyMs: 900 }), { state: "ready", label: "Connected" }, "a slow node is still connected (K)");
  assert.deepEqual(dotFor({ stateName: "busy", connecting: true }), { state: "busy", label: "Connecting" });
  assert.deepEqual(dotFor({ stateName: "error" }), { state: "error", label: "Disconnected" });
  assert.match(app, /const DISCONNECT_GRACE_MS = 8_?000;/);
  const css = read("ui", "cycle-button.css");
  assert.match(css, /dock-connection-dot\.ready \{ background: var\(--ios-green\); \}/);
  assert.match(css, /dock-connection-dot\.busy \{ background: var\(--ios-orange\); \}/);
  assert.match(css, /dock-connection-dot\.error \{ background: var\(--ios-red\); \}/);
});

// --- KaPost profile and Edit Profile --------------------------------------------------------------

await test("someone else's profile: Follow and Chat under the follow counts", () => {
  const counts = kaposts.indexOf('<span class="kaposts-profile-counts">');
  const actions = kaposts.indexOf('<span class="kaposts-profile-actions kaposts-under-counts">');
  const bio = kaposts.indexOf("kaposts-profile-bio\" data-kaposts-profile-bio");
  assert.ok(counts > 0 && actions > counts && bio > actions, "counts, then Follow and Chat, then the bio");
  const after = kaposts.slice(actions, actions + 1200);
  assert.match(after, /data-kaposts-profile-follow/);
  assert.match(after, /data-kaposts-profile-chat/);
});

await test("Edit Profile: the Username section first, Get a username opens the Usernames screen", () => {
  const live = read("ui", "kachat-names-live.js");
  const form = live.slice(live.indexOf("const formHtml = () => `"), live.indexOf("// MARK: rendering"));
  const username = form.indexOf('header: "Username"');
  assert.ok(username > 0 && username < form.indexOf("Your profile belongs to your address"), "before everything else");
  assert.ok(username < form.indexOf("SOCIAL_KINDS.map(fieldHtml)"), "before Avatar");
  assert.match(form, /Get a username/);
  assert.doesNotMatch(form, /Get a \.kachat name|header: "\.kachat Name"/);
  assert.match(live, /if \(event\.target\.closest\("\[data-kl-get-kachat-name\]"\)\) \{\n\s*kit\.closeLayer\(layer\);\n\s*deps\(\)\.openKachatNames\?\.\(\);/);
  assert.match(app, /openKachatNames: \(\) => setActiveAppTab\("kachat-names"\),/);
});

// --- Audit #26 and #27 ----------------------------------------------------------------------------

await test("#26: the chain feed's block handler goes when the fallback goes inactive", () => {
  let added = 0;
  let removed = 0;
  const engine = { addBlockScanClient: () => { added += 1; return () => { removed += 1; }; } };
  const feed = createKaPostLiveFeed();
  feed.setActive(engine, true);
  assert.equal(added, 1);
  feed.setActive(engine, true);
  assert.equal(added, 1, "once");
  feed.setActive(engine, false);
  assert.equal(removed, 1, "removed with the outage");
  feed.setActive(engine, false);
  assert.equal(removed, 1);
  feed.setActive(engine, true);
  feed.setActive(engine, false);
  assert.deepEqual([added, removed], [2, 2], "every outage adds one and takes it away again");
});

await test("#27: the Chats list rebuild waits at most a second", () => {
  let clock = 0;
  const timers = new Map();
  let nextId = 1;
  const setTimer = (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: clock + ms }); return id; };
  const clearTimer = (id) => timers.delete(id);
  const advance = (ms) => {
    const end = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = due[1].at;
      due[1].fn();
    }
    clock = end;
  };
  let runs = 0;
  const schedule = coalescedRunner({ run: () => { runs += 1; }, delayMs: 180, maxWaitMs: 1000, setTimer, clearTimer, now: () => clock });
  schedule();
  assert.equal(runs, 1, "the first change after a quiet spell shows at once");
  // a change every 100 ms for three seconds: a pure debounce would never run
  for (let i = 0; i < 30; i += 1) { advance(100); schedule(); }
  assert.ok(runs >= 3 && runs <= 4, `rebuilt about once a second while it goes on (${runs})`);
  const before = runs;
  advance(180);
  assert.equal(runs, before + 1, "and once more 180 ms after it stops");
  schedule.cancel();
  assert.match(app, /const scheduleChatSearchRender = coalescedRunner\(\{ run: \(\) => renderChats\(\), delayMs: 180, maxWaitMs: 1000 \}\);/);
});

console.log(`k54 cycle buttons: ${passed} passed`);
