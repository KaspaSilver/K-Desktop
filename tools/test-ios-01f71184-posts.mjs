// node tools/test-ios-01f71184-posts.mjs - K 01f71184 (release + smoothness audits 2026-11-27), the
// Posts parts: a repost of a repost shows the post reposted (feed card and quote composer); Following
// and Feed/Popular keep their own posts, paging, pill and place; your reply to your own post joins
// its thread at once; the outage's block stream only while Posts is on screen and not metered, and
// timeouts right after a network change don't count; a new thread level opens at its top; names.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRepostOrigins, isPlainRepost, quoteCardShown, composerQuoteShown, REPOST_ORIGIN_MAX_HOPS, REPOST_ORIGIN_RETRY_MS,
} from "../ui/kaposts-repost-origins.js";
import { stashFeedSource, restoredFeedIsFresh } from "../ui/kaposts-feed-sources.js";
import { selfThreadChainRoot } from "../ui/kaposts-x-rules.js";
import { createKaPostLiveFeed } from "../engine/kaposts-chain-fallback.js";
import { indexerFetchOutcome, noteNetworkChange, msSinceNetworkChange, INDEXER_NETWORK_CHANGE_GRACE_MS } from "../engine/indexer-health.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const kaposts = read("ui/kaposts.js");
const engineKaposts = read("engine/kaposts.js");
const fnText = (name) => {
  const start = kaposts.search(new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} exists`);
  const next = kaposts.indexOf("\n}\n", start);
  return kaposts.slice(start, next + 3);
};

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const id = (n) => n.toString(16).padStart(64, "0");
const ref = (n, text, who = `kaspa:${n}`) => ({ remoteId: id(n), text, posterAddress: who, timestamp: n * 1000, posterPubkey: `02${id(n)}` });

// --- 1. Repost of a repost --------------------------------------------------------------------------

test("a plain repost is a quote with an id and no words", () => {
  assert.equal(isPlainRepost(ref(1, "")), true);
  assert.equal(isPlainRepost(ref(1, "  \n ")), true);
  assert.equal(isPlainRepost(ref(1, "words")), false);
  assert.equal(isPlainRepost({ remoteId: null, text: "" }), false);
  assert.equal(isPlainRepost(null), false);
});

test("the original is followed through reposts to the first post with words, once per id", async () => {
  const quotes = new Map([[id(1), ref(2, "")], [id(2), ref(3, "")], [id(3), ref(4, "the words")]]);
  let asked = 0;
  const origins = createRepostOrigins({ quoteOf: async (postId) => { asked += 1; return quotes.get(postId) || null; } });
  const card = ref(1, "");
  assert.equal(origins.wants(card), true);
  const [a, b] = await Promise.all([origins.original(card), origins.original(card)]);
  assert.equal(a.text, "the words");
  assert.equal(a, b, "one lookup in flight per id");
  assert.equal(asked, 3);
  assert.equal(origins.cached(card).remoteId, id(4));
  assert.equal(origins.wants(card), false, "found: not asked again");
  await origins.original(card);
  assert.equal(asked, 3);
  assert.equal(origins.wants(ref(9, "has words")), false, "a quote with words needs nothing");
});

test("at most 5 reposts deep, a loop stops, and a failure waits 2 minutes", async () => {
  assert.equal(REPOST_ORIGIN_MAX_HOPS, 5);
  const deep = createRepostOrigins({ quoteOf: async (postId) => ref(parseInt(postId, 16) + 1, "") });
  assert.equal(await deep.original(ref(1, "")), null, "never reaches words");
  const loop = createRepostOrigins({ quoteOf: async (postId) => (postId === id(1) ? ref(2, "") : ref(1, "")) });
  assert.equal(await loop.original(ref(1, "")), null);
  let clock = 1_000_000;
  let answer = null;
  const flaky = createRepostOrigins({ quoteOf: async () => { if (!answer) throw new Error("down"); return answer; }, now: () => clock });
  assert.equal(await flaky.original(ref(1, "")), null);
  answer = ref(5, "back");
  assert.equal(flaky.wants(ref(1, "")), false, "a failed lookup waits");
  assert.equal(await flaky.original(ref(1, "")), null);
  clock += REPOST_ORIGIN_RETRY_MS;
  assert.equal(flaky.wants(ref(1, "")), true);
  assert.equal((await flaky.original(ref(1, ""))).text, "back");
});

test("the card shows the original (another author), the composer quotes a repost's post", () => {
  const middle = ref(2, "", "kaspa:middle");
  const original = ref(3, "the words", "kaspa:author");
  assert.deepEqual(quoteCardShown(middle, null), { shown: middle, sameAuthor: true });
  assert.deepEqual(quoteCardShown(middle, original), { shown: original, sameAuthor: false });
  const repost = { remoteId: id(7), text: "", posterAddress: "kaspa:me", timestamp: 1, quoted: original };
  assert.equal(composerQuoteShown(repost).text, "the words");
  assert.equal(composerQuoteShown(repost).posterAddress, "kaspa:author");
  const repostOfRepost = { ...repost, quoted: middle };
  assert.equal(composerQuoteShown(repostOfRepost, original).text, "the words", "a found original wins");
  assert.deepEqual(composerQuoteShown(repostOfRepost, null), middle, "until it's found, the repost's own card");
  const own = { ...repost, text: "my take" };
  assert.equal(composerQuoteShown(own), own, "a quote with words is itself");
  assert.equal(composerQuoteShown(null), null);
});

test("ui: the feed's quote card and the composer go through the lookup", () => {
  assert.match(kaposts, /const quotedHtml = post\.quoted \? quoteEmbedHtml\(post\.quoted\) : "";/);
  const embed = fnText("quoteEmbedHtml");
  assert.match(embed, /quoteCardShown\(quoted, repostOrigins\.cached\(quoted\)\)/);
  assert.match(embed, /isHiddenAuthorLower\(shown\.posterAddress\)/);
  assert.match(embed, /data-kaposts-open-remote="\$\{deps\.escapeHtml\(shown\.remoteId\)\}"/, "a click opens the original");
  assert.match(embed, /kaposts-quote-looking/);
  const quoteOf = fnText("repostQuoteOf");
  assert.match(quoteOf, /await fetchPost\(/);
  assert.match(quoteOf, /await fetchChainPost\(id\)/, "else the chain");
  assert.match(quoteOf, /record\.action !== "quote"/);
  assert.match(fnText("lookUpRepostOrigin"), /schedulePosterRepaint\(\)/);
  assert.match(fnText("renderComposerQuoteCard"), /composerQuoteShown\(target, target\?\.quoted \? repostOrigins\.cached\(target\.quoted\) : null\)/);
  assert.match(fnText("resetKaPostsForAccount"), /repostOrigins\.clear\(\);/);
  assert.match(read("ui/kaposts-conversation.css"), /\.kaposts-quote-embed > span\.kaposts-quote-looking/);
});

// --- 2. Per-source feeds (P1) -----------------------------------------------------------------------

test("a source set aside keeps its posts, paging, pill and place; its pager has nothing in flight", () => {
  const pager = { cursor: "c2", hasMore: true, loading: true, seen: new Set(["a"]), firstPageGeneration: 4 };
  const posts = [{ id: "p1" }];
  const saved = stashFeedSource({ posts, pager, pendingNewPosts: [{ id: "n" }], pendingNewPostsHaveGap: true, loadedAt: 50, scrollTop: 640 });
  assert.equal(saved.posts, posts);
  assert.notEqual(saved.pager, pager, "a copy: the run still out keeps its own object");
  assert.equal(saved.pager.loading, false);
  assert.equal(saved.pager.cursor, "c2");
  assert.equal(saved.pager.firstPageGeneration, null);
  saved.pager.seen.add("b");
  assert.equal(pager.seen.has("b"), false);
  assert.equal(pager.loading, true, "the original is untouched");
  assert.equal(saved.pendingNewPostsHaveGap, true);
  assert.equal(saved.scrollTop, 640);
});

test("back within 5 minutes is fresh (only newer posts asked); later, empty or never loaded is not", () => {
  const minutes5 = 5 * 60_000;
  const saved = stashFeedSource({ posts: [{ id: "p" }], pager: { seen: [] }, loadedAt: 1_000, scrollTop: 0 });
  assert.equal(restoredFeedIsFresh(saved, 1_000 + minutes5 - 1, minutes5), true);
  assert.equal(restoredFeedIsFresh(saved, 1_000 + minutes5, minutes5), false);
  assert.equal(restoredFeedIsFresh({ ...saved, posts: [] }, 1_001, minutes5), false);
  assert.equal(restoredFeedIsFresh({ ...saved, loadedAt: 0 }, 1_001, minutes5), false);
  assert.equal(restoredFeedIsFresh(null, 1, minutes5), false);
});

test("ui: switching Following <-> Feed swaps the source; the stash follows likes, deletes, live posts, resets", () => {
  const select = fnText("selectFeedTab");
  assert.match(select, /const restored = switchFeedSource\(source\);/);
  assert.match(select, /if \(restoredFeedIsFresh\(restored, Date\.now\(\), FEED_STALE_AFTER_MS\)\) \{\n\s*checkForNewPosts\(\);/);
  assert.match(select, /scroller\.scrollTop = keepTop;/, "back where it was");
  assert.match(select, /loadFeed\(\)\.then\(deepen\);/);
  const swap = fnText("switchFeedSource");
  assert.match(swap, /feedGeneration \+= 1;/, "the outgoing source's pages in flight are dropped");
  assert.match(swap, /if \(outgoing && outgoing !== source && lastFeedLoadAt\) \{/);
  assert.match(swap, /stashFeedSource\(\{\n\s*posts: remotePosts, pager: feedPager, pendingNewPosts, pendingNewPostsHaveGap,/);
  assert.match(swap, /feedLoading = false;/);
  assert.match(fnText("mutatePost"), /for \(const stashed of stashedFeeds\.values\(\)\) walk\(stashed\.posts\);/);
  assert.match(fnText("removePostEverywhere"), /stashed\.posts = prune\(stashed\.posts\);/);
  assert.match(fnText("mergeLivePosts"), /stashed\.posts = livePostsMerged\(live, applyLiveAmendments\(stashed\.posts\), source\);/);
  assert.match(fnText("handleKaPostIndexerAvailability"), /stashedFeeds\.clear\(\);/);
  assert.match(fnText("resetKaPostsForAccount"), /stashedFeeds\.clear\(\);/);
});

// --- 3. Your reply to your own post joins its thread at once (T4) ------------------------------------

test("the reply continues the root with no chain yet, or the chain's last post; not a middle one", () => {
  const chains = new Map([["root", [{ id: "s1" }, { id: "s2" }]]]);
  assert.equal(selfThreadChainRoot(chains, "s2"), "root", "answers the chain's last post");
  assert.equal(selfThreadChainRoot(chains, "s1"), "s1", "a middle segment with no chain of its own is its own root");
  assert.equal(selfThreadChainRoot(chains, "root"), null, "the root with a chain: a comment, as on K");
  assert.equal(selfThreadChainRoot(chains, "other"), "other");
  assert.equal(selfThreadChainRoot(new Map(), "p"), "p");
});

test("ui: a sent reply to your own post is added to the chain and marks the root", () => {
  const reply = fnText("submitReply");
  assert.match(reply, /mutatePost\(comment\.id, \(p\) => \{ p\.remoteId = txid; p\.delivery = "sent"; \}\);\n\s*if \(deps\.engine\?\.address && parent\.posterAddress === deps\.engine\.address\) extendSelfThreadChain\(parent\.id, comment\.id\);/);
  const extend = fnText("extendSelfThreadChain");
  assert.match(extend, /selfThreadChainRoot\(threadChains, parentId\)/);
  assert.match(extend, /root\.posterAddress !== reply\.posterAddress/);
  assert.match(extend, /threadChains\.set\(rootId, \[\.\.\.chain, reply\]\);/);
  assert.match(extend, /threadRootProbe\.set\(root\.remoteId, true\);/);
});

// --- 4. The outage's block stream (B1) --------------------------------------------------------------

test("blocks stream only during the outage with Posts on screen on an unmetered path; posts stay", () => {
  const live = createKaPostLiveFeed();
  let added = 0;
  let removed = 0;
  const engine = { addBlockScanClient: () => { added += 1; return () => { removed += 1; }; } };
  live.setActive(engine, true);
  assert.equal(live.isStreaming(), false, "down, but Posts isn't on screen");
  assert.equal(added, 0);
  live.setOnScreen(true);
  assert.equal(live.isStreaming(), true);
  assert.equal(added, 1);
  live.setExpensivePath(true);
  assert.equal(live.isStreaming(), false, "metered: off");
  assert.equal(removed, 1);
  live.setExpensivePath(false);
  live.setOnScreen(false);
  assert.equal(removed, 2, "left Posts: off");
  assert.equal(live.isActive(), true, "the outage goes on");
  live.setOnScreen(true);
  live.setActive(engine, false);
  assert.equal(live.isStreaming(), false);
  assert.equal(added, 3);
  assert.equal(removed, 3);
  live.setActive(engine, false);
  live.setOnScreen(true);
  assert.equal(added, 3, "up again: nothing streams");
});

test("timeouts and dropped connections within 30 s of a network change don't count", () => {
  assert.equal(INDEXER_NETWORK_CHANGE_GRACE_MS, 30_000);
  const timeout = Object.assign(new Error("aborted"), { name: "AbortError" });
  const o = (args) => indexerFetchOutcome({ offline: false, ...args });
  assert.equal(o({ error: new TypeError("x"), sinceNetworkChangeMs: 5_000 }), "inconclusive");
  assert.equal(o({ error: timeout, elapsedMs: 12_000, sinceNetworkChangeMs: 29_999 }), "inconclusive");
  assert.equal(o({ error: timeout, elapsedMs: 12_000, sinceNetworkChangeMs: 30_000 }), "down");
  assert.equal(o({ error: new TypeError("x"), sinceNetworkChangeMs: Infinity }), "down");
  assert.equal(o({ response: { status: 503 }, sinceNetworkChangeMs: 1_000 }), "down", "an answer still counts");
  noteNetworkChange(1_000);
  assert.equal(msSinceNetworkChange(4_000), 3_000);
  noteNetworkChange(-Infinity); // as before any change, for the rest of the run
});

test("ui: the gates follow the Posts tab, the page's visibility and navigator.connection", () => {
  assert.match(fnText("stopKaPostsPolling"), /setPostsTabOnScreen\(false\);/);
  assert.match(fnText("refreshKaPostsFeed"), /startNewPostsCheck\(\);\n\s*setPostsTabOnScreen\(true\);/);
  assert.match(fnText("setPostsTabOnScreen"), /kapostLiveFeed\.setOnScreen\(postsTabShown && !document\.hidden\);/);
  assert.match(fnText("kapostsPathIsExpensive"), /connection\.saveData === true \|\| connection\.type === "cellular"/);
  const gates = fnText("wireLiveFeedGates");
  assert.match(gates, /addEventListener\("visibilitychange"/);
  assert.match(gates, /navigator\.connection\?\.addEventListener\?\.\("change"/);
  const health = read("engine/indexer-health.js");
  assert.match(health, /globalThis\.addEventListener\("online", \(\) => noteNetworkChange\(\)\);/);
  assert.match(health, /navigator\?\.connection\?\.addEventListener\?\.\("change", \(\) => noteNetworkChange\(\)\);/);
});

// --- 5. Names -----------------------------------------------------------------------------------------

test("Posts in the screen's own text; the Testnet note keeps Desktop's Settings path", () => {
  assert.match(kaposts, /"Posts' server isn't answering\. Showing saved posts and new ones from the network\."/);
  assert.match(kaposts, /title="Opens Posts, where everyone's posts are\."/);
  assert.match(engineKaposts, /throw new Error\("Posts isn't available on Testnet yet\."\);/);
  assert.doesNotMatch(kaposts, /title: "KaPost"/);
  assert.doesNotMatch(kaposts, /KaPost's server/);
  assert.match(kaposts, /There is no Posts indexer for testnet\. Turn off Testnet in Settings > Connection to read and post on mainnet\./);
});

// --- 6. A new thread level opens at its top (P5) -------------------------------------------------------

test("opening a level, and Back to an outer one, start at the top", () => {
  assert.match(fnText("openThread"), /threadStack\.push\(post\.id\);\n(?:\s*\/\/[^\n]*\n)+\s*const levelScroller = kapostsScrollEl\(\);\n\s*if \(levelScroller\) levelScroller\.scrollTop = 0;/);
  assert.match(kaposts, /if \(threadStack\.length > 0\) \{ const levelScroller = kapostsScrollEl\(\); if \(levelScroller\) levelScroller\.scrollTop = 0; \}\n\s*renderThread\(\);/);
});

let passed = 0;
for (const [name, fn] of tests) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}
console.log(`ios-01f71184-posts: ${passed}/${tests.length} passed`);
