// node tools/test-k-mentions.mjs - K bdf29425 / 157790b0 on Desktop: @mentions by .kachat username
// (who can be mentioned, the group wire format, the suggestion order for KaPost and rooms), the
// group action sheets' steps (and the engine's report hook that feeds them), membership lines named
// at display time, the web push rules (a raw group push held back while the app is in front, a
// room mention push past the bell), and the header chips' look.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
}
globalThis.localStorage = new MemoryStorage();

const M = await import("../ui/username-mentions.js");
const S = await import("../ui/group-action-sheets.js");
const G = await import("../engine/group.js");
const { GroupManager } = await import("../engine/group-store.js");

const root = new URL("..", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.error(`not ok - ${name}\n${error?.stack || error}`); }
}

const A = (tag) => `kaspa:qq${tag.padEnd(59, tag[0])}`;
const ME = A("me");
const ALICE = A("alice");
const ALICE2 = A("bob");
const CAROL = A("carol");
const DAVE = A("dave");
const NONAME = A("xnoname");
const labels = new Map([[ME, "me"], [ALICE, "alice"], [ALICE2, "alice2"], [CAROL, "carol"], [DAVE, "dave"]]);
const labelOf = (address) => labels.get(address) ?? null;

await test("who can be mentioned: only a valid .kachat username", () => {
  assert.equal(M.MENTIONS_ENABLED, true);
  assert.equal(M.mentionName("alice"), "alice");
  assert.equal(M.mentionName("Alice.KaChat"), "alice");
  for (const bad of [null, "", "-alice", "alice-", "al ice", "a".repeat(33), "alice.kas", "émile"]) {
    assert.equal(M.mentionName(bad), null, String(bad));
  }
  // a group's members: those with a username, by name, never you, filtered by what's typed
  const members = [{ address: ME }, { address: CAROL }, { address: NONAME }, { address: ALICE2 }, { address: ALICE }];
  assert.deepEqual(M.groupMentionCandidates({ query: "", members, me: ME, labelOf }).map((c) => c.name), ["alice", "alice2", "carol"]);
  assert.deepEqual(M.groupMentionCandidates({ query: "AL", members, me: ME, labelOf }).map((c) => c.address), [ALICE, ALICE2]);
  assert.deepEqual(M.groupMentionCandidates({ query: "z", members, me: ME, labelOf }), []);
});

await test("tokens: @name or @name.kachat after a start, space or opening bracket; never an email", () => {
  const text = "hi @alice, (@Bob.kachat) x@carol @-nope \"@dave\" @alice.kas @e";
  assert.deepEqual(M.mentionTokens(text).map((t) => [t.name, text.slice(t.start, t.end)]), [
    ["alice", "@alice"], ["bob", "@Bob.kachat"], ["dave", "@dave"], ["alice", "@alice"], ["e", "@e"],
  ]);
  assert.deepEqual(M.mentionTokens("no at sign"), []);
  assert.equal(M.textMentionsName("thanks @Carol.kachat!", "carol"), true);
  assert.equal(M.textMentionsName("mail me at x@carol", "carol"), false);
  assert.equal(M.textMentionsName("@carol", null), false);
  // what's being typed at the caret
  assert.equal(M.typedMentionQuery("hey @"), "");
  assert.equal(M.typedMentionQuery("hey @Al"), "al");
  assert.equal(M.typedMentionQuery("hey (@al-b"), "al-b");
  assert.equal(M.typedMentionQuery("x@al"), null);
  assert.equal(M.typedMentionQuery("hey @al b"), null);
  assert.equal(M.typedMentionQuery("no mention"), null);
  // a pick writes the name with its ending (anything sent keeps it), replacing the typed token
  assert.equal(M.mentionInsertText("alice"), "@alice.kachat ");
  assert.equal(M.replaceTypedMention("hey @al", M.mentionInsertText("alice")), "hey @alice.kachat ");
});

await test("group wire format: @name in, @<address> on the wire, the name shown", () => {
  const members = [{ address: ALICE, name: "alice" }, { address: ALICE2, name: "alice2" }, { address: NONAME, name: null }];
  const typed = "hey @alice.kachat and @Alice2, not @alicex or x@alice; (@alice)";
  const wire = M.encodeGroupMentionText(typed, members);
  assert.equal(wire, `hey @${ALICE} and @${ALICE2}, not @alicex or x@alice; (@${ALICE})`);
  const names = new Map([[ALICE, "Alice Smith"], [ALICE2, "alice2"]]);
  assert.equal(M.decodeGroupMentionText(wire, (a) => names.get(a)), "hey @Alice Smith and @alice2, not @alicex or x@alice; (@Alice Smith)");
  // the older brace-wrapped desktop form still reads
  assert.equal(M.decodeGroupMentionText(`hi @{${ALICE}}`, (a) => names.get(a)), "hi @Alice Smith");
  // nothing to encode: unchanged
  assert.equal(M.encodeGroupMentionText("plain text", members), "plain text");
});

