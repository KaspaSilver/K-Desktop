// kUSDT's UI (KaPay iOS 3d126db; ui/kusdt-wallet.js, ui/kusdt-screens.js and their app.js hooks)
// without a browser: the pure helpers (holdings, the Manage kUSDT list and its Visibility sets, the
// texts), the Manage Addresses rules for kUSDT-listed addresses (§11), the wallet's refresh with a
// fake Trestly and a fake node - which addresses it asks about, four at a time, an answer after an
// account switch dropped, "Received X kUSDT" only past the first look and only with Address
// Activity on, Discover, the poll's gate and Delete Account's forget - then source checks of the
// screens' exact strings and the app.js / index.html / endpoints hooks. Run from the repo root:
//
//   node tools/test-kusdt-ui.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js";

const K = await import("../engine/kusdt.js");
const S = await import("../engine/kusdt-store.js");
const C = await import("../engine/kachat-names/codec.js");
const W = await import("../ui/kusdt-wallet.js");
const A = await import("../ui/address-activity.js");

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (error) { failures.push(`${name}: ${error?.stack || error}`); }
}
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const net = "testnet-10";
const dep = K.kusdtDeployment(net);
const tmpl = K.kusdtTemplate();
const key = (n) => schnorr.getPublicKey(C.unhex(n.toString(16).padStart(2, "0").repeat(32)));
const chatting = K.addressOfOwner(key(1), net);
const other = K.addressOfOwner(key(9), net);
const spending = (i) => K.addressOfOwner(key(20 + i), net); // regular addresses #0..
const txid = (n) => n.toString(16).padStart(2, "0").repeat(32);
const h = (index, units, coinCount = 1, address = index == null ? chatting : spending(index)) => W.makeHolding(index, address, units, coinCount);

// MARK: - Pure helpers

await check("holding ids are iOS's: chatting, s<index>", () => {
  assert.equal(W.holdingIdFor(null), "chatting");
  assert.equal(W.holdingIdFor(3), "s3");
  assert.equal(W.indexOfHoldingId("s12"), 12);
  assert.equal(W.indexOfHoldingId("chatting"), null);
  assert.equal(W.isRegularIndex(5), true);
  assert.equal(W.isRegularIndex(1_000_002), false, "quantum-safe slots never hold kUSDT");
});

await check("a refresh asks about the regular addresses that use kUSDT only, revealed ones, in order", () => {
  const indices = W.refreshTargetIndices({
    holdings: [h(4, 5n)], known: [2], shown: [7], hidden: ["s9", "chatting"],
    expected: [{ holdingId: "s1" }], activity: [{ holdingId: "s3" }, { holdingId: "chatting" }],
    maxIndex: 8,
  });
  assert.deepEqual(indices, [1, 2, 3, 4, 7], "s9 is past the revealed range");
  assert.deepEqual(W.refreshTargetIndices({ shown: [1_000_001], maxIndex: 2_000_000 }), [], "never a quantum-safe slot");
});

await check("the lookups run four at a time", () => {
  assert.deepEqual(W.chunked([1, 2, 3, 4, 5, 6, 7, 8, 9]).map((c) => c.length), [4, 4, 1]);
  assert.equal(W.KUSDT_LOOKUP_BATCH, 4);
});

await check("Manage kUSDT lists the Chatting Address, then held unless hidden, then checked-on, in order", () => {
  const held = [h(null, 10n), h(5, 3n), h(2, 1n)];
  const rows = W.listedHoldingsOf({ held, hidden: ["s5"], shown: [8], chattingAddress: chatting, addressAt: spending });
  assert.deepEqual(rows.map((r) => r.id), ["chatting", "s2", "s8"]);
  assert.equal(rows[2].units, 0n);
  const none = W.listedHoldingsOf({ held: [], chattingAddress: chatting, addressAt: spending });
  assert.deepEqual(none.map((r) => [r.id, r.units]), [["chatting", 0n]], "the Chatting Address always, with nothing");
});

