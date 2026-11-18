// node tools/test-message-click-menu.mjs - Build 298 (owner): a left click on a message opens the
// same menu as a right-click, and that menu has the quick reactions on top in 1:1 chats, groups and
// Public Chats. The composer's emoji button sits inside the message field, and Play Chess draws iOS's
// checkerboard.rectangle.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const app = read("ui/app.js");
const rooms = read("ui/broadcasts.js");
const html = read("index.html");

let failures = 0;
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.log(`FAIL - ${name}\n`, error); }
}

// onMessageClick on its own, with just enough of a DOM for it.
async function clickHelper() {
  const src = read("ui/touch.js");
  const start = src.indexOf("const OWN_CLICK_SELECTOR");
  const code = `${src.slice(start).replace(/^export /gm, "")}\nexport { onMessageClick };`;
  return import(`data:text/javascript,${encodeURIComponent(code)}`);
}
class FakeEl {
  constructor(tag = "div", parent = null) { this.tag = tag; this.parentElement = parent; this.listeners = {}; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  matches(selector) { return selector.split(",").map((s) => s.trim()).includes(this.tag); }
  contains(node) { for (let n = node; n; n = n.parentElement) if (n === this) return true; return false; }
  fire(type, event) { for (const fn of this.listeners[type] || []) fn(event); }
}
globalThis.Element = FakeEl;
let openMenu = false;
globalThis.document = { querySelector: () => (openMenu ? {} : null) };
globalThis.window = { getSelection: () => ({ isCollapsed: true }) };

await test("a mouse click on the bubble's text opens the menu; a tap, a link and a closing click don't", async () => {
  const { onMessageClick } = await clickHelper();
  const bubble = new FakeEl("div");
  const text = new FakeEl("span", bubble);
  const link = new FakeEl("a", bubble);
  let opened = 0;
  onMessageClick(bubble, () => { opened += 1; });
  const click = (target, pointerType = "mouse") => {
    bubble.fire("pointerdown", { pointerType });
    bubble.fire("click", { target, button: 0, defaultPrevented: false });
  };
  click(text);
  assert.equal(opened, 1, "mouse on text");
  click(text, "touch");
  assert.equal(opened, 1, "a tap on a phone stays a tap");
  click(link);
  assert.equal(opened, 1, "a link keeps its own click");
  openMenu = true;
  click(text);
  openMenu = false;
  assert.equal(opened, 1, "a click that closes a menu only closes it");
  window.getSelection = () => ({ isCollapsed: false, anchorNode: text });
  click(text);
  window.getSelection = () => ({ isCollapsed: true });
  assert.equal(opened, 1, "the click that ends a text selection");
  click(bubble);
  assert.equal(opened, 2, "on the bubble itself");
});
await test("1:1, group and room bubbles open their menu on a left click; double-click is phone-only", () => {
  assert.match(app, /onMessageClick\(bubble, \(event\) => \{\n\s+if \(messageSelectionMode\) return;\n\s+openOneToOneMessageMenu\(/);
  assert.match(app, /onMessageClick\(bubble, \(event\) => \{\n\s+if \(groupSelectionMode\) return;\n\s+openGroupMessageMenu\(/);
  assert.match(rooms, /onMessageClick\(el, \(event\) => openBroadcastMessageMenu\(/);
  assert.doesNotMatch(app + rooms, /onDoubleGesture\(/);
});
await test("the 1:1 and group menus carry the quick reactions, like the room menu", () => {
  assert.match(app, /const reaction = \{ current: myReaction, onPick: \(emoji\) => sendReaction\(conversationEntry, message, emoji\) \};\n\s+openMsgContextMenu\(\{ x, y, reaction,/);
  assert.match(app, /onPick: \(emoji\) => sendGroupReaction\(activeGroupId, message, emoji\),\n\s+\} : null;\n\s+openMsgContextMenu\(\{ x, y, reaction,/);
  assert.match(rooms, /reaction: pending \? null : \{ current, onPick:/);
});
await test("nothing in the menu acts in its first 300 ms (a double-click's second click)", () => {
  assert.match(app, /const tooSoon = \(\) => performance\.now\(\) - openedAt < 300;/);
  assert.equal((app.match(/if \(tooSoon\(\)\) return;/g) || []).length, 3);
});
await test("the emoji button is inside the message field, in 1:1 chats and groups", () => {
  for (const attr of ["data-composer-emoji", "data-group-composer-emoji"]) {
    const at = html.indexOf(` ${attr} `);
    const wrapOpen = html.lastIndexOf('<div class="composer-field-wrap">', at);
    const wrapClose = html.indexOf("</div>\n                  <button", wrapOpen);
    assert.ok(wrapOpen > 0 && at > wrapOpen && at < wrapClose, attr);
  }
});
await test("Play Chess draws a checkerboard in a rounded rectangle", () => {
  assert.match(html, /clipPath id="chess-tile-board-clip"><rect x="2\.5" y="4\.5" width="19" height="15" rx="3"\/>/);
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log(`message click menu: ${passed} passed`);
