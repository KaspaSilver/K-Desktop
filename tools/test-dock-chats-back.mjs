// KaChat on the dock, tapped again while a chat, a group or a public room covers the chats list
// (the phone layout), goes back to the list, exactly as that screen's back arrow does. On a wide
// window the list sits beside the open chat, which stays open.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

const start = app.indexOf("function backToChatsListFromDock() {");
const body = app.slice(start, app.indexOf("\n}\n", start) + 2);

function run({ wide = false, group = null, room = false, chat = null } = {}) {
  const calls = [];
  const fn = new Function("ctx", `
    let { isWideLayout, activeGroupId, publicRoomOpen, activeConversationId } = ctx.state;
    const closeGroupChat = () => ctx.calls.push("closeGroupChat");
    const closeBroadcastRoom = () => ctx.calls.push("closeBroadcastRoom");
    const setActiveConversationId = (id) => ctx.calls.push(\`setActiveConversationId(\${id})\`);
    const renderChats = () => ctx.calls.push("renderChats");
    ${body}
    return backToChatsListFromDock();
  `);
  const result = fn({ calls, state: { isWideLayout: wide, activeGroupId: group, publicRoomOpen: room, activeConversationId: chat } });
  return { result, calls };
}

test("the dock click remembers Chats was already up and goes back after the switch", () => {
  assert.ok(start > 0, "backToChatsListFromDock exists");
  assert.match(app, /const wasOnChats = tab === "chats" && currentAppTab === "chats";\n\s*setActiveAppTab\(tab\);\n\s*if \(page\) setChatListPage\(page\);\n\s*applyDockLayout\(\);\n(?:\s*\/\/[^\n]*\n)+\s*if \(wasOnChats && !backToChatsListFromDock\(\) && !WIDE_DOCK_QUERY\.matches\) \{\n\s*if \(chatSelectionModeActive\) setChatSelectionMode\(false\);\n\s*setChatListPage\(chatListPage === "chats" \? "publicChats" : "chats"\);/);
});

test("a 1:1 chat closes as its back arrow closes it", () => {
  assert.deepEqual(run({ chat: "c1" }), { result: true, calls: ["setActiveConversationId(null)", "renderChats"] });
  assert.match(app, /\[data-back-to-chats\]"\)\.addEventListener\("click", \(\) => \{\n\s*setActiveConversationId\(null\);\n\s*if \(!isWideLayout\) renderChats\(\);/);
});

test("a group and a public room close through their own close", () => {
  assert.deepEqual(run({ group: "g1", chat: "g1" }), { result: true, calls: ["closeGroupChat"] });
  assert.deepEqual(run({ room: true }), { result: true, calls: ["closeBroadcastRoom"] });
  assert.match(app, /\[data-group-chat-back\]"\)\?\.addEventListener\("click", closeGroupChat\)/);
});

test("nothing open, or a wide window, changes nothing", () => {
  assert.deepEqual(run({}), { result: false, calls: [] });
  assert.deepEqual(run({ wide: true, chat: "c1" }), { result: false, calls: [] });
  assert.deepEqual(run({ wide: true, group: "g1" }), { result: false, calls: [] });
});

console.log(`dock chats back: ${passed} passed`);
