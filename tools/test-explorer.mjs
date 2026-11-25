// node tools/test-explorer.mjs - the Explorer (K 961fc05a), which replaced KaChat Stats: what a
// transaction is from its payload's prefix (ExplorerAPI.classify), kaspa.stream's answers and K's
// node's blocks mapped, an address page's rules (unaccepted mining rewards left out, any other
// unaccepted transaction Not Accepted and not counted, Load More 20 then 40), search, the chart
// series (hashrate history, block reward schedule, market cap, Kaspalytics fees), K Activity from the
// indexer's /stats, the Mining Estimate moved from Portfolio, and the wiring: the dock item, the old
// tab id landing on the Explorer, live blocks only while it shows, Portfolio's hashrate gone.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import * as X from "../engine/explorer.js";
import { RAIL_ORDER, PHONE_BAR, dockLayoutFor, currentTabId } from "../ui/dock-arrangement.js";
import { KUSDT_DEPLOYMENTS } from "../engine/kusdt.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const app = read("ui/app.js");
const html = read("index.html");
const ui = read("ui/explorer.js");
const css = read("ui/explorer.css");
const portfolio = read("ui/portfolio.js");
const endpoints = read("engine/endpoints.js");
const styles = read("ui/styles.css");

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}
const hex = (text) => Buffer.from(text, "utf8").toString("hex");
const kindOf = (text, extra = {}) => X.classifyTransaction({ payloadHex: hex(text), ...extra }).kind;

// --- classify ------------------------------------------------------------------------------------

await test("K's protocols are told apart by the payload's prefix (K ExplorerAPI.classify)", () => {
  assert.equal(kindOf("kchat:1:handshake:abc"), "handshake");
  assert.equal(kindOf("kchat:1:self_stash:abc"), "handshake");
  for (const action of ["comm", "gcomm", "gctl", "dm"]) assert.equal(kindOf(`kchat:1:${action}:x`), "kachatMessage", action);
  for (const action of ["pay", "tip"]) assert.equal(kindOf(`kchat:1:${action}:x`), "payment", action);
  for (const action of ["name", "offer", "profile"]) assert.equal(kindOf(`kchat:1:${action}:x`), "kachatName", action);
  for (const action of ["post", "reply", "quote", "vote", "follow"]) assert.equal(kindOf(`kchat:1:${action}:x`), "kapost", action);
  assert.equal(kindOf("k:1:post:pub:sig:aGk="), "kapost");
  // the older roots
  assert.equal(kindOf("ciph_msg:1:comm:x"), "kachatMessage");
  assert.equal(kindOf("ciph_msg:handshake:x"), "handshake");
  // public chats: the chess and arcade rooms are their own kinds
  assert.equal(kindOf("kchat:1:bcast:chess-arena:move"), "chessMove");
  assert.equal(kindOf("kchat:1:bcast:chess-bots:move"), "chessMove");
  assert.equal(kindOf("kchat:1:bcast:kplay-arcade:stamp"), "arcadeStamp");
  assert.equal(kindOf("kchat:1:bcast:kaspa:hello"), "publicChat");
  // not K's, and no payload
  assert.equal(kindOf("hello world"), "other");
  assert.equal(X.classifyTransaction({ payloadHex: "" }).kind, "payment");
  assert.equal(X.classifyTransaction({ payloadHex: null }).kind, "payment");
});

await test("mining rewards by subnetwork, kUSDT and its pool by covenant", () => {
  assert.equal(X.classifyTransaction({ payloadHex: hex("kchat:1:comm:x"), subnetwork: "0100000000000000000000000000000000000000" }).kind, "coinbase");
  const m = KUSDT_DEPLOYMENTS.mainnet;
  assert.equal(X.classifyTransaction({ covenants: [m.poolId.toUpperCase()], network: "mainnet" }).kind, "kusdtSwap");
  assert.equal(X.classifyTransaction({ covenants: [m.covenantId], network: "mainnet" }).kind, "kusdtTransfer");
  // another network's ids are nobody's here
  assert.equal(X.classifyTransaction({ covenants: [m.covenantId], network: "testnet-10" }).kind, "payment");
  assert.equal(X.classifyTransaction({ covenants: [KUSDT_DEPLOYMENTS["testnet-10"].covenantId], network: "testnet-10" }).kind, "kusdtTransfer");
});

