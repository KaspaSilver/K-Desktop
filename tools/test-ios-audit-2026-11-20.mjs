// node tools/test-ios-audit-2026-11-20.mjs - the iOS audit of 2026-11-20 (KaChat 5b7c772c, KaPay
// 3d126db / 17bda71, KaPlay 32e6392, KaPost f954738), where Desktop had the same bug: crafted
// pictures, reaction emoji, Max while typing, holds after a "spent" refusal, KaPost actions tied to
// their account, clock-decided bracket games, profile caches on Delete Account, Send to Chatting
// Address, and .kachat names on payment cards confirmed on chain.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectImage, imageDisplayPlan, MAX_SOURCE_PIXELS, MAX_PLAY_EDGE, MAX_PLAY_FRAMES, dataUrlBytes, planForDataUrl } from "../ui/image-guard.js";
import { encodeGif } from "../ui/gif.js";
import { outpointsNamedIn, releaseUnlessSpent } from "../engine/transactions.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const app = read("ui/app.js");

let failures = 0;
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.log(`FAIL - ${name}\n`, error); }
}

function png(width, height, { animated = false } = {}) {
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set([...type].map((c) => c.charCodeAt(0)), 4);
    out.set(data, 8);
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr)];
  if (animated) parts.push(chunk("acTL", new Uint8Array(8)));
  parts.push(chunk("IDAT", new Uint8Array(4)), chunk("IEND", new Uint8Array()));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
function jpeg(width, height) {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0, 0xff, 0xd9]);
}
function gif(w, h, frames, frameEdge = Math.max(w, h)) {
  const list = Array.from({ length: frames }, (_, i) => ({ indices: new Uint8Array(w * h).fill(i % 2), delay: 0.1 }));
  const bytes = encodeGif(list, w, h, new Uint8Array([0, 0, 0, 255, 255, 255]), 255);
  if (frameEdge !== Math.max(w, h)) {
    const at = bytes.indexOf(0x2c);
    bytes[at + 5] = frameEdge & 255;
    bytes[at + 6] = frameEdge >> 8;
  }
  return bytes;
}

