// The whole-app audit of 2026-11-21: less work per thread / chat-list redraw and per save, the two
// missing security headers, the cloud setup's secrets file, and the launch screen saying K.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8");
const app = read("ui", "app.js");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}
function fnSource(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is in ui/app.js`);
  let depth = 0;
  for (let i = app.indexOf(") {", start) + 2; i < app.length; i += 1) {
    if (app[i] === "{") depth += 1;
    else if (app[i] === "}" && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

test("the thread asks each message's envelope questions once per text, not once per redraw", () => {
  assert.match(app, /^const renderEnvelopeMemos = \{ control: new Map\(\), groupControl: new Map\(\), chess: new Map\(\), groupPhoto: new Map\(\) \};/m);
  // declared before anything can draw (no TDZ on an early render)
  assert.ok(app.indexOf("const renderEnvelopeMemos") < app.indexOf("state = buildFullyRestoredState();"));
  const render = fnSource("renderMessages");
  assert.match(render, /\.filter\(\(m\) => !isControlEnvelopeText\(m\?\.text\)\)/);
  assert.doesNotMatch(render, /Chess\.parseChessEnvelope/);
  assert.equal((render.match(/chessEnvelopeOf\(/g) || []).length, 2);

  let parses = 0;
  const box = { Chess: { parseChessEnvelope: (t) => { parses += 1; return String(t ?? "").startsWith("{\"chess") ? { kind: "move" } : null; }, unwrapReplyText: (t) => t } };
  vm.createContext(box);
  vm.runInContext(`const renderEnvelopeMemos = { chess: new Map() };\n${fnSource("renderMemo")}\n${fnSource("chessEnvelopeOf")}\nthis.api = { chessEnvelopeOf };`, box);
  const move = "{\"chess\":1}";
  const first = box.api.chessEnvelopeOf(move);
  assert.equal(box.api.chessEnvelopeOf(move), first, "the same object again");
  box.api.chessEnvelopeOf("hello");
  box.api.chessEnvelopeOf("hello");
  assert.equal(parses, 2);
  assert.equal(box.api.chessEnvelopeOf(undefined), null, "a missing text is still answered");
});

test("a save stringifies the messages once; the history copy rides the backup's minute", () => {
  const writes = fnSource("persistStateWrites");
  const throttled = writes.slice(writes.indexOf("STATE_BACKUP_MIN_INTERVAL_MS) {"), writes.indexOf("lastStateBackupWriteAt = now;"));
  assert.match(throttled, /chatStorageSetSync\(accountScopedKey\(MESSAGE_HISTORY_KEY\)/);
  assert.equal((writes.match(/MESSAGE_HISTORY_KEY/g) || []).length, 1);
  // clearing a chat marks nothing hidden, so it writes the recovery copies at once
  assert.match(app, /conversationEntry\.messages = \[\];[\s\S]{0,400}lastStateBackupWriteAt = 0;\n\s*persistState\(\);/);
});

test("the contact lookup is indexed and never answers with a stale contact", () => {
  const box = { state: { contacts: [] } };
  vm.createContext(box);
  vm.runInContext(`let contactIndexById = { list: null, map: new Map() };\n${fnSource("contactForConversation")}\nthis.find = contactForConversation;`, box);
  const a = { id: "a" }; const b = { id: "b" }; const c = { id: "c" };
  box.state.contacts = [a, b];
  assert.equal(box.find({ contactId: "b" }), b);
  assert.equal(box.find({ contactId: "zz" }), null);
  box.state.contacts.splice(0, 1); // b moves to index 0
  assert.equal(box.find({ contactId: "b" }), b);
  box.state.contacts.push(c);
  assert.equal(box.find({ contactId: "c" }), c);
  const b2 = { id: "b" };
  box.state.contacts[0] = b2; // replaced in place
  assert.equal(box.find({ contactId: "b" }), b2);
  box.state.contacts = [c]; // a whole new list (a restored state)
  assert.equal(box.find({ contactId: "b" }), null);
  assert.equal(box.find(null), null);
});

test("the chat list sorts on each chat's newest message found once, and skips a redraw that changes nothing", () => {
  const sorted = fnSource("sortedConversations");
  assert.equal((sorted.match(/conversationRecency\(/g) || []).length, 1);
  assert.doesNotMatch(sorted, /\.sort\([^)]*conversationRecency/);
  const render = fnSource("renderChats");
  assert.match(render, /if \(listHtml !== lastChatListHtml\) \{\n\s*chatList\.innerHTML = listHtml;/);
  // code that edits the rows in place forgets the last drawing
  assert.match(fnSource("markChatRowOpened"), /lastChatListHtml = null;/);
  assert.match(fnSource("updateActiveRowHighlight"), /lastChatListHtml = null;/);
  assert.match(fnSource("groupPhotoDataUrl"), /renderMemo\("groupPhoto"/);
});

test("the scroll-to-latest badge runs once a frame and counts back from the newest", () => {
  assert.match(app, /messageArea\.addEventListener\("scroll", queueUpdate, \{ passive: true \}\);/);
  assert.match(app, /for \(let i = all\.length - 1; i >= 0 && unseen < 99; i -= 1\)/);
  assert.match(fnSource("syncChatHeaderInsets"), /area\.style\.paddingTop !== padding/);
});

test("Permissions-Policy and HSTS on the site; the secrets file is private; the launch screen says K", () => {
  const headers = read("public", "_headers");
  assert.match(headers, /\n {2}Permissions-Policy: camera=\(self\), microphone=\(self\), geolocation=\(\)/);
  assert.match(headers, /\n {2}Strict-Transport-Security: max-age=31536000; includeSubDomains\n/);
  assert.doesNotMatch(headers, /preload/);
  assert.match(read("scripts", "kachat-cloud-setup.sh"), /\n {2}chmod 600 \.env\n/);
  assert.match(read("vite.config.mjs"), /`K \$\{v\.version\} \(\$\{v\.build\}\)`/);
});

console.log(`${passed}/6 passed`);
