// Send Dollars in a 1:1 chat (KaChat iOS 5b7c772c, MESSAGING.md "Token Payments in a Chat") and
// KaPost's Tip In (KaPost iOS f954738), without a browser: the token_payment_notice envelope (wire
// JSON, the shapes iOS's Codable decodes, the drop rules), the bubble texts, the payee's chain check
// with stubbed REST and node answers - forged notices included (an input of ours, a coin of ours or
// another contact's spent, the wrong owner, the wrong covenant, the wrong address, no answer) - the
// wallet's Discover-if-stale and its quiet banner for a notice-filed transfer, Tip In's effective
// value and layout, then source checks of the exact strings and the app.js / index.html hooks.
// Nothing leaves the machine. Run from the repo root:
//
//   node tools/test-kusdt-chat-tips.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js";

const K = await import("../engine/kusdt.js");
const S = await import("../engine/kusdt-store.js");
const C = await import("../engine/kachat-names/codec.js");
const T = await import("../engine/token-payment-notice.js");
const P = await import("../engine/payment-notice.js");
const W = await import("../ui/kusdt-wallet.js");
const TI = await import("../ui/kaposts-tip-in.js");

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (error) { failures.push(`${name}: ${error?.stack || error}`); }
}
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const net = "mainnet";
const dep = K.kusdtDeployment(net);
const tmpl = K.kusdtTemplate();
const key = (n) => schnorr.getPublicKey(C.unhex(n.toString(16).padStart(2, "0").repeat(32)));
const ME = K.addressOfOwner(key(1), net);          // the payee's chatting address
const PAYER = K.addressOfOwner(key(2), net);       // the contact who paid
const OTHER = K.addressOfOwner(key(3), net);       // another contact
const MY_SPENDING = K.addressOfOwner(key(4), net); // one of my regular addresses
const STRANGER = K.addressOfOwner(key(5), net);
const TX = "ab".repeat(32);
const AMOUNT = 12_500_000n;

// MARK: - The envelope

await check("encode writes iOS's exact wire JSON; parse reads it back as a token notice", () => {
  const text = T.encodeTokenPaymentNotice({ txId: TX.toUpperCase(), index: 0, amount: AMOUNT, address: ME });
  assert.equal(text, `{"type":"token_payment_notice","token":"kusdt","txId":"${TX}","index":0,"amount":12500000,"address":"${ME}"}`);
  const envelope = P.parsePaymentPoolEnvelope(text);
  assert.equal(envelope.kind, "tokenNotice");
  assert.deepEqual(envelope.notice, { token: "kusdt", txId: TX, index: 0, amount: AMOUNT, address: ME });
  assert.equal(P.parsePaymentNotice(text), null, "not a payment_notice");
  assert.equal(T.encodeTokenPaymentNotice({ txId: "zz", index: 0, amount: AMOUNT, address: ME }), "");
  assert.equal(T.encodeTokenPaymentNotice({ txId: TX, index: 0, amount: 0n, address: ME }), "");
  assert.equal(T.encodeTokenPaymentNotice({ txId: TX, index: 0, amount: AMOUNT, address: "" }), "");
});

await check("a big amount is read exactly (a u64, never rounded through a float)", () => {
  const text = `{"type":"token_payment_notice","token":"kusdt","txId":"${TX}","index":0,"amount":18446744073709551615,"address":"${ME}"}`;
  assert.equal(P.parsePaymentPoolEnvelope(text).notice.amount, 18446744073709551615n);
  assert.equal(P.parsePaymentPoolEnvelope(text.replace("18446744073709551615", "18446744073709551616")), null, "past a u64: Codable fails");
});