await test("crafted pictures: over 50 MP blocked, only safe GIFs animate, other animations still", () => {
  assert.equal(MAX_SOURCE_PIXELS, 50_000_000);
  assert.equal(MAX_PLAY_EDGE, 1024);
  assert.equal(MAX_PLAY_FRAMES, 300);
  assert.deepEqual(inspectImage(jpeg(640, 480)), { format: "jpeg", height: 480, width: 640, animated: false });
  assert.equal(imageDisplayPlan(jpeg(640, 480)), "show");
  assert.equal(imageDisplayPlan(png(20_000, 20_000)), "block", "a PNG declaring 400 MP");
  assert.equal(imageDisplayPlan(jpeg(10_000, 6_000)), "block", "60 MP");
  assert.equal(imageDisplayPlan(png(100, 100, { animated: true })), "still", "APNG");
  assert.equal(imageDisplayPlan(gif(20, 20, 3)), "show");
  assert.equal(imageDisplayPlan(gif(20, 20, 1)), "show", "a one-frame GIF");
  assert.equal(imageDisplayPlan(gif(20, 20, 3, 2000)), "still", "a frame past 1024 px");
  assert.equal(imageDisplayPlan(gif(20, 20, 301)), "still", "past 300 frames");
  assert.equal(imageDisplayPlan(new Uint8Array([1, 2, 3])), "block", "unreadable");
  const url = `data:image/jpeg;base64,${Buffer.from(png(20_000, 20_000)).toString("base64")}`;
  assert.equal(dataUrlBytes(url).length, png(20_000, 20_000).length);
  assert.equal(planForDataUrl(url), "block", "whatever MIME type the message claims");
  assert.equal(planForDataUrl("https://example.com/a.png"), "show");
});
await test("crafted pictures: every photo path goes through the guard", () => {
  assert.equal((app.match(/setGuardedImageSrc\(img, imageEnvelope\.content\);/g) || []).length, 2, "1:1 and group bubbles");
  assert.doesNotMatch(app, /img\.src = imageEnvelope\.content;/);
  assert.match(app, /setGuardedImageSrc\(photoPreviewImage, dataUrl\);/);
  assert.match(app, /return planForDataUrl\(url\) === "show" \? url : "";/, "group photos");
  assert.match(read("ui/voice-notes.js"), /return guardedImageBlobUrl\(out, mime\);/, "joined photos");
});
await test("a reaction that isn't one emoji takes the sender's reaction away", () => {
  const start = app.indexOf("function isReactionEmoji(text) {");
  const fn = new Function(`${app.slice(start, app.indexOf("\nfunction parseReactionEnvelope", start))}; return isReactionEmoji;`)();
  for (const ok of ["👍", "❤️", "👍🏽", "👨‍👩‍👧", "1️⃣", "🇺🇸"]) assert.ok(fn(ok), ok);
  for (const bad of ["a", "1", "👍👍", "hi", "❤", "<b>x</b>", "x".repeat(60)]) assert.ok(!fn(bad), bad);
  assert.match(app, /if \(!isReactionEmoji\(emoji\)\) return \{ targetTxId, emoji: "", action: "remove" \};/);
});
await test("typing stops a Max still being worked out", () => {
  assert.match(app, /function stopSendKaspaMaxForTyping\(\) \{\n\s+sendKaspaMaxMode = false;\n\s+sendKaspaMaxStopped = sendKaspaMaxToken;\n\s+sendKaspaMaxToken \+= 1;/);
  assert.match(app, /if \(event\.isTrusted\) stopSendKaspaMaxForTyping\(\);/);
  assert.equal((app.match(/\{ maxSuperseded\(\); return; \}/g) || []).length, 2);
});
await test("after a spent refusal only the coins the node named stay held", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  assert.deepEqual([...outpointsNamedIn(`rejected: outpoint (${a}, 1) already spent; also ${b}:0`)], [`${a}:1`, `${b}:0`]);
  assert.equal(typeof releaseUnlessSpent, "function");
  assert.match(read("engine/transactions.js"), /else releaseUnlessSpent\(held, error\);/);
});
await test("a KaPost action is refused when the account changed before it went out", () => {
  const src = read("engine/kaposts.js");
  assert.match(src, /const owner = engine\.address;\n\s+const privateKey = engine\.privateKey;\n\s+await engine\.connect\(\);\n\s+if \(engine\.address !== owner\) throw kapostAccountChangedError\(\);/);
  assert.match(src, /sourceAddress: owner,\n\s+destinationAddress: owner,/);
  assert.match(src, /\/\/ Sealed for one account, signed by another: refused/);
});
await test("bracket games decided by the clock show their winner", () => {
  const src = read("ui/chess-tournaments.js");
  assert.match(src, /const winner = T\.decidedWinner\(game, now\);/);
  assert.match(src, /const live = game && !T\.isDecided\(game, now\);/);
  assert.match(src, /tournamentDecidedKey\(tournaments\[view\.tournamentId\]\) !== paintedTournamentDecided\) render\(\);/);
});
await test("Delete Account clears the profile caches; Send to Chatting Address on each address", () => {
  assert.match(app, /forgetAccountSecrets\(address\);\n[^\n]*\n[^\n]*\n\s+try \{ kachatClearProfileCache\(\)\.catch/);
  assert.match(app, /\{ id: "send-chatting", title: "Send to Chatting Address", subtitle: "Moves Kaspa from this address to your Chatting Address\.", disabled: /);
  assert.match(app, /openSendKaspaModal\(\{ spendingIndex: index, lockSource: true, prefillAddress: engine\.address \}\)/);
  assert.match(read("ui/dialogs.js"), /data-app-dialog-choice="\$\{escape\(option\.id\)\}"\$\{option\.disabled \? " disabled" : ""\}>\n\s+<span class="cold-action-copy">/);
});
await test("payment cards name an address only by a .kachat label the chain confirmed", () => {
  const runtime = read("ui/kachat-names-runtime.js");
  assert.match(runtime, /const VERIFIED_LABEL_MAX_AGE_MS = 600_000;/);
  assert.match(runtime, /await registry\.confirmOnChain\(n, service\);/);
  assert.match(runtime, /=== "lapsed"\) return null;/);
  const card = app.slice(app.indexOf("function resolutionCardName("), app.indexOf("function resolutionCardLooking("));
  assert.match(card, /const label = kachatVerifiedLabel\(address\);/);
  assert.doesNotMatch(card, /kachatCachedDisplayLabel/, "the indexer's word alone never names who you pay");
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log(`ios audit 2026-11-20: ${passed} passed`);
