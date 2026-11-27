// node tools/test-ios-b49a021d-cold.mjs - K b49a021d (owner, 2026-11-27): Cold Storage on Manage
// Addresses' cards. The list shows each account on a card (lock and name, a red trash that asks
// first, balance and worth, Copy kpub, kpub QR, Rename in place, Alerts On / Off, Tap to View
// Addresses; no ⋮). Inside, the Total Balance card, then each address on Manage Addresses' card,
// sorted as Manage Addresses sorts; a regular address's top right hides it at once, a quantum one
// keeps the ⋮; Discover Addresses and Address Visibility at the top right; the floating + asks
// Regular or Quantum-Protected. An address's page shows the full address and has no Send / Receive
// bar. The kpub QR is laid out as the receive screens and never shows the kpub as text.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sortColdEntries, coldUsageState, coldQuantumTone, coldDiscoverySummary, coldAccountRenameValue,
  coldAlertsToast, coldHideRefusal,
} from "../ui/cold-cards.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const cold = read("ui/coldstorage.js");
const css = read("ui/coldstorage-cards.css");

/** The source of one function in ui/coldstorage.js, braces balanced. */
function fn(name) {
  const start = cold.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} exists`);
  let depth = 0;
  for (let i = cold.indexOf("{", cold.indexOf(")", start)); i < cold.length; i += 1) {
    if (cold[i] === "{") depth += 1;
    else if (cold[i] === "}") { depth -= 1; if (depth === 0) return cold.slice(start, i + 1); }
  }
  return "";
}

let passed = 0;
function test(name, body) { body(); passed += 1; console.log(`ok - ${name}`); }

const QB = 1_000_000; // a quantum index, past any receive index
const isQuantum = (index) => index >= QB;

test("the sort is Manage Addresses': unused newest first, then used in number order, regular before quantum", () => {
  const used = new Set([1, 3, QB + 1]);
  const entries = [0, 1, 2, 3, 4, QB, QB + 1, QB + 2].map((index) => ({ index }));
  const sorted = sortColdEntries(entries, (e) => used.has(e.index), isQuantum).map((e) => e.index);
  assert.deepEqual(sorted, [4, 2, 0, QB + 2, QB, 1, 3, QB + 1]);
  assert.deepEqual(entries.map((e) => e.index), [0, 1, 2, 3, 4, QB, QB + 1, QB + 2], "the input stays as it was");
});

test("Used / Unused / Checking: a username or Kaspa counts as used, unknown is never Unused", () => {
  assert.equal(coldUsageState({ balanceSompi: 5, everUsed: undefined }), "used");
  assert.equal(coldUsageState({ balanceSompi: 0, everUsed: true }), "used");
  assert.equal(coldUsageState({ balanceSompi: 0, everUsed: false, ownsUsername: true }), "used");
  assert.equal(coldUsageState({ balanceSompi: 0, everUsed: false }), "unused");
  assert.equal(coldUsageState({ balanceSompi: 0, everUsed: undefined }), "checking");
  assert.equal(coldUsageState({ balanceSompi: undefined, everUsed: false }), "checking");
});

test("the quantum tag: protected until a spend, orange with Kaspa on it again, a regular one never", () => {
  assert.equal(coldQuantumTone({ quantum: true, spent: false, funded: true }), "safe");
  assert.equal(coldQuantumTone({ quantum: true, spent: true, funded: true }), "warn");
  assert.equal(coldQuantumTone({ quantum: true, spent: true, funded: false }), "plain");
  assert.equal(coldQuantumTone({ quantum: false, spent: false, funded: true }), "plain");
  assert.match(fn("coldQuantumTagHtml"), /\$\{tone === "safe" \? "Quantum Protected" : "Not Quantum Protected"\}/);
  assert.match(fn("addressCardHtml"), /<strong class="address-card-name">\$\{label\}<\/strong>\$\{coldQuantumTagHtml\(entry\)\}\$\{corner\}/);
});

test("toasts and the account rename's rule", () => {
  assert.equal(coldDiscoverySummary(0), "No addresses with a balance or username found.");
  assert.equal(coldDiscoverySummary(1), "Found 1 address with a balance or username.");
  assert.equal(coldDiscoverySummary(7), "Found 7 addresses with a balance or username.");
  assert.equal(coldAlertsToast(true), "You'll be notified when this account receives Kaspa.");
  assert.equal(coldAlertsToast(false), "No more notifications when this account receives Kaspa.");
  assert.equal(coldAccountRenameValue("  Vault  "), "Vault");
  assert.equal(coldAccountRenameValue("   "), null, "an empty name keeps the old one");
  assert.equal(coldHideRefusal(1), "An address holding Kaspa stays on the list.");
  assert.equal(coldHideRefusal(0), null);
});

test("the list: each account on a card with its trash, balance, worth and four buttons; no ⋮", () => {
  const card = fn("accountCardHtml");
  assert.match(card, /class="spending-address-row address-card cold-account-card" data-cold-account-card="\$\{account\.id\}"/);
  assert.match(card, /class="address-card-body" data-cold-open="\$\{account\.id\}" role="button" tabindex="0"/);
  assert.match(card, /<span class="cold-card-lock" aria-hidden="true">\$\{LOCK_ICON\}<\/span><strong class="address-card-name">\$\{name\}<\/strong>/);
  assert.match(card, /data-cold-remove-account="\$\{account\.id\}" aria-label="Remove Account"/);
  assert.match(card, /<span class="address-card-amount" data-cold-account-amount="\$\{account\.id\}">/);
  assert.match(card, /cardWorthHtml\(sompi, /);
  assert.match(card, /title: "Copy kpub" \}/);
  assert.match(card, /icon: "qr", title: "kpub QR" \}/);
  assert.match(card, /data-cold-account-action="rename" data-id="\$\{account\.id\}" data-rename-button`, icon: "rename", title: "Rename" \}/);
  assert.match(card, /title: alertsOn \? "Alerts On" : "Alerts Off" \}/);
  assert.match(card, /Tap to View Addresses\$\{CHEVRON_RIGHT_ICON\}/);
  assert.doesNotMatch(cold, /data-cold-menu-toggle|renderColdAccountSheet/);
});

