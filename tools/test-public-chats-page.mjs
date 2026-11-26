// Public Chats as KaChat's second page, and the room rules that came with it (K 961fc05a, owner
// 2026-11-25):
// - the cycle button beside the KaChat title switches Chats (chats, groups, bots, Message Requests)
//   and Public Chats (the rooms by latest activity, pinned rooms as circles above them);
// - the button's red count is the bell-on rooms' unread on either page; the dock's KaChat badge
//   counts chats and groups only; the app icon still adds the bell-on rooms;
// - on the rooms page the + is New Public Chat and the gear is Edit Default Public Chats;
// - #report-bugs is a default room, and #kachat-bugs an ordinary indexer room again (K ef760cfa: no
//   room is retired any more);
// - every account's rooms are silenced once, then keep the person's bell choices (K ef760cfa);
// - every room the indexer's /broadcast-channels lists is a default room (bell off, More Rooms),
//   and a switched-off one the indexer dropped is left after 7 days;
// - a room push waits (at most 4 s) for the open app to fetch its message.
// Drives ui/broadcasts.js under node with the DOM stubbed out, and reads ui/app.js, index.html and
// the service worker as text (ui/app.js imports CSS). Run from the repo root:
//
//   node tools/test-public-chats-page.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const app = read("ui/app.js");
const html = read("index.html");
const css = read("ui/styles.css");
const roomsSource = read("ui/broadcasts.js");
const sw = read("public/sw.js");
const webPush = read("ui/web-push.js");

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}
/** A top-level function's source in app.js (up to the next line that closes it). */
function fnSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  return source.slice(start, source.indexOf("\n}\n", start) + 2);
}

// --- the browser stubs ui/broadcasts.js needs ------------------------------------------------------
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
};
const noop = () => {};
globalThis.window = globalThis;
globalThis.addEventListener = noop;
globalThis.matchMedia = () => ({ matches: false, addEventListener: noop });
globalThis.document = {
  hidden: true, // keeps the closed-room sweep from fetching
  addEventListener: noop,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, dataset: {}, setAttribute: noop, addEventListener: noop, appendChild: noop, remove: noop, querySelector: () => null }),
  body: { appendChild: noop },
};
// The indexer answers only what each test hands it.
let indexerRows = () => [];
globalThis.fetch = async (url) => {
  const href = String(url);
  if (href.includes("/get-broadcasts")) {
    const body = JSON.stringify({ messages: indexerRows(new URL(href).searchParams.get("channel")), hasMore: false });
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => body, json: async () => JSON.parse(body) };
  }
  return { ok: false, status: 404, headers: { get: () => null }, text: async () => "", json: async () => ({}) };
};

const engineMod = await import("../engine/broadcasts.js");
const {
  FEATURED_BROADCAST_CHANNELS, RETIRED_BROADCAST_CHANNELS, replacementBroadcastChannel, indexerDefaultChannelsFrom,
  indexerDefaultBroadcastChannels, setReportedBroadcastChannels, isCuratedBroadcastChannel, DROPPED_ROOM_GRACE_MS,
} = engineMod;
const roomsModForGrace = await import("../ui/broadcasts.js");
const { DROPPED_AUTO_ROOM_GRACE_MS } = roomsModForGrace;
const { shouldAskTrackedRooms, TRACKED_ASK_INTERVAL_MS } = await import("../engine/indexer-tracked-rooms.js");
const { ROOM_PINS_KEY } = await import("../ui/room-pins.js");

const engine = { address: "kaspa:qwalletone", onConnectionState: noop, onBroadcastBlockHits: noop, setBroadcastScanChannels: noop };
const scoped = (key) => (engine.address ? `acct:${engine.address}:${key}` : key);
const removed = [];

// An account from an older build: #kaspa's and #kachat-bugs' bells turned on by themselves, and its
// own room's bell on, #kachat-bugs pinned to the circles.
localStorage.setItem(scoped("kachat-broadcast-notify-v1"), JSON.stringify({ kaspa: true, "kachat-bugs": true, "my-room": true }));
localStorage.setItem(scoped("kachat-broadcast-channels-v1"), JSON.stringify(["kaspa", "kachat-bugs", "my-room"]));
localStorage.setItem(scoped(ROOM_PINS_KEY), JSON.stringify(["kachat-bugs", "kaspa"]));
// A second account had a bell on too.
localStorage.setItem("acct:kaspa:qwallettwo:kachat-broadcast-notify-v1", JSON.stringify({ kaspa: true }));

