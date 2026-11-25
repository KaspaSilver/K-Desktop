// KaPost conversations like X (K 961fc05a): "View thread" only for the poster's own replies, the
// opened post drawn as X's focused post, replies in X's order with no heading, "Replying to" on a
// reply shown outside its conversation, and KaPost notifications that poll like X.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  nextSelfThreadSegment, pageHasPosterReply, rankReplies, createReplyOrderMemo, focusedTimestamp,
  replyingToAddress, kaPostsNotifPollDue, kaPostsNotifPollSoonDue,
  KAPOSTS_NOTIF_POLL_MS, KAPOSTS_NOTIF_PUSH_SAFETY_NET_MS,
} from "../ui/kaposts-x-rules.js";

const kaposts = readFileSync(new URL("../ui/kaposts.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../ui/kaposts-conversation.css", import.meta.url), "utf8");

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

const POSTER = "kaspa:qposter";
const ME = "kaspa:qme";
const FRIEND = "kaspa:qfriend";
const OTHER = "kaspa:qother";
const reply = (id, posterAddress, { likes = 0, timestamp = 1000, remoteId = id } = {}) => ({ id: `remote-${id}`, remoteId, posterAddress, likes, timestamp });

// --- View thread: the poster's own chain only ---------------------------------------------------

await test("someone else's reply, even the only one, is never the thread", () => {
  assert.equal(nextSelfThreadSegment([reply("a", OTHER)], POSTER), null);
  assert.equal(nextSelfThreadSegment([], POSTER), null);
  assert.equal(pageHasPosterReply([reply("a", OTHER)], POSTER), false);
});

await test("the poster's earliest reply is the next link, whoever else replied", () => {
  const replies = [reply("a", OTHER, { timestamp: 1 }), reply("b", POSTER, { timestamp: 30 }), reply("c", POSTER, { timestamp: 20 })];
  assert.equal(nextSelfThreadSegment(replies, POSTER).remoteId, "c");
  assert.equal(nextSelfThreadSegment(replies, POSTER.toUpperCase()).remoteId, "c", "addresses compare without case");
  assert.equal(pageHasPosterReply(replies, POSTER), true);
  // a reply with no txid yet can't be followed
  assert.equal(nextSelfThreadSegment([reply("d", POSTER, { remoteId: null })], POSTER), null);
});

function loadChainSandbox({ pages, probe = new Map() }) {
  const source = fnSource(kaposts, "loadSelfThreadChain");
  const sandbox = {
    deps: { engine: {} },
    threadChains: new Map(),
    threadRootProbe: probe,
    threadRootNoUntil: new Map(),
    threadRootNoLifetime: () => 600_000,
    isHiddenAuthor: () => false,
    mapRemotePost: (p) => p,
    nextSelfThreadSegment,
    pageHasPosterReply,
    fetches: [],
    fetchReplies: async ({ postId }) => { sandbox.fetches.push(postId); return { posts: pages[postId] || [] }; },
  };
  vm.runInNewContext(`${source}; this.run = loadSelfThreadChain;`, sandbox);
  return sandbox;
}

await test("loadSelfThreadChain: a lone comment from someone else leaves no thread and no View thread", async () => {
  const root = { id: "remote-root", remoteId: "root", posterAddress: POSTER, comments: [reply("x", OTHER)] };
  const box = loadChainSandbox({ pages: {} });
  await box.run(root);
  assert.equal(box.threadChains.get("remote-root").length, 0);
  assert.notEqual(box.threadRootProbe.get("root"), true);
  assert.deepEqual(box.fetches, [], "nothing to walk, and nothing was marked to check again");
});

await test("loadSelfThreadChain: walks the poster's chain link by link and marks the root", async () => {
  const root = { id: "remote-root", remoteId: "root", posterAddress: POSTER, comments: [reply("x", OTHER), reply("s2", POSTER)] };
  const box = loadChainSandbox({ pages: { s2: [reply("y", OTHER), reply("s3", POSTER)], s3: [reply("z", OTHER)] } });
  await box.run(root);
  assert.deepEqual([...box.threadChains.get("remote-root")].map((p) => p.remoteId), ["s2", "s3"]);
  assert.equal(box.threadRootProbe.get("root"), true);
});