test("the trash asks first; Alerts toggles this account's receive notifications with a toast", () => {
  assert.match(fn("removeAccount"), /title: "Remove Cold Storage Account\?",\n\s+message: "This only removes it from K's watch list\. It has no effect on the KasSigner device or any funds it holds\.",/);
  assert.match(fn("removeAccount"), /if \(!confirmed\) return;\s*\/\/[^\n]*\n\s*const live = liveAccount\(id\);\s*if \(!live\) return;/);
  const actions = fn("handleAccountMenuAction");
  assert.match(actions, /account\.receiveNotifications = account\.receiveNotifications === false;/);
  assert.match(actions, /deps\.showToast\?\.\(coldAlertsToast\(account\.receiveNotifications !== false\)\);/);
});

test("the card's balance: the last known at once, then read live, its addresses summed", () => {
  const load = fn("loadListBalances");
  assert.match(load, /const known = lastKnownAccountBalance\(account\);/);
  assert.match(load, /\.\.\.\(account\.quantumAddresses \|\| \[\]\)\.map\(\(q\) => q\.address\)/);
  assert.match(load, /listBalances\.set\(account\.id, \[\.\.\.balances\.values\(\)\]\.reduce/);
  assert.match(fn("lastKnownAccountBalance"), /loadPersistedAccountCache\(account\.id\)\?\.balances/);
  assert.match(fn("refreshColdStorage"), /else if \(!activeAccountId\) loadListBalances\(\);/);
});

test("rename in place on both cards; a repaint waits while a name is typed", () => {
  assert.match(cold, /import \{ startInlineRename, inlineRenameActive \} from "\.\/inline-rename\.js";/);
  const account = fn("renameAccountInPlace");
  assert.match(account, /key: `cold-account:\$\{account\.id\}`,/);
  assert.match(account, /const name = coldAccountRenameValue\(text\);\n\s+if \(!live \|\| !name \|\| name === live\.label\) return;/);
  const address = fn("handleAddressAction");
  assert.match(address, /startInlineRename\(card, \{\n\s+key: `cold:\$\{account\.id\}:\$\{entry\.address\}`,/);
  assert.match(address, /if \(trimmed\) live\.labels\[at\] = trimmed;\n\s+else \{ delete live\.labels\[at\]; delete live\.labels\[String\(at\)\]; \}/);
  assert.doesNotMatch(cold, /title: "Rename Account"|title: "Rename Address"/, "no pop-up");
  assert.match(fn("render"), /if \(!rootEl\) return;\n[^\n]*\n[^\n]*\n\s+if \(inlineRenameActive\(\)\) return;/);
  assert.match(fn("renderDetail"), /^function renderDetail\(\) \{\n\s+if \(inlineRenameActive\(\)\) return;/);
});

test("the account screen: Total Balance, address cards, the top right, the floating +", () => {
  const detail = fn("renderDetail");
  assert.match(detail, /data-cold-discover aria-label="Discover Addresses"/);
  assert.match(detail, /data-cold-open-visibility aria-label="Address Visibility"/);
  assert.match(detail, /\$\{balanceCardHtml\("Total Balance", totalSompi\)\}\n\s+\$\{discovering \? `<div class="cold-discover-status" data-cold-discover-status/);
  assert.match(detail, /sortColdEntries\(visible, entryIsUsed, isColdQuantumIndex\)/);
  assert.match(detail, /sorted\.map\(\(e\) => addressCardHtml\(account, e\)\)/);
  assert.match(detail, /data-cold-new-address aria-label="New Address"/);
  // the account's own actions live on its list card only
  assert.doesNotMatch(cold, /data-cold-remove[^-]|data-cold-rename-account|data-cold-actions-toggle|cold-summary-name|renderColdActionsSheet/);
  const chooser = fn("openNewAddressChooser");
  assert.match(chooser, /title: "New Address",/);
  assert.match(chooser, /\{ id: "regular", title: "Regular Address", subtitle: "Reveals the next unused address in this account\." \}/);
  assert.match(chooser, /if \(choice === "regular"\) runAddressAction\("generate"\);/);
});

test("Discover: \"Checking address #N\" under the Total Balance, then the result toast", () => {
  assert.match(fn("discoverStatusInnerHtml"), /<strong>Checking address #\$\{progress\.checkingIndex\}<\/strong>/);
  const run = fn("runAddressAction");
  assert.match(run, /if \(status\) status\.innerHTML = discoverStatusInnerHtml\(\);/);
  assert.match(run, /deps\.showToast\?\.\(coldDiscoverySummary\(found\)\);/);
});

test("an address card: Copy, Send, Receive, Rename, the tags, and the top right", () => {
  const card = fn("addressCardHtml");
  assert.match(card, /class="spending-address-row address-card cold-address-card" data-cold-address-row="\$\{i\}"/);
  for (const [kind, title] of [["copy", "Copy"], ["send", "Send"], ["receive", "Receive"]]) {
    assert.match(card, new RegExp(`data-cold-card-action="${kind}" data-index="\\$\\{i\\}"\`, icon: "${kind}", title: "${title}"`));
  }
  assert.match(card, /data-cold-card-action="rename" data-index="\$\{i\}" data-rename-button`, icon: "rename", title: "Rename" \}/);
  assert.match(card, /title: "Send", disabled: !funded \}/);
  assert.match(card, /Contains username/);
  assert.match(card, /Tap to View History\$\{CHEVRON_RIGHT_ICON\}/);
  assert.match(card, /data-cold-addr-hide="\$\{i\}" aria-label="Hide Address"/);
  assert.match(card, /isColdQuantumIndex\(i\)\n\s+\? `<span class="spending-address-row-menu-wrap"><button type="button" class="spending-row-menu-btn" data-cold-addr-menu-toggle/);
  assert.doesNotMatch(card, /Chatting/, "no Send to Chatting Address in Cold Storage");
  // Hide refuses an address holding Kaspa, then checks the node and fails closed
  assert.match(fn("handleAddressAction"), /const refusal = coldHideRefusal\(entry\.balanceSompi\);\n\s+if \(refusal\) \{ deps\.showToast\?\.\(refusal\); return; \}\n\s+if \(!\(await addressConfirmedEmpty\(entry\.address\)\)\)/);
  // a card's Send starts from that address, not the address page's coins
  assert.match(fn("openSendFlow"), /async function openSendFlow\(\{ compound = false, index = activeAddressIndex \} = \{\}\)/);
  assert.match(fn("sendAvailableSompi"), /addrUtxos\.state === "ready" && entry\.index === activeAddressIndex/);
  // the quantum ⋮ has what isn't on the card
  const sheet = fn("renderColdAddressSheet");
  assert.match(sheet, /title: "Hide Address"/);
  assert.doesNotMatch(sheet, /Rename Address|Copy Address|Show QR Code/);
});

test("an address's page: the full address on its card, no Send / Receive bar", () => {
  const page = fn("renderAddressScreen");
  assert.match(page, /balanceCardHtml\(displayLabelFor\(account, entry\.index\), balanceSompi, "address", entry\.address\)/);
  assert.doesNotMatch(page, /data-cold-addr-send|data-cold-addr-receive|cold-bottom-actions/);
  assert.match(fn("balanceCardHtml"), /<code class="address-balance-card-address">\$\{deps\.escapeHtml\(address\)\}<\/code>/);
});

test("the kpub QR: Watch This Account, the receive screens' look, never the kpub as text", () => {
  assert.match(cold, /<span>Watch This Account<\/span>/);
  assert.match(cold, /<p class="cold-kpub-name" data-cold-kpub-name><\/p>/);
  assert.match(cold, /<div class="chatting-address-qr-frame"><canvas width="512" height="512" data-cold-kpub-canvas><\/canvas><\/div>/);
  assert.match(cold, /<span class="receive-note cold-kpub-eye"><span class="receive-note-icon">\$\{EYE_ICON\}<\/span><span>Watch-only\. This cannot spend, but it reveals every address in this account\.<\/span>/);
  assert.match(cold, /<p class="qr-tap-hint dark">Click anywhere to copy<\/p>/);
  assert.match(cold, /data-kind="allowed"><span class="receive-note-icon">\$\{receiveNoteIcon\("allowed"\)\}<\/span><span>Scan it into another device to watch this account there\.<\/span>/);
  assert.match(cold, /data-kind="warning"><span class="receive-note-icon">\$\{receiveNoteIcon\("warning"\)\}<\/span><span>Whoever scans it sees every address, balance and payment of this account\. Show it only to devices you trust\.<\/span>/);
  const open = fn("openKpubQrModal");
  assert.match(open, /\[data-cold-kpub-name\]"\)\.textContent = account\.label;/);
  assert.doesNotMatch(open, /textContent = account\.kpub/);
  assert.match(open, /drawQrFor\(canvas, account\.kpub, \{ dark: "#06110f", light: "#ffffff", errorCorrectionLevel: "L" \}\)/);
  assert.match(css, /\.cold-kpub-eye \.receive-note-icon \{ color: #ff9f0a; \}/);
});

test("swipe left to hide, as Manage Addresses; the cards' own styles live beside the screen", () => {
  assert.match(cold, /rowAttr: "data-cold-address-row",/);
  assert.match(cold, /onAction\(id\) \{ handleAddressAction\("hide", Number\(id\)\); \},/);
  assert.match(fn("renderDetail"), /detailRowSwipes\?\.refresh\(\);/);
  assert.match(cold, /import "\.\/coldstorage-cards\.css";/);
  assert.match(css, /\[data-cold-root\] \{ position: relative; \}/);
  assert.match(css, /\.cold-card-trash \{ color: var\(--ios-red, #ff3b30\); \}/);
});

console.log(`ios b49a021d cold: ${passed} passed`);
