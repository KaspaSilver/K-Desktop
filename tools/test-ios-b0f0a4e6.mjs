// K b0f0a4e6 and 800dcb75 on Desktop (Build 322): UTXO Selection in its own card, KaPost tips as
// tips in a chat (card, notification, one push), pushes noted so the open app never banners one
// again, KaPost pushes naming the person, kUSDT's one ping, held payment notices retried on a
// timer, a newer message beating an older reaction, payment memos after a colon, change lines in
// address history, swipe left to hide, Cold Storage without kpub text, and a dark-only app icon.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { feeControlsHtml } from "../ui/send-kaspa-components.js";
import { tipPostIdFromPayloadHex, createTipResolver, tipNeedsLookup } from "../ui/kapost-tip-ledger.js";
import { clampRowSwipe, settleRowSwipe, isFullRowSwipe } from "../ui/row-swipe.js";
import { findReceived, receivedNotification } from "../engine/kusdt-balances.js";
import { normalizeMessage } from "../engine/conversations.js";
import { KaspaEngine } from "../engine/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8");
const app = read("ui", "app.js");
const cold = read("ui", "coldstorage.js");
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
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
const hexOf = (text) => Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("");
const sandbox = { globalThis: null };
sandbox.globalThis = sandbox;
vm.runInNewContext(read("public", "sw-push.js"), sandbox);
const PushMap = sandbox.KaChatPushMap;
const ME = "kaspa:qzk2jrk7wq3zdw2n0260v87fglky82cg5u3pwy73wpktk3u864yecm5djll40";

await test("UTXO Selection is its own card above Network Fee; none where a send can't pick coins", () => {
  const html = feeControlsHtml({ prefix: "x", coinSummary: "2 UTXOs selected" });
  assert.ok(html.indexOf("sk-utxo-card") < html.indexOf("sk-fee\""), "the coins card first");
  assert.match(html, /<span class="sk-utxo-title">UTXO Selection<\/span><span class="sk-utxo-caption">Choose which coins this send spends\.<\/span>/);
  assert.match(html, /data-x-coin-toggle/);
  assert.match(html, /data-x-coin-summary>2 UTXOs selected</);
  assert.doesNotMatch(html, /Coin Control/);
  assert.doesNotMatch(feeControlsHtml({ prefix: "y", showCoinControl: false }), /sk-utxo-card|coin-toggle/);
  assert.match(cold, /step: "coincontrol", title: "UTXO Selection"/);
});

await test("a tip's payload names its post; anything else is no tip", () => {
  const post = "ab".repeat(32);
  const tip = hexOf(`kchat:1:tip:02${"11".repeat(32)}:${"22".repeat(64)}:${post}:02${"33".repeat(32)}:deadbeef`);
  assert.equal(tipPostIdFromPayloadHex(tip), post);
  assert.equal(tipPostIdFromPayloadHex(tip.toUpperCase()), post);
  assert.equal(tipPostIdFromPayloadHex(hexOf(`kchat:1:tip:02${"11".repeat(32)}:sig:${post}:author:`)), null, "no sealed part");
  assert.equal(tipPostIdFromPayloadHex(hexOf(`kchat:1:tip:a:b:short:c:d`)), null);
  assert.equal(tipPostIdFromPayloadHex(hexOf("kchat:1:pay:abc")), null);
  assert.equal(tipPostIdFromPayloadHex(null), null);
});

