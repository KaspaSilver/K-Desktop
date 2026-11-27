// Broadcasts tab UI — desktop port of the iOS/Android 4.0 broadcast rooms. Channel list
// (featured rooms pinned, then every other default room and the joinable customs), room view with
// indexer backfill (once on open + 8s polling while open), per-room hidden users, the Public Chats
// settings sheet (a switch per default room, and the Languages switch), and a live connection dot
// in the room header. Feature parity with mobile:
// link previews in bubbles (same progressive Nextcloud probe as 1:1), reactions (same
// cross-platform JSON payload as 1:1, sent as normal broadcast messages), and voice notes
// via Nextcloud media upload.

import { IS_TESTNET, KAS_UNIT } from "../engine/network.js";
import { isKaChatSiteLink } from "./kaposts-format.js";
import { allowsPreview } from "../engine/link-preview-policy.js";
import { stripBidiControls } from "./kaposts-markdown.js";
import { onForegroundBeat, BEAT_MS } from "./foreground-beat.js";
import { sompiFromUserText, kasTextFromSompi } from "../engine/amounts.js";
import {
  BROADCAST_RETENTION_MS,
  FEATURED_BROADCAST_CHANNELS,
  LANGUAGE_BROADCAST_CHANNELS,
  broadcastLanguageDisplayName,
  fetchBroadcastHistory,
  hasBroadcastIndexer,
  isCuratedBroadcastChannel,
  isIndexerTrackedBroadcastChannel,
  isServiceBroadcastChannel,
  onIndexerTrackedRoomsChange,
  refreshIndexerTrackedRooms,
  isValidBroadcastChannel,
  normalizeBroadcastChannel,
  sendBroadcastMessage,
  broadcastPayloadBytes,
  RETIRED_BROADCAST_CHANNELS,
  replacementBroadcastChannel,
  curatedBroadcastChannels,
  indexerDefaultBroadcastChannels,
  DROPPED_ROOM_GRACE_MS,
  broadcastContentDigest,
} from "../engine/broadcasts.js";
import { ROOM_PINS_KEY, parseRoomPins } from "./room-pins.js";
import { setSettingItem, onSettingsStorageFull } from "./settings-storage.js";
import { roomCacheForStorage, restoreTruncatedRow, pruneRoomEdits } from "./room-cache-budget.js";
import { isIndexerDown, onIndexerAvailabilityChange, indexerKey, INDEXER_RECOVERY_MARGIN_MS } from "../engine/indexer-health.js";
import { getEndpoint } from "../engine/endpoints.js";
import { confirmDialog, promptDialog, PROMPT_EXTRA, alertDialog, chooseDialog, userFacingError } from "./dialogs.js";
import { onContextGesture, attachDoubleTap, onMessageClick, isTouchDevice, releaseTypingFocus } from "./touch.js";
import { roomHiddenSenders, roomMessageReportBody, sendContentReport } from "./kapost-moderation.js";
import { SEND_OUTCOME_UNKNOWN, SEND_OUTCOME_UNKNOWN_MESSAGE } from "../engine/transactions.js";
import { settleLeftoverRoomRows, markRoomRowUnconfirmed, settleRoomCopy, ROOM_UNCONFIRMED } from "./leftover-sends.js";
import { accountGuard } from "./account-guard.js";
import { recordRoomEdit, restoreRoomEdit, roomLinkJoinPrompt, roomPollGapFloor } from "../engine/kaposts.js";
import { encodeRoomDelete, parseRoomDelete, roomDeleteEntry, roomDeleteLookupSet, addRoomDelete, resolveRoomDeletes, rowsTheIndexerNoLongerHas } from "../engine/room-deletes.js";
import { groupParts, isLaterPart, VOICE_PATHS, voicePartSizes } from "../engine/voice-parts.js";
import * as VoiceNotes from "./voice-notes.js";
import { MENTIONS_ENABLED, mentionTokens, textMentionsName, roomMentionCandidates, attachMentionSuggestions } from "./username-mentions.js";
import { primary as primaryName } from "../engine/name-services.js";

// Public chain data caches are global but per network: a testnet room is not the mainnet room.
const NET_SUFFIX = IS_TESTNET ? "-testnet" : "";
const CHANNELS_KEY = "kachat-broadcast-channels-v1";        // account-scoped: ["name", ...]
const HIDDEN_KEY = "kachat-broadcast-hidden-v1";            // account-scoped: { [channel]: [address, ...] }
const NOTIFY_KEY = "kachat-broadcast-notify-v1";            // account-scoped: { [channel]: true } — the bell
const LISTEN_KEY = "kachat-broadcast-listen-v1";            // account-scoped: { [channel]: true } — always-listen
const RETENTION_KEY = "kachat-broadcast-retention-v1";      // account-scoped: { [channel]: millis } (own channels only; absent = the 3h default)
const INDEXER_KEY = "kachat-broadcast-indexer-v1";          // account-scoped: { [channel]: url } — per-room indexer override (Room Info)
const JOINED_AT_KEY = "kachat-broadcast-joined-at-v1";      // account-scoped: { [channel]: ms } — when this device joined the room
// Retention is bounded (iOS BroadcastStore.maxRetentionMillis): a room can hold at most three
// days on this device, and a new room starts at three hours.
const MAX_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_MS = 3 * 60 * 60 * 1000;
// A voice note that goes on-chain is capped hard (iOS BroadcastAudioRecording.maxDuration);
// "Record via Nextcloud" runs to the app-wide Nextcloud cap instead.
// On chain a room note runs as long as 1 KAS of fees allows, 2:50, as tagged parts (KaPost
// 1b15521, VoiceNotePolicy.publicChat); a browser without the encoder keeps the old 10 s note.
const LEGACY_ONCHAIN_VOICE_MAX_SECONDS = 10;
function onchainVoiceMaxSeconds() {
  return VoiceNotes.longVoiceNotesSupported() ? VOICE_PATHS.room.maxSeconds : LEGACY_ONCHAIN_VOICE_MAX_SECONDS;
}

// Long voice notes in rooms: parts by (room, sender, id, count) are one bubble (KaPost
// PublicChatVoiceParts). The cache is per room, so the sender is the owner.
function roomPartStatus(m) {
  if (m.status === "failed") return "failed";
  if (m.status === "pending") return "pending";
  if (m.status === ROOM_UNCONFIRMED) return "warning";
  return "sent";
}
const ROOM_PART_ACCESSORS = {
  content: (m) => m.content,
  owner: (m) => String(m.senderAddress || "").toLowerCase(),
  key: (m) => m.txId,
  status: roomPartStatus,
};
let roomParts = { clusters: new Map(), hidden: new Set(), anchorKeyOf: new Map() };
const LONG_MESSAGE_BYTES = 2000;
const LONG_MESSAGE_PREVIEW_CHARS = 500;
const LINK_HOST = "kachat.app"; // every shared link is https://kachat.app/... (KACHAT_APP_LINKS.md)
const CACHE_KEY = `kachat-broadcast-messages-cache-v1${NET_SUFFIX}`;     // GLOBAL: public chain data, account-agnostic
const REACTIONS_KEY = `kachat-broadcast-reactions-cache-v1${NET_SUFFIX}`; // GLOBAL: public chain data, account-agnostic
const EDITS_KEY = `kachat-broadcast-edits-cache-v1${NET_SUFFIX}`;         // GLOBAL: { [channel]: { [targetTxId]: { text, blockTime, editor, txIds } } }
// GLOBAL: ["room|txid|sender", ...] - room messages their sender deleted for everyone (K e4062188
// PublicChatStore.recordDelete). K keeps it per account because its room cache is; Desktop's room
// cache is shared by every account here, so the record that keeps a message out of it is too.
const DELETES_KEY = `kachat-broadcast-deletes-v1${NET_SUFFIX}`;
const POLL_MS = 8000;
// Nextcloud carries the audio bytes - the same 5 minutes as every Nextcloud voice note in the app
// (iOS ComposerMediaLimits.nextcloudVoiceSeconds); app.js hands its own figure over as a dep.
const VOICE_MAX_DURATION_SECONDS = 300;
// "Record via Nextcloud" chosen at the mic for the note being recorded (iOS nextcloudVoiceRequested).
let voiceViaNextcloud = false;

let deps = null;

let roomEl, roomTitleEl, roomBodyEl, composerInput, sendBtn;
let voicePanelEl, voiceBtn;
let joinedChannels = [];
let hiddenByRoom = {};
let notifyByChannel = {};    // { [channel]: true } — the bell: OS pings for new messages
let retentionByChannel = {}; // { [channel]: millis } — own channels only; indexed rooms are fixed 30-day
let indexerByChannel = {};   // { [channel]: url } — Room Info's per-room indexer override
let joinedAtByChannel = {};  // { [channel]: ms }
let feeOverrideKas = null;   // the fee typed on the pill for the NEXT message
let feeEstimateKas = null;
let feeEstimateLength = null; // UTF-8 bytes of the text feeEstimateKas is for
// { [channel]: true } — always-listen, own channels only. Keeps a custom room's live block
// scan running while its screen is closed (iOS BroadcastChannel.alwaysListen). Curated rooms
// deliberately have no toggle: they are indexer-backed, so there is nothing to keep alive.
let listenByChannel = {};
// True while the Broadcasts tab is the visible tab. An open room only counts as "wanted"
// (and only polls) while its screen is actually on screen.
let tabVisible = false;
// True only while Public Chats itself is on screen. tabVisible stays true on Chats too (the rooms
// keep their badge count there), but a room left open behind Chats isn't being read (audit 2026-11-13).
let roomOnScreen = false;
// Only messages arriving AFTER app launch may ping — backfilled history never notifies.
const broadcastSessionStartMs = Date.now();
/** A room message older than this when it arrives isn't rung (K 428a797b InAppBanner: 3 minutes). */
const ROOM_BANNER_MAX_AGE_MS = 3 * 60_000;
let messageCache = {}; // { [channel]: [{ txId, senderAddress, content, blockTime, status? }] }
// { [channel]: { byTarget: { [targetTxId]: { [reactorAddress]: { emoji, blockTime, removed? } } },
//                txIds: [processed reaction txids], lastEvent: { senderAddress, emoji, blockTime } | null } }
let reactionsCache = {};
let editsCache = {};
let roomDeletes = [];           // DELETES_KEY, oldest first
let roomDeleteSet = new Set();  // the same, for lookups
let activeChannel = null;
let pollTimer = null;
let sendInFlight = false;
let voiceRecorder = null;
let voiceRecordingChannel = null;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

// What has been read, per room and per wallet (iOS 83286b3): unread = messages from others since
// the marker; opening a room marks it read; a room seen for the first time counts from now.
const READ_KEY = "kachat-broadcast-read-v1";
let readMarkerByChannel = {};   // { [channel]: ms }
let markedUnread = {};          // { [channel]: true } - "Mark as Unread" with nothing new
function saveRead() {
  try { localStorage.setItem(deps.accountScopedKey(READ_KEY), JSON.stringify({ markers: readMarkerByChannel, unread: markedUnread })); } catch { /* fine */ }
}
function unreadFor(channel) {
  if (readMarkerByChannel[channel] == null) { readMarkerByChannel[channel] = Date.now(); saveRead(); }
  const marker = Number(readMarkerByChannel[channel]) || 0;
  const me = deps.engine.address || "";
  const hidden = hiddenIn(channel);
  let count = 0;
  const seenNotes = new Set(); // a long voice note's parts count once (KaPost 1b15521)
  for (const m of messageCache[channel] || []) {
    if (m.senderAddress === me || m.status) continue;
    if (hidden.has(m.senderAddress)) continue;
    if (deps.parseReactionEnvelope?.(m.content)) continue;
    if (Number(m.blockTime || 0) <= marker) continue;
    const before = seenNotes.size;
    const note = roomNoteKey(m);
    if (note) { seenNotes.add(note); if (seenNotes.size === before) continue; }
    count += 1;
  }
  if (count === 0 && markedUnread[channel]) return 1;
  return count;
}
function roomNoteKey(m) {
  const tag = typeof m.content === "string" && m.content.startsWith("{") ? VoiceNotes.sniffPartTag(m.content) : null;
  return tag ? `${tag.kind}|${String(m.senderAddress || "").toLowerCase()}|${tag.id}|${tag.count}` : null;
}
function markChannelRead(channel) {
  if (!channel) return;
  const before = unreadFor(channel);
  // Read up to the newest message shown, not this device's clock (KaPost 369794e): a message whose
  // block time lands after "now" on a clock running fast stayed read when it shouldn't, and one
  // that arrives later with an earlier block time counts. Never moves back; now for an empty room.
  let newest = 0;
  for (const m of messageCache[channel] || []) if (!m.status && Number(m.blockTime) > newest) newest = Number(m.blockTime);
  readMarkerByChannel[channel] = newest ? Math.max(newest, Number(readMarkerByChannel[channel]) || 0) : Math.max(Date.now(), Number(readMarkerByChannel[channel]) || 0);
  delete markedUnread[channel];
  saveRead();
  if (before > 0) deps.onUnreadChanged?.();
}

/** The rooms' share of the Chats badge (KaChat 148a5331 AppTabBadge .chats): unread in the listed
 *  rooms whose bell is on. */
export function broadcastNotifyingUnreadTotal() {
  if (!deps) return 0;
  let total = 0;
  for (const name of listedChannels()) if (notifyByChannel[name]) total += unreadFor(name);
  return total;
}
// --- Select mode (iOS e08c4cc): rooms picked in bulk for Mark as Read / Unread / Delete --------
/** "Delete" from the room list: the room is left, default rooms too (K 824a30bb, owner 2026-11-26).
 *  One the indexer keeps can be added again from Add Room. */
function removeFromList(name) {
  leaveChannel(name);
}
/** The rooms in the list: only the ones the person added (K 824a30bb: Public Chats starts empty;
 *  the featured rooms are no longer listed unjoined). A room an older build switched off is left out. */
function listedChannels() {
  return [...new Set(joinedChannels)].filter((name) => curatedShown(name) && !isServiceBroadcastChannel(name));
}
/** A room's place in the list (iOS 865c9ab PublicChatService.listedChannels sortKey): its newest
 *  message; a language room nobody has written in yet keeps its place in LANGUAGE_BROADCAST_CHANNELS,
 *  after every room with messages (they are all joined at the same moment, so their join times would
 *  order them at random); anything else by when it was joined. */
function roomActivityAt(name) {
  const latest = Number(lastVisibleMessage(name)?.blockTime || 0);
  if (latest) return latest;
  const languageIndex = LANGUAGE_BROADCAST_CHANNELS.indexOf(name);
  if (languageIndex >= 0) return -(languageIndex + 1);
  return Number(joinedAtByChannel[name] || 0);
}

// --- Rooms in the Chats list ---------------------------------------------------------------------
// On Desktop the rooms are rows in the Chats list, each with # for its avatar (owner, 2026-11-05;
// iOS a062577 has them as circles above it). The app draws them and owns their selection. These are
// the room facts and actions it needs.

/** The rooms in the list, each with what its circle shows: unread (messages from others since
 *  the room was last opened), latest activity (for the row's order), and the half sheet's state. */
export function chatListRooms() {
  if (!deps) return [];
  // The same rooms the Public Chats list shows - the featured ones plus every joined room - as
  // iOS ChatListView reads PublicChatService.listedChannels (no unjoined language rooms).
  return listedChannels().map((name) => ({
    name,
    unread: unreadFor(name),
    lastAt: roomActivityAt(name),
    lastMessageAt: Number(lastVisibleMessage(name)?.blockTime || 0),
    preview: roomPreviewLine(name),
    notify: Boolean(notifyByChannel[name]),
    indexed: isCuratedBroadcastChannel(name), // a default room (Add Room lists it)
    // the indexer keeps it, so the bell covers it with the room closed (iOS 21c480d)
    tracked: isIndexerTrackedBroadcastChannel(name),
    joined: joinedChannels.includes(name),
    open: name === activeChannel,
  }));
}
/** Opens a room in the detail pane (the app clears whatever chat or group had it first). */
export function openBroadcastRoom(name) {
  if (!deps) return;
  const clean = normalizeBroadcastChannel(name);
  if (!clean) return;
  openRoom(clean);
}
/** Closes the open room, if any - a chat or a group is taking the pane. */
export function closeBroadcastRoom() {
  if (deps && activeChannel) closeRoom();
}
/** Mark as Read / Unread for several rooms at once (the Chats Select bar, a circle's sheet). */
export function markBroadcastRooms(names, read) {
  if (!deps) return;
  for (const name of names) {
    if (read) markChannelRead(name);
    else markedUnread[name] = true;
  }
  if (!read) saveRead();
  renderChannelList();
}
/** Delete: every room is left with its messages on this device (K 824a30bb). */
export function removeBroadcastRooms(names) {
  if (!deps) return 0;
  const list = [...names];
  for (const name of list) removeFromList(name);
  renderChannelList();
  return list.length;
}
/** The room's notifications on or off, as the room's bell sets them. */
export function setBroadcastRoomNotify(name, on) {
  if (!deps) return;
  setBroadcastRoomsNotify([name], on);
  deps.showToast?.(!on
    ? "Notifications are off for this public chat"
    : (isIndexerTrackedBroadcastChannel(name)
      ? "You'll get notifications for new messages in this public chat, even when the app is closed"
      : "You'll get a notification for new messages in this public chat as long as your app remains open"));
}
/** Mute / Unmute for several rooms at once (the Chats Select bar; KaPosts-iPhone eec2e30): each
 *  room's bell as setBroadcastRoomNotify sets it, without its per-room toast - the bar says it once. */
export function setBroadcastRoomsNotify(names, on) {
  if (!deps) return;
  const list = [...names];
  for (const name of list) {
    if (on) notifyByChannel[name] = true;
    else delete notifyByChannel[name];
  }
  if (on && list.length) deps.ensureNotificationPermission?.();
  saveNotify();
  syncScanWanted();
  renderChannelList();
  if (activeChannel && list.includes(activeChannel)) syncRoomBell();
}
/** Copies the room's kachat.app link. */
export function copyBroadcastRoomLink(name) {
  if (!deps) return;
  copyRoomLink(name);
}

// Service rooms (the chess arena) are scanned while their screen is up, on top of whatever the
// rooms want; the chess module sets this and the block-hit rows for them go to it, not here.
let serviceScanWanted = [];
export function setServiceScanWanted(channels) {
  serviceScanWanted = Array.isArray(channels) ? channels.map((c) => normalizeBroadcastChannel(c)).filter(Boolean) : [];
  if (deps) syncScanWanted();
}

// Default (curated) rooms switched off in Public Chats settings (iOS d5c7613): gone from the
// list, never notifying, not counted. Per wallet.
const HIDDEN_CURATED_KEY = "kachat-broadcast-hidden-curated-v1";
let hiddenCurated = new Set();
function loadHiddenCurated() {
  try { hiddenCurated = new Set(JSON.parse(localStorage.getItem(deps.accountScopedKey(HIDDEN_CURATED_KEY)) || "[]") || []); }
  catch { hiddenCurated = new Set(); }
}
function curatedShown(name) { return !hiddenCurated.has(name); }
// Edit Default Public Chats is gone (K 824a30bb, owner 2026-11-26): nothing is added by default, so
// there's nothing to switch off. Rooms come from Add Room (addRoomChoices, joinBroadcastRoom).

/** Add Room's lists (K 824a30bb PublicRoomBrowserView): the featured rooms, then every room the
 *  indexer reports, then the language rooms (Other Languages), each with whether it's joined. */
export function addRoomChoices() {
  const joined = new Set(deps ? joinedChannels : []);
  const rooms = [...FEATURED_BROADCAST_CHANNELS];
  for (const name of indexerDefaultBroadcastChannels()) if (!rooms.includes(name)) rooms.push(name);
  return {
    rooms: rooms.map((name) => ({ name, joined: joined.has(name) })),
    languages: LANGUAGE_BROADCAST_CHANNELS.map((name) => ({ name, label: broadcastLanguageDisplayName(name), joined: joined.has(name) })),
  };
}
/** Add Room's Join: the room joins the list (bell on) without opening; false if it can't. */
export function joinBroadcastRoom(rawName) {
  if (!deps) return false;
  const name = replacementBroadcastChannel(rawName);
  if (broadcastJoinProblem(name)) return false;
  addJoinedChannel(name);
  renderChannelList();
  return true;
}
/** Add Room asks the indexer for its rooms within a minute (K: maxAge 60) and redraws when the list
 *  changes; returns the stop function. */
export function watchAddRoomChoices(redraw) {
  refreshIndexerTrackedRooms({ maxAgeMs: 60_000 }).catch(() => {});
  return onIndexerTrackedRoomsChange(redraw);
}

let cachesLoaded = false;
function loadState({ caches = true } = {}) {
  // A save still waiting must land before anything is read back, or the older stored copy
  // would replace messages that arrived in the last half second.
  if (cacheSaveTimer) { window.clearTimeout(cacheSaveTimer); cacheSaveTimer = 0; saveCacheNow(); }
  try {
    joinedChannels = JSON.parse(localStorage.getItem(deps.accountScopedKey(CHANNELS_KEY)) || "[]") || [];
  } catch { joinedChannels = []; }
  try {
    const read = JSON.parse(localStorage.getItem(deps.accountScopedKey(READ_KEY)) || "{}") || {};
    readMarkerByChannel = read.markers && typeof read.markers === "object" ? read.markers : {};
    markedUnread = read.unread && typeof read.unread === "object" ? read.unread : {};
  } catch { readMarkerByChannel = {}; markedUnread = {}; }
  try {
    hiddenByRoom = JSON.parse(localStorage.getItem(deps.accountScopedKey(HIDDEN_KEY)) || "{}") || {};
  } catch { hiddenByRoom = {}; }
  try {
    notifyByChannel = JSON.parse(localStorage.getItem(deps.accountScopedKey(NOTIFY_KEY)) || "{}") || {};
  } catch { notifyByChannel = {}; }
  // Rooms join with notifications OFF and stay off until the user turns a bell on - the
  // curated rooms included (iOS 1ea3c45). They used to be switched on once per wallet here.
  loadHiddenCurated();
  try {
    retentionByChannel = JSON.parse(localStorage.getItem(deps.accountScopedKey(RETENTION_KEY)) || "{}") || {};
  } catch { retentionByChannel = {}; }
  try {
    listenByChannel = JSON.parse(localStorage.getItem(deps.accountScopedKey(LISTEN_KEY)) || "{}") || {};
  } catch { listenByChannel = {}; }
  try {
    indexerByChannel = JSON.parse(localStorage.getItem(deps.accountScopedKey(INDEXER_KEY)) || "{}") || {};
  } catch { indexerByChannel = {}; }
  try {
    joinedAtByChannel = JSON.parse(localStorage.getItem(deps.accountScopedKey(JOINED_AT_KEY)) || "{}") || {};
  } catch { joinedAtByChannel = {}; }
  // Older installs stored retention as a day count (0 = forever). Days become milliseconds,
  // and everything is clamped to the three-day ceiling the app now has.
  for (const channel of Object.keys(retentionByChannel)) {
    const value = Number(retentionByChannel[channel] || 0);
    if (!Number.isFinite(value) || value <= 0) { delete retentionByChannel[channel]; continue; }
    const millis = value < 1000 ? value * 86_400_000 : value;
    retentionByChannel[channel] = Math.min(MAX_RETENTION_MS, millis);
  }
  // The message, reaction and edit caches are this module's own state: once read, the copy in
  // memory is the newer one. Re-reading them on every tab show cost a parse of every room.
  if (caches || !cachesLoaded) {
    try {
      messageCache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}") || {};
    } catch { messageCache = {}; }
    // One row per message id (iOS d0b819f): a cache written while a send's own row and the
    // chain's copy raced could hold the same txid twice. The first copy stays.
    for (const channel of Object.keys(messageCache)) {
      const ids = new Set();
      messageCache[channel] = (Array.isArray(messageCache[channel]) ? messageCache[channel] : []).filter((m) => {
        if (!m?.txId) return false;
        if (ids.has(m.txId)) return false;
        ids.add(m.txId);
        return true;
      });
    }
    try {
      reactionsCache = JSON.parse(localStorage.getItem(REACTIONS_KEY) || "{}") || {};
    } catch { reactionsCache = {}; }
    try {
      editsCache = JSON.parse(localStorage.getItem(EDITS_KEY) || "{}") || {};
    } catch { editsCache = {}; }
    try {
      const stored = JSON.parse(localStorage.getItem(DELETES_KEY) || "[]");
      roomDeletes = Array.isArray(stored) ? stored.filter((entry) => typeof entry === "string") : [];
    } catch { roomDeletes = []; }
    roomDeleteSet = roomDeleteLookupSet(roomDeletes); // held and unheld alike (audit 2026-11-25 #26)
    cachesLoaded = true;
  }
  // Every default room is in Public Chats from the start (iOS 865c9ab ensureDefaultChannelsJoined):
  // the two featured rooms always, and each language room unless it was switched off in Public
  // Chats settings. They join with notifications off, which is what keeps them cheap: the
  // closed-room sweep, the block scan and the push registration only cover rooms whose bell is
  // on. (Desktop used to leave the language rooms unjoined, behind an "Other Languages" row.)
  // Like iOS PublicChatStore (joinedAt = Date() when a room is first stored), an auto-joined
  // room is stamped too, so Room Info shows its "Joined" row.
  // A retired room's account is moved over once, before the defaults join (none retired now: K
  // ef760cfa brought #kachat-bugs back as a room of its own).
  moveRetiredChannels();
  joinDefaultRooms();
  silenceRoomsOnce();
  clearAutoAddedRoomsOnce();
  migrateCachedReactionRows();
  migrateCachedDeleteRows();
  pruneCache();
}