await check("Visibility: a holding is hidden or shown, an empty address put on or taken off; Hide All keeps only the Chatting Address", () => {
  let sets = { hidden: [], shown: [] };
  sets = W.toggleListedSets(h(3, 5n), sets);
  assert.deepEqual(sets, { hidden: ["s3"], shown: [] });
  assert.equal(W.isListedHolding(h(3, 5n), sets), false);
  sets = W.toggleListedSets(h(3, 5n), sets);
  assert.deepEqual(sets.hidden, []);
  sets = W.toggleListedSets(h(6, 0n, 0), sets);
  assert.deepEqual(sets.shown, [6]);
  assert.equal(W.isListedHolding(h(6, 0n, 0), sets), true);
  assert.deepEqual(W.toggleListedSets(h(null, 5n), sets), sets, "the Chatting Address always stays");
  assert.equal(W.isListedHolding(h(null, 0n, 0), { hidden: ["chatting"] }), true);
  assert.deepEqual(W.hideAllListedSets([h(null, 1n), h(2, 1n), h(4, 0n, 0)]), { hidden: ["s2"], shown: [] });
});

await check("Held On, KAS Held With It and Used read as iOS", () => {
  const label = (x) => (x.spendingIndex == null ? "Chatting Address" : `Address #${x.spendingIndex + 1}`);
  assert.equal(W.heldOnText(null, label), "--");
  assert.equal(W.heldOnText([h(2, 1n)], label), "Address #3");
  assert.equal(W.heldOnText([h(null, 1n), h(2, 1n)], label), "2 Addresses");
  assert.equal(W.heldOnText([], label), "0 Addresses");
  assert.equal(W.kasHeldSompi([h(null, 1n, 2), h(2, 1n, 1)]), 450_000_000n);
  assert.equal(W.isHoldingUsed(h(null, 0n, 0)), true, "the Chatting Address is always Used");
  assert.equal(W.isHoldingUsed(h(4, 0n, 0)), false);
  assert.equal(W.isHoldingUsed(h(4, 0n, 0), { usedIndices: new Set([4]) }), true, "Kaspa history");
  assert.equal(W.isHoldingUsed(h(4, 0n, 0), { activity: [{ holdingId: "s4" }] }), true, "kUSDT history");
});

await check("amount and address texts", () => {
  assert.equal(W.kusdtFeeText(120_000n), "0.0012 KAS", "four decimals");
  assert.equal(W.kusdtFeeText(5_432n), "0.00005432 KAS", "eight under 0.001");
  assert.equal(W.kusdtFeeText(2_345_678n), "0.0235 KAS");
  assert.equal(W.kasAmountText(150_000_000n), "1.5 KAS");
  assert.equal(W.kasAmountText(450_000_000n), "4.5 KAS");
  assert.equal(W.kasAmountText(123_456_700_000_000n), "1,234,567 KAS");
  assert.equal(K.formatKusdt(125_500_000n), "125.50 kUSDT");
  assert.equal(K.kusdtDollars(125_500_000n), "$125.50");
  assert.equal(K.typedKusdt(125_500_000n), "125.5", "Max types the full balance");
  const a = "kaspatest:qq0123456789abcdefghijklmnopqrstuvwxyz";
  assert.equal(W.shortKusdtAddress(a), `${a.slice(0, 14)}...${a.slice(-6)}`);
  assert.equal(W.visibilityShortAddress(a), `${a.slice(0, 16)}…${a.slice(-6)}`);
});

await check("a fresh regular slot is past the revealed ones and skips one holding kUSDT", () => {
  assert.equal(W.freshRegularIndex(4, []), 5);
  assert.equal(W.freshRegularIndex(4, [5, 6]), 7);
  assert.equal(W.freshRegularIndex(-1, []), 0);
});

await check("§11: Manage Addresses keeps every kUSDT-listed address", () => {
  const listed = new Set([2, 5]);
  assert.equal(W.manageAddressesHideRefusal(2, listed), "This address is on your kUSDT list, so it stays here. Hide it from Manage kUSDT first.");
  assert.equal(W.manageAddressesHideRefusal(3, listed), null);
  const hidden = [1, 2, 5, 9];
  assert.deepEqual(W.reshowListedHidden(hidden, listed), [1, 9], "shown again on open");
  const same = [1, 9];
  assert.equal(W.reshowListedHidden(same, listed), same, "unchanged: the same array, nothing saved");
  assert.deepEqual(W.hideAllKeepingListed([0, 1, 2, 3, 5, 1_000_000], listed), [0, 1, 3, 1_000_000]);
  assert.equal(W.KUSDT_LISTED_ALERT_TITLE, "Shown for kUSDT");
});