await test("lists read only the first 128 bytes; a transaction's own page reads it all", () => {
  const long = `kchat:1:bcast:general:${"é".repeat(400)}`;
  const listed = X.classifyTransaction({ payloadHex: hex(long) });
  assert.deepEqual(listed, { kind: "publicChat", decoded: null });
  const full = X.classifyTransaction({ payloadHex: hex("kchat:1:bcast:general:gm all"), full: true });
  assert.deepEqual(full, { kind: "publicChat", decoded: "#general: gm all" });
  // a 280-character preview
  assert.ok(X.classifyTransaction({ payloadHex: hex(long), full: true }).decoded.endsWith("…"));
  // KaPost's text through the app's own parser, only on the full read
  const parsePost = (text) => (text.startsWith("kchat:1:post:") ? { message: "  Hello Kaspa  " } : null);
  assert.equal(X.classifyTransaction({ payloadHex: hex("kchat:1:post:pk:sig:x"), full: true, parsePost }).decoded, "Hello Kaspa");
  assert.equal(X.classifyTransaction({ payloadHex: hex("kchat:1:post:pk:sig:x"), parsePost }).decoded, null);
  // not UTF-8 at all: some other app's
  assert.equal(X.classifyTransaction({ payloadHex: "ff00fe", full: true }).kind, "other");
  // readFully fills in a listed KaPost / public chat only
  const tx = { kind: "publicChat", payloadHex: hex("kchat:1:bcast:kaspa:hi"), decoded: null };
  assert.equal(X.readFully(tx).decoded, "#kaspa: hi");
  const payment = { kind: "payment", payloadHex: "", decoded: null };
  assert.equal(X.readFully(payment), payment);
});

await test("every kind has K's title, plural and explanation; K Activity lists only K's", () => {
  for (const [kind, info] of Object.entries(X.TX_KINDS)) {
    assert.ok(info.title && info.plural && info.explanation && info.icon, kind);
  }
  assert.equal(X.TX_KINDS.coinbase.title, "Mining Reward");
  assert.equal(X.TX_KINDS.kachatName.title, "Username");
  assert.equal(X.isKKind("payment"), false);
  assert.equal(X.isKKind("coinbase"), false);
  assert.equal(X.isKKind("other"), false);
  assert.equal(X.isKKind("kapost"), true);
  assert.equal(X.isKKind("kusdtSwap"), true);
});

// --- mapping -------------------------------------------------------------------------------------

const A = "kaspa:qqaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "kaspa:qqbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const indexed = (over = {}) => ({
  transaction_id: "ab".repeat(32), subnetwork_id: "0000000000000000000000000000000000000000", mass: "2036", payload: "",
  block_hash: ["cd".repeat(32)], block_time: 1_795_000_000_000, is_accepted: true, accepting_block_blue_score: 1000,
  inputs: [{ index: 0, previous_outpoint_address: A, previous_outpoint_amount: 10_000_000_000 }],
  outputs: [{ index: 0, amount: 100_000_000, script_public_key_address: B }, { index: 1, amount: 9_899_990_000, script_public_key_address: A }],
  ...over,
});

await test("an indexed transaction: fee from resolved inputs, confirmations from the virtual blue score", () => {
  const tx = X.transactionFromIndexed(indexed(), { virtualBlueScore: 1009 });
  assert.equal(tx.kind, "payment");
  assert.equal(tx.fee, 10_000);
  assert.equal(tx.confirmations, 10);
  assert.equal(tx.mass, 2036);
  assert.equal(tx.blockHash, "cd".repeat(32));
  assert.equal(tx.isAccepted, true);
  assert.equal(X.movedAmount(tx), 100_000_000); // the change back to A left out
  // an input whose amount didn't come back: the fee isn't known
  const unresolved = X.transactionFromIndexed(indexed({ inputs: [{ index: 0, previous_outpoint_address: A }] }));
  assert.equal(unresolved.fee, null);
  // not accepted: no confirmations, Not Accepted
  const dropped = X.transactionFromIndexed(indexed({ is_accepted: false }), { virtualBlueScore: 1009 });
  assert.equal(dropped.confirmations, 0);
  assert.equal(X.isNotAccepted(dropped), true);
  assert.equal(X.isNotAccepted(X.transactionFromIndexed(indexed({ is_accepted: undefined }))), false);
  // a coinbase pays no fee
  assert.equal(X.transactionFromIndexed(indexed({ subnetwork_id: "0100000000000000000000000000000000000000", inputs: [] })).fee, 0);
});

