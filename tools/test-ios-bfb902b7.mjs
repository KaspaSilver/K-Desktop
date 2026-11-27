// K bfb902b7 (owner, 2026-11-26/27): Kaspa Hub is a glass menu that remembers your section (on
// Desktop: More, on a phone or narrow window); K Explorer is the default explorer and every View in
// Explorer link opens the app's own Explorer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const app = read("ui/app.js");
const html = read("index.html");
const explorer = read("ui/explorer.js");
let passed = 0;
const test = (name, f) => { try { f(); passed += 1; console.log(`ok - ${name}`); } catch (e) { console.error(`not ok - ${name}`); throw e; } };
const fn = (name) => { const i = app.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return app.slice(i, app.indexOf("\n}\n", i)); };

test("More is a menu: the last section, the menu while in it, the menu with nothing picked", () => {
  assert.match(app, /if \(button\.dataset\.appTab === "hub"\) \{ hubButtonTapped\(\); return; \}/);
  const tapped = fn("hubButtonTapped");
  assert.match(tapped, /if \(hubMenuOpen\(\)\) \{ closeHubMenu\(\); return; \}/);
  assert.match(tapped, /if \(currentAppTab === "hub" && hubSection\) \{ openHubMenu\(\); return; \}/);
  assert.match(tapped, /if \(lastHubSection && hubVisibleTabs\(\)\.includes\(lastHubSection\)\) \{ openHubSectionFromMenu\(lastHubSection\); return; \}/);
  assert.match(tapped, /openHubMenu\(\);\s*$/);
  assert.match(fn("openHubSectionFromMenu"), /lastHubSection = tab;\n\s*hubSection = tab;\n\s*setActiveAppTab\("hub"\);/);
});

test("K Explorer: first in Settings, the default, everyone moved once; its links open in the app", () => {
  assert.ok(html.indexOf('data-explorer-option="k">K Explorer') < html.indexOf('data-explorer-option="kaspaStream"'));
  assert.match(app, /const DEFAULT_KASPA_EXPLORER = "k";/);
  assert.match(app, /if \(!accountShellPrefs\.kExplorerDefaultMigrated\) \{\n\s*try \{\n\s*accountShellPrefs\.explorer = "k";/);
  assert.match(fn("explorerTxUrl"), /if \(currentExplorer\(\)\.internal\) return internalExplorerUrl\("tx", txid\);/);
  assert.match(fn("explorerAddressUrl"), /if \(currentExplorer\(\)\.internal\) return internalExplorerUrl\("address", address\);/);
  assert.match(app, /window\.open = \(url, \.\.\.rest\) => \(openInternalExplorerUrl\(url\) \? null : nativeOpen\(url, \.\.\.rest\)\);/);
  assert.match(fn("openInternalExplorerUrl"), /setActiveAppTab\("explorer"\);\n\s*try \{ openExplorerRoute\(route\); \}/);
  assert.match(explorer, /export function openExplorerRoute\(route\)/);
  // only this page's own tx / address links count
  const route = fn("internalExplorerRoute");
  assert.match(route, /if \(parsed\.origin !== window\.location\.origin\) return null;/);
  assert.match(route, /\/\^#explorer\\\/\(tx\|address\)\\\/\(\[\^\/\]\+\)\$\//);
});

console.log(`ios bfb902b7: ${passed} passed`);