await check("the poll runs only while the page shows, signed in, Address Activity on, for an account that uses kUSDT", () => {
  assert.equal(W.shouldPoll({ visible: true, account: chatting, notificationsEnabled: true, usesTokens: true }), true);
  for (const off of ["visible", "account", "notificationsEnabled", "usesTokens"]) {
    assert.equal(W.shouldPoll({ visible: true, account: chatting, notificationsEnabled: true, usesTokens: true, [off]: off === "account" ? "" : false }), false, off);
  }
  assert.equal(W.KUSDT_POLL_MS, 30_000);
});

await check("receive notes, word for word (§10)", () => {
  const n = (screen) => { const r = W.receiveNotesFor(screen); return [r.privacy?.text ?? null, ...r.notes.map((x) => x.text)]; };
  assert.deepEqual(n("wallet"), [
    "A brand-new address of yours, never used or handed out: this payment can't be tied to your name.",
    "Kaspa, and kUSDT on Kaspa, can be sent here.",
    "It lands in this account and shows in your spending total. Use it for everything except .kachat names.",
  ]);
  assert.deepEqual(n("chatting"), [
    "Your Chatting Address shows your .kachat name and identity: whoever pays here can see it's you.",
    "Kaspa, and kUSDT on Kaspa, can be sent here.",
    "Use for chatting and acquiring .kachat domains.",
  ]);
  assert.deepEqual(n("spending"), ["A spending address of yours: a payment here isn't tied to your name.", "Kaspa, and kUSDT on Kaspa, can be sent here."]);
  assert.deepEqual(n("quantum"), [
    "A quantum-resistant address: its key stays hidden until it spends.",
    "Only Kaspa can be sent here.",
    "Don't send kUSDT here: it can't be traded from a quantum-resistant address. Use Receive for a regular one.",
  ]);
  assert.deepEqual(n("kusdt-fresh").slice(1), [
    "Only kUSDT on Kaspa, or KAS, can be sent here.",
    "Don't send USDT from Ethereum, BNB Chain or an exchange to this address: it would be lost. Bridge it to Kaspa on Trestly first.",
  ]);
});

await check("a send's own transaction is marked, so its KAS change isn't 'Received KAS'", () => {
  const id = txid(0xab);
  assert.equal(A.isMarkedOwnTransaction(id), false);
  A.markOwnTransaction(id.toUpperCase());
  assert.equal(A.isMarkedOwnTransaction(id), true);
  assert.equal(A.isMarkedOwnTransaction(id, Date.now() + 61 * 60 * 1000), false, "kept an hour");
  A.markOwnTransaction("not a txid");
  assert.equal(A.isMarkedOwnTransaction("not a txid"), false);
});

// MARK: - The wallet, with a fake Trestly and a fake node

