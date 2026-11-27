// node tools/test-audit-2026-11-27-cold.mjs - Cold Storage audit (2026-11-27), four fixes:
//  1. A background re-read (listColdWatchedAddresses, every 30-60 s from ui/app.js) no longer
//     replaces the live accounts, and every action that awaits re-resolves its account by id
//     before it writes, so Discover, Generate, renames, Hide, the visibility toggles and Remove
//     don't save into a detached copy or quietly give up.
//  2. A hidden address holding Kaspa is shown, counted in the Total, and un-hidden for good once
//     its live balance comes back above zero.
//  3. A price that lands late repaints only the screen it was drawn for.
//  4. The kpub's 30-second clipboard clear only clears while the clipboard still holds the kpub.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mergeColdAccountsById, coldFundedHiddenIndexes, coldShownEntries, coldTotalSompi, coldScreenName,
  coldClipboardStillHolds,
} from "../ui/cold-cards.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const cold = readFileSync(join(repo, "ui/coldstorage.js"), "utf8");

/** The source of one function in ui/coldstorage.js, braces balanced. */
function fn(name) {
  const start = cold.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} exists`);
  let depth = 0;
  for (let i = cold.indexOf("{", cold.indexOf(")", start)); i < cold.length; i += 1) {
    if (cold[i] === "{") depth += 1;
    else if (cold[i] === "}") { depth -= 1; if (depth === 0) return cold.slice(start, i + 1); }
  }
  throw new Error(`${name} has no end`);
}

let passed = 0;
async function test(name, body) {
  try { await body(); passed += 1; }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

// --- 1. live accounts survive a re-read --------------------------------------------------------

await test("merge keeps the live object and refreshes it in place", () => {
  const live = { id: "a", label: "Old", kpub: "kpub1", maxIndex: 2, hidden: [1], labels: {}, stale: true };
  const held = live; // what an in-flight action holds across its await
  const stored = [{ id: "a", label: "New", kpub: "kpub1", maxIndex: 5, hidden: [], labels: { 0: "x" } }];
  const merged = mergeColdAccountsById([live], stored);
  assert.equal(merged.length, 1);
  assert.equal(merged[0], held, "the same object, not a copy");
  assert.equal(held.label, "New");
  assert.equal(held.maxIndex, 5);
  assert.deepEqual(held.hidden, []);
  assert.equal("stale" in held, false, "a key no longer stored goes");
});

await test("merge adds new records, drops removed ones, keeps the stored order", () => {
  const a = { id: "a", kpub: "k1" };
  const b = { id: "b", kpub: "k2" };
  const c = { id: "c", kpub: "k3" };
  const merged = mergeColdAccountsById([a, b], [{ id: "c", kpub: "k3" }, { id: "a", kpub: "k1" }]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((x) => x.id), ["c", "a"]);
  assert.equal(merged[1], a);
  assert.notEqual(merged[0], c, "a new record is the stored one");
  assert.deepEqual(mergeColdAccountsById([], [{ id: "z", kpub: "k" }]).map((x) => x.id), ["z"]);
  assert.deepEqual(mergeColdAccountsById([a], []), []);
});

await test("an action holding an account survives the background re-read (simulated)", () => {
  // A Discover holds `account`, the 30-60 s re-read runs, then Discover writes and saves.
  let accounts = [{ id: "a", kpub: "k", maxIndex: 0, hidden: [] }];
  const held = accounts[0];
  const storage = JSON.stringify(accounts);
  accounts = mergeColdAccountsById(accounts, JSON.parse(storage));
  held.maxIndex = 9;
  assert.equal(JSON.parse(JSON.stringify(accounts))[0].maxIndex, 9, "the saved list carries the write");
});

await test("listColdWatchedAddresses reads into a local and never touches the live list", () => {
  const body = fn("listColdWatchedAddresses");
  assert.match(body, /const stored = readStoredAccounts\(\);/);
  assert.doesNotMatch(body, /loadState\(\)/);
  assert.doesNotMatch(body, /\baccounts\b(?! here)/, "no use of the live `accounts`");
  assert.match(body, /for \(const account of stored\)/);
});

await test("loadState merges by id instead of replacing", () => {
  const body = fn("loadState");
  assert.match(body, /accounts = mergeColdAccountsById\(accounts, readStoredAccounts\(\)\);/);
  // an id-less stored record keeps the id the live list gave it
  assert.match(fn("readStoredAccounts"), /accounts\.find\(\(a\) => a\.kpub === raw\.kpub\)\?\.id/);
});

await test("the actions re-resolve their account by id before they write", () => {
  assert.match(fn("liveAccount"), /accounts\.find\(\(a\) => a\.id === id\)/);
  assert.match(fn("liveActiveAccount"), /activeAccountId === id \? liveAccount\(id\) : null/);
  // no action compares a held object any more (a re-read used to make these fail silently)
  assert.doesNotMatch(cold, /activeAccount\(\) !== account/);
  assert.doesNotMatch(cold, /accounts\.includes\(account\)/);

  const discover = fn("discoverAddresses");
  assert.match(discover, /const live = liveAccount\(account\.id\);\s*if \(!live\) return 0;/);
  assert.match(discover, /live\.maxIndex = lastMatchIndex \+ 1;/);
  assert.match(discover, /live\.hidden = \[\.\.\.hiddenSet\];\s*saveState\(\);/);
  assert.doesNotMatch(discover, /\baccount\.(maxIndex|hidden) =/);

  const run = fn("runAddressAction");
  assert.match(run, /const live = liveActiveAccount\(account\.id\);\s*if \(!live\) return;\s*if \(pick === null\) \{\s*live\.maxIndex \+= 1;/);
  assert.match(run, /const latestHidden = new Set\(live\.hidden\.map\(Number\)\);/);
  assert.doesNotMatch(run, /\baccount\.(maxIndex|hidden) *[+]?=/);

  const rename = fn("renameAccountInPlace");
  assert.match(rename, /const live = liveAccount\(account\.id\);/);
  assert.match(rename, /live\.label = name;/);

  const address = fn("handleAddressAction");
  // Hide, the in-place rename's keystrokes and Stop Watching
  assert.equal((address.match(/const live = liveActiveAccount\(account\.id\);/g) || []).length, 3);
  assert.match(address, /live\.hidden\.push\(at\)/);
  assert.match(address, /live\.labels\[at\] = trimmed/);
  assert.match(address, /removeQuantumAddress\(live, entry\.address\)/);
  assert.doesNotMatch(address, /\baccount\.(hidden\.push|labels\[at\] =)/);

  const remove = fn("removeAccount");
  assert.match(remove, /const live = liveAccount\(id\);\s*if \(!live\) return;/);
  assert.match(remove, /accounts = accounts\.filter\(\(a\) => a\.id !== live\.id\);/);
  assert.match(remove, /dropColdQuantumUtxoLabels\(live\)/);

  for (const name of ["toggleVisibilityRow", "toggleQuantumVisibility"]) {
    assert.match(fn(name), /account = liveActiveAccount\(account\.id\);\s*if \(!account \|\| !showingVisibility\) return;/, name);
  }
  assert.match(fn("openNewAddressChooser"), /if \(!liveActiveAccount\(account\.id\) \|\| activeAddressIndex !== null \|\| showingVisibility\) return;/);
  assert.match(fn("loadListBalances"), /if \(!liveAccount\(account\.id\)\) continue;/);
});

// --- 2. funded hidden addresses ----------------------------------------------------------------

await test("a hidden address holding Kaspa is un-hidden; zero and unknown stay hidden", () => {
  const entries = [
    { index: 0, balanceSompi: 5 },
    { index: 1, balanceSompi: 0 },
    { index: 2, balanceSompi: undefined },
    { index: 3, balanceSompi: 100 },
    { index: 4, balanceSompi: 7 },
  ];
  assert.deepEqual(coldFundedHiddenIndexes([1, 2, 3, "4"], entries), [3, 4]);
  assert.deepEqual(coldFundedHiddenIndexes([], entries), []);
  assert.deepEqual(coldFundedHiddenIndexes([1, 2], entries), []);
  assert.deepEqual(coldFundedHiddenIndexes([3], [{ index: null, balanceSompi: 5 }]), []);
});

await test("the account screen shows every funded address and counts it in the Total", () => {
  const entries = [
    { index: 0, balanceSompi: 10 },
    { index: 1, balanceSompi: 0 },
    { index: 2, balanceSompi: 25 },
    { index: 3, balanceSompi: undefined },
  ];
  const shown = coldShownEntries(entries, [1, 2, 3]);
  assert.deepEqual(shown.map((e) => e.index), [0, 2], "hidden #2 holds Kaspa, so it shows");
  assert.equal(coldTotalSompi(entries), 35, "hidden funds count");
  assert.equal(coldTotalSompi([]), 0);

  const render = fn("renderDetail");
  assert.match(render, /const visible = coldShownEntries\(detailEntries, account\.hidden\);/);
  assert.match(render, /const totalSompi = coldTotalSompi\(detailEntries\);/);
  assert.doesNotMatch(render, /!hiddenSet\.has\(e\.index\)/);
});

await test("the live balances un-hide funded addresses and save", () => {
  const unhide = fn("unhideFundedAddresses");
  assert.match(unhide, /const account = liveAccount\(accountId\);/);
  assert.match(unhide, /currentIndexOf\(account, e\)/);
  assert.match(unhide, /coldFundedHiddenIndexes\(account\.hidden, current\)/);
  assert.match(unhide, /account\.hidden = account\.hidden\.filter\(\(i\) => !funded\.has\(Number\(i\)\)\);\s*saveState\(\);/);
  assert.match(unhide, /coldWatchedCache\.fingerprint = "";/);
  assert.match(unhide, /deps\.onWatchedAddressesChanged\?\.\(\);/);
  // after the account's balances land, before the repaint
  assert.match(fn("loadDetail"), /unhideFundedAddresses\(account\.id, detailEntries\);\s*render\(\);/);
  // and on the list, from each account's live read
  const list = fn("loadListBalances");
  assert.match(list, /unhideFundedAddresses\(account\.id, addresses\.map\(/);
  assert.match(list, /index: i < derivedCount \? i : COLD_QUANTUM_INDEX_BASE \+ \(i - derivedCount\)/);
});

// --- 3. a late price repaints the right screen -------------------------------------------------

await test("coldScreenName picks the screen as render() does", () => {
  assert.equal(coldScreenName({ activeAccountId: null, activeAddressIndex: null, showingVisibility: false }), "list");
  assert.equal(coldScreenName({ activeAccountId: "a", activeAddressIndex: null, showingVisibility: false }), "detail");
  assert.equal(coldScreenName({ activeAccountId: "a", activeAddressIndex: null, showingVisibility: true }), "visibility");
  assert.equal(coldScreenName({ activeAccountId: "a", activeAddressIndex: 0, showingVisibility: false }), "address");
  assert.equal(coldScreenName({ activeAccountId: "a", activeAddressIndex: 3, showingVisibility: true }), "address");
  assert.equal(coldScreenName({ activeAccountId: null, activeAddressIndex: 3, showingVisibility: true }), "list");
});

await test("price callbacks repaint only the screen they were drawn for", () => {
  assert.match(fn("render"), /const screen = currentColdScreen\(\);/);
  assert.match(fn("repaintIfShowing"), /if \(rootEl\?\.isConnected && currentColdScreen\(\) === screen\) render\(\);/);
  assert.match(fn("cardWorthHtml"), /\(\) => repaintIfShowing\(screen\)/);
  assert.match(fn("balanceCardHtml"), /\(\) => repaintIfShowing\(screen\)/);
  assert.match(cold, /function balanceCardHtml\(label, sompi, screen = "detail", address = ""\)/);
  assert.match(fn("addressCardHtml"), /cardWorthHtml\(entry\.balanceSompi, "detail"\)/);
  assert.match(fn("accountCardHtml"), /cardWorthHtml\(sompi, "list"\)/);
  assert.match(fn("renderAddressScreen"), /balanceSompi, "address", entry\.address\)/);
  assert.doesNotMatch(cold, /redraw = renderDetail|cardWorthHtml\([^)]*renderDetail\)/);

  // run it: a price that lands after the address page opened leaves that page alone
  const make = new Function("env", `
    let activeAccountId = "a", activeAddressIndex = null, showingVisibility = false;
    const rootEl = { isConnected: true };
    const coldScreenName = env.coldScreenName;
    const render = () => env.renders.push(currentColdScreen());
    ${fn("currentColdScreen")}
    ${fn("repaintIfShowing")}
    return { repaintIfShowing, open: (i) => { activeAddressIndex = i; }, vis: (v) => { showingVisibility = v; } };
  `);
  const env = { renders: [], coldScreenName };
  const page = make(env);
  page.repaintIfShowing("detail");
  assert.deepEqual(env.renders, ["detail"]);
  page.open(4);
  page.repaintIfShowing("detail");
  assert.deepEqual(env.renders, ["detail"], "the address page isn't painted over");
  page.open(null);
  page.vis(true);
  page.repaintIfShowing("detail");
  assert.deepEqual(env.renders, ["detail"], "Address Visibility isn't painted over");
  page.repaintIfShowing("visibility");
  assert.deepEqual(env.renders, ["detail", "visibility"]);
});

// --- 4. the kpub's clipboard clear -------------------------------------------------------------

await test("coldClipboardStillHolds only for the same kpub", () => {
  assert.equal(coldClipboardStillHolds("kpubABC", "kpubABC"), true);
  assert.equal(coldClipboardStillHolds(" kpubABC\n", "kpubABC"), true);
  assert.equal(coldClipboardStillHolds("something else", "kpubABC"), false);
  assert.equal(coldClipboardStillHolds("", "kpubABC"), false);
  assert.equal(coldClipboardStillHolds(null, "kpubABC"), false, "unreadable: leave it");
  assert.equal(coldClipboardStillHolds(undefined, "kpubABC"), false);
  assert.equal(coldClipboardStillHolds("", ""), false);
});

await test("copyKpub clears after 30 s only while the kpub is still there", async () => {
  const make = new Function("env", `
    let kpubClipboardTimer = null;
    const deps = { showToast: () => {} };
    const coldClipboardStillHolds = env.coldClipboardStillHolds;
    const window = {
      setTimeout: (fn, ms) => { env.timers.push({ fn, ms }); return env.timers.length; },
      clearTimeout: (id) => { env.cleared.push(id); },
    };
    const navigator = env.navigator;
    ${fn("copyKpub")}
    return copyKpub;
  `);
  const scenario = async (afterCopy, { readThrows = false, noRead = false } = {}) => {
    const env = { timers: [], cleared: [], coldClipboardStillHolds, writes: [] };
    let clip = "";
    env.navigator = {
      clipboard: {
        writeText: async (t) => { clip = t; env.writes.push(t); },
        ...(noRead ? {} : { readText: async () => { if (readThrows) throw new Error("NotAllowedError"); return clip; } }),
      },
    };
    const copyKpub = make(env);
    copyKpub("kpubSECRET");
    assert.equal(env.timers.at(-1).ms, 30_000);
    if (afterCopy) clip = afterCopy;
    await env.timers.at(-1).fn();
    return { env, clip };
  };

  let r = await scenario(null);
  assert.equal(r.clip, " ", "still the kpub: cleared");
  r = await scenario("my newer copy");
  assert.equal(r.clip, "my newer copy", "something copied since: kept");
  assert.deepEqual(r.env.writes, ["kpubSECRET"]);
  r = await scenario(null, { readThrows: true });
  assert.equal(r.clip, "kpubSECRET", "can't read: not wiped");
  r = await scenario(null, { noRead: true });
  assert.equal(r.clip, "kpubSECRET", "no readText: not wiped");
});

console.log(`audit 2026-11-27 cold: ${passed} passed`);