await test("loadSelfThreadChain: a root marked before (the old rule) with no poster reply is unmarked", async () => {
  const root = { id: "remote-root", remoteId: "root", posterAddress: POSTER, timestamp: Date.now(), comments: [reply("x", OTHER)] };
  const box = loadChainSandbox({ pages: { root: [reply("x", OTHER)] }, probe: new Map([["root", true]]) });
  await box.run(root);
  assert.deepEqual(box.fetches, ["root"], "the indexer's first page is asked once more");
  assert.equal(box.threadRootProbe.get("root"), false);
  assert.ok(box.threadRootNoUntil.get("root") > Date.now(), "held as long as a fresh probe's no");
  // ...but kept when that page shows the poster's reply after all
  const kept = loadChainSandbox({ pages: { root: [reply("s2", POSTER, { remoteId: "s2" })] }, probe: new Map([["root", true]]) });
  await kept.run({ ...root, comments: [] });
  assert.equal(kept.threadRootProbe.get("root"), true);
});

await test("the old any-lone-reply rule is gone from the walk", () => {
  const source = fnSource(kaposts, "loadSelfThreadChain");
  assert.doesNotMatch(source, /candidates\.length === 1/);
  assert.match(source, /nextSelfThreadSegment\(candidates, post\.posterAddress\)/);
  // the feed probe was already poster-only, and stays so
  assert.match(fnSource(kaposts, "probeThreadRoots"), /mapped\.posterAddress === post\.posterAddress/);
  // View thread shows only for a root
  assert.match(kaposts, /!inThread && isThreadRootPost\(post\) \? `<button class="kaposts-view-thread"/);
});

// --- Replies in X's order ------------------------------------------------------------------------

await test("replies: the poster's first, then yours, then people you follow, then the rest; most liked first", () => {
  const replies = [
    reply("rest-old", OTHER, { likes: 1, timestamp: 1 }),
    reply("rest-liked", OTHER, { likes: 9, timestamp: 5 }),
    reply("friend", FRIEND, { likes: 0 }),
    reply("mine", ME, { likes: 0 }),
    reply("poster", POSTER, { likes: 0 }),
    reply("rest-new", OTHER, { likes: 1, timestamp: 9 }),
  ];
  const ordered = rankReplies(replies, { posterAddress: POSTER, me: ME, isFollowing: (a) => a === FRIEND });
  assert.deepEqual(ordered.map((r) => r.remoteId), ["poster", "mine", "friend", "rest-liked", "rest-old", "rest-new"]);
});

await test("the order is kept while the post is open: likes landing don't move rows", () => {
  const memo = createReplyOrderMemo();
  const options = { posterAddress: POSTER, me: ME, isFollowing: () => false, now: 10_000_000 };
  const first = [reply("a", OTHER, { likes: 5 }), reply("b", OTHER, { likes: 1 })];
  assert.deepEqual(memo.ordered(first, "p", options).map((r) => r.remoteId), ["a", "b"]);
  const liked = [reply("a", OTHER, { likes: 5 }), reply("b", OTHER, { likes: 50 })];
  assert.deepEqual(memo.ordered(liked, "p", options).map((r) => r.remoteId), ["a", "b"], "b keeps its place");
  assert.equal(memo.ordered(liked, "p", options)[1].likes, 50, "with the fresh numbers");
  // the next page goes below
  const paged = [...liked, reply("c", OTHER, { likes: 99 })];
  assert.deepEqual(memo.ordered(paged, "p", options).map((r) => r.remoteId), ["a", "b", "c"]);
  // closed and opened again: ranked afresh
  memo.retain(new Set());
  assert.deepEqual(memo.ordered(paged, "p", options).map((r) => r.remoteId), ["c", "b", "a"]);
});

await test("your fresh reply goes up, after the poster's and yours", () => {
  const memo = createReplyOrderMemo();
  const now = 10_000_000;
  const options = { posterAddress: POSTER, me: ME, isFollowing: () => false, now };
  const shown = [reply("poster", POSTER), reply("x", OTHER, { likes: 3 })];
  memo.ordered(shown, "p", options);
  const sent = { id: "local-1", remoteId: null, posterAddress: ME, likes: 0, timestamp: now };
  assert.deepEqual(memo.ordered([...shown, sent], "p", options).map((r) => r.remoteId || r.id), ["poster", "local-1", "x"]);
  // an old reply of yours from a later page stays below
  const old = reply("old-mine", ME, { timestamp: now - 3_600_000 });
  assert.deepEqual(memo.ordered([...shown, sent, old], "p", options).map((r) => r.remoteId || r.id), ["poster", "local-1", "x", "old-mine"]);
});

await test("renderThread: no Comments heading, no empty line, no Thread header; replies come ranked", () => {
  const render = fnSource(kaposts, "renderThread");
  assert.doesNotMatch(render, /Comments \(|kaposts-comments-header|kaposts-comments-empty|No comments yet|Every reply is in the conversation above/);
  assert.doesNotMatch(render, /kaposts-thread-chain-header|Thread · |Conversation · /);
  assert.match(render, /const comments = commentsExcludingThread\(post\);/);
  assert.match(render, /postCellHtml\(post, \{ inThread: true, isRoot: true, replyInline: true, showReply: false, focused: true \}\)/);
  // the poster's posts one under another, joined by the avatar-column line
  assert.match(render, /kaposts-thread-chain-item\$\{index < chain\.length - 1 \? " continues" : ""\}/);
  assert.match(css, /\.kaposts-thread-chain-item\.continues::before \{[^}]*left: 30px;[^}]*bottom: -12px;/);
  // closed posts rank afresh next time
  assert.match(render, /replyOrderMemo\.retain\(new Set\(threadStack\)\)/);
  const excluding = fnSource(kaposts, "commentsExcludingThread");
  assert.match(excluding, /replyOrderMemo\.ordered\(replies, post\.id, \{/);
  assert.match(excluding, /isFollowing: \(address\) => prefs\.following\.includes\(address\)/);
});

// --- X's focused post ----------------------------------------------------------------------------

await test("the focused post's time reads \"12:00 PM · Nov 25, 2026\"", () => {
  const stamp = focusedTimestamp(new Date(2026, 10, 25, 12, 0).getTime(), "en-US").replace(/\s/g, " ");
  assert.equal(stamp, "12:00 PM · Nov 25, 2026");
});

await test("the focused layout: avatar and name on one line, text full width, the time, actions between rules", () => {
  const cell = fnSource(kaposts, "postCellHtml");
  const focused = cell.slice(cell.indexOf("if (focused) {"), cell.indexOf("// \"Replying to Alice\""));
  assert.match(focused, /<div class="kaposts-focused-head">\s*\$\{avatarHtml\}\s*<div class="kaposts-focused-name">\$\{headHtml\}<\/div>/);
  assert.match(focused, /focusedTimestamp\(post\.timestamp\)/);
  assert.match(focused, /<div class="kaposts-focused-actions">\$\{actionsHtml\}<\/div>/);
  assert.doesNotMatch(focused, /View thread|postTimestamp\(/);
  assert.match(css, /\.kaposts-thread \.kaposts-cell\.focused \{ flex-direction: column;/);
  assert.match(css, /\.kaposts-focused-actions \{ border-top: 1px solid var\(--line\); border-bottom: 1px solid var\(--line\);/);
  assert.match(css, /\.kaposts-cell\.focused \.kaposts-cell-text \{ font-size: 20px;/);
  // feed rows keep the full date under the actions
  const row = cell.slice(cell.indexOf("// Feed rows keep the full date"));
  assert.match(row, /\$\{actionsHtml\}\s*<div class="kaposts-cell-foot"><span class="kaposts-cell-stamp">\$\{deps\.escapeHtml\(postTimestamp\(post\.timestamp\)\)\}/);
  assert.match(kaposts, /import "\.\/kaposts-conversation\.css";/);
});

// --- Replying to ---------------------------------------------------------------------------------

await test("Replying to: the parent's author when known, else the first signed mention that isn't the poster", () => {
  const toAddress = (key) => ({ k1: POSTER, k2: FRIEND, k3: OTHER }[key] || null);
  assert.equal(replyingToAddress({ posterAddress: OTHER }, { addressFromPubkey: toAddress }), null, "a post answers no one");
  assert.equal(replyingToAddress({ parentRemoteId: "p", parentPosterPubkey: "k2", posterAddress: OTHER }, { addressFromPubkey: toAddress }), FRIEND);
  assert.equal(replyingToAddress({ parentRemoteId: "p", posterAddress: OTHER, mentionedPubkeys: ["k1"] }, { addressFromPubkey: toAddress, findParentAuthor: () => ME }), ME);
  // a thread reply: K leaves the signer out, so the first mention other than the poster
  assert.equal(replyingToAddress({ parentRemoteId: "p", posterAddress: POSTER, mentionedPubkeys: ["k1", "k3"] }, { addressFromPubkey: toAddress }), OTHER);
  assert.equal(replyingToAddress({ parentRemoteId: "p", posterAddress: POSTER, mentionedPubkeys: ["k1"] }, { addressFromPubkey: toAddress }), null);
});

await test("profiles' rows and Bookmarks say Replying to; the feed and the thread don't", () => {
  assert.match(kaposts, /feedItems\.map\(\(post\) => postCellHtml\(post, \{ inThread: true, openByRemote: true, profileOf: address, replyingTo: true \}\)\)/);
  assert.match(kaposts, /bookmarks\.map\(\(post\) => postCellHtml\(post, \{ inThread: true, openByRemote: true, replyingTo: true \}\)\)/);
  const cell = fnSource(kaposts, "postCellHtml");
  assert.match(cell, /const replyingToName = replyingTo \? replyingToName_\(post\) : null;/);
  assert.match(cell, /Replying to <span class="kaposts-replying-to-name">\$\{deps\.escapeHtml\(replyingToName\)\}<\/span>/);
  assert.match(fnSource(kaposts, "replyParentAuthor"), /Date\.now\(\) - missedAt < 15_000/);
  assert.equal((kaposts.match(/replyingTo: true/g) || []).length, 2);
});

// --- KaPost notifications like X ----------------------------------------------------------------

await test("with push registered the poll is a 5-minute safety net; without push, the usual poll", () => {
  const now = 1_000_000_000;
  assert.equal(kaPostsNotifPollDue({ now, lastPollAt: 0, pushRegistered: true }), true, "never polled");
  assert.equal(kaPostsNotifPollDue({ now, lastPollAt: now - 60_000, pushRegistered: true }), false);
  assert.equal(kaPostsNotifPollDue({ now, lastPollAt: now - KAPOSTS_NOTIF_PUSH_SAFETY_NET_MS, pushRegistered: true }), true);
  assert.equal(kaPostsNotifPollDue({ now, lastPollAt: now - KAPOSTS_NOTIF_POLL_MS, pushRegistered: false }), true);
  assert.equal(kaPostsNotifPollDue({ now, lastPollAt: now - 30_000, pushRegistered: false }), false);
  assert.equal(KAPOSTS_NOTIF_PUSH_SAFETY_NET_MS, 300_000);
  // a push, coming back or the bell: now, unless a poll ran in the last 15 s
  assert.equal(kaPostsNotifPollSoonDue({ now, lastPollAt: now - 5_000 }), false);
  assert.equal(kaPostsNotifPollSoonDue({ now, lastPollAt: now - 16_000 }), true);
});

await test("the poll runs on open, on coming back, on Profile, and when a KaPost push asks", () => {
  const start = fnSource(kaposts, "startKaPostsNotificationPolling");
  assert.match(start, /kaPostsNotifPollDue\(\{ now: Date\.now\(\), lastPollAt: kaPostsNotifLastPollAt, pushRegistered: kaPostsPushBringsActivity\(\) \}\)/);
  assert.match(start, /window\.setTimeout\(runKaPostNotificationPoll, 10_000\)/);
  assert.match(start, /addEventListener\("visibilitychange", \(\) => \{ if \(!document\.hidden\) pollKaPostNotificationsSoon\(\); \}\)/);
  const soon = fnSource(kaposts, "pollKaPostNotificationsSoon");
  assert.match(soon, /if \(!deps \|\| document\.hidden\) return;/);
  assert.match(soon, /kaPostsNotifPollSoonDue/);
  assert.match(fnSource(kaposts, "setKaPostsRootMode"), /if \(next === "myProfile"\) \{\s*\/\/[^\n]*\n\s*pollKaPostNotificationsSoon\(\);/);
  assert.match(fnSource(kaposts, "kaPostsPushBringsActivity"), /deps\?\.kaPostsPushRegistered\?\.\(\)/);
  // app.js: registered = the switch on and this browser subscribed; a KaPost push asks for a poll
  assert.match(app, /kaPostsPushRegistered: \(\) => pushNotificationsEnabled\(\) && webPushStatus\(\)\?\.state === "on",/);
  assert.match(app, /onPush: \(data = \{\}\) => \{\s*\/\/[^\n]*\n\s*if \(data\.type === "kaposts"\) \{ try \{ pollKaPostNotificationsSoon\(\); \}/);
  // the worker hands the push's type to the open page
  const sw = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(sw, /client\.postMessage\(\{ type: "kachat:push", data: \{ type: String\(payload\.type \|\| ""\)/);
  // an account switch asks the next account's at once
  assert.match(kaposts, /kaPostsNotifLastPollAt = 0;\n\s*renderedFeedIds = new Set\(\);/);
});

// --- Full-width link cards ---------------------------------------------------------------------

await test("a post's link card fills the post's column; chats keep theirs", () => {
  assert.match(css, /\.kaposts-site-card \.message-link-card \{ max-width: none; width: 100%; \}/);
  assert.match(css, /\.kaposts-site-card \.message-link-card-thumb \{ height: 190px; \}/);
  assert.match(kaposts, /<div class="kaposts-site-card" data-kaposts-site-card=/);
});

console.log(`kapost conversations: ${passed} passed`);