function storage() {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); } };
}
function answer(json) {
  const bytes = new TextEncoder().encode(K.stringifyExact(json));
  return { status: 200, headers: { get: () => null }, arrayBuffer: async () => bytes.buffer.slice(0) };
}
/** Trestly's /tokens and the node, from `coins`: { [address]: [{ n, index, units }] }. */
function world() {
  const coins = {};
  const asked = [];
  let inFlight = 0;
  let peak = 0;
  let gate = null;
  const ownerOf = (address) => K.schnorrOwner(address, net);
  const stateOf = (address, units) => K.plainState(ownerOf(address), units);
  const fetchImpl = async (url) => {
    const owner = new URL(url).searchParams.get("owner");
    asked.push(owner);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      if (gate) await gate.promise;
      await new Promise((r) => setTimeout(r, 1));
      const list = coins[owner] || [];
      return answer({ states: list.map((c) => ({ utxo: { transactionId: txid(c.n), index: c.index }, state: K.stateToJson(stateOf(owner, c.units)) })) });
    } finally { inFlight -= 1; }
  };
  const getUtxos = async (addresses) => {
    const out = [];
    for (const [owner, list] of Object.entries(coins)) {
      for (const c of list) {
        const script = K.lockingScript(stateOf(owner, c.units), tmpl);
        if (!addresses.includes(K.coinAddress(script, net))) continue;
        out.push({ outpoint: { transactionId: txid(c.n), index: c.index }, amount: 150_000_000n, blockDaaScore: 1n, isCoinbase: false, scriptVersion: 0, scriptPublicKey: C.hex(script), covenantId: dep.covenantId });
      }
    }
    return out;
  };
  return {
    coins, asked, fetchImpl, getUtxos,
    get peak() { return peak; },
    hold() { let release; gate = { promise: new Promise((r) => { release = r; }) }; return () => { gate = null; release(); }; },
  };
}
function makeWallet(w, overrides = {}) {
  const store = storage();
  let active = chatting;
  const notes = [];
  const revealed = [];
  const wallet = W.createKusdtWallet({
    account: () => active,
    network: net,
    storage: store,
    apiBase: () => dep.apiBase,
    getUtxos: w.getUtxos,
    fetchImpl: w.fetchImpl,
    isHeld: () => false,
    maxSpendingIndex: () => 9,
    spendingAddressAt: (i) => spending(i),
    spendingAddressesInRange: async (start, end) => new Map(Array.from({ length: end - start }, (_, k) => [start + k, spending(start + k)])),
    revealSpendingSlot: (index, owner) => { revealed.push([index, owner]); },
    spendingLabel: (i) => `Address #${i + 1}`,
    ownAddresses: () => [chatting, ...Array.from({ length: 10 }, (_, i) => spending(i))],
    fetchTransactionInputs: async () => [{ hash: txid(0xee), index: 0, address: other }],
    notificationsEnabled: () => true,
    notify: (note) => notes.push(note),
    ...overrides,
  });
  return { wallet, store, notes, revealed, switchTo: (a) => { active = a; } };
}

await check("a refresh asks about the Chatting Address and only the addresses that use kUSDT", async () => {
  const w = world();
  w.coins[chatting] = [{ n: 1, index: 0, units: 12_500_000n }];
  const { wallet, store } = makeWallet(w);
  store.setItem(S.kusdtStorageKeys(chatting).shown, JSON.stringify([3]));
  await wallet.refresh();
  assert.deepEqual(w.asked, [chatting, spending(3)], "not the other eight regular addresses");
  assert.equal(wallet.balance(), 12_500_000n);
  assert.equal(wallet.heldOnText(), "Chatting Address");
  assert.equal(wallet.kasHeld(), 150_000_000n);
  assert.equal(wallet.usesTokens(), true);
});

await check("Discover looks at every regular address to 20 past the last, four at a time, and reveals the furthest holding some", async () => {
  const w = world();
  w.coins[spending(14)] = [{ n: 2, index: 1, units: 3_000_000n }];
  const { wallet, revealed, store } = makeWallet(w);
  const progress = [];
  const found = await wallet.discover((checking, soFar) => progress.push([checking, soFar]));
  assert.equal(found, 1);
  assert.equal(w.asked.length, 1 + 30, "the Chatting Address and #1 to #30 (indices 0..29)");
  assert.ok(w.peak <= 4, `at most 4 at a time (saw ${w.peak})`);
  assert.deepEqual(revealed, [[14, chatting]]);
  assert.equal(progress.at(-1)[1], 1);
  assert.deepEqual(JSON.parse(store.getItem(S.kusdtStorageKeys(chatting).indices)), [14], "remembered for the next refresh");
  assert.equal(wallet.listedSpendingIndices().has(14), true);
  const seen = JSON.parse(store.getItem(S.kusdtStorageKeys(chatting).seen));
  assert.deepEqual(seen, [`${txid(2)}:1`], "what Discover finds is known, never announced");
});

await check("an answer that comes back after an account switch is dropped", async () => {
  const w = world();
  w.coins[chatting] = [{ n: 1, index: 0, units: 7_000_000n }];
  const { wallet, store, switchTo } = makeWallet(w);
  const release = w.hold();
  const running = wallet.refresh();
  await new Promise((r) => setTimeout(r, 5));
  switchTo(other);
  release();
  await running;
  assert.equal(wallet.balance(), null, "the new account shows nothing of the old one's");
  assert.equal(store.getItem(S.kusdtStorageKeys(chatting).seen), null, "nothing written for the old account either");
  assert.equal(store.getItem(S.kusdtStorageKeys(other).seen), null);
  switchTo(chatting);
  assert.equal(wallet.balance(), null, "and back: read again, not the dropped answer");
});

