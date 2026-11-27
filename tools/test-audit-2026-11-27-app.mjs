// node tools/test-audit-2026-11-27-app.mjs - the 2026-11-27 audit's fixes in ui/app.js and ui/storage.js.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const app = read("ui/app.js");
const storage = read("ui/storage.js");

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }
/** A top-level `function name(...) {...}` of ui/app.js, by brace matching. */
function fnSource(name) {
  const start = app.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} is in ui/app.js`);
  let depth = 0;
  for (let i = app.indexOf(") {", start) + 2; i < app.length; i += 1) {
    if (app[i] === "{") depth += 1;
    else if (app[i] === "}" && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

test("a failed save trims a snapshot for localStorage, never the live chats", () => {
  const handler = fnSource("handleChatStorageFlushError");
  assert.match(handler, /const snapshot = \{ \.\.\.state, conversations: \(state\.conversations \|\| \[\]\)\.map\(\(entry\) => \(\{ \.\.\.entry \}\)\) \};/);
  assert.match(handler, /trimPhoneBackupMessages\(keep, snapshot\);/);
  assert.doesNotMatch(handler, /trimPhoneBackupMessages\(keep\);/);
  const ctx = { state: { conversations: [{ messages: [{ id: "a", transport: "phone-backup", createdAt: 1 }, { id: "b", transport: "phone-backup", createdAt: 2 }] }] } };
  vm.createContext(ctx);
  vm.runInContext(`${fnSource("trimPhoneBackupMessages")}; this.trim = trimPhoneBackupMessages;`, ctx);
  const copy = { conversations: ctx.state.conversations.map((entry) => ({ ...entry })) };
  assert.equal(ctx.trim(0, copy), 2);
  assert.equal(copy.conversations[0].messages.length, 0);
  assert.equal(ctx.state.conversations[0].messages.length, 2, "the live state keeps them");
});
test("at start-up the emergency copy is merged, not thrown away; a later good save removes it", () => {
  assert.match(storage, /merged = resolveConflict \? resolveConflict\(key, cache\.get\(key\), value\) : null;/);
  assert.match(storage, /export function setChatStorageFlushSuccessHandler\(handler\)/);
  assert.match(app, /resolveConflict: resolveChatStorageConflict,/);
  assert.match(app, /setChatStorageFlushSuccessHandler\(\(\) => \{\n\s+try \{ dropChatStorageFallbackCopies\(\); \}/);
  const ctx = { STORAGE_KEY: "s", STATE_BACKUP_KEY: "b", MESSAGE_HISTORY_KEY: "h" };
  vm.createContext(ctx);
  vm.runInContext(`${fnSource("resolveChatStorageConflict")}; this.resolve = resolveChatStorageConflict;`, ctx);
  const merged = JSON.parse(ctx.resolve("acct:h", JSON.stringify({ c1: [{ id: "old", text: "1" }] }), JSON.stringify({ c1: [{ id: "new", text: "2" }] })));
  assert.deepEqual(merged.c1.map((m) => m.id).sort(), ["new", "old"], "history: both");
  assert.equal(ctx.resolve("acct:s", "idb", "local"), "local", "state: the newer copy");
  assert.equal(ctx.resolve("acct:other", "idb", "local"), null);
});
test("one tab at a time per account: the tab signed in last claims it, the other stops saving", () => {
  assert.match(app, /function markSessionActive\(\) \{ sessionActive = true; claimActiveTab\(\); \}/);
  assert.match(app, /new BroadcastChannel\("kachat-active-tab-v1"\)/);
  assert.match(app, /if \(mine && mine === data\.address\) pauseForOtherTab\(\);/);
  assert.match(app, /function persistStateWrites\(\{ includeBackup = true \} = \{\}\) \{\n[^\n]*\n\s+if \(stateWritesPausedForOtherTab\) return;/);
  assert.match(app, /<strong>K is open in another tab<\/strong>/);
  assert.match(app, /querySelector\("\[data-use-k-here\]"\)\.addEventListener\("click", \(\) => reloadKaChat\(\)\);/);
});
test("Send Kaspa refuses From = To, and says so", () => {
  assert.match(fnSource("sendKaspaSendsToItself"), /return Boolean\(from\) && from === String\(sendKaspaRecipient\)\.toLowerCase\(\);/);
  assert.match(fnSource("sendKaspaCanReview"), /&& !sendKaspaSendsToItself\(\)/);
  assert.match(app, /canContinue: \(\) => !\(sendKaspaChoosingFrom && sendKaspaSourceIndex == null\) && !sendKaspaSendsToItself\(\),/);
  assert.match(app, /This is the address the Kaspa is going to\. Choose another address to send from\./);
});
test("a send to one of your own addresses makes no chat with yourself", () => {
  assert.match(fnSource("recordOutgoingPaymentChat"), /if \(ownPaymentAddresses\(\)\.has\(clean\.toLowerCase\(\)\)\) return;/);
});
test("a chat payment: the Review's fee is held to, and one that never went leaves no empty chat", () => {
  const pay = fnSource("payPaymentRequestAsChatPayment");
  assert.match(pay, /expectedFeeSompi,\n\s+\}\);/);
  assert.match(pay, /catch \(error\) \{\n\s+undoNewChat\(\);\n\s+throw error;/);
  assert.match(pay, /if \(!sent\) \{ undoNewChat\(\);/);
  assert.match(pay, /if \(!createdConversation \|\| \(createdConversation\.messages \|\| \[\]\)\.length\) return;/);
  assert.match(app, /expectedFeeSompi: kasToSompi\(trimKas8\(sendKaspaTotalFeeKas\(\)\)\),\n\s+\}\)\.catch\(\(error\) => \{\n\s+if \(error\?\.code === SEND_FEE_CHANGED\) scheduleSendKaspaFeeEstimate\(\);/);
});
test("Max: the exact sompi in either unit, and a late balance for another From is ignored", () => {
  assert.match(fnSource("sendKaspaResolveAmountKas"), /if \(maxPin && maxPin\.source === sendKaspaSourceIndex && maxPin\.amountSompi != null\) return kasTextFromSompi\(maxPin\.amountSompi\);/);
  const fill = fnSource("fillMaxAmountNow");
  assert.match(fill, /if \(source === sendKaspaSourceIndex && token === sendKaspaMaxToken\) \{\n\s+sendKaspaAvailableKas = Number\(b\.totalKas\);/);
  assert.match(fill, /if \(source !== sendKaspaSourceIndex \|\| token !== sendKaspaMaxToken\) return;/);
});
test("fresh addresses are checked on chain and skip kUSDT ones (debit card, Buy/Sell)", () => {
  assert.match(app, /const next = await verifiedFreshRegularIndex\(owner\);/);
  assert.match(fnSource("verifiedFreshRegularIndex"), /let index = freshRegularIndex\(getSpendingState\(owner\)\.maxIndex, taken\);/);
});
test("the bell counts a row unread by when it arrived", () => {
  assert.match(app, /recordedAt: Date\.now\(\),/);
  assert.match(fnSource("notifIsUnread"), /return Number\(n\?\.recordedAt \|\| n\?\.timestamp \|\| 0\) > notifCenterLastSeenAt;/);
  assert.match(fnSource("unreadNotifCount"), /globalNotifications\.filter\(notifIsUnread\)/);
});
test("a payment card leaving takes an unread mark only if it was unread", () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${fnSource("unreadAmong")}; this.unreadAmong = unreadAmong;`, ctx);
  const chat = { unreadCount: 2, messages: [
    { id: "oldPay", direction: "incoming", createdAt: 1 },
    { id: "m1", direction: "incoming", createdAt: 5 },
    { id: "mine", direction: "outgoing", createdAt: 6 },
    { id: "m2", direction: "incoming", createdAt: 7 },
  ] };
  assert.equal(ctx.unreadAmong(chat, new Set(["oldPay"])), 0, "read already");
  assert.equal(ctx.unreadAmong(chat, new Set(["m2"])), 1);
  assert.equal(ctx.unreadAmong({ ...chat, unreadCount: 0 }, new Set(["m2"])), 0);
});
test("the sign-in screen's Delete Account asks for that account's password", () => {
  const del = fnSource("openSavedAccountDelete");
  assert.match(del, /if \(vaultHasAppPassword\(account\.address\)\) \{\n\s+const ok = await requestPassword\(\{/);
  assert.match(del, /forAddress: account\.address,/);
  assert.match(app, /try \{ ok = target \? await unlockKeyVault\(pw, target\) : await verifyAppPassword\(pw\); \}/);
  assert.match(fnSource("closePasswordModal"), /passwordVerifyAddress = null;/);
});
test("an expired name is looked for every 5 minutes while K shows", () => {
  assert.match(app, /window\.setInterval\(\(\) => \{\n\s+if \(document\.visibilityState === "visible" && engine\.address\) \{ try \{ refreshKachatExpiredBanner\(\); \}[^\n]*\n\s+\}, 5 \* 60_000\);/);
});
console.log(`audit 2026-11-27 app: ${passed} passed`);