/** No room is joined for the person any more (K 824a30bb, owner 2026-11-26): Public Chats starts
 *  empty and fills only with rooms they add. What's left here: stamping a joined room's "Joined"
 *  time, and leaving any room the indexer dropped once its time is up (forgetDroppedDefaultRooms). */
function joinDefaultRooms() {
  let stamped = false;
  for (const name of joinedChannels) {
    if (!joinedAtByChannel[name]) { joinedAtByChannel[name] = Date.now(); stamped = true; }
  }
  if (stamped && deps?.engine?.address) { try { saveJoinedAt(); } catch {} }
  forgetDroppedDefaultRooms();
}

// The joined rooms the indexer's `/broadcast-channels` listed, per account (K 35b112ce
// kachat_rooms_indexer_listed_v1): once the indexer stops listing one, it's left, because nobody
// indexes it any more and its history and pushes would stop with no explanation. Any such room goes,
// even one the person joined by name or posted in (owner, 2026-11-26; until then only the rooms K
// joined for them, kachat-rooms-auto-joined-v1). A room off the list and not joined is forgotten, so
// joining it again later keeps it. A room the indexer never listed (your own, or one with its own
// indexer) stays, and the built-in rooms are never dropped, so they aren't kept here.
const INDEXER_LISTED_KEY = "kachat-rooms-indexer-listed-v1"; // account-scoped: ["room", ...]
/** Before K 35b112ce: only the rooms K joined for the person. Read once, into the new set. */
const LEGACY_AUTO_JOINED_KEY = "kachat-rooms-auto-joined-v1";
/** How long a room the indexer listed may be missing from its list before it's left: two of the
 *  hourly `/broadcast-channels` reads (K droppedAutoRoomGrace). */
export const DROPPED_AUTO_ROOM_GRACE_MS = 2 * 60 * 60 * 1000;
function readIndexerListed() {
  try {
    const list = JSON.parse(localStorage.getItem(deps.accountScopedKey(INDEXER_LISTED_KEY)) || "[]");
    return new Set(Array.isArray(list) ? list.filter((name) => typeof name === "string") : []);
  } catch { return new Set(); }
}
function updateIndexerListed(change) {
  if (!deps?.engine?.address) return;
  const before = readIndexerListed();
  const set = new Set(before);
  change(set);
  if (set.size === before.size && [...set].every((name) => before.has(name))) return;
  try { localStorage.setItem(deps.accountScopedKey(INDEXER_LISTED_KEY), JSON.stringify([...set].sort())); } catch { /* next load */ }
}
/** Adds the rooms on the indexer's list now; forgets ones off it that aren't joined (K
 *  noteIndexerListedRooms). */
function noteIndexerListedRooms(joined) {
  const listed = new Set(indexerDefaultBroadcastChannels());
  let legacy = [];
  try {
    const oldKey = deps.accountScopedKey(LEGACY_AUTO_JOINED_KEY);
    const raw = localStorage.getItem(oldKey);
    if (raw != null) {
      const list = JSON.parse(raw);
      legacy = Array.isArray(list) ? list.filter((name) => typeof name === "string") : [];
      localStorage.removeItem(oldKey);
    }
  } catch { legacy = []; }
  updateIndexerListed((set) => {
    for (const name of [...listed, ...legacy]) set.add(name);
    for (const name of [...set]) if (!listed.has(name) && !joined.has(name)) set.delete(name);
  });
}
const CURATED_BUILT_IN = new Set([...FEATURED_BROADCAST_CHANNELS, ...LANGUAGE_BROADCAST_CHANNELS]);

/** A room's data on this device goes, with no redraw (leaving a room, a retired or dropped room):
 *  its place in the list, its bell and settings, its cached messages, reactions and edits. */
function forgetRoom(name) {
  joinedChannels = joinedChannels.filter((c) => c !== name);
  saveChannels();
  delete messageCache[name];
  saveCache();
  delete reactionsCache[name];
  appliedRowsByChannel.delete(name); // rejoining must apply its reactions and edits again
  saveReactions();
  delete listenByChannel[name];
  saveListen();
  delete indexerByChannel[name];
  saveIndexerOverrides();
  delete joinedAtByChannel[name];
  saveJoinedAt();
  if (notifyByChannel[name]) { delete notifyByChannel[name]; saveNotify(); }
  // its edits and paging state go with it (KaPost 369794e: leaving a room deletes its data)
  delete editsCache[name];
  saveEdits();
  for (const key of [...failedRoomEdits.keys()]) if (String(key).startsWith(`${name}:`)) failedRoomEdits.delete(key);
  deepBackfilled.delete(name);
  deepBackfillFloor.delete(name);
  deepBackfillDone.delete(name);
  deepBackfillResume.delete(name);
  roomNewestSeen.delete(name);
}

function saveHiddenCurated() {
  try { localStorage.setItem(deps.accountScopedKey(HIDDEN_CURATED_KEY), JSON.stringify([...hiddenCurated])); } catch { /* fine */ }
}

// The retired default rooms this account has been moved off, once each (K 961fc05a
// moveRetiredChannels). Desktop never saved the featured rooms as joined (they are joined on every
// load), so "had the old room" can't be read from the joined list: every account had it.
const RETIRED_MOVED_KEY = "kachat-broadcast-retired-moved-v1"; // account-scoped: ["kachat-bugs", ...]

// Every room starts silenced (owner, 2026-11-25, K ef760cfa silenceRoomsOnceIfNeeded): the first time
// an account's rooms load on this build, every bell that's on goes off, including the #kaspa and
// #kachat-bugs bells older builds turned on by themselves. Once per account; after that the bells are
// whatever the person picks, kept across updates. Bump the key's version only to silence everyone again.
const ROOMS_SILENCED_ONCE_KEY = "kachat-rooms-silenced-once-v1"; // account-scoped: "1"
function silenceRoomsOnce() {
  if (!deps?.engine?.address) return;
  const key = deps.accountScopedKey(ROOMS_SILENCED_ONCE_KEY);
  try { if (localStorage.getItem(key)) return; } catch { return; }
  const ringing = Object.keys(notifyByChannel).filter((name) => notifyByChannel[name]);
  for (const name of ringing) delete notifyByChannel[name];
  if (ringing.length) saveNotify();
  try { localStorage.setItem(key, "1"); } catch { /* asked again next load */ }
  if (!ringing.length) return;
  deps.appendEngineLog?.(`Silenced ${ringing.length} public chat(s) once for this update`);
  // the push service stops sending these rooms (its registration lists the bell-on rooms)
  deps.onPushPreferencesChanged?.();
  syncScanWanted();
}

// Public Chats starts empty (K 824a30bb, owner 2026-11-26: nothing may feel added without the
// person's say). Once per account, the first load of this build leaves every room older builds joined
// for everyone (the featured and language rooms, the rooms the indexer lists now, rooms switched
// off) unless they showed they want it: a bell they turned on, or a pin. A room joined by name stays,
// unless the indexer lists that name now (K joined it for them anyway; the two can't be told apart).
// Runs after silenceRoomsOnce, so a bell an old build turned on by itself doesn't count.
const ROOMS_OPT_IN_KEY = "kachat-rooms-opt-in-v1"; // account-scoped: "1"
function clearAutoAddedRoomsOnce() {
  if (!deps?.engine?.address) return;
  const key = deps.accountScopedKey(ROOMS_OPT_IN_KEY);
  try { if (localStorage.getItem(key)) return; } catch { return; }
  let pins = [];
  try { pins = parseRoomPins(localStorage.getItem(deps.accountScopedKey(ROOM_PINS_KEY)) || "[]"); } catch { pins = []; }
  const switchedOff = new Set(hiddenCurated);
  const autoAdded = new Set([...curatedBroadcastChannels(), ...switchedOff]);
  const left = [];
  for (const name of [...joinedChannels]) {
    if (!autoAdded.has(name) || isServiceBroadcastChannel(name)) continue;
    const wanted = !switchedOff.has(name) && (Boolean(notifyByChannel[name]) || pins.includes(name));
    if (wanted) continue;
    if (activeChannel === name) activeChannel = null;
    forgetRoom(name);
    try { deps.onRoomRemoved?.(name); } catch { /* the app's pins */ }
    left.push(name);
  }
  hiddenCurated.clear();
  saveHiddenCurated();
  try { localStorage.setItem(key, "1"); } catch { /* asked again next load */ }
  if (!left.length) return;
  deps.appendEngineLog?.(`Public Chats starts empty: left ${left.length} room(s) K had added`);
  deps.onPushPreferencesChanged?.();
  syncScanWanted();
}

/** Moves this account off each retired default room, once: the new room gets the old one's bell
 *  (when it wasn't joined already), its pin in the Public Chats circles and its switched-off state;
 *  then the old room is left (its messages go from this device; they stay on chain). */
function moveRetiredChannels() {
  if (!deps?.engine?.address) return;
  const key = deps.accountScopedKey(RETIRED_MOVED_KEY);
  let moved;
  try { moved = JSON.parse(localStorage.getItem(key) || "[]"); } catch { moved = []; }
  if (!Array.isArray(moved)) moved = [];
  let changed = false;
  for (const [old, replacement] of Object.entries(RETIRED_BROADCAST_CHANNELS)) {
    if (moved.includes(old)) continue;
    moved.push(old);
    changed = true;
    const replacementJoined = joinedChannels.includes(replacement);
    if (hiddenCurated.has(old)) {
      hiddenCurated.delete(old);
      hiddenCurated.add(replacement);
      saveHiddenCurated();
    } else if (!replacementJoined) {
      joinedChannels.push(replacement);
      if (!joinedAtByChannel[replacement]) joinedAtByChannel[replacement] = Date.now();
      if (notifyByChannel[old]) { notifyByChannel[replacement] = true; saveNotify(); }
    }
    // its circle on the Public Chats page (the app's room pins, ui/room-pins.js)
    try {
      const pinsKey = deps.accountScopedKey(ROOM_PINS_KEY);
      const pins = parseRoomPins(localStorage.getItem(pinsKey) || "[]");
      const at = pins.indexOf(old);
      if (at >= 0) {
        if (pins.includes(replacement)) pins.splice(at, 1); else pins[at] = replacement;
        localStorage.setItem(pinsKey, JSON.stringify(pins));
      }
    } catch { /* pins are best-effort */ }
    if (readMarkerByChannel[old] != null || markedUnread[old]) { delete readMarkerByChannel[old]; delete markedUnread[old]; saveRead(); }
    if (activeChannel === old) activeChannel = null;
    forgetRoom(old);
  }
  if (changed) { try { localStorage.setItem(key, JSON.stringify(moved)); } catch { /* moved again next load: nothing left to move */ } }
}

// Since when each switched-off room has been missing from the default rooms, per account (K
// 961fc05a kachat_broadcast_hidden_missing_<wallet>).
const HIDDEN_MISSING_KEY = "kachat-broadcast-hidden-missing-v1"; // account-scoped: { [channel]: ms }

/** A switched-off room the indexer no longer reports: nothing would ever show it again (no switch
 *  for it any more), so it's left - once it has been missing for DROPPED_ROOM_GRACE_MS, so one short
 *  `/broadcast-channels` answer doesn't forget it was switched off (K 961fc05a). Any joined room the
 *  indexer listed and then dropped is left too, pin included, once it has been missing
 *  DROPPED_AUTO_ROOM_GRACE_MS (K 35b112ce): joined by name or posted in, it goes all the same. */
function forgetDroppedDefaultRooms(now = Date.now()) {
  if (!deps?.engine?.address) return;
  const curated = new Set(curatedBroadcastChannels());
  const absentHidden = new Set([...hiddenCurated].filter((name) => !curated.has(name)));
  const joined = new Set(joinedChannels);
  noteIndexerListedRooms(joined);
  const absentAuto = [...readIndexerListed()].filter((name) => joined.has(name) && !curated.has(name));
  const absent = [...new Set([...absentHidden, ...absentAuto])];
  const key = deps.accountScopedKey(HIDDEN_MISSING_KEY);
  let saved;
  try { saved = JSON.parse(localStorage.getItem(key) || "{}"); } catch { saved = {}; }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) saved = {};
  // back on the indexer's list, or switched on again: its clock stops
  const missing = {};
  for (const name of absent) missing[name] = Number(saved[name]) > 0 ? Number(saved[name]) : now;
  const dropped = Object.keys(missing).filter((name) =>
    now - missing[name] >= (absentHidden.has(name) ? DROPPED_ROOM_GRACE_MS : DROPPED_AUTO_ROOM_GRACE_MS));
  for (const name of dropped) delete missing[name];
  if (JSON.stringify(missing) !== JSON.stringify(saved)) {
    try {
      if (Object.keys(missing).length) localStorage.setItem(key, JSON.stringify(missing));
      else localStorage.removeItem(key);
    } catch { /* asked again next load */ }
  }
  if (!dropped.length) return;
  for (const name of dropped) hiddenCurated.delete(name);
  saveHiddenCurated();
  updateIndexerListed((set) => { for (const name of dropped) set.delete(name); });
  for (const name of dropped) {
    if (!joinedChannels.includes(name)) continue;
    deps.appendEngineLog?.(`#${name} left: the indexer no longer tracks it`);
    if (activeChannel === name) activeChannel = null;
    forgetRoom(name);
    try { deps.onRoomRemoved?.(name); } catch { /* the app's pins */ }
  }
}

// Every room starts silenced, bell off (K 8cb4c88e, owner 2026-11-24, for new installs): #kaspa and
// #kachat-bugs (#report-bugs since K 961fc05a) no longer get their bell switched on once per wallet (iOS 865c9ab
// applyDefaultNotificationsOnce, Desktop's applyDefaultBellsOnce, key
// kaposts_broadcast_default_bells, both removed). An account that already had those bells switched
// on keeps them: they are its own saved bells (NOTIFY_KEY) like any other, and nothing here turns them off.

/** Older caches stored reaction payload rows as normal messages — lift them into the
 *  reactions store so they never render as raw-JSON rows. */
function migrateCachedReactionRows() {
  let migrated = false;
  for (const channel of Object.keys(messageCache)) {
    const kept = [];
    for (const row of messageCache[channel] || []) {
      const reaction = deps.parseReactionEnvelope?.(row.content);
      if (reaction) {
        recordReaction(channel, row.txId, reaction, row.senderAddress || "", Number(row.blockTime) || 0);
        migrated = true;
      } else {
        kept.push(row);
      }
    }
    messageCache[channel] = kept;
  }
  if (migrated) { saveCache(); saveReactions(); }
}

/** A delete for everyone that reached a cache before this build stored it as a message (its JSON
 *  showed as text): it comes out of the rows and is applied (K e4062188). */
function migrateCachedDeleteRows() {
  for (const channel of Object.keys(messageCache)) {
    const rows = messageCache[channel] || [];
    if (!rows.some((row) => parseRoomDelete(row?.content))) continue;
    messageCache[channel] = rows.filter((row) => !parseRoomDelete(row?.content));
    applyRoomDeletes(channel, rows.flatMap((row) => {
      const del = parseRoomDelete(row?.content);
      return del ? [{ target: del.targetTxId, sender: row.senderAddress || "" }] : [];
    }));
    saveCache();
  }
}

function saveChannels() {
  setSettingItem(deps.accountScopedKey(CHANNELS_KEY), JSON.stringify(joinedChannels)); // never throws: a full storage gives the room cache back first (audit 2026-11-25 #11)
  deps.onPushPreferencesChanged?.();
}

// Hidden senders and the bells are part of what the push service is told (broadcastPushWatch).
function saveHidden() {
  setSettingItem(deps.accountScopedKey(HIDDEN_KEY), JSON.stringify(hiddenByRoom));
  deps.onPushPreferencesChanged?.();
}

function saveNotify() {
  setSettingItem(deps.accountScopedKey(NOTIFY_KEY), JSON.stringify(notifyByChannel));
  deps.onPushPreferencesChanged?.();
}

/** What the push service needs for closed-app room notifications (iOS
 *  collectWatchedPublicChatChannels / collectHiddenPublicChatSenders): the indexer-tracked rooms
 *  whose bell is on, and per room the senders hidden there. */
export function broadcastPushWatch() {
  if (!deps) return { channels: [], hidden: {} };
  const channels = joinedChannels
    .filter((name) => notifyByChannel[name] && isIndexerTrackedBroadcastChannel(name) && curatedShown(name))
    .sort();
  const hidden = {};
  for (const name of channels) {
    const list = [...hiddenIn(name)];
    if (list.length) hidden[name] = list.sort();
  }
  return { channels, hidden };
}
/** The room on screen, if any (the push worker keeps quiet for it while the app is in front). */
export function activeBroadcastChannelName() { return activeChannel || null; }

function saveListen() {
  setSettingItem(deps.accountScopedKey(LISTEN_KEY), JSON.stringify(listenByChannel));
}

function saveIndexerOverrides() {
  setSettingItem(deps.accountScopedKey(INDEXER_KEY), JSON.stringify(indexerByChannel));
}

function saveJoinedAt() {
  setSettingItem(deps.accountScopedKey(JOINED_AT_KEY), JSON.stringify(joinedAtByChannel));
}

function indexerOverrideFor(channel) {
  return String(indexerByChannel[channel] || "").trim();
}
/** The indexer a room reads from: its own, else the app-wide one. */
function roomIndexerBase(channel) {
  return indexerOverrideFor(channel) || String(getEndpoint("broadcastIndexer") || "").trim();
}

function retentionMillisFor(channel) {
  const stored = Number(retentionByChannel[channel] || 0);
  return stored > 0 ? Math.min(MAX_RETENTION_MS, stored) : DEFAULT_RETENTION_MS;
}

// The share text and links for a room (iOS KaChatInternalLink.broadcastRoomShareText): one human
// line, then BOTH accepted link forms.
function roomShareLink(channel) {
  return `https://${LINK_HOST}/broadcast/${encodeURIComponent(normalizeBroadcastChannel(channel))}`;
}
function roomShareText(channel) {
  const name = normalizeBroadcastChannel(channel);
  // One human line and the kachat.app link (iOS 688a02e): a bare kachat:// line previews nowhere.
  return `Join #${name} on KaChat.\n\n${roomShareLink(name)}`;
}

// ---------------------------------------------------------------------------
// Live block scanning (custom rooms)
//
// The broadcast indexer only tracks the curated rooms, so a user-created room has no
// history anywhere: its only delivery path is watching the chain live. The engine
// subscribes to the node's block-added notifications and hands back rows in the exact
// shape `fetchBroadcastHistory` returns, so both paths land in `mergeMessages` and dedupe
// by txId against the same cache. Live only, by construction - nothing backfills.
// ---------------------------------------------------------------------------

/** True for a room the user asked to keep listening to with its screen closed. */
// The bell is the one control (iOS ac34790): a room with notifications on is listened to while
// the app is open, which is what lets it notify and count unread. The separate "listen" switch
// is gone; a value stored by an older build is no longer read.
function alwaysListening(channel) {
  return Boolean(notifyByChannel[channel]) && !isIndexerTrackedBroadcastChannel(channel);
}

/**
 * The rooms that justify the block stream right now - iOS `BroadcastService.wantedChannels`:
 * the room whose screen is open, plus every always-listen room. Nothing else, so an idle app
 * does no block work at all.
 *
 * Indexer-backed rooms are then dropped, because they already have a service watching the
 * chain 24/7 plus an 8s poll while open: streaming every block for them would be pure
 * duplicate cost. If the user clears the broadcast indexer, they stay in - then the block
 * stream is their only live path too.
 */
function scanWantedChannels() {
  const wanted = new Set();
  if (tabVisible && activeChannel) wanted.add(activeChannel);
  for (const channel of Object.keys(notifyByChannel)) {
    if (alwaysListening(channel) && joinedChannels.includes(channel)) wanted.add(channel);
  }
  if (hasBroadcastIndexer()) {
    for (const channel of [...wanted]) {
      // An indexer that isn't answering covers nothing: its rooms keep the stream (iOS ee5ec98).
      if (isIndexerTrackedBroadcastChannel(channel) && !isIndexerDown(roomIndexerBase(channel))) wanted.delete(channel);
    }
  }
  for (const channel of serviceScanWanted) wanted.add(channel);
  return [...wanted];
}

/** Pushes the wanted set to the engine. Idempotent - the engine only starts/stops the
 *  subscription when the set actually changes between empty and non-empty. */
function syncScanWanted() {
  if (!deps?.engine?.setBroadcastScanChannels) return;
  try { deps.engine.setBroadcastScanChannels(scanWantedChannels()); }
  catch (error) { deps.appendEngineLog?.(`Broadcast live scan update failed: ${error.message}`); }
}

/** Live hits from the block stream, already filtered to the wanted rooms by the engine.
 *  Straight into `mergeMessages` — same store, same txId dedupe, same retention, same
 *  render as the indexer rows. */
function handleBroadcastBlockHits(hits) {
  const byChannel = new Map();
  for (const hit of hits || []) {
    const channel = normalizeBroadcastChannel(hit?.channel);
    if (!channel || !hit?.txId || isServiceBroadcastChannel(channel)) continue;
    // Deliberately NOT filtering hidden senders here: the indexer path stores them and
    // filters at render time, so unhiding a user brings their messages back. Both paths must
    // leave the store in the same state, so this one stores them too.
    if (!byChannel.has(channel)) byChannel.set(channel, []);
    byChannel.get(channel).push(hit);
  }
  let touched = false;
  for (const [channel, rows] of byChannel) {
    // engine-verified senders, so their deletes count at once (audit 2026-11-25 #22)
    if (mergeMessages(channel, rows, { live: true }) > 0) {
      touched = true;
      if (activeChannel === channel) renderRoom();
    }
  }
  if (touched) renderChannelList();
}

/** Effective retention cutoff for a channel: every room the indexer tracks (the curated rooms,
 *  and any the operator added on the indexer, iOS 21c480d) keeps the indexer's full 30 days,
 *  matching iOS; own channels use their configured retention, at most three days. */
function retentionCutoffMs(channel) {
  if (isIndexerTrackedBroadcastChannel(channel)) return Date.now() - BROADCAST_RETENTION_MS;
  return Date.now() - retentionMillisFor(channel);
}

// One JSON pass a beat after the last change (and on page hide), not one per merged page
// or live block hit: the cache holds every indexed room's 30 days.
let cacheSaveTimer = 0;
function saveCache() {
  if (cacheSaveTimer) return;
  cacheSaveTimer = window.setTimeout(() => { cacheSaveTimer = 0; saveCacheNow(); }, 500);
}
window.addEventListener("pagehide", () => { if (cacheSaveTimer) { window.clearTimeout(cacheSaveTimer); cacheSaveTimer = 0; saveCacheNow(); } });
// The stored copy is bounded (audit 2026-11-25 #11, ui/room-cache-budget.js): long plain text kept
// as its start, a cap per room and in all; the copy in memory stays whole. On a quota error the old
// copy is removed first (it is what fills the storage), then half the budget is tried; failing that
// nothing is stored and the indexer refills the rooms next time. The settings writes
// (setSettingItem) can take the stored copy back too, so a block or a joined room is never lost to it.
function saveCacheNow() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(roomCacheForStorage(messageCache))); }
  catch {
    try { localStorage.removeItem(CACHE_KEY); } catch { /* nothing to free */ }
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(roomCacheForStorage(messageCache, { budget: 0.5 }))); }
    catch { /* still over quota: the in-memory copy carries on, unstored */ }
  }
}
onSettingsStorageFull(() => { localStorage.removeItem(CACHE_KEY); });

// A quota error keeps the copy in memory (audit 2026-11-25 #24): emptying it lost every room's
// reactions for the session, though they are still right; they are stored again on the next change.
function saveReactions() {
  try { localStorage.setItem(REACTIONS_KEY, JSON.stringify(reactionsCache)); }
  catch { /* kept in memory, stored on a later change */ }
}

