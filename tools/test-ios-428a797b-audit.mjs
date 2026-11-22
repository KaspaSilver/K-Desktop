// K 428a797b's audit fixes that apply on Desktop (AUDIT_2026-11-21.md there; Build 321): room reply
// quotes from the quoted message, blocked reactors off the pills, bidi controls out of rows and
// notifications, room indexer answers checked, capped author lookups, linear KaPost markdown,
// quote cards from a prefix, sane numbers, translation without cookies, .kachat pictures only for
// people you know, and a .kachat claim that never goes out for another account.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderKaPostsMarkdown, MAX_LINK_LABEL_LENGTH } from "../ui/kaposts-markdown.js";
import { kapostsDefaultTipSompi } from "../ui/kaposts-format.js";
import { wellFormedBroadcastRows } from "../engine/broadcasts.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const rooms = read("ui/broadcasts.js");
const engineRooms = read("engine/broadcasts.js");
const kaposts = read("ui/kaposts.js");
const live = read("ui/kachat-names-live.js");
const app = read("ui/app.js");
const actions = read("engine/kachat-names/actions.js");
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

await test("a room reply's quote comes from the quoted message, or names nobody (#18)", () => {
  const start = rooms.indexOf("function replyQuoteDisplay(");
  const body = rooms.slice(start, rooms.indexOf("\n}\n", start) + 2);
  const messageCache = { kaspa: [{ txId: "t1", senderAddress: "kaspa:alice", content: "the real words" }] };
  const fn = new Function("messageCache", "effectiveContent", "humanizeBroadcastContent", "senderName", "stripBidiControls",
    `${body} return replyQuoteDisplay;`)(
    messageCache, (_c, m) => m.content, (t) => t, (a) => (a === "kaspa:alice" ? "Alice" : a), (t) => String(t).replace(/[‪-‮⁦-⁩]/g, ""));
  assert.deepEqual(fn("kaspa", { replyToId: "t1", replyToSender: "kaspa:famous", replyToPreview: "Send 100 KAS to me" }), { sender: "Alice", preview: "the real words" });
  assert.deepEqual(fn("kaspa", { replyToId: "gone", replyToSender: "kaspa:famous", replyToPreview: "claimed‮text" }), { sender: null, preview: "claimedtext" });
  assert.match(rooms, /label\.textContent = shown\.sender \?\? "Original message not loaded";/);
  assert.doesNotMatch(rooms, /senderName\(replyEnvelope\.replyToSender\)/);
});

