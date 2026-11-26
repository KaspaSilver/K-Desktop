// App-shell fixes from the 2026-11-25 audit, run from ui/app.js's own source with the page around
// them stubbed:
//   #5  a sweep that throws no longer ends message syncing for the session: the loop reschedules,
//       backs off, and recovers; create/import start the timers whatever the first sweep did.
//   #30 30 s after a private key is copied the clipboard is emptied only if it still holds the key
//       (it used to write " " through copyTextToClipboard, which refused, so nothing was cleared).
//
//   node tools/test-audit-2026-11-25-shell.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "..", "ui", "app.js"), "utf8");

// --- source extraction (as tools/test-app-tail-guards.mjs) -------------------------------------
function skipLiteral(src, i) {
  const c = src[i];
  if (c === "/" && src[i + 1] === "/") { const end = src.indexOf("\n", i); return end < 0 ? src.length : end; }
  if (c === "/" && src[i + 1] === "*") return src.indexOf("*/", i + 2) + 2;
  if (c === '"' || c === "'") {
    for (let j = i + 1; j < src.length; j += 1) { if (src[j] === "\\") { j += 1; continue; } if (src[j] === c) return j + 1; }
  }
  if (c === "`") {
    for (let j = i + 1; j < src.length; j += 1) {
      if (src[j] === "\\") { j += 1; continue; }
      if (src[j] === "`") return j + 1;
      if (src[j] === "$" && src[j + 1] === "{") j = matchClose(src, j + 1, "{", "}") - 1;
    }
  }
  return i;
}
function matchClose(src, open, a, b) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const next = skipLiteral(src, i);
    if (next !== i) { i = next - 1; continue; }
    if (src[i] === a) depth += 1;
    else if (src[i] === b) { depth -= 1; if (depth === 0) return i + 1; }
  }
  throw new Error("unbalanced source");
}
function extractFunction(src, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  assert.ok(match, `function ${name} in the source`);
  const paramsEnd = matchClose(src, match.index + match[0].length - 1, "(", ")");
  const bodyStart = src.indexOf("{", paramsEnd);
  return src.slice(match.index, matchClose(src, bodyStart, "{", "}"));
}
function sandbox(sources, overrides = {}) {
  const calls = [];
  const scope = new Proxy(overrides, {
    has: (target, key) => typeof key === "string" && (key in target || !(key in globalThis)),
    get: (target, key) => {
      if (key === Symbol.unscopables) return undefined;
      if (key in target) return target[key];
      const fn = (...args) => { calls.push([key, ...args]); return undefined; };
      target[key] = fn;
      return fn;
    },
    set: (target, key, value) => { target[key] = value; return true; },
  });
  const names = sources.map((src) => /function\s+([A-Za-z0-9_$]+)/.exec(src)?.[1]).filter(Boolean);
  // eslint-disable-next-line no-new-func
  const run = new Function("scope", `with (scope) { ${sources.join("\n")}\n return { ${names.join(", ")} }; }`);
  return { fns: run(scope), calls, scope: overrides, called: (name) => calls.filter((c) => c[0] === name) };
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

// --- #5 the sweep loop survives a throw -----------------------------------------------------------
await test("#5 a sweep that throws is rescheduled, backs off, and recovers", async () => {
  const timers = [];
  const logs = [];
  let mode = "throw";
  const box = sandbox([extractFunction(app, "startSweepLoop")], {
    indexerAvailabilityHooked: true,
    sweepLoopRunning: false,
    lastSweepFailed: false,
    MESSAGE_REFRESH_MS: 5000,
    MESSAGE_REFRESH_MAX_MS: 60000,
    lastKnsRevealCheckAt: Date.now(),
    KNS_REVEAL_CHECK_MS: 1e9,
    document: { hidden: false },
    window: { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } },
    appendEngineLog: (line) => logs.push(line),
    pushNotificationsEnabled: () => false,
    refreshAllConversations: async () => {
      if (mode === "throw") throw new Error("Local storage is full");
      box.scope.lastSweepFailed = false;
      return 0;
    },
  });
  box.fns.startSweepLoop();
  assert.equal(timers.length, 1);
  await timers[0].fn();
  assert.equal(timers.length, 2, "the next tick is scheduled after a throw");
  assert.equal(timers[1].ms, 10000, "a throw counts as a failed sweep: the loop backs off");
  assert.ok(logs.some((l) => /Message sweep failed: Local storage is full/.test(l)));
  await timers[1].fn();
  assert.equal(timers[2].ms, 20000);
  mode = "ok";
  await timers[2].fn();
  assert.equal(timers[3].ms, 5000, "the first good sweep snaps back");
  box.fns.startSweepLoop();
  assert.equal(timers.length, 4, "still one loop");
});