/** Rolling retention, matching the indexed rooms' product rule. */
function pruneCache() {
  // Per-channel retention (iOS parity): indexed rooms fixed 30-day, own channels use their
  // configured retention (0 = keep forever).
  for (const channel of Object.keys(messageCache)) {
    const cutoff = retentionCutoffMs(channel);
    if (!cutoff) continue;
    messageCache[channel] = (messageCache[channel] || []).filter((m) => (m.blockTime || 0) >= cutoff);
    if (messageCache[channel].length === 0) delete messageCache[channel];
  }
  for (const channel of Object.keys(reactionsCache)) {
    const cutoff = retentionCutoffMs(channel);
    const entry = reactionsCache[channel] || {};
    if (cutoff) {
      for (const targetTxId of Object.keys(entry.byTarget || {})) {
        const perReactor = entry.byTarget[targetTxId];
        for (const reactor of Object.keys(perReactor)) {
          if (Number(perReactor[reactor]?.blockTime || 0) < cutoff) delete perReactor[reactor];
        }
        if (Object.keys(perReactor).length === 0) delete entry.byTarget[targetTxId];
      }
      if (entry.lastEvent && Number(entry.lastEvent.blockTime || 0) < cutoff) entry.lastEvent = null;
    }
    if (Array.isArray(entry.txIds) && entry.txIds.length > 500) entry.txIds = entry.txIds.slice(-500);
    if (Object.keys(entry.byTarget || {}).length === 0 && !entry.lastEvent) delete reactionsCache[channel];
  }
  // Edits go with their messages (audit 2026-11-25 #23): none kept for a message no longer held or
  // past the room's retention.
  if (pruneRoomEdits(editsCache, messageCache, retentionCutoffMs)) saveEdits();
}

// Blocked accounts are hidden in every room (KaPosts-iPhone 9e22075 PublicChatStore.blockedSenders).
// They are not rows in hiddenByRoom: Room Info's Hidden Users lists that room's own hides, and a
// block is undone under Blocked in KaPost's menu.
function hiddenIn(channel) {
  return roomHiddenSenders(hiddenByRoom[channel], deps?.blockedAccounts?.());
}

/** The blocked list changed (a block, or an undo in KaPost's menu): they leave or come back to every
 *  room, and the push service is told (broadcastPushWatch). */
export function broadcastBlockedAccountsChanged() {
  if (!deps) return;
  try { renderChannelList(); } catch { /* list not mounted */ }
  if (activeChannel) { try { renderRoom(); } catch { /* room not mounted */ } }
  deps.onUnreadChanged?.();
  deps.onPushPreferencesChanged?.();
}

// ---------------------------------------------------------------------------
// Reactions store (mirrors app.js's reactionsByTxId semantics, per channel)
// ---------------------------------------------------------------------------

function reactionsFor(channel) {
  return reactionsCache[channel]?.byTarget || {};
}
/** The reactions a bubble shows: its own, and - for a voice note's bubble - those made on any of
 *  its hidden parts, once per reactor (KaPost 369794e: reactions and replies on hidden parts go to
 *  the bubble). The bubble's own reaction wins over a part's. */
function reactionsOn(channel, txId) {
  const byTarget = reactionsFor(channel);
  const cluster = roomParts.clusters.get(txId);
  const merged = { ...(byTarget[txId] || {}) };
  for (const member of cluster?.members || []) {
    if (member.txId === txId) continue;
    for (const [reactor, reaction] of Object.entries(byTarget[member.txId] || {})) {
      if (!(reactor in merged)) merged[reactor] = reaction;
    }
  }
  // Someone you blocked or hid here doesn't show up on a pill either (K 428a797b, audit #22).
  const hidden = hiddenIn(channel);
  for (const reactor of Object.keys(merged)) if (hidden.has(reactor)) delete merged[reactor];
  return merged;
}

// Edits (MESSAGING.md "Message Edits", iOS a55b79a): a plaintext broadcast row like a reaction,
// applied on the scan, indexer-page and sweep paths (all through mergeMessages). Newest by
// block time wins; the editor is checked against the message's sender when the text is read.
function saveEdits() {
  try { localStorage.setItem(EDITS_KEY, JSON.stringify(editsCache)); } catch { /* fine */ }
}
function recordEdit(channel, txId, edit, editorAddress, blockTime, status = null) {
  return recordRoomEdit((editsCache[channel] ||= {}), txId, edit, editorAddress, blockTime, status);
}
/** A room message's content with its edit applied - when the editor is the message's sender. */
function effectiveContent(channel, m) {
  const edit = editFor(channel, m);
  if (!edit) return m?.content ?? "";
  if (!deps.isEditableContent?.(m.content)) return m.content ?? "";
  return deps.applyEditToContent?.(edit.text, m.content) ?? edit.text;
}
function editFor(channel, m) {
  const edit = editsCache[channel]?.[m?.txId];
  // A failed edit (only an older build left one) never reached the chain (iOS ee5ec98).
  return edit && edit.editor === m.senderAddress && edit.status !== "failed" ? edit : null;
}

// Deletes for everyone (K e4062188 MessageDeleteCodec, MESSAGING.md "Public Chat Deletes"): a room
// message {"type":"delete","targetTxId":...} from the target's own sender takes it away, with its
// reactions and edits, and is remembered as room|txid|sender so no page or block brings it back.
// Never in the machinery rooms (chess, bots, arcade), never a row, banner or push of its own.
function saveRoomDeletes() {
  try { localStorage.setItem(DELETES_KEY, JSON.stringify(roomDeletes)); } catch { /* fine */ }
}
/** `held`: the target was here when the delete came. Deletes for targets not held are kept on a
 *  smaller budget of their own, so a flood of them can't push real ones out (audit 2026-11-25 #26). */
function recordRoomDelete(channel, txId, sender, held = true) {
  const next = addRoomDelete(roomDeletes, channel, txId, sender, undefined, { held });
  if (!next) return false;
  roomDeletes = next;
  roomDeleteSet = roomDeleteLookupSet(next);
  saveRoomDeletes();
  return true;
}
function isRoomDeleted(channel, txId, sender) {
  return roomDeleteSet.size > 0 && roomDeleteSet.has(roomDeleteEntry(channel, txId, sender));
}
/** Takes these messages out of a room's rows (`rows`, changed in place), with the reactions on
 *  them and their edits (K PublicChatStore.deleteMessages). Returns how many rows went. */
function removeRoomRows(channel, rows, ids) {
  const wanted = new Set([...ids].map((id) => String(id).toLowerCase()));
  if (!wanted.size) return 0;
  let removed = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (wanted.has(String(rows[i]?.txId || "").toLowerCase())) { rows.splice(i, 1); removed += 1; }
  }
  const byTarget = reactionsCache[channel]?.byTarget;
  let reactionsGone = false;
  for (const target of Object.keys(byTarget || {})) {
    if (wanted.has(target.toLowerCase())) { delete byTarget[target]; reactionsGone = true; }
  }
  if (reactionsGone) saveReactions();
  const edits = editsCache[channel];
  let editsGone = false;
  for (const target of Object.keys(edits || {})) {
    if (wanted.has(target.toLowerCase())) { delete edits[target]; editsGone = true; }
  }
  if (editsGone) saveEdits();
  return removed;
}
/** Delete envelopes seen in a room, [{ target, sender }] (K applyIncomingDeletes). Returns how many
 *  held rows went. */
function applyRoomDeletes(channel, deletes, senderOf = null) {
  if (!deletes?.length || isServiceBroadcastChannel(channel)) return 0;
  const rows = (messageCache[channel] ||= []);
  const lookup = senderOf || ((txId) => {
    const hit = rows.find((m) => String(m.txId).toLowerCase() === String(txId).toLowerCase());
    return hit ? String(hit.senderAddress || "") : null;
  });
  const { gone, record } = resolveRoomDeletes(deletes, lookup);
  for (const { target, sender, held } of record) recordRoomDelete(channel, target, sender, held !== false);
  if (activeChannel === channel && broadcastReplyTarget && gone.has(broadcastReplyTarget.txId)) cancelBroadcastReply();
  return gone.size ? removeRoomRows(channel, rows, gone) : 0;
}

/** Applies one reaction event. Newest-wins per (targetTxId, reactor); a "remove" is kept as
 *  a tombstone so an older "add" seen again on a later poll can't resurrect the reaction.
 *  Dedupes by reaction txId (pass null for optimistic local applies). Returns true if the
 *  store changed. */
