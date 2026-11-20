// node tools/test-ios-wallet-regular-receive.mjs - KaPay 3d126db / KaChat 5b7c772c wallet changes
// that come with kUSDT: Receive hands out regular addresses (owner's call, 2026-11-19), Address
// Actions has a Generate row for each kind, and Wallet's refresh sweeps every address, showing only
// new ones (a hidden address stays hidden), at most every 10 minutes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applySpendingDiscovery, applyQuantumDiscovery } from "../ui/spending-discovery.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(repo, "ui/app.js"), "utf8");
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`); };

test("Receive: regular slots, recycled hidden unused ones first, else past the regular end", () => {
  assert.match(app, /lowestUnusedIndex: lowestUnusedRegularIndex,/);
  const fn = app.slice(app.indexOf("async function lowestUnusedRegularIndex()"), app.indexOf("/// The lowest hidden quantum-safe slot"));
  assert.match(fn, /if \(isQuantumIndex\(i\) \|\| !hidden\.has\(i\) \|\| i === state\.activeIndex\) continue;/);
  assert.match(fn, /return state\.maxIndex \+ 1;/);
});
test("Address Actions: a Generate row for each kind, iOS's words", () => {
  assert.match(app, /\{ id: "generate-regular", title: "Generate Non-Quantum Address", subtitle: "A regular address, like Receive gives you\. Works with everything, kUSDT included\." \}/);
  assert.match(app, /\{ id: "generate", title: "Generate Quantum-Resistant Address", subtitle: "Keeps its key hidden until it spends\. For Kaspa only: kUSDT can't be traded from it\." \}/);
  assert.match(app, /if \(isQuantumIndex\(i\) !== quantum\) continue;/);
});
test("Wallet's sweep shows only new addresses; one you hid stays hidden", () => {
  assert.deepEqual(applySpendingDiscovery({ maxIndex: 5, hidden: [2, 3, 7] }, { lastMatchIndex: 9, matchedIndices: [2, 9] }, { newOnly: true }), { maxIndex: 9, hidden: [2, 3, 6, 7, 8] });
  assert.deepEqual(applySpendingDiscovery({ maxIndex: 5, hidden: [2, 3, 7] }, { lastMatchIndex: 9, matchedIndices: [2, 9] }).hidden, [3, 6, 7, 8], "Discover still shows every match");
  assert.deepEqual(applyQuantumDiscovery({ qMaxIndex: 3, hidden: [1000001, 1000005] }, { matchedIndices: [1000001, 1000005], highestUsed: 5 }, 1000000, { newOnly: true }), { qMaxIndex: 5, hidden: [1000001, 1000004] });
  assert.match(app, /const WALLET_SWEEP_EVERY_MS = 10 \* 60 \* 1000;/);
  assert.match(app, /await discoverSpendingAddressesFor\(wallet, \{ newOnly: true \}\);/);
});
console.log(`wallet regular receive: ${passed} passed`);