await test("KaPost's @ suggests follows, then recent posters, then contacts, plus a looked-up name first", () => {
  M.resetKaPostPosters();
  M.noteKaPostPoster(DAVE);
  M.noteKaPostPoster(NONAME);
  M.noteKaPostPoster(ALICE2);
  M.noteKaPostPoster(DAVE); // seen again: newest
  assert.deepEqual(M.recentKaPostPosters(), [DAVE, ALICE2, NONAME].map((a) => a.toLowerCase()));
  const base = { me: ME, following: [CAROL, ME], recentPosters: M.recentKaPostPosters(), contacts: [ALICE, CAROL, NONAME], labelOf };
  assert.deepEqual(M.kaPostMentionCandidates({ ...base, query: "" }).map((c) => c.name), ["carol", "dave", "alice2", "alice"]);
  assert.deepEqual(M.kaPostMentionCandidates({ ...base, query: "al" }).map((c) => c.name), ["alice2", "alice"]);
  const looked = M.kaPostMentionCandidates({ ...base, query: "zo", lookedUp: { address: A("zoe"), name: "zoe.kachat" } });
  assert.deepEqual(looked.map((c) => c.name), ["zoe"]);
  // a looked-up name already in the list isn't doubled
  assert.equal(M.kaPostMentionCandidates({ ...base, query: "car", lookedUp: { address: CAROL, name: "carol" } }).length, 1);
  M.resetKaPostPosters();
  assert.deepEqual(M.recentKaPostPosters(), []);
});

await test("a room's @ suggests a looked-up name, everyone who wrote there (newest first), then contacts", () => {
  const senders = [DAVE, ME, ALICE2, DAVE, NONAME]; // newest first
  const base = { me: ME, senders, contacts: [CAROL, ALICE, ALICE2], labelOf };
  assert.deepEqual(M.roomMentionCandidates({ ...base, query: "" }).map((c) => c.name), ["dave", "alice2", "carol", "alice"]);
  assert.deepEqual(M.roomMentionCandidates({ ...base, query: "ALI" }).map((c) => c.name), ["alice2", "alice"]);
  assert.deepEqual(M.roomMentionCandidates({ ...base, query: "", lookedUp: { address: A("zoe"), name: "zoe" } }).map((c) => c.name)[0], "zoe");
  // at most 50
  const many = Array.from({ length: 80 }, (_, i) => A(`n${String(i).padStart(2, "0")}`));
  const named = (address) => `n${many.indexOf(address)}`;
  assert.equal(M.roomMentionCandidates({ me: ME, senders: many, contacts: [], labelOf: named, query: "" }).length, 50);
});