function recordReaction(channel, txId, reaction, reactorAddress, blockTime) {
  if (!reactorAddress) return false;
  const entry = (reactionsCache[channel] ||= { byTarget: {}, txIds: [], lastEvent: null });
  entry.txIds ||= [];
  entry.byTarget ||= {};
  if (txId && entry.txIds.includes(txId)) return false;
  if (txId) entry.txIds.push(txId);
  const perReactor = (entry.byTarget[reaction.targetTxId] ||= {});
  const existing = perReactor[reactorAddress];
  if (!existing || Number(existing.blockTime || 0) <= blockTime) {
    perReactor[reactorAddress] = {
      emoji: reaction.emoji,
      blockTime,
      ...(reaction.action === "remove" ? { removed: true } : {}),
    };
  }
  // Drives the channel list's "Reacted <emoji>" preview line. A remove clears the
  // event rather than advertising an undone reaction (same idea as 1:1's
  // lastReactionEvent handling).
  if (reaction.action === "remove") {
    if (entry.lastEvent && entry.lastEvent.senderAddress === reactorAddress && entry.lastEvent.emoji === reaction.emoji) {
      entry.lastEvent = null;
    }
  } else if (!entry.lastEvent || blockTime >= Number(entry.lastEvent.blockTime || 0)) {
    entry.lastEvent = { senderAddress: reactorAddress, emoji: reaction.emoji, blockTime };
  }
  return true;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

let listRenderSuppressed = false;
// Reaction and edit rows already applied this session, per channel (iOS 4cb565f): the 8 s poll
// re-serves the newest rows, and reapplying them, though idempotent, is work for nothing.
const appliedRowsByChannel = new Map();
function appliedRowsFor(channel) {
  let set = appliedRowsByChannel.get(channel);
  if (!set) { set = new Set(); appliedRowsByChannel.set(channel, set); }
  if (set.size > 5000) set.clear();
  return set;
}
/**
 * Sender check for every row entering the store (audit DSK-045). Live block-stream rows are
 * already verified by the engine (input 0's address, accepted only as a self-send), so they
 * pass unchanged. Indexer rows (`/get-broadcasts`) carry only the indexer's own guess of the
 * sender - no inputs, no outputs, nothing to check it against here - so they are still shown
 * as the indexer names them, as before: fixing the indexer's sender pick is out of scope for
 * this client. The one thing done here is to apply a verdict the engine already reached for the
 * same txid: a post it proved forged is dropped, a verified one shows its verified sender.
 * When the engine also holds the chain's own copy (a live block, our own send, a checked lookup),
 * a row whose room or text differs from it is dropped and the chain's block time is used (audit
 * 2026-11-25 #9). Rows already stored (`stored`) skip that check: only their time can change.
 * (The chess arena verifies its indexer rows in full; see ui/chess-tournaments.js.)
 */
function withKnownSenderVerdicts(rows, channel = "", stored = null) {
  const out = [];
  for (const row of rows || []) {
    const known = row?.txId ? deps.engine?.broadcastSenderVerdict?.(row.txId) : null;
    if (!known) { out.push(row); continue; }
    if (known.verdict !== "verified") continue;
    let next = known.senderAddress === row.senderAddress ? row : { ...row, senderAddress: known.senderAddress };
    if (known.digest) {
      if (!stored?.has(row.txId)
        && ((channel && known.channel !== channel) || known.digest !== broadcastContentDigest(known.channel, row.content))) continue;
      if (known.blockTime > 0 && Number(next.blockTime) !== known.blockTime) next = { ...next, blockTime: known.blockTime };
    }
    out.push(next);
  }
  return out;
}

/** `live`: rows from the block stream, whose senders the engine verified. Indexer rows are the
 *  indexer's word: deletes among them are applied straight away only from the app-wide indexer;
 *  from a room's own (Room Info) indexer they are proved against the chain first (proveRoomDeletes,
 *  audit 2026-11-25 #22), since the delete record is shared by every account here. */
function mergeMessages(channel, rows, { live = false } = {}) {
  const deletesTrusted = live || !indexerOverrideFor(channel);
  const unprovenDeletes = [];
  // the room's own array, so a delete in this batch can take a row this batch just added
  const existing = (messageCache[channel] ||= []);
  const seen = new Set(existing.map((m) => m.txId));
  const truncatedIds = new Set(existing.filter((m) => m.truncated).map((m) => m.txId));
  const applied = appliedRowsFor(channel);
  let added = 0;
  let removed = 0;
  let reactionsChanged = false;
  const freshIncoming = [];
  // Oldest first, so an edit in this page can see the message it targets; the indexer pages
  // newest-first. The sender of a target is looked up in what is stored or in this page.
  const ordered = withKnownSenderVerdicts(rows, channel, seen).sort((a, b) => (Number(a?.blockTime) || 0) - (Number(b?.blockTime) || 0));
  const senderOf = (txId) => {
    const hit = existing.find((m) => m.txId === txId) || ordered.find((r) => r?.txId === txId);
    return hit ? String(hit.senderAddress || "") : null;
  };
  for (const row of ordered) {
    if (!row?.txId) continue;
    if (seen.has(row.txId)) {
      // A send left "Not confirmed" whose copy came back did go out (iOS 33095ac).
      if (settleRoomCopy(existing, row.txId, row.blockTime)) added += 1;
      // A row stored cut to its start gets its full text back (audit 2026-11-25 #11).
      if (truncatedIds.has(row.txId) && restoreTruncatedRow(existing.find((m) => m.txId === row.txId), row)) added += 1;
      continue;
    }
    if (applied.has(row.txId)) continue;
    // A delete for everyone is never a row: it takes its target away when its own sender sent it
    // (K e4062188 applyIncomingDeletes), from every sender here, hidden ones too.
    const deletion = parseRoomDelete(row.content);
    if (deletion && !deletesTrusted) { unprovenDeletes.push(row); continue; }
    if (deletion) {
      applied.add(row.txId);
      removed += applyRoomDeletes(channel, [{ target: deletion.targetTxId, sender: row.senderAddress || "" }], senderOf);
      continue;
    }
    // never a message its sender deleted for everyone
    if (isRoomDeleted(channel, row.txId, row.senderAddress)) { applied.add(row.txId); continue; }
    seen.add(row.txId);
    const blockTime = Number(row.blockTime) || Date.now();
    // Reactions ride the same wire as normal messages but never become message
    // rows — they only update the per-channel reactions store (same as 1:1).
    const reaction = deps.parseReactionEnvelope?.(row.content);
    if (reaction) {
      if (recordReaction(channel, row.txId, reaction, row.senderAddress || "", blockTime)) reactionsChanged = true;
      applied.add(row.txId);
      continue;
    }
    const edit = deps.parseEditEnvelope?.(row.content);
    if (edit) {
      // Only the message's own sender may edit it (iOS PublicChatService): anyone else's
      // "edit" is dropped before it can shadow the real one.
      const targetSender = senderOf(edit.targetTxId);
      if (targetSender !== null && targetSender === String(row.senderAddress || "")) {
        if (recordEdit(channel, row.txId, edit, row.senderAddress || "", blockTime)) { saveEdits(); added += 1; }
        applied.add(row.txId);
      }
      // An edit met before its target is not remembered, so it is retried once the target lands.
      continue;
    }
    // Our own just-sent message can come back from the chain BEFORE `sendBroadcastText`
    // rewrites its optimistic bubble from `pending-...` to the real txid — the live block
    // scan is fast enough to win that race where the 8s indexer poll never did. Resolve the
    // pending bubble in place instead of adding a second row for the same message (the later
    // rewrite then finds no pending row and is a no-op).
    if ((row.senderAddress || "") === deps.engine.address) {
      const pending = existing.find((m) =>
        (m.status === "pending" || (m.status === ROOM_UNCONFIRMED && String(m.txId).startsWith("pending-")))
        && m.senderAddress === deps.engine.address
        && m.content === (row.content ?? ""));
      if (pending) {
        pending.txId = row.txId;
        pending.blockTime = blockTime;
        delete pending.status;
        added += 1;
        continue;
      }
    }
    existing.push({
      txId: row.txId,
      senderAddress: row.senderAddress || "",
      content: row.content ?? "",
      blockTime,
    });
    added += 1;
    if ((row.senderAddress || "") !== deps.engine.address) {
      freshIncoming.push({ channel, senderAddress: row.senderAddress || "", content: row.content ?? "", txId: row.txId, blockTime });
    }
  }
  existing.sort((a, b) => a.blockTime - b.blockTime);
  messageCache[channel] = existing;
  if (added > 0 || removed > 0) saveCache();
  if (added > 0 || removed > 0) {
    if (channel === activeChannel && tabVisible && roomOnScreen && !document.hidden) markChannelRead(channel);
    if (!listRenderSuppressed) { try { renderChannelList(); } catch { /* list not mounted */ } }
  }
  if (reactionsChanged) saveReactions();
  // A default room switched off in settings stays silent everywhere, the bell included.
  if (!curatedShown(channel)) freshIncoming.length = 0;
  recordRoomMentions(channel, freshIncoming);
  if (freshIncoming.length) deps.onIncomingBroadcast?.(freshIncoming);
  // The per-channel bell (iOS parity): OS pings for LIVE messages in notify-enabled channels
  // you're not currently reading, never from a sender hidden in that room (iOS
  // PublicChatService.notifyIfEnabled). Capped so one poll can't fire a burst.
  const hiddenHere = hiddenIn(channel);
  // One ring per long voice note: against the rows the room had before this batch, and only the
  // first part of a note within the batch (parts often arrive together in one poll).
  const freshTxIds = new Set(freshIncoming.map((row) => row.txId));
  const before = (messageCache[channel] || []).filter((row) => !freshTxIds.has(row.txId));
  const notesThisBatch = new Set();
  const firstOfNote = (row) => {
    const note = roomNoteKey(row);
    if (!note) return true;
    if (notesThisBatch.has(note)) return false;
    notesThisBatch.add(note);
    return !isLaterPart(row, before, ROOM_PART_ACCESSORS);
  };
  const pingable = freshIncoming.filter((row) =>
    notifyByChannel[row.channel]
    // The room you are reading stays quiet only while the app is in front (iOS isViewing + active).
    && (row.channel !== activeChannel || !roomOnScreen || document.hidden || !document.hasFocus())
    && !hiddenHere.has(row.senderAddress)
    && Number(row.blockTime || 0) >= broadcastSessionStartMs
    // Only news: a message more than three minutes old when it arrives (a catch-up after the app
    // slept) is listed, not rung (K 428a797b InAppBanner).
    && Date.now() - Number(row.blockTime || 0) <= ROOM_BANNER_MAX_AGE_MS
    // A later part of a long voice note isn't news of its own (KaChat's one ring per note).
    && firstOfNote(row));
  // One per message (K 428a797b), no longer the first three of a poll.
  for (const row of pingable) {
    deps.postDesktopNotification?.({
      // Title the room, body the message preview alone (iOS: "#room" over previewText).
      title: `#${row.channel}`,
      body: stripBidiControls(humanizeBroadcastContent(row.content)).slice(0, 90),
      tag: `kachat-broadcast-${row.txId}`,
      key: row.txId, // its push's tx_id: none if that push already came (K b0f0a4e6)
      // Clicking it opens the room (the app routes "room" to the detail pane).
      route: { kind: "room", channel: row.channel },
      onClick: () => deps.openRoomFromNotification?.(row.channel),
    });
  }
  if (unprovenDeletes.length) proveRoomDeletes(channel, unprovenDeletes);
  return added + removed + (reactionsChanged ? 1 : 0);
}

/**
 * Deletes served by a room's own (Room Info) indexer (audit 2026-11-25 #22). That indexer is one
 * account's choice, but the delete record is shared by every account here, so its word that a
 * delete came from the target's sender isn't enough: the engine checks each against the chain
 * (sender, room and text, verifyBroadcastRows) and only the proven ones are applied and recorded.
 * Forged ones are not asked about again this session; unanswered ones are, on a later read.
 */
const provingRoomDeletes = new Set();
async function proveRoomDeletes(channel, rows) {
  if (isServiceBroadcastChannel(channel) || typeof deps?.engine?.verifyBroadcastRows !== "function") return;
  const ask = rows.filter((row) => !provingRoomDeletes.has(row.txId));
  if (!ask.length) return;
  for (const row of ask) provingRoomDeletes.add(row.txId);
  try {
    const { accepted = [], forged = [] } = await deps.engine.verifyBroadcastRows(ask, { channel });
    const applied = appliedRowsFor(channel);
    for (const row of forged) applied.add(row.txId);
    const deletes = [];
    for (const row of accepted) {
      // the chain's text: a row the indexer passed off as a delete may be none
      const deletion = parseRoomDelete(row.content);
      if (!deletion) continue;
      applied.add(row.txId);
      deletes.push({ target: deletion.targetTxId, sender: row.senderAddress || "" });
    }
    if (deletes.length && applyRoomDeletes(channel, deletes) > 0) {
      saveCache();
      if (activeChannel === channel) { try { renderRoom(); } catch { /* room not mounted */ } }
      try { renderChannelList(); } catch { /* list not mounted */ }
    }
  } catch { /* asked again on a later read */ }
  finally { for (const row of ask) provingRoomDeletes.delete(row.txId); }
}

// Channels that already did the full historical page-back this session — the 8s poll
// afterwards only needs the newest page.
const deepBackfilled = new Set();
// Oldest a room's next backfill needs to reach after an outage (ms): the indexer gets the last word
// on that stretch, without paging its whole history again (iOS ee5ec98).
const deepBackfillFloor = new Map();
// The newest block time the indexer has shown for each room this session. A steady poll whose whole
// page is newer than this has a gap behind it (iOS ee5ec98).
const roomNewestSeen = new Map();
function noteRoomNewest(channel, rows) {
  const newest = (rows || []).reduce((max, row) => Math.max(max, Number(row?.blockTime) || 0), 0);
  if (newest) roomNewestSeen.set(channel, Math.max(newest, roomNewestSeen.get(channel) || 0));
}
// How many reads in a row each cached room message ("room|txid") was missing from (K absenceStrikes).
const absenceStrikes = new Map();
// Rooms whose next indexer read removes a missing message on the first miss (K d089011f
// firstMissRemovesChannels): a room just opened, and the Rooms list's check. The reader is looking
// at it now, and a deleted message mustn't sit there until the next read.
const firstMissRemovesChannels = new Set();
/** For a room the indexer tracks, the indexer is the truth (K d089011f "work like KaPost",
 *  dropRowsTheIndexerNoLongerHas; the rules are in engine/room-deletes.js): a cached message the
 *  read doesn't have in the span it answers for goes - a moderator's removal, its sender's delete,
 *  anything the indexer no longer serves. Only for the app-wide indexer (no Room Info override)
 *  and a room it tracks, never a machinery room. `before` is the page's exclusive upper bound when
 *  it was asked for older history. Returns how many rows went. */
function dropRowsTheIndexerNoLongerHas(channel, page, before = null) {
  if (indexerOverrideFor(channel) || !isIndexerTrackedBroadcastChannel(channel) || isServiceBroadcastChannel(channel)) return 0;
  const rows = messageCache[channel];
  if (!rows?.length || !page?.length) return 0;
  // Never a message of any account saved here, not only the one on (audit 2026-11-25 #25).
  let mine = [];
  try { mine = deps.localAccountAddresses?.() || []; } catch { mine = []; }
  const needed = firstMissRemovesChannels.delete(channel) ? 1 : 2;
  const { gone } = rowsTheIndexerNoLongerHas({
    channel, page, before, held: rows, me: [deps.engine?.address || "", ...mine],
    retentionMs: BROADCAST_RETENTION_MS, strikes: absenceStrikes, needed,
  });
  if (!gone.length) return 0;
  const removed = removeRoomRows(channel, rows, gone);
  if (!removed) return 0;
  deps.appendEngineLog?.(`#${channel}: ${removed} message(s) no longer on the indexer, removed here too`);
  saveCache();
  if (activeChannel === channel) { try { renderRoom(); } catch { /* room not mounted */ } }
  if (!listRenderSuppressed) { try { renderChannelList(); } catch { /* list not mounted */ } }
  return removed;
}
/** The rooms' indexer changed state: the wanted scan follows, and once it's back its rooms read the
 *  outage again from ten minutes before it began. */
function handleIndexerAvailability({ key, down, downSinceMs }) {
  if (!down) {
    for (const channel of [...deepBackfilled]) {
      if (indexerKey(roomIndexerBase(channel)) !== key) continue;
      deepBackfilled.delete(channel);
      deepBackfillFloor.set(channel, Math.max(0, Number(downSinceMs) - INDEXER_RECOVERY_MARGIN_MS));
    }
    if (activeChannel) backfillChannel(activeChannel).catch(() => {});
  }
  syncScanWanted();
}
// ...and of those, the ones whose page-back ran to the end: their whole history is in.
const deepBackfillDone = new Set();
// A page-back that failed part-way: where the next poll picks it up ({ before, cutoff, failures }),
// so older history isn't lost for the rest of the session. Three failed tries in a row and it gives
// up (KaChat iOS 148a5331 PublicChatService deepBackfillResume / failedBackfillResumes).
const deepBackfillResume = new Map();
const BACKFILL_RESUME_TRIES = 3;

/** Pages a room's history backwards from `before` (null: the newest) down to `cutoff`, up to 20
 *  pages of 500. Returns { added, stale }; a page that throws records where to resume and rethrows. */
async function pageBackHistory(channel, { before, cutoff, baseUrl, generation }) {
  let added = 0;
  listRenderSuppressed = true; // one list rebuild at the end, not one per page
  try {
    for (let page = 0; page < 20; page++) {
      let result;
      try {
        result = await fetchBroadcastHistory({ channel, limit: 500, before, baseUrl });
      } catch (error) {
        const failures = (deepBackfillResume.get(channel)?.failures || 0) + 1;
        if (failures < BACKFILL_RESUME_TRIES) deepBackfillResume.set(channel, { before, cutoff, failures });
        else deepBackfillResume.delete(channel);
        throw error;
      }
      if (generation !== roomAccountGeneration) return { added: 0, stale: true };
      added += mergeMessages(channel, result.messages);
      added += dropRowsTheIndexerNoLongerHas(channel, result.messages, before);
      noteRoomNewest(channel, result.messages);
      if (!result.hasMore || !result.messages.length) break;
      const oldest = result.messages.reduce(
        (min, m) => Math.min(min, Number(m.blockTime) || Infinity), Infinity);
      if (!Number.isFinite(oldest)) break;
      if (cutoff && oldest < cutoff) break; // older pages would be pruned anyway
      // Inclusive of the oldest millisecond (KaPost 369794e): rows sharing it past the page's
      // end were skipped; the overlap dedupes by txid. A page all in one millisecond can't
      // move on that way, so it steps past it.
      before = oldest + 1 === before ? oldest : oldest + 1;
    }
  } finally { listRenderSuppressed = false; }
  deepBackfillResume.delete(channel);
  return { added, stale: false };
}

// Sends started in this run, by pending id. A row still pending that isn't one of these was left by
// a run that ended mid-send, and nothing is working on it (iOS e5a9b11 PublicChatService).
const pendingSendsThisRun = new Set();
// Rooms already checked for those rows: once per account per run, cleared on an account switch.
const settledPendingRooms = new Set();

/** Settles the room's pending rows from an earlier run (settleLeftoverRoomRows), once. For a room
 *  the indexer tracks only after its full history is in, so a send that did land has its copy to
 *  match; a room with no indexer has no history coming, so on opening. Returns whether rows changed. */
function settlePendingFromEarlierRuns(channel) {
  if (!channel || settledPendingRooms.has(channel)) return false;
  settledPendingRooms.add(channel);
  const rows = messageCache[channel];
  if (!rows?.length || settleLeftoverRoomRows(rows, { keeping: pendingSendsThisRun }) === 0) return false;
  saveCache();
  return true;
}

// Bumped on every account change (KaPost b78fdb0 walletGeneration): a poll, backfill or sweep that
// was waiting on the indexer when the account changed drops its answer instead of merging the last
// account's rows into this one's rooms.
let roomAccountGeneration = 0;
async function backfillChannel(channel, { quiet = true } = {}) {
  const generation = roomAccountGeneration;
  try {
    let added = 0;
    const baseUrl = indexerOverrideFor(channel) || null;
    if (deepBackfilled.has(channel)) {
      const result = await fetchBroadcastHistory({ channel, baseUrl });
      if (generation !== roomAccountGeneration) return 0;
      added = mergeMessages(channel, result.messages);
      added += dropRowsTheIndexerNoLongerHas(channel, result.messages);
      // More arrived since the last poll than the page holds (a busy room, or the tab away for a
      // while, when the block stream isn't watching it): page back to the rows already seen,
      // through the backfill below (iOS ee5ec98).
      const gapFloor = roomPollGapFloor(result, roomNewestSeen.get(channel));
      noteRoomNewest(channel, result.messages);
      if (gapFloor != null) {
        deepBackfilled.delete(channel);
        deepBackfillFloor.set(channel, gapFloor);
      }
      // After an account switch the room's history is already in, so its next poll settles it.
      if (deepBackfillDone.has(channel) && settlePendingFromEarlierRuns(channel)) added += 1;
      // A page-back that failed part-way carries on from where it stopped.
      const resume = deepBackfilled.has(channel) ? deepBackfillResume.get(channel) : null;
      if (resume) {
        const paged = await pageBackHistory(channel, { before: resume.before, cutoff: resume.cutoff, baseUrl, generation });
        if (paged.stale) return 0;
        added += paged.added;
        deepBackfillDone.add(channel);
        if (settlePendingFromEarlierRuns(channel)) added += 1;
      }
    }
    if (!deepBackfilled.has(channel)) {
      // First open this session: page backwards through the indexer's full history
      // (newest-first, `before` = oldest blockTime seen) so the room shows every
      // message still retained server-side, not just the newest page.
      deepBackfilled.add(channel);
      const outageFloor = deepBackfillFloor.get(channel);
      deepBackfillFloor.delete(channel);
      const cutoff = Math.max(retentionCutoffMs(channel) || 0, outageFloor || 0) || retentionCutoffMs(channel);
      deepBackfillResume.delete(channel);
      const paged = await pageBackHistory(channel, { before: null, cutoff, baseUrl, generation });
      if (paged.stale) return 0;
      added += paged.added;
      // The whole history is in, so a send that did land has its copy to match (iOS e5a9b11).
      deepBackfillDone.add(channel);
      if (settlePendingFromEarlierRuns(channel)) added += 1;
    }
    if (added > 0) {
      if (activeChannel === channel) renderRoom();
      renderChannelList();
    }
    return added;
  } catch (error) {
    if (generation !== roomAccountGeneration) return 0; // the last account's failure
    if (!quiet) deps.showToast?.(userFacingError(error));
    deps.appendEngineLog?.(`Broadcast backfill failed for #${channel}: ${error.message}`);
    // With the indexer confirmed down no history is coming to match them against, so the rows an
    // earlier run left pending settle now, once (KaPost 369794e), instead of showing Sending.
    if (isIndexerDown(roomIndexerBase(channel)) && settlePendingFromEarlierRuns(channel)) {
      if (activeChannel === channel) renderRoom();
      renderChannelList();
    }
    return -1;
  }
}

function startPolling(channel) {
  stopPolling();
  pollTimer = window.setInterval(() => { if (!document.hidden) backfillChannel(channel); }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
}

// ---------------------------------------------------------------------------
// Sending (single serialized queue so concurrent tx builds can't race UTXOs)
// ---------------------------------------------------------------------------

let sendQueue = Promise.resolve();
// A queued send whose account is no longer the active one (see enqueueBroadcastSend).
const ROOM_SEND_ACCOUNT_CHANGED = "ROOM_SEND_ACCOUNT_CHANGED";
function enqueueBroadcastSend(task) {
  // The account that pressed Send, captured now. The task signs with whatever key deps.engine
  // holds when its turn in the queue comes, so a message, reaction or edit still waiting behind
  // another send when the account switched would go out as the NEW account: it is dropped.
  const owner = accountGuard(() => deps?.engine?.address);
  const guarded = () => {
    if (!owner.still()) {
      const error = new Error("The account changed before this could be sent.");
      error.code = ROOM_SEND_ACCOUNT_CHANGED;
      throw error;
    }
    return task();
  };
  const run = sendQueue.then(guarded, guarded);
  sendQueue = run.then(() => {}, () => {});
  return run;
}

// When the chatting address has no coins at all (iOS d816404 notEnoughKasMessage).
const ROOM_NOT_ENOUGH_KAS = "Not enough KAS on your Chatting Address. Add some and try again.";

/** What a room send's toast says. A send that may have landed says so and no more: "Failed to
 *  send" would invite sending it again (iOS e5a9b11). `prefix` leads any other reason. */
function roomSendErrorText(error, prefix = "") {
  if (error?.code === SEND_OUTCOME_UNKNOWN) return SEND_OUTCOME_UNKNOWN_MESSAGE;
  const raw = String(error?.message ?? error ?? "");
  const text = /no utxos found|insufficient funds/i.test(raw) ? ROOM_NOT_ENOUGH_KAS : userFacingError(error);
  return `${prefix}${text}`;
}

/** Shared send pipeline used by the composer, voice-note share links, and reactions
 *  (reactions pass showBubble:false — they never get a message row). */
async function sendBroadcastText(channel, text, { showBubble = true, feeKas = null } = {}) {
  const pendingId = newRoomPendingId();
  if (showBubble) {
    pendingSendsThisRun.add(pendingId);
    (messageCache[channel] ||= []).push({
      txId: pendingId,
      senderAddress: deps.engine.address || "",
      content: text,
      blockTime: Date.now(),
      status: "pending",
    });
    if (activeChannel === channel) renderRoom();
  }
  return sendRoomRow(channel, pendingId, text, { showBubble, feeKas });
}
function newRoomPendingId() {
  return `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
/** A long voice note's parts (KaPost sendPublicChatVoiceParts): every part shows at once,
 *  Sending, then they go in index order, each spending the change of the one before. When one
 *  fails, the rest are Failed for one Retry. Never a reply. */
async function sendRoomParts(channel, texts) {
  const start = Date.now();
  const ids = texts.map((text, offset) => {
    const pendingId = newRoomPendingId();
    pendingSendsThisRun.add(pendingId);
    (messageCache[channel] ||= []).push({ txId: pendingId, senderAddress: deps.engine.address || "", content: text, blockTime: start + offset, status: "pending" });
    return pendingId;
  });
  if (activeChannel === channel) renderRoom();
  return sendRoomRowsInOrder(channel, ids);
}
async function sendRoomRowsInOrder(channel, ids) {
  for (let i = 0; i < ids.length; i += 1) {
    const row = (messageCache[channel] || []).find((m) => m.txId === ids[i]);
    if (!row) return false;
    try {
      await sendRoomRow(channel, row.txId, row.content);
    } catch (error) {
      // The parts after it are Failed for the one Retry: no longer this run's sends (Retry skips
      // those, so they stayed on Sending for good), and kept so (KaPost b78fdb0).
      const later = ids.slice(i + 1);
      messageCache[channel] = (messageCache[channel] || []).map((m) => (later.includes(m.txId) ? { ...m, status: "failed" } : m));
      for (const id of later) pendingSendsThisRun.delete(id);
      saveCache();
      if (activeChannel === channel) renderRoom();
      deps.showToast?.(roomSendErrorText(error, "Failed to send voice message: "));
      return false;
    }
  }
  renderChannelList();
  return true;
}
/** Retry on a note's bubble: only its failed parts, in place and in order. */
function retryRoomParts(channel, cluster) {
  if (!channel) return;
  // the parts as they are now, and none already being sent again (KaPost 369794e)
  const live = new Map((messageCache[channel] || []).map((m) => [m.txId, m]));
  const failed = cluster.parts.map((m) => live.get(m.txId))
    .filter((m) => m && m.status === "failed" && !pendingSendsThisRun.has(m.txId)).map((m) => m.txId);
  if (!failed.length) return;
  messageCache[channel] = (messageCache[channel] || []).map((m) => (failed.includes(m.txId) ? { ...m, status: "pending" } : m));
  for (const id of failed) pendingSendsThisRun.add(id);
  renderRoom();
  sendRoomRowsInOrder(channel, failed);
}
/** Sends a row already in the room (status pending) under its pending id. */
async function sendRoomRow(channel, pendingId, text, { showBubble = true, feeKas = null } = {}) {
  try {
    const txid = await enqueueBroadcastSend(() => sendBroadcastMessage({ engine: deps.engine, channel, content: text, feeKas: feeKas || "0" }));
    if (showBubble) {
      const list = messageCache[channel] || [];
      // The chain's copy can already be in the room (a block scan faster than this answer, with
      // the pending bubble not matched): then the bubble goes, so the id is never listed twice
      // (iOS d0b819f, one row per message id).
      // Still on this device's clock (`localTime`) until the chain's copy brings its block time
      // (settleRoomCopy, audit 2026-11-25 #25).
      messageCache[channel] = list.some((m) => m.txId === txid)
        ? list.filter((m) => m.txId !== pendingId)
        : list.map((m) => (m.txId === pendingId ? { ...m, txId: txid, status: undefined, localTime: true } : m));
      saveCache();
    }
    return txid;
  } catch (error) {
    if (showBubble && error?.code === SEND_OUTCOME_UNKNOWN) {
      // It may have landed, so no Retry, which would post and pay twice: "Not confirmed" with the
      // transaction's id until its chain copy turns it sent (mergeMessages; iOS 33095ac
      // markMessageUnconfirmed). Saved, so a reload still has it to settle.
      pendingSendsThisRun.delete(pendingId);
      messageCache[channel] = markRoomRowUnconfirmed(messageCache[channel], pendingId, error.txid);
      saveCache();
    } else if (showBubble) {
      // failed: free for a Retry again
      pendingSendsThisRun.delete(pendingId);
      messageCache[channel] = (messageCache[channel] || []).map((m) =>
        m.txId === pendingId ? { ...m, status: "failed" } : m);
    }
    throw error;
  } finally {
    if (showBubble && activeChannel === channel) renderRoom();
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** What a reply's quote shows (K 428a797b, audit #18). The sender and text a reply envelope
 *  carries are whatever its author typed, so they could put any words in anyone's mouth: the quote
 *  is drawn from the quoted message itself, found by its txid among the room's loaded messages
 *  (with its edit). When it isn't loaded, nobody is named (`sender` null) and the claimed text is
 *  shown as unverified. */
function replyQuoteDisplay(channel, reply) {
  const original = reply?.replyToId ? (messageCache[channel] || []).find((row) => row.txId === reply.replyToId) : null;
  if (!original) return { sender: null, preview: stripBidiControls(String(reply?.replyToPreview || "")) };
  const preview = humanizeBroadcastContent(effectiveContent(channel, original)).replace(/\s+/g, " ").trim().slice(0, 200);
  return { sender: stripBidiControls(senderName(original.senderAddress)), preview: stripBidiControls(preview) };
}

// ---- @mentions by .kachat username (K bdf29425, 157790b0) ---------------------------------------
// Room text is public: a mention is the plain `@name.kachat` (or `@name`) as typed. Bubbles style
// and link each one (a click opens the profile) and outline a message that @'s you; typing "@"
// suggests everyone who has written in the room, then your contacts, plus a looked-up name - only
// people with a username.

/** The text into `container` with each @username a clickable span, the rest through the link
 *  renderer. Returns the links found, as renderTextWithLinks does. */
function renderRoomText(container, text) {
  const value = String(text ?? "");
  const tokens = MENTIONS_ENABLED ? mentionTokens(value) : [];
  const plain = (run) => {
    if (!run) return [];
    if (deps.renderTextWithLinks) return deps.renderTextWithLinks(container, run) || [];
    container.append(run);
    return [];
  };
  if (!tokens.length) return plain(value);
  const urls = [];
  let last = 0;
  for (const token of tokens) {
    urls.push(...plain(value.slice(last, token.start)));
    const span = document.createElement("span");
    span.className = "room-mention";
    span.setAttribute("role", "link");
    // "@alice", never the ending, whatever the sender typed (K 522fd9f4)
    span.textContent = value.slice(token.start, token.end).replace(/\.kachat$/i, "");
    span.addEventListener("click", (event) => {
      // the profile, not the message menu a click on the bubble opens
      event.stopPropagation();
      openMentionedProfile(token.name);
    });
    container.append(span);
    last = token.end;
  }
  urls.push(...plain(value.slice(last)));
  return urls;
}

/** Opens the profile of whoever `name` (a bare username) belongs to. Unknown names say so. */
async function openMentionedProfile(name) {
  try {
    const found = primaryName((await deps.engine.resolveNameEverywhere?.(name)) || []);
    if (found?.address) deps.openUserInfo?.(found.address);
    else deps.showToast?.(`No one has the username @${name}.`);
  } catch {
    deps.showToast?.(`Couldn't look up @${name}.`);
  }
}

/** Each new room message that @'s you by your username is a row in Profile's bell (K d089011f
 *  insertRoomMessages: every mention, whatever the room's bell; never a banner from here). Not
 *  the machinery rooms, nor your own, nor from a sender hidden in that room. Reactions, edits
 *  and deletes never reach here (mergeMessages keeps them out of the rows). */
function recordRoomMentions(channel, rows) {
  if (!rows?.length || !deps.recordMention || isServiceBroadcastChannel(channel)) return;
  const me = String(deps.engine.address || "").toLowerCase();
  if (!me || !deps.mentionUsernameOf?.(deps.engine.address)) return;
  const hiddenHere = hiddenIn(channel);
  for (const row of rows) {
    if (String(row.senderAddress || "").toLowerCase() === me || hiddenHere.has(row.senderAddress)) continue;
    const preview = humanizeBroadcastContent(row.content);
    if (!roomTextMentionsMe(preview)) continue;
    deps.recordMention({
      sender: stripBidiControls(senderName(row.senderAddress)),
      place: `#${stripBidiControls(channel)}`,
      preview: stripBidiControls(preview).slice(0, 160),
      txId: row.txId,
      blockTime: row.blockTime,
      target: `room:${channel}`,
    });
  }
}

/** Whether room text @'s the signed-in account by its username. */
function roomTextMentionsMe(text) {
  if (!MENTIONS_ENABLED) return false;
  const me = deps.mentionUsernameOf?.(deps.engine.address);
  return Boolean(me) && textMentionsName(text, me);
}

/** Who a room's @ suggests: everyone who has written here (newest first), then your contacts. */
function roomMentionSource(query, lookedUp) {
  const rows = activeChannel ? (messageCache[activeChannel] || []) : [];
  const senders = [];
  for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i]?.senderAddress) senders.push(rows[i].senderAddress);
  return roomMentionCandidates({
    query,
    me: deps.engine.address || "",
    senders,
    contacts: deps.mentionContactAddresses?.() || [],
    labelOf: (address) => deps.mentionUsernameOf?.(address) || null,
    lookedUp,
  });
}

function wireRoomMentions() {
  if (!MENTIONS_ENABLED || !composerInput) return;
  let list = document.querySelector("[data-broadcast-mention-suggestions]");
  if (!list) {
    // a cached older shell has no list: it goes just above the composer row
    list = document.createElement("div");
    list.className = "mention-suggestions room-mention-suggestions";
    list.dataset.broadcastMentionSuggestions = "";
    list.hidden = true;
    composerInput.closest(".kaposts-reply-bar")?.before(list);
  }
  roomMentionList = attachMentionSuggestions(composerInput, {
    container: list,
    source: roomMentionSource,
    lookup: async (typed) => {
      const found = primaryName((await deps.engine.resolveNameEverywhere?.(typed)) || []);
      return found?.name && found.address ? { address: found.address, name: found.name } : null;
    },
    subscribe: deps.onNamesChange || null,
    avatarHtml: deps.mentionAvatarHtml || null,
    displayName: deps.nameDisplay || ((n) => n),
    escapeHtml: deps.escapeHtml,
  });
}
let roomMentionList = null;

function senderName(address) {
  if (!address) return "unknown";
  if (address === deps.engine.address) return "You";
  // The name you gave them, else their .kachat name, else the address.
  const contactName = deps.contactNameFor?.(address);
  if (contactName) return contactName;
  // Their .kachat name when you haven't named them (iOS e52357d).
  const identityName = deps.identityNameFor?.(address);
  if (identityName) return identityName;
  // No name: the app's one short form, kaspa:xxxx....xxxx (iOS a80d271).
  return deps.defaultAlias ? deps.defaultAlias(address) : deps.shortAddress(address);
}

// The bell icon pair, iOS-style: filled accent when notifications are on, slashed when off.
const BELL_ON_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a5.5 5.5 0 0 1 5.5 5.5c0 3.2.8 5 1.8 6.2.4.5.05 1.3-.6 1.3H5.3c-.65 0-1-.8-.6-1.3 1-1.2 1.8-3 1.8-6.2A5.5 5.5 0 0 1 12 4Z" fill="currentColor" stroke="none"/><path d="M10 19.5a2 2 0 0 0 4 0"/></svg>`;
const BELL_OFF_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a5.5 5.5 0 0 1 5.5 5.5c0 3.2.8 5 1.8 6.2.4.5.05 1.3-.6 1.3H5.3c-.65 0-1-.8-.6-1.3 1-1.2 1.8-3 1.8-6.2A5.5 5.5 0 0 1 12 4Z"/><path d="M10 19.5a2 2 0 0 0 4 0"/><path d="M4 4l16 16"/></svg>`;
const GEAR_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>`;

/** The room's top-right bell (iOS toolbar): bell.fill while notifications are on, bell.slash
 *  while off, and the label says which. */
function syncRoomBell() {
  const bell = document.querySelector("[data-broadcast-room-bell]");
  if (!bell || !activeChannel) return;
  const on = Boolean(notifyByChannel[activeChannel]);
  bell.innerHTML = on ? BELL_ON_SVG : BELL_OFF_SVG;
  const label = on ? "Notifications on" : "Notifications off";
  bell.setAttribute("aria-label", label);
  bell.title = label;
}

function lastVisibleMessage(name) {
  const hidden = hiddenIn(name);
  const rows = messageCache[name] || [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const m = rows[i];
    if (hidden.has(m.senderAddress)) continue;
    if (deps.parseReactionEnvelope?.(m.content)) continue;
    return m;
  }
  return null;
}
/** A room's newest message as a row shows it, with who sent it; "" with none. */
function roomPreviewLine(name) {
  const last = lastVisibleMessage(name);
  if (!last) return "";
  const me = deps.engine.address || "";
  // A link-bearing message never shows its URL in a row, same as the chat lists.
  const rawPreview = humanizeBroadcastContent(effectiveContent(name, last));
  const previewText = /https?:\/\/\S+/i.test(rawPreview) ? "📎 Sent a link" : rawPreview;
  // bidi controls out of the Chats row too (K 428a797b, audit #22), not only the bubble
  return stripBidiControls(`${last.senderAddress === me ? "You" : senderName(last.senderAddress)}: ${previewText}`).replace(/\s+/g, " ").slice(0, 120);
}

function renderChannelList() {
  // The rooms are rows in the Chats list, drawn by the app: this only tells the app that a room's
  // state changed, so their rows redraw.
  deps?.onUnreadChanged?.();
}

/** Site links whose preview has been asked for: each repaints the room once, when it lands. */
const siteLinkPreviewsAsked = new Set();

/** One broadcast bubble: header, linkified body (+ the same preview card treatment as 1:1
 *  bubbles — Nextcloud shares get the progressive video→audio→img→attachment probe), hover
 *  reaction bar, and aggregated reaction chips. */
/** Avatar + bubble row, matching 1:1/group chats: sender avatar beside every message
 *  (left for others, right for your own). */
function buildMessageRow(m) {
  const mine = m.senderAddress === deps.engine.address;
  const row = document.createElement("div");
  row.className = `broadcast-msg-row${mine ? " mine" : ""}`;
  const avatar = document.createElement("span");
  avatar.className = "broadcast-avatar-slot group-avatar-clickable";
  avatar.innerHTML = deps.avatarHtmlForAddress?.(m.senderAddress, "message-avatar") || "";
  avatar.addEventListener("click", (event) => { event.stopPropagation(); openBroadcastSenderMenu(m.senderAddress, event.clientX, event.clientY, m); });
  const card = buildMessageElement(m);
  if (mine) row.append(card, avatar);
  else row.append(avatar, card);
  return row;
}

/** The URL when the whole message is one http(s) link and nothing else (iOS
 *  MessageTextRenderPlan.isEntirelyLink), else null. */
function entirelyLinkUrl(text) {
  const match = String(text || "").trim().match(/^https?:\/\/\S+$/i);
  return match ? match[0] : null;
}

/** The bare text a message could be translated from: a plain or reply-wrapped text message, not a
 *  photo, voice note or KaChat link card. Empty when there is nothing to translate. */
function translatableText(m) {
  const content = effectiveContent(activeChannel, m);
  if (deps.parseImageEnvelope?.(m.content) || deps.parseAudioEnvelope?.(m.content)) return "";
  const replyEnvelope = deps.parseReplyEnvelope?.(content) || null;
  const text = String(replyEnvelope ? replyEnvelope.text : content || "").trim();
  if (!text || text.startsWith("{")) return "";
  if (deps.firstInternalLinkIn?.(text)) return "";
  return text;
}
/** Per message AND per text: an edit changes the text, and a translation of the old text must not
 *  show over the new one. */
function translationKeyFor(m) {
  const text = translatableText(m);
  return `publicchat:${m.txId || m.id || ""}:${text.length}:${text.slice(0, 64)}`;
}
function messageTimeLineText(ms) {
  const date = new Date(ms);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return time;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const day = date.toDateString() === yesterday.toDateString()
    ? "Yesterday"
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${day}, ${time}`;
}