await check("Discover across a switch reveals and applies nothing", async () => {
  const w = world();
  w.coins[spending(12)] = [{ n: 3, index: 0, units: 1_000_000n }];
  const { wallet, revealed, switchTo } = makeWallet(w);
  const release = w.hold();
  const running = wallet.discover();
  await new Promise((r) => setTimeout(r, 5));
  switchTo(other);
  release();
  await running;
  assert.deepEqual(revealed, []);
  assert.equal(wallet.balance(), null);
});

await check("Received: never on the first look; a payment from someone else after it, with Address Activity on", async () => {
  const w = world();
  w.coins[chatting] = [{ n: 1, index: 0, units: 5_000_000n }];
  let clock = 1_000_000;
  const { wallet, notes } = makeWallet(w, { now: () => clock });
  await wallet.refresh();
  assert.deepEqual(notes, [], "first look: learn, don't announce");
  w.coins[chatting].push({ n: 4, index: 0, units: 12_500_000n });
  await wallet.refresh();
  // On the Chatting Address it waits up to two minutes for a contact's chat notice (K b0f0a4e6).
  assert.deepEqual(notes, [], "waiting for a chat notice");
  clock += W.KUSDT_NOTICE_WAIT_MS + 1000;
  await wallet.refresh();
  assert.deepEqual(notes, [{ title: "Received 12.50 kUSDT", body: "" }], "no notice came: the wallet says it, amount only");
  assert.equal(wallet.activity()[0].kind, "received");
  const quiet = makeWallet(w, { notificationsEnabled: () => false });
  await quiet.wallet.refresh();
  w.coins[chatting].push({ n: 5, index: 0, units: 1_000_000n });
  await quiet.wallet.refresh();
  assert.deepEqual(quiet.notes, [], "Address Activity off: no notification");
  assert.equal(quiet.wallet.activity().some((r) => r.kind === "received"), true, "still in the history");
});

await check("Visibility and Generate New Address, through the wallet", async () => {
  const w = world();
  w.coins[spending(2)] = [{ n: 6, index: 0, units: 2_000_000n }];
  const { wallet, revealed } = makeWallet(w, { maxSpendingIndex: () => 2 });
  await wallet.discover();
  assert.deepEqual(wallet.listed().map((x) => x.id), ["chatting", "s2"]);
  wallet.toggleListed(wallet.holdingById("s2"));
  assert.deepEqual(wallet.listed().map((x) => x.id), ["chatting"]);
  assert.equal(wallet.hiddenCount(), 1, "\"1 hidden: they still count in the total.\"");
  assert.equal(wallet.balance(), 2_000_000n, "a hidden address still counts");
  const number = await wallet.generateFresh();
  assert.equal(number, 4, "slot 3, past the revealed #3 - shown as #4");
  assert.deepEqual(revealed.at(-1), [3, chatting]);
  assert.deepEqual(wallet.listed().map((x) => x.id), ["chatting", "s3"]);
  wallet.hideAll();
  assert.deepEqual(wallet.listed().map((x) => x.id), ["chatting"]);
});

await check("Delete Account forgets the account's kUSDT records and the figures in memory", async () => {
  const w = world();
  w.coins[chatting] = [{ n: 1, index: 0, units: 5_000_000n }];
  const { wallet, store } = makeWallet(w);
  await wallet.refresh();
  store.setItem(S.kusdtStorageKeys(chatting).hidden, "[\"s1\"]");
  wallet.forgetAccount(chatting);
  const left = [...store.map.keys()].filter((k) => k.endsWith(chatting));
  assert.deepEqual(left, []);
  assert.equal(wallet.known, false);
});

await check("the 90 s poll waits for an account that uses kUSDT", async () => {
  const w = world();
  const { wallet } = makeWallet(w);
  assert.equal(wallet.usesTokens(), false, "nothing held, listed or in the history");
});

// MARK: - The screens and the hooks (source)

const screens = read("ui/kusdt-screens.js");
const app = read("ui/app.js");
const html = read("index.html");
const css = read("ui/styles.css");
const endpoints = read("engine/endpoints.js");