await test("a node block, from kaspa.stream's /blocks and from K's node's block-added (WASM shapes)", () => {
  const rest = {
    header: { timestamp: "1795000000000", daaScore: "602000000", blueScore: "600000000", parents: [{ parentHashes: ["p1", "p2"] }] },
    verboseData: { hash: "h1", difficulty: 1.6e16, isChainBlock: true, transactionIds: ["t0", "t1"], childrenHashes: ["c1"], mergeSetBluesHashes: ["a", "b"], mergeSetRedsHashes: [] },
    transactions: [
      { subnetworkId: "0100000000000000000000000000000000000000", inputs: [], outputs: [{ amount: "18300000", verboseData: { scriptPublicKeyAddress: A } }], payload: "", verboseData: { transactionId: "t0" } },
      { subnetworkId: "0000000000000000000000000000000000000000", inputs: [{}, {}], outputs: [{ amount: "5", verboseData: { scriptPublicKeyAddress: B } }], payload: hex("kchat:1:comm:x"), mass: "3000", verboseData: { transactionId: "t1" } },
    ],
  };
  const block = X.blockFromNode(rest);
  assert.equal(block.id, "h1");
  assert.equal(block.daaScore, 602_000_000);
  assert.equal(block.blueScore, 600_000_000);
  assert.deepEqual(block.parents, ["p1", "p2"]);
  assert.equal(block.mergeSetBlues, 2);
  assert.equal(block.transactions[0].kind, "coinbase");
  assert.equal(block.transactions[1].kind, "kachatMessage");
  // its inputs are only the coins they spend: no address, so the amount can't be told ("–")
  assert.equal(block.transactions[1].inputs.length, 2);
  assert.equal(X.movedAmount(block.transactions[1]), 5); // one output has no change
  // the WASM SDK: BigInts, `value` for amounts, parentsByLevel, no verbose output addresses
  const wasm = {
    header: { hash: "h2", timestamp: 1_795_000_000_123n, daaScore: 602_000_010n, blueScore: 600_000_009n, parentsByLevel: [["p9"]] },
    verboseData: { hash: "h2", difficulty: 1.6e16, isChainBlock: false, transactionIds: ["u1"] },
    transactions: [{ subnetworkId: "0000000000000000000000000000000000000000", inputs: [{}], outputs: [{ value: 7n, scriptPublicKey: { version: 0, script: "20ab" } }, { value: 9n, scriptPublicKey: {} }], payload: Uint8Array.from(Buffer.from("kchat:1:pay:x")), verboseData: { transactionId: "u1" } }],
  };
  const live = X.blockFromNode(wasm, { addressOf: (o) => (o.scriptPublicKey?.script ? B : "") });
  assert.equal(live.time, 1_795_000_000_123);
  assert.equal(live.daaScore, 602_000_010);
  assert.deepEqual(live.parents, ["p9"]);
  assert.equal(live.transactions[0].kind, "payment");
  assert.deepEqual(live.transactions[0].outputs.map((o) => [o.address, o.amount]), [[B, 7], ["", 9]]);
  assert.equal(X.movedAmount(live.transactions[0]), null);
  assert.equal(X.amountLine(live.transactions[0]), "–");
});

// --- address pages -------------------------------------------------------------------------------

