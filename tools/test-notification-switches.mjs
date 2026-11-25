// K 8cb4c88e notifications audit: every notification switch holds on every path - the open app's
// own notifications, the worker that shows Web Push (public/sw-push.js, Desktop's analogue of the
// iPhone's push extension) and the push registration (ui/web-push-core.js). Plain node, run from
// the repo root:
//
//   node tools/test-notification-switches.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildRegistrationFields, registrationFingerprint } from "../ui/web-push-core.js";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const sandbox = { atob, TextDecoder, Uint8Array, BigInt };
sandbox.globalThis = sandbox;
vm.runInNewContext(read("public/sw-push.js"), sandbox);
const PushMap = sandbox.KaChatPushMap;
const { notificationFromPush } = PushMap;

const app = read("ui/app.js");
const sw = read("public/sw.js");
const rooms = read("ui/broadcasts.js");
const namesNotifier = read("ui/kachat-names-notifier.js");

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

const ME = "kaspa:qpme";
const ALICE = "kaspa:qpalice";
const BOB = "kaspa:qpbob";
const CAROL = "kaspa:qpcarol";
const base = { account: ME, unit: "KAS", sound: true, names: {}, quiet: [], off: [], loud: [], blocked: [] };
const chat = (sender, mirror, extra = {}) => notificationFromPush({ type: "contextual", sender, tx_id: "t1", ...extra }, { ...base, ...mirror });

// ---- master switch ------------------------------------------------------------------------------
test("Push Notifications off reaches the worker: every push is shown and closed", () => {
  assert.match(sw, /const switchedOff = mirror\.enabled === false;/);
  assert.match(sw, /let suppress = Boolean\(mapped\.suppress\) \|\| switchedOff;/);
  // the app writes the switch into the mirror on every round, and clears the mirror on sign-out
  assert.match(read("ui/web-push.js"), /mirror = \{ \.\.\.\(deps\?\.mirror\?\.\(\) \|\| \{\}\), enabled \};/);
});

// ---- Play sound, contacts' own modes ------------------------------------------------------------
test("Play sound off: chats ring silent, a contact set to Sound still rings, No Sound never does", () => {
  assert.equal(chat(ALICE, { sound: false }).options.silent, true);
  assert.equal(chat(ALICE, { sound: false, loud: [ALICE] }).options.silent, false);
  assert.equal(chat(ALICE, { sound: true }).options.silent, false);
  assert.equal(chat(ALICE, { sound: true, quiet: [ALICE] }).options.silent, true);
  // every other kind goes out without its sound too
  const room = notificationFromPush({ type: "broadcast", channel: "kaspa", tx_id: "t", body: "gm" }, { ...base, sound: false, rooms: ["kaspa"] });
  assert.equal(room.options.silent, true);
  const name = notificationFromPush({ type: "name_event", title: "Offer", body: "12 KAS", dedup: "d" }, { ...base, sound: false });
  assert.equal(name.options.silent, true);
  const received = notificationFromPush({ type: "address_activity", address: ALICE, amount_kas: "1", tx_id: "t" }, { ...base, sound: false });
  assert.equal(received.options.silent, true);
});

test("a contact set to Off rings nothing, payments and tips included", () => {
  assert.equal(chat(ALICE, { off: [ALICE] }).suppress, true);
  const payment = notificationFromPush({ type: "payment", sender: ALICE, amount: "150000000", tx_id: "t" }, { ...base, off: [ALICE] });
  assert.equal(payment.suppress, true);
  assert.notEqual(chat(BOB, { off: [ALICE] }).suppress, true);
  // a tip from that contact (its key's address is the tipper's chat)
  const key = "11".repeat(32);
  const tipper = PushMap.kaspaAddressFromXOnly(key, "kaspa");
  const tip = notificationFromPush({ type: "kaposts", actor_pubkey: key, body: "tipped your post: 0.2 KAS", kaposts_kind: "tip", tx_id: "e".repeat(64) }, { ...base, off: [tipper] });
  assert.equal(tip.suppress, true);
  const tipOk = notificationFromPush({ type: "kaposts", actor_pubkey: key, body: "tipped your post: 0.2 KAS", kaposts_kind: "tip", tx_id: "e".repeat(64) }, base);
  assert.notEqual(tipOk.suppress, true);
});

// ---- rooms ------------------------------------------------------------------------------------------
test("a room with its bell off is quiet unless the push @'s you (mention true, 1 or \"true\")", () => {
  const roomPush = (mirror, extra = {}) => notificationFromPush({ type: "broadcast", channel: "kaspa", tx_id: "t", body: "gm", ...extra }, { ...base, ...mirror });
  assert.equal(roomPush({ rooms: [] }).suppress, true);
  assert.notEqual(roomPush({ rooms: ["kaspa"] }).suppress, true);
  for (const mention of ["true", "1", true, 1, "TRUE"]) assert.notEqual(roomPush({ rooms: [] }, { mention }).suppress, true, String(mention));
  for (const mention of ["false", "0", "", false]) assert.equal(roomPush({ rooms: [] }, { mention }).suppress, true, String(mention));
  // no room list mirrored yet (an older app, rooms not started): everything through, as before
  assert.notEqual(roomPush({ rooms: null }).suppress, true);
});