await test("#5 the sweep's save is guarded, and create/import start the timers regardless", async () => {
  const sweep = extractFunction(app, "refreshAllConversations");
  assert.match(sweep, /try \{\s*persistState\(\);\s*if \(!activeConversationId\) renderChats\(\);\s*\} catch \(error\) \{\s*sweepFailures \+= 1;/);
  assert.match(sweep, /try \{\s*if \(contactNotesReadDue\(\)\)[\s\S]*?\} catch \(error\) \{ appendEngineLog\(`Contact notes check failed/);
  assert.equal((app.match(/\.finally\(\(\) => startAutomaticRefresh\(\)\);/g) || []).length, 2, "create and import");
  assert.doesNotMatch(app, /await refreshAllConversations\(\{ quiet: true \}\);\s*startAutomaticRefresh\(\);/);
  const onboarding = extractFunction(app, "runPostOnboardingSync");
  assert.match(onboarding, /\} catch \(error\) \{\s*appendEngineLog\(`Post-onboarding sync failed[^\n]*\n\s*\}\s*\/\/[^\n]*\n\s*startAutomaticRefresh\(\);/);
});

// --- #30 the private key clipboard wipe ----------------------------------------------------------
function clipboardBox(clipboard) {
  const timers = [];
  const box = sandbox([extractFunction(app, "clearPrivateKeyClipboardLater")], {
    privateKeyClipboardTimer: null,
    window: { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {} },
    navigator: { clipboard },
  });
  return { box, timers };
}
const KEY = "ab".repeat(32);

await test("#30 the key still on the clipboard after 30 s is emptied with \"\"", async () => {
  const clip = { text: KEY, readText: async () => clip.text, writeText: async (t) => { clip.text = t; } };
  const { box, timers } = clipboardBox(clip);
  box.fns.clearPrivateKeyClipboardLater(KEY);
  assert.equal(timers[0].ms, 30_000);
  await timers[0].fn();
  assert.equal(clip.text, "");
});

await test("#30 something copied since is left alone", async () => {
  const clip = { text: "a kaspa: address copied later", readText: async () => clip.text, writeText: async (t) => { clip.text = t; } };
  const { box, timers } = clipboardBox(clip);
  box.fns.clearPrivateKeyClipboardLater(KEY);
  await timers[0].fn();
  assert.equal(clip.text, "a kaspa: address copied later");
});

await test("#30 a clipboard that can't be read is emptied (as the seed copy does)", async () => {
  const clip = { text: KEY, readText: async () => { throw new Error("denied"); }, writeText: async (t) => { clip.text = t; } };
  const { box, timers } = clipboardBox(clip);
  box.fns.clearPrivateKeyClipboardLater(KEY);
  await timers[0].fn();
  assert.equal(clip.text, "");
});

await test("#30 both private key copy buttons use it; the \" \" write is gone", async () => {
  assert.doesNotMatch(app, /copyTextToClipboard\(" "\)/);
  assert.match(app, /clearPrivateKeyClipboardLater\(value\);/);
  assert.match(app, /clearPrivateKeyClipboardLater\(engine\.privateKeyHex\);/);
});

// --- #14 the chatting-address switch carries the password (logic: tools/test-key-vault-carry.mjs) --
await test("#14 the switch begins the carry before the import, finishes it after, abandons on failure", async () => {
  const fn = extractFunction(app, "performChattingAddressSwitch");
  const begin = fn.indexOf("beginAccountVaultCarry(previousAddress, candidate.address)");
  const imp = fn.indexOf("await importAndEnterAccount(");
  const drop = fn.indexOf("persistSavedAccounts(loadSavedAccounts().filter(");
  const finish = fn.indexOf("finishAccountVaultCarry(previousAddress, engine.address)");
  assert.ok(begin > 0 && begin < imp, "begin before the import");
  assert.ok(drop > 0 && finish > drop, "finish after the old entry is dropped");
  assert.match(fn.slice(fn.lastIndexOf("} catch (error) {")), /abandonAccountVaultCarry\(previousAddress, candidate\.address\)/);
});

console.log(`\n${passed} passed`);
