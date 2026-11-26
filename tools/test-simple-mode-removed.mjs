// Simple Mode (child mode) is gone from Desktop, as from K iOS in eb2ccac9 (owner, 2026-11-25:
// "simple mode stays gone"; audit 2026-11-25): no code, markup, styles or push mirror field of it
// remain in ui/, public/ or index.html, and a one-time cleanup deletes the keys it stored.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  removeRetiredFeatureData,
  RETIRED_SIMPLE_MODE_KEYS,
  RETIRED_FEATURES_DONE_KEY,
} from "../ui/retired-features.js";

const root = fileURLToPath(new URL("..", import.meta.url));
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else if (/\.(js|mjs|css|html|json)$/.test(name)) out.push(path);
  }
  return out;
}

// The one file allowed to name the old keys: the cleanup that deletes them.
const ALLOWED = new Set(["ui/retired-features.js"]);
const PATTERNS = [
  /simple[\s_-]?mode/i,
  /child[\s_-]?mode/i,
  /childmode/i,
  /CHILD_HIDDEN_TABS/,
  /isChildModeEnabled/,
  /data-child-mode/,
  /data-cm-/,
  /kachat-user-type-choice/,
  /UserType(GuideStep|GuideChoice|Pending|Chosen)/,
  /setup-usertype|setup-child-password/,
  /kaPostsSuppressed/,
  /m\.childMode/,
  /Adult\/Child/,
  /Who will use K/i,
];

test("no Simple Mode references remain in ui/, public/ and index.html", () => {
  const files = [...filesUnder(join(root, "ui")), ...filesUnder(join(root, "public")), join(root, "index.html")];
  const hits = [];
  for (const file of files) {
    const rel = relative(root, file).split("\\").join("/");
    if (ALLOWED.has(rel)) continue;
    const text = readFileSync(file, "utf8");
    for (const pattern of PATTERNS) {
      const match = text.match(pattern);
      if (match) hits.push(`${rel}: ${match[0]}`);
    }
  }
  assert.deepEqual(hits, []);
});

test("the Simple Mode module and its Settings page are gone", () => {
  assert.equal(existsSync(join(root, "ui", "childmode.js")), false);
  const html = readFileSync(join(root, "index.html"), "utf8");
  assert.doesNotMatch(html, /data-settings-subscreen="child-mode"|data-settings-open-subscreen="child-mode"/);
  const app = readFileSync(join(root, "ui", "app.js"), "utf8");
  assert.doesNotMatch(app, /extra: "usertype"/);
  // The setup guide's run marker and the password eye toggle survive in their own module.
  assert.match(app, /from "\.\/onboarding-run\.js";/);
  assert.match(app, /installEyeToggleDelegation\(\);/);
  // The cleanup runs on startup.
  assert.match(app, /import \{ removeRetiredFeatureData \} from "\.\/retired-features\.js";/);
  assert.match(app, /if \(removeRetiredFeatureData\(\)\) appendEngineLog\(/);
});

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

test("the cleanup lists every key Simple Mode stored", () => {
  assert.deepEqual([...RETIRED_SIMPLE_MODE_KEYS].sort(), [
    "kachat-child-mode-enabled-v1",
    "kachat-child-mode-record-v1",
    "kachat-simple-mode-failed-attempts",
    "kachat-simple-mode-locked-until",
    "kachat-user-type-choice-v1",
  ]);
});

test("the cleanup deletes the old keys once and keeps everything else", () => {
  const storage = memoryStorage({
    "kachat-child-mode-enabled-v1": "1",
    "kachat-child-mode-record-v1": JSON.stringify({ salt: "00", hash: "11", iterations: 120000 }),
    "kachat-simple-mode-failed-attempts": "3",
    "kachat-simple-mode-locked-until": "1790000000",
    "kachat-user-type-choice-v1": "pending",
    "kachat-onboarding-run-pending-v1": "create",
    "kachat-app-password-v1": "{}",
  });
  assert.equal(removeRetiredFeatureData(storage), true);
  for (const key of RETIRED_SIMPLE_MODE_KEYS) assert.equal(storage.getItem(key), null, key);
  assert.equal(storage.getItem("kachat-onboarding-run-pending-v1"), "create");
  assert.equal(storage.getItem("kachat-app-password-v1"), "{}");
  assert.equal(storage.getItem(RETIRED_FEATURES_DONE_KEY), "1");
  // Already done: a later launch leaves storage alone.
  storage.setItem("kachat-child-mode-enabled-v1", "1");
  assert.equal(removeRetiredFeatureData(storage), false);
  assert.equal(storage.getItem("kachat-child-mode-enabled-v1"), "1");
});

test("storage that throws or is missing does not break startup", () => {
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(removeRetiredFeatureData(throwing), false);
  assert.equal(removeRetiredFeatureData(null), false);
});

console.log(`${passed} passed`);