await check("a notice of the wrong shape is no notice (iOS's Codable decode fails, so it shows as text)", () => {
  const base = { type: "token_payment_notice", token: "kusdt", txId: TX, index: 0, amount: 12500000, address: ME };
  const bad = [
    { ...base, amount: "12500000" }, { ...base, amount: 1.5 }, { ...base, amount: -1 }, { ...base, index: -1 },
    { ...base, index: 2 ** 32 }, { ...base, index: "0" }, { ...base, txId: 5 }, { ...base, token: null },
  ];
  for (const b of bad) assert.equal(P.parsePaymentPoolEnvelope(JSON.stringify(b)), null, JSON.stringify(b));
  const { address, ...noAddress } = base;
  assert.equal(P.parsePaymentPoolEnvelope(JSON.stringify(noAddress)), null);
  assert.equal(P.parsePaymentPoolEnvelope(JSON.stringify({ ...base, extra: true })).kind, "tokenNotice", "extra keys are ignored, as Codable does");
});

await check("validTokenPaymentNotice drops an unknown token, another address, a bad txId or amount", () => {
  const n = { token: "kusdt", txId: TX.toUpperCase(), index: 0, amount: AMOUNT, address: ME };
  assert.deepEqual(T.validTokenPaymentNotice(n, ME), { token: "kusdt", txId: TX, index: 0, amount: AMOUNT, address: ME });
  assert.equal(T.validTokenPaymentNotice({ ...n, token: "kusdc" }, ME), null, "a token this app doesn't know");
  assert.equal(T.validTokenPaymentNotice(n, PAYER), null, "not a payment to my chatting address");
  assert.equal(T.validTokenPaymentNotice({ ...n, txId: TX.slice(1) }, ME), null);
  assert.equal(T.validTokenPaymentNotice({ ...n, txId: `${TX.slice(2)}zz` }, ME), null);
  assert.equal(T.validTokenPaymentNotice({ ...n, amount: 0n }, ME), null);
  assert.equal(T.validTokenPaymentNotice(n, ""), null);
  assert.ok(T.validTokenPaymentNotice({ ...n, address: ME.toUpperCase() }, ME), "address compared without case");
});

await check("bubble texts: dot decimals, no grouping, the symbol; unverified has no amount", () => {
  assert.equal(T.tokenPaymentText({ amount: AMOUNT, outgoing: true }), "Sent 12.50 kUSDT");
  assert.equal(T.tokenPaymentText({ amount: 1_250_000_000n }), "Received 1250.00 kUSDT");
  assert.equal(T.tokenPaymentText({ amount: 1n }), "Received 0.000001 kUSDT");
  assert.equal(T.tokenPaymentText({ amount: 12_345_600n, outgoing: true }), "Sent 12.3456 kUSDT");
  assert.equal(T.unverifiedTokenPaymentText(), "Unverified kUSDT payment");
  assert.equal(T.tokenOfPaymentText("Sent 12.50 kUSDT")?.symbol, "kUSDT");
  assert.equal(T.tokenOfPaymentText("Sent 1 KAS — kUSDT later"), null, "a memo never makes it a token payment");
  assert.equal(T.tokenOfPaymentText("Received 2.5 KAS"), null);
});

await check("tokenCoinOwnerHex reads the owner from a P2SH input's redeem script, byte-aligned only", () => {
  const redeem = K.redeemScript(K.plainState(key(7), 3_000_000n), tmpl);
  const sig = `41${"11".repeat(65)}4d${"00".repeat(2)}${C.hex(redeem)}`;
  const prefixHex = C.hex(tmpl.prefix);
  assert.equal(T.tokenCoinOwnerHex(sig, prefixHex), C.hex(key(7)));
  assert.equal(T.tokenCoinOwnerHex(`${"aa".repeat(40)}`, prefixHex), null, "no token coin");
  assert.equal(T.tokenCoinOwnerHex(`0${C.hex(redeem)}`, prefixHex), null, "an odd offset is no byte boundary");
  assert.equal(T.tokenCoinOwnerHex(`${prefixHex}09`, prefixHex), null, "a state too short");
});

// MARK: - The chain check

