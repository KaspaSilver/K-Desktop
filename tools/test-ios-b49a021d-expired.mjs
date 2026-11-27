// node tools/test-ios-b49a021d-expired.mjs - K b49a021d (owner 2026-11-27: "make sure no one misses
// it"): a username of yours in grace shows everywhere until it's renewed - a red dot on the dock's
// Wallet, "1 Expired" on Your Usernames, a red "Expired: Renew Before Grace Ends" badge on its card
// and a red status pill - and the app reminds about every name, a week before grace ends too.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const app = read("ui/app.js");
const html = read("index.html");
const live = read("ui/kachat-names-live.js");
const liveCss = read("ui/kachat-names-live.css");
const notifier = read("ui/kachat-names-notifier.js");

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`ok - ${name}`); }

await test("Wallet's dock dot, from any tab, until the name is renewed", () => {
  assert.match(app, /if \(tab === "wallet"\) return kachatExpiredAll\(\)\.length;/);
  assert.match(app, /const dot = tab === "profile" \|\| tab === "wallet";/);
  assert.match(app, /function kachatExpiredAll\(\) \{\n\s+const st = renderKachatExpiredBanner\.state;\n\s+return st && st\.address === engine\.address \? st\.expired \|\| \[\] : \[\];/, "dismissing the banner doesn't clear it");
  assert.match(app, /try \{ refreshTabBadges\(\); renderProfileDomains\(\); \} catch/);
  assert.match(app, /\/\/ Your names in grace, from any tab \(K b49a021d DockBadgeSync\)[^\n]*\n[^\n]*\n\s+try \{ refreshKachatOwnedCount\(\); \}/);
});
await test("Your Usernames: \"1 Expired\" in red beside the count", () => {
  assert.match(html, /<span class="profile-domains-expired" data-profile-domains-expired hidden><\/span>\s*<span class="profile-domains-count" data-profile-domains-count><\/span>/);
  assert.match(app, /expiredEl\.innerHTML = expired \? `<svg[^`]*<\/svg>\$\{expired\} Expired` : "";/);
  assert.match(app, /String\(Math\.max\(kachatOwnedCount, expired\)\)/);
});
await test("a name in grace: a red badge that says what to do, a red status pill", () => {
  assert.match(live, /case Status\.grace: return EXPIRED_BADGE;/);
  assert.match(live, /const EXPIRED_BADGE = "Expired: Renew Before Grace Ends";/);
  assert.match(live, /\$\{domainBadgeHtml\(b, "kns-domain-primary"\)\}/);
  assert.match(live, /\$\{domainBadgeHtml\(badge, "kl-tile-soon"\)\}/);
  assert.match(liveCss, /\.kl-status-grace \{ color: var\(--ios-red\);/);
  assert.match(liveCss, /\.kns-badge-warning \{[^}]*background: var\(--ios-red\) !important;/);
});
await test("reminders for every name; renewal and expiry only where push doesn't send them; a week before grace ends", async () => {
  const R = await import("../engine/kachat-names/reminders.js");
  const day = 86_400_000;
  const E = 1_900_000_000_000;
  const n = { name: "alice", expiresAt: BigInt(E) };
  const kinds = (list) => list.map((w) => w.id.split("-").pop()).join(",");
  const long = { graceMs: BigInt(30 * day), renewWindowMs: BigInt(30 * day) };
  const ctx = { dayString: (ms) => `D${ms}`, wallet: "kaspa:qx", network: "mainnet" };
  assert.equal(kinds(R.wantedReminders([n], long, ctx)), "renew,grace,graceweek,lastcall");
  assert.equal(kinds(R.wantedReminders([n], long, { ...ctx, pushCovered: () => true })), "graceweek,lastcall", "push sends renewal and expiry");
  const week = R.wantedReminders([n], long, ctx).find((w) => w.id.endsWith("graceweek"));
  assert.equal(week.at, E + 30 * day - 7 * day);
  assert.equal(week.body, `Renew it before D${E + 30 * day} or anyone can claim it.`);
  assert.equal(kinds(R.wantedReminders([n], { graceMs: BigInt(7 * day), renewWindowMs: BigInt(day) }, ctx)), "renew,grace,lastcall", "no week's warning in a short grace");
  assert.match(notifier, /updateReminders\(wallet, owned, params, \{ pushCovered: \(n\) => pushOn && bytesEqual\(n\.owner, me\) \}\)/);
  assert.match(app, /pushCoversChatting: \(\) => webPushStatus\(\)\.state === "on",/);
});
console.log(`ios b49a021d expired: ${passed} passed`);
