// K 8cb4c88e: the Profile tab's account switcher. A glass chip beside Profile's title opens an
// Accounts sheet of the accounts saved on this device; tapping another one logs out and signs in
// with the sign-in screen's own steps (its password included); Share Profile is the top-left
// button; Saved Accounts and the sheet show each account's own picture, saved in this browser while
// it was signed in and removed with the account.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { accountChipLabel, switcherAccounts, hasKeysOnThisDevice } from "../ui/account-switcher.js";
import {
  createSavedAccountAvatars, savedAvatarSourceFor, isStorableAvatarSrc, coverRect,
  SAVED_ACCOUNT_AVATARS_KEY, SAVED_ACCOUNT_AVATAR_MAX_CHARS,
} from "../ui/saved-account-avatars.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8");
const app = read("ui", "app.js");
const html = read("index.html");
const dialogs = read("ui", "dialogs.js");
const drawerCss = read("ui", "kaposts-drawer.css");
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}
const between = (source, start, end) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing ${end}`);
  return source.slice(from, to);
};

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

await test("the chip says your username, a long one cut in the middle, else your short address", () => {
  assert.equal(accountChipLabel({ username: "alice.kachat", address: "kaspa:qzvrabcdefghijkl9ug" }), "alice.kachat");
  assert.equal(accountChipLabel({ username: "averyveryverylongname.kachat" }), "averyvery….kachat");
  assert.equal(accountChipLabel({ address: "kaspa:qzvrabcdefghijkl9ug" }), "qzvr…l9ug");
  assert.equal(accountChipLabel({ address: "kaspatest:qpxyz" }), "qpxyz");
  assert.equal(accountChipLabel({}), "");
});

await test("the sheet lists the signed-in account first, then the rest in the sign-in screen's order", () => {
  const list = [{ address: "a" }, { address: "b" }, { address: "c" }];
  assert.deepEqual(switcherAccounts(list, (account) => account.address === "b").map((a) => a.address), ["b", "a", "c"]);
  assert.deepEqual(switcherAccounts(null, () => false), []);
});

await test("an account's keys are on this device in the clear or sealed under a password", () => {
  assert.equal(hasKeysOnThisDevice({ address: "a", privateKeyHex: "ab" }), true);
  assert.equal(hasKeysOnThisDevice({ address: "a", sealed: { v: 1, iv: "00", ct: "00" }, locked: true }), true);
  assert.equal(hasKeysOnThisDevice({ address: "a" }), false);
  assert.equal(hasKeysOnThisDevice(null), false);
});

await test("each account's picture is kept by its canonical address, and removed with it", () => {
  const storage = new MemoryStorage();
  const canonicalize = (address) => String(address).replace(/^kaspatest:/, "kaspa:");
  const avatars = createSavedAccountAvatars({ storage, canonicalize });
  assert.equal(avatars.get("kaspa:qme"), null);
  assert.equal(avatars.save("kaspa:qme", PNG), true);
  assert.equal(avatars.save("kaspa:qme", PNG), false, "the same picture isn't written again");
  assert.equal(avatars.get("kaspatest:qme"), PNG, "the same account on testnet");
  assert.equal(avatars.save("kaspa:qother", "https://example.com/a.png"), true);
  assert.equal(avatars.save("kaspa:qbad", "javascript:alert(1)"), false);
  assert.equal(avatars.save("kaspa:qbad", "http://example.com/a.png"), false, "https only");
  assert.equal(avatars.remove("kaspatest:qme"), true);
  assert.equal(avatars.get("kaspa:qme"), null);
  assert.equal(avatars.get("kaspa:qother"), "https://example.com/a.png");
  avatars.remove("kaspa:qother");
  assert.equal(storage.getItem(SAVED_ACCOUNT_AVATARS_KEY), null, "nothing left, nothing stored");
});

await test("only raster data URLs and https links are kept, and not huge ones", () => {
  assert.equal(isStorableAvatarSrc(PNG), true);
  assert.equal(isStorableAvatarSrc("data:image/svg+xml;base64,PHN2Zz4="), false);
  assert.equal(isStorableAvatarSrc("blob:https://x/1"), false);
  assert.equal(isStorableAvatarSrc(`data:image/png;base64,${"A".repeat(SAVED_ACCOUNT_AVATAR_MAX_CHARS)}`), false);
});

await test("a picture is copied small; one that can't be copied keeps its https link, a blob nothing", async () => {
  assert.equal(await savedAvatarSourceFor("https://x.test/a.png", { copy: async () => PNG }), PNG);
  const refuse = async () => { throw new Error("tainted"); };
  assert.equal(await savedAvatarSourceFor("https://x.test/a.png", { copy: refuse }), "https://x.test/a.png");
  assert.equal(await savedAvatarSourceFor("blob:https://x.test/1", { copy: refuse }), null);
  assert.equal(await savedAvatarSourceFor("", { copy: async () => PNG }), null);
  assert.deepEqual(coverRect(200, 100, 96), { x: -48, y: 0, width: 192, height: 96 });
});

await test("the switcher is the top-left button (your picture and a switch symbol), Share Profile beside the title (K 824a30bb)", () => {
  assert.match(html, /<button class="kaposts-edit-kns kaposts-title-share" type="button" data-kaposts-share-profile aria-label="Share Profile"[^>]*>\s*<svg[\s\S]*?<\/svg>Share Profile\s*<\/button>/);
  assert.match(html, /<button class="profile-account-chip" type="button" data-profile-account-chip aria-haspopup="dialog"[^>]*title="Switch Account"/);
  assert.match(html, /data-profile-account-chip-avatar/);
  assert.match(html, /<span class="profile-account-chip-label visually-hidden" data-profile-account-chip-label><\/span>/, "the name is for screen readers only");
  assert.match(html, /class="profile-account-chip-switch"/);
  assert.doesNotMatch(html, /profile-account-chip-chevron/);
  assert.match(drawerCss, /grid-template-areas: "chip \. \. refresh bell" "title share \. \. \.";/);
  assert.match(drawerCss, /\[data-kaposts-panel\]:not\(\[data-kaposts-panel-root\]\) \.profile-account-chip \{ display: none; \}/);
  assert.match(app, /profileAccountChip\?\.addEventListener\("click", \(\) => \{ openAccountSwitcher\(\); \}\);/);
});

await test("the Accounts sheet: Signed in, Recovery Phrase Needed, Add Another Account?", () => {
  const sheet = between(app, "async function openAccountSwitcher()", "async function switchToSavedAccount(");
  assert.match(sheet, /title: "Accounts"/);
  assert.match(sheet, /aria-label="Signed in"/);
  assert.match(sheet, /title: "Add Another Account"/);
  assert.match(sheet, /title: "Add Another Account\?",\n\s+message: "You'll go to the accounts screen to create or import one\. This account stays saved on this device\.",\n\s+confirmLabel: "Log Out"/);
  assert.match(sheet, /if \(ok && !savedAccountActionRunning\) await performLogout\(\);/);
  assert.match(sheet, /title: "Recovery Phrase Needed",\n\s+message: "This account's keys aren't on this device\. Log out, then sign in to it from the accounts screen with its recovery phrase\."/);
  assert.match(sheet, /if \(!account \|\| account\.current\) return;/);
  assert.match(sheet, /leadingHtml: savedAccountAvatarHtml\(account\.address\)/);
  // the sheet holds no keys
  assert.match(sheet, /address: account\.address, name: account\.name, current: isCurrent\(account\), hasKeys: hasKeysOnThisDevice\(account\),/);
  assert.match(dialogs, /\$\{option\.leadingHtml \? `<span class="cold-action-leading">\$\{option\.leadingHtml\}<\/span>` : ""\}/);
  assert.match(dialogs, /\$\{option\.trailingHtml \|\| ""\}/);
});

await test("switching is Log Out, then the sign-in screen's own sign-in, password and all", () => {
  const sw = between(app, "async function switchToSavedAccount(", "profileAccountChip?.addEventListener");
  // through runAccountSwitch (K 961fc05a, tools/test-account-switch-no-flash.mjs): Log Out, then the sign-in
  assert.ok(sw.indexOf("logOut: () => performLogout()") >= 0 && sw.indexOf("logOut: () => performLogout()") < sw.indexOf("signInToSavedAccount("), "logs out first");
  assert.match(sw, /signedOut: \(\) => !engine\.address,/);
  const signIn = between(app, "async function signInToSavedAccount(account)", "function savedAccountAvatarHtml(");
  assert.match(signIn, /if \(isAppLocked\(address\)\) \{\n\s+if \(!\(await unlockAppWithPassword\(undefined, \{ autoBiometric: true, address \}\)\)\) return false;/);
  assert.match(signIn, /accountShellPrefs\.passwordForLogin && hasAppPassword\(address\)/);
  assert.ok(signIn.indexOf("unlockAppWithPassword") < signIn.indexOf("activateSavedAccount(account.address)"), "the password before the keys");
  assert.match(app, /signInButton\.addEventListener\("click", \(\) => \{ signInToSavedAccount\(account\); \}\);/);
});

await test("Saved Accounts show each account's saved picture; it's written while signed in and removed with the account", () => {
  assert.match(app, /signInButton\.innerHTML = `\$\{savedAccountAvatarHtml\(account\.address\)\}<span class="saved-account-copy">/);
  assert.doesNotMatch(app, /<span class="saved-account-icon" aria-hidden="true">✓<\/span>/);
  const remember = between(app, "function rememberSignedInAvatar()", "function updateAvatarElement(");
  assert.match(remember, /addressBookPhoto\(address\) \|\| \(kachatNamesUiEnabled\(\) \? kachatCachedAvatarUrl\(address\) : ""\)/);
  assert.match(remember, /if \(identity && !identity\.profile\?\.avatar\) \{/);
  assert.match(remember, /savedAccountAvatars\.save\(address, kept\)/);
  const dock = between(app, "function refreshDockProfileAvatar()", "const icon = document.querySelector");
  assert.match(dock, /rememberSignedInAvatar\(\)/);
  assert.match(dock, /refreshProfileAccountChip\(\)/);
  const removal = between(app, "function removeSavedAccountFromDevice(", "let pendingSavedAccountRename");
  assert.match(removal, /savedAccountAvatars\.remove\(address\)/);
  // never looked up: the row reads only the saved copy
  const avatarHtml = between(app, "function savedAccountAvatarHtml(", "function renderSavedAccountsScreen()");
  assert.doesNotMatch(avatarHtml, /kachatCached|kachatAvatar/);
});

console.log(`account switcher (K 8cb4c88e): ${passed} passed`);