const coinScript = K.lockingScript(K.plainState(K.schnorrOwner(ME, net), AMOUNT), tmpl);
const coinAt = K.coinAddress(coinScript, net);
const tokenInput = (owner) => ({ previous_outpoint_address: K.coinAddress(K.lockingScript(K.plainState(owner, 1n), tmpl), net), signature_script: `40${"22".repeat(64)}4c${C.hex(K.redeemScript(K.plainState(owner, 20_000_000n), tmpl))}` });
function txWith({ outputs, inputs } = {}) {
  return {
    transaction_id: TX,
    outputs: outputs ?? [
      { index: 0, amount: 150_000_000, script_public_key_address: coinAt, covenant_id: dep.covenantId },
      { index: 1, amount: 150_000_000, script_public_key_address: "kaspa:pchange", covenant_id: dep.covenantId },
    ],
    inputs: inputs ?? [{ previous_outpoint_address: PAYER, signature_script: "41aa" }, tokenInput(K.schnorrOwner(PAYER, net))],
  };
}
const notice = { token: "kusdt", txId: TX, index: 0, amount: AMOUNT, address: ME };
const nodeCoin = (overrides = {}) => ({ outpoint: { transactionId: TX, index: 0 }, amount: 150_000_000n, scriptVersion: 0, scriptPublicKey: C.hex(coinScript), covenantId: dep.covenantId, ...overrides });
const verdict = (tx, extra = {}) => T.checkTokenNoticeOnChain({
  tx, notice, paidAddress: ME, payer: PAYER, ownAddresses: [ME, MY_SPENDING], otherContactAddresses: [PAYER, OTHER], network: net, template: tmpl,
  readNodeUtxos: async () => { throw new Error("the node isn't asked when the explorer names the covenant"); }, ...extra,
});

await check("valid: output 0 is my coin of that amount, with kUSDT's covenant id from the explorer, paid by the contact", async () => {
  assert.deepEqual(await verdict(txWith()), { status: "valid" });
  // camelCase fields read the same
  const camel = { outputs: [{ index: 0, scriptPublicKeyAddress: coinAt, covenantId: dep.covenantId }], inputs: [{ previousOutpointAddress: PAYER }] };
  assert.deepEqual(await verdict(camel), { status: "valid" });
});

await check("forged: the wrong covenant, the wrong amount or owner, a missing output", async () => {
  const wrongCovenant = txWith({ outputs: [{ index: 0, script_public_key_address: coinAt, covenant_id: "11".repeat(32) }] });
  assert.equal((await verdict(wrongCovenant)).status, "invalid");
  const otherAmount = K.coinAddress(K.lockingScript(K.plainState(K.schnorrOwner(ME, net), AMOUNT + 1n), tmpl), net);
  assert.equal((await verdict(txWith({ outputs: [{ index: 0, script_public_key_address: otherAmount, covenant_id: dep.covenantId }] }))).status, "invalid", "a coin of another amount");
  const otherOwner = K.coinAddress(K.lockingScript(K.plainState(key(5), AMOUNT), tmpl), net);
  assert.equal((await verdict(txWith({ outputs: [{ index: 0, script_public_key_address: otherOwner, covenant_id: dep.covenantId }] }))).status, "invalid", "someone else's coin");
  assert.equal((await verdict(txWith({ outputs: [{ index: 0, script_public_key_address: ME, covenant_id: null }] }))).status, "invalid", "plain KAS to my address is no kUSDT");
  assert.match((await verdict(txWith({ outputs: [{ index: 3, script_public_key_address: coinAt }] }))).reason, /no output 0/);
  // an output list without indices is read by position
  assert.equal((await verdict(txWith({ outputs: [{ script_public_key_address: coinAt, covenant_id: dep.covenantId }] }))).status, "valid");
});

await check("forged: an input of mine or another contact's, by address", async () => {
  for (const address of [ME, MY_SPENDING]) {
    const v = await verdict(txWith({ inputs: [{ previous_outpoint_address: PAYER }, { previous_outpoint_address: address }] }));
    assert.equal(v.status, "invalid", address);
    assert.match(v.reason, /your own/);
  }
  const v = await verdict(txWith({ inputs: [{ previous_outpoint_address: OTHER }] }));
  assert.equal(v.status, "invalid");
  assert.match(v.reason, /another contact/);
  assert.equal((await verdict(txWith({ inputs: [{ previous_outpoint_address: STRANGER }] }))).status, "valid", "a stranger's KAS may pay for it");
});

