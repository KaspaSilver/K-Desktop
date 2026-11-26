// K d089011f: every @mention of you in a public chat or a group is a row in Profile's bell, and a
// row opens the room at the message (or the group). Your own @ opens the Profile tab, and a room
// behind another tab keeps its place.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
const rooms = readFileSync(new URL("../ui/broadcasts.js", import.meta.url), "utf8");
const kaposts = readFileSync(new URL("../ui/kaposts.js", import.meta.url), "utf8");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}
function fnSource(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const next = text.indexOf("\nfunction ", start + 10);
  const nextAsync = text.indexOf("\nasync function ", start + 10);
  const nextExport = text.indexOf("\nexport ", start + 10);
  const ends = [next, nextAsync, nextExport].filter((i) => i > 0);
  return text.slice(start, ends.length ? Math.min(...ends) : undefined);
}

test("the bell keeps mention rows, one per message, and lists them with an @", () => {
  assert.match(app, /const NOTIF_CENTER_SOURCES = new Set\(\["wallet", "kachat", "mention"\]\);/);
  const record = fnSource(app, "recordMentionNotification");
  assert.match(record, /source: "mention",\n\s*id: `mention-\$\{id\}`,/);
  assert.match(record, /title: `\$\{sender\} mentioned you in \$\{place\}`/);
  assert.match(record, /targetId: `\$\{target\}\|\$\{txId\}`/);
  assert.match(app, /n\.source === "mention" \? "mention" : "kachat"/);
  assert.match(kaposts, /item\.kind === "mention" \? PANEL_ICONS\.at : PANEL_ICONS\.bell/);
});

test("a mention row opens the room at the message, or the group", () => {
  const open = fnSource(app, "openGlobalNotification");
  assert.match(open, /if \(notif\.targetKind === "mention"\) \{/);
  assert.match(open, /openBroadcastMessageFromNotification\(place\.slice\("room:"\.length\), txId\)/);
  assert.match(open, /openGroupChat\(place\.slice\("group:"\.length\)\)/);
  const jump = rooms.slice(rooms.indexOf("export function openBroadcastMessageFromNotification("), rooms.indexOf("export function initBroadcasts("));
  assert.match(jump, /openBroadcastChannelFromNotification\(channel\);/);
  assert.match(jump, /jumpToBroadcastMessage\(txId, \{ quiet: true \}\)/, "not loaded: the room opens as usual, no toast");
  assert.match(rooms, /if \(!row\) \{ if \(!quiet\) deps\.showToast\?\.\("Original message not available\."\); return; \}/);
});

test("rooms: every new message that @'s you, whatever the room's bell, not your own nor a hidden sender's", () => {
  const record = fnSource(rooms, "recordRoomMentions");
  assert.match(record, /isServiceBroadcastChannel\(channel\)/, "never the machinery rooms");
  assert.match(record, /=== me \|\| hiddenHere\.has\(row\.senderAddress\)\) continue;/);
  assert.match(record, /if \(!roomTextMentionsMe\(preview\)\) continue;/);
  assert.match(record, /target: `room:\$\{channel\}`/);
  assert.doesNotMatch(record, /notifyByChannel/, "the room's bell doesn't decide");
  // only rows this read added, after a switched-off default room is left out
  assert.match(rooms, /if \(!curatedShown\(channel\)\) freshIncoming\.length = 0;\n\s*recordRoomMentions\(channel, freshIncoming\);/);
  assert.match(app, /recordMention: \(mention\) => recordMentionNotification\(mention\),/);
});

test("groups: a mention is in the bell whatever the group's setting; muted only stops the ring", () => {
  const notify = fnSource(app, "maybeNotifyGroupIncoming");
  const mention = notify.indexOf("maybeRecordGroupMention(");
  const muted = notify.indexOf('if (mode === "muted") return;');
  assert.ok(mention > 0 && muted > mention, "the mention is recorded before a muted group returns");
  assert.ok(notify.indexOf("isGroupMemberHidden(") < mention && notify.indexOf("isGroupMemberMuted(") < mention, "never from a hidden or muted member");
  assert.ok(notify.indexOf("learnedAt") < mention, "nor history from before you joined");
  assert.match(notify, /\{ ring: mode !== "muted" \}/);
  const record = fnSource(app, "maybeRecordGroupMention");
  assert.match(record, /recordMentionNotification\(\{/);
  assert.match(record, /target: `group:\$\{groupId\}`/);
  assert.match(record, /if \(!ring \|\| !groupOsPingAllowed\(groupId\)/);
});

test("your own @ opens the Profile tab, not a visitor's copy", () => {
  const own = fnSource(app, "openProfileForAddress");
  assert.match(own, /setActiveAppTab\("profile"\);/);
  assert.match(own, /openChatInfoForAddress\(address\);/);
  assert.match(app, /openUserInfo: \(address\) => openProfileForAddress\(address\),/);
  assert.match(app, /if \(choice === "profile"\) openProfileForAddress\(address\);/);
  assert.match(app, /openProfileTab: \(\) => setActiveAppTab\("profile"\),/);
  const tap = fnSource(kaposts, "openProfileFromTap");
  assert.match(tap, /deps\.openProfileTab\(\);/);
  // mentions, posters, notifications and search go through it; the Profile tab's own profile doesn't
  assert.match(kaposts, /openProfileFromTap\(address, null\);/);
  assert.match(kaposts, /openProfileFromTap\(p\.posterAddress, p\.posterPubkey\);/);
  assert.match(kaposts, /else if \(item\.actorAddress\) openProfileFromTap\(item\.actorAddress, null\);/);
  assert.match(kaposts, /if \(personRow\) openProfileFromTap\(/);
  assert.match(kaposts, /if \(deps\.engine\.address\) openPosterProfile\(deps\.engine\.address, safeRequesterPubkey\(\)\);/);
});

test("a room hidden behind another tab keeps the reader's place; one at the newest goes to the newest", () => {
  const restore = fnSource(rooms, "restoreRoomScrollPlace");
  assert.match(restore, /roomBodyEl\.scrollTop = place\.atBottom \? roomBodyEl\.scrollHeight : place\.top;/);
  const note = fnSource(rooms, "noteRoomScrollPlace");
  assert.match(note, /if \(roomPlacePending \|\| !roomBodyEl \|\| !activeChannel \|\| roomBodyEl\.clientHeight === 0\) return;/, "never a hidden room's reset scroll");
  assert.match(rooms, /roomBodyEl\?\.addEventListener\("scroll", noteRoomScrollPlace, \{ passive: true \}\);/);
  assert.match(rooms, /if \(!laidOut && roomScrollPlace\?\.channel === activeChannel\) roomPlacePending = true;/);
  assert.match(rooms, /if \(roomOnScreen && roomScrollPlace\?\.channel === activeChannel\) roomPlacePending = true;/);
  assert.match(rooms, /\} else if \(restoreRoomScrollPlace\(\)\) \{/);
  // the bell's jump lands at once, so a poll's re-render can't stop it short
  assert.match(rooms, /row\.scrollIntoView\(\{ behavior: quiet \? "auto" : "smooth", block: "center" \}\);/);
});

console.log(`mentions in the bell: ${passed} passed`);
