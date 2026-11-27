// Public Chats under Chats on a computer's dock (owner, 2026-11-26): the pill beside the Chats
// title is hard to catch on a computer, so the left dock has a Public Chats item that opens Chats on
// its Public Chats page, and Chats opens the Private Chats page. A phone or narrow window keeps the
// pill and has no such item (ui/dock-arrangement.js WIDE_ONLY_TABS).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (...p) => readFileSync(new URL(`../${p.join("/")}`, import.meta.url), "utf8");
const app = read("ui", "app.js");
const html = read("index.html");
const css = read("ui", "styles.css");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

test("the dock item, its click, and the lit item follow the page", () => {
  assert.match(html, /data-app-tab="public-chats" hidden>[\s\S]*?<span>Public Chats<\/span>/);
  assert.match(app, /const tab = item === "public-chats" \? "chats" : item;/);
  assert.match(app, /const page = item === "public-chats" \? "publicChats" : \(item === "chats" && WIDE_DOCK_QUERY\.matches \? "chats" : null\);/);
  assert.match(app, /setActiveAppTab\(tab\);\n\s*if \(page\) setChatListPage\(page\);/);
  assert.match(app, /const onPublic = onChats && !publicItem\.hidden && chatListPage === "publicChats";/);
  assert.match(app, /currentAppTab = tab;\n\s*syncChatsDockItems\(\);/);
});

test("on a computer the title names the page, the pill is gone and the rooms' count is on the item", () => {
  assert.match(app, /const titleText = wide && chatListPage === "publicChats" \? "Public Chats" : "Chats";/);
  assert.match(css, /@media \(min-width: 860px\) \{\n  \.chats-page-cycle-wrap \{ display: none; \}\n\}/);
  assert.match(app, /const dockItem = document\.querySelector\('\.sidebar-tab\[data-app-tab="public-chats"\]'\);\n\s*if \(dockItem\) \{\n\s*const count = publicRoomUnreadCount\(\);/);
});

console.log(`public chats dock item: ${passed} passed`);