await test("an address page: unaccepted mining rewards left out, other unaccepted ones kept and not counted", () => {
  const now = Date.UTC(2026, 10, 25);
  const reward = { ...X.transactionFromIndexed(indexed({ subnetwork_id: "0100000000000000000000000000000000000000", inputs: [], outputs: [{ index: 0, amount: 500, script_public_key_address: A }], is_accepted: false })), time: now - 1000 };
  const accepted = { ...X.transactionFromIndexed(indexed({ subnetwork_id: "0100000000000000000000000000000000000000", inputs: [], outputs: [{ index: 0, amount: 700, script_public_key_address: A }] })), time: now - 2000 };
  const failed = { ...X.transactionFromIndexed(indexed({ is_accepted: false })), time: now - 3000 };
  const sent = { ...X.transactionFromIndexed(indexed()), time: now - 4000 };
  const history = X.addressHistory([reward, accepted, failed, sent]);
  assert.deepEqual(history.map((t) => t.id ? t.time : 0), [accepted.time, failed.time, sent.time]);
  const summary = X.addressSummary([accepted, failed, sent], A, { nextPageBefore: null, now });
  assert.equal(summary.received30d, 700);
  // A spent 100 KAS and got 98.9999 back: 1.0001 KAS out; the unaccepted copy moved nothing
  assert.equal(summary.sent30d, 100_010_000);
  assert.equal(summary.summaryCoversMonth, true);
  // a page that stops short of 30 days ago with more to load isn't the whole month
  assert.equal(X.addressSummary([sent], A, { nextPageBefore: 123, now }).summaryCoversMonth, false);
  assert.equal(X.perspectiveAmount(sent, A), "−1 KAS");
  assert.equal(X.perspectiveAmount(sent, B), "+1 KAS");
});

await test("history pages: 20 first, 40 per Load More, the cursor from x-next-page-before", () => {
  assert.equal(X.FIRST_ADDRESS_PAGE, 20);
  assert.equal(X.LATER_ADDRESS_PAGE, 40);
  assert.equal(X.nextPageCursor(20, 20, "1795000000000"), 1_795_000_000_000);
  assert.equal(X.nextPageCursor(12, 20, "1795000000000"), null); // a short page is the last
  assert.equal(X.nextPageCursor(20, 20, null), null);
  assert.match(ui, /full-transactions-page/);
  assert.match(ui, /headers\.get\("x-next-page-before"\)/);
});

// --- search --------------------------------------------------------------------------------------