await check("exact strings (§1-§13)", () => {
  for (const text of [
    "kUSDT can only go to a regular Kaspa address, not a quantum-safe or other script address.",
    "The KAS for the fee comes from the same address, so the send doesn't link it to your other addresses.",
    "More than your kUSDT.",
    "This address had no KAS, so the network fee came out of the KAS that goes with the kUSDT.",
    "Waiting for your KAS to arrive…", "Building the transaction…",
    "The KAS you sent hasn't shown up on this address yet. It usually takes a few seconds.",
    "Every kUSDT coin holds 1.5 KAS. It goes to the recipient with the kUSDT, so the KAS isn't lost.",
    "Pick which of your addresses the KAS comes from, tap Send, and you're back here.",
    "KAS for a kUSDT send", "This address's key isn't available on this computer.",
    "Every kUSDT coin holds 1.5 KAS. Combining them into one coin gives the extra KAS back to this address as regular KAS, less the network fee. Your kUSDT stays the same.",
    "Not independently audited yet. Hold only what you can afford to lose.",
    "Receive it on a fresh address, or buy it with Swap Stablecoins on the Wallet tab.",
    "Sends, receives and combines on this computer show here from now on.",
    "More stablecoins will show here as K adds them.",
    "These addresses couldn't be derived right now. Go back a page or reopen this screen to retry.",
    "Who are you sending to?", "Where are you sending from?", "How much?", "You're sending", "Goes With It",
    "Total KAS", "KAS Paid From", "Check Again", "Swap Stablecoins", "Which stablecoin?", "What are you sending?",
    "Gives this address a label of your own.", "Puts the full address on the clipboard.",
    "Full screen, for scanning with another device.", "Moves kUSDT from this address to your Chatting Address.",
    "Merges its coins into one and gives the extra KAS back.", "Adds a brand-new regular address of yours to this list.",
    "Finds your addresses holding kUSDT.", "Check off which addresses holding kUSDT are on the list.",
    "Close and Keep Scanning", "Hide All Addresses?", "This address on the Kaspa explorer.", "View the Vault",
    "Release to Confirm", "Coins Combined", "The transaction didn't go out.", "Back to This Address", "KAS Held With It",
    "A dollar stablecoin on Kaspa", "1.5 KAS in Every Coin", "Where It Lives", "The Risks",
  ]) assert.ok(screens.includes(text) || screens.includes(text.replaceAll("'", "\\'")), `missing: ${text}`);
  assert.equal(K.KUSDT_TOKEN.name, "Bridged USDT");
  assert.match(screens, /subtitle: KUSDT_TOKEN\.name/, "Send's chooser: kUSDT / Bridged USDT");
  for (const [pattern, label] of [
    [/`Add \$\{kas\(short\)\} for Fee and Change Coin`/, "fund: change coin"],
    [/`Add \$\{kas\(short\)\} for the Network Fee`/, "fund: fee"],
    [/`Add \$\{kas\(short\)\} More`/, "fund: more"],
    [/`Couldn't check \$\{SYMBOL\} just now: \$\{error\} Refresh to try again\.`/, "refresh error"],
    [/`\$\{hidden\} hidden: they still count in the total\.`/, "hidden footnote"],
    [/`Address #\$\{number\} is ready\.`/, "generate toast"],
    [/`Checking address #\$\{discovering\.checking\}`/, "discover progress"],
    [/`Found \$\{found\} addresses with \$\{SYMBOL\}\.`/, "discover summary"],
    [/`\$\{merging\} coins into 1`/, "combine title"],
  ]) assert.match(screens, pattern, label);
});

await check("Swap opens Trestly's swap page in a new tab, with noopener", () => {
  assert.match(screens, /openExternal\(`\$\{kusdtDeployment\(deps\.network\)\.siteUrl\}\/swap`\)/);
  assert.match(screens, /window\.open\(url, "_blank", "noopener,noreferrer"\)/);
  assert.equal(K.kusdtDeployment("testnet-10").siteUrl, "https://testnet.trestly.io");
});

await check("nothing kUSDT asks for a password, and every build is held to its account", () => {
  for (const file of ["ui/kusdt-screens.js", "ui/kusdt-wallet.js"]) assert.doesNotMatch(read(file), /requestPassword|unlockForSeedPhrase/, file);
  assert.match(screens, /const isCurrent = \(\) => S\.open && ticket\.isCurrent\(buildKey\(\)\) && deps\.account\(\) === owner;/);
  assert.match(screens, /if \(!S\.outcomeUnknown && isReviewStale\(built\)\)/, "a stale review is built again, not sent");
  assert.match(screens, /wallet\.submit\(built, \{ retryingUnknown: S\.outcomeUnknown \}\)/, "Try Again resends the same transaction");
});