test("public rooms start silenced; bells an account already has stay on", () => {
  assert.doesNotMatch(rooms, /function applyDefaultBellsOnce/);
  assert.doesNotMatch(rooms, /applyDefaultBellsOnce\(\)/);
  // a default room switched back on comes back silenced, #kaspa and #kachat-bugs too
  const curated = rooms.slice(rooms.indexOf("function setCuratedChannel("), rooms.indexOf("export function anyLanguageRoomOn"));
  assert.doesNotMatch(curated, /notifyByChannel\[name\] = true/);
  // the push watch and the worker's room list are the bell-on rooms
  assert.match(rooms, /\.filter\(\(name\) => notifyByChannel\[name\] && isIndexerTrackedBroadcastChannel\(name\) && curatedShown\(name\)\)/);
  assert.match(app, /try \{ rooms = broadcastPushWatch\(\)\.channels; \} catch \{ rooms = null; \}/);
});

// ---- KaPost -------------------------------------------------------------------------------------------
test("a KaPost kind switched off (Mentions included) is quiet in the worker", () => {
  const post = (kaposts_kind, kinds, body = "") => notificationFromPush({ type: "kaposts", kaposts_kind, body, tx_id: "a".repeat(64), post_id: "b".repeat(64) }, { ...base, kapostsKinds: kinds });
  const allOn = { likes: true, dislikes: true, comments: true, reposts: true, follows: true, mentions: true };
  for (const kind of ["vote_up", "vote_down", "reply", "quote", "repost", "follow", "mention"]) {
    assert.notEqual(post(kind, allOn).suppress, true, kind);
  }
  assert.equal(post("vote_up", { ...allOn, likes: false }).suppress, true);
  assert.equal(post("vote_down", { ...allOn, dislikes: false }).suppress, true);
  assert.equal(post("reply", { ...allOn, comments: false }).suppress, true);
  assert.equal(post("quote", { ...allOn, reposts: false }).suppress, true);
  assert.equal(post("repost", { ...allOn, reposts: false }).suppress, true);
  assert.equal(post("follow", { ...allOn, follows: false }).suppress, true);
  assert.equal(post("mention", { ...allOn, mentions: false }).suppress, true);
  // read from the body when the server sends no kind
  assert.equal(post("", { ...allOn, mentions: false }, "mentioned you in a post").suppress, true);
  // no switches mirrored yet: through
  assert.notEqual(post("mention", undefined).suppress, true);
  assert.equal(PushMap.kapostsKindEnabled({ likes: false }, "tip"), true);
  assert.equal(PushMap.kapostsKindEnabled({ likes: false }, "other"), true);
});

