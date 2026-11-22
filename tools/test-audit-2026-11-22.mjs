// The audit's second round (2026-11-22): chat threads and the KaPost feed keep the rows that did not
// change, link preview images come through the relay, the dev server stays on this machine, the
// gesture listeners that block scrolling exist only where the gesture does, and group messages are
// saved in fewer, larger batches.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8");
const app = read("ui", "app.js");
const kaposts = read("ui", "kaposts.js");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}
function fnSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  let depth = 0;
  for (let i = source.indexOf(") {", start) + 2; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

// A container of nodes, just enough DOM for reconcileChildren.
function fakeContainer(initial = []) {
  const container = {
    childNodes: [],
    get firstChild() { return this.childNodes[0] || null; },
    insertBefore(node, ref) {
      if (node.parent) node.parent.childNodes.splice(node.parent.childNodes.indexOf(node), 1);
      const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
      this.childNodes.splice(at, 0, node);
      node.parent = this;
      return node;
    },
  };
  for (const node of initial) container.insertBefore(node, null);
  return container;
}
function fakeNode(name) {
  return {
    name,
    parent: null,
    get nextSibling() { const list = this.parent?.childNodes || []; return list[list.indexOf(this) + 1] || null; },
    remove() { if (this.parent) { this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 1); this.parent = null; } },
  };
}

test("a thread render puts rows in order, moving only what is out of place", () => {
  const box = {};
  vm.createContext(box);
  vm.runInContext(`${fnSource(app, "reconcileChildren")}\nthis.reconcile = reconcileChildren;`, box);
  const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map(fakeNode);
  const area = fakeContainer([a, b, c, d]);
  let moves = 0;
  const insert = area.insertBefore.bind(area);
  area.insertBefore = (node, ref) => { moves += 1; return insert(node, ref); };
  box.reconcile(area, [a, b, c, d]);
  assert.equal(moves, 0, "nothing changed, nothing touched");
  box.reconcile(area, [a, c, d, e]);
  assert.deepEqual(area.childNodes.map((n) => n.name), ["a", "c", "d", "e"]);
  assert.equal(moves, 1, "only the new row went in");
  assert.equal(b.parent, null, "the dropped row is gone");
  box.reconcile(area, [e, a, c, d]);
  assert.deepEqual(area.childNodes.map((n) => n.name), ["e", "a", "c", "d"]);
});

test("a kept row is one whose message fields are all the same", () => {
  const box = {};
  vm.createContext(box);
  vm.runInContext(`${fnSource(app, "threadRowFields")}\n${fnSource(app, "sameThreadRowFields")}\nthis.api = { threadRowFields, sameThreadRowFields };`, box);
  const message = { id: "m1", text: "hi", status: "pending", edit: null };
  const fields = box.api.threadRowFields(message);
  assert.equal(box.api.sameThreadRowFields(fields, { ...message }), true, "a copy of the same message");
  message.status = "confirmed";
  assert.equal(box.api.sameThreadRowFields(fields, message), false, "a status change redraws");
  assert.equal(box.api.sameThreadRowFields(fields, { id: "m1", text: "hi", status: "pending", edit: { text: "hey" } }), false, "an edit redraws");
  assert.equal(box.api.sameThreadRowFields(fields, { id: "m1", text: "hi", status: "pending", edit: null, txid: "t" }), false, "a new field redraws");
});