await test("blocked or hidden reactors don't show on pills; bidi controls out of rows and notifications (#22)", () => {
  assert.match(rooms, /const hidden = hiddenIn\(channel\);\n\s*for \(const reactor of Object\.keys\(merged\)\) if \(hidden\.has\(reactor\)\) delete merged\[reactor\];/);
  assert.match(rooms, /return stripBidiControls\(`\$\{last\.senderAddress === me/);
  assert.match(rooms, /body: stripBidiControls\(humanizeBroadcastContent\(row\.content\)\)\.slice\(0, 90\),/);
});

await test("room indexer rows are checked before anything reads them (#19)", () => {
  const good = { txId: "a".repeat(64), senderAddress: "kaspa:qzk2jrk7wq3zdw2n0260v87fglky82cg5u3pwy73wpktk3u864yecm5djll40", content: "hi", blockTime: 1_700_000_000_000, channel: "kaspa" };
  const now = 1_700_000_100_000;
  const rows = [good, { ...good, txId: "xyz" }, { ...good, senderAddress: "kaspa:nope" }, { ...good, content: "" },
    { ...good, content: "x".repeat(200_001) }, { ...good, blockTime: 0 }, { ...good, blockTime: now + 2 * 86_400_000 },
    { ...good, channel: "other" }, null, { ...good, channel: undefined }];
  const kept = wellFormedBroadcastRows(rows, "kaspa", now);
  assert.equal(kept.length, 2, "the good row, and the same without a channel");
  assert.match(engineRooms, /const messages = wellFormedBroadcastRows\(json\?\.messages, channel\);/);
  assert.match(engineRooms, /if \(body\.length > MAX_INDEXER_RESPONSE_CHARS\) throw/);
});

await test("live author lookups: four at once, 64 waiting at most (#23)", async () => {
  assert.match(engineRooms, /if \(this\.inflight\.size >= MAX_PENDING_AUTHOR_LOOKUPS\) return Promise\.resolve\(\{ verdict: BROADCAST_SENDER\.UNKNOWN/);
  const start = engineRooms.indexOf("  async withLookupSlot(task) {");
  const method = engineRooms.slice(start, engineRooms.indexOf("\n  }\n", start) + 4);
  const Slots = new Function(`const MAX_CONCURRENT_AUTHOR_LOOKUPS = 4; return class { ${method} };`)();
  const slots = new Slots();
  let running = 0, peak = 0;
  const releases = [];
  const task = () => new Promise((resolve) => { running += 1; peak = Math.max(peak, running); releases.push(() => { running -= 1; resolve(); }); });
  const all = Array.from({ length: 10 }, () => slots.withLookupSlot(task));
  for (let i = 0; i < 10; i += 1) { await new Promise((r) => setTimeout(r, 0)); releases.shift()?.(); }
  while (releases.length) { await new Promise((r) => setTimeout(r, 0)); releases.shift()?.(); }
  await Promise.all(all);
  assert.equal(peak, 4);
});

await test("KaPost markdown: a post full of [ or ** parses in linear time, links bounded (#15)", () => {
  for (const text of ["[".repeat(30000), "**a*".repeat(8000), "[x](".repeat(8000)]) {
    const t = Date.now();
    renderKaPostsMarkdown(text);
    assert.ok(Date.now() - t < 1000, `${text.slice(0, 6)}… took ${Date.now() - t} ms`);
  }
  const long = `[${"a".repeat(MAX_LINK_LABEL_LENGTH + 1)}](https://x.y)`;
  assert.equal(renderKaPostsMarkdown(long).spans.some((s) => s.style.link), false, "a label past 500 is text");
  assert.equal(renderKaPostsMarkdown("[ok](https://x.y)").spans[0].style.link, "https://x.y");
  assert.match(kaposts, /const QUOTE_PREVIEW_CHARS = 1200;/);
});

await test("numbers from a server or a setting stay sane (#10, #20)", () => {
  assert.equal(kapostsDefaultTipSompi({ fiat: 100000 }, 1e-9), null, "a huge currency tip is no tip");
  assert.equal(kapostsDefaultTipSompi({ fiat: 1 }, 0.1), 1_000_000_000);
  assert.equal(kapostsDefaultTipSompi({ sompi: 1e30 }, 1), null);
  assert.match(kaposts, /const share = total > 0 \? Math\.min\(1, count \/ total\) : 0;/);
  assert.match(read("engine/kachat-names/registry.js"), /const years = \(e\.years \?\? 0n\) > 1000n \? 1000n : \(e\.years \?\? 0n\);/);
});

await test("translation sends no cookies, cache or referrer (#24)", () => {
  assert.match(kaposts, /const TRANSLATE_FETCH = Object\.freeze\(\{ credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" \}\);/);
  assert.equal((kaposts.match(/\.\.\.TRANSLATE_FETCH/g) || []).length, 3);
});

await test(".kachat pictures are looked up only for you, your chats, your Address Book and opened profiles (#17)", () => {
  assert.match(live, /if \(!link \|\| !mayLookUpSocial\(address\)\) return null;/);
  assert.match(live, /if \(!mayLookUpSocial\(address\)\) return pieces;/);
  assert.match(app, /setKachatSocialLookupGate\(\(address\) => \{/);
  assert.match(app, /return Boolean\(addressBookEntry\(address\)\);/);
  assert.match(kaposts, /async function openPosterProfile\(address, passedPubkey\) \{\n\s*\/\/[^\n]*\n\s*try \{ kachatProfileOpened\(address\); \}/);
  assert.match(app, /kachatProfileOpened\(address\);/);
});

await test("a .kachat claim never goes out for an account that is no longer open (#13)", () => {
  assert.equal((actions.match(/if \(this\.myAddress !== walletAddress\) throw ActionError\.accountChanged\(\);/g) || []).length, 2);
  assert.match(actions, /if \(lapsed && this\.myAddress === walletAddress\) \{/);
  assert.match(actions, /if \(this\.myAddress === walletAddress\) this\._startDriver\(\);/);
});

console.log(`ios 428a797b audit: ${passed} passed`);
