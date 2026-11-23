// A chat you start on another device is found while Desktop runs: saved contact notes are read in
// full once per session (and once a day), then looked at again every minute from the newest note
// already seen, as K does on every sync (iOS fetchSavedHandshakes). Before, Desktop read them once
// per page load, so the chat stayed missing until a reload or until you added the address.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fetchSavedHandshakeNotes } from "../engine/sync.js";

const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}
const WALLET = "kaspa:qp50rjf8zwvss6aafz2270d63ks3mzn9wden4asdecz4nkmgszhy7jxjg89gn";
const PARTNER = "kaspa:qzk2jrk7wq3zdw2n0260v87fglky82cg5u3pwy73wpktk3u864yecm5djll40";

await test("the note fetch starts at the block time it is given", async () => {
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const query = new URL(url).searchParams;
    asked.push(Number(query.get("block_time")));
    const rows = Number(query.get("block_time")) <= 5000
      ? [{ tx_id: "a".repeat(64), block_time: 6000, stashed_data: "abcd" }]
      : [];
    return { ok: true, json: async () => rows };
  };
  try {
    const result = await fetchSavedHandshakeNotes({
      walletAddress: WALLET, privateKeyHex: "11".repeat(32), indexerUrl: "https://indexer.example",
      startBlockTime: 5000,
      decryptMessage: async () => JSON.stringify({ type: "contact", version: 1, partnerAddress: PARTNER, timestamp: 6000 }),
    });
    assert.equal(asked[0], 5000);
    assert.equal(result.complete, true);
    assert.equal(result.stashes.length, 1);
    assert.equal(result.stashes[0].partnerAddress, PARTNER);
    assert.equal(result.stashes[0].type, "contact");
    assert.equal(result.stashes[0].blockTime, 6000);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("due: in full for a new wallet, then once a minute, never twice at once or while backing off", () => {
  const start = app.indexOf("function contactNotesReadDue(");
  const body = app.slice(start, app.indexOf("\n}\n", start) + 2);
  const make = (vars) => new Function("engine", "v", `
    let { contactNotesInFlight, contactNotesRetryAt, contactNotesReadBackFor, contactNotesCheckedAt } = v;
    const CONTACT_NOTES_RECHECK_MS = 60_000;
    ${body} return contactNotesReadDue;`)({ address: "kaspa:me" }, vars);
  const base = { contactNotesInFlight: false, contactNotesRetryAt: 0, contactNotesReadBackFor: "kaspa:me", contactNotesCheckedAt: 100_000 };
  assert.equal(make({ ...base, contactNotesReadBackFor: null })(100_001), true, "first read for this wallet");
  assert.equal(make(base)(130_000), false, "30 s after the last read");
  assert.equal(make(base)(160_000), true, "a minute after it");
  assert.equal(make({ ...base, contactNotesInFlight: true })(500_000), false);
  assert.equal(make({ ...base, contactNotesRetryAt: 600_000 })(500_000), false);
});

await test("later reads start ten minutes before the newest note; a full read daily", () => {
  assert.match(app, /const CONTACT_NOTES_RECHECK_MS = 60_000;/);
  assert.match(app, /const CONTACT_NOTES_FULL_RESCAN_MS = 24 \* 60 \* 60_000;/);
  assert.match(app, /const CONTACT_NOTES_REWIND_MS = 10 \* 60_000;/);
  assert.match(app, /const full = contactNotesReadBackFor !== wallet \|\| Date\.now\(\) - contactNotesFullAt >= CONTACT_NOTES_FULL_RESCAN_MS;/);
  assert.match(app, /const startBlockTime = full \? 0 : Math\.max\(0, contactNotesHighWater - CONTACT_NOTES_REWIND_MS\);/);
  assert.match(app, /await engine\.fetchSavedHandshakeNotes\(\{ startBlockTime \}\)/);
});

await test("only a full read that reached the end marks the notes complete or writes missing ones", () => {
  assert.match(app, /if \(full && complete\) s\.complete = true;/);
  assert.match(app, /if \(full && complete\) backfillContactStashes\(\);/);
  assert.doesNotMatch(app, /\n\s*if \(complete\) s\.complete = true;/);
});

await test("a chat found mid-session loads its history quietly, without silencing every other chat", () => {
  assert.match(app, /await Promise\.all\(recoveredEntries\.map\(\(conversationEntry\) => syncOneConversation\(conversationEntry, \{ quiet: true, catchUp: true \}\)/);
  const fn = app.slice(app.indexOf("async function readBackContactNotes()"), app.indexOf("// Best-effort, fire-and-forget: mirrors iOS's sendOrQueueSelfStash"));
  assert.match(fn, /if \(full\) \{\n\s*pendingInitialCatchUp = true;/);
});

await test("both sweep gates use the recheck, and an account reset clears it", () => {
  assert.equal((app.match(/if \(contactNotesReadDue\(\)\) readBackContactNotes\(\)\.catch\(\(\) => \{\}\);/g) || []).length, 2);
  assert.match(app, /contactNotesHighWater = 0;\n\s*contactNotesCheckedAt = 0;\n\s*contactNotesFullAt = 0;\n\s*contactStashState = null;/);
});

console.log(`contact notes recheck: ${passed} passed`);