test("both threads reuse rows, and never one that reads more than its own message", () => {
  const render = fnSource(app, "renderMessages");
  assert.doesNotMatch(render, /messageArea\.innerHTML = ""/);
  assert.match(render, /reconcileChildren\(messageArea, nodes\);/);
  assert.match(render, /if \(!chessEnv && !retryable && !row\.querySelector\("\.composer-field-spinner, \.voice-player\.loading, \.payment-resolving"\)\)/);
  assert.match(render, /cachedRow\.linkVersion === null \|\| cachedRow\.linkVersion === linkPreviewStateVersion/);
  assert.match(render, /threadRowCache\.entry !== conversationEntry \|\| threadRowCache\.context !== rowContext/);
  const group = fnSource(app, "renderGroupMessages");
  assert.doesNotMatch(group, /groupMessageArea\.innerHTML = ""/);
  assert.match(group, /reconcileChildren\(groupMessageArea, nodes\);/);
  assert.match(group, /if \(!failedOwn && !row\.querySelector/);
  // a preview landing or a tap-to-load approval redraws the rows that drew a link
  assert.equal((app.match(/linkPreviewStateVersion \+= 1;/g) || []).length, 3);
});

test("the KaPost feed redraws only the posts whose HTML changed", () => {
  const render = fnSource(kaposts, "renderFeed");
  assert.match(render, /if \(!patchFeedCells\(cells\)\) \{/);
  const patch = fnSource(kaposts, "patchFeedCells");
  assert.match(patch, /feedCellHtml\.get\(node\) !== html/);
  assert.match(patch, /if \(ids\.size !== cells\.length\) return false;/, "a post twice: written out in full");
  assert.match(patch, /else if \(!child\.matches\("\.kaposts-new-pill-holder, \[data-kaposts-sentinel\]"\)\) return false;/, "anything else on screen: written out in full");
  assert.doesNotMatch(fnSource(kaposts, "appendFeedRows"), /insertAdjacentHTML/);
});

test("link preview images come through the relay", () => {
  const load = fnSource(app, "loadPreviewImage");
  assert.equal((load.match(/img\.src = imageUrl;/g) || []).length, 1);
  assert.ok(load.indexOf("img.src = imageUrl;") > load.indexOf("isProxyAvailable()"), "only when there is no relay");
  assert.doesNotMatch(app, /PROXIED_IMAGE_HOST_RE/);
});

test("the dev server stays on this machine; no unused SSL plugin", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts.dev, "bash tools/check-wasm.sh && vite");
  assert.match(pkg.scripts["dev:lan"], /--host 0\.0\.0\.0/);
  assert.equal(pkg.dependencies["@vitejs/plugin-basic-ssl"], undefined);
  assert.match(read("Dockerfile"), /npm run preview -- --host 0\.0\.0\.0/, "the Docker image still serves its network");
});

test("scroll-blocking gesture listeners only on a phone; no live blur on more scrolling cards", () => {
  for (const [file, mq, fn] of [["edge-back.js", "phone", "onEdgeTouchMove"], ["sheets.js", "phoneSheets", "onSheetTouchMove"]]) {
    const source = read("ui", file);
    assert.doesNotMatch(source, /document\.addEventListener\("touchmove", \(event\)/);
    assert.match(source, new RegExp(`if \\(${mq}\\.matches\\) document\\.addEventListener\\("touchmove", ${fn}, \\{ passive: false \\}\\);`));
    assert.match(source, new RegExp(`${mq}\\.addEventListener\\?\\.\\("change"`));
  }
  const css = read("ui", "styles.css");
  const rule = css.slice(css.indexOf("/* Smooth scrolling: no live blur"), css.indexOf("backdrop-filter: none;", css.indexOf("/* Smooth scrolling: no live blur")));
  for (const selector of [".profile-card", ".portfolio-hashrate-card", ".action-tile"]) assert.ok(rule.includes(`${selector}`), selector);
});

test("group messages are saved every 1.5 s at most, and at once when the app is hidden", () => {
  assert.match(app, /const GROUP_MSG_SAVE_DELAY_MS = 1500;/);
  assert.match(fnSource(app, "saveGroupMsgAll"), /setTimeout\(flushGroupMsgAll, GROUP_MSG_SAVE_DELAY_MS\)/);
  assert.match(app, /document\.visibilityState === "hidden"\) flushPendingGroupMsgAll\(\);/);
});

console.log(`${passed}/8 passed`);
