// node tools/test-ios-d7c56280.mjs - KaChat iOS d7c56280 and KaPost 63c9861: deleted group messages
// stay deleted, "GIF" in previews, chat link previews' redirect / https / Referer rules, and the
// KaPost feed's one-direction swipe lock.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isSameSiteHost } from "../engine/link-preview-policy.js";
import { previewPolicyOf, previewHopRefusal, previewHopHeaders, isAllowedPreviewRedirect } from "./relay-rules.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const app = read("ui/app.js");

let failures = 0;
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.log(`FAIL - ${name}\n`, error); }
}

await test("a deleted group message is remembered per account and never comes back", () => {
  assert.match(app, /const DELETED_GROUP_MESSAGES_KEY = "kachat-deleted-group-messages-v1";/);
  assert.match(app, /const DELETED_GROUP_MESSAGES_CAP = 20_000;/);
  assert.match(app, /accountScopedKey\(DELETED_GROUP_MESSAGES_KEY\)/);
  assert.match(app, /function appendGroupMessage\(groupId, message\) \{\n\s+if \(isDeletedGroupMessage\(message\)\) return false;/);
  assert.match(app, /for \(const message of messages \|\| \[\]\) \{\n\s+if \(isDeletedGroupMessage\(message\)\) continue;/);
  assert.match(app, /rememberDeletedGroupMessages\(all\.filter\(\(m\) => keys\.has\(groupMsgKey\(m\)\)\)\);/);
  const prune = app.slice(app.indexOf("function pruneExpiredGroupSystemMessages"), app.indexOf("function saveGroupMessages("));
  assert.doesNotMatch(prune, /rememberDeletedGroupMessages/, "expired system lines aren't recorded");
});
await test("previews say GIF for an image/gif", () => {
  assert.equal((app.match(/if \(fileMime\.toLowerCase\(\) === "image\/gif"\) return "GIF";/g) || []).length, 3);
});
await test("chat previews: https og:image only; Referer same-site; crawler retry only on Meta's servers", () => {
  assert.match(app, /if \(image && !\/\^https:\/i\.test\(image\)\) image = "";/);
  assert.match(app, /sameSite \? \{ "x-preview-image": "1", "x-preview-referer": pageUrl \} : \{ "x-preview-image": "1" \}/);
  assert.match(app, /if \(!metaImageHost\) throw error;/);
  assert.ok(isSameSiteHost("www.x.com", "x.com"));
  assert.ok(isSameSiteHost("x.com", "cdn.x.com"));
  assert.ok(!isSameSiteHost("x.com", "evilx.com"));
});
await test("chat preview redirects: same host or https on a public name only", () => {
  const from = new URL("http://example.com/a");
  assert.ok(isAllowedPreviewRedirect(from, new URL("http://example.com/b")), "same host over http");
  assert.ok(isAllowedPreviewRedirect(from, new URL("https://other.org/")));
  assert.ok(!isAllowedPreviewRedirect(from, new URL("http://other.org/")), "plain http elsewhere");
  for (const bad of ["https://localhost/", "https://a.localhost/", "https://printer.local/", "https://intranet/", "https://10.0.0.1/", "https://[::1]/", "https://8.8.8.8/"]) {
    assert.ok(!isAllowedPreviewRedirect(from, new URL(bad)), bad);
  }
  const headers = { "x-preview": "1", referer: "https://news.example.com/a" };
  const policy = previewPolicyOf(headers);
  assert.equal(policy.kind, "chat");
  assert.equal(previewHopRefusal(policy, new URL("https://news.example.com/a"), 0), null);
  assert.ok(previewHopRefusal(policy, new URL("http://tracker.example.net/"), 1));
  assert.equal(previewHopHeaders(policy, headers, new URL("https://cdn.news.example.com/x")).referer, "https://news.example.com/a", "same site keeps it");
  assert.equal(previewHopHeaders(policy, headers, new URL("https://elsewhere.org/x")).referer, undefined, "leaving the site drops it");
  assert.equal(previewPolicyOf({ accept: "x" }), null, "not a preview: untouched");
});
await test("KaPost feed: 10 px, 1.3x sideways, the lock holds to the end", async () => {
  const { KAPOSTS_PAGER_LOCK_PX, KAPOSTS_PAGER_SIDEWAYS_BIAS, kapostsAxisLock, kapostsPagerTarget } = await import("../ui/kaposts-format.js");
  assert.equal(KAPOSTS_PAGER_LOCK_PX, 10);
  assert.equal(KAPOSTS_PAGER_SIDEWAYS_BIAS, 1.3);
  assert.equal(kapostsAxisLock(12, 10), "y");
  assert.equal(kapostsPagerTarget({ selection: 0, pageCount: 2, dx: -200, dy: 300, width: 400, locked: true }), 1);
  // The feeds no longer swipe (K 518fdc8c: one cycle button, no sideways swipe); the rule stays tested.
  assert.doesNotMatch(read("ui/kaposts.js"), /attachFeedPager|kapostsPagerTarget\(/);
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log(`ios d7c56280: ${passed} passed`);
