// The left dock and the phone bar (owner, 2026-11-12, Build 281): ui/dock-arrangement.js.
import assert from "node:assert/strict";
import { RAIL_ORDER, PHONE_BAR, WIDE_ONLY_TABS, dockLayoutFor } from "../ui/dock-arrangement.js";

// On a computer every screen is in the dock, once, and More is not.
const wide = dockLayoutFor(true);
assert.deepEqual(wide.dock, RAIL_ORDER);
assert.deepEqual(wide.hub, []);
assert.equal(new Set(wide.dock).size, wide.dock.length, "no screen twice");
assert.ok(!wide.dock.includes("hub"), "no More on a computer");
assert.ok(!wide.dock.includes("kachat-bots"), "no Bots screen: the bots live in Chats");
// Profile and Settings sit at the bottom.
assert.deepEqual(wide.dock.slice(-2), ["profile", "settings"]);

// On a phone: five in the bar, the last More, and every other screen under More.
const narrow = dockLayoutFor(false);
assert.deepEqual(narrow.dock, PHONE_BAR);
assert.equal(narrow.dock.length, 5);
assert.equal(narrow.dock.at(-1), "hub");
for (const tab of RAIL_ORDER) {
  if (WIDE_ONLY_TABS.includes(tab)) continue;
  assert.ok(narrow.dock.includes(tab) !== narrow.hub.includes(tab), `${tab} is in exactly one place`);
}

// Public Chats sits under Chats on a computer only (owner, 2026-11-26): a phone keeps the pill.
assert.deepEqual([...WIDE_ONLY_TABS], ["public-chats"]);
assert.equal(wide.dock.indexOf("public-chats"), wide.dock.indexOf("chats") + 1);
assert.ok(!narrow.dock.includes("public-chats") && !narrow.hub.includes("public-chats"));

// A fresh copy each time: changing one never changes the next.
wide.dock.push("x");
assert.ok(!dockLayoutFor(true).dock.includes("x"));

console.log("dock arrangement: all passed");
