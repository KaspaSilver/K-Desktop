// Token payments in a 1:1 chat: `token_payment_notice` (KaChat iOS 5b7c772c, MESSAGING.md "Token
// Payments in a Chat"; iOS TokenPaymentNoticeContent, recordTokenPayment, handleTokenPaymentNotice,
// checkTokenNoticeOnChain, tokenCoinOwner in ChatService+PaymentPools.swift).
//
// A kUSDT transfer is a covenant transaction built by Trestly's builder: it carries no chat payload,
// and the payee's coin sits at a P2SH script, not at their chatting address, so nothing on their
// side can place it in the chat. So right after it is accepted, the payer's chatting address sends
// this invisible encrypted envelope in the 1:1 chat (like `payment_notice`):
//   {"type":"token_payment_notice","token":"kusdt","txId":"<64 hex>","index":0,"amount":12500000,"address":"<payee's chatting address>"}
// The payee checks it on chain before showing an amount (checkTokenNoticeOnChain below).
//
// Pure helpers only - no DOM, no network of its own (the REST answer and the node's UTXOs are
// handed in) - so tools/test-kusdt-chat-tips.mjs can run them.

import {
  KUSDT_TOKEN, kusdtDeployment, kusdtTemplate, plainState, lockingScript, coinAddress, schnorrOwner,
  typedKusdt, parseExactJson, jsonU64,
} from "./kusdt.js";
import { hex } from "./kachat-names/codec.js";

export const TOKEN_PAYMENT_NOTICE_TYPE = "token_payment_notice";

/** The tokens a notice may name (iOS `WalletToken.all`): kUSDT only, today. */
export const NOTICE_TOKENS = Object.freeze({ [KUSDT_TOKEN.id]: KUSDT_TOKEN });

const U32_MAX = 0xffff_ffff;

/** The notice in an envelope's (already trimmed) text, as Codable would decode it, or null when it
 *  isn't one of the right shape: `{ token, txId, index, amount (BigInt), address }`. `index` is a
 *  UInt32 and `amount` a UInt64 JSON integer (read exactly: a big amount is never rounded); the
 *  strings are strings. Nothing is checked beyond the shape here (see validTokenPaymentNotice). */
export function parseTokenPaymentNoticeText(text) {
  let parsed;
  try { parsed = parseExactJson(String(text || "")); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.type !== TOKEN_PAYMENT_NOTICE_TYPE) return null;
  const { token, txId, index, amount, address } = parsed;
  if (typeof token !== "string" || typeof txId !== "string" || typeof address !== "string") return null;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > U32_MAX) return null;
  // a JSON number (a digit string only when parseExactJson quoted a 16+ digit integer)
  if (typeof amount !== "number" && !(typeof amount === "string" && /^[0-9]{16,}$/.test(amount))) return null;
  const units = jsonU64(amount);
  if (units == null) return null;
  return { token, txId, index, amount: units, address };
}

/**
 * A notice the app may act on (iOS handleTokenPaymentNotice's guards), normalized - or null to drop
 * it silently: a token this app knows, a 64-hex txId (lower-cased), an amount above zero, and the
 * address it names is `paidAddress` (the receiving side's chatting address: ours for a notice we
 * received, the contact's for our own notice read back).
 */
export function validTokenPaymentNotice(notice, paidAddress) {
  if (!notice || !Object.prototype.hasOwnProperty.call(NOTICE_TOKENS, notice.token)) return null;
  const txId = String(notice.txId || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txId)) return null;
  let amount;
  try { amount = BigInt(notice.amount); } catch { return null; }
  if (amount <= 0n) return null;
  const index = Number(notice.index);
  if (!Number.isInteger(index) || index < 0 || index > U32_MAX) return null;
  const address = String(notice.address || "").trim();
  if (!address || !paidAddress || address.toLowerCase() !== String(paidAddress).trim().toLowerCase()) return null;
  return { token: notice.token, txId, index, amount, address };
}

/** The envelope the payer's chatting address sends (iOS PaymentPoolCodec.encode): fields in iOS's
 *  order, the amount an exact integer. "" when something is missing. */
export function encodeTokenPaymentNotice({ token = KUSDT_TOKEN.id, txId, index = 0, amount, address }) {
  const id = String(txId || "").trim().toLowerCase();
  let units;
  try { units = BigInt(amount); } catch { return ""; }
  const at = Number(index);
  if (!/^[0-9a-f]{64}$/.test(id) || units <= 0n || !address || !Number.isInteger(at) || at < 0) return "";
  return `{"type":"${TOKEN_PAYMENT_NOTICE_TYPE}","token":${JSON.stringify(String(token))},"txId":${JSON.stringify(id)},"index":${at},"amount":${units.toString()},"address":${JSON.stringify(String(address))}}`;
}