function buildMessageElement(m) {
  const mine = m.senderAddress === deps.engine.address;
  const el = document.createElement("div");
  el.className = `broadcast-message${mine ? " mine" : ""}`;

  const head = document.createElement("div");
  head.className = "broadcast-message-head";
  el.dataset.broadcastTxid = m.txId;
  // The sender's name is a label, not a button (iOS PublicChatMessageRow): the avatar opens the
  // sender sheet.
  const sender = document.createElement("strong");
  // "You" over your own messages (iOS PublicChatMessageRow).
  sender.textContent = mine ? "You" : senderName(m.senderAddress);
  head.append(sender);
  // Your own messages carry the same delivery label as 1:1 and group bubbles, under the
  // message (iOS 21baa36): Sending, Sent, Failed · Tap to retry. Appended below, after the body.
  if (mine && deps.createDeliveryStatusIcon) {
    // handled after the body
  } else if (m.status === "pending") {
    const badge = document.createElement("span");
    badge.className = "broadcast-pending";
    badge.textContent = "sending…";
    head.append(badge);
  } else if (m.status === "failed") {
    const badge = document.createElement("span");
    badge.className = "broadcast-failed";
    badge.textContent = "failed";
    head.append(badge);
  } else if (m.status === ROOM_UNCONFIRMED) {
    const badge = document.createElement("span");
    badge.className = "broadcast-pending";
    badge.textContent = "not confirmed";
    head.append(badge);
  }
  el.append(head);

  // Decode the same wire envelopes 1:1 chats use - replies and voice notes arrive as JSON
  // payloads. A room draws no photo bubble (iOS: text and voice only), so any other envelope
  // reads as its text.
  const shownContent = effectiveContent(activeChannel, m);
  const roomEdit = editFor(activeChannel, m);
  const replyEnvelope = deps.parseReplyEnvelope?.(shownContent) || null;
  const audioEnvelope = replyEnvelope ? null : (deps.parseAudioEnvelope?.(m.content) || null);

  if (replyEnvelope) {
    const quote = document.createElement("div");
    quote.className = "message-reply-quote";
    const shown = replyQuoteDisplay(activeChannel, replyEnvelope);
    const label = document.createElement("strong");
    label.textContent = shown.sender ?? "Original message not loaded";
    const preview = document.createElement("span");
    preview.textContent = shown.preview || "Message";
    if (shown.sender == null) quote.classList.add("unverified");
    quote.append(label, preview);
    // Tapping the quote jumps to the original and lights it up; gone from this device's cache
    // (retention, or before you joined) says so instead of doing nothing.
    quote.classList.add("clickable");
    quote.addEventListener("click", (event) => { event.stopPropagation(); jumpToBroadcastMessage(replyEnvelope.replyToId); });
    el.append(quote);
  }

  // What the message says (iOS displayText): a reply's own text, else the content.
  const originalText = String((replyEnvelope ? replyEnvelope.text : shownContent) ?? "");
  const withinInline = new TextEncoder().encode(originalText).length <= LONG_MESSAGE_BYTES;
  const isEnvelopeText = originalText.startsWith("{");
  // A link into KaChat itself: the native card is the WHOLE message, even with text around it
  // (iOS loneInternalLink - KaPosts' share text quotes the post above the link).
  const internalLink = !audioEnvelope && !isEnvelopeText ? (deps.firstInternalLinkIn?.(originalText) || null) : null;
  const internalCard = internalLink && withinInline ? (deps.buildInternalLinkCard?.(internalLink) || null) : null;
  // A message that is nothing but a link: the preview card replaces the bubble (iOS loneLinkURL).
  const loneLink = !audioEnvelope && !internalLink && withinInline && !isEnvelopeText ? entirelyLinkUrl(originalText) : null;
  // Rooms follow KaPost's preview rules (KaPost b78fdb0): a link previews, by itself with no tap,
  // only when its sender has a .kachat name and it is KaChat's own site or an allowed site with no
  // adult words. Any other link stays plain text in the bubble, so no unknown server is contacted.
  const senderNamed = Boolean(deps.hasKachatName?.(m.senderAddress));
  const previewCardFor = (url) => {
    if (!senderNamed || !(isKaChatSiteLink(url) || allowsPreview(url))) return null;
    const card = deps.buildKaPostWebCard?.(url) || null;
    if (!card && !siteLinkPreviewsAsked.has(url)) {
      siteLinkPreviewsAsked.add(url);
      deps.resolveKaPostWebPreview?.(url).then((data) => { if (data) renderRoom(); }).catch(() => {});
    }
    return card;
  };

  const loneCard = !internalCard && loneLink && deps.isPreviewableUrl?.(loneLink) ? previewCardFor(loneLink) : null;

  const partCluster = roomParts.clusters.get(m.txId) || null;
  if (partCluster && deps.buildVoicePlayer) {
    el.append(VoiceNotes.buildPartsBody(partCluster, {
      contentOf: (row) => row.content,
      buildVoicePlayer: (src, options) => deps.buildVoicePlayer(src, { ...options, chatStyle: false }),
      outgoing: mine,
      onReady: () => { if (activeChannel) renderRoom(); },
    }));
  } else if (internalCard || loneCard) {
    el.classList.add("link-card-only");
    el.append(internalCard || loneCard);
  } else if (audioEnvelope) {
    const audioWrap = document.createElement("div");
    audioWrap.className = "message-audio-bubble";
    if (deps.buildVoicePlayer) {
      audioWrap.append(deps.buildVoicePlayer(audioEnvelope.content, { outgoing: mine, durationHint: audioEnvelope.duration }));
    } else {
      const player = document.createElement("audio");
      player.controls = true;
      player.preload = "metadata";
      player.src = audioEnvelope.content;
      player.addEventListener("click", (event) => event.stopPropagation());
      audioWrap.append(player);
    }
    el.append(audioWrap);
  } else {
    const body = document.createElement("div");
    body.className = "broadcast-message-body";
    // The translation while one is showing, otherwise the message (iOS 03e5128).
    const translationKey = !mine && deps.translation ? translationKeyFor(m) : null;
    const fullText = translationKey ? deps.translation.textFor(translationKey, originalText) : originalText;
    // Public rooms are where stray base64 and essays land: past 2000 bytes the bubble shows a
    // 500-character preview and opens in full on demand, as iOS does.
    const isLong = new TextEncoder().encode(String(fullText || "")).length > LONG_MESSAGE_BYTES;
    const bodyText = isLong ? `${String(fullText).slice(0, LONG_MESSAGE_PREVIEW_CHARS)}…` : fullText;
    // @usernames styled and clickable (K bdf29425): a click opens that person's profile.
    const urls = renderRoomText(body, stripBidiControls(bodyText));
    if (isLong) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "message-show-more";
      more.textContent = "Show More";
      more.addEventListener("click", (event) => {
        event.stopPropagation();
        // iOS FullMessageTextView: the whole text, Done, and a copy button.
        // A row stored cut to its start (audit 2026-11-25 #11) says so until the room serves it again.
        const message = m.truncated ? `${fullText}…\n\nOnly the start of this long message is kept on this device. It shows in full once the room loads it again.` : fullText;
        confirmDialog({ title: "Message", message, confirmLabel: "Copy", cancelLabel: "Done" }).then((copy) => {
          if (copy) deps.copyText?.(String(fullText)).then(() => deps.showToast?.("Message copied.")).catch(() => {});
        });
      });
      body.append(more);
    }
    if (roomEdit) {
      // Just "edited", whatever the edit's delivery (iOS isEdited chip).
      const mark = document.createElement("span");
      mark.className = "message-edited";
      mark.textContent = "edited";
      body.append(mark);
    }
    el.append(body);
    // The line under a bubble, the same words KaPosts uses: "Translate" under someone else's
    // message in another language (K 8cb4c88e: as KaPost's "Translate post", not only in the
    // menu; the same language guess, canOfferTextTranslation), then "Translating...", "Translated
    // from Spanish - Show original", or why it could not be.
    const tState = translationKey ? deps.translation.state(translationKey) : null;
    const offerText = translationKey && !tState && !m.status ? translatableText(m) : "";
    const offersTranslate = Boolean(offerText) && deps.translation.canOffer(translationKey, offerText);
    if (tState || offersTranslate) {
      const note = document.createElement("div");
      note.className = "broadcast-translate-note";
      const link = (label, onClick) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "kaposts-translate-link";
        button.textContent = label;
        button.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
        return button;
      };
      if (!tState) note.append(link("Translate", () => deps.translation.translate(translationKey, offerText)));
      else if (tState.status === "translating") note.textContent = "Translating...";
      else if (tState.status === "failed") note.append(link("Translation unavailable - try again", () => deps.translation.translate(translationKey, translatableText(m))));
      else if (tState.status === "unavailable") note.textContent = tState.reason || "Translation unavailable";
      else if (tState.showingOriginal) note.append(link("Show translation", () => deps.translation.showTranslation(translationKey)));
      else { note.append(`Translated from ${tState.sourceName || "another language"} - `); note.append(link("Show original", () => deps.translation.showOriginal(translationKey))); }
      el.append(note);
    }
    // A link inside longer text gets its card below the bubble (iOS trailingLinkPreview); never
    // for a KaChat link (that one is the card above) or a JSON envelope.
    const previewable = !internalLink && !isEnvelopeText ? urls.find((url) => deps.isPreviewableUrl?.(url)) : null;
    if (previewable) {
      const card = previewCardFor(previewable);
      if (card) el.append(card);
    }
  }

  // The time under every message, and under your own the delivery status right after it
  // ("10:57 AM  ✓ Sent"). Rooms are long feeds, so another day's message says which
  // (iOS MessageTimeLine, showsDay).
  const timeLine = document.createElement("div");
  timeLine.className = "broadcast-delivery-row broadcast-time-line";
  const time = document.createElement("span");
  time.className = "broadcast-time";
  time.textContent = messageTimeLineText(Number(m.blockTime) || Date.now());
  timeLine.append(time);
  if (mine && deps.createDeliveryStatusIcon) {
    // "Not confirmed": the same label as a 1:1 send whose outcome is unknown, with no Retry (iOS 33095ac).
    const baseStatus = m.status === "pending" ? "pending" : m.status === "failed" ? "failed" : m.status === ROOM_UNCONFIRMED ? ROOM_UNCONFIRMED : "confirmed";
    // The bubble carries its edit's send state; `m` keeps the row's own (iOS ee5ec98 shownMessage).
    const editFailed = failedRoomEdits.has(failedRoomEditKey(activeChannel, m.txId));
    const status = editFailed ? "failed" : roomEdit?.status === ROOM_UNCONFIRMED ? ROOM_UNCONFIRMED : baseStatus;
    const onRetry = editFailed ? () => retryFailedRoomEdit(activeChannel, m.txId)
      : partCluster ? () => retryRoomParts(activeChannel, partCluster) : () => retryBroadcastMessage(m);
    // A note's parts show one status (any failed, then any sending, then not confirmed).
    const noteStatus = partCluster ? { failed: "failed", pending: "pending", warning: ROOM_UNCONFIRMED, sent: "confirmed" }[partCluster.status] : null;
    const icon = deps.createDeliveryStatusIcon({ direction: "outgoing", status: noteStatus || status }, { onRetry });
    if (icon) {
      icon.classList.add("broadcast-delivery-icon");
      timeLine.append(icon);
    }
  }
  el.append(timeLine);
  // Someone else's message that @'s you by your username stands out (K bdf29425).
  if (!mine && roomTextMentionsMe(originalText)) el.classList.add("mentions-me");
  appendReactionUi(el, m);
  // 1:1 parity: right-click opens the reactions + Reply/Copy/Hide menu.
  onContextGesture(el, (event) => {
    event.preventDefault();
    openBroadcastMessageMenu(m, event.clientX, event.clientY);
  });
  // A left click opens the same menu, the quick reactions with it (owner, Build 298).
  onMessageClick(el, (event) => openBroadcastMessageMenu(m, event.clientX, event.clientY));
  // Double-tap on a phone: the quick-reaction bar (iOS double-tap), with "+" into the full picker.
  attachDoubleTap(el, (event) => {
    if (m.status) return;
    event.preventDefault();
    const perReactor = reactionsOn(activeChannel, m.txId);
    const myEntry = perReactor[deps.engine.address || ""];
    deps.openQuickReactionBar?.({
      anchor: el,
      alignRight: mine,
      current: myEntry && !myEntry.removed ? myEntry.emoji : null,
      onReact: (emoji) => sendBroadcastReaction(m.txId, emoji),
      onReply: () => startBroadcastReply(m),
    });
  });
  return el;
}

// Scrolls to the original a reply quotes and lights it up for a moment.
function jumpToBroadcastMessage(txId, { quiet = false } = {}) {
  if (!txId || !roomBodyEl) return;
  // a reply to one of a voice note's hidden parts goes to the note's bubble (KaPost 369794e)
  txId = roomParts.anchorKeyOf.get(txId) || txId;
  let row = null;
  try { row = roomBodyEl.querySelector(`[data-broadcast-txid="${CSS.escape(String(txId))}"]`); } catch { row = null; }
  // quiet: a mention opened from the bell that isn't in the loaded rows opens the room as usual
  if (!row) { if (!quiet) deps.showToast?.("Original message not available."); return; }
  // quiet (the bell's jump): at once, since a poll's re-render mid-glide would stop it short
  row.scrollIntoView({ behavior: quiet ? "auto" : "smooth", block: "center" });
  row.classList.add("message-highlight");
  window.setTimeout(() => row.classList.remove("message-highlight"), 1200);
}

// The avatar menu (iOS BroadcastChannelView.avatarButton): who this is, and what you can do
// about them. Same menu from the sender's name.
function openBroadcastSenderMenu(address, x, y, message = null) {
  void x; void y;
  if (!address) return;
  const mine = address === deps.engine.address;
  // iOS PublicChatChannelView.senderSheet: a header naming the sender and their address, then
  // one row per option saying what it does - View Profile, Open Chat, Send Kaspa, Copy Address,
  // Hide User, Report, Block, in that order (Report and Block: KaPosts-iPhone 9e22075).
  const options = [{ id: "profile", title: "View Profile", subtitle: "Their profile, .kachat name and address." }];
  if (!mine) {
    options.push({ id: "chat", title: "Open Chat", subtitle: "Message them directly, one to one." });
    // "Send Kaspa", was "Pay in Kaspa" (iOS aaa45ae).
    options.push({ id: "pay", title: "Send Kaspa", subtitle: "Open your chat with them in payment mode." });
  }
  options.push({ id: "copy", title: "Copy Address", subtitle: "Copy their Kaspa address." });
  if (!mine) {
    options.push({ id: "hide", title: "Hide User", subtitle: "Stop seeing their messages in this room. Undo it in Room Info.", destructive: true });
    if (message) options.push({ id: "report", title: "Report", subtitle: "Report abusive or objectionable content. Opens an email with this message attached.", destructive: true });
    options.push({ id: "block", title: `Block ${senderName(address)}`, subtitle: "Hides their posts and room messages, and stops them interacting with you.", destructive: true });
  }
  chooseDialog({ title: senderName(address), message: address, options }).then((choice) => {
    if (choice === "profile") deps.openUserInfo?.(address);
    else if (choice === "chat") deps.openChat?.(address, deps.contactNameFor?.(address) || "");
    else if (choice === "copy") deps.copyText?.(address).then(() => deps.showToast?.(deps.addressCopiedToastText?.(address) || "Address copied")).catch(() => {});
    else if (choice === "pay") deps.payInKaspa?.(address, deps.contactNameFor?.(address) || "");
    else if (choice === "hide") hideSender(address);
    else if (choice === "report") reportBroadcastMessage(message);
    else if (choice === "block") {
      deps.blockAccount?.(address);
      deps.showToast?.("Blocked. Undo it in the Feed's menu, under Blocked.");
    }
  });
}

/** Reporting (KaPosts-iPhone 9e22075 reportMessage): the message's id, room, sender and text. Works
 *  with no mail app, see sendContentReport. */
function reportBroadcastMessage(m) {
  if (!activeChannel || !m) return;
  const body = roomMessageReportBody({
    channel: activeChannel,
    txId: m.txId,
    senderAddress: m.senderAddress,
    text: humanizeBroadcastContent(effectiveContent(activeChannel, m)),
  });
  sendContentReport(body, { copyText: deps.copyText, confirm: confirmDialog });
}

// A failed send of yours: drop the failed row and send the same content again.
function retryBroadcastMessage(m) {
  if (!activeChannel) return;
  // the row as it is now, not as the bubble was drawn (KaPost 369794e): a second tap finds it gone
  const live = (messageCache[activeChannel] || []).find((row) => row.txId === m?.txId);
  if (!live || live.status !== "failed" || pendingSendsThisRun.has(live.txId)) return;
  messageCache[activeChannel] = (messageCache[activeChannel] || []).filter((row) => row.txId !== live.txId);
  renderRoom();
  sendBroadcastText(activeChannel, m.content).then(() => renderChannelList()).catch((error) => {
    deps.showToast?.(roomSendErrorText(error));
  });
}

// ---------------------------------------------------------------------------
// Right-click context menu (1:1 parity): quick reactions + Reply / Copy /
// View in Explorer / Hide user. Reply-SENDING rides the same cross-platform
// reply envelope the room already renders.
// ---------------------------------------------------------------------------

let broadcastReplyTarget = null; // { txId, senderAddress, preview }

function startBroadcastReply(m) {
  broadcastReplyTarget = {
    txId: m.txId,
    senderAddress: m.senderAddress,
    preview: humanizeBroadcastContent(effectiveContent(activeChannel, m)).replace(/\s+/g, " ").slice(0, 90),
  };
  renderBroadcastReplyBanner();
  composerInput?.focus();
}

function cancelBroadcastReply() {
  broadcastReplyTarget = null;
  broadcastEditTarget = null;
  renderBroadcastReplyBanner();
}

/** The banner's X: a reply is dropped; an edit is dropped with the text it put in the composer
 *  (iOS editBanner's cancel empties the composer). */
function cancelBroadcastComposeBanner() {
  const wasEditing = Boolean(broadcastEditTarget);
  cancelBroadcastReply();
  if (wasEditing && composerInput) {
    composerInput.value = "";
    if (activeChannel) deps.saveDraft?.(`room:${activeChannel}`, "");
    syncComposerButtons();
    hideFeePill();
  }
}

let broadcastEditTarget = null; // the row being edited
// Room edits whose send failed, "channel:targetTxId" -> the text, for Retry Edit. The row itself goes
// back to what it read before, since that text never reached the chain (iOS ee5ec98).
const failedRoomEdits = new Map();
const failedRoomEditKey = (channel, targetTxId) => `${channel}:${targetTxId}`;
function retryFailedRoomEdit(channel, targetTxId) {
  const text = failedRoomEdits.get(failedRoomEditKey(channel, targetTxId));
  if (text != null) sendBroadcastEdit(channel, targetTxId, text);
}
function startBroadcastEdit(m) {
  cancelBroadcastReply();
  broadcastEditTarget = m;
  const current = effectiveContent(activeChannel, m);
  if (composerInput) { composerInput.value = String(deps.parseReplyEnvelope?.(current)?.text ?? current); syncComposerButtons(); }
  const banner = document.querySelector("[data-broadcast-reply-banner]");
  const title = document.querySelector("[data-broadcast-reply-title]");
  const preview = document.querySelector("[data-broadcast-reply-preview]");
  if (title) title.textContent = "Editing message";
  if (preview) preview.textContent = humanizeBroadcastContent(current).replace(/\s+/g, " ").slice(0, 90);
  if (banner) banner.hidden = false;
  composerInput?.focus();
}
async function sendBroadcastEdit(channel, targetTxId, text) {
  const myAddress = deps.engine.address || "";
  const clean = String(text || "").trim().slice(0, 4000);
  if (!myAddress || !targetTxId || !clean) return;
  if (deps.isChattingBalanceZero?.()) { deps.showFundingGate?.(); return; }
  failedRoomEdits.delete(failedRoomEditKey(channel, targetTxId));
  // What the message reads now, to go back to if this never leaves the browser.
  const previous = editsCache[channel]?.[targetTxId] ? { ...editsCache[channel][targetTxId] } : null;
  recordEdit(channel, null, { targetTxId, text: clean }, myAddress, Date.now(), "pending");
  saveEdits();
  if (activeChannel === channel) renderRoom();
  try {
    const txid = await sendBroadcastText(channel, JSON.stringify({ type: "edit", targetTxId, text: clean }), { showBubble: false });
    recordEdit(channel, txid, { targetTxId, text: clean }, myAddress, Date.now());
    // The block scan may already have stored the chain row (with an earlier block time), in
    // which case the call above was a no-op: the pending mark still has to come off.
    const sent = editsCache[channel]?.[targetTxId];
    if (sent && sent.editor === myAddress) delete sent.status;
  } catch (error) {
    deps.appendEngineLog?.(`Broadcast edit send failed: ${error.message}`);
    // Not "Failed": it may well have gone through (iOS ee5ec98 showEditFailure).
    deps.showToast?.(roomSendErrorText(error, "Failed to edit: "));
    if (error?.code === SEND_OUTCOME_UNKNOWN) {
      // "Not confirmed" with no Retry, which could pay twice. Its chain copy turns it into a normal edit.
      recordEdit(channel, error.txid || null, { targetTxId, text: clean }, myAddress, Date.now(), ROOM_UNCONFIRMED);
    } else {
      // Never sent: the message goes back to what it read, and the text waits for Retry Edit.
      restoreRoomEdit(editsCache[channel] ||= {}, targetTxId, previous);
      failedRoomEdits.set(failedRoomEditKey(channel, targetTxId), clean);
    }
  }
  saveEdits();
  if (activeChannel === channel) renderRoom();
}

function renderBroadcastReplyBanner() {
  const banner = document.querySelector("[data-broadcast-reply-banner]");
  const title = document.querySelector("[data-broadcast-reply-title]");
  const preview = document.querySelector("[data-broadcast-reply-preview]");
  if (!banner) return;
  banner.hidden = !broadcastReplyTarget;
  if (broadcastReplyTarget) {
    if (title) title.textContent = `Replying to ${senderName(broadcastReplyTarget.senderAddress)}`;
    if (preview) preview.textContent = broadcastReplyTarget.preview;
  }
}