await check("app.js hooks: Delete Account, Address Activity, Manage Addresses §11, the bell, Help, Fund This Address", () => {
  assert.match(app, /kusdtWallet \? kusdtWallet\.forgetAccount\(encoded\) : forgetKusdtStorage\(localStorage, encoded\)/);
  assert.match(app, /const isSelfSend = isMarkedOwnTransaction\(txid\) \|\| /);
  assert.match(app, /markOwnTransaction: \(txid\) => markOwnTransaction\(txid\)/);
  assert.match(app, /manageAddressesHideRefusal\(index, kusdtListedSpendingIndices\(\)\)/);
  assert.match(app, /hideAllKeepingListed\(spendingRevealedIndices\(\), kusdtListedSpendingIndices\(\)\)/);
  assert.match(app, /alertDialog\(\{ title: KUSDT_LISTED_ALERT_TITLE, message: KUSDT_LISTED_HIDE_MESSAGE \}\)/);
  assert.match(app, /showKusdtListedSpendingAddresses\(\);\n  renderSpendingList\(\);/);
  assert.match(app, /notif\.targetKind === "kusdt"/);
  assert.match(app, /notificationsEnabled: \(\) => addressActivityFeatureEnabled\(\)/);
  assert.match(app, /\[data-help-kusdt\]/);
  assert.match(app, /sendKaspaOnClosed = typeof options\?\.onClosed === "function"/);
  assert.match(app, /apiBase: \(\) => getEndpoint\("trestlyApi"\)/);
  assert.match(app, /window\.__kasiaNativeFetch \|\| window\.fetch\.bind\(window\)/, "Trestly is fetched past the relay wrapper");
  assert.match(app, /if \(holding\?\.spendingIndex == null\) return String\(engine\.privateKeyHex/);
  assert.match(app, /if \(isQuantumIndex\(holding\.spendingIndex\)\) return null;/);
});

await check("index.html: the pager and its pills, Swap, the Help row, the Trestly field, the CSS version", () => {
  for (const marker of ["data-wallet-card-pager", "data-wallet-card-pill=\"1\">kUSDT", "data-kusdt-card", "kUSDT Balance", "Held On", "KAS Held With It",
    "Tap to Manage", "data-wallet-swap", "Swap Stablecoins", "data-help-kusdt", "kUSDT Guide",
    "What kUSDT is, where it lives, and how sending and swapping work.", "data-endpoint=\"trestlyApi\"", "Trestly API URL",
    "data-chatting-address-notes", "data-spending-qr-notes"]) assert.ok(html.includes(marker), marker);
  // 417 came with kUSDT; later builds only move it up.
  assert.ok(Number(html.match(/\.\/ui\/styles\.css\?v=(\d+)"/)[1]) >= 417);
  assert.ok(css.includes(".kusdt-balance-card") && css.includes("rgba(38,161,123,.32)"), "the green card");
  const helpKns = html.indexOf("data-help-kns");
  assert.ok(helpKns > 0 && html.indexOf("data-help-kusdt") > helpKns, "after the .kachat Names Guide");
});

await check("the Trestly API: its own endpoint, defaulting to the deployment's, never relayed", async () => {
  assert.match(endpoints, /trestlyApi: "https:\/\/api\.trestly\.io\/api\/v1"/);
  assert.match(endpoints, /trestlyApi: "https:\/\/testnet\.trestly\.io\/api\/v1"/);
  assert.equal(K.kusdtDeployment("mainnet").apiBase, "https://api.trestly.io/api/v1");
  assert.equal(K.kusdtDeployment("testnet-10").apiBase, "https://testnet.trestly.io/api/v1");
  const relayed = /const INDEXER_PROXY_HOST_RE = (\/.*\/i);/.exec(endpoints);
  assert.ok(relayed, "the relay's host list");
  // eslint-disable-next-line no-eval
  const re = eval(relayed[1]);
  assert.equal(re.test("api.trestly.io"), false);
  assert.equal(re.test("testnet.trestly.io"), false);
});

console.log(`kUSDT UI: ${passed}/${passed + failures.length} passed`);
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