/** "Sent 12.50 kUSDT" / "Received 12.50 kUSDT" (iOS tokenPaymentText): the amount with a dot and no
 *  grouping, so the payment card reads it back, and the token's symbol. */
export function tokenPaymentText({ amount, outgoing = false, token = KUSDT_TOKEN.id }) {
  const symbol = NOTICE_TOKENS[token]?.symbol ?? KUSDT_TOKEN.symbol;
  return `${outgoing ? "Sent" : "Received"} ${typedKusdt(BigInt(amount), { keepCents: true })} ${symbol}`;
}

/** An unchecked claim's bubble (iOS "Unverified %@ payment"): no amount, since anyone can make a
 *  look-alike coin with plain KAS until the covenant id says otherwise. */
export function unverifiedTokenPaymentText(token = KUSDT_TOKEN.id) {
  return `Unverified ${NOTICE_TOKENS[token]?.symbol ?? KUSDT_TOKEN.symbol} payment`;
}

/** The token a payment bubble's text names (iOS paymentCardParts: a word of the part before " — "
 *  that is a token's symbol), or null for a Kaspa payment. */
export function tokenOfPaymentText(text) {
  const head = String(text || "").split(" — ")[0];
  const words = head.split(/\s+/);
  for (const t of Object.values(NOTICE_TOKENS)) if (words.includes(t.symbol)) return t;
  return null;
}

/** The owner key (hex, lower case) of a token coin an input spends, or null when it spends none
 *  (iOS tokenCoinOwner): the redeem script, the last push of a P2SH input's signature script, is
 *  `prefix ‖ 112-byte state ‖ suffix`, and the state's bytes 10-41 are the owner - so, after a
 *  byte-aligned template prefix, hex characters 20..84 of the state, which starts 0x08 and has 0x20
 *  at byte 9. */
export function tokenCoinOwnerHex(signatureScriptHex, templatePrefixHex) {
  const h = String(signatureScriptHex || "").toLowerCase();
  const prefix = String(templatePrefixHex || "").toLowerCase();
  if (!prefix) return null;
  let from = 0;
  for (;;) {
    const found = h.indexOf(prefix, from);
    if (found < 0) return null;
    if (found % 2 === 0) {
      const state = h.slice(found + prefix.length, found + prefix.length + 224);
      if (state.length === 224 && state.startsWith("08") && state.slice(18, 20) === "20") {
        const owner = state.slice(20, 84);
        if (/^[0-9a-f]{64}$/.test(owner)) return owner;
      }
    }
    from = found + 1;
  }
}

/** A REST output's or input's field, snake_case or camelCase. */
const field = (o, snake, camel) => (o?.[snake] ?? o?.[camel]);

/**
 * What the chain says about a received token notice (iOS checkTokenNoticeOnChain):
 *   `{ status: "valid" }`, `{ status: "invalid", reason }` (drop it, or remove its unverified
 *   bubble), or `{ status: "unknown", reason }` (no chain answer yet: an unverified bubble, checked
 *   again on a later read).
 * - output `index` of the transaction is the coin of exactly `amount` owned by `paidAddress`'s key:
 *   its address is the P2SH of the pinned template with `plainState(owner, amount)`;
 * - no input is ours or another contact's, by address (`ownAddresses`, `otherContactAddresses`);
 *   and for an input that spends a token coin (any input that isn't a Schnorr key address), the
 *   owner key in that coin's state may not be ours or another contact's either - else a contact
 *   could claim our own Combine Coins, or another contact's send, whose inputs are coin P2SHs;
 * - the coin carries kUSDT's covenant id: the explorer's `covenant_id`, else the node's while the
 *   coin is unspent (`readNodeUtxos(address)` -> node UTXOs as engine.getUtxosWithCovenants gives).
 * `tx`: the REST transaction (`/transactions/{txId}?resolve_previous_outpoints=light`), or null when
 * it didn't answer. `payer`: the contact's chatting address.
 */
