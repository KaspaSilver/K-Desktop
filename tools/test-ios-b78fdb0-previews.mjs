// node tools/test-ios-b78fdb0-previews.mjs - KaPost iOS b78fdb0's link preview rules (Build 302):
// posts and Public Chats preview a link only for a sender with a .kachat name, only an explicit
// link to an allowed site with no adult words; redirects and images held to the same list by both
// relays; social networks drawn as their logo; 1:1 chats untouched.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allowsPreview, allowsPreviewPage, allowsPreviewRedirect, allowsPreviewImage, firstExplicitLink,
  hasBlockedPreviewWords, socialPreviewBrand, previewPolicyRefusal,
} from "../engine/link-preview-policy.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");

let failures = 0;
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.log(`FAIL - ${name}\n`, error); }
}

await test("an allowed site and its subdomains; anything else, credentials or a port is refused", () => {
  assert.ok(allowsPreview("https://x.com/kaspa/status/1"));
  assert.ok(allowsPreview("https://mobile.twitter.com/a"));
  assert.ok(allowsPreview("http://en.wikipedia.org/wiki/Kaspa"));
  assert.ok(allowsPreview("https://www.youtube.com/watch?v=abc"));
  assert.ok(!allowsPreview("https://evil.example/x"));
  assert.ok(!allowsPreview("https://x.com.evil.example/"));
  assert.ok(!allowsPreview("https://user:pw@x.com/"));
  assert.ok(!allowsPreview("https://x.com:8443/"));
  assert.ok(!allowsPreview("ftp://x.com/"));
});
await test("adult words anywhere (decoded), sex/sexy only as whole words", () => {
  assert.ok(hasBlockedPreviewWords("https://x.com/porn"));
  assert.ok(hasBlockedPreviewWords("https://x.com/%2570orn"), "twice encoded");
  assert.ok(hasBlockedPreviewWords("https://reddit.com/r/sexy-pics"));
  assert.ok(!hasBlockedPreviewWords("https://bbc.co.uk/news/sussex-essex-unisex"));
  assert.ok(!allowsPreview("https://x.com/i/nsfw"));
});
await test("redirects only to allowed https pages; images only from the site or its image servers", () => {
  assert.ok(allowsPreviewRedirect("https://mobile.x.com/a"));
  assert.ok(!allowsPreviewRedirect("http://x.com/a"), "https only");
  assert.ok(!allowsPreviewRedirect("https://tracker.example/a"));
  assert.ok(allowsPreviewImage("https://pbs.twimg.com/media/a.jpg", "https://x.com/a"));
  assert.ok(allowsPreviewImage("https://img.youtube.com/vi/a/hqdefault.jpg", "https://youtube.com/watch?v=a"));
  assert.ok(!allowsPreviewImage("http://pbs.twimg.com/a.jpg", "https://x.com/a"), "https only");
  assert.ok(!allowsPreviewImage("https://s3.amazonaws.com/a.jpg", "https://x.com/a"));
  assert.ok(!allowsPreviewImage("https://pbs.twimg.com/a.jpg", "https://evil.example/"), "for an allowed page only");
  assert.ok(allowsPreviewPage("https://home.kachat.app/kachat/"), "KaChat's own site");
});
await test("only a link written as a link previews", () => {
  assert.equal(firstExplicitLink("I left facebook.com last year"), null);
  assert.equal(firstExplicitLink("see www.bbc.com/news.").url, "https://www.bbc.com/news");
  assert.equal(firstExplicitLink("watch https://youtu.be/abc!").raw, "https://youtu.be/abc");
});
await test("a post's card: named posters only, the link left out of the text, KaChat links skipped", async () => {
  const { kapostsPreviewLinkIn } = await import("../ui/kaposts-format.js");
  const text = "Big news https://www.reuters.com/markets/kaspa today";
  assert.equal(kapostsPreviewLinkIn(text, { named: false }), null);
  const card = kapostsPreviewLinkIn(text, { named: true });
  assert.equal(card.url, "https://www.reuters.com/markets/kaspa");
  assert.equal(card.bodyText, "Big news  today");
  assert.equal(kapostsPreviewLinkIn("look https://evil.example/x", { named: true }), null);
  assert.equal(kapostsPreviewLinkIn("https://kachat.app/post/" + "a".repeat(64), { named: true }), null, "a KaChat link has its own card");
  assert.equal(kapostsPreviewLinkIn("https://home.kachat.app/kachat/", { named: true }).url, "https://home.kachat.app/kachat/");
});
await test("social networks draw their logo; YouTube keeps its thumbnail", async () => {
  assert.equal(socialPreviewBrand("https://x.com/a"), "x");
  assert.equal(socialPreviewBrand("https://www.instagram.com/p/1"), "instagram");
  assert.equal(socialPreviewBrand("https://threads.net/@a"), "threads");
  assert.equal(socialPreviewBrand("https://youtube.com/watch?v=a"), null);
  const { SOCIAL_LOGOS } = await import("../ui/social-logos.js");
  assert.deepEqual(Object.keys(SOCIAL_LOGOS).sort(), ["facebook", "instagram", "linkedin", "threads", "tiktok", "x"]);
  assert.equal(SOCIAL_LOGOS.instagram.color, "#E4405F");
});
await test("both relays hold every hop of a KaPost preview to the policy", async () => {
  assert.equal(previewPolicyRefusal("page", "https://x.com/a", { hop: 0 }), null);
  assert.ok(previewPolicyRefusal("page", "https://evil.example/", { hop: 1 }));
  const { previewPolicyOf, previewHopHeaders } = await import("./relay-rules.mjs");
  const headers = { "x-preview-policy": "image", "x-preview-referer": "https://x.com/a", referer: "https://x.com/a" };
  const policy = previewPolicyOf(headers);
  assert.equal(policy.kind, "image");
  assert.ok(!("x-preview-policy" in headers), "stripped before it leaves");
  assert.equal(previewHopHeaders(policy, headers, new URL("https://pbs.twimg.com/a.jpg")).referer, undefined, "Referer only to the page's own host");
  assert.equal(previewHopHeaders(policy, headers, new URL("https://x.com/b.jpg")).referer, "https://x.com/a");
  for (const file of ["tools/relay-guard.mjs", "functions/nc-proxy/[[path]].js"]) {
    assert.match(read(file), /const policyRefusal = previewHopRefusal\(previewPolicy, hopTarget, hop\);/, file);
  }
});
await test("posts and rooms ask for a .kachat name; rooms no longer tap-to-load; chats unchanged", () => {
  const feed = read("ui/kaposts.js");
  const rooms = read("ui/broadcasts.js");
  assert.match(feed, /kapostsPreviewLinkIn\(textWithoutCards, \{ named: Boolean\(deps\.hasKachatName\?\.\(post\.posterAddress\)\) \}\)/);
  assert.match(rooms, /if \(!senderNamed \|\| !\(isKaChatSiteLink\(url\) \|\| allowsPreview\(url\)\)\) return null;/);
  assert.doesNotMatch(rooms, /buildTapToLoadCard/);
  assert.match(read("ui/app.js"), /hasKachatName: \(address\) => Boolean\(address && kachatCachedLabel\(address\)\),/);
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log(`ios b78fdb0 previews: ${passed} passed`);
