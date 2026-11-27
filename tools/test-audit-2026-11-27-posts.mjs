// Posts fixes from the 2026-11-27 audit, run from ui/kaposts.js's and ui/chess-bots.js's own source
// with the page around them stubbed:
//   1. Thread, reply and profile lists no longer stick on "Loading...": a page one made stale by
//      navigation lets go of (or hands back) its pager, Back to an outer thread loads what never
//      landed, the rail clears every thread cursor, and a kept profile with a tab still loading
//      from an old load opens afresh.
//   2. A bot challenge names its winner only when the post the link came from was theirs (as
//      arcade challenges, audit 2026-11-24 #21); a link from outside says "Someone".
//
//   node tools/test-audit-2026-11-27-posts.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { schnorr } from "@noble/curves/secp256k1.js";
import { addressOf } from "../engine/kachat-names/registry-state.js";
import { botConfirmedBy, botChallengeBannerText, parseBotChallengeLink } from "../engine/chess-bot-links.js";

const here = dirname(fileURLToPath(import.meta.url));
const kaposts = readFileSync(join(here, "..", "ui", "kaposts.js"), "utf8");
const chessBots = readFileSync(join(here, "..", "ui", "chess-bots.js"), "utf8");

// --- source extraction (as tools/test-audit-2026-11-25-shell.mjs) ------------------------------
function skipLiteral(src, i) {
  const c = src[i];
  if (c === "/" && src[i + 1] === "/") { const end = src.indexOf("\n", i); return end < 0 ? src.length : end; }
  if (c === "/" && src[i + 1] === "*") return src.indexOf("*/", i + 2) + 2;
  if (c === '"' || c === "'") {
    for (let j = i + 1; j < src.length; j += 1) { if (src[j] === "\\") { j += 1; continue; } if (src[j] === c) return j + 1; }
  }
  if (c === "`") {
    for (let j = i + 1; j < src.length; j += 1) {
      if (src[j] === "\\") { j += 1; continue; }
      if (src[j] === "`") return j + 1;
      if (src[j] === "$" && src[j + 1] === "{") j = matchClose(src, j + 1, "{", "}") - 1;
    }
  }
  return i;
}
function matchClose(src, open, a, b) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const next = skipLiteral(src, i);
    if (next !== i) { i = next - 1; continue; }
    if (src[i] === a) depth += 1;
    else if (src[i] === b) { depth -= 1; if (depth === 0) return i + 1; }
  }
  throw new Error("unbalanced source");
}
function extractFunction(src, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  assert.ok(match, `function ${name} in the source`);
  const paramsEnd = matchClose(src, match.index + match[0].length - 1, "(", ")");
  const bodyStart = src.indexOf("{", paramsEnd);
  return src.slice(match.index, matchClose(src, bodyStart, "{", "}"));
}
function sandbox(sources, overrides = {}) {
  const calls = [];
  const scope = new Proxy(overrides, {
    has: (target, key) => typeof key === "string" && (key in target || !(key in globalThis)),
    get: (target, key) => {
      if (key === Symbol.unscopables) return undefined;
      if (key in target) return target[key];
      const fn = (...args) => { calls.push([key, ...args]); return undefined; };
      target[key] = fn;
      return fn;
    },
    set: (target, key, value) => { target[key] = value; return true; },
  });
  const names = sources.map((src) => /function\s+([A-Za-z0-9_$]+)/.exec(src)?.[1]).filter(Boolean);
  // eslint-disable-next-line no-new-func
  const run = new Function("scope", `with (scope) { ${sources.join("\n")}\n return { ${names.join(", ")} }; }`);
  return { fns: run(scope), calls, scope: overrides, called: (name) => calls.filter((c) => c[0] === name) };
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// --- 1. threads and comments -----------------------------------------------------------------
const THREAD_FNS = ["makePager", "seedPager", "openThread", "loadThreadFirstPage", "loadCommentReplies",
  "threadFirstPageStale", "letThreadPagerGo", "resumeRevealedThread", "reloadExpandedReplies", "openKaPostsSection"];

/** A thread module with its posts in `posts` (id -> post) and every fetchReplies held until the
 *  test answers it: `pending` lists { postId, d } in the order they were asked. */
function threadBox() {
  const posts = new Map();
  const pending = [];
  const box = sandbox(THREAD_FNS.map((name) => extractFunction(kaposts, name)), {
    PAGER_PAGE_SIZE: 50, PAGER_THREAD_PAGE_SIZE: 100, PAGER_TARGET_ROWS: 18,
    threadGeneration: 0, threadStack: [], threadPagers: new Map(), expandedCommentIds: new Set(),
    sessionReplyIds: new Set(), panelOverThread: false, pendingThreadScrollRemoteId: null,
    deps: { engine: {}, appendEngineLog: () => {} },
    nextPageCursor: () => null,
    userFacingError: (error) => error.message,
    findPost: (id) => posts.get(id) || null,
    mutatePost: (id, fn) => { const post = posts.get(id); if (post) fn(post); },
    mapRemotePost: (raw) => {
      const mapped = { id: `remote-${raw.id}`, remoteId: raw.id, comments: [] };
      if (!posts.has(mapped.id)) posts.set(mapped.id, mapped);
      return posts.get(mapped.id);
    },
    mergeOutageRows: (old, fresh) => fresh,
    loadSelfThreadChain: async () => {},
    fetchReplies: ({ postId }) => { const d = deferred(); pending.push({ postId, d }); return d.promise; },
  });
  const post = (remoteId) => { const p = { id: `remote-${remoteId}`, remoteId, comments: [] }; posts.set(p.id, p); return p; };
  const answer = async (postId, ids = []) => {
    const at = pending.findIndex((entry) => entry.postId === postId);
    assert.ok(at >= 0, `a replies request for ${postId}`);
    const [{ d }] = pending.splice(at, 1);
    d.resolve({ posts: ids.map((id) => ({ id })), pagination: null });
    await tick(); await tick();
  };
  // The Back button's handler, from its source: pop, and with threads left resume the one on top.
  const back = () => {
    box.scope.threadStack.pop();
    if (box.scope.threadStack.length === 0) { box.scope.threadGeneration += 1; box.scope.threadPagers.clear(); }
    if (box.scope.threadStack.length > 0) box.fns.resumeRevealedThread();
  };
  return { box, posts, pending, post, answer, back };
}

await test("1 Back to a thread whose replies were overtaken by a quoted post loads them again", async () => {
  const { box, post, pending, answer, back } = threadBox();
  const a = post("aa"); const b = post("bb");
  box.fns.openThread(a);
  box.fns.openThread(b); // the quoted post, before A's replies came
  await answer("aa", ["r1"]); // A's page lands stale
  assert.equal(box.scope.threadPagers.has(a.id), false, "A's stale page lets go of its pager - no spinner left behind");
  back();
  const pager = box.scope.threadPagers.get(a.id);
  assert.ok(pager?.loading, "Back to A starts its page one again");
  assert.ok(pending.some((entry) => entry.postId === "aa"), "a fresh request for A's replies");
  await answer("aa", ["r1", "r2"]);
  assert.equal(pager.loading, false, "and it lands");
  assert.deepEqual(a.comments.map((c) => c.remoteId), ["r1", "r2"]);
});

await test("1 Back while A's stale page is still in flight: the old answer never touches the new pager", async () => {
  const { box, post, answer, back } = threadBox();
  const a = post("aa"); const b = post("bb");
  box.fns.openThread(a);
  box.fns.openThread(b);
  back(); // A's first request still out
  const fresh = box.scope.threadPagers.get(a.id);
  assert.ok(fresh?.loading, "A loads again on Back");
  await answer("aa", ["old"]); // the stale one comes back first
  assert.equal(box.scope.threadPagers.get(a.id), fresh, "the stale answer leaves the fresh pager alone");
  assert.equal(a.comments.length, 0, "and its rows are dropped");
  await answer("aa", ["new"]);
  assert.equal(fresh.loading, false);
  assert.deepEqual(a.comments.map((c) => c.remoteId), ["new"]);
});

await test("1 a thread whose page did land keeps it on Back (no reload)", async () => {
  const { box, post, pending, answer, back } = threadBox();
  const a = post("aa"); const b = post("bb");
  box.fns.openThread(a);
  await answer("aa", ["r1"]);
  const kept = box.scope.threadPagers.get(a.id);
  box.fns.openThread(b);
  back();
  assert.equal(box.scope.threadPagers.get(a.id), kept, "the landed pager and its cursor stay");
  assert.equal(pending.filter((entry) => entry.postId === "aa").length, 0, "nothing asked again");
});

await test("1 expanded replies made stale by navigation load again on Back, and View replies works", async () => {
  const { box, posts, post, pending, answer, back } = threadBox();
  const a = post("aa"); const b = post("bb");
  box.fns.openThread(a);
  await answer("aa", ["c1"]);
  const comment = posts.get("remote-c1");
  box.scope.expandedCommentIds.add(comment.id);
  box.fns.loadCommentReplies(comment);
  assert.ok(box.scope.threadPagers.get(comment.id)?.loading);
  box.fns.openThread(b);
  await answer("c1", ["n1"]); // the comment's page lands stale
  assert.equal(box.scope.threadPagers.has(comment.id), false, "its pager is let go, not left loading");
  back();
  assert.ok(pending.some((entry) => entry.postId === "c1"), "Back to A asks for the expanded comment's replies again");
  await answer("c1", ["n1"]);
  assert.deepEqual(comment.comments.map((c) => c.remoteId), ["n1"]);
  assert.equal(box.scope.threadPagers.get(comment.id).loading, false);
});

await test("1 a still-loading stale comment page does not block a new View replies", async () => {
  const { box, posts, post, pending, answer } = threadBox();
  const a = post("aa");
  box.fns.openThread(a);
  await answer("aa", ["c1"]);
  const comment = posts.get("remote-c1");
  box.fns.loadCommentReplies(comment);
  box.scope.threadGeneration += 1; // navigation, with the page still out
  box.fns.loadCommentReplies(comment);
  assert.equal(pending.filter((entry) => entry.postId === "c1").length, 2, "the second tap asks again");
  // A live page one still blocks a double tap.
  box.fns.loadCommentReplies(comment);
  assert.equal(pending.filter((entry) => entry.postId === "c1").length, 2);
});

await test("1 the rail clears every thread cursor: a thread opened again loads from page one", async () => {
  const { box, posts, post, pending, answer } = threadBox();
  const a = post("aa");
  box.fns.openThread(a);
  await answer("aa", ["c1"]);
  const comment = posts.get("remote-c1");
  box.fns.loadCommentReplies(comment); // in flight
  box.fns.openKaPostsSection("feed");
  assert.equal(box.scope.threadPagers.size, 0, "openKaPostsSection drops every thread pager");
  assert.deepEqual(box.scope.threadStack, []);
  await answer("c1", ["n1"]);
  box.fns.openThread(a);
  await answer("aa", ["c1"]);
  box.fns.loadCommentReplies(posts.get("remote-c1"));
  assert.ok(pending.some((entry) => entry.postId === "c1"), "View replies loads on the reopened thread");
});

await test("1 Back and setKaPostsRootMode resume / clear thread cursors (source)", () => {
  const backHandler = kaposts.slice(kaposts.indexOf('"[data-kaposts-thread-back]"'), kaposts.indexOf('"[data-kaposts-thread-back]"') + 1400);
  assert.match(backHandler, /if \(threadStack\.length > 0\) resumeRevealedThread\(\);/, "Back resumes the revealed thread");
  const rootMode = extractFunction(kaposts, "setKaPostsRootMode");
  assert.equal((rootMode.match(/threadPagers\.clear\(\);/g) || []).length, 2, "both of setKaPostsRootMode's resets drop the thread pagers");
  for (const name of ["loadMoreThreadReplies", "loadMoreCommentReplies"]) {
    assert.match(extractFunction(kaposts, name), /isStale: \(\) => threadPagers\.get\(\w+\) !== pager/, `${name} is stale by pager, not generation`);
  }
});

// --- 1. profiles -------------------------------------------------------------------------------
function profileBox() {
  const pending = [];
  const box = sandbox(["makePager", "seedPager", "refreshProfilePanel", "freshKeptProfilePanel"].map((name) => extractFunction(kaposts, name)), {
    PAGER_PAGE_SIZE: 50, PAGER_TARGET_ROWS: 18, PROFILE_FRESH_MS: 300000,
    panelGeneration: 0, activePanel: null, keptProfilePanel: null,
    deps: { engine: {}, appendEngineLog: () => {} },
    nextPageCursor: () => "cursor",
    userFacingError: (error) => error.message,
    mapRemotePost: (raw) => ({ id: `remote-${raw.id}`, remoteId: raw.id }),
    mergeOutageRows: (old, fresh) => fresh,
    kapostsKeptPageFresh: () => true,
    lastOwnKaPostActivityAt: () => 0,
    fetchUserPosts: () => { const d = deferred(); pending.push(d); return d.promise; },
    fetchUserReplies: () => { const d = deferred(); pending.push(d); return d.promise; },
  });
  const old = box.fns.makePager();
  old.cursor = "page2";
  const panel = { type: "profile", address: "kaspa:alice", pubkey: "02ab", tab: "posts", posts: [{ id: "p1" }], replies: [], loading: false, pagers: { posts: old, replies: box.fns.makePager() } };
  box.scope.activePanel = panel;
  box.scope.keptProfilePanel = { address: "kaspa:alice", panel, loadedAt: Date.now() };
  return { box, panel, old, pending };
}

await test("1 profile refresh, Followers, Back: the panel is not reused spinning, and refresh works", async () => {
  const { box, panel, old, pending } = profileBox();
  box.fns.refreshProfilePanel(panel);
  assert.equal(panel.pagers.posts.loading, true);
  // Followers opened (a new panel), then Back: openPosterProfile moves the generation on first.
  box.scope.activePanel = { type: "followList" };
  box.scope.panelGeneration += 1;
  box.scope.panelGeneration += 1;
  assert.equal(box.fns.freshKeptProfilePanel("kaspa:alice", null), null, "a kept panel with a tab loading from an old load opens afresh");
  // The stale refresh lands: the tab gets its old pager back, not stuck loading.
  pending.shift().resolve({ posts: [{ id: "x" }], pagination: null });
  await tick(); await tick();
  assert.equal(panel.pagers.posts, old, "the old pager (and cursor) back");
  assert.equal(panel.pagers.posts.loading, false);
  assert.deepEqual(panel.posts, [{ id: "p1" }], "the stale rows are not applied");
  assert.equal(box.fns.freshKeptProfilePanel("kaspa:alice", null), panel, "with nothing loading it is kept again");
  box.scope.activePanel = panel;
  box.fns.refreshProfilePanel(panel);
  assert.equal(pending.length, 1, "refresh is live again");
});

await test("1 a stale profile refresh that fails also hands the pager back", async () => {
  const { box, panel, old, pending } = profileBox();
  box.fns.refreshProfilePanel(panel);
  box.scope.panelGeneration += 1;
  pending.shift().reject(new Error("offline"));
  await tick(); await tick();
  assert.equal(panel.pagers.posts, old);
  assert.equal(old.error, null, "no error pinned on the old pager");
});

await test("1 a current refresh still lands as before", async () => {
  const { box, panel, pending } = profileBox();
  box.fns.refreshProfilePanel(panel);
  const fresh = panel.pagers.posts;
  pending.shift().resolve({ posts: [{ id: "n1" }], pagination: null });
  await tick(); await tick();
  assert.equal(panel.pagers.posts, fresh);
  assert.equal(fresh.loading, false);
  assert.deepEqual(panel.posts.map((p) => p.remoteId), ["n1"]);
});

// --- 2. bot challenges name only the post's author --------------------------------------------
const fromHex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const keyAddress = (n) => addressOf(schnorr.getPublicKey(fromHex(n.toString(16).padStart(64, "0"))), "kaspa");
const BY = keyAddress(3);
const AUTHOR_OTHER = keyAddress(5);

await test("2 botConfirmedBy names by only when it signed the post", () => {
  const challenge = parseBotChallengeLink(`kachatchess://bot/3?moves=14&by=${BY}`);
  assert.ok(challenge?.by, "a valid by");
  assert.equal(botConfirmedBy(challenge, BY), BY);
  assert.equal(botConfirmedBy(challenge, BY.toUpperCase()), BY, "address case does not matter");
  assert.equal(botConfirmedBy(challenge, AUTHOR_OTHER), null, "someone else's post");
  assert.equal(botConfirmedBy(challenge, null), null, "no post (opened from outside)");
  assert.equal(botConfirmedBy({ level: 3, by: null }, BY), null);
  assert.equal(botChallengeBannerText({ challenge, botName: "Bot", who: "", unlocked: true }), "Someone beat Bot in 14 moves. Can you do it in fewer?", "no confirmed name: Someone");
  assert.equal(botChallengeBannerText({ challenge, botName: "Bot", who: null, unlocked: true }), "Someone beat Bot in 14 moves. Can you do it in fewer?");
});

await test("2 the KaPlay banner names the winner only for the author's own post", () => {
  const challenge = parseBotChallengeLink(`kachatchess://bot/2?moves=9&by=${BY}`);
  const banner = (author) => {
    const box = sandbox([extractFunction(chessBots, "challengeBannerHtml")], {
      challenge: author === undefined ? challenge : { ...challenge, author },
      chessBot: (level) => ({ level, name: "Bot" }),
      deps: () => ({ displayNameFor: (address) => (address === BY ? "alice.kas" : "mallory.kas") }),
      botChallengeBannerText, botConfirmedBy,
      isBotUnlocked: () => true, loadRecords: () => ({}),
      esc: (text) => String(text), ICON_CROSSED_FLAGS: "",
    });
    return box.fns.challengeBannerHtml();
  };
  assert.match(banner(BY), /alice\.kas beat Bot in 9 moves/, "the author is the winner: named");
  assert.match(banner(AUTHOR_OTHER), /Someone beat Bot in 9 moves/, "someone else posted it: Someone");
  assert.doesNotMatch(banner(AUTHOR_OTHER), /alice/);
  assert.match(banner(undefined), /Someone beat Bot/, "a link with no post (outside, or app.js not passing one): Someone");
  assert.match(banner(null), /Someone beat Bot/);
});

await test("2 the Posts card click passes the post's signer with a bot challenge (source)", () => {
  const at = kaposts.indexOf("const botCard = event.target.closest(\"[data-kaposts-bot-challenge]\");\n    if (botCard)");
  assert.ok(at > 0);
  const block = kaposts.slice(at, at + 800);
  assert.match(block, /deps\.openKaChatLink\?\.\(found\.challenge\.url, \{ author: post\.posterAddress \|\| null \}\)/);
});

console.log(`ok audit 2026-11-27 posts (${passed} tests)`);