await check("forged: a token coin of mine (my own Combine Coins) or another contact's spent through its P2SH", async () => {
  const mine = await verdict(txWith({ inputs: [tokenInput(K.schnorrOwner(ME, net))] }));
  assert.equal(mine.status, "invalid");
  assert.match(mine.reason, /your own coins/);
  const spendingCoin = await verdict(txWith({ inputs: [tokenInput(K.schnorrOwner(MY_SPENDING, net))] }));
  assert.equal(spendingCoin.status, "invalid", "a coin on one of my regular addresses");
  const theirs = await verdict(txWith({ inputs: [tokenInput(K.schnorrOwner(OTHER, net))] }));
  assert.equal(theirs.status, "invalid");
  assert.match(theirs.reason, /another contact's coin/);
  assert.equal((await verdict(txWith({ inputs: [tokenInput(K.schnorrOwner(PAYER, net))] }))).status, "valid", "the payer's own coin");
  assert.equal((await verdict(txWith({ inputs: [tokenInput(key(5))] }))).status, "valid", "a stranger's coin");
  const unreadable = await verdict(txWith({ inputs: [{ previous_outpoint_address: "kaspa:pqscriptaddress" }] }));
  assert.equal(unreadable.status, "unknown", "a script input without its signature script");
});

await check("no chain answer: unknown (an unverified bubble, checked again later)", async () => {
  assert.equal((await verdict(null)).status, "unknown", "REST didn't answer");
  assert.equal((await verdict(txWith({ inputs: [{ previous_outpoint_address: PAYER }, { previous_outpoint_address: null }] }))).status, "unknown", "an unresolved input");
  assert.equal((await verdict(txWith({ inputs: [] }))).status, "unknown");
  assert.equal((await T.checkTokenNoticeOnChain({ tx: txWith(), notice, paidAddress: ME, payer: PAYER, network: net, template: null })).status, "unknown", "no template");
});

await check("no covenant id from the explorer: the node's, while the coin is unspent", async () => {
  const noCovenant = txWith({ outputs: [{ index: 0, script_public_key_address: coinAt }] });
  const asked = [];
  const node = (list) => async (address) => { asked.push(address); return list; };
  assert.deepEqual(await verdict(noCovenant, { readNodeUtxos: node([nodeCoin()]) }), { status: "valid" });
  assert.deepEqual(asked, [coinAt], "the node is asked about the coin's own address");
  assert.equal((await verdict(noCovenant, { readNodeUtxos: node([nodeCoin({ covenantId: "11".repeat(32) })]) })).status, "invalid", "a look-alike coin");
  assert.equal((await verdict(noCovenant, { readNodeUtxos: node([nodeCoin({ covenantId: null })]) })).status, "invalid");
  assert.equal((await verdict(noCovenant, { readNodeUtxos: node([nodeCoin({ scriptPublicKey: "00" })]) })).status, "invalid");
  assert.equal((await verdict(noCovenant, { readNodeUtxos: node([]) })).status, "unknown", "spent since: can't tell");
  assert.equal((await verdict(noCovenant, { readNodeUtxos: async () => { throw new Error("down"); } })).status, "unknown");
  assert.equal((await verdict(noCovenant, { readNodeUtxos: null })).status, "unknown");
});

await check("a chatting address that can't hold tokens, or an unknown token, is invalid", async () => {
  assert.equal((await T.checkTokenNoticeOnChain({ tx: txWith(), notice, paidAddress: "kaspa:pqx", payer: PAYER, network: net, template: tmpl })).status, "invalid");
  assert.equal((await T.checkTokenNoticeOnChain({ tx: txWith(), notice: { ...notice, token: "x" }, paidAddress: ME, payer: PAYER, network: net, template: tmpl })).status, "invalid");
});

// MARK: - The wallet: Discover if stale, and the quiet banner

function storage() {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); } };
}
function answer(json) {
  const bytes = new TextEncoder().encode(K.stringifyExact(json));
  return { status: 200, headers: { get: () => null }, arrayBuffer: async () => bytes.buffer.slice(0) };
}
const txid = (n) => n.toString(16).padStart(2, "0").repeat(32);
const spending = (i) => K.addressOfOwner(key(40 + i), net);
function world() {
  const coins = {};
  const asked = [];
  const stateOf = (address, units) => K.plainState(K.schnorrOwner(address, net), units);
  return {
    coins, asked,
    fetchImpl: async (url) => {
      const owner = new URL(url).searchParams.get("owner");
      asked.push(owner);
      const list = coins[owner] || [];
      return answer({ states: list.map((c) => ({ utxo: { transactionId: txid(c.n), index: 0 }, state: K.stateToJson(stateOf(owner, c.units)) })) });
    },
    getUtxos: async (addresses) => {
      const out = [];
      for (const [owner, list] of Object.entries(coins)) {
        for (const c of list) {
          const script = K.lockingScript(stateOf(owner, c.units), tmpl);
          if (!addresses.includes(K.coinAddress(script, net))) continue;
          out.push({ outpoint: { transactionId: txid(c.n), index: 0 }, amount: 150_000_000n, blockDaaScore: 1n, isCoinbase: false, scriptVersion: 0, scriptPublicKey: C.hex(script), covenantId: dep.covenantId });
        }
      }
      return out;
    },
  };
}
function makeWallet(w, overrides = {}) {
  let clock = 1_000_000;
  const notes = [];
  const wallet = W.createKusdtWallet({
    account: () => ME, network: net, storage: storage(), apiBase: () => dep.apiBase,
    getUtxos: w.getUtxos, fetchImpl: w.fetchImpl, isHeld: () => false, now: () => clock,
    maxSpendingIndex: () => 1, spendingAddressAt: (i) => spending(i),
    spendingAddressesInRange: async (start, end) => new Map(Array.from({ length: end - start }, (_, k) => [start + k, spending(start + k)])),
    revealSpendingSlot: () => {}, spendingLabel: (i) => `Address #${i + 1}`,
    ownAddresses: () => [ME], fetchTransactionInputs: async () => [{ hash: txid(0xee), index: 0, address: PAYER }],
    notificationsEnabled: () => true, notify: (note) => notes.push(note),
    ...overrides,
  });
  return { wallet, notes, tick: (ms) => { clock += ms; } };
}

