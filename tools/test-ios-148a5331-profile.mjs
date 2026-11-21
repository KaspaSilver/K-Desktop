// KaChat iOS 148a5331: the dock's Profile tab is your KaPost profile (KaPostsView rootMode
// .myProfile) with Edit / Share / Log Out, See All Posts, a compose button and one bell holding
// KaPost's notifications and the wallet's. KaPost's menu loses Profile, Notifications and Settings;
// Settings gains KaPost and Help; Your Domains moves to Wallet.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8");
const app = read("ui", "app.js");
const kaposts = read("ui", "kaposts.js");
const html = read("index.html");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

test("Profile shows KaPost's screen in its profile mode, behind the Terms", () => {
  assert.doesNotMatch(html, /data-app-tab-screen="profile"/);
  assert.match(app, /const shown = screenTab === "profile" \? "kaposts" : /);
  assert.match(app, /if \(screenTab === "profile"\) \{ try \{ setKaPostsRootMode\("myProfile"\); \}/);
  assert.match(app, /const kaPostScreen = tab === "kaposts" \|\| tab === "profile"/);
});

test("your profile is the root page: no back, closes back to it", () => {
  assert.match(kaposts, /export function setKaPostsRootMode\(mode\)/);
  assert.match(kaposts, /function closePanel\(\) \{\n  \/\/ The Profile tab's own profile is its page, not something to close\.\n  if \(isRootProfilePanel\(activePanel\)\) return;/);
  assert.match(kaposts, /if \(!activePanel && rootMode === "myProfile" && threadStack\.length === 0 && deps\?\.engine\?\.address\) \{/);
  assert.match(kaposts, /panelEl\?\.toggleAttribute\("data-kaposts-panel-root", show && isRootProfilePanel\(activePanel\)\);/);
});

test("Edit Profile, Share Profile, Log Out and See All Posts", () => {
  for (const label of ["Edit Profile", "Share Profile", "Log Out", "See All Posts"]) assert.ok(kaposts.includes(`${label}</button>`), label);
  assert.match(app, /shareProfile: \(\) => shareOwnProfile\(\),/);
  assert.match(app, /logOut: \(\) => openLogoutModal\(\),/);
});

test("one bell: KaPost's rows and the wallet's, newest first; both marked seen on open", () => {
  assert.match(kaposts, /const items = \[\.\.\.\(panel\.items \|\| \[\]\), \.\.\.walletRows\]\n      \.sort\(\(a, b\) => \(Number\(b\.timestamp\) \|\| 0\) - \(Number\(a\.timestamp\) \|\| 0\)\);/);
  assert.match(kaposts, /deps\.markWalletNotificationsSeen\?\.\(\);\n  markAllKaPostsNotificationsSeen\(\);/);
  assert.match(app, /if \(tab === "profile"\) return unreadNotifCount\(\) \+ \(Number\(kaPostsUnseenCount\(\)\) \|\| 0\);/);
});

test("KaPost's menu loses Profile, Notifications and Settings", () => {
  for (const key of ["profile", "notifications", "settings"]) assert.doesNotMatch(html, new RegExp(`data-kaposts-rail="${key}"`));
  assert.doesNotMatch(kaposts, /data-kaposts-phone-section="(profile|notifications|settings)"/);
});

test("Settings has KaPost and Help; the topbar Help button is gone; Your Domains is on Wallet", () => {
  assert.match(app, /data-settings-hub-kapost/);
  assert.match(app, /data-settings-hub-help/);
  assert.doesNotMatch(html, /data-open-help-screen/);
  const wallet = html.slice(html.indexOf('data-app-tab-screen="wallet"'));
  const next = wallet.indexOf("data-app-tab-screen=", 40);
  const at = wallet.indexOf("data-open-domains-screen");
  assert.ok(at > 0 && (next < 0 || at < next));
  assert.equal(html.split("data-open-domains-screen").length, 2);
});

console.log(`ios 148a5331 profile: ${passed} passed`);
