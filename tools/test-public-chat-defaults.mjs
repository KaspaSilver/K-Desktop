// Public Chats starts empty (K 824a30bb, owner 2026-11-26: nothing may feel added without the
// person's say): no room is joined for anyone, Add Room offers the featured rooms, the indexer's
// rooms and the language rooms, a room you join starts with its bell ON, Delete leaves any room, and
// an account from an older build is cleared once, keeping only the rooms it showed it wants (a bell it
// turned on, or a pin). Drives ui/broadcasts.js with the DOM stubbed out. Run from the repo root:
//
//   node tools/test-public-chat-defaults.mjs

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
  createElement: () => ({ style: {}, dataset: {}, setAttribute: noop, addEventListener: noop, appendChild: noop, remove: noop }),
  body: { appendChild: noop },
};

const { FEATURED_BROADCAST_CHANNELS, LANGUAGE_BROADCAST_CHANNELS } = await import("../engine/broadcasts.js");
const rooms = await import("../ui/broadcasts.js");

const r = {
  pass: 0, fail: 0, failures: [],
  check(ok, label) { if (ok) this.pass++; else { this.fail++; this.failures.push(label); } },
  eq(a, b, label) { this.check(a === b, `${label}: got ${String(a)}, expected ${String(b)}`); },
};

const engine = { address: "kaspa:qwalletone", onConnectionState: noop, onBroadcastBlockHits: noop, setBroadcastScanChannels: noop };
const scoped = (key) => (engine.address ? `acct:${engine.address}:${key}` : key);
let pushSyncs = 0;
let blockedAccounts = [];
// An older build's account: every default room joined (#kaspa's bell turned on by the person after
// the silence-once ran, #kaspa-german pinned), plus a room joined by name, and #kaspa-korean switched off.
localStorage.setItem(scoped("kachat-broadcast-channels-v1"), JSON.stringify(["kaspa", "report-bugs", ...LANGUAGE_BROADCAST_CHANNELS, "my-room"]));
localStorage.setItem(scoped("kachat-broadcast-notify-v1"), JSON.stringify({ kaspa: true }));
localStorage.setItem(scoped("kachat-rooms-silenced-once-v1"), "1");
localStorage.setItem(scoped("kachat-room-pins-v1"), JSON.stringify(["kaspa-german"]));
localStorage.setItem(scoped("kachat-broadcast-hidden-curated-v1"), JSON.stringify(["kaspa-korean"]));
rooms.initBroadcasts({
  blockedAccounts: () => blockedAccounts,
  engine,
  accountScopedKey: scoped,
  escapeHtml: (value) => String(value),
  onPushPreferencesChanged: () => { pushSyncs += 1; },
  onUnreadChanged: noop,
});

const byName = () => new Map(rooms.chatListRooms().map((room) => [room.name, room]));
const notifyStore = () => JSON.parse(localStorage.getItem(scoped("kachat-broadcast-notify-v1")) || "{}");

// --- an older account is cleared once: only the rooms it showed it wants stay ---------------------
{
  const listed = byName();
  r.eq(listed.get("kaspa")?.joined, true, "#kaspa stays: its bell was on");
  r.eq(listed.get("kaspa-german")?.joined, true, "#kaspa-german stays: it was pinned");
  r.eq(listed.get("my-room")?.joined, true, "a room joined by name stays");
  r.eq(listed.has("report-bugs"), false, "#report-bugs goes: K had added it");
  r.eq(listed.has("kaspa-french") || listed.has("kaspa-francais"), false, "the other language rooms go");
  r.eq(listed.has("kaspa-korean"), false, "a switched-off room stays out");
  r.eq(JSON.stringify(JSON.parse(localStorage.getItem(scoped("kachat-broadcast-hidden-curated-v1")) || "[]")), "[]", "the switched-off list is emptied");
  r.eq(localStorage.getItem(scoped("kachat-rooms-opt-in-v1")), "1", "done once for this account");
  rooms.removeBroadcastRooms(["kaspa-german"]);
  rooms.refreshBroadcasts();
  r.eq(byName().has("kaspa-german"), false, "Delete leaves a default room (no switch any more)");
  r.eq(byName().has("report-bugs"), false, "nothing comes back on the next load");
}

// --- Add Room: the featured rooms, then the language rooms; Join adds with the bell on ------------
{
  const choices = rooms.addRoomChoices();
  r.eq(choices.rooms.slice(0, FEATURED_BROADCAST_CHANNELS.length).map((room) => room.name).join(","), FEATURED_BROADCAST_CHANNELS.join(","), "featured first");
  r.eq(choices.rooms.find((room) => room.name === "kaspa")?.joined, true, "#kaspa reads Open");
  r.eq(choices.rooms.find((room) => room.name === "report-bugs")?.joined, false, "#report-bugs reads Join");
  r.eq(choices.languages.map((room) => room.name).join(","), LANGUAGE_BROADCAST_CHANNELS.join(","), "Other Languages in K's order");
  r.check(choices.languages.every((room) => room.label), "each language with its name");
  const before = pushSyncs;
  r.eq(rooms.joinBroadcastRoom("report-bugs"), true, "Join takes");
  r.eq(byName().get("report-bugs")?.notify, true, "a room you join starts with its bell on");
  r.eq(notifyStore()["report-bugs"], true, "saved");
  r.check(rooms.broadcastPushWatch().channels.includes("report-bugs"), "the push service watches it");
  void before;
  r.eq(rooms.joinBroadcastRoom("bad name"), false, "a name that can't be a room doesn't join");
  rooms.setBroadcastRoomNotify("report-bugs", false);
  r.eq(rooms.joinBroadcastRoom("report-bugs"), true, "joining again is fine");
  r.eq(byName().get("report-bugs").notify, false, "a room already joined keeps its bell");
}

// --- a blocked account is hidden in every room the push service watches (KaPosts-iPhone 9e22075) ---
{
  blockedAccounts = ["kaspa:qblocked"];
  const before = pushSyncs;
  rooms.broadcastBlockedAccountsChanged();
  r.check(pushSyncs > before, "a block tells the push registration");
  const { channels, hidden } = rooms.broadcastPushWatch();
  r.check(channels.length > 0, "some room is watched");
  for (const name of channels) r.check(hidden[name]?.includes("kaspa:qblocked"), `#${name} leaves out the blocked account`);
  blockedAccounts = [];
  rooms.broadcastBlockedAccountsChanged();
  r.eq(Object.keys(rooms.broadcastPushWatch().hidden).length, 0, "undoing the block puts them back");
}

// --- a new wallet starts with no rooms at all --------------------------------------------------------
{
  engine.address = "kaspa:qwallettwo";
  rooms.resetBroadcastsForAccount();
  r.eq(rooms.chatListRooms().length, 0, "wallet two: Public Chats is empty");
  engine.address = "kaspa:qwalletone";
  rooms.resetBroadcastsForAccount();
  r.eq(byName().get("kaspa")?.joined, true, "back on wallet one: its rooms kept");
}

// --- no wallet yet: nothing is applied under an unscoped key ------------------------------------
{
  engine.address = "";
  rooms.resetBroadcastsForAccount();
  r.eq(localStorage.getItem("kachat-rooms-opt-in-v1"), null, "no unscoped flag");
}

if (r.fail) {
  console.error(`FAIL ${r.fail} of ${r.pass + r.fail}`);
  for (const failure of r.failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`ok ${r.pass} checks`);
process.exit(0); // the module's sweep interval would otherwise keep node alive