await test("each payment is read once, two at a time, and the answer kept on the message", async () => {
  const post = "cd".repeat(32);
  const tipTx = { payload: hexOf(`kchat:1:tip:02${"11".repeat(32)}:${"22".repeat(64)}:${post}:02${"33".repeat(32)}:00`) };
  let reads = 0, running = 0, peak = 0;
  const answers = [];
  const resolver = createTipResolver({
    fetchTx: async (txid) => {
      reads += 1; running += 1; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return txid.startsWith("a") ? tipTx : txid.startsWith("b") ? { payload: hexOf("kchat:1:pay:x") } : null;
    },
    onAnswer: (message, patch) => { Object.assign(message, patch); answers.push(patch); },
  });
  const tipMsg = { txid: "a".repeat(64) };
  const payMsg = { txid: "b".repeat(64) };
  const unread = { txid: "c".repeat(64) };
  const others = Array.from({ length: 4 }, (_, i) => ({ txid: `${"b".repeat(63)}${i}` }));
  assert.equal(await resolver.resolveNow(tipMsg), post);
  assert.equal(tipMsg.tipPostId, post);
  assert.equal(tipNeedsLookup(tipMsg), false, "known: never read again");
  assert.equal(await resolver.resolveNow(payMsg), null);
  assert.equal(payMsg.tipChecked, true);
  assert.equal(await resolver.resolveNow(unread), null);
  assert.equal(unread.tipChecked, undefined, "not readable now: nothing stored");
  assert.equal(await resolver.resolveNow(unread), null);
  await Promise.all(others.map((m) => resolver.resolveNow(m)));
  assert.equal(reads, 3 + 4, "the unreadable one only once this session");
  assert.ok(peak <= 2, `at most two at once (${peak})`);
  assert.equal(tipNeedsLookup({ txid: "pending" }), false, "a send with no txid yet");
  const kept = normalizeMessage({ txid: "a".repeat(64), tipPostId: post, text: "Sent 1 KAS" }, "c");
  assert.equal(kept.tipPostId, post, "kept through a reload");
  assert.equal(normalizeMessage({ tipPostId: "nope" }, "c").tipPostId, undefined);
});

