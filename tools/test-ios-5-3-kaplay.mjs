// node tools/test-ios-5-3-kaplay.mjs - KaPlay iOS 077d777's chess and arena fixes, ported in Build
// 295: no move once your own clock reads zero, a queued join kept until it's settled, a dropped
// join's own message, a waiting room whose room is gone, the arena error clearing itself, sends
// refused after an account switch, history paging that survives a failing page, only the outage
// paged again, draw and invite wording, and log redaction after "_".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const ui = read("ui/chess-tournaments.js");

let failures = 0;
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.log(`FAIL - ${name}\n`, error); }
}

await test("no move once your own clock reads zero, nor a retry after it ran out", () => {
  assert.match(ui, /const clockLeft = \(g\) => T\.remainingMs\(g, T\.colorOf\(g, my\), Date\.now\(\)\) > 0;/);
  assert.match(ui, /\|\| !clockLeft\(game\) \|\|/);
  assert.match(ui, /if \(stillWanted && !stillWanted\(\)\) \{\n\s+setLastError\(CLOCK_RAN_OUT_MESSAGE\);/);
  assert.match(ui, /const CLOCK_RAN_OUT_MESSAGE = "Your clock ran out before the move could be sent\.";/);
});
await test("a queued join stays until the room is under way and the join is the chain's", () => {
  assert.match(ui, /if \(T\.tournamentStatus\(room\) === "open"\) \{/);
  assert.match(ui, /\} else if \(!joinStillLocal\) \{/);
  assert.match(ui, /queuedAt = Date\.now\(\);/);
  assert.match(ui, /\/\/ leaving ends the queue and its automatic rejoins \(KaPlay 077d777\)\n\s+queuedPublicRoomId = null;\n\s+queuedAt = 0;\n\s+autoRejoinsLeft = 0;/);
});
await test("a dropped join says so, and ends the queue", async () => {
  const T = await import("../engine/chess-tournament.js");
  assert.equal(T.JOIN_DROPPED_MESSAGE, "Your join didn't reach the network. Join again whenever you like.");
  assert.match(ui, /mineDropped === "join" \? T\.JOIN_DROPPED_MESSAGE/);
  assert.match(ui, /if \(\(message\?\.a === "join" \|\| message\?\.a === "create"\) && message\.t === queuedPublicRoomId && row\.senderAddress === my\)/);
});
await test("a waiting room whose room is gone closes; out before the seat ran out is a join that didn't land", () => {
  assert.match(ui, /if \(!t\) \{\n\s+\/\/ The room is gone/);
  assert.match(ui, /now - \(waitingAppearedAt \|\| now\) > 30_000/);
  assert.match(ui, /const ranOut = waitingSeatExpiry == null \|\| now >= waitingSeatExpiry;/);
});
await test("the arena error clears itself after 3 s, never over a newer one", () => {
  assert.match(ui, /const LAST_ERROR_SHOWN_MS = 3_000;/);
  assert.match(ui, /if \(token !== lastErrorToken \|\| !lastError\) return;/);
  assert.equal((ui.match(/\blastError = T\./g) || []).length, 0, "every error goes through setLastError");
});
await test("a queued arena send or bot stamp is refused once another account is on", async () => {
  const { sendBroadcastMessage, BROADCAST_SENDER_CHANGED } = await import("../engine/broadcasts.js");
  const engine = { kaspa: {}, privateKey: "k", address: "kaspa:qnow", connect: async () => { engine.address = "kaspa:qother"; } };
  await assert.rejects(sendBroadcastMessage({ engine, channel: "chess-arena", content: "x", expectedSender: "kaspa:qthen" }), (e) => e.message === BROADCAST_SENDER_CHANGED);
  engine.address = "kaspa:qthen";
  await assert.rejects(sendBroadcastMessage({ engine, channel: "chess-arena", content: "x", expectedSender: "kaspa:qthen" }), (e) => e.message === BROADCAST_SENDER_CHANGED, "a switch during the connect");
  assert.match(ui, /singleInput: true, expectedSender: sender \}/);
  assert.match(read("ui/chess-bots.js"), /This game was played on another account\. Sign in to it to stamp the result\./);
});
await test("a failing deep page keeps what was paged and resumes; three empty tries end it", () => {
  assert.match(ui, /let before = wholeWindow \? backfillResumeBefore : null;/);
  assert.match(ui, /if \(backfillEmptyFailures >= 3\) \{/);
});
await test("back from an outage, only the outage is paged again", () => {
  assert.match(ui, /if \(backfilled && Number\(downSinceMs\) > 0\) \{\n\s+requestRepage\(Number\(downSinceMs\) - T\.REPAGE_MARGIN_MS\);/);
});
await test("draws read 'after a draw by stalemate' and 'the fifty-move rule'; invites give the whole path", () => {
  assert.match(ui, /return text === "fifty-move rule" \? "the fifty-move rule" : text;/);
  assert.match(ui, /`\$\{who\} won on clock after a draw by \$\{by\}`/);
  assert.match(ui, /open Arcade > Chess > \$\{share\.dataset\.kind\} > Join with a code, and enter \$\{share\.dataset\.chessTShare\}\.`/);
  assert.match(ui, /\$\{duel \? "" : ' data-invite="tournament"'\}>Share<\/button>/);
});
await test("an address right after '_' is shortened in the log too", async () => {
  const { shortenLogAddresses } = await import("../ui/log-addresses.js");
  assert.equal(shortenLogAddresses("wallet_kaspa:qrabcdefghijklmnopqrstuvwxyz0123"), "wallet_…wxyz0123");
  assert.equal(shortenLogAddresses("xkaspa:qqqqqqqqqqqqqqqqq"), "xkaspa:qqqqqqqqqqqqqqqqq", "part of another word: left alone");
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log(`ios 5.3 kaplay: ${passed} passed`);