const rooms = await import("../ui/broadcasts.js");
rooms.initBroadcasts({
  engine,
  accountScopedKey: scoped,
  escapeHtml: (value) => String(value),
  shortAddress: (address) => String(address).slice(0, 12),
  onUnreadChanged: noop,
  onRoomRemoved: (name) => removed.push(name),
  blockedAccounts: () => [],
});
const byName = () => new Map(rooms.chatListRooms().map((room) => [room.name, room]));
const stored = (key) => JSON.parse(localStorage.getItem(scoped(key)) || "null");

// --- #kachat-bugs back, rooms silenced once (K ef760cfa) -----------------------------------------------
await test("#report-bugs is a featured room; no room is retired, #kachat-bugs is its own room again", () => {
  assert.deepEqual([...FEATURED_BROADCAST_CHANNELS], ["kaspa", "report-bugs"]);
  assert.deepEqual({ ...RETIRED_BROADCAST_CHANNELS }, {});
  assert.equal(replacementBroadcastChannel("KaChat-Bugs"), "kachat-bugs");
  assert.equal(isCuratedBroadcastChannel("kachat-bugs"), false, "not a built-in default: an indexer room");
  const listed = byName();
  assert.equal(listed.get("kachat-bugs")?.joined, true, "an account that had it keeps it");
  assert.deepEqual(stored(ROOM_PINS_KEY), ["kachat-bugs", "kaspa"], "its pin stays");
});

await test("every account's rooms are silenced once, then keep the person's choices", () => {
  const listed = byName();
  for (const name of ["kaspa", "kachat-bugs", "my-room"]) assert.equal(listed.get(name)?.notify, false, `${name} silenced`);
  assert.equal(stored("kachat-rooms-silenced-once-v1"), 1, "done once for this account");
  // a bell turned on afterwards stays on through later loads
  rooms.setBroadcastRoomNotify("my-room", true);
  rooms.refreshBroadcasts();
  rooms.resetBroadcastsForAccount();
  assert.equal(byName().get("my-room").notify, true, "not silenced again");
  rooms.setBroadcastRoomNotify("my-room", false);
  // another account is silenced on its own first load
  engine.address = "kaspa:qwallettwo";
  rooms.resetBroadcastsForAccount();
  assert.equal(byName().get("kaspa").notify, false);
  assert.equal(localStorage.getItem("acct:kaspa:qwallettwo:kachat-rooms-silenced-once-v1"), "1");
  engine.address = "kaspa:qwalletone";
  rooms.resetBroadcastsForAccount();
});

await test("joining #kachat-bugs opens #kachat-bugs", () => {
  assert.equal(rooms.broadcastJoinError("kachat-bugs"), "");
  assert.equal(rooms.joinBroadcastChannelFromSheet("kachat-bugs"), true);
  assert.equal(rooms.activeBroadcastChannelName(), "kachat-bugs");
  rooms.closeBroadcastRoom();
});

// --- rooms added on the indexer ----------------------------------------------------------------------
await test("every room /broadcast-channels lists is a default room, minus machinery and retired names", () => {
  assert.deepEqual(
    indexerDefaultChannelsFrom(["zeta", "kaspa", "chess-arena", "chess-bots", "kplay-arcade", "kachat-bugs", "Alpha", "bad name", "alpha"]),
    ["alpha", "kachat-bugs", "zeta"],
  );
  assert.deepEqual(indexerDefaultBroadcastChannels(), [], "nothing reported yet");
});

