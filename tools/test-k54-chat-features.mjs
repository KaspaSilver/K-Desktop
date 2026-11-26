// node tools/test-k54-chat-features.mjs - K 518fdc8c's chat features on Desktop: Settings > Chats >
// Who Can Message You? (the hidden requests, their count, the push worker's part and the one ring
// once a name lands), Tip in a 1:1 chat (Tipping's settings, the 10 KAS cap, the Tip card that only
// the send button sends), public rooms pinned into the Chats row, and the chat-side audit fixes
// (profile links, the Send label, plurals, group drafts, Address Book photos, edited previews).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  whoCanMessage, setWhoCanMessage, resetWhoCanMessageCache, isHiddenRequest, visibleMessageRequests,
  noteHiddenRequest, mergeHiddenRequests, settleHiddenRequests, WHO_CAN_MESSAGE_KEY, WHO_CAN_MESSAGE_OPTIONS,
  WHO_CAN_MESSAGE_FOOTERS, HIDDEN_REQUESTS_LIMIT,
} from "../ui/who-can-message.js";
import { parseRoomPins, toggleRoomPin, dropRoomPin, pinnedRoomsInOrder, ROOM_PINS_KEY } from "../ui/room-pins.js";
import {
  instantTipPlan, chatTipStep, INSTANT_TIP_LIMIT_SOMPI, INSTANT_TIP_LIMIT_NOTICE, TIP_IN_ASK, TIP_IN_KASPA, TIP_IN_KUSDT,
} from "../ui/kaposts-tip-in.js";
import { KAPOSTS_TIP_MIN_SOMPI } from "../ui/kaposts-format.js";
import { configureAddressBook, saveAddressBookEntry, addressBookPhoto, forgetAddressBookCache } from "../ui/address-book-store.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8");
const app = read("ui", "app.js");
const html = read("index.html");
const rooms = read("ui", "broadcasts.js");
const sw = read("public", "sw.js");
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}
function fnSource(source, name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} exists`);
  let depth = 0;
  for (let i = source.indexOf(") {", start) + 2; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k),
    get length() { return map.size; }, key: (i) => [...map.keys()][i] ?? null, map,
  };
}
const ME = "kaspa:qzk2jrk7wq3zdw2n0260v87fglky82cg5u3pwy73wpktk3u864yecm5djll40";
const ALICE = "kaspa:qpalice0000000000000000000000000000000000000000000000000000000";
const BOB = "kaspa:qpbob00000000000000000000000000000000000000000000000000000000";

// --- Who Can Message You? --------------------------------------------------------------------------

await test("Who Can Message You?: Anyone by default, one app setting, Usernames saved and read back", () => {
  const storage = memoryStorage();
  resetWhoCanMessageCache();
  assert.equal(whoCanMessage(storage), "anyone");
  assert.equal(setWhoCanMessage("usernames", storage), "usernames");
  assert.equal(storage.getItem(WHO_CAN_MESSAGE_KEY), "usernames");
  resetWhoCanMessageCache();
  assert.equal(whoCanMessage(storage), "usernames", "read back after a reload");
  assert.equal(setWhoCanMessage("everyone?", storage), "anyone", "anything else is Anyone");
  assert.equal(storage.getItem(WHO_CAN_MESSAGE_KEY), null);
  assert.deepEqual(WHO_CAN_MESSAGE_OPTIONS.map((o) => o.label), ["Anyone", "Only Users with a Username"]);
  assert.match(WHO_CAN_MESSAGE_FOOTERS.usernames, /hidden and don't notify you; choose Anyone to see them again/);
  // app-wide, as K's UserDefaults.standard: not an account-scoped key
  assert.doesNotMatch(app, /accountScopedKey\(WHO_CAN_MESSAGE_KEY/);
  resetWhoCanMessageCache();
});

await test("hidden requests: only with Usernames, only without a .kachat name; the count leaves them out", () => {
  assert.equal(isHiddenRequest({ setting: "anyone", label: null }), false);
  assert.equal(isHiddenRequest({ setting: "usernames", label: null }), true);
  assert.equal(isHiddenRequest({ setting: "usernames", label: "  " }), true);
  assert.equal(isHiddenRequest({ setting: "usernames", label: "alice.kachat" }), false);
  const names = { [ALICE]: "alice.kachat" };
  const entries = [{ address: ALICE, request: true }, { address: BOB, request: true }, { address: ME, request: false }];
  const listFor = (setting) => visibleMessageRequests(entries, {
    isRequest: (e) => e.request,
    isHidden: (e) => isHiddenRequest({ setting, label: names[e.address] }),
  });
  assert.deepEqual(listFor("anyone").map((e) => e.address), [ALICE, BOB]);
  assert.deepEqual(listFor("usernames").map((e) => e.address), [ALICE], "Bob is hidden, not deleted");
  assert.equal(entries.length, 3);
  // The sheet, the row's count and a request push's lookup all read the one filtered list; group
  // invites are added on top, untouched.
  const requests = fnSource(app, "messageRequestConversations");
  assert.match(requests, /isMessageRequest\(entry\) && !isHiddenMessageRequest\(entry\)/);
  assert.match(app, /messageRequestConversations\(\)\.length \+ pendingGroupInvites\(\)\.length/);
  const hidden = fnSource(app, "isHiddenMessageRequest");
  assert.match(hidden, /kachatCachedLabel\(address\)/, "asking queues the name's lookup");
  // Accepted chats are never requests, so never hidden: the list's own filter is unchanged.
  assert.match(fnSource(app, "visibleChatConversations"), /if \(isMessageRequest\(conversationEntry\) \|\| isChatBlocked\(contact\.address\)\) return false;/);
});

await test("a hidden request rings nothing, isn't counted as rung, and is filed for later", () => {
  const notify = fnSource(app, "maybeNotifyIncoming");
  const at = notify.indexOf("if (isHiddenMessageRequest(conversationEntry)) { fileHiddenRequest(key); return; }");
  assert.ok(at > 0);
  assert.ok(at < notify.indexOf("s.notified.add(key);"), "before it is marked as rung");
});

await test("a name that lands rings the hidden request once (audit #13); accepted, blocked and nameless ones don't", () => {
  let list = [];
  list = noteHiddenRequest(list, ME, BOB);
  list = noteHiddenRequest(list, ME, BOB.toUpperCase());
  assert.deepEqual(list, [`${ME}|${BOB}`], "filed once, lowercased");
  list = noteHiddenRequest(list, ME, ALICE);
  list = mergeHiddenRequests(list, [`${ME}|${ALICE}`, `other|${BOB}`, "junk"]);
  assert.deepEqual(list, [`${ME}|${BOB}`, `${ME}|${ALICE}`, `other|${BOB}`]);
  let capped = [];
  for (let i = 0; i < HIDDEN_REQUESTS_LIMIT + 20; i += 1) capped = noteHiddenRequest(capped, ME, `kaspa:q${i}`);
  assert.equal(capped.length, HIDDEN_REQUESTS_LIMIT);
  assert.equal(capped.at(-1), `${ME}|kaspa:q${HIDDEN_REQUESTS_LIMIT + 19}`, "the oldest go first");

  const names = {};
  const requests = { [BOB]: true, [ALICE]: true };
  const step = (notified = new Set(), setting = "usernames") => settleHiddenRequests({
    list, wallet: ME, setting,
    requestState: (a) => (a in requests ? requests[a] : null),
    labelOf: (a) => names[a] || null,
    notified,
  });
  let out = step();
  assert.deepEqual(out.announce, [], "nobody named yet");
  assert.equal(out.list.length, 3, "kept for the next pass");
  names[BOB] = "bob.kachat";
  out = step();
  assert.deepEqual(out.announce, [BOB], "rings once its name is known");
  assert.ok(!out.list.includes(`${ME}|${BOB}`), "and leaves the list");
  assert.ok(out.list.includes(`other|${BOB}`), "another account's entry stays");
  assert.deepEqual(step(new Set([BOB])).announce, [], "never twice");
  assert.deepEqual(step(new Set(), "anyone").announce, [], "nothing while Anyone");
  requests[ALICE] = false; // accepted meanwhile
  assert.ok(!step().list.includes(`${ME}|${ALICE}`), "an accepted one is dropped, unannounced");
  const unloaded = settleHiddenRequests({ list: [`${ME}|${ALICE}`], wallet: ME, setting: "usernames", requestState: () => null, labelOf: () => "alice.kachat" });
  assert.deepEqual(unloaded, { list: [`${ME}|${ALICE}`], announce: [] }, "a chat not loaded yet waits");
  const blocked = settleHiddenRequests({ list: [`${ME}|${ALICE}`], wallet: ME, setting: "usernames", requestState: () => true, blocked: () => true, labelOf: () => "alice.kachat" });
  assert.deepEqual(blocked, { list: [], announce: [] });
  // The app runs it when names land, when it comes back, and on a cold open, with the worker's list.
  const announce = fnSource(app, "announceNamedHiddenRequests");
  assert.match(announce, /await takeWorkerHiddenRequests\(\)/);
  assert.match(announce, /title: "New message request"/);
  assert.match(announce, /body: `\$\{name\} wants to chat with you\.`/);
  assert.match(announce, /s\.notified\.add\(address\)/);
  assert.match(app, /onKachatIdentityChange\(\(\) => \{ if \(whoCanMessage\(\) === WHO_CAN_MESSAGE_USERNAMES\) scheduleHiddenRequestAnnounce\(\); \}\)/);
});

await test("web push: a nameless first message rings nothing under Usernames and is filed; requests stay quiet", () => {
  const sandbox = { globalThis: null };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("public", "sw-push.js"), sandbox);
  const { notificationFromPush, noteHiddenRequest: swNote } = sandbox.KaChatPushMap;
  const base = { account: ME, names: {}, blocked: [], requests: [], kachatNamed: [] };
  const first = { type: "contextual", inbox: "true", sender: BOB, tx_id: "t1" };
  const anyone = notificationFromPush(first, { ...base, whoCanMessage: "anyone" });
  assert.equal(anyone.suppress, false);
  assert.equal(anyone.title, "New message request");
  const hidden = notificationFromPush(first, { ...base, whoCanMessage: "usernames" });
  assert.equal(hidden.suppress, true);
  assert.equal(hidden.hiddenRequest, BOB, "filed for the app");
  const named = notificationFromPush(first, { ...base, whoCanMessage: "usernames", kachatNamed: [BOB] });
  assert.equal(named.suppress, false, "a sender the app knows a name for rings");
  assert.equal(named.hiddenRequest, undefined);
  // a later message from someone already in Message Requests is quiet, as in the open app
  const later = notificationFromPush({ type: "contextual", sender: BOB, tx_id: "t2" }, { ...base, whoCanMessage: "anyone", requests: [BOB] });
  assert.equal(later.suppress, true);
  const payment = notificationFromPush({ type: "payment", sender: BOB, amount: "100000000" }, { ...base, whoCanMessage: "usernames", requests: [BOB] });
  assert.equal(payment.suppress, false, "payments ring as payments");
  // A chat you accepted isn't a request (no inbox tag, not listed): untouched.
  assert.equal(notificationFromPush({ type: "contextual", sender: ALICE }, { ...base, whoCanMessage: "usernames" }).suppress, false);
  assert.deepEqual(Array.from(swNote(swNote([], ME, BOB), ME, BOB)), [`${ME}|${BOB}`]);
  assert.match(sw, /if \(mapped\.hiddenRequest && !switchedOff\)/);
  assert.match(sw, /kvSet\("hiddenRequests", self\.KaChatPushMap\.noteHiddenRequest\(await kvGet\("hiddenRequests"\), mirror\.account, mapped\.hiddenRequest\)\)/);
  assert.match(fnSource(app, "webPushMirror"), /\.\.\.whoCanMessageMirror\(\)/);
});

await test("Settings > Chats has Who Can Message You?, with what each choice does under it", () => {
  assert.match(html, /<strong>Who Can Message You\?<\/strong>/);
  assert.match(html, /data-who-can-message aria-label="Who Can Message You\?"/);
  assert.ok(html.indexOf("Who Can Message You?") < html.indexOf("data-open-quick-reactions"), "first on the page, as K");
  assert.match(fnSource(app, "applyWhoCanMessage"), /scheduleWebPushSync/);
});

// --- Tip in a 1:1 chat -------------------------------------------------------------------------------

await test("the default tip: up to 10 KAS goes, over it opens the tip screen, under 0.2 KAS or no price says why", () => {
  assert.equal(INSTANT_TIP_LIMIT_SOMPI, 1_000_000_000);
  assert.deepEqual(instantTipPlan({ defaultTip: null }), { kind: "none" });
  assert.deepEqual(instantTipPlan({ defaultTip: { sompi: 50_000_000 } }), { kind: "send", sompi: 50_000_000 });
  assert.deepEqual(instantTipPlan({ defaultTip: { sompi: INSTANT_TIP_LIMIT_SOMPI } }), { kind: "send", sompi: INSTANT_TIP_LIMIT_SOMPI });
  assert.deepEqual(instantTipPlan({ defaultTip: { sompi: INSTANT_TIP_LIMIT_SOMPI + 1 } }), { kind: "overLimit" });
  assert.deepEqual(instantTipPlan({ defaultTip: { sompi: KAPOSTS_TIP_MIN_SOMPI - 1 } }), { kind: "tooSmall" });
  assert.deepEqual(instantTipPlan({ defaultTip: { fiat: 1, currency: "usd" }, price: null }), { kind: "noPrice" });
  assert.deepEqual(instantTipPlan({ defaultTip: { fiat: 1, currency: "usd" }, price: 0.5 }), { kind: "send", sompi: 200_000_000 });
  assert.deepEqual(instantTipPlan({ defaultTip: { fiat: 6, currency: "usd" }, price: 0.5 }), { kind: "overLimit" }, "$6 at $0.50 is 12 KAS");
  assert.match(INSTANT_TIP_LIMIT_NOTICE, /^Instant tips are limited to 10 KAS\./);
  // KaPost's Tip keeps the same cap.
  const tipUser = app.slice(app.indexOf("tipUser: async"), app.indexOf("kaPostsCooldownEnabled,", app.indexOf("tipUser: async")));
  assert.match(tipUser, /const plan = instantTipPlan\(\{ defaultTip, price \}\);/);
  assert.match(tipUser, /openTipModal\(\{ address, name, tip, onTipped, error: INSTANT_TIP_LIMIT_NOTICE \}\)/);
});

await test("Tip from the +: a default waits as a card, never sent from the + itself; kUSDT is Send Dollars; Ask asks", () => {
  const send = { kind: "send", sompi: 50_000_000 };
  assert.deepEqual(chatTipStep({ tipIn: TIP_IN_KASPA, plan: send }), { step: "card", sompi: 50_000_000 });
  assert.deepEqual(chatTipStep({ tipIn: TIP_IN_KASPA, plan: { kind: "none" } }), { step: "sheet", notice: "" }, "no default asks the amount");
  assert.deepEqual(chatTipStep({ tipIn: TIP_IN_KASPA, plan: { kind: "overLimit" } }), { step: "sheet", notice: INSTANT_TIP_LIMIT_NOTICE });
  assert.deepEqual(chatTipStep({ tipIn: TIP_IN_KASPA, plan: { kind: "tooSmall" } }), { step: "error", reason: "tooSmall" });
  assert.deepEqual(chatTipStep({ tipIn: TIP_IN_KUSDT, plan: send }), { step: "dollars" });
  assert.deepEqual(chatTipStep({ tipIn: TIP_IN_ASK, plan: send }), { step: "ask" });
  for (const tipIn of [TIP_IN_KASPA, TIP_IN_KUSDT, TIP_IN_ASK]) {
    for (const kind of ["none", "send", "overLimit", "tooSmall", "noPrice"]) {
      assert.notEqual(chatTipStep({ tipIn, plan: { kind, sompi: 1 } }).step, "send", "the + never sends");
    }
  }
  const fromPlus = fnSource(app, "tipFromChat");
  assert.doesNotMatch(fromPlus, /sendInstantTip|sendPendingChatTip|engine\.send/, "the + only stages it");
  assert.match(fromPlus, /pendingChatTip\.value = \{/);
  assert.match(fromPlus, /if \(step\.step === "dollars"\) \{ openChatDollarSend\(\); return; \}/);
  assert.match(fromPlus, /isSelfConversation\(conversationEntry\)\) return;/, "not in your own chat");
});

await test("the Tip card: the send button sends it from Tips From, as an ordinary payment; the trash takes it back", () => {
  const submit = app.slice(app.indexOf('composer.addEventListener("submit"'), app.indexOf("if (pendingPhotoAttachment) {", app.indexOf('composer.addEventListener("submit"')));
  assert.match(submit, /if \(activeChatTip\(\)\) \{ sendPendingChatTip\(\); return; \}/);
  const sendTip = fnSource(app, "sendPendingChatTip");
  // no post named (null), Tips From's address, the chat's own toast; no password asked
  assert.match(sendTip, /sendInstantTip\(tip\.address, tip\.name, tip\.sompi \/ 1e8, null, tip\.fiatText, kaPostsTipSourceIndex\(\), \{ chat: true \}\)/);
  assert.match(sendTip, /if \(kaPostsTipSourceUnavailable\(\)\)/);
  assert.doesNotMatch(sendTip, /authorizeKasSpend|unlockFor|password/i);
  assert.match(sendTip, /SEND_OUTCOME_UNKNOWN\) \{ done = true;/, "an unknown outcome takes the card away");
  assert.match(app, /document\.querySelector\("\[data-pending-tip-remove\]"\)\?\.addEventListener\("click", \(\) => \{\n  if \(pendingChatTip\.value\?\.sending\) return;\n  pendingChatTip\.value = null;/);
  assert.match(fnSource(app, "syncComposerSlots"), /hasTip \? "Send Tip" : "Send"/);
});

await test("the 1:1 + order: Send Kaspa, Send Dollars, Tip, then the rest; Tip hidden in your own chat", () => {
  const pay = html.indexOf("data-composer-pay title");
  const dollars = html.indexOf("data-composer-dollars title");
  const tip = html.indexOf("data-composer-tip title");
  const camera = html.indexOf('data-composer-media="camera"');
  assert.ok(pay > 0 && pay < dollars && dollars < tip && tip < camera);
  assert.match(html, /<strong>Tip<\/strong><small>Tip this contact, as set in Settings > Customization > Tipping\.<\/small>/);
  assert.match(app, /querySelectorAll\("\[data-composer-tip\]"\)\.forEach\(\(row\) => \{ row\.hidden = botChat \|\| selfChat; \}\)/);
});

await test("Tipping lives in Settings > Customization; Settings > KaPost keeps the cool down", () => {
  assert.match(html, /data-settings-open-tipping>[\s\S]*?<strong>Tipping<\/strong>/);
  assert.match(html, /What Tip sends, on a post and in a chat\./);
  assert.match(app, /addEventListener\("click", \(\) => openKaPostsSettings\(\{ part: "tipping" \}\)\)/);
  const settings = fnSource(app, "openKaPostsSettings");
  assert.match(settings, /const part = options\?\.part === "tipping" \? "tipping" : "kapost";/);
  assert.match(settings, /<div data-kaposts-part="kapost">[\s\S]*data-kaposts-cooldown[\s\S]*<div data-kaposts-part="tipping">[\s\S]*data-kaposts-tip-in[\s\S]*data-kaposts-open-tips-from/);
  assert.match(settings, /el\.hidden = el\.getAttribute\("data-kaposts-part"\) !== part;/);
  assert.match(settings, /\$\{part === "tipping" \? "Tipping" : "KaPost Settings"\}/);
  assert.match(settings, /\$\{INSTANT_TIP_LIMIT_FOOTER\}/);
});

// --- Room pins -----------------------------------------------------------------------------------

await test("room pins: newest first, each once, kept per account; a pin whose room is gone shows nowhere", () => {
  assert.deepEqual(parseRoomPins('["kaspa"," kaspa ","","dev",4]'), ["kaspa", "dev"]);
  assert.deepEqual(parseRoomPins("not json"), []);
  let pins = [];
  ({ pins } = toggleRoomPin(pins, "kaspa"));
  const second = toggleRoomPin(pins, "dev");
  assert.equal(second.pinned, true);
  assert.deepEqual(second.pins, ["dev", "kaspa"], "a new pin goes first");
  const off = toggleRoomPin(second.pins, "kaspa");
  assert.deepEqual(off, { pins: ["dev"], pinned: false });
  const listed = [{ name: "kaspa" }, { name: "dev" }, { name: "es" }];
  assert.deepEqual(pinnedRoomsInOrder(["es", "gone", "kaspa"], listed).map((r) => r.name), ["es", "kaspa"]);
  assert.equal(ROOM_PINS_KEY, "kachat-room-pins-v1");
  assert.match(fnSource(app, "chatRoomPins"), /accountScopedKey\(ROOM_PINS_KEY\)/);
});

await test("switching a default room off, or leaving your own, drops its pin", () => {
  assert.deepEqual(dropRoomPin(["dev", "kaspa"], "kaspa"), { pins: ["dev"], changed: true });
  assert.deepEqual(dropRoomPin(["dev"], "kaspa"), { pins: ["dev"], changed: false });
  const curated = fnSource(rooms, "setCuratedChannel");
  assert.match(curated, /if \(!shown\) \{[\s\S]*deps\.onRoomRemoved\?\.\(name\)/);
  assert.match(fnSource(rooms, "leaveChannel"), /deps\.onRoomRemoved\?\.\(name\)/);
  assert.match(app, /onRoomRemoved: \(name\) => dropChatRoomPin\(name\),/);
});

// K 961fc05a: the pinned rooms are the Public Chats page's circles, alone (tools/test-public-chats-page.mjs).
await test("a pinned room is a # circle on the Public Chats page, out of the list but in search results", () => {
  const list = fnSource(app, "visibleChatRooms");
  assert.match(list, /if \(query\) return rooms\.filter/);
  assert.match(list, /rooms\.filter\(\(room\) => !pinned\.has\(room\.name\)\)/);
  const circles = fnSource(app, "visibleChatCircles");
  assert.match(circles, /if \(onPublicChatsPage\(\)\) \{\n    return pinnedChatRooms\(\)\.map\(/);
  assert.match(circles, /return \[\.\.\.pinned, \.\.\.rest\];/);
  assert.match(fnSource(app, "pinnedChatRooms"), /if \(String\(searchInput\?\.value \|\| ""\)\.trim\(\)\) return \[\];/);
  assert.match(fnSource(app, "chatCirclesHtml"), /chat-circle-glyph chat-circle-room">#</);
  // its hold: Mark as Read, Unpin, Mute and Delete
  const sheet = fnSource(app, "openPinnedRoomSheet");
  for (const title of ["Mark as Read", "Unpin", "Mute", "Delete"]) assert.ok(sheet.includes(`title: "${title}"`), title);
  assert.match(app, /if \(circleId\.startsWith\("r:"\)\) \{ openPinnedRoomSheet\(circleId\.slice\(2\)\); return; \}/);
  // the row swipes and sheet offer the pin
  assert.match(app, /chatRowSwipeActions\(\{ unread: room\.unread, isSilent: !room\.notify, isPinned: chatRoomPins\(\)\.includes\(room\.name\) \}\)/);
  assert.match(fnSource(app, "runRoomRowChoice"), /else if \(choice === "pin"\) toggleChatRoomPin\(name\);/);
});

// --- Chat audit fixes --------------------------------------------------------------------------------

await test("#20: a profile link (?chat=1 too) opens User Info; nothing saves the stranger as a contact", () => {
  const parse = fnSource(app, "parseKaChatInternalLink");
  const sandbox = {
    parseBotChallengeLink: () => null, parsePaymentRequestLinkCached: () => null, parseHubLink: () => null,
    toActiveNetworkAddress: (a) => a, isValidKaspaAddressString: () => true, isUnsafeObjectKey: () => false,
  };
  vm.runInNewContext(`${parse}; this.parse = parseKaChatInternalLink;`, sandbox);
  const body = ME.slice("kaspa:".length);
  for (const link of [`kachat://profile/${ME}?chat=1`, `https://kachat.app/u/${body}?chat=1`]) {
    assert.deepEqual({ ...sandbox.parse(link) }, { kind: "profile", address: ME }, link);
  }
  // Opening it shows their info; the record made for that is "viewed only", not a saved contact,
  // and isn't accepted until you write to them.
  const open = fnSource(app, "openProfileLink");
  assert.match(open, /openChatInfoForAddress\(/);
  assert.doesNotMatch(open, /state\.contacts\.push|acceptChat|persistState/);
  assert.match(fnSource(app, "openChatInfoForAddress"), /viewedOnly: true,/);
  assert.match(fnSource(app, "isAcceptedContact"), /if \(contact\.viewedOnly\) \{[\s\S]*direction === "outgoing"/);
  assert.doesNotMatch(app, /get\("chat"\)|chat=1"\)/, "?chat=1 is never acted on");
});

await test("#32: the 1:1 send button is labelled Send", () => {
  const composer = html.slice(html.indexOf("<form class=\"composer kachat-composer\" data-composer>"), html.indexOf("</form>", html.indexOf("data-composer>")));
  assert.match(composer, /<button class="composer-send" type="submit" aria-label="Send">/);
  assert.match(fnSource(app, "syncComposerSlots"), /icon === "stop" \? "Stop recording" : icon === "mic" \? "Record" : hasTip \? "Send Tip" : "Send"/);
});

await test("#33/#34: counts read as whole English, never an \"s\" glued on", () => {
  const sandbox = {};
  vm.runInNewContext(`${fnSource(app, "countedText")}; this.f = countedText;`, sandbox);
  assert.equal(sandbox.f(1, "Delete 1 Chat?", "Delete {n} Chats?"), "Delete 1 Chat?");
  assert.equal(sandbox.f(3, "Delete 1 Chat?", "Delete {n} Chats?"), "Delete 3 Chats?");
  assert.equal(sandbox.f(0, "1 chat", "{n} chats"), "0 chats");
  for (const glued of [
    /Delete \$\{chats\} Chat\$\{/, /Delete \$\{groups\} Group\$\{/, /Delete \$\{rooms\} Public Chat\$\{/,
    /Delete \$\{count\} Message\$\{/, /\$\{rows\.length\} chat\$\{/, /\$\{days\} day\$\{/, /Notifications on for \$\{rooms\.length\}`/,
    /"Adding member\(s\) to the group…"/, /"they" : "they"/,
  ]) assert.doesNotMatch(app, glued);
  assert.match(app, /countedText\(chats, "Delete 1 Chat\?", "Delete \{n\} Chats\?"\)/);
  assert.match(app, /countedText\(count, "Delete 1 Message\?", "Delete \{n\} Messages\?"\)/);
  assert.match(app, /countedText\(idsToDelete\.size, "Chat deleted\.", "\{n\} chats deleted\."\)/);
});

await test("#16: a group draft is filed only under the account it was typed in", () => {
  const close = fnSource(app, "closeGroupChat");
  assert.match(close, /const sameAccount = \(openGroupChat\.draftOwner \?\? engine\.address \?\? ""\) === \(engine\.address \|\| ""\);/);
  assert.match(close, /if \(keepDraft !== false && sameAccount\) saveDraft/);
  assert.match(fnSource(app, "openGroupChat"), /openGroupChat\.draftOwner = engine\.address \|\| "";/);
});

await test("#17: no Address Book photo shows once signed out", () => {
  const storage = memoryStorage();
  const photos = new Map();
  let wallet = ME;
  configureAddressBook({
    storage, photoStorage: { get: (k) => photos.get(k) ?? null, set: (k, v) => photos.set(k, v), remove: (k) => photos.delete(k) },
    scopedKey: (base, w) => `${w}:${base}`, wallet: () => wallet, isValidAddress: () => true,
  });
  saveAddressBookEntry({ address: ALICE, name: "Alice", photo: "data:image/jpeg;base64,AAAA" });
  assert.equal(addressBookPhoto(ALICE), "data:image/jpeg;base64,AAAA");
  wallet = "";
  forgetAddressBookCache();
  assert.equal(addressBookPhoto(ALICE), null);
  wallet = ME;
  assert.equal(addressBookPhoto(ALICE), "data:image/jpeg;base64,AAAA", "back with the account");
  assert.match(app, /engine\.clearSession\(\);\n    lockKeyVault\(\);[^\n]*\n    \/\/ The Address Book's photos go with the account[^\n]*\n    try \{ forgetAddressBookCache\(\); resetAddressBookForAccount\(\); \}/);
});

await test("#10: a group row shows the edited text of its last message; #14: live delivery reads every 256-lane chunk", () => {
  assert.match(fnSource(app, "groupRowHtml"), /groupRowPreview\(\{ \.\.\.last, text: groupMessageContent\(g\.groupId, last\) \}\)/);
  // Desktop's thread rows are cached against the shown (edited) text, not the message id alone.
  assert.match(app, /cachedRow\.shown === rowShown/);
  const store = read("engine", "group-store.js");
  assert.match(store, /for \(let i = 0; i < ids\.length; i \+= 256\) \{\n\s+const chunk = ids\.slice\(i, i \+ 256\);/);
});

console.log(`k54 chat features: ${passed} passed`);
