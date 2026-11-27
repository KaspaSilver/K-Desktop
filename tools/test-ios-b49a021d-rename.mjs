// node tools/test-ios-b49a021d-rename.mjs - K b49a021d: Rename on an address card is in place, never a
// pop-up. The name becomes a field, the quantum tag steps aside, Rename reads Done, each keystroke is
// saved, empty goes back to "Address #n", and Enter, Escape, Done or a click elsewhere ends it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const app = read("ui/app.js");
const kusdt = read("ui/kusdt-screens.js");
const inline = read("ui/inline-rename.js");
const css = read("ui/styles.css");

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }

test("the field takes the name's place, saves each keystroke and ends on Enter, Escape or blur", () => {
  assert.match(inline, /nameEl\.hidden = true;\n\s+nameEl\.after\(input\);\n\s+card\.classList\.add\("renaming"\);/);
  assert.match(inline, /button\.innerHTML = `<span class="address-card-action-circle">\$\{CHECK_ICON\}<\/span><span>Done<\/span>`;/);
  assert.match(inline, /const onInput = \(\) => \{ try \{ onChange\?\.\(input\.value\); \}/);
  assert.match(inline, /if \(event\.key === "Enter" \|\| event\.key === "Escape"\) \{ event\.preventDefault\(\); input\.blur\(\); \}/);
  assert.match(inline, /input\.addEventListener\("blur", session\.finish\);/);
  assert.match(inline, /input\.addEventListener\("click", stop\);/, "typing never opens the history");
  assert.match(inline, /if \(inlineRenameJustEnded\(key\)\) return;/, "the click on Done doesn't start another");
  assert.match(css, /\.address-card\.renaming \.quantum-tag \{ display: none; \}/);
});
test("Manage Addresses: in place, no prompt; an empty name is Address #n again", () => {
  assert.match(app, /data-spending-card-action="rename" data-index="\$\{index\}" data-rename-button/);
  assert.match(app, /startInlineRename\(card, \{\n\s+key: `spending:\$\{index\}`,\n\s+current: spendingCustomLabel\(state, index\),\n\s+placeholder: spendingIndexTitle\(index\),\n\s+onChange: \(text\) => saveSpendingLabel\(index, text\),\n\s+onDone: \(\) => renderSpendingList\(\),/);
  assert.doesNotMatch(app, /title: "Rename Address", label: "Label"/);
  assert.match(app, /if \(trimmed\) labels\[index\] = trimmed; else \{ delete labels\[index\]; delete labels\[String\(index\)\]; \}/);
  assert.match(app, /async function renderSpendingList\(\) \{\n\s+if \(!spendingListEl\) return;\n[^\n]*\n\s+if \(inlineRenameActive\(\)\) return;/);
});
test("Manage kUSDT: the same, under the address's Kaspa name", () => {
  assert.match(kusdt, /\$\{b\.id === "rename" \? " data-rename-button" : ""\}/);
  assert.match(kusdt, /key: `kusdt:\$\{id\}`,\n\s+current: deps\.customLabel\?\.\(index\) \|\| "",\n\s+placeholder: `Address #\$\{addressNumber\(index\)\}`,/);
  assert.doesNotMatch(kusdt, /promptDialog/);
  assert.match(kusdt, /function renderManage\(\) \{\n\s+if \(!manageEl \|\| manageEl\.hidden\) return;\n[^\n]*\n\s+if \(inlineRenameActive\(\)\) return;/);
});
console.log(`ios b49a021d rename: ${passed} passed`);