export async function checkTokenNoticeOnChain({
  tx, notice, paidAddress, payer, ownAddresses = [], otherContactAddresses = [], readNodeUtxos = null,
  network, template = kusdtTemplate(),
}) {
  const txId = String(notice?.txId || "").toLowerCase();
  const index = Number(notice?.index);
  let amount;
  try { amount = BigInt(notice?.amount); } catch { return { status: "invalid", reason: "has no amount" }; }
  if (!NOTICE_TOKENS[notice?.token]) return { status: "invalid", reason: "not a token this app can check" };
  if (!template) return { status: "unknown", reason: "the token template is missing" };
  let deployment;
  try { deployment = kusdtDeployment(network); } catch { return { status: "invalid", reason: "no token on this network" }; }
  const owner = schnorrOwner(paidAddress, deployment.network);
  if (!owner) return { status: "invalid", reason: "the chatting address can't hold tokens" };
  const script = lockingScript(plainState(owner, amount), template);
  let at = null;
  try { at = coinAddress(script, deployment.network); } catch { at = null; }
  if (!at) return { status: "unknown", reason: "the coin's address couldn't be worked out" };
  if (!tx || typeof tx !== "object") return { status: "unknown", reason: "the transaction isn't readable yet" };

  const outputs = Array.isArray(tx.outputs) ? tx.outputs : [];
  const output = outputs.find((o) => o?.index != null && Number(o.index) === index)
    ?? (outputs[index] && outputs[index].index == null ? outputs[index] : null);
  if (!output) return { status: "invalid", reason: `it has no output ${index}` };
  const outputAddress = String(field(output, "script_public_key_address", "scriptPublicKeyAddress") || "").toLowerCase();
  if (outputAddress !== at.toLowerCase()) return { status: "invalid", reason: `output ${index} isn't a coin of that amount for this address` };

  // who paid
  const inputs = Array.isArray(tx.inputs) ? tx.inputs : [];
  const inputAddress = (input) => String(field(input, "previous_outpoint_address", "previousOutpointAddress") || "").trim().toLowerCase();
  if (!inputs.length || inputs.some((input) => !inputAddress(input))) return { status: "unknown", reason: "has inputs that aren't readable yet" };
  const lower = (list) => new Set([...list].map((a) => String(a || "").trim().toLowerCase()).filter(Boolean));
  const payerAddress = String(payer || "").trim().toLowerCase();
  const own = lower(ownAddresses);
  const others = lower(otherContactAddresses);
  others.delete(payerAddress);
  const keyOf = (address) => { const k = schnorrOwner(address, deployment.network); return k ? hex(k) : null; };
  const ownKeys = new Set([...own].map(keyOf).filter(Boolean));
  const otherKeys = new Set([...others].map(keyOf).filter(Boolean));
  const payerKey = keyOf(payerAddress);
  const prefixHex = hex(template.prefix);
  for (const input of inputs) {
    const address = inputAddress(input);
    if (own.has(address)) return { status: "invalid", reason: "paid by one of your own addresses" };
    if (address !== payerAddress && others.has(address)) return { status: "invalid", reason: "paid by another contact" };
    // a script input: if it spends a token coin, its owner is in the coin's state
    if (schnorrOwner(address, deployment.network)) continue;
    const sig = field(input, "signature_script", "signatureScript");
    if (typeof sig !== "string" || !sig) return { status: "unknown", reason: "an input's signature script isn't readable" };
    const coinOwner = tokenCoinOwnerHex(sig, prefixHex);
    if (!coinOwner) continue;
    if (ownKeys.has(coinOwner)) return { status: "invalid", reason: "it spends one of your own coins" };
    if (coinOwner !== payerKey && otherKeys.has(coinOwner)) return { status: "invalid", reason: "it spends another contact's coin" };
  }

  // the real token: its covenant id, from the explorer or else the node
  const covenant = String(field(output, "covenant_id", "covenantId") || "").trim().toLowerCase();
  if (covenant) {
    return covenant === deployment.covenantId ? { status: "valid" } : { status: "invalid", reason: `the coin isn't ${NOTICE_TOKENS[notice.token].symbol}` };
  }
  if (typeof readNodeUtxos !== "function") return { status: "unknown", reason: "no node to ask" };
  let utxos;
  try { utxos = await readNodeUtxos(at); } catch { return { status: "unknown", reason: "the node didn't answer" }; }
  const coin = (Array.isArray(utxos) ? utxos : []).find((u) => String(u?.outpoint?.transactionId || "").toLowerCase() === txId
    && Number(u?.outpoint?.index) === index);
  // spent since, or no node answer: can't tell it from a look-alike
  if (!coin) return { status: "unknown", reason: "the coin isn't on the node" };
  if (String(coin.scriptPublicKey || "").toLowerCase() !== hex(script) || Number(coin.scriptVersion ?? 0) !== 0
    || String(coin.covenantId || "").toLowerCase() !== deployment.covenantId) {
    return { status: "invalid", reason: `the coin isn't ${NOTICE_TOKENS[notice.token].symbol}` };
  }
  return { status: "valid" };
}