function openBroadcastMessageMenu(m, x, y) {
  if (!deps.openMsgContextMenu) return;
  const mine = m.senderAddress === deps.engine.address;
  const pending = Boolean(m.status); // pending/failed/not confirmed rows aren't known on chain yet
  const myAddress = deps.engine.address || "";
  const perReactor = reactionsOn(activeChannel, m.txId);
  const myEntry = perReactor[myAddress];
  const current = myEntry && !myEntry.removed ? myEntry.emoji : null;
  const icons = deps.getMsgMenuIcons?.() || {};
  const text = humanizeBroadcastContent(effectiveContent(activeChannel, m));
  const items = [];
  if (!pending) {
    items.push({ label: "Reply", icon: icons.reply, onClick: () => startBroadcastReply(m) });
  }
  if (mine && !pending && deps.isEditableContent?.(m.content)) {
    items.push({ label: "Edit", icon: icons.edit, onClick: () => startBroadcastEdit(m) });
  }
  const firstLink = (String(text || "").match(/https?:\/\/[^\s<>"']+/) || [])[0] || null;
  // A Nextcloud share is the address of someone's photo or file: it can be opened, never copied
  // out to forward (iOS BroadcastChannelView, same rule as the preview card).
  const share = Boolean(firstLink && deps.isNextcloudShareLink?.(firstLink));
  if (firstLink) {
    items.push({ label: "Open Link", icon: icons.explorer, onClick: () => window.open(firstLink, "_blank", "noopener,noreferrer") });
    if (!share) items.push({ label: "Copy Link", icon: icons.link || icons.copy, onClick: () => deps.copyText?.(firstLink).catch(() => {}) });
  }
  if (text && !deps.parseAudioEnvelope?.(m.content) && !deps.isNextcloudShareLink?.(text)) {
    items.push({
      label: "Copy Message", icon: icons.copy,
      onClick: () => deps.copyText?.(text).then(() => deps.showToast?.("Message copied.")).catch(() => {}),
    });
  }
  // Report, on someone else's message (KaPosts-iPhone 9e22075), under Copy as on iOS.
  if (!mine) {
    items.push({ label: "Report", hint: "Report abusive or objectionable content. Opens an email with this message attached.", icon: icons.flag || icons.info, onClick: () => reportBroadcastMessage(m) });
  }
  // Delete for Everyone (K e4062188): your own delivered message, not a voice note (a long one is
  // several transactions), never in the machinery rooms.
  if (mine && !pending && !deps.parseAudioEnvelope?.(m.content) && !roomParts.clusters.get(m.txId)
      && !isServiceBroadcastChannel(activeChannel) && /^[0-9a-f]{64}$/i.test(String(m.txId || ""))) {
    items.push({ label: "Delete for Everyone", hint: "Removes it from this room for everyone using K.", icon: icons.trash, danger: true, onClick: () => confirmDeleteForEveryone(m) });
  }
  // Translate (iOS 03e5128): someone else's plain text, in a language other than the reader's.
  // Public rooms only - the text is public already; 1:1 and group messages never leave the device.
  const translation = deps.translation;
  if (translation && !mine && !pending && translatableText(m)) {
    const key = translationKeyFor(m);
    const state = translation.state(key);
    if (state?.status === "translated") {
      items.push(state.showingOriginal
        ? { label: "Show Translation", icon: icons.info, onClick: () => translation.showTranslation(key) }
        : { label: "Show Original", icon: icons.info, onClick: () => translation.showOriginal(key) });
    } else if ((!state || state.status === "failed") && translation.canOffer(key, translatableText(m))) {
      // iOS MessageAction.translate(into:): "Translate", saying the language underneath.
      items.push({ label: "Translate", hint: `Shows this message in ${translation.readerLanguageName()}.`, icon: icons.info, onClick: () => translation.translate(key, translatableText(m)) });
    }
  }
  if (!pending && deps.explorerTxUrl) {
    items.push({
      label: "View in Explorer", icon: icons.explorer,
      onClick: () => window.open(deps.explorerTxUrl(m.txId), "_blank", "noopener,noreferrer"),
    });
  }
  const noteCluster = roomParts.clusters.get(m.txId);
  if (mine && (noteCluster ? noteCluster.status === "failed" : m.status === "failed")) {
    // A note's bubble resends only its failed parts, in place and in order.
    items.push({ label: "Retry Send", icon: icons.retry, onClick: () => (noteCluster ? retryRoomParts(activeChannel, noteCluster) : retryBroadcastMessage(m)) });
  }
  if (mine && failedRoomEdits.has(failedRoomEditKey(activeChannel, m.txId))) {
    items.push({ label: "Retry Edit", icon: icons.retry, onClick: () => retryFailedRoomEdit(activeChannel, m.txId) });
  }
  const reactionEntries = Object.entries(perReactor).filter(([, entry]) => !entry.removed)
    .map(([reactorAddress, entry]) => ({ emoji: entry.emoji, reactorAddress }));
  if (reactionEntries.length) {
    items.push({
      label: `Reactions (${reactionEntries.length})`, icon: icons.heart || icons.info,
      onClick: () => deps.showReactionsSheet?.({
        entries: reactionEntries,
        nameFor: (address) => senderName(address),
        avatarFor: (address) => deps.avatarHtmlForAddress?.(address, "chat-avatar reactions-sheet-avatar") || "",
      }),
    });
  }
  // Hiding a sender is the avatar's sheet only (iOS), not this menu.
  deps.openMsgContextMenu({
    x, y,
    reaction: pending ? null : { current, onPick: (emoji) => sendBroadcastReaction(m.txId, emoji) },
    items,
  });
}

async function confirmDeleteForEveryone(m) {
  const channel = activeChannel;
  const ok = await confirmDialog({
    title: "Delete for Everyone?",
    message: "It goes from this room for everyone using K. It stays on the Kaspa network, where anyone reading the chain can still find it. Deleting costs a small network fee.",
    confirmLabel: "Delete",
    destructive: true,
  });
  if (!ok || !channel) return;
  deleteBroadcastMessageForEveryone(channel, m);
}
/** Deletes one of your own delivered room messages for everyone (K deletePublicChatMessage): the
 *  delete goes out as one transaction, like an edit, and once it has the message goes from here and
 *  is remembered as deleted. A failed send changes nothing; one whose outcome is unknown leaves it
 *  too: if it landed, its own delete comes back through the room's reads and removes it then. */
async function deleteBroadcastMessageForEveryone(channel, m) {
  const me = deps.engine.address || "";
  if (!me || isServiceBroadcastChannel(channel) || m.status || m.senderAddress !== me
      || !/^[0-9a-f]{64}$/i.test(String(m.txId || ""))) return false;
  if (deps.isChattingBalanceZero?.()) { deps.showFundingGate?.(); return false; }
  try {
    await sendBroadcastText(channel, encodeRoomDelete(m.txId), { showBubble: false });
  } catch (error) {
    deps.appendEngineLog?.(`Broadcast delete send failed: ${error.message}`);
    if (error?.code !== SEND_OUTCOME_UNKNOWN) deps.showToast?.("Couldn't delete the message. Try again.");
    return false;
  }
  if (broadcastReplyTarget?.txId === m.txId) cancelBroadcastReply();
  if (broadcastEditTarget?.txId === m.txId) cancelBroadcastComposeBanner();
  recordRoomDelete(channel, m.txId, me);
  if (removeRoomRows(channel, (messageCache[channel] ||= []), [m.txId])) saveCache();
  if (activeChannel === channel) renderRoom();
  renderChannelList();
  return true;
}

/** Human text for previews/notifications: unwrap replies, name photos/voice notes. */
function humanizeBroadcastContent(content) {
  if (deps.parseEditEnvelope?.(content)) return "Edited a message";
  const reply = deps.parseReplyEnvelope?.(content);
  if (reply) return reply.text || "Reply";
  if (deps.parseImageEnvelope?.(content)) return "📷 Photo";
  if (deps.parseAudioEnvelope?.(content)) return "🎤 Audio message";
  return String(content || "");
}

function appendReactionUi(el, m) {
  if (m.status) return; // pending/failed rows have no on-chain txid to react to
  const perReactor = reactionsOn(activeChannel, m.txId);

  // No hover bar: reacting is the right-click menu (and double-click), like everywhere else.

  // The pill under the bubble (iOS ReactionPillView): which emoji are on it, with counts. It is
  // not a button - your own reaction comes off the way it went on, from the menu or the bar.
  const entries = Object.values(perReactor).filter((entry) => !entry.removed);
  const status = broadcastReactionStatus.get(m.txId) || null;
  if (entries.length) {
    const chips = document.createElement("div");
    chips.className = "message-reaction-pill";
    // Your reaction's delivery, once per pill: nothing while it is in flight, a green check for
    // ten minutes once it is on chain, a red mark (and the pill outlined) when it failed.
    const statusEl = broadcastReactionStatusEl(status);
    if (statusEl) chips.append(statusEl);
    if (status?.status === "failed") chips.classList.add("failed");
    const counts = new Map();
    for (const entry of entries) counts.set(entry.emoji, (counts.get(entry.emoji) || 0) + 1);
    for (const [emoji, count] of counts) {
      const chip = document.createElement("span");
      chip.className = "message-reaction-pill-entry";
      chip.textContent = emoji;
      if (count > 1) {
        const countEl = document.createElement("span");
        countEl.className = "message-reaction-pill-count";
        countEl.textContent = String(count);
        chip.append(countEl);
      }
      chips.append(chip);
    }
    el.append(chips);
    el.classList.add("has-reactions");
  }
  // A reaction of yours that failed to send: a red "Retry" by the time line (iOS, under the
  // message); the pill hangs off the bubble's bottom edge, so it goes just above that line.
  if (status?.status === "failed" && status.retry) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "broadcast-reaction-retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", (event) => { event.stopPropagation(); status.retry(); });
    const timeLine = el.querySelector(".broadcast-time-line");
    if (timeLine) el.insertBefore(retry, timeLine); else el.append(retry);
  }
}

// The room holds its newest window; "Load earlier messages" at the top widens it without
// throwing the reader to the bottom when the older rows land (iOS 02a4f58).
const ROOM_WINDOW = 400;
let roomWindow = ROOM_WINDOW;
let roomWindowChannel = null;
let keepInPlaceAfterOlderLoad = null;   // { height, top } of the scroller before the widen
let lastRenderedNewestKey = null;       // the newest row the room last drew
let lastRenderedCount = 0;
// Where the reader is in the open room (K d089011f): a room hidden behind another tab (a profile
// opened from it, any other tab) comes back at the same place; only a reader who was at the newest
// message is taken to the newest. A hidden room has no layout, so the browser loses its scroll and
// a render there can't keep it: the place is noted while it's on screen and put back on return.
let roomScrollPlace = null;             // { channel, top, atBottom }
let roomPlacePending = false;
function noteRoomScrollPlace() {
  // while a place waits to be put back, the browser's own scroll on return isn't the reader's
  if (roomPlacePending || !roomBodyEl || !activeChannel || roomBodyEl.clientHeight === 0) return;
  roomScrollPlace = {
    channel: activeChannel,
    top: roomBodyEl.scrollTop,
    atBottom: roomBodyEl.scrollHeight - roomBodyEl.scrollTop - roomBodyEl.clientHeight < 60,
  };
}
/** Puts the reader back where they were once the room is laid out again. True when it did. */
function restoreRoomScrollPlace() {
  if (!roomPlacePending || !roomBodyEl || roomBodyEl.clientHeight === 0) return false;
  roomPlacePending = false;
  const place = roomScrollPlace;
  if (!place || place.channel !== activeChannel) return false;
  roomBodyEl.scrollTop = place.atBottom ? roomBodyEl.scrollHeight : place.top;
  noteRoomScrollPlace();
  return true;
}
function loadEarlierRoomMessages() {
  if (!roomBodyEl) return;
  keepInPlaceAfterOlderLoad = { height: roomBodyEl.scrollHeight, top: roomBodyEl.scrollTop };
  roomWindow += ROOM_WINDOW;
  renderRoom();
}
function renderRoom() {
  const inRoom = Boolean(activeChannel);
  if (inRoom && roomWindowChannel !== activeChannel) { roomWindowChannel = activeChannel; roomWindow = ROOM_WINDOW; keepInPlaceAfterOlderLoad = null; lastRenderedNewestKey = null; lastRenderedCount = 0; }
  if (roomEl) roomEl.hidden = !inRoom;
  // The room takes the detail pane beside the Chats list (the app decides what that means for
  // the layout).
  deps.onRoomVisibility?.(inRoom);
  if (!inRoom) return;

  if (roomTitleEl) roomTitleEl.textContent = `#${activeChannel}`;
  // A room you made yourself says what "public" does and does not mean. Rooms the indexer tracks
  // keep their history there, so they need no such warning (iOS 21c480d).
  const aboutButton = document.querySelector("[data-broadcast-own-room-about]");
  if (aboutButton) aboutButton.hidden = isIndexerTrackedBroadcastChannel(activeChannel);
  syncRoomBell();
  if (composerInput) composerInput.placeholder = `Message #${activeChannel}`;
  // No in-room retention banner: iOS removed it so the room reads clean. The 30-day rule is
  // stated once, beside the Popular header in the channel list.
  updateVoiceButtonVisibility();
  syncBroadcastFundingGate();

  const hidden = hiddenIn(activeChannel);
  const visibleRoomMessages = (messageCache[activeChannel] || []).filter((m) =>
    !hidden.has(m.senderAddress) && !deps.parseReactionEnvelope?.(m.content) && !deps.parseEditEnvelope?.(m.content));
  // A long voice note: one bubble at its first part, the others hidden (KaPost 1b15521).
  roomParts = groupParts(visibleRoomMessages, ROOM_PART_ACCESSORS);
  for (const [key, cluster] of roomParts.clusters) {
    // Rooms draw no photos: a multi-part photo's chunks stay as they are.
    if (cluster.kind !== "voice") { roomParts.clusters.delete(key); for (const m of cluster.members) roomParts.hidden.delete(m.txId); }
  }
  const allMessages = roomParts.hidden.size ? visibleRoomMessages.filter((m) => !roomParts.hidden.has(m.txId)) : visibleRoomMessages;
  const messages = allMessages.length > roomWindow ? allMessages.slice(-roomWindow) : allMessages;
  if (roomBodyEl) {
    const before = { height: roomBodyEl.scrollHeight, top: roomBodyEl.scrollTop, client: roomBodyEl.clientHeight };
    // hidden behind another tab: no layout to keep a place in, so it's put back on return
    const laidOut = before.client > 0;
    if (!laidOut && roomScrollPlace?.channel === activeChannel) roomPlacePending = true;
    roomBodyEl.replaceChildren();
    if (allMessages.length > messages.length) {
      const earlier = document.createElement("button");
      earlier.type = "button";
      earlier.className = "broadcast-load-earlier";
      earlier.textContent = "Load earlier messages";
      earlier.addEventListener("click", loadEarlierRoomMessages);
      roomBodyEl.append(earlier);
    }
    if (messages.length === 0) {
      const empty = document.createElement("div");
      empty.className = "no-results-card";
      // The same words in every room (iOS emptyState); a room you made says what "public" means
      // behind its info button instead.
      empty.innerHTML = `<strong>No messages yet</strong><span>Be the first to post in #${deps.escapeHtml(activeChannel)}.</span>`;
      roomBodyEl.append(empty);
    } else {
      // "Today"/"Yesterday"/date pill whenever the calendar day changes (iOS parity;
      // same pill class + label formatter as 1:1 and group chats).
      let lastDayKey = "";
      for (const m of messages) {
        const ts = Number(m.blockTime) || Date.now();
        const dayKey = new Date(ts).toDateString();
        if (dayKey !== lastDayKey && deps.daySeparatorLabel) {
          lastDayKey = dayKey;
          const sep = document.createElement("div");
          sep.className = "message-day-separator";
          const pill = document.createElement("span");
          pill.textContent = deps.daySeparatorLabel(ts);
          sep.append(pill);
          roomBodyEl.append(sep);
        }
        roomBodyEl.append(buildMessageRow(m));
      }
    }
    // The room goes to the bottom only when its NEWEST message changes (iOS 9c9e3e0). A backfill
    // page of older history, a reaction or a translation must not throw a reader who scrolled
    // into history back down: older rows landing above keep what was on screen where it was.
    const newest = messages[messages.length - 1];
    const newestKey = newest ? String(newest.txId || newest.id || "") : "";
    const wasAtBottom = before.height - before.top - before.client < 60;
    if (!laidOut && roomPlacePending) {
      // nothing to measure: the place comes back with the room (restoreRoomScrollPlace)
    } else if (restoreRoomScrollPlace()) {
      // back from another tab: where the reader was, or the newest if they were there
    } else if (keepInPlaceAfterOlderLoad) {
      const { height, top } = keepInPlaceAfterOlderLoad;
      keepInPlaceAfterOlderLoad = null;
      roomBodyEl.scrollTop = roomBodyEl.scrollHeight - height + top;
    } else if (lastRenderedNewestKey === null || wasAtBottom
      || (newestKey !== lastRenderedNewestKey && newest?.senderAddress === deps.engine.address)) {
      // First paint, a reader already at the bottom, or a new newest message of your own: to the
      // bottom (iOS onChange of messages.last?.id). Someone reading further up stays where they
      // are when someone else's message comes in (iOS e5a9b11).
      roomBodyEl.scrollTop = roomBodyEl.scrollHeight;
    } else if (newestKey !== lastRenderedNewestKey) {
      // The new rows landed below what is on screen: it stays put.
      roomBodyEl.scrollTop = before.top;
    } else if (messages.length !== lastRenderedCount) {
      roomBodyEl.scrollTop = before.top + (roomBodyEl.scrollHeight - before.height);
    } else {
      roomBodyEl.scrollTop = before.top;
    }
    lastRenderedNewestKey = newestKey;
    lastRenderedCount = messages.length;
    noteRoomScrollPlace();
  }
}

// Zero-balance gate (iOS ZeroBalanceFundingCardView above a greyed compose bar): reading stays
// fully usable, only composing is blocked, and the card says where to send the KAS.
let fundingGateQrDrawnFor = null;
function syncBroadcastFundingGate() {
  const gate = document.querySelector("[data-broadcast-funding-gate]");
  const bar = composerInput?.closest(".kaposts-reply-bar");
  if (!gate) return;
  const address = deps.chattingAddress?.() || deps.engine.address || "";
  const gated = Boolean(activeChannel) && Boolean(address) && Boolean(deps.isChattingBalanceZero?.());
  gate.hidden = !gated;
  bar?.classList.toggle("gated", gated);
  if (composerInput) composerInput.disabled = gated;
  if (!gated) return;
  const addressEl = gate.querySelector("[data-broadcast-funding-gate-address]");
  if (addressEl) addressEl.textContent = address;
  const canvas = gate.querySelector("[data-broadcast-funding-gate-qr]");
  if (canvas && fundingGateQrDrawnFor !== address && deps.drawQr) {
    fundingGateQrDrawnFor = address;
    deps.drawQr(canvas, address).then(() => { canvas.style.width = "160px"; canvas.style.height = "160px"; })
      .catch(() => { fundingGateQrDrawnFor = null; });
  }
}

// The fee pill (iOS feeBubble): "fee: -------- KAS" shimmering while the estimate is in flight,
// the value underlined once it lands (a tap edits it), hidden with Show Fee Estimate off.
let feeTimer = null;
let feeToken = 0;
function formatKasExact(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(8) : "--";
}
function renderFeePill(feeKas, { estimating = false } = {}) {
  const pill = document.querySelector("[data-broadcast-fee]");
  if (!pill) return;
  pill.classList.toggle("estimating", estimating);
  const label = estimating && feeKas == null ? `fee: -------- ${KAS_UNIT}`
    : feeKas == null ? `fee: -- ${KAS_UNIT}` : `fee: ${formatKasExact(feeKas)} ${KAS_UNIT}`;
  if (pill.textContent !== label) pill.textContent = label;
  pill.hidden = false;
}
function hideFeePill() {
  if (feeTimer) clearTimeout(feeTimer);
  feeTimer = null;
  feeEstimateKas = null;
  feeEstimateLength = null;
  const pill = document.querySelector("[data-broadcast-fee]");
  if (pill) pill.hidden = true;
}
// As the 1:1/group composers (iOS 0977a5b): each estimate fetches UTXOs and builds a transaction,
// and the fee follows the payload size, so while TYPING it waits for a 0.6 s pause and is skipped
// while the message is within 24 bytes of the estimated length; other callers force it.
function scheduleBroadcastFeeEstimate({ typing = false } = {}) {
  const text = String(composerInput?.value || "").trim();
  if (!activeChannel || !text || !deps.showFeeEstimate?.() || !deps.estimateFeeKas) { hideFeePill(); return; }
  if (feeOverrideKas != null) { renderFeePill(feeOverrideKas); return; }
  const length = new TextEncoder().encode(text).length;
  if (typing && !feeTimer && feeEstimateKas != null && feeEstimateLength != null
      && Math.abs(length - feeEstimateLength) < 24
      && !document.querySelector("[data-broadcast-fee]")?.hidden) return;
  if (feeTimer) clearTimeout(feeTimer);
  feeTimer = null;
  const token = ++feeToken;
  renderFeePill(feeEstimateKas, { estimating: true });
  feeTimer = setTimeout(async () => {
    feeTimer = null;
    try {
      const fee = await deps.estimateFeeKas(broadcastPayloadBytes(activeChannel, text));
      if (token !== feeToken) return;
      feeEstimateKas = fee == null ? null : String(fee);
      feeEstimateLength = fee == null ? null : length;
      renderFeePill(feeEstimateKas);
    } catch {
      if (token !== feeToken) return;
      feeEstimateLength = null;
      renderFeePill(null);
    }
  }, typing ? 600 : 200);
}
async function editBroadcastFee() {
  const pill = document.querySelector("[data-broadcast-fee]");
  if (!pill || pill.classList.contains("estimating")) return;
  const current = feeOverrideKas ?? feeEstimateKas;
  if (current == null) return;
  const typed = await promptDialog({
    title: "Adjust Network Fee",
    label: `Fee (${KAS_UNIT})`,
    message: "If the network is busy, a higher fee can help your transaction confirm faster.",
    initial: formatKasExact(current),
    confirmLabel: "Save",
    extraLabel: "Use Default",
  });
  if (typed == null) return;
  // "Use Default" (iOS fee alert): back to the live estimate.
  if (typed === PROMPT_EXTRA) { feeOverrideKas = null; scheduleBroadcastFeeEstimate(); return; }
  // The one exact parser (iOS IOS-010), kept as exact KAS text.
  const typedSompi = String(typed).trim() === "" ? 0n : sompiFromUserText(String(typed));
  if (typedSompi === 0n) { feeOverrideKas = null; scheduleBroadcastFeeEstimate(); return; }
  if (typedSompi == null) { deps.showToast?.(`Enter a fee in ${KAS_UNIT}.`); return; }
  feeOverrideKas = kasTextFromSompi(typedSompi);
  renderFeePill(feeOverrideKas);
}


// ---------------------------------------------------------------------------
// Voice notes: on chain (10 s), or via Nextcloud when chosen at the mic
// ---------------------------------------------------------------------------

function updateVoiceButtonVisibility() {
  syncComposerButtons();
}

/** The composer's one button (iOS sendOrRecordButton): the mic while the field is empty, the
 *  send arrow once there is text. Nextcloud only changes where a voice note's bytes go. */
function syncComposerButtons() {
  const hasText = Boolean(String(composerInput?.value || "").trim());
  if (voiceBtn) voiceBtn.hidden = hasText;
  if (sendBtn) sendBtn.hidden = !hasText;
}

// The room's own recording bar (iOS recordingBar), drawn here rather than by the 1:1/group
// composers' shared panel: trash, a red mic, "Recording... Ns" (or "Encoding…" once stopped) and
// the send arrow. It takes the composer's place while it is up. There is no preview step in a
// room: the arrow - or the length cap - sends the note at once.
function showRecordingBar(state) { // "recording" | "encoding" | null
  if (!voicePanelEl) return;
  const bar = composerInput?.closest(".kaposts-reply-bar");
  voicePanelEl.hidden = !state;
  if (bar) bar.hidden = Boolean(state);
  if (!state) return;
  const timeEl = voicePanelEl.querySelector("[data-broadcast-voice-time]");
  // "Recording... 00:10 / 02:50" toward the limit (KaPost 1b15521).
  const limit = voiceViaNextcloud && deps.isNextcloudConnected?.() ? (Number(deps.nextcloudVoiceMaxSeconds) || VOICE_MAX_DURATION_SECONDS) : onchainVoiceMaxSeconds();
  const mmss = (value) => { const total = Math.max(0, Math.round(Number(value) || 0)); return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`; };
  if (timeEl) timeEl.textContent = state === "encoding" ? "Encoding…" : `Recording... ${mmss(voiceRecordedSeconds)} / ${mmss(limit)}`;
  const send = voicePanelEl.querySelector("[data-broadcast-voice-stop]");
  if (send) send.disabled = state === "encoding";
}

// A Nextcloud share link's worst-case payload size (iOS nextcloudLinkPayloadSize).
const NEXTCLOUD_LINK_PAYLOAD_BYTES = 96;
let recordingFeeBytes = null;
/** The fee pill while recording (iOS updateRecordingFeeEstimate): the final size is not known
 *  until the note is done, so on chain it is 150 bytes plus 2870 per second recorded; via
 *  Nextcloud the chain only carries the share link. Asked once per new size. */
function updateRecordingFeeEstimate(elapsedSeconds) {
  if (!deps.showFeeEstimate?.() || !deps.estimateFeeKas) return;
  const viaNextcloud = voiceViaNextcloud && Boolean(deps.isNextcloudConnected?.());
  // On chain with the long-note encoder: the parts the note makes so far, each its own
  // transaction (KaPost estimatePublicChatVoiceFee), as base64 JSON in the room payload.
  const partBytes = !viaNextcloud && VoiceNotes.longVoiceNotesSupported()
    ? voicePartSizes(Math.max(1, Math.floor(Number(elapsedSeconds) || 0)), VOICE_PATHS.room).map((size) => 260 + 4 * Math.ceil(size / 3))
    : null;
  const bytes = viaNextcloud ? NEXTCLOUD_LINK_PAYLOAD_BYTES : partBytes ? partBytes.join(",") : Math.floor(150 + Math.floor(Number(elapsedSeconds) || 0) * 2870);
  if (bytes === recordingFeeBytes) return;
  recordingFeeBytes = bytes;
  renderFeePill(feeOverrideKas ?? feeEstimateKas);
  const token = ++feeToken;
  const estimate = partBytes ? sumPartFees(partBytes, deps.estimateFeeKas) : deps.estimateFeeKas(bytes);
  Promise.resolve(estimate).then((fee) => {
    if (token !== feeToken || !voiceRecorder?.isRecording()) return;
    feeEstimateKas = fee == null ? null : String(fee);
    renderFeePill(feeOverrideKas ?? feeEstimateKas);
  }).catch(() => {});
}
/** The fees of parts of these payload sizes, asked once per distinct size. */
async function sumPartFees(sizes, estimate) {
  const bySize = new Map();
  for (const size of sizes) bySize.set(size, (bySize.get(size) || 0) + 1);
  let total = 0;
  for (const [size, count] of bySize) {
    const fee = Number(await estimate(size));
    if (!Number.isFinite(fee)) return null;
    total += fee * count;
  }
  return Number(total.toFixed(8));
}
function endRecordingFee() {
  recordingFeeBytes = null;
  feeToken += 1;
  hideFeePill();
}

function ensureVoiceRecorder() {
  if (voiceRecorder || !deps.createVoiceRecorder) return voiceRecorder;
  voiceRecorder = deps.createVoiceRecorder({
    maxDurationSeconds: () => (voiceViaNextcloud && deps.isNextcloudConnected?.()
      ? (Number(deps.nextcloudVoiceMaxSeconds) || VOICE_MAX_DURATION_SECONDS)
      : onchainVoiceMaxSeconds()),
    onElapsed: (elapsed) => {
      voiceRecordedSeconds = elapsed;
      if (voiceRecordingChannel) {
        showRecordingBar("recording");
        updateRecordingFeeEstimate(elapsed);
      }
    },
    onFinish: handleVoiceRecordingFinished,
  });
  return voiceRecorder;
}

async function startVoiceRecording() {
  if (!activeChannel) return;
  if (deps.isChattingBalanceZero?.()) {
    deps.showFundingGate?.();
    return;
  }
  const recorder = ensureVoiceRecorder();
  // A second tap while the mic prompt is up is ignored rather than opening another stream.
  if (!recorder || recorder.isRecording() || recorder.isStarting?.()) return;
  // With a Nextcloud server connected the mic asks on chain or via Nextcloud, like the "+" sheet's
  // Voice Message in 1:1 and group chats (iOS 8b13460); Back closes the question. Without one it
  // records on chain straight away.
  const channel = activeChannel;
  if (deps.isNextcloudConnected?.() && deps.chooseMediaRoute) {
    const route = await deps.chooseMediaRoute("voice");
    if (route !== "chain" && route !== "nextcloud") return;
    if (activeChannel !== channel || recorder.isRecording() || recorder.isStarting?.()) return;
    voiceViaNextcloud = route === "nextcloud";
  } else {
    voiceViaNextcloud = false;
  }
  voiceRecordingChannel = activeChannel;
  voiceRecordedSeconds = 0;
  const error = await recorder.start();
  if (error) {
    if (error === "Microphone access was denied." && deps.showMicrophoneAccessAlert) deps.showMicrophoneAccessAlert();
    else deps.showToast?.(error);
    voiceRecordingChannel = null;
    voiceViaNextcloud = false;
    return;
  }
  // Cancelled (trash, room left) while the mic prompt was up: nothing is recording.
  if (!recorder.isRecording()) return;
  showRecordingBar("recording");
  updateRecordingFeeEstimate(0);
}

// The arrow on the bar, and the length cap, both end here: the note goes straight out (iOS
// stopAndSendRecording). The trash ends here too, cancelled.
async function handleVoiceRecordingFinished({ blob, mimeType, cancelled }) {
  const channel = voiceRecordingChannel;
  voiceRecordingChannel = null;
  const seconds = Math.round(Number(voiceRecordedSeconds) || 0);
  endRecordingFee();
  if (cancelled || !blob || !channel) {
    voiceViaNextcloud = false;
    showRecordingBar(null);
    return;
  }
  showRecordingBar("encoding");
  try {
    await sendBroadcastVoice({ blob, mimeType, channel, seconds });
  } finally {
    if (!voiceRecorder?.isRecording()) showRecordingBar(null);
  }
}
async function sendBroadcastVoice({ blob, mimeType, channel, seconds }) {
  // Via Nextcloud the bytes go to the server and the room gets the share link (an audio card on
  // every client). Otherwise, or when the upload fails, the note goes on chain in the same
  // envelope 1:1 and group voice notes use. Wording as iOS stopAndSendRecording.
  const viaNextcloud = voiceViaNextcloud && Boolean(deps.isNextcloudConnected?.());
  voiceViaNextcloud = false;
  try {
    if (viaNextcloud) {
      let url = null;
      try {
        showRecordingBar(null);
        url = await deps.uploadNextcloudMedia(blob, `voice_${Date.now()}.${(deps.voiceFileName?.(mimeType) || "voice.webm").split(".").pop()}`, mimeType);
      } catch (error) {
        deps.appendEngineLog?.(`Broadcast voice note upload failed: ${error.message}`);
        // The on-chain envelope is capped: a longer note would arrive cut short, so say so instead.
        if (seconds > onchainVoiceMaxSeconds()) {
          deps.showToast?.("Nextcloud upload failed, and the recording is too long to send on-chain.");
          return;
        }
        deps.showToast?.("Nextcloud upload failed - sending on-chain instead");
      }
      if (url) {
        await sendBroadcastText(channel, url);
        renderChannelList();
        return;
      }
    }
    // 16 kbps Opus in 60 ms frames, as parts of up to 14.5 s (KaPost 1b15521).
    if (VoiceNotes.longVoiceNotesSupported()) {
      const { parts } = await VoiceNotes.prepareVoiceParts(blob, VOICE_PATHS.room);
      const envelopes = VoiceNotes.voicePartEnvelopes(parts);
      if (!voiceRecorder?.isRecording()) showRecordingBar(null);
      if (envelopes.length === 1) {
        await sendBroadcastText(channel, envelopes[0], { feeKas: feeOverrideKas });
        feeOverrideKas = null;
        renderChannelList();
        return;
      }
      // The whole note's fees first, before a single part goes out.
      const fees = await Promise.all(envelopes.map((text) => Promise.resolve(deps.estimateFeeKas?.(new TextEncoder().encode(text).length + 40)).catch(() => null)));
      const shortfall = deps.partsBalanceShortfall?.(fees);
      if (shortfall) { deps.showToast?.(shortfall); return; }
      feeOverrideKas = null;
      await sendRoomParts(channel, envelopes);
      return;
    }
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => resolve("");
      reader.readAsDataURL(blob);
    });
    if (!dataUrl.startsWith("data:")) throw new Error("Could not process the recording.");
    const envelope = JSON.stringify({ type: "file", name: deps.voiceFileName?.(mimeType) || "voice.webm", size: blob.size, mimeType: mimeType || "audio/webm", content: dataUrl, duration: seconds });
    if (!voiceRecorder?.isRecording()) showRecordingBar(null);
    await sendBroadcastText(channel, envelope, { feeKas: feeOverrideKas });
    feeOverrideKas = null;
    renderChannelList();
  } catch (error) {
    deps.showToast?.(roomSendErrorText(error, "Failed to send voice message: "));
    deps.appendEngineLog?.(`Broadcast voice note failed: ${error.message}`);
  }
}
let voiceRecordedSeconds = 0;

function cancelVoiceRecordingIfActive() {
  // Also a start still on the mic prompt, so it can't go on to record with no bar showing it.
  if (voiceRecorder?.isRecording() || voiceRecorder?.isStarting?.()) voiceRecorder.stop(true);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function openRoom(channel) {
  if (normalizeBroadcastChannel(channel) !== activeChannel) {
    releaseTypingFocus();
    // its first read removes a missing message on one miss (K d089011f)
    firstMissRemovesChannels.add(normalizeBroadcastChannel(channel));
  }
  activeChannel = normalizeBroadcastChannel(channel);
  // Every default room is joined at load (iOS 865c9ab) unless it was switched off; a link or a
  // notification can still open one that isn't, and opening it is what creates its row.
  if (activeChannel && isCuratedBroadcastChannel(activeChannel) && !joinedChannels.includes(activeChannel)) {
    joinedChannels.push(activeChannel);
    saveChannels();
    if (!joinedAtByChannel[activeChannel]) { joinedAtByChannel[activeChannel] = Date.now(); saveJoinedAt(); }
    renderChannelList();
  }
  cancelBroadcastReply(); // a reply drafted in another room must not leak across
  feeOverrideKas = null;
  hideFeePill();
  closeRoomInfo();
  markChannelRead(activeChannel);
  renderChannelList();
  renderRoom();
  // What was typed here last time comes back (iOS 360e5d2).
  if (composerInput) composerInput.value = deps.readDraft?.(`room:${activeChannel}`) || "";
  syncComposerButtons();
  // Only the rooms the indexer tracks have history behind them, so only they backfill and poll.
  // Any other room is asked once, quietly: rows back mean the indexer tracks it after all (one
  // the operator added), and it turns into a tracked room at once (iOS 21c480d).
  if (isIndexerTrackedBroadcastChannel(activeChannel)) {
    backfillChannel(activeChannel, { quiet: true });
    startPolling(activeChannel);
  } else {
    stopPolling();
    // A room with no indexer has no history coming to wait for (iOS e5a9b11).
    if (settlePendingFromEarlierRuns(activeChannel)) renderRoom();
    probeIndexerForRoom(activeChannel);
  }
  syncScanWanted();
}

// One newest-row ask for a room the indexer is not known to track (iOS asks the indexer for
// every room; an indexer stores only rooms it tracks). Nothing is merged or logged here: rows
// back mark the room as served in the engine, and handleTrackedRoomsChanged takes it from there.
async function probeIndexerForRoom(channel) {
  const baseUrl = indexerOverrideFor(channel) || null;
  if (!baseUrl && !hasBroadcastIndexer()) return;
  try { await fetchBroadcastHistory({ channel, limit: 1, baseUrl }); }
  catch { /* a live room: nothing to say */ }
}

// The set of tracked rooms changed (the indexer listed a room, or returned rows for one): the
// live scan, the sweep, the wording and retention follow at once (iOS 21c480d). An open room
// that turned out to be tracked gets its history and the 8 s poll, as a default room does.
function handleTrackedRoomsChanged() {
  if (!deps) return;
  // a room the operator just added on the indexer joins (bell off), and a switched-off one it
  // dropped a week ago is left (K 961fc05a IndexerTrackedRooms.didChange)
  if (deps.engine?.address) joinDefaultRooms();
  syncScanWanted();
  renderChannelList();
  if (!activeChannel) return;
  renderRoom();
  if (tabVisible && !pollTimer && isIndexerTrackedBroadcastChannel(activeChannel)) {
    const channel = activeChannel;
    backfillChannel(channel, { quiet: true });
    startPolling(channel);
  }
}

function closeRoom() {
  releaseTypingFocus();
  cancelVoiceRecordingIfActive();
  cancelBroadcastReply();
  roomMentionList?.close();
  if (activeChannel && composerInput) deps.saveDraft?.(`room:${activeChannel}`, composerInput.value);
  activeChannel = null;
  stopPolling();
  syncScanWanted();
  renderRoom();
  renderChannelList();
}

/** Why `name` (already normalized) can't be joined, or null. Shared by the join card's alert and
 *  the Chats New sheet, which shows the message in place (iOS joinRoomFromCreateSheet). */
// The only rule is the name's (iOS joinRoomFromCreateSheet): a service room such as #chess-arena
// joins like any other and simply stays out of the lists.
function broadcastJoinProblem(name) {
  if (!isValidBroadcastChannel(name)) return { title: "Couldn't Join Channel", message: "Channel names must be 1-36 characters with no spaces or colons." };
  return null;
}

/** The Chats New sheet's "New Public Chat": "" when the name is fine to join, otherwise the
 *  sentence to show under the field. Nothing is joined here - the caller clears the detail pane
 *  first, then calls joinBroadcastChannelFromSheet, which opens the room there. */
export function broadcastJoinError(rawName) {
  if (!deps) return "Something went wrong joining that channel.";
  return broadcastJoinProblem(normalizeBroadcastChannel(rawName))?.message || "";
}

/** Joins (or reopens) the room and opens it, as the join card does. */
export function joinBroadcastChannelFromSheet(rawName) {
  if (!deps) return false;
  // a retired room's name opens the room that replaced it (K 961fc05a)
  const name = replacementBroadcastChannel(rawName);
  if (broadcastJoinProblem(name)) return false;
  joinChannel(name);
  return true;
}

/// Joins a room without opening it (the list, the circles row and syncing pick it up). A room the
/// person adds starts with its bell ON (K 824a30bb, owner 2026-11-26: they chose it); one already
/// joined keeps its bell, and machinery rooms (chess, the bots, the arcade) stay silent.
function addJoinedChannel(name) {
  if (joinedChannels.includes(name)) return;
  joinedChannels.push(name);
  saveChannels();
  joinedAtByChannel[name] = Date.now();
  saveJoinedAt();
  if (!isServiceBroadcastChannel(name)) {
    notifyByChannel[name] = true;
    saveNotify();
    deps.ensureNotificationPermission?.();
    syncScanWanted();
  }
}

function joinChannel(rawName) {
  // a retired room's name (#kachat-bugs) opens the room that replaced it (K 961fc05a)
  const name = replacementBroadcastChannel(rawName);
  const problem = broadcastJoinProblem(name);
  if (problem) {
    alertDialog(problem);
    return;
  }
  addJoinedChannel(name);
  renderChannelList();
  openRoom(name);
}

function leaveChannel(name) {
  // Any room can be left, default rooms too (K 824a30bb: every room is one the person added).
  forgetRoom(name);
  if (activeChannel === name) closeRoom();
  // left: its pin in the Chats row goes too (K 518fdc8c dropRoomPin)
  try { deps.onRoomRemoved?.(name); } catch { /* the app's pins */ }
  syncScanWanted();
  renderChannelList();
}

async function sendCurrentMessage() {
  if (sendInFlight || !activeChannel || !composerInput) return;
  // Broadcast messages cost KAS too — same funding popup as chats when the
  // chatting balance is a confirmed zero.
  if (deps.isChattingBalanceZero?.()) {
    deps.showFundingGate?.();
    return;
  }
  const text = composerInput.value.trim();
  if (!text) return;
  if (broadcastEditTarget) {
    const target = broadcastEditTarget;
    composerInput.value = "";
    syncComposerButtons();
    deps.saveDraft?.(`room:${activeChannel}`, "");
    cancelBroadcastReply();
    sendBroadcastEdit(activeChannel, target.txId, text);
    return;
  }
  sendInFlight = true;
  composerInput.value = "";
  syncComposerButtons();
  deps.saveDraft?.(`room:${activeChannel}`, "");
  const channel = activeChannel;
  // Reply mode: wrap in the exact cross-platform reply envelope the room renders.
  const replyTarget = broadcastReplyTarget;
  const content = replyTarget
    ? JSON.stringify({
        type: "reply",
        replyToId: replyTarget.txId,
        replyToSender: replyTarget.senderAddress,
        replyToPreview: replyTarget.preview,
        text,
      })
    : text;
  cancelBroadcastReply();
  const feeKas = feeOverrideKas;
  feeOverrideKas = null;
  hideFeePill();
  try {
    await sendBroadcastText(channel, content, { feeKas });
    renderChannelList();
  } catch (error) {
    deps.showToast?.(roomSendErrorText(error, "Failed to send: "));
    deps.appendEngineLog?.(`Broadcast send failed: ${error.message}`);
  } finally {
    sendInFlight = false;
  }
}

/** Toggle-sends a reaction. EXACT cross-platform wire format (iOS/Android/desktop 1:1):
 *  {"type":"reaction","targetTxId":"<txid>","emoji":"<emoji>","action":"add"|"remove"} —
 *  a normal broadcast message whose content is that JSON. Applied optimistically; the
 *  send failure is non-fatal (local state stays), matching the 1:1 behavior. */
async function sendBroadcastReaction(targetTxId, emoji) {
  if (!activeChannel || !targetTxId || !emoji) return;
  const myAddress = deps.engine.address || "";
  if (!myAddress) return;
  if (deps.isChattingBalanceZero?.()) {
    deps.showFundingGate?.();
    return;
  }
  const channel = activeChannel;
  const existing = reactionsFor(channel)[targetTxId]?.[myAddress];
  const action = existing && !existing.removed && existing.emoji === emoji ? "remove" : "add";

  recordReaction(channel, null, { targetTxId, emoji, action }, myAddress, Date.now());
  saveReactions();
  renderRoom();
  renderChannelList();

  const payload = JSON.stringify({ type: "reaction", targetTxId, emoji, action });
  // One delivery status per message: yours is the only reaction here that has one (iOS
  // localReaction). A removal that fails is offered again the same way.
  const statusKey = targetTxId;
  // Retry runs this again later, from the red mark: only for the account that reacted.
  const owner = accountGuard(() => deps?.engine?.address);
  const attempt = async () => {
    if (!owner.still()) return;
    if (statusKey) setBroadcastReactionStatus(statusKey, "pending");
    try {
      const txid = await enqueueBroadcastSend(() => sendBroadcastMessage({ engine: deps.engine, channel, content: payload }));
      // Remember our own reaction tx so the next poll doesn't re-process it.
      const entry = reactionsCache[channel];
      if (entry && txid) {
        (entry.txIds ||= []).push(txid);
        saveReactions();
      }
      // A removal leaves no reaction of yours to mark (iOS: no local reaction, no status).
      if (action === "remove") { broadcastReactionStatus.delete(statusKey); renderRoom(); }
      else setBroadcastReactionStatus(statusKey, "sent");
    } catch (error) {
      if (error?.code === ROOM_SEND_ACCOUNT_CHANGED) {
        // Never sent; the status marks are the previous account's (cleared with it).
        deps.appendEngineLog?.("Broadcast reaction dropped: the account changed before it went out");
        return;
      }
      if (error?.code === SEND_OUTCOME_UNKNOWN) {
        // It may have landed: left as it is, with no red mark and no Retry that could send it
        // twice (iOS e5a9b11). Its chain copy, if it lands, is applied like any other.
        deps.appendEngineLog?.("Broadcast reaction outcome unknown (left as it is)");
        return;
      }
      // No toast (iOS): the pill turns red and "Retry" shows under the message.
      deps.appendEngineLog?.(`Broadcast reaction send failed (local state already applied): ${error.message}`);
      if (statusKey) setBroadcastReactionStatus(statusKey, "failed", attempt);
    }
  };
  await attempt();
}

// Reaction delivery status (iOS ReactionPillView's localReactionStatus), per message: pending
// shows nothing, "sent" a green check for ten minutes, "failed" a red mark plus "Retry" under the
// message. In-memory only.
const broadcastReactionStatus = new Map(); // targetTxId -> { status, retry }

function setBroadcastReactionStatus(key, status, retry = null) {
  const entry = { status, retry };
  broadcastReactionStatus.set(key, entry);
  if (status === "sent") {
    window.setTimeout(() => {
      if (broadcastReactionStatus.get(key) === entry) {
        broadcastReactionStatus.delete(key);
        renderRoom();
      }
    }, 600_000);
  }
  renderRoom();
}

function broadcastReactionStatusEl(entry) {
  if (!entry || entry.status === "pending") return null;
  const el = document.createElement("span");
  if (entry.status === "sent") {
    el.className = "reaction-status sent";
    el.textContent = "✓";
    el.title = "Reaction sent";
  } else {
    el.className = "reaction-status failed";
    el.textContent = "!";
    el.title = "Reaction failed to send";
  }
  return el;
}

function hideSender(address) {
  if (!activeChannel || !address || address === deps.engine.address) return;
  const set = new Set(hiddenByRoom[activeChannel] || []);
  set.add(address);
  hiddenByRoom[activeChannel] = [...set];
  saveHidden();
  renderRoom();
}

function infoPanelEl() {
  return document.querySelector("[data-broadcast-info-panel]");
}

function closeRoomInfo() {
  const panel = infoPanelEl();
  if (panel) { panel.hidden = true; panel.innerHTML = ""; }
}

// Hidden users in ONE room (iOS HiddenBroadcastSendersView): name over the full address,
// alphabetical, Unhide per row. Reached from Room Info.
function renderHiddenUsersPanel() {
  const panel = infoPanelEl();
  if (!panel || !activeChannel) return;
  const addresses = [...(hiddenByRoom[activeChannel] || [])].sort();
  panel.hidden = false;
  panel.innerHTML = `
    <div class="kaposts-thread-header">
      <button class="kaposts-icon-button" type="button" data-broadcast-info-open aria-label="Back to Room Info">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"/></svg>
      </button>
      <strong>Hidden Users - #${deps.escapeHtml(activeChannel)}</strong>
      <button class="kaposts-view-link" type="button" data-broadcast-hidden-close>Done</button>
    </div>
    ${addresses.length === 0
      ? `<div class="no-results-card"><span>No hidden users in #${deps.escapeHtml(activeChannel)}. Right-click a message to hide its sender.</span></div>`
      : addresses.map((address) => `
          <div class="kaposts-notification-row">
            <div class="kaposts-notification-main">
              <span><strong>${deps.escapeHtml(senderName(address))}</strong></span>
              <span class="broadcast-info-address">${deps.escapeHtml(address)}</span>
            </div>
            <button class="kaposts-view-link" type="button" data-broadcast-unhide="${deps.escapeHtml(address)}">Unhide</button>
          </div>`).join("")}`;
}

/** Room Info's indexer field as it is typed (iOS): Save only once the text differs from what is
 *  saved and no check is running; "Use the app's indexer" while the field has text. */
function syncRoomIndexerButtons() {
  const panel = infoPanelEl();
  const input = panel?.querySelector("[data-broadcast-indexer-input]");
  if (!input || !activeChannel) return;
  const text = String(input.value || "").trim();
  const save = panel.querySelector("[data-broadcast-indexer-save]");
  if (save) save.disabled = indexerCheck.state === "checking" || text === indexerOverrideFor(activeChannel);
  const clear = panel.querySelector("[data-broadcast-indexer-clear]");
  if (clear) clear.hidden = !text;
}

// Everything about one room that is not the messages (iOS BroadcastRoomInfoView): what it is,
// what is in it, how to share it, who you have hidden, and which indexer it reads from.
let indexerCheck = { state: "idle" }; // idle | checking | reachable(count) | failed(reason)
function renderRoomInfoPanel() {
  const panel = infoPanelEl();
  if (!panel || !activeChannel) return;
  const channel = activeChannel;
  const curated = isCuratedBroadcastChannel(channel);
  // Only rooms the indexer tracks have history worth a number: the indexer keeps theirs, 30
  // days, which is what this device keeps too (iOS 21c480d).
  const keptDays = Math.round(BROADCAST_RETENTION_MS / 86_400_000);
  const keptFor = isIndexerTrackedBroadcastChannel(channel) ? (keptDays === 1 ? "1 day" : `${keptDays} days`) : "";
  // What the room shows (iOS messages(forChannel:)): hidden senders are not counted.
  const hidden = hiddenIn(channel);
  const rows = (messageCache[channel] || []).filter((m) => !hidden.has(m.senderAddress));
  const people = new Set(rows.map((m) => m.senderAddress).filter(Boolean)).size;
  const times = rows.map((m) => Number(m.blockTime) || 0).filter(Boolean);
  const fmt = (ms) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const fmtDay = (ms) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  const language = broadcastLanguageDisplayName(channel);
  const joinedAt = joinedAtByChannel[channel];
  const hiddenCount = (hiddenByRoom[channel] || []).length;
  const appWide = String(deps.appWideBroadcastIndexer?.() || "").trim();
  const override = indexerOverrideFor(channel);
  const row = (label, value) => `<div class="broadcast-info-row"><span>${deps.escapeHtml(label)}</span><strong>${deps.escapeHtml(value)}</strong></div>`;
  const checkHtml = indexerCheck.state === "checking"
    ? `<p class="broadcast-info-check checking">Checking the indexer...</p>`
    : indexerCheck.state === "reachable"
      ? `<p class="broadcast-info-check ok">${indexerCheck.count === 0 ? "Connected. It holds nothing for this room yet." : "Connected, and it has this room's messages."}</p>`
      : indexerCheck.state === "failed"
        ? `<p class="broadcast-info-check failed">${deps.escapeHtml(indexerCheck.reason)}</p>`
        : "";
  panel.hidden = false;
  panel.innerHTML = `
    <div class="kaposts-thread-header">
      <strong>Room Info</strong>
      <button class="kaposts-view-link" type="button" data-broadcast-hidden-close>Done</button>
    </div>
    <section class="broadcast-info-section">
      ${row("Room", `#${channel}`)}
      ${language ? row("Language", language) : ""}
      ${row("Kind", curated ? "Popular" : "Added by you")}
      ${joinedAt ? row("Joined", fmtDay(joinedAt)) : ""}
      <p class="broadcast-info-footer">${curated
        ? "A curated room, always in your list. Anyone on K can post to it."
        : "A room you added. Anyone who knows the name can post to it."}</p>
    </section>
    <section class="broadcast-info-section">
      <h3>On this device</h3>
      ${row("Messages", String(rows.length))}
      ${row("People who posted", String(people))}
      ${times.length ? row("Latest", fmt(Math.max(...times))) : ""}
      ${times.length ? row("Oldest held", fmt(Math.min(...times))) : ""}
      ${keptFor ? row("Kept for", keptFor) : ""}
    </section>
    <section class="broadcast-info-section">
      <button type="button" class="broadcast-info-action" data-broadcast-share-room>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0-12 4 4m-4-4-4 4M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></svg>
        <span>Share this room</span>
      </button>
      <button type="button" class="broadcast-info-action" data-broadcast-hidden-users>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="8" r="4"/><path d="M3 20a7 7 0 0 1 12.5-4.3M17 15l4 4m0-4-4 4"/></svg>
        <span>Hidden users</span>
        <b>${hiddenCount}</b>
      </button>
      <p class="broadcast-info-footer">Sharing sends a link that opens this room in K, and a web link for anyone without it. Hiding is per room: someone hidden here still shows in every other room.</p>
    </section>
    <section class="broadcast-info-section">
      <h3>Indexer for this room</h3>
      <input class="kaposts-reply-input" type="url" data-broadcast-indexer-input value="${deps.escapeHtml(override)}" placeholder="${deps.escapeHtml(appWide)}" autocomplete="off" spellcheck="false" />
      ${checkHtml}
      <div class="broadcast-info-buttons">
        <button type="button" class="primary-button" data-broadcast-indexer-save disabled>Save</button>
        <button type="button" class="secondary-button danger" data-broadcast-indexer-clear ${override ? "" : "hidden"}>Use the app's indexer</button>
      </div>
      <p class="broadcast-info-footer">A public chat lives on the Kaspa blockDAG, so any indexer watching the same network serves the same room. Point this one wherever you like - your own, or someone else's - without changing the indexer every other room uses. Leave it blank to follow ${deps.escapeHtml(appWide || "the app's indexer")}.</p>
    </section>`;
  syncRoomIndexerButtons();
}

// Saves the override, then asks the indexer for this room. A wrong URL is otherwise silent: the
// room simply stops filling in, with nothing on screen to say why.
async function saveRoomIndexer(value) {
  if (!activeChannel) return;
  const channel = activeChannel;
  const trimmed = String(value || "").trim();
  if (trimmed === indexerOverrideFor(channel)) return;
  if (trimmed) indexerByChannel[channel] = trimmed; else delete indexerByChannel[channel];
  saveIndexerOverrides();
  deps.showToast?.(trimmed ? `Indexer updated for #${channel}.` : "This room follows the app's indexer again.");
  deepBackfilled.delete(channel);
  deepBackfillResume.delete(channel);
  // Whichever one the room now reads from. Nothing to check when that is no indexer at all
  // (following the app-wide setting on a network without one).
  const target = trimmed || String(deps.appWideBroadcastIndexer?.() || "").trim();
  if (!target) {
    indexerCheck = { state: "idle" };
    renderRoomInfoPanel();
    return;
  }
  indexerCheck = { state: "checking" };
  renderRoomInfoPanel();
  try {
    const page = await fetchBroadcastHistory({ channel, limit: 1, baseUrl: target });
    indexerCheck = { state: "reachable", count: page.messages.length };
  } catch (error) {
    indexerCheck = { state: "failed", reason: `Could not reach it: ${error.message}` };
  }
  if (activeChannel === channel) renderRoomInfoPanel();
  if (isIndexerTrackedBroadcastChannel(channel) || trimmed) backfillChannel(channel, { quiet: true });
}

/** "Share this room" (iOS ShareLink of the share text): the system share sheet where there is
 *  one, else the text goes to the clipboard. */
async function shareRoom(channel) {
  const text = roomShareText(channel);
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try { await navigator.share({ text }); return; }
    catch (error) { if (error?.name === "AbortError") return; }
  }
  copyRoomLink(channel, { text: true });
}

async function copyRoomLink(channel, { text = false } = {}) {
  const value = text ? roomShareText(channel) : roomShareLink(channel);
  try { await deps.copyText?.(value); deps.showToast?.("Room link copied"); } catch { deps.showToast?.("Could not copy the link."); }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function refreshBroadcasts({ onScreen = false } = {}) {
  // Chats (where the room circles live) can come up before the rooms are started.
  if (!deps) return;
  tabVisible = true;
  roomOnScreen = Boolean(onScreen);
  loadState({ caches: false });
  renderChannelList();
  if (activeChannel) {
    // back from another tab: the room keeps the reader's place (K d089011f)
    if (roomOnScreen && roomScrollPlace?.channel === activeChannel) roomPlacePending = true;
    renderRoom();
    if (roomPlacePending) requestAnimationFrame(() => restoreRoomScrollPlace());
    if (roomOnScreen && !document.hidden) markChannelRead(activeChannel);
    // Leaving Public Chats stops the open room's poll; coming back starts it again, with a quiet
    // catch-up, or the room sits frozen until another one is opened (audit 2026-11-13).
    if (!pollTimer && isIndexerTrackedBroadcastChannel(activeChannel)) {
      const channel = activeChannel;
      backfillChannel(channel, { quiet: true });
      startPolling(channel);
    }
  }
  syncScanWanted();
}

/** Repaints the names and avatars on screen (the room list and the open room) after an identity
 *  changed - no reload, no polling. */
export function repaintBroadcastIdentities() {
  if (!deps) return;
  try { renderChannelList(); } catch { /* list not mounted */ }
  if (!activeChannel) return;
  try { renderRoom(); } catch { /* room not mounted */ }
}

export function resetBroadcastsForAccount() {
  // every answer still on its way belongs to the last account (KaPost b78fdb0)
  roomAccountGeneration += 1;
  cancelVoiceRecordingIfActive();
  stopPolling();
  // Each wallet has its own store: rows the last wallet applied are not applied for this one.
  appliedRowsByChannel.clear();
  // Leftover pending rows are checked again for this account (iOS e5a9b11 setCurrentWallet).
  settledPendingRooms.clear();
  // Reaction marks and their Retry are the previous account's reactions.
  broadcastReactionStatus.clear();
  // And these were the previous account's rooms (iOS ee5ec98 setCurrentWallet).
  roomNewestSeen.clear();
  failedRoomEdits.clear();
  activeChannel = null;
  loadState();
  syncScanWanted();
  renderChannelList();
  renderRoom();
  refreshIndexerTrackedRooms().catch(() => {}); // at most hourly (iOS 21c480d)
}

/** Called when the Broadcasts tab stops being the visible tab. The open room stops
 *  polling AND stops counting as wanted; always-listen rooms keep their block scan. */
// Closed rooms are swept from the indexer while the app is on screen (iOS 3c14b46): every
// listed room the indexer tracks (iOS 21c480d) with its bell on that is not open asks for its
// newest rows on the shared foreground beat (30 s, 60 s on an expensive connection; it was 20 s on
// its own timer: K 961fc05a ForegroundBeat, ui/foreground-beat.js) - one small request per room,
// sequential. The block scan stays the fast path and misses blocks
// around a stream reconnect; the open room keeps its own 8 s poll. New live rows get the same
// ping the scan gives; a room's first pass is history, not news, and stays quiet.
const SWEEP_MS = BEAT_MS;
let sweepTimer = null;
let sweepRunning = false;
function startClosedRoomSweep() {
  if (sweepTimer) return;
  sweepTimer = onForegroundBeat(() => sweepClosedRooms(), { offsetMs: 0 });
}
async function sweepClosedRooms() {
  // not while signed out; an account change ends a sweep under way (KaPost b78fdb0)
  if (sweepRunning || document.hidden || !deps || !deps.engine?.address || !hasBroadcastIndexer()) return;
  sweepRunning = true;
  const generation = roomAccountGeneration;
  try {
    for (const name of listedChannels()) {
      if (generation !== roomAccountGeneration) return;
      if (name === activeChannel || !notifyByChannel[name] || !isIndexerTrackedBroadcastChannel(name)) continue;
      try {
        const result = await fetchBroadcastHistory({ channel: name, limit: 50, baseUrl: indexerOverrideFor(name) || null });
        if (generation !== roomAccountGeneration) return;
        // a message a moderator removed goes from closed rooms too, not only when one opens (K e4062188)
        const changed = mergeMessages(name, result.messages) + dropRowsTheIndexerNoLongerHas(name, result.messages);
        if (changed > 0) renderChannelList();
      } catch { /* the next sweep tries again */ }
    }
  } finally { sweepRunning = false; }
}

// The Rooms list is on screen (K d089011f checkListedRoomsAgainstIndexer): each indexed room it
// shows that nothing else keeps current (bell off, not open) is read from the indexer once, at most
// every 2 minutes, so a message deleted there leaves the row's preview too, and new messages show.
// One at a time, each read removing a missing message on its first miss; bell-on rooms are on the
// sweep beat already.
const LIST_CHECK_MS = 2 * 60 * 1000;
const listCheckedAt = new Map();
let listCheckRunning = false;
export function checkListedRoomsAgainstIndexer() {
  if (!deps || !deps.engine?.address || listCheckRunning || document.hidden || !hasBroadcastIndexer()) return;
  const now = Date.now();
  const due = listedChannels().filter((name) => !notifyByChannel[name] && name !== activeChannel
    && isIndexerTrackedBroadcastChannel(name) && now - (listCheckedAt.get(name) || 0) >= LIST_CHECK_MS);
  if (!due.length) return;
  listCheckRunning = true;
  const generation = roomAccountGeneration;
  (async () => {
    try {
      for (const name of due) {
        if (generation !== roomAccountGeneration || document.hidden) return;
        listCheckedAt.set(name, Date.now());
        firstMissRemovesChannels.add(name);
        try {
          const result = await fetchBroadcastHistory({ channel: name, limit: 50, baseUrl: indexerOverrideFor(name) || null });
          if (generation !== roomAccountGeneration) return;
          const changed = mergeMessages(name, result.messages) + dropRowsTheIndexerNoLongerHas(name, result.messages);
          if (changed > 0 && !listRenderSuppressed) renderChannelList();
        } catch { /* the next check tries again */ }
        finally { firstMissRemovesChannels.delete(name); }
      }
    } finally { listCheckRunning = false; }
  })();
}

// A room push that came while K is open (K 961fc05a fetchBeforePushBanner, "room push waits for its
// message"): its message is fetched before the notification shows, so it never announces a message
// the Public Chats list and the room don't have yet (the next 20 s sweep used to bring it). Asks
// again until the push's transaction is here (the indexer can push a moment before it serves the
// row), giving up after `timeoutMs` so the notification is never held long. Each fetch races the
// time left: one that takes longer keeps running and merges when it answers, but nobody waits for
// it. An indexer marked down isn't asked. public/sw.js holds the notification for the answer.
const ROOM_PUSH_WAIT_MS = 4000;
const roomPushFetches = new Map(); // channel -> the fetch under way, so two asks share one
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
export function fetchRoomBeforePushBanner(rawChannel, txId = "", { timeoutMs = ROOM_PUSH_WAIT_MS } = {}) {
  if (!deps || !deps.engine?.address) return Promise.resolve(false);
  const name = normalizeBroadcastChannel(rawChannel);
  // only a room you're in: a push never joins one (KaPost b78fdb0)
  if (!name || !joinedChannels.includes(name)) return Promise.resolve(false);
  const baseUrl = indexerOverrideFor(name) || null;
  if (!baseUrl && !hasBroadcastIndexer()) return Promise.resolve(false);
  if (isIndexerDown(roomIndexerBase(name))) return Promise.resolve(false);
  const running = roomPushFetches.get(name);
  if (running) return running;
  const wanted = /^[0-9a-f]{64}$/i.test(String(txId || "")) ? String(txId).toLowerCase() : "";
  const generation = roomAccountGeneration;
  const arrived = () => (messageCache[name] || []).some((m) => String(m.txId || "").toLowerCase() === wanted)
    || (reactionsCache[name]?.txIds || []).some((id) => String(id).toLowerCase() === wanted);
  const job = (async () => {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      const fetched = fetchBroadcastHistory({ channel: name, limit: 50, baseUrl })
        .then((result) => {
          if (generation !== roomAccountGeneration) return false;
          if (mergeMessages(name, result.messages) > 0) renderChannelList();
          return true;
        })
        .catch(() => false);
      const ok = await Promise.race([fetched, pause(left).then(() => false)]);
      if (!ok || generation !== roomAccountGeneration) return false;
      if (!wanted || arrived()) return true;
      if (Date.now() + 800 >= deadline) return false;
      await pause(800);
    }
  })().finally(() => roomPushFetches.delete(name));
  roomPushFetches.set(name, job);
  return job;
}

export function stopBroadcastPolling() {
  stopPolling();
  roomOnScreen = false;
  if (!deps) return;
  tabVisible = false;
  syncScanWanted();
}

/** Deep-open a channel's room from OUTSIDE this module (the global bell center). */
// An in-chat room link (kachat://broadcast/<channel>): joins the room if it is not in the list
// yet, once the person says so, then opens it - the same gate a pasted room name goes through. Any
// post can hand over a link, and the name is whatever it likes (iOS ee5ec98).
export function openBroadcastRoomFromLink(channel) {
  if (!deps) return;
  loadState({ caches: false });
  // a link to a retired room opens the room that replaced it (K 961fc05a)
  const name = replacementBroadcastChannel(channel);
  // default rooms ask too (K 824a30bb): no room is in the list unasked
  const listed = joinedChannels.includes(name);
  // A name that can't be a room goes straight to joinChannel, which says so.
  // (joinChannel maps a retired name itself)
  if (listed || !isValidBroadcastChannel(name)) { joinChannel(channel); return; }
  confirmDialog(roomLinkJoinPrompt(name)).then((join) => { if (join) joinChannel(channel); });
}

export function openBroadcastChannelFromNotification(channel) {
  if (!deps) return;
  // a push for a retired room opens the room that replaced it (K 961fc05a)
  const clean = replacementBroadcastChannel(channel);
  if (!clean) return;
  loadState({ caches: false });
  // A room not in the list (a mention in Profile's bell for a room since left, a stale push) is
  // asked about first (K 824a30bb askToJoinRoom: no room is added unasked).
  if (!joinedChannels.includes(clean)) {
    if (!isValidBroadcastChannel(clean)) return;
    confirmDialog(roomLinkJoinPrompt(clean, "This room isn't in your Public Chats. Add it?")).then((join) => { if (join) joinChannel(clean); });
    return;
  }
  openRoom(clean);
}

/** A mention in Profile's bell (K d089011f PublicChatJumpRoute): the room opens at the message
 *  when it's in the loaded rows, else as usual. */
export function openBroadcastMessageFromNotification(channel, txId) {
  if (!deps) return;
  openBroadcastChannelFromNotification(channel);
  const clean = replacementBroadcastChannel(channel);
  if (!txId || !clean || activeChannel !== clean) return;
  window.setTimeout(() => { if (activeChannel === clean) jumpToBroadcastMessage(txId, { quiet: true }); }, 300);
}

export function initBroadcasts(dependencies) {
  deps = dependencies;
  onIndexerAvailabilityChange(handleIndexerAvailability);
  // A translation landing, or the reader flipping original/translation, repaints the open room.
  deps.translation?.onChange?.(() => { if (activeChannel) renderRoom(); });
  roomEl = document.querySelector("[data-broadcast-room]");
  roomTitleEl = document.querySelector("[data-broadcast-room-title]");
  roomBodyEl = document.querySelector("[data-broadcast-room-body]");
  roomBodyEl?.addEventListener("scroll", noteRoomScrollPlace, { passive: true });
  // The in-room retention banner was removed for iOS parity (the room reads clean; the 30-day
  // rule is stated beside the Popular header instead). Its markup still lives in index.html —
  // drop the node so it can never render. Safe to delete the element from index.html later.
  // The banner markup is gone from index.html, but this is a PWA: a service-worker-cached
  // old shell can still carry it, so strip it at runtime too.
  document.querySelector("[data-broadcast-room-banner]")?.remove();
  composerInput = document.querySelector("[data-broadcast-input]");
  sendBtn = document.querySelector("[data-broadcast-send]");
  voicePanelEl = document.querySelector("[data-broadcast-voice-panel]");
  voiceBtn = document.querySelector("[data-broadcast-voice]");
  document.querySelector("[data-broadcast-reply-cancel]")?.addEventListener("click", cancelBroadcastComposeBanner);

  loadState();
  renderChannelList();
  updateVoiceButtonVisibility();
  wireRoomMentions();

  // Live block scanning: rows arrive in the indexer's row shape and go through the same
  // mergeMessages dedupe/retention/render path, so a message seen by both paths is stored once.
  deps.engine.onBroadcastBlockHits?.(handleBroadcastBlockHits);
  startClosedRoomSweep();
  // Always-listen rooms must start scanning at launch, before the tab is ever opened.
  syncScanWanted();
  // Rooms added on the indexer count like default rooms (iOS 21c480d): ask which ones on open
  // and on coming back to the app (at most hourly), and follow the set when it changes.
  onIndexerTrackedRoomsChange(handleTrackedRoomsChanged);
  refreshIndexerTrackedRooms().catch(() => {});
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshIndexerTrackedRooms().catch(() => {});
  });
  // and hourly while the app stays open (K 961fc05a: rooms added on the indexer, asked hourly)
  window.setInterval(() => { if (!document.hidden) refreshIndexerTrackedRooms().catch(() => {}); }, 60 * 60_000);

  composerInput?.addEventListener("input", () => { syncComposerButtons(); scheduleBroadcastFeeEstimate({ typing: true }); });
  document.querySelector("[data-broadcast-fee]")?.addEventListener("click", editBroadcastFee);
  document.querySelector("[data-broadcast-funding-gate]")?.addEventListener("click", async (event) => {
    if (!event.target.closest("[data-broadcast-funding-gate-address], [data-broadcast-funding-gate-copy]")) return;
    const address = deps.chattingAddress?.() || "";
    if (!address) return;
    try { await deps.copyText?.(address); deps.showToast?.(deps.addressCopiedToastText?.(address) || "Address copied"); } catch {}
  });
  // The room's header chip opens Room Info; the dead space beside it jumps to the first message.
  document.querySelector("[data-broadcast-room-info]")?.addEventListener("click", () => { indexerCheck = { state: "idle" }; renderRoomInfoPanel(); });
  // Not animated and nothing lit up (iOS jumpToRoomStart): it lands on the first message.
  document.querySelector("[data-broadcast-room] .kaposts-thread-header")?.addEventListener("click", (event) => {
    if (event.target.closest("button") || !roomBodyEl) return;
    roomBodyEl.scrollTop = 0;
  });
  // Scroll-to-latest, appearing once you have scrolled up.
  if (roomBodyEl?.parentElement) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "group-scroll-bottom broadcast-scroll-bottom";
    btn.setAttribute("aria-label", "Scroll to latest");
    btn.hidden = true;
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    btn.addEventListener("click", () => roomBodyEl.scrollTo({ top: roomBodyEl.scrollHeight, behavior: "smooth" }));
    roomBodyEl.parentElement.appendChild(btn);
    roomBodyEl.addEventListener("scroll", () => {
      btn.hidden = roomBodyEl.scrollHeight - roomBodyEl.scrollTop - roomBodyEl.clientHeight < 120;
    }, { passive: true });
  }

  document.querySelector("[data-broadcast-back]")?.addEventListener("click", closeRoom);
  // The bell in the room's top-right: on or off, on a sheet (iOS eff5c09).
  document.querySelector("[data-broadcast-room-bell]")?.addEventListener("click", async () => {
    const name = activeChannel;
    if (!name) return;
    const on = Boolean(notifyByChannel[name]);
    const tracked = isIndexerTrackedBroadcastChannel(name);
    const choice = await chooseDialog({
      title: `#${name}`,
      message: on
        ? (tracked ? "You're notified of new messages here, even when the app is closed."
          : "You're notified of new messages here while the app is open.")
        : "New messages here don't notify you. The room still updates when you open it.",
      options: on
        ? [{ id: "off", title: "Turn Off Notifications", subtitle: "No notification for new messages in this room." }]
        : [{ id: "on", title: "Turn On Notifications", subtitle: tracked ? "Notifies you of new messages, even when the app is closed." : "Notifies you of new messages while the app is open." }],
    });
    if (!choice) return;
    if (choice === "on") {
      if (isCuratedBroadcastChannel(name) && !joinedChannels.includes(name)) { joinedChannels.push(name); saveChannels(); }
      notifyByChannel[name] = true;
      deps.ensureNotificationPermission?.();
    } else delete notifyByChannel[name];
    saveNotify();
    syncScanWanted();
    renderChannelList();
    // No toast: the bell itself changes (iOS notifySheet just closes).
    syncRoomBell();
  });
  document.querySelector("[data-broadcast-own-room-about]")?.addEventListener("click", () => {
    alertDialog({
      title: "About this room",
      message: "No one can see your messages in here unless they are also active in the room at the same time.\n\nIf you want messages to persist and be seen by anyone who joins, you need to run your own indexer and have users add it to the room.",
      confirmLabel: "Done",
    });
  });
  sendBtn?.addEventListener("click", sendCurrentMessage);
  composerInput?.addEventListener("keydown", (event) => {
    // On a phone keyboard Return is a newline and Send is the button, as in the iOS app.
    if (event.key === "Enter" && !event.shiftKey && !isTouchDevice()) {
      event.preventDefault();
      sendCurrentMessage();
    }
  });

  voiceBtn?.addEventListener("click", startVoiceRecording);
  // The recording bar: the arrow stops and sends, the trash throws the recording away.
  voicePanelEl?.addEventListener("click", (event) => {
    if (event.target.closest("[data-broadcast-voice-stop]")) { if (voiceRecorder?.isRecording()) voiceRecorder.stop(false); return; }
    if (event.target.closest("[data-broadcast-voice-cancel]")) { if (voiceRecorder?.isRecording()) voiceRecorder.stop(true); }
  });

  // The list lives in the chats sidebar and the room in the detail pane now; one handler on both.
  const screenClick = async (event) => {
    const unhide = event.target.closest("[data-broadcast-unhide]");
    if (unhide) {
      hiddenByRoom[activeChannel] = (hiddenByRoom[activeChannel] || []).filter((a) => a !== unhide.dataset.broadcastUnhide);
      saveHidden();
      renderHiddenUsersPanel();
      renderRoom();
      return;
    }

    if (event.target.closest("[data-broadcast-hidden-users]")) { renderHiddenUsersPanel(); return; }
    if (event.target.closest("[data-broadcast-info-open]")) { renderRoomInfoPanel(); return; }
    if (event.target.closest("[data-broadcast-share-room]")) { shareRoom(activeChannel); return; }
    if (event.target.closest("[data-broadcast-indexer-save]")) {
      saveRoomIndexer(infoPanelEl()?.querySelector("[data-broadcast-indexer-input]")?.value || "");
      return;
    }
    if (event.target.closest("[data-broadcast-indexer-clear]")) {
      const input = infoPanelEl()?.querySelector("[data-broadcast-indexer-input]");
      if (input) input.value = "";
      syncRoomIndexerButtons();
      saveRoomIndexer("");
      return;
    }

    const hiddenClose = event.target.closest("[data-broadcast-hidden-close]");
    if (hiddenClose) closeRoomInfo();
  };
  document.querySelector("[data-broadcast-room]")?.addEventListener("click", screenClick);
  infoPanelEl()?.addEventListener("input", (event) => {
    if (event.target.matches("[data-broadcast-indexer-input]")) syncRoomIndexerButtons();
  });
  infoPanelEl()?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.matches("[data-broadcast-indexer-input]")) {
      event.preventDefault();
      saveRoomIndexer(event.target.value);
    }
  });
}