await test("the chat: Sent tip / Received tip, the post on click, one notice, the tip sent marked", () => {
  assert.match(app, /return message\?\.tipPostId \? \(outgoing \? "Sent tip" : "Received tip"\) : \(outgoing \? "Sent" : "Received"\);/);
  assert.match(app, /if \(tipPostId\) \{ setActiveAppTab\("kaposts"\); try \{ openKaPostFromNotification\(tipPostId\); \}/);
  assert.match(app, /body: tipPostId \? tipNotificationBody\(message\) : body,/);
  assert.match(app, /return amount \? `Received a tip: \$\{amount\} \$\{KAS_UNIT\}` : "Received a tip";/);
  assert.match(app, /tip\.tip && !tip\.fundingAddress && \/\^\[0-9a-f\]\{64\}\$\/i\.test\(String\(tip\.tip\.postId\)\) \? \{ tipPostId:/);
  assert.match(read("ui", "kaposts.js"), /if \(n\.contentType === "tip"\) continue;/);
  assert.match(app, /if \(poolEnvelope\?\.kind === "tokenNotice"\) body = "Sent you kUSDT";/);
});

await test("the worker turns a KaPost key into the address it pays", () => {
  const key = KaspaEngine.prototype.kapostPubkeyForAddress.call(null, ME);
  assert.equal(PushMap.kaspaAddressFromXOnly(key.slice(2), "kaspa"), ME);
  assert.equal(PushMap.kaspaAddressFromXOnly(key, "kaspa"), ME, "a compressed key too");
  assert.equal(PushMap.kaspaAddressFromXOnly("zz", "kaspa"), null);
});

await test("a KaPost push names the person; a tip push is the tipper's chat notice", () => {
  const key = KaspaEngine.prototype.kapostPubkeyForAddress.call(null, ME).slice(2);
  const mirror = { account: "kaspa:qpme", unit: "KAS", sound: true, kapostsNames: { [key]: "Alice" }, names: {} };
  const like = PushMap.notificationFromPush({ type: "kaposts", actor_pubkey: `02${key}`, subtitle: "kaspa:qzk2…", body: "liked your post", kaposts_kind: "vote_up", tx_id: "t1" }, mirror, {});
  assert.equal(like.title, "KaPost");
  assert.equal(like.options.body, "Alice liked your post");
  const tip = PushMap.notificationFromPush({ type: "kaposts", actor_pubkey: key, body: "tipped your post: 0.2 KAS", kaposts_kind: "tip", tx_id: "e".repeat(64), post_id: "f".repeat(64) }, mirror, {});
  assert.equal(tip.title, "Alice");
  assert.equal(tip.options.body, "Received a tip: 0.2 KAS");
  assert.equal(tip.options.tag, `kachat-chat-${ME}`, "the tipper's chat, as its payment push");
  assert.equal(tip.options.data.key, "e".repeat(64));
  assert.equal(tip.options.data.route.kind, "chatAddress");
  assert.equal(tip.options.data.tip, true);
  const unknown = PushMap.notificationFromPush({ type: "kaposts", actor_pubkey: key, body: "tipped your post", tx_id: "e".repeat(64) }, { account: "kaspa:qpme" }, {});
  assert.equal(unknown.options.body, "Received a tip");
  assert.equal(unknown.title.startsWith("kaspa:"), true, "no name: the short address");
});

await test("every push is noted half an hour by txid; the second of a tip's pushes is quiet", async () => {
  let ledger = {};
  const get = async () => ledger;
  const set = async (_k, value) => { ledger = value; };
  assert.equal(await PushMap.recordPushArrival({ tx_id: "AB" }, get, set, 1000), false);
  assert.equal(ledger.ab, 1000);
  assert.equal(await PushMap.recordPushArrival({ tx_id: "ab" }, get, set, 2000), true, "same txid again");
  assert.equal(await PushMap.recordPushArrival({ tx_id: "ab" }, get, set, 2000 + PushMap.PUSH_ARRIVAL_MS), false, "after the window");
  const many = {};
  for (let i = 0; i < 600; i += 1) many[`k${i}`] = 5000 + i;
  assert.equal(Object.keys(PushMap.noteArrival(many, { tx_id: "new" }, 6000).ledger).length, 500);
  assert.equal(PushMap.isTipPush({ type: "payment" }, { options: { data: {} } }), true);
  assert.equal(PushMap.isTipPush({ type: "contextual" }, { options: { data: {} } }), false);
  const sw = read("public", "sw.js");
  assert.match(sw, /const seenBefore = await self\.KaChatPushMap\.recordPushArrival\(payload, kvGet, kvSet\);/);
  assert.match(sw, /if \(existing && options\.data\?\.tip\) \{ options\.silent = true;/);
  const web = read("ui", "web-push.js");
  assert.match(web, /const at = Number\(arrivals\?\.\[wanted\] \|\| 0\);/);
  assert.match(app, /if \(key && !alreadyUp && await pushArrivedRecently\(key\)\) return false;/);
  assert.match(read("ui", "broadcasts.js"), /key: row\.txId,/);
  assert.match(read("ui", "kaposts.js"), /key: n\.id,/);
  assert.match(app, /kapostsNames,/);
});

await test("kUSDT on the Chatting Address waits up to two minutes for its chat notice; amount only", async () => {
  const seen = new Set(["old:0"]);
  const store = { seenOutpoints: () => seen, rememberSeen: (keys) => { for (const k of keys) seen.add(k); }, ownTxids: () => new Set(), record: () => {} };
  const coin = { transactionId: "f".repeat(64), index: 0, state: { amount: 2_000_000n } };
  const current = [{ holdingId: "chatting", coins: [coin] }];
  let hold = true;
  const args = { store, current, fetchTransactionInputs: async () => [{ hash: "x", index: 0, address: "kaspa:someone" }], ownAddresses: [ME], holdForNotice: () => hold };
  assert.equal((await findReceived(args)).received.length, 0);
  assert.equal(seen.has(`${"f".repeat(64)}:0`), false, "held: still new next time");
  hold = false;
  assert.equal((await findReceived(args)).received.length, 1);
  assert.deepEqual(receivedNotification([{ units: 2_000_000n }], ["Chatting Address"], (u) => `${Number(u) / 1e6} kUSDT`), { title: "Received 2 kUSDT", body: "" });
});

await test("held payment notices are tried every 20 s for 15 minutes, not only on a balance change", () => {
  assert.match(app, /const UNSENT_NOTICE_RETRY_MS = 20_000;/);
  assert.match(app, /const UNSENT_NOTICE_RETRY_FOR_MS = 15 \* 60_000;/);
  assert.match(fnSource(app, "keepUnsentPaymentNotice"), /scheduleUnsentNoticeRetry\(\);/);
  assert.match(fnSource(app, "observeChattingBalanceForNotices"), /if \(readUnsentPaymentNotices\(\)\.length\) scheduleUnsentNoticeRetry\(\);/);
});

await test("a newer message beats an older reaction, on the chain's clock", () => {
  const box = { MESSAGE_STATUSES: { CONFIRMED: "confirmed" } };
  vm.createContext(box);
  vm.runInContext(`${fnSource(app, "reactionIsNewerThanMessage")}\nthis.newer = reactionIsNewerThanMessage;`, box);
  const T = 1_700_000_000_000;
  const reaction = { timestamp: T + 10_000 };
  assert.equal(box.newer(reaction, { blockTime: T + 5_000, createdAt: T + 5_000, status: "confirmed" }), true);
  assert.equal(box.newer(reaction, { blockTime: T + 9_500, createdAt: T + 9_000, status: "confirmed" }), false, "within a second");
  assert.equal(box.newer(reaction, { createdAt: T, direction: "outgoing", status: "pending" }), false, "not in a block yet");
  assert.equal(box.newer(reaction, { blockTime: (T + 9_600) / 1000, createdAt: T, status: "confirmed" }), false, "block time in seconds");
  assert.equal(box.newer(reaction, { createdAt: T + 1_000, direction: "incoming" }), true, "an incoming one by its time");
});

await test("a payment's memo after a colon: Sent 1 KAS: Testing", () => {
  const box = { isPaymentBubble: (m) => m?.messageType === "payment" };
  vm.createContext(box);
  vm.runInContext(`${fnSource(app, "paymentDisplayText")}\nthis.show = paymentDisplayText;`, box);
  assert.equal(box.show({ messageType: "payment", text: "Sent 1 KAS — Testing — more" }), "Sent 1 KAS: Testing — more");
  assert.equal(box.show({ messageType: "payment", text: "Sent 1 KAS" }), "Sent 1 KAS");
  assert.equal(box.show({ text: "a — b" }), "a — b", "not a payment");
  assert.match(fnSource(app, "chatListPreviewText"), /if \(isPaymentBubble\(message\)\) return linkSafe\(paymentDisplayText\(message, unwrapped\)\);/);
});

await test("address history: Sent counts other people, change to your own addresses on its own line, Moved", () => {
  const box = {};
  vm.createContext(box);
  vm.runInContext(`${fnSource(app, "outgoingTxBreakdown")}\nthis.split = outgoingTxBreakdown;`, box);
  const labels = { "kaspa:own2": "Address #2", "kaspa:chat": "Chatting Address" };
  const labelFor = (a) => labels[a] || null;
  const tx = { outputs: [
    { script_public_key_address: "kaspa:friend", amount: "100000000" },
    { script_public_key_address: "kaspa:own2", amount: "899000000" },
    { script_public_key_address: "kaspa:me", amount: "5" },
  ] };
  const sent = box.split(tx, "kaspa:me", labelFor);
  assert.equal(sent.toOthers, 100000000n);
  assert.equal(sent.moved, false);
  assert.equal(sent.change.map((c) => `${c.label}=${c.sompi}`).join(","), "Address #2=899000000");
  const moved = box.split({ outputs: [{ script_public_key_address: "kaspa:chat", amount: "7" }, { script_public_key_address: "kaspa:chat", amount: "3" }] }, "kaspa:me", labelFor);
  assert.equal(moved.moved, true);
  assert.equal(moved.changeTotal, 10n);
  const load = fnSource(app, "loadManageAddressTransactions");
  assert.match(load, /info\.amountSompi = breakdown\.moved \? breakdown\.changeTotal : breakdown\.toOthers;/);
  assert.match(load, /`Change \$\{spendingKasText\(line\.sompi\)\} \$\{KAS_UNIT\} to \$\{line\.label\}`/);
  assert.match(load, /\(breakdown\?\.moved \? "Moved" : "Sent"\)/);
});

await test("Manage Addresses: swipe left to hide, a full swipe hides at once", () => {
  const widths = { leftWidth: 74, rightWidth: 0, rowWidth: 300, fullLeft: true };
  assert.equal(clampRowSwipe(-250, widths), -250, "runs on past its button");
  assert.equal(clampRowSwipe(-400, widths), -300);
  assert.equal(isFullRowSwipe(-200, widths), true);
  assert.equal(settleRowSwipe({ offset: -200, ...widths }), "full-left");
  assert.equal(settleRowSwipe({ offset: -60, ...widths }), "left", "a short swipe shows Hide");
  const chat = { leftWidth: 222, rightWidth: 96, rowWidth: 300 };
  assert.equal(settleRowSwipe({ offset: -290, ...chat }), "left", "a chat row's left swipe still has no full swipe");
  assert.ok(clampRowSwipe(-400, chat) > -300);
  assert.match(app, /rowAttr: "data-spending-row",\n\s*actionsFor: \(\) => \(\{ left: \[\{ id: "hide", title: "Hide", icon: "eyeSlash", tint: "orange" \}\], right: \[\], fullLeft: true \}\),/);
  assert.match(app, /spendingListEl\.querySelector\(`\[data-spending-action="hide"\]\[data-index="\$\{CSS\.escape\(String\(id\)\)\}"\]`\)\?\.click\(\);/);
  assert.equal((app.match(/spendingRowSwipes\?\.refresh\(\);/g) || []).length, 2);
});

await test("Cold Storage: no kpub on screen, Copy kpub in Address Actions, the floating button, Paste reads the clipboard", () => {
  assert.doesNotMatch(cold, /cold-summary-kpub|class="cold-kpub"|truncateMiddle/);
  assert.match(cold, /\$\{row\("copy-kpub", "Copy kpub", "Puts this account's kpub on the clipboard\. It reveals all its addresses\.", COPY_ICON\)\}/);
  assert.match(cold, /class="spending-actions-fab cold-actions-fab" data-cold-actions-toggle aria-label="Address Actions"/);
  assert.match(cold, /payloadEl\.textContent = kpub \? "" : payload;/);
  assert.match(cold, /if \(clip && validateKpub\(clip\)\) \{ beginImport\(clip\); return; \}\n\s*deps\.showToast\?\.\("Not a valid kpub"\);/);
  assert.match(cold, /\$\{balanceCardHtml\(displayLabelFor\(account, entry\.index\), balanceSompi, renderAddressScreen\)\}/);
  assert.doesNotMatch(cold, /spending-detail-balance-label">Balance/);
});

await test("the app icon is dark only", () => {
  for (const name of ["icon-192-dark.png", "icon-512-dark.png", "icon-512-maskable-dark.png", "apple-touch-icon-dark.png"]) {
    assert.equal(existsSync(join(here, "..", "public", "icons", name)), false, name);
  }
  assert.equal(existsSync(join(here, "..", "public", "manifest-dark.json")), false);
  assert.doesNotMatch(read("ui", "pwa.js"), /syncInstallIcons|manifest-dark/);
  const dark = readFileSync(join(here, "..", "public", "icons", "icon-192.png"));
  assert.ok(dark.length > 1000);
});

console.log(`ios b0f0a4e6: ${passed} passed`);