await check("Send Dollars' Discover runs once per 5 minutes per account, and says it's looking meanwhile", async () => {
  assert.equal(W.KUSDT_DISCOVER_STALE_MS, 300_000);
  const w = world();
  w.coins[ME] = [{ n: 1, units: AMOUNT }];
  const { wallet, tick } = makeWallet(w);
  const running = wallet.discoverIfStale();
  assert.equal(wallet.discovering, true, "the From step says Checking");
  assert.equal(await running, 1);
  assert.equal(wallet.discovering, false);
  const sweep = w.asked.length;
  assert.ok(sweep >= 1 + 21, "every regular address to 20 past the last");
  tick(299_000);
  assert.equal(await wallet.discoverIfStale(), null, "fresh: not again");
  assert.equal(w.asked.length, sweep);
  tick(2_000);
  await wallet.discoverIfStale();
  assert.equal(w.asked.length, sweep * 2, "stale: again");
  assert.equal(wallet.balance(), AMOUNT);
});

await check("no second \"Received kUSDT\" banner for a transfer a chat's notice filed; its history row stays", async () => {
  const w = world();
  w.coins[ME] = [{ n: 1, units: 1_000_000n }];
  const filed = new Set([txid(7)]);
  const { wallet, notes, tick } = makeWallet(w, { isNoticeFiled: (id) => filed.has(id) });
  await wallet.refresh(); // first look
  w.coins[ME].push({ n: 7, units: AMOUNT });
  await wallet.refresh();
  assert.deepEqual(notes, [], "the chat announced it already");
  assert.equal(wallet.activity().filter((r) => r.kind === "received").length, 1, "still in the kUSDT history");
  w.coins[ME].push({ n: 8, units: 2_000_000n });
  await wallet.refresh();
  assert.deepEqual(notes, [], "a coin with no notice yet waits for one (K b0f0a4e6)");
  tick(W.KUSDT_NOTICE_WAIT_MS + 1000);
  await wallet.refresh();
  assert.deepEqual(notes, [{ title: "Received 2.00 kUSDT", body: "" }], "one no notice filed still rings, after the wait");
});