await test("a room the indexer adds joins with its bell off, as a default room", () => {
  setReportedBroadcastChannels(["kaspa", "dev-room", "quiet-room", "chess-arena"]);
  const listed = byName();
  assert.equal(listed.get("dev-room")?.joined, true, "joined at once");
  assert.equal(listed.get("dev-room").notify, false, "bell off");
  assert.equal(listed.get("dev-room").indexed, true, "a default room: Delete switches it off");
  assert.equal(listed.has("chess-arena"), false, "machinery stays out");
  assert.ok(stored("kachat-broadcast-channels-v1").includes("dev-room"), "saved as joined");
  assert.ok(stored("kachat-rooms-auto-joined-v1").includes("dev-room"), "remembered as joined by K (K 65f8a765)");
});

await test("dropped by the indexer: one K joined is left after 2 hours; switched off is left after 7 days", () => {
  rooms.removeBroadcastRooms(["quiet-room"]); // Delete on a default room switches it off
  assert.equal(byName().has("quiet-room"), false);
  const realNow = Date.now;
  try {
    setReportedBroadcastChannels(["kaspa"]);
    const listed = byName();
    assert.equal(listed.get("dev-room")?.joined, true, "on: kept for now");
    assert.equal(listed.get("dev-room").indexed, false, "no longer a default room");
    assert.equal(listed.has("quiet-room"), false, "switched off: still not listed");
    assert.ok(stored("kachat-broadcast-hidden-curated-v1").includes("quiet-room"), "its switched-off mark is kept for now");
    assert.ok(stored("kachat-broadcast-hidden-missing-v1")?.["quiet-room"] > 0, "its clock started");
    // back on the list within the week: nothing lost, the clock stops
    setReportedBroadcastChannels(["kaspa", "quiet-room"]);
    assert.equal(byName().has("quiet-room"), false, "still switched off");
    assert.equal(stored("kachat-broadcast-hidden-missing-v1")?.["quiet-room"], undefined, "its clock stopped");
    assert.ok(stored("kachat-broadcast-hidden-missing-v1")?.["dev-room"] > 0, "dev-room's (K joined it) still runs");
    // gone for good: a week later it's left
    setReportedBroadcastChannels(["kaspa"]);
    const start = Date.now();
    Date.now = () => start + DROPPED_ROOM_GRACE_MS + 1000;
    rooms.refreshBroadcasts();
    assert.ok(!(stored("kachat-broadcast-hidden-curated-v1") || []).includes("quiet-room"), "switched-off mark dropped");
    assert.ok(!stored("kachat-broadcast-channels-v1").includes("quiet-room"), "left");
    assert.ok(removed.includes("quiet-room"), "its pin goes too");
    assert.equal(byName().has("dev-room"), false, "the room K joined is left too (K 65f8a765)");
    assert.ok(removed.includes("dev-room"), "its pin goes too");
    assert.ok(!stored("kachat-rooms-auto-joined-v1").includes("dev-room"));
  } finally {
    Date.now = realNow;
  }
});

await test("a room K joined goes 2 hours after the indexer drops it; one you joined by name or posted in stays", () => {
  const realNow = Date.now;
  try {
    setReportedBroadcastChannels(["kaspa", "brief-room", "kept-room"]);
    assert.ok(stored("kachat-rooms-auto-joined-v1").includes("kept-room"));
    rooms.joinBroadcastChannelFromSheet("kept-room"); // joined by name: the person's own
    rooms.closeBroadcastRoom();
    assert.ok(!stored("kachat-rooms-auto-joined-v1").includes("kept-room"), "no longer K's to drop");
    setReportedBroadcastChannels(["kaspa"]);
    const start = Date.now();
    Date.now = () => start + DROPPED_AUTO_ROOM_GRACE_MS - 60_000;
    rooms.refreshBroadcasts();
    assert.equal(byName().has("brief-room"), true, "under 2 hours: still there");
    Date.now = () => start + DROPPED_AUTO_ROOM_GRACE_MS + 1000;
    rooms.refreshBroadcasts();
    assert.equal(byName().has("brief-room"), false, "2 hours missing: left");
    assert.equal(byName().get("kept-room")?.joined, true, "yours: stays as an ordinary room");
  } finally {
    Date.now = realNow;
  }
  // posting makes a room yours too
  assert.match(fnSource(roomsSource, "sendRoomRow"), /^function sendRoomRow[^\n]*\n[^\n]*\n  keepRoomAsOwn\(channel\);/);
  assert.match(fnSource(roomsSource, "joinChannel"), /addJoinedChannel\(name\);\n[^\n]*\n  keepRoomAsOwn\(name\);/);
});