await test("the suggestion list shows five rows before it scrolls, and follows the names registry", () => {
  const src = read("ui/username-mentions.js");
  assert.match(src, /const ROW_LIMIT_VISIBLE = 5;/);
  assert.match(src, /subscribe\?\.\(\(\) => \{ if \(query != null\) draw\(\); \}\)/);
  const css = read("ui/styles.css");
  assert.match(css, /\.mention-suggest \{[^}]*max-height: calc\(var\(--mention-row-h\) \* var\(--mention-visible-rows, 5\)\)/);
  // all three composers use it, and KaPost's mentions are back on
  const kaposts = read("ui/kaposts.js");
  assert.doesNotMatch(kaposts, /const MENTIONS_ENABLED = false/);
  assert.match(kaposts, /kaPostMentionCandidates\(/);
  assert.match(kaposts, /noteKaPostPoster\(address\)/);
  const rooms = read("ui/broadcasts.js");
  assert.match(rooms, /roomMentionCandidates\(/);
  assert.match(rooms, /el\.classList\.add\("mentions-me"\)/);
  const app = read("ui/app.js");
  assert.match(app, /const GROUP_MENTIONS_ENABLED = MENTIONS_ENABLED;/);
  assert.match(app, /encodeGroupMentionText\(out, members\)/);
});

await test("group sheets: creating a group's steps, fed as they happen", () => {
  const nameOf = (a) => (a === ALICE ? "Alice" : "Carol");
  const p = S.groupCreateProgress({ name: " Friends ", members: [ALICE, CAROL], nameOf, withPhoto: true });
  assert.equal(p.headline, 'Creating "Friends"');
  assert.deepEqual(p.steps.map((s) => [s.id, s.title]), [
    ["#setup", "Setting up the group"], [ALICE, "Inviting Alice"], [CAROL, "Inviting Carol"],
    ["#recovery", "Saving a recovery copy"], ["#photo", "Adding the group photo"],
  ]);
  let changes = 0;
  p.onChange(() => { changes += 1; });
  p.apply("#setup", "started");
  assert.equal(p.find("#setup").state, "working");
  p.apply("#setup", "finished");
  p.apply(ALICE.toUpperCase(), "started"); // keys match whatever the case
  p.apply(ALICE, "finished");
  p.apply(CAROL, "failed", new Error("no funds"));
  assert.deepEqual([p.doneCount, p.failedCount, p.settledCount], [2, 1, 3]);
  assert.equal(p.find(CAROL).error, "no funds");
  assert.equal(p.isFinished, false);
  p.finish();
  assert.equal(p.isFinished, true);
  assert.deepEqual(p.steps.map((s) => s.state), ["done", "done", "failed", "failed", "failed"]);
  assert.equal(p.find("#photo").error, "Not sent");
  assert.ok(changes >= 6);
  // adding members: one step per person, the key's transactions counted in the detail
  const add = S.groupAddProgress({ members: [DAVE], nameOf: () => "dave" });
  assert.equal(add.headline, "Adding 1 member");
  assert.deepEqual(add.steps.map((s) => s.title), ["Adding dave"]);
  assert.equal(S.groupAddProgress({ members: [DAVE, CAROL], nameOf: () => "x" }).headline, "Adding 2 members");
  assert.equal(S.groupKeyDetail(3, 10), "Sending the new group key: 3 of 10");
  assert.equal(S.groupKeyDetail(12, 10), "Sending the new group key: 10 of 10");
});

// --- the engine's report hook (a stub engine: nothing is broadcast) ---
const KEY = (n) => n.toString(16).padStart(64, "0");
const W = {
  admin: { address: "kaspa:qzadminbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", key: KEY(0xad) },
  m1: { address: "kaspa:qzmemberoneccccccccccccccccccccccccccccccccccccccccccccccc", key: KEY(0x0c) },
  m2: { address: "kaspa:qzmembertwodddddddddddddddddddddddddddddddddddddddddddddd", key: KEY(0x0d) },
  m3: { address: "kaspa:qzmemberthreeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", key: KEY(0x0e) },
};
const PUB = new Map(Object.values(W).map((w) => [w.address, G.bytesToHex(G.xOnlyPublicKey(w.key))]));
let failSendTo = null;
const engine = {
  address: W.admin.address,
  privateKeyHex: W.admin.key,
  log() {},
  groupIndexerUrl: () => "https://indexer.stub.test",
  async xOnlyPubKeyForAddress(address) { const pub = PUB.get(address); if (!pub) throw new Error("no key"); return pub; },
  async encryptGroupControl(address, json) { return G.bytesToHex(new TextEncoder().encode(JSON.stringify({ to: address, body: json }))); },
  async sendGroupPayload(payload) {
    if (failSendTo && payload.includes(PUB.get(failSendTo))) throw new Error("send failed");
    return { txids: ["tx"] };
  },
  async scanGroupControlByRecipientPage() { return { rows: [], nextCursor: null, rawCount: 0 }; },
  async scanGroupMessagesSince() { const e = new Error("no /since"); e.unsupported = true; throw e; },
  async scanGroupMessages() { return []; },
};

await test("the engine reports every step of creating a group, and of adding a member", async () => {
  localStorage.clear();
  const mgr = new GroupManager(engine);
  const events = [];
  failSendTo = W.m2.address;
  const created = await mgr.createGroup({ name: "Team", memberAddresses: [W.m1.address, W.m2.address], report: (key, phase) => events.push(`${key}:${phase}`) });
  failSendTo = null;
  assert.deepEqual(events, [
    "#setup:started", "#setup:finished",
    `${W.m1.address}:started`, `${W.m1.address}:finished`,
    `${W.m2.address}:started`, `${W.m2.address}:failed`,
    "#recovery:started", "#recovery:finished",
  ]);
  assert.ok(created.inviteWarning, "a failed invite is still a soft warning");
  // the sheet takes those reports as they come
  const p = S.groupCreateProgress({ name: "Team", members: [W.m1.address, W.m2.address], nameOf: () => "x" });
  for (const e of events) { const at = e.lastIndexOf(":"); p.apply(e.slice(0, at), e.slice(at + 1)); }
  p.finish();
  assert.deepEqual(p.steps.map((s) => s.state), ["done", "done", "failed", "done"]);
  // adding: an announcement to each member, the new key to each, and the recovery copy
  const add = [];
  await mgr.addMember(created.groupId, W.m3.address, { report: (key, phase) => add.push(`${key}:${phase}`) });
  const started = add.filter((e) => e.endsWith(":started")).length;
  assert.equal(started, 2 * 3 + 1, "every transaction of the add is reported");
  assert.ok(add.includes(`${W.m3.address}:finished`));
  assert.equal(add.at(-1), "#recovery:finished");
});

await test("membership lines keep the address and are named as they're drawn", () => {
  const nameOf = (a) => (a === ALICE ? "alice" : a === ME ? "You" : "kaspa:qq…");
  assert.equal(M.groupSystemLineDisplay(`${ALICE} joined the group`, nameOf), "alice joined the group");
  assert.equal(M.groupSystemLineDisplay(`${ME} changed the group photo`, nameOf), "You changed the group photo");
  // an older line that stored a name reads as it was
  assert.equal(M.groupSystemLineDisplay("Bob was invited to the group chat", nameOf), "Bob was invited to the group chat");
  const app = read("ui/app.js");
  assert.doesNotMatch(app, /\$\{groupSenderLabel\([^)]*\)\} was (invited|removed)/, "no line freezes a name");
  assert.match(app, /sysRow\.textContent = groupSystemLineText\(message\.text\);/);
  assert.match(app, /if \(last\?\.system\) return groupSystemLineText\(last\.text\)/);
});

await test("web push: a raw group push is held back while the app is in front; a room mention passes the bell", () => {
  const sandbox = { self: {}, globalThis: {}, atob, TextDecoder, Uint8Array, BigInt };
  vm.createContext(sandbox);
  vm.runInContext(read("public/sw-push.js"), sandbox);
  const map = sandbox.self.KaChatPushMap;
  assert.equal(map.holdsBackWhileOpen({ type: "group_message" }), true);
  assert.equal(map.holdsBackWhileOpen({ type: "group_control" }), true);
  assert.equal(map.holdsBackWhileOpen({ type: "contextual" }), false);
  assert.equal(map.holdsBackWhileOpen({ type: "broadcast" }), false);
  const mirror = { account: ME, rooms: ["general"] };
  assert.equal(map.notificationFromPush({ type: "broadcast", channel: "other", body: "hi @me" }, mirror).suppress, true);
  assert.equal(map.notificationFromPush({ type: "broadcast", channel: "other", body: "hi @me", mention: "true" }, mirror).suppress, false);
  const sw = read("public/sw.js");
  assert.match(sw, /heldForApp = !suppress && appInFront && Boolean\(self\.KaChatPushMap\?\.holdsBackWhileOpen\(payload\)\)/);
  assert.match(sw, /if \(!heldForApp\) \{\s*try \{\s*const seenBefore = await self\.KaChatPushMap\.recordPushArrival/);
});

await test("chat header chips: a 60pt photo, a slim pill, press feedback over a wider reach", () => {
  const css = read("ui/styles.css");
  const tail = css.slice(css.lastIndexOf("/* Chat header chips (K bdf29425)"));
  assert.match(tail, /\.conversation-header \.conversation-avatar,\n\.group-chat-header \.group-chat-avatar,\n\.broadcast-room-chip-icon \{ width: 60px; height: 60px; \}/);
  assert.match(tail, /\.conversation-identity h1 \{ margin-top: -5px; padding: 10px 27px 8px 14px; font-weight: 600; \}/);
  assert.match(tail, /\.conversation-identity:active,\n\.broadcast-room-chip:active \{ opacity: \.6; transform: scale\(\.96\); \}/);
  assert.match(tail, /\.conversation-identity::before,\n\.broadcast-room-chip::before \{ content: ""; position: absolute; inset: -6px -40px; \}/);
  assert.match(tail, /\.conversation-header > :not\(\.conversation-identity\) \{ z-index: 2; \}/);
});

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log("all passed");