// MARK: - Tip In

await check("Tip In: the stored choice, else Kaspa while an instant tip is set, else Ask Each Time", () => {
  assert.equal(TI.effectiveTipIn({}), "ask");
  assert.equal(TI.effectiveTipIn({ hasInstantTip: true }), "kaspa");
  assert.equal(TI.effectiveTipIn({ stored: "kusdt", hasInstantTip: true }), "kusdt");
  assert.equal(TI.effectiveTipIn({ stored: "kaspa" }), "kaspa");
  assert.equal(TI.effectiveTipIn({ stored: "nonsense" }), "ask");
});

await check("Tip In is kept per account; Ask Each Time is no entry", () => {
  let map = TI.withTipIn(undefined, "kaspa:a", "kusdt");
  map = TI.withTipIn(map, "kaspa:b", "kaspa");
  assert.deepEqual(map, { "kaspa:a": "kusdt", "kaspa:b": "kaspa" });
  assert.equal(TI.storedTipIn(map, "kaspa:a"), "kusdt");
  assert.equal(TI.storedTipIn(map, "kaspa:c"), null);
  map = TI.withTipIn(map, "kaspa:a", "ask");
  assert.deepEqual(map, { "kaspa:b": "kaspa" });
  assert.equal(TI.storedTipIn({ x: "bogus" }, "x"), null);
});

await check("Tip In's layout: instant tip only for Kaspa, Tips From hidden for kUSDT, footers exactly as iOS", () => {
  assert.deepEqual(TI.TIP_IN_OPTIONS.map((o) => [o.value, o.label]), [["ask", "Ask Each Time"], ["kaspa", "Kaspa"], ["kusdt", "kUSDT"]]);
  assert.deepEqual(TI.tipInLayout("kaspa"), { instantTipRows: true, tipsFrom: true, footer: null, clearsInstantTip: false });
  assert.deepEqual(TI.tipInLayout("ask"), { instantTipRows: false, tipsFrom: true, footer: "Tip asks whether to send Kaspa or kUSDT each time.", clearsInstantTip: true });
  assert.deepEqual(TI.tipInLayout("kusdt"), { instantTipRows: false, tipsFrom: false, footer: "Tip sends kUSDT to the poster's chatting address. kUSDT tips aren't counted on the post.", clearsInstantTip: true });
});

// MARK: - Exact strings and hooks (source)

const screens = read("ui/kusdt-screens.js");
const app = read("ui/app.js");
const html = read("index.html");

await check("exact strings: Send Dollars, its From step, the tip chooser", () => {
  for (const text of [
    'sendDollarsTitle: "Send Dollars"', 'sendDollarsQuestion: "Which stablecoin are you sending?"',
    'fromNone: "None of your addresses holds kUSDT yet."', 'fromChecking: "Checking your addresses for kUSDT…"',
    'tipTitle: "Tip"', 'tipQuestion: "What are you tipping in?"', 'tipKusdtSubtitle: "Not counted on the post"',
    'tipFootnote: "Set what Tip sends in Settings > KaPost > Tip In."',
    'lockedChanged: "This send changed while the screen was open. Nothing was sent: check it again and swipe."',
    "<span>Swap Stablecoins</span>",
  ]) assert.ok(screens.includes(text), text);
});