await test("Edit Default Public Chats lists them under More Rooms and asks the indexer within a minute", () => {
  const settings = fnSource(roomsSource, "openPublicChatsSettings");
  assert.match(settings, /<p class="settings-group-label">More Rooms<\/p>/);
  assert.match(settings, /Rooms added on the indexer K reads public chats from\./);
  assert.match(settings, /refreshIndexerTrackedRooms\(\{ maxAgeMs: 60_000 \}\)/);
  assert.match(settings, /onIndexerTrackedRoomsChange\(redrawMoreRooms\)/);
  assert.equal(shouldAskTrackedRooms({ base: "https://x", at: 0 }, "https://x", 60_000, 60_000), true, "a minute later: asked");
  assert.equal(shouldAskTrackedRooms({ base: "https://x", at: 0 }, "https://x", 60_000), false, "hourly otherwise");
  assert.equal(shouldAskTrackedRooms({ base: "https://x", at: 0 }, "https://x", TRACKED_ASK_INTERVAL_MS), true);
  assert.match(roomsSource, /window\.setInterval\(\(\) => \{ if \(!document\.hidden\) refreshIndexerTrackedRooms\(\)\.catch\(\(\) => \{\}\); \}, 60 \* 60_000\);/);
});

// --- room push waits for its message -----------------------------------------------------------------
const SENDER = "kaspa:qzk2jrk7wq3zdw2n0260v87fglky82cg5u3pwy73wpktk3u864yecm5djll40";
const txid = (n) => n.toString(16).padStart(64, "0");
await test("a room push fetches its room until the message is there", async () => {
  let asked = 0;
  indexerRows = (channel) => {
    if (channel !== "kaspa") return [];
    asked += 1;
    // the indexer pushes a moment before it serves the row: the second ask has it
    return asked < 2 ? [] : [{ txId: txid(7), channel: "kaspa", senderAddress: SENDER, content: "hello", blockTime: Date.now() - 1000 }];
  };
  const got = await rooms.fetchRoomBeforePushBanner("kaspa", txid(7));
  assert.equal(got, true);
  assert.equal(asked, 2, "asked again once it wasn't there");
  assert.match(byName().get("kaspa").preview, /hello/, "the list has it");
});

await test("a push for a room you're not in fetches nothing, and the wait is capped", async () => {
  let asked = 0;
  indexerRows = () => { asked += 1; return []; };
  assert.equal(await rooms.fetchRoomBeforePushBanner("not-joined", txid(8)), false);
  assert.equal(asked, 0);
  const started = Date.now();
  assert.equal(await rooms.fetchRoomBeforePushBanner("kaspa", txid(9), { timeoutMs: 1200 }), false, "never came");
  assert.ok(Date.now() - started < 2500, "gave up in time");
});

await test("the service worker holds a room push for the open app, at most 4 s", () => {
  const sandbox = { globalThis: null };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("public/sw-push.js"), sandbox);
  const map = sandbox.KaChatPushMap;
  assert.equal(map.roomPushWaitsForApp({ type: "broadcast", channel: "kaspa" }), true);
  assert.equal(map.roomPushWaitsForApp({ type: "broadcast" }), false);
  assert.equal(map.roomPushWaitsForApp({ type: "contextual", channel: "kaspa" }), false);
  assert.equal(map.ROOM_PUSH_WAIT_MS, 4000);
  assert.match(sw, /if \(!suppress && appInFront\) \{\n    let waits = false;\n    try \{ waits = Boolean\(self\.KaChatPushMap\?\.roomPushWaitsForApp\(payload\)\); \}/);
  assert.match(sw, /if \(waits\) await askOpenAppToFetchRoom\(clients, payload\);\n  \}\n  if \(suppress\) \{/);
  assert.match(sw, /type: "kachat:room-push", data: \{ channel: String\(payload\.channel \|\| ""\), txId: String\(payload\.tx_id \|\| ""\) \} \}, \[port\.port2\]/);
  assert.match(webPush, /else if \(type === "kachat:room-push"\) \{[\s\S]*?deps\.onRoomPush\?\.\(event\.data\.data \|\| \{\}\)[\s\S]*?\.finally\(reply\);/);
  assert.match(app, /onRoomPush: \(data = \{\}\) => \(engine\.address && data\.channel \? fetchRoomBeforePushBanner\(data\.channel, data\.txId\) : false\),/);
});