test("the app mirrors the KaPost switches and the contacts' Off / Sound modes for the worker", () => {
  const mirror = app.slice(app.indexOf("function webPushMirror()"), app.indexOf("function webPushFocusKey()"));
  assert.match(mirror, /kapostsKinds: \{/);
  for (const key of ["kaPostsNotifyLikes", "kaPostsNotifyDislikes", "kaPostsNotifyComments", "kaPostsNotifyReposts", "kaPostsNotifyFollows", "kaPostsNotifyMentions"]) {
    assert.match(mirror, new RegExp(`accountShellPrefs\\.${key}`), key);
  }
  assert.match(mirror, /else if \(override === "off"\) off\.push\(address\);/);
  assert.match(mirror, /else if \(override === "sound"\) loud\.push\(address\);/);
  assert.match(mirror, /names, quiet, off, loud, blocked,/);
});

// ---- groups --------------------------------------------------------------------------------------------
test("muted groups, muted or hidden members and mentions-only groups stay quiet in the worker", () => {
  const groupPush = (entry) => notificationFromPush({ type: "group_message", blinded_group_id: "AB12", sender: BOB, tx_id: "t" }, { ...base, groups: { ab12: entry } });
  assert.notEqual(groupPush({ g: "g1", n: "Friends", m: BOB }).suppress, true);
  assert.equal(groupPush({ g: "g1", n: "Friends", m: BOB, q: 1 }).suppress, true);
  // a quiet push leaves the badge alone
  assert.equal(groupPush({ g: "g1", n: "Friends", m: BOB, q: 1 }).badge, null);
});

test("the registration leaves out hidden members as well as muted ones, and marks every quiet id", () => {
  const streams = app.slice(app.indexOf("function webPushGroupStreams()"), app.indexOf("function webPushGroupStreams()") + 2200);
  assert.match(streams, /isGroupMemberMuted\(group\.groupId, member\.address\) \|\| isGroupMemberHidden\(group\.groupId, member\.address\)/);
  assert.match(streams, /if \(mode !== "muted" && !quietMember\) ids\.push\(id\);/);
  assert.match(streams, /if \(mode !== "all" \|\| quietMember\) mirror\[id\]\.q = 1;/);
  // muting or hiding a member re-registers at once
  for (const fn of ["setGroupMemberMuted", "setGroupMemberHidden"]) {
    const body = app.slice(app.indexOf(`function ${fn}(`), app.indexOf(`function ${fn}(`) + 700);
    assert.match(body, /scheduleWebPushSync\(\)/, fn);
  }
  // the open app's own group banner skips them too
  const banner = app.slice(app.indexOf("function maybeNotifyGroupIncoming("), app.indexOf("function maybeRecordGroupMention("));
  assert.match(banner, /if \(isGroupMemberHidden\(groupId, senderAddress\)\) return;/);
  assert.match(banner, /if \(isGroupMemberMuted\(groupId, senderAddress\)\) return;/);
});

// ---- the registration -------------------------------------------------------------------------------
test("notify_sound is registered, and switching it registers again", () => {
  const input = { endpoint: "https://push.example/abc", p256dh: "p", authSecret: "a", watchedAddresses: [ME] };
  const on = buildRegistrationFields(input);
  const off = buildRegistrationFields({ ...input, notifySound: false });
  assert.equal(on.notify_sound, true);
  assert.equal(off.notify_sound, false);
  assert.notEqual(registrationFingerprint(on, ME), registrationFingerprint(off, ME));
  assert.equal(buildRegistrationFields({ ...input, kaposts: { pubkey: "02aa", mentions: false } }).kaposts_notify_mentions, false);
  assert.match(app, /notifySound: \(accountShellPrefs\.notificationSound \?\? true\) !== false,/);
  // a Play sound change asks for a sync (the fingerprint then differs)
  assert.match(app, /key === "chatNotifications" \|\| key === "notificationSound" \|\| key === "addressActivityNotifications" \|\| key\.startsWith\("kaPostsNotify"\)/);
});

test("a device with no chats still registers (its own address, primary and watch-only addresses)", () => {
  const fields = buildRegistrationFields({ endpoint: "https://push.example/abc", p256dh: "p", authSecret: "a", primaryAddress: ME, watchOnlyAddresses: [CAROL] });
  assert.equal(fields.primary_address, ME);
  assert.deepEqual([...fields.watch_only_addresses], [CAROL]);
  assert.match(read("ui/web-push.js"), /if \(!fields\.watched_addresses\.length && !fields\.watched_group_ids\.length\) fields\.watched_addresses = \[wallet\.address\.toLowerCase\(\)\];/);
});

// ---- .kachat reminders ----------------------------------------------------------------------------------
test(".kachat reminders follow Push Notifications and Play sound", () => {
  assert.match(app, /canNotify: \(\) => pushNotificationsEnabled\(\) && typeof Notification !== "undefined" && Notification\.permission === "granted",/);
  assert.match(app, /if \(key === "chatNotifications" \|\| key === "notificationSound"\) \{ try \{ kachatNamesNotificationSettingsChanged\(\); \}/);
  assert.match(namesNotifier, /export function kachatNamesNotificationSettingsChanged\(\)/);
  // switched off, nothing stays armed: turning it back on never rings what came due meanwhile
  assert.match(namesNotifier, /if \(!canNotify\(\)\) \{\n\s+stopReminderTimer\(\);\n\s+writeReminders\(wallet, \{\}\);/);
});

// ---- receives while a switch is off ------------------------------------------------------------------
test("a receive while its switch is off moves its floor, so it is never announced later", () => {
  const check = app.slice(app.indexOf("async function runAddressActivityCheck()"), app.indexOf("function makeOutputAddressLookup()"));
  assert.match(check, /\} else if \(!isFirstRun && balance > previousSompi\) \{[\s\S]{0,400}saveActivityFloor\(address, Date\.now\(\)\);/);
  // the muted addresses' balances are still read, so their baselines keep up
  assert.match(check, /const addresses = \[\.\.\.watched\.keys\(\), \.\.\.muted\];/);
});

test("the open app's own notifications all go through the master switch and Play sound", () => {
  const post = app.slice(app.indexOf("function postDesktopNotification("), app.indexOf("function shouldNotifyKaPostsAction("));
  assert.match(post, /if \(!pushNotificationsEnabled\(\)\) return;/);
  assert.match(post, /silent: \(accountShellPrefs\.notificationSound \?\? true\) === false,/);
  const show = app.slice(app.indexOf("async function showAppNotification("), app.indexOf("async function showAppNotification(") + 400);
  assert.match(show, /if \(!pushNotificationsEnabled\(\)\) return false;/);
});

console.log(`notification switches (K 8cb4c88e): ${passed} passed`);