await check("the + sheet: Send Dollars right after Send Kaspa, then its second step with Back", () => {
  const pay = html.indexOf("data-composer-pay title");
  const dollars = html.indexOf("data-composer-dollars title");
  const camera = html.indexOf('data-composer-media="camera"');
  assert.ok(pay > 0 && pay < dollars && dollars < camera, "Send Kaspa, Send Dollars, Camera");
  assert.ok(html.includes('title="Send dollars (kUSDT) to this contact."'));
  assert.ok(html.includes("<strong>Send Dollars</strong><small>Send dollars (kUSDT) to this contact.</small>"));
  const step = html.slice(html.indexOf("data-composer-dollars-menu"), html.indexOf("data-composer-dollars-back") + 60);
  for (const text of ['<p class="composer-plus-title">Send Dollars</p>', '<p class="composer-plus-caption">Which stablecoin are you sending?</p>',
    "<strong>kUSDT</strong><small>Bridged USDT</small>", ">Back</button>"]) assert.ok(step.includes(text), text);
  // hidden for bots by the rule that hides every tile but Send Kaspa
  assert.ok(app.includes('composerPlusMenu.querySelectorAll("button").forEach((row) => { if (!row.hasAttribute("data-composer-pay")) row.hidden = botChat; });'));
});

await check("app.js hooks: notice routing, the notification, the payer's record, the payee's check, Tip In", () => {
  for (const text of [
    'if (poolEnvelope.kind === "tokenNotice") return handleTokenPaymentNotice(conversationEntry, message, poolEnvelope.notice);',
    '(poolEnvelope.kind === "tokenNotice" && validTokenPaymentNotice(poolEnvelope.notice, engine.address))',
    "kusdtWallet.discoverIfStale()",
    "onSent: (txid, index, amount) => recordTokenPayment({ owner, conversationId, contactAddress, txId: txid, index, amount })",
    "keepUnsentPaymentNotice(owner, { contactAddress: address, payload, txId: txid })",
    "await sendPaymentNoticeEnvelope(conversationEntry, contact, payload, owner);",
    "readNodeUtxos: (address) => engine.getUtxosWithCovenants([address])",
    "/transactions/${txId}?resolve_previous_outpoints=light",
    "isNoticeFiled: (txid) => isTokenNoticeFiled(txid)",
    "isTransactionAccepted: (txid) => isTransactionAcceptedRest(txid)",
    "logoWrap.innerHTML = kusdtCoinIconHtml(46);",
    '<span class="settings-row-copy"><strong>Tip In</strong></span>',
    "openKusdtSend({ recipient: address, recipientName: name || shortAddress(address), locked: true, refresh: \"always\" });",
    "await openTipAssetChooser(",
  ]) assert.ok(app.includes(text), text);
  // the payer's notice goes from the account that paid, never one switched to since
  assert.ok(/if \(engine\.address !== owner\) \{\s*if \(payload\) keepUnsentPaymentNotice\(owner/.test(app));
  // a kUSDT tip names no post and records nothing in a chat
  const tip = app.slice(app.indexOf("function openKaPostKusdtTip"), app.indexOf("function openKaPostKusdtTip") + 300);
  assert.ok(!tip.includes("onSent") && !tip.includes("onTipped"));
});

await check("the locked send: no To step, From has no Back, a 10 s × 18 lookup after Not confirmed", () => {
  assert.ok(screens.includes('back: () => (S.locked ? null : "to"),'));
  assert.ok(screens.includes("function sendSkipsFrom() { return !S.locked &&"));
  assert.ok(screens.includes("export const LOCKED_SEND_POLL_MS = 10_000;"));
  assert.ok(screens.includes("export const LOCKED_SEND_POLL_TRIES = 18;"));
  assert.ok(screens.includes("if (onSent) pollUnknownChatSend(built.txid, built.amount, onSent, built.owner || S.owner);"));
  assert.ok(screens.includes('goSend(lock ? "from"'));
});

console.log(`test-kusdt-chat-tips: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