await test("search as you type: an address anywhere in pasted text, a 64-character id, or a name", () => {
  assert.deepEqual(X.queryKind(`send to ${A}, thanks`), { kind: "address", value: A });
  assert.deepEqual(X.queryKind("KASPA:QQ"), { kind: "address", value: "kaspa:qq" });
  assert.deepEqual(X.queryKind("AB".repeat(32)), { kind: "id", value: "ab".repeat(32) });
  assert.deepEqual(X.queryKind(" alice.kachat "), { kind: "name", value: "alice.kachat" });
  assert.deepEqual(X.queryKind("   "), { kind: "", value: "" });
  assert.equal(X.addressIn("nothing here"), null);
  // looked up a moment after typing stops, and only the newest lookup lands
  assert.match(ui, /home\.typedTimer = setTimeout\(\(\) => \{ lookUpTyped\(text, token\)/);
  assert.match(ui, /if \(!current\(\)\) return;/);
  assert.match(ui, /"Nothing Found"/);
});

// --- formatting ----------------------------------------------------------------------------------

await test("K's formats: ids cut in the middle, hashrate, ages, percents", () => {
  assert.equal(X.shortId(A), "kaspa:qqaa...aaaa");
  assert.equal(X.shortId("0123456789abcdef".repeat(4)), "012345…abcdef");
  assert.equal(X.shortId("short"), "short");
  assert.equal(X.hashrateText(323.28e15), "323.28 PH/s");
  assert.equal(X.hashrateText(1.47e18), "1.47 EH/s");
  const now = 1_000_000_000;
  assert.equal(X.ago(now - 2000, now), "just now");
  assert.equal(X.ago(now - 12_000, now), "12 sec. ago");
  assert.equal(X.ago(now - 3 * 60_000, now), "3 min. ago");
  assert.equal(X.percentText(4.21), "4.2%");
  assert.equal(X.percentText(-27_743.4), "27,743%");
  assert.equal(X.daysUntil(now + 6.5 * 86_400_000, now), "6 days");
  assert.equal(X.daysUntil(now + 3600_000, now), "hours");
  assert.equal(X.metricFormat("price", 0.08423), "$0.0842");
  assert.equal(X.metricFormat("price", 0.004), "$0.00400");
  assert.equal(X.metricFormat("networkFees", 0.000314), "0.000314 KAS");
  assert.equal(X.metricFormat("networkFees", 2418.27), "2,418.3 KAS");
  assert.equal(X.compactUsd(2.345e9), "$2.35B");
  assert.equal(X.rewardText(183_540_480), "1.8354 KAS");
  assert.equal(X.groupTyped("1200000.5"), "1,200,000.5");
  assert.equal(X.typedNumber("1,200.5"), 1200.5);
});

// --- charts --------------------------------------------------------------------------------------

await test("the block reward follows Kaspa's emission schedule", () => {
  assert.equal(X.rewardPerBlock(Date.UTC(2022, 0, 1)), 500);
  assert.equal(X.rewardPerBlock(X.CHROMATIC_START), 440);
  // twelve months in it has halved
  assert.ok(Math.abs(X.rewardPerBlock(X.CHROMATIC_START + 12 * 30.44 * 86_400_000 + 1000) - 220) < 1e-9);
  // ten blocks a second from Crescendo: each block a tenth
  const before = X.rewardPerBlock(X.CRESCENDO - 1000);
  assert.ok(Math.abs(X.rewardPerBlock(X.CRESCENDO) - before / 10) < 1e-9);
  const series = X.blockRewardSeries("allTime", Date.UTC(2026, 10, 25));
  assert.equal(series.length, 200);
  assert.equal(series[0].date, X.MAINNET_LAUNCH);
  assert.equal(X.blockRewardSeries("day", 1e12).length, 96);
  assert.equal(X.METRICS.blockReward.stepped, true);
});

await test("hashrate history: two UTC days for 24 Hours, months for 7 / 30 Days, weekly for All Time", () => {
  const now = Date.UTC(2026, 10, 1, 6);
  assert.deepEqual(X.hashrateRequests("day", now).paths, ["/info/hashrate/history/2026-10-31", "/info/hashrate/history/2026-11-01"]);
  assert.deepEqual(X.hashrateRequests("week", now).paths, ["/info/hashrate/history/2026-10", "/info/hashrate/history/2026-11"]);
  assert.deepEqual(X.hashrateRequests("allTime", now), { since: 0, paths: ["/info/hashrate/history?resolution=7d"] });
  const points = X.hashratePoints([{ timestamp: 3, hashrate_kh: 2 }, { timestamp: 1, hashrate_kh: 323277049444108 }, { timestamp: 0, hashrate_kh: 1 }], 1);
  assert.deepEqual(points, [{ date: 1, value: 323277049444108000 }, { date: 3, value: 2000 }]);
  assert.equal(X.hashrateText(points[0].value), "323.28 PH/s");
  assert.equal(X.downsample(Array.from({ length: 1000 }, (_, i) => i), 240).length, 240);
});

await test("market cap: each price times the supply then, worked back along the emission", () => {
  const now = Date.UTC(2026, 10, 25);
  const prices = [{ date: now - 2 * 86_400_000, value: 0.1 }, { date: now - 86_400_000, value: 0.1 }];
  const caps = X.marketCapSeries(prices, 27_828_734_739, now);
  assert.equal(caps.length, 2);
  assert.ok(caps[0].value < caps[1].value, "less supply further back");
  // a day of emission at today's rate: reward x 10 blocks/s x 86,400 s
  const perDay = X.rewardPerBlock(now) * 10 * 86_400;
  assert.ok(Math.abs((27_828_734_739 - perDay) * 0.1 - caps[1].value) / caps[1].value < 0.001);
  assert.deepEqual(X.marketCapSeries([], 1), []);
});

await test("network fees from Kaspalytics: 7 / 30 Days daily, All Time monthly, no 24 Hours", () => {
  const answer = {
    labels: ["2026-10-30T00:00:00.000Z", "2026-10-31T00:00:00.000Z", "2026-11-01T00:00:00.000Z", "bad"],
    datasets: [{ label: "Fees", data: [10, 20, null, 5] }, { label: "Other", data: [1, 1, 1, 1] }],
  };
  const daily = X.kaspalyticsPoints(answer, "Fees");
  assert.deepEqual(daily.map((p) => p.value), [10, 20]);
  assert.deepEqual(X.monthlySums([...daily, { date: Date.UTC(2026, 10, 2), value: 4 }]).map((p) => p.value), [30, 4]);
  assert.equal(X.feeSeries(daily, "day"), null);
  assert.equal(X.feeSeries(daily, "week").length, 2);
  assert.equal(X.feeSeries([], "week"), null);
  assert.deepEqual(X.metricPeriods("networkFees").map((p) => p.id), ["week", "month", "allTime"]);
  assert.deepEqual(X.metricPeriods("hashrate").map((p) => p.title), ["24 Hours", "7 Days", "30 Days", "All Time"]);
  assert.equal(X.KASPALYTICS_FEES, "https://www.kaspalytics.com/api/charts/transactions/accepted/fees");
  // Kaspalytics sends no CORS headers: read through the site's relay where there is one
  assert.match(ui, /if \(await isProxyAvailable\(\)\) target = proxiedUrl\(url\);/);
  // mainnet only, at most once an hour
  assert.match(ui, /NETWORK_ID === "mainnet" && Date\.now\(\) - kStats\.kaspalyticsAt > 3_600_000/);
});

await test("high / low / average, the bar still filling left out; drag to read the nearest point", () => {
  const pts = [{ date: 1, value: 4 }, { date: 2, value: 8 }, { date: 3, value: 1 }];
  assert.deepEqual(X.chartSummary(pts), { high: 8, low: 1, average: 13 / 3 });
  assert.deepEqual(X.chartSummary(pts, { bars: true }), { high: 8, low: 4, average: 6 });
  assert.equal(X.nearestPoint(pts, 2.4), pts[1]);
  assert.equal(X.nearestPoint(pts, 2.9, { bars: true }), pts[1]);
  assert.equal(Math.round(X.chartChange(pts, 8)), 100);
  // drawn here in SVG, no chart library
  assert.match(ui, /<svg class="kx-chart-svg"/);
  assert.match(ui, /svgEl\.addEventListener\("pointermove", pick\)/);
  const pkg = JSON.parse(read("package.json"));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const lib of ["chart.js", "d3", "recharts", "echarts", "apexcharts", "uplot"]) assert.ok(!deps.includes(lib), lib);
});

// --- K Activity ----------------------------------------------------------------------------------

const STATS = {
  categories: {
    arcadeScores: { last24h: 2, last7d: 2, total: 2 }, chessGames: { total: 2 }, chessMoves: { last24h: 0, last7d: 0, total: 79 },
    groupMessages: { last24h: 54, last7d: 292, total: 4436 }, groupUpdates: { last24h: 12, last7d: 119, total: 2278 },
    handshakes: { last24h: 2, last7d: 5, total: 4543 }, kapostActions: { last24h: 102, last7d: 334, total: 7434 },
    kaposts: { last24h: 63, last7d: 176, total: 3493 }, messages: { last24h: 1229, last7d: 8899, total: 803302 },
    payments: { last24h: 18, last7d: 41, total: 1430 }, publicChats: { last24h: 237, last7d: 510, total: 614 },
    selfStash: { last24h: 71, last7d: 258, total: 3882 },
  },
};

await test("K Activity from /stats: 24 Hours, 7 Days, All Time; machinery left out, kinds summed", () => {
  const { activity, periods } = X.activityFromStats(STATS);
  assert.deepEqual(periods, ["day", "week", "allTime"]);
  assert.equal(activity.day.counts.kachatMessage, 1229 + 54);
  assert.equal(activity.day.counts.kapost, 63 + 102);
  assert.equal(activity.day.counts.handshake, 2); // selfStash isn't counted as one
  assert.equal(activity.day.total, 1229 + 54 + 2 + 18 + 63 + 102 + 237 + 0 + 2);
  assert.equal(activity.day.ranked[0].kind, "kachatMessage");
  assert.equal(activity.day.change, null);
  assert.equal(activity.day.bars, null);
  // only what's served: no 24-hour numbers, no 24 Hours
  const allOnly = X.activityFromStats({ categories: { messages: { total: 5 } } });
  assert.deepEqual(allOnly.periods, ["allTime"]);
  assert.equal(X.activityFromStats({}), null);
  assert.equal(X.activityFromStats({ categories: { selfStash: { total: 9 } } }), null);
  assert.deepEqual(X.K_ACTIVITY_PERIODS, ["day", "week", "allTime"]);
});

await test("/stats/activity when served: the window before and the bars", () => {
  const day = X.activityFromRich("day", {
    categories: { messages: 1224, kaposts: 63, selfStash: 71 },
    previous: { messages: 3246, kaposts: 52, groupUpdates: 17 },
    series: [{ t: 2, count: 5 }, { t: 1, count: 9 }],
  });
  assert.equal(day.total, 1287);
  assert.equal(day.previousTotal, 3298);
  assert.equal(day.change.toFixed(2), ((1287 - 3298) / 3298 * 100).toFixed(2));
  assert.deepEqual(day.bars, [9, 5]);
  // All Time has nothing before it
  const all = X.activityFromRich("allTime", { categories: { messages: 3 }, previous: { messages: 1 } });
  assert.equal(all.change, null);
  assert.equal(X.activityFromRich("day", { nope: 1 }), null);
  assert.deepEqual(X.RICH_PERIOD_NAMES, { day: "day", week: "week", allTime: "all" });
  // read from K's indexer; a 404 isn't asked again this session, any other failure waits an hour
  assert.match(ui, /\$\{base\}\/stats\/activity\?period=/);
  assert.match(ui, /if \(notServed\) kStats\.richUnavailable = true; else kStats\.richRetryAt = Date\.now\(\) \+ 3_600_000;/);
  // nothing made up: no demo numbers when the indexer serves nothing
  assert.match(ui, /K's indexer isn't serving these numbers right now\./);
  assert.doesNotMatch(ui, /Demo numbers|demo: not served/);
});

// --- Mining Estimate -----------------------------------------------------------------------------

await test("the Mining Estimate moved to the Hashrate chart", () => {
  // 21 TH/s of 323 PH/s at 1.8354 KAS a block, ten a second
  const daily = X.dailyKasEstimate({ yourHs: 21e12, networkHs: 323e15, rewardKas: 1.8354 });
  assert.ok(Math.abs(daily - 1.8354 * 10 * 86_400 * 21e12 / 323e15) < 1e-9);
  assert.equal(X.dailyKasEstimate({ yourHs: 0, networkHs: 1, rewardKas: 1 }), null);
  assert.equal(X.dailyKasEstimate({ yourHs: 1, networkHs: null, rewardKas: 1 }), null);
  assert.deepEqual(X.HASHRATE_UNITS.map((u) => u.label), ["GH/s", "TH/s", "PH/s"]);
  assert.match(ui, /\$\{entry\.id === "hashrate" \? `<div data-kx-mining>\$\{miningHtml\(\)\}<\/div>` : ""\}/);
  assert.match(ui, /Before pool fees, power and luck, and both figures move\./);
  assert.match(ui, /Enter your hashrate to estimate earnings\./);
  // Portfolio's hashrate card and screen are gone
  assert.doesNotMatch(portfolio, /hashrateCardHtml|hashrateViewHtml|>Mining Estimate<|engine\/network-stats|data-portfolio-open="hashrate"|Network Hashrate/);
  assert.ok(!existsSync(new URL("../engine/network-stats.js", import.meta.url)));
});

// --- wiring --------------------------------------------------------------------------------------

await test("Explorer is a dock item where KaChat Stats was; the old tab id lands on it", () => {
  assert.ok(RAIL_ORDER.includes("explorer"));
  assert.ok(!RAIL_ORDER.includes("kachat-stats"));
  assert.equal(RAIL_ORDER.indexOf("explorer"), RAIL_ORDER.indexOf("apps") - 1);
  assert.ok(dockLayoutFor(false).hub.includes("explorer"));
  assert.ok(!PHONE_BAR.includes("explorer"));
  assert.equal(currentTabId("kachat-stats"), "explorer");
  assert.equal(currentTabId("wallet"), "wallet");
  // a saved spot and every tab switch go through it
  assert.match(app, /const saved = currentTabId\(localStorage\.getItem\(UI_SPOT_TAB_KEY\)\);/);
  assert.match(app, /tab = currentTabId\(tab\);/);
  assert.match(app, /if \(screenTab === "explorer"\) showExplorer\(\); else hideExplorer\(\);/);
  assert.match(app, /if \(wasOnExplorer\) \{ try \{ explorerToHome\(\); \}/);
  // the screen and its dock button; KaChat Stats is gone
  assert.match(html, /<div class="profile-screen" data-app-tab-screen="explorer" data-explorer hidden><\/div>/);
  assert.match(html, /data-app-tab="explorer" hidden>[\s\S]*?<span>Explorer<\/span>/);
  assert.doesNotMatch(html + app + styles, /kachat-stats|KachatStats|kstats-/);
  assert.ok(!existsSync(new URL("../ui/kachat-stats.js", import.meta.url)));
  assert.ok(!existsSync(new URL("../ui/kachat-stats.css", import.meta.url)));
  assert.match(styles, /\.sidebar-tab\[data-app-tab="explorer"\] \{ margin-top: 9px; \}/);
});

await test("live blocks from K's node only while the Explorer's home shows in a visible tab", () => {
  // the engine's block-added stream: a client added on start, removed on stop
  assert.match(app, /addBlockClient: \(fn\) => engine\.addBlockScanClient\(fn\)/);
  assert.match(ui, /live\.removeBlockClient = deps\.addBlockClient\?\.\(receiveBlock\)/);
  assert.match(ui, /const remove = live\.removeBlockClient;\n  live\.removeBlockClient = null;\n  try \{ remove\?\.\(\); \}/);
  assert.match(ui, /return active && routes\.length === 0 && \(typeof document === "undefined" \|\| document\.visibilityState !== "hidden"\);/);
  assert.match(ui, /document\.addEventListener\("visibilitychange", updateLive\)/);
  assert.match(ui, /export function hideExplorer\(\) \{\n  active = false;\n  stopLive\(\);/);
  // the block graph pauses with the feed (30 fps while it runs)
  assert.match(ui, /blockDagAnimation\(canvas, \{ minIntervalMs: 1000 \/ 30 \}\)/);
  assert.match(ui, /try \{ live\.dag\?\.stop\(\); \}/);
  assert.match(read("ui/send-kaspa-components.js"), /export function blockDagAnimation\(canvas, \{ minIntervalMs = 0 \} = \{\}\)/);
  assert.match(css, /\.kx-screen\.kx-running \.kx-live-dot::after \{ animation-play-state: running; \}/);
  // blocks buffered and shown once a second, at most 30 waiting, 15 kept
  assert.match(ui, /const PENDING_CAP = 30;/);
  assert.match(ui, /const KEPT_BLOCKS = 15;/);
  // the mempool from the node
  assert.match(app, /engine\.withRpc\(\(rpc\) => rpc\.getInfo\(\)/);
  // the engine still has the client API this needs
  assert.match(read("engine/index.js"), /addBlockScanClient\(client\) \{/);
});

await test("Not Accepted rows are dimmed and struck through; the home's tiles, supply and lists", () => {
  assert.match(ui, /<span class="kx-pill">Not Accepted<\/span>/);
  assert.match(ui, /\$\{notAccepted \? " kx-struck" : ""\}/);
  assert.match(css, /\.kx-not-accepted \{ opacity: \.5; \}/);
  assert.match(css, /\.kx-struck \{ text-decoration: line-through; \}/);
  for (const title of ["Hashrate", "Mempool", "Network Fee", "KAS Price", "Block Reward", "Market Cap"]) assert.ok(ui.includes(`title: "${title}"`), title);
  assert.match(ui, /Circulating Supply/);
  assert.match(ui, /const HOME_PAGES = \[\["blocks", "Blocks"\], \["transactions", "Transactions"\], \["kActivity", "K Activity"\]\];/);
  assert.match(ui, /Live blocks from K's node · data from kaspa\.stream/);
  // an address page cycles History and Assets, Kaspa and kUSDT (kUSDT at 0 too)
  assert.match(ui, /options: \[\["history", "History"\], \["assets", "Assets"\]\]/);
  assert.match(ui, /const units = info\.kusdtUnits \?\? 0n;/);
  assert.match(app, /kusdtUnits: async \(address\) => \(await verifiedKusdtCoins\(\{ engine, address, network: NETWORK_ID \}\)\)\.units/);
});

await test("kaspa.stream is asked directly (it sends CORS headers); api-tn10 on testnet", () => {
  assert.equal(X.explorerApiBase("mainnet"), "https://api.kaspa.stream");
  assert.equal(X.explorerApiBase("testnet-10"), "https://api-tn10.kaspa.stream");
  const re = new RegExp(/const DIRECT_FIRST_HOST_RE = \/(.+)\/i;/.exec(endpoints)[1], "i");
  for (const host of ["api.kaspa.stream", "api-tn10.kaspa.stream"]) assert.ok(re.test(host), host);
  // the node resolver's seeds on kaspa.stream stay relayed
  assert.ok(!re.test("seeder1.kaspa.stream"));
});

console.log(`explorer: ${passed} passed`);
