// K 2251f15c (owner, 2026-11-26): a new chat's photos wait behind Tap to View (they used to stay
// hidden), and User Info opens with Profile's header: banner, avatar, See All Posts, the name with
// its pencil, Following / Followers, the bio, then Add as Contact and Share; .kachat Names is
// Usernames.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (...p) => readFileSync(new URL(`../${p.join("/")}`, import.meta.url), "utf8");
const app = read("ui", "app.js");
const html = read("index.html");
const kaposts = read("ui", "kaposts.js");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}
function fnSource(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const ends = ["\nfunction ", "\nasync function ", "\nexport ", "\n// ", "\nconst ", "\nlet ", "\ndocument."]
    .map((m) => text.indexOf(m, start + 10)).filter((i) => i > 0);
  return text.slice(start, Math.min(...ends));
}

test("a photo held back is a Tap to View tile, open for this session once tapped", () => {
  const held = fnSource(app, "photoHeldBack");
  const run = new Function("photosAreHidden", "heldPhotoReveals", `${held}; return photoHeldBack;`);
  const reveals = new Set();
  const photoHeldBack = run((at) => Date.now() < at, reveals);
  const soon = Date.now() + 60_000;
  assert.equal(photoHeldBack({ direction: "incoming", txId: "t1" }, soon), true);
  assert.equal(photoHeldBack({ direction: "outgoing", txId: "t2" }, soon), false, "your own photos always show");
  assert.equal(photoHeldBack({ direction: "incoming", txId: "t1" }, Date.now() - 1), false, "after the 10 minutes, every photo shows");
  reveals.add("t1");
  assert.equal(photoHeldBack({ direction: "incoming", txId: "t1" }, soon), false, "tapped open");
  assert.equal(photoHeldBack({ direction: "incoming", txId: "t3" }, soon), true, "only that one");
  const tile = fnSource(app, "buildHiddenPhotoTile");
  assert.match(tile, /document\.createElement\("button"\)/);
  assert.match(tile, /<b class="message-photo-held-pill">Tap to view<\/b>/);
  assert.match(tile, /heldPhotoReveals\.add\(key\);\n\s*scheduleActiveThreadRerender\(\);/);
  assert.doesNotMatch(tile, /It shows 10 minutes after/);
  // every held place: one photo, a multi-part photo, a photo link's card; and a reveal redraws the rows
  assert.equal((app.match(/buildHiddenPhotoTile\(peerName, message\)/g) || []).length, 3);
  assert.match(app, /photosAreHidden\(photosUnlockAt\), heldPhotoReveals\.size, engine\.address/);
});

test("User Info's header: banner or gradient, avatar with See All Posts, name, counts, bio, then Add as Contact and Share", () => {
  const card = html.slice(html.indexOf('<div class="profile-card chat-info-header-card">'), html.indexOf('data-chat-info-rows'));
  const order = ["data-chat-info-banner", "data-chat-info-avatar-preview", "data-chat-info-see-posts", "data-chat-info-name-input",
    "data-chat-info-follow-counts", "data-chat-info-address-caption", "data-chat-info-bio", "data-chat-info-address-book", "data-chat-info-share"];
  let at = -1;
  for (const marker of order) {
    const next = card.indexOf(marker);
    assert.ok(next > at, `${marker} in order`);
    at = next;
  }
  assert.match(card, /class="chat-info-banner placeholder"/);
  assert.match(app, /banner\.classList\.add\("placeholder"\);/, "no banner: the gradient, never nothing");
  // the old row and round button are gone; the names row is Usernames
  assert.doesNotMatch(html, /Add to Contacts|chat-info-share-button/);
  assert.match(html, /<span class="chat-info-row-title">Usernames<\/span>/);
  assert.match(app, /"kachat-names": "Usernames",/);
  assert.match(app, /if \(title\) title\.textContent = saved \? "Edit Contact" : "Add as Contact";/);
});

test("See All Posts and the counts open Posts (yours: the Profile tab); a bot has none of them", () => {
  assert.match(app, /if \(seePosts\) seePosts\.hidden = isBot;/);
  assert.match(app, /if \(headerActions\) headerActions\.hidden = isBot;/);
  assert.match(app, /if \(followCounts\) followCounts\.hidden = isBot;/);
  assert.match(app, /openKaPostsProfileFor\(address\);/);
  assert.match(app, /openKaPostsFollowList\(address, pubkey, button\.dataset\.chatInfoFollowList\);/);
  const load = fnSource(app, "loadChatInfoFollowCounts");
  assert.match(load, /if \(load !== chatInfoFollowLoad \|\| chatInfoContactAddress !== address\) return;/, "a late answer for someone else is dropped");
  const profileFor = kaposts.slice(kaposts.indexOf("export function openKaPostsProfileFor("), kaposts.indexOf("export function openKaPostsFollowList("));
  assert.match(profileFor, /deps\.openProfileTab\?\.\(\); return;/);
  assert.match(profileFor, /deps\.openKaPostsTab\?\.\(\);\n\s*openPosterProfile\(address, null\);/);
  const counts = kaposts.slice(kaposts.indexOf("export async function kaPostsFollowCounts("), kaposts.indexOf("export function openKaPostsProfileFor("));
  assert.match(counts, /if \(mine\) details = ownProfileDetails\(details, pubkey\);/, "never your own follower");
});

console.log(`ios 2251f15c: ${passed} passed`);