// --- the two pages -----------------------------------------------------------------------------------
await test("a cycle button beside the KaChat title switches Chats and Public Chats", () => {
  assert.match(html, /<div class="chats-title-row">\n\s*<h1 class="kaposts-title chats-list-title">Chats<\/h1>\n\s*<span class="chats-page-cycle-wrap">\n\s*<button class="cycle-button chats-page-cycle" type="button" data-cycle="chats-page" data-chats-page-cycle/);
  assert.match(app, /function chatListPageOptions\(\) \{ return \[\{ id: "chats", title: "Chats" \}, \{ id: "publicChats", title: "Public Chats" \}\]; \}/);
  assert.match(app, /"Switches between your chats and public chats"/);
  assert.match(app, /document\.querySelector\("\[data-chats-page-cycle\]"\)\?\.addEventListener\("click", \(event\) => \{\n\s*const next = event\.currentTarget\.dataset\.cycleNext/);
  const set = fnSource(app, "setChatListPage");
  assert.match(set, /if \(chatSelectionModeActive\) setChatSelectionMode\(false\);/, "Select ends on a page change");
  assert.match(set, /restartFade\(/, "the list fades in");
  assert.match(css, /\.chats-page-cycle-badge \{/);
});

await test("Chats lists chats, groups and Message Requests; Public Chats lists the rooms", () => {
  assert.match(fnSource(app, "visibleChatConversations"), /if \(onPublicChatsPage\(\)\) return \[\];/);
  assert.match(fnSource(app, "visibleChatGroups"), /if \(onPublicChatsPage\(\)\) return \[\];/);
  assert.match(fnSource(app, "visibleChatRooms"), /if \(!onPublicChatsPage\(\)\) return \[\];/);
  const render = fnSource(app, "renderChats");
  assert.match(render, /const showsRequestsRow = !roomsPage && !searching && !chatSelectionModeActive;/);
  assert.match(render, /const countLineHtml = roomsPage \? "" :/);
  assert.match(render, /emptyState\.hidden = !\(showsEmpty && !roomsPage\);/);
  assert.match(render, /emptyRoomsState\.hidden = !\(showsEmpty && roomsPage\);/);
  // Your Address stays pinned first on the Chats page (owner, 2026-11-12)
  assert.match(render, /pinned: isSelfConversation\(conversationEntry\)/);
  assert.match(html, /data-empty-rooms-state hidden>[\s\S]*?<h1>No Public Chats<\/h1>\s*<p>Tap \+ to join or create a public room\.<\/p>/);
  const onPage = fnSource(app, "onPublicChatsPage");
  assert.match(onPage, /return chatListPage === "publicChats";/);
});

await test("each page has its own circles: bots and pins on Chats, pinned rooms on Public Chats", () => {
  const circles = fnSource(app, "visibleChatCircles");
  assert.match(circles, /if \(onPublicChatsPage\(\)\) \{\n    return pinnedChatRooms\(\)\.map\(/);
  assert.doesNotMatch(circles.slice(circles.indexOf("const items")), /pinnedChatRooms/, "no rooms among the Chats page's circles");
});

await test("badges: the page button counts bell-on rooms, the dock chats and groups, the icon both", () => {
  assert.match(fnSource(app, "chatsTabUnreadTotal"), /return chatsTabUnreadCount\(\{ chats, groups: totalGroupUnread\(\) \}\);/);
  assert.doesNotMatch(fnSource(app, "chatsTabUnreadTotal"), /broadcastNotifyingUnreadTotal/);
  assert.match(fnSource(app, "scheduleAppBadgeUpdate"), /total \+= publicRoomUnreadCount\(\);/);
  const controls = fnSource(app, "syncChatListPageControls");
  assert.match(controls, /const count = publicRoomUnreadCount\(\);/, "on either page");
  assert.match(fnSource(app, "renderChatCircles"), /scheduleAppBadgeUpdate\(\);\n  syncChatListPageControls\(\);/);
});

await test("the rooms page: + is New Public Chat, the gear only there, room links and pushes switch to it", () => {
  assert.match(app, /button\.addEventListener\("click", \(\) => openNewChatSheet\(\{ publicRoom: onPublicChatsPage\(\) \}\)\);/);
  assert.match(fnSource(app, "openNewChatSheet"), /if \(publicRoom\) showJoin\(\); else showMenu\(\);/);
  // the Chats page's New sheet has only New Chat and New Group Chat (K ef760cfa)
  assert.doesNotMatch(fnSource(app, "newChatSheetMenuHtml"), /title: "New Public Chat"/);
  assert.match(fnSource(app, "newChatSheetMenuHtml"), /title: "New Chat"[^\n]*\n[^\n]*title: "New Group Chat"/);
  // a silenced chat, group or room shows a Silenced pill, not a bell icon (K ef760cfa SilencedPill)
  assert.equal((app.match(/<strong>\$\{chatRowTitleHtml\(/g) || []).length, 3);
  assert.match(fnSource(app, "chatRowTitleHtml"), /<span class="chat-row-name-text">\$\{nameHtml\}<\/span>\$\{silencedPillHtml\(\)\}/);
  assert.match(fnSource(app, "silencedPillHtml"), /chat-row-silenced-pill">Silenced</);
  assert.match(css, /\.chat-meta strong \.chat-row-silenced-pill \{[^}]*border-radius: 999px[^}]*color: var\(--accent\)/);
  assert.doesNotMatch(app, /chat-row-silenced"|group-row-silenced"/);
  assert.match(fnSource(app, "syncChatsPublicSettingsGear"), /\|\| chatListPage !== "publicChats"/);
  assert.match(fnSource(app, "openPublicChatsTab"), /setActiveAppTab\("chats"\);\n  setChatListPage\("publicChats"\);/);
  assert.match(app, /if \(activeConversationId\) setActiveConversationId\(null\);\n[^\n]*\n[^\n]*\n\s*setChatListPage\("publicChats"\);\n\s*\}\n\s*syncPublicChatsPane\(\);/, "any room opening shows its page");
  // the dock's KaChat still goes back to the list on a phone (Build 336)
  assert.match(fnSource(app, "backToChatsListFromDock"), /if \(publicRoomOpen\) \{ try \{ closeBroadcastRoom\(\); \}/);
});

await test("Select on the rooms page: Mark as Read / Unread, Mute, Pin, Delete with K's wording", () => {
  assert.match(html, /data-chat-pin-rooms aria-label="Pin" title="Pin" hidden>/);
  assert.match(html, /data-chat-mute-rooms aria-label="Mute" title="Mute" hidden>/);
  const bar = fnSource(app, "updateChatSelectionBar");
  assert.match(bar, /mute\.hidden = !roomsPage;/);
  assert.match(bar, /pin\.hidden = !roomsPage;/);
  assert.match(app, /Default public chats are switched off \(turn them back on in Edit Default Public Chats\)\. Rooms you added are deleted with their messages on this device\./);
});

await test("a row's preview shows its last message's newest edit (1:1, groups and rooms)", () => {
  assert.match(fnSource(app, "chatListPreviewText"), /if \(message\.edit\?\.text != null\) message = \{ \.\.\.message, text: messageContent\(message\) \};/);
  assert.match(fnSource(app, "groupRowHtml"), /groupRowPreview\(\{ \.\.\.last, text: groupMessageContent\(g\.groupId, last\) \}\)/);
  assert.match(fnSource(roomsSource, "roomPreviewLine"), /humanizeBroadcastContent\(effectiveContent\(name, last\)\)/);
});

console.log(`public chats page: ${passed} passed`);
process.exit(0); // the module's sweep interval would otherwise keep node alive
