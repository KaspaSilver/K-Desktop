// kUSDT on Kaspa L1: Trestly's KCC-20 token (kaspador/kusdt-open b70707c, SPEC.md).
//
// Port of KaPay iOS KaChatWallet/Services/Tokens/Kusdt.swift (e188209, 3d126db) and the amount
// helpers of Views/Tokens/WalletTokens.swift (`TokenAmount`). What a wallet needs to read and move
// kUSDT: the deployment (covenant ids, the KAS a coin carries), the token template (pinned,
// kusdt/kusdt-kcc20-template.json), a coin's state, the script it locks to, which addresses can
// hold it, and amounts as text.
//
// Trust (as iOS): nothing Trestly's API says is believed until the node shows it. A coin counts only
// when the node holds that exact outpoint, at the script recomputed here from the state, carrying
// kUSDT's covenant id (engine/kusdt-balances.js). A wrong template or a lying API can only hide
// coins, never invent them.
//
// Pure: no network, no storage, nothing runs at import but the template check. Amounts are BigInt
// base units (6 decimals) and sompi. JSON to and from Trestly's builder is exact both ways
// (`stringifyExact` / `parseExactJson`): a u64 is a bare JSON integer, and an answer's 16+ digit
// integers are read as digit strings instead of being rounded by JSON.parse.

import { sha256 } from "@noble/hashes/sha2.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex, unhex, concat, bytesEqual, p2shScript, p2pkScript } from "./kachat-names/codec.js";
import { decodeAddress, encodeAddress, p2shAddress } from "./kachat-names/registry-state.js";
import { NETWORK_ID } from "./network.js";
import { groupedAmountText } from "./amounts.js";
import templateJson from "../kusdt/kusdt-kcc20-template.json" with { type: "json" };

/** kUSDT has 6 decimals, like USDT. */
export const KUSDT_DECIMALS = 6;
export const KUSDT_SYMBOL = "kUSDT";
/** The token id in storage keys and history rows (iOS `WalletToken.kusdt.id`). */
export const KUSDT_TOKEN_ID = "kusdt";
/** What the screens say about it (iOS `WalletToken.kusdt`): USDT from Ethereum and BNB Chain, held
 *  1:1 in Trestly's vault and issued as a KCC-20 token on Kaspa L1 (mainnet launched 2026-11-15). */
export const KUSDT_TOKEN = Object.freeze({
  id: "kusdt",
  symbol: "kUSDT",
  name: "Bridged USDT",
  decimals: 6,
  isDollarStable: true,
  issuer: "Trestly",
  issuerSite: "https://trestly.io",
  backingURL: "https://etherscan.io/address/0xfa9869982542FB20baD929789B252b7b06EeE10e",
  /** KAS every token coin holds (tokenValue, 1.5 KAS): a send carries it to the recipient's coin. */
  kasPerCoinSompi: 150_000_000n,
});
const UNIT_SCALE = 10n ** BigInt(KUSDT_DECIMALS);
const U64_MAX = (1n << 64n) - 1n;

// MARK: - Deployment

/** kusdt-open `deployments/<network>.json` and `wallet/extension/src/config/defaults.ts`, as iOS
 *  `Kusdt.deployment(for:)`; the API bases are iOS `AppSettings.defaultTrestlyAPIURL(for:)`.
 *  `covenantId`: every kUSDT coin carries it (and so do the minter and its seed, which is why the
 *  script check matters too). `tokenValue`: the KAS (sompi) every new token coin carries for its
 *  storage mass (1.5 KAS). */
export const KUSDT_DEPLOYMENTS = Object.freeze({
  mainnet: Object.freeze({
    network: "mainnet",
    hrp: "kaspa",
    covenantId: "50b3477e7368d0c5bfbd64483b4607350ec411377972f33e40b2d4b6d1513fd3",
    poolId: "28e7758e6fc0e2054cceb7f87f9da44a53accfa0a1795c8075c80fb99c83aaad",
    tokenValue: 150_000_000n,
    positionValue: 200_000_000n,
    apiBase: "https://api.trestly.io/api/v1",
    siteUrl: "https://trestly.io",
  }),
  "testnet-10": Object.freeze({
    network: "testnet-10",
    hrp: "kaspatest",
    covenantId: "a1d9fd1347128011ad0036b077949d63274d5d3b8ac8351776c30c945ef2c2fb",
    poolId: "99445008e36139d0a57040f562414e298a3022fb739c0e9374b1dbb9f4c42171",
    tokenValue: 150_000_000n,
    positionValue: 200_000_000n,
    apiBase: "https://testnet.trestly.io/api/v1",
    siteUrl: "https://testnet.trestly.io",
  }),
});

/** The deployment of `network` ("mainnet" | "testnet-10"; "testnet" reads as testnet-10). Defaults
 *  to the network the page runs on (engine/network.js NETWORK_ID). */
export function kusdtDeployment(network = NETWORK_ID) {
  const id = network === "testnet" ? "testnet-10" : network;
  const d = KUSDT_DEPLOYMENTS[id];
  if (!d) throw new Error(`kUSDT has no deployment on ${network}`);
  return d;
}

// MARK: - Template

/** SHA-256 of `prefix ‖ suffix` as shipped (iOS `Kusdt.templateSHA256`): a resource that differs
 *  is refused. */
export const KUSDT_TEMPLATE_SHA256 = "e87405ef5a227167e373f94968432ccec6d792c47dce783a41f45c0095a97137";

/** A template `{ templateHash, prefix, suffix }` (Uint8Arrays) from its JSON, or null when it is
 *  unreadable or not the pinned one: SHA-256(prefix ‖ suffix) must be KUSDT_TEMPLATE_SHA256, the
 *  prefix 34 bytes ending in the template hash (iOS `Kusdt.template`). */
export function loadTemplate(json) {
  try {
    const templateHash = unhex(String(json?.templateHash ?? ""));
    const prefix = unhex(String(json?.prefix ?? ""));
    const suffix = unhex(String(json?.suffix ?? ""));
    if (templateHash.length !== 32) return null;
    if (hex(sha256(concat(prefix, suffix))) !== KUSDT_TEMPLATE_SHA256) return null;
    if (prefix.length !== 34 || !bytesEqual(prefix.slice(2), templateHash)) return null;
    return Object.freeze({ templateHash, prefix, suffix });
  } catch {
    return null;
  }
}

let pinned;
/** The pinned template (kusdt/kusdt-kcc20-template.json), or null if it isn't the pinned one:
 *  every kUSDT entry point then refuses with templateMissing. */
export function kusdtTemplate() {
  if (pinned === undefined) pinned = loadTemplate(templateJson);
  return pinned;
}

// MARK: - State

/** KCC-2 owner schemes (SPEC section 4). KaChat holds tokens only as 0x00 (a Schnorr key). */
export const OWNER_P2PK_SCHNORR = 0x00;
export const OWNER_P2SH = 0x03;
export const OWNER_COVENANT_ID = 0x04;
/** An encoded state is 112 bytes of explicit pushes. */
export const STATE_LENGTH = 112;

const ZERO32 = () => new Uint8Array(32);

/** A KCC20 coin's state `{ amount: bigint, owner: Uint8Array(32), ownerScheme, borrowScheme,
 *  borrowGuard: Uint8Array(32), extensionCommitment: Uint8Array(32) }` (iOS `Kusdt.State`). */
export function makeState({ amount, owner, ownerScheme, borrowScheme = 0, borrowGuard = ZERO32(), extensionCommitment = ZERO32() }) {
  const a = BigInt(amount);
  if (a < 0n || a > U64_MAX) throw new Error("kUSDT state: amount out of range");
  for (const [name, b] of [["owner", owner], ["borrowGuard", borrowGuard], ["extensionCommitment", extensionCommitment]]) {
    if (!(b instanceof Uint8Array) || b.length !== 32) throw new Error(`kUSDT state: ${name} must be 32 bytes`);
  }
  for (const [name, v] of [["ownerScheme", ownerScheme], ["borrowScheme", borrowScheme]]) {
    if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error(`kUSDT state: ${name} must be a byte`);
  }
  return { amount: a, owner, ownerScheme, borrowScheme, borrowGuard, extensionCommitment };
}

/** A plain coin of this key: Schnorr owner, nothing borrowed, no extension (the only kind KaChat
 *  shows or spends; SPEC section 5). */
export function plainState(owner, amount) {
  return makeState({ amount, owner, ownerScheme: OWNER_P2PK_SCHNORR });
}

/** Whether `state` is a plain coin of `owner` (iOS `State.isPlain(of:)`). */
export function isPlainStateOf(state, owner) {
  return !!state && state.ownerScheme === OWNER_P2PK_SCHNORR && bytesEqual(state.owner, owner)
    && state.borrowScheme === 0 && bytesEqual(state.borrowGuard, ZERO32())
    && bytesEqual(state.extensionCommitment, ZERO32());
}

/** Same state, field for field. */
export function sameState(a, b) {
  return !!a && !!b && a.amount === b.amount && bytesEqual(a.owner, b.owner) && a.ownerScheme === b.ownerScheme
    && a.borrowScheme === b.borrowScheme && bytesEqual(a.borrowGuard, b.borrowGuard)
    && bytesEqual(a.extensionCommitment, b.extensionCommitment);
}

/** `08 amount(8, LE) 20 owner 01 scheme 01 borrow 20 guard 20 extension` (112 bytes). */
export function encodeState(state) {
  const out = new Uint8Array(STATE_LENGTH);
  let a = BigInt(state.amount);
  out[0] = 0x08;
  for (let i = 0; i < 8; i += 1) { out[1 + i] = Number(a & 0xffn); a >>= 8n; }
  out[9] = 0x20; out.set(state.owner, 10);
  out[42] = 0x01; out[43] = state.ownerScheme;
  out[44] = 0x01; out[45] = state.borrowScheme;
  out[46] = 0x20; out.set(state.borrowGuard, 47);
  out[79] = 0x20; out.set(state.extensionCommitment, 80);
  return out;
}

/** The state of 112 encoded bytes, or null when they aren't one (the inverse of `encodeState`;
 *  an amount above 2^63 is refused, as the contract's i64 does). */
export function decodeState(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== STATE_LENGTH) return null;
  if (bytes[0] !== 0x08 || bytes[9] !== 0x20 || bytes[42] !== 0x01 || bytes[44] !== 0x01 || bytes[46] !== 0x20 || bytes[79] !== 0x20) return null;
  let amount = 0n;
  for (let i = 7; i >= 0; i -= 1) amount = (amount << 8n) | BigInt(bytes[1 + i]);
  if (amount >= 1n << 63n) return null;
  return makeState({
    amount, owner: bytes.slice(10, 42), ownerScheme: bytes[43], borrowScheme: bytes[45],
    borrowGuard: bytes.slice(47, 79), extensionCommitment: bytes.slice(80, 112),
  });
}

/** The state as Trestly's builder and API write it (hex32 fields, small ints, the amount a BigInt
 *  that `stringifyExact` writes as a bare integer). */
export function stateToJson(state) {
  return {
    amount: BigInt(state.amount), owner: hex(state.owner), ownerScheme: state.ownerScheme,
    borrowScheme: state.borrowScheme, borrowGuard: hex(state.borrowGuard),
    extensionCommitment: hex(state.extensionCommitment),
  };
}

/** A state as the API writes it (kusdt-open `parseTokenState`, iOS `KusdtBalances.state`): hex32
 *  fields, small ints, the amount a JSON integer or a string of digits; borrowScheme, borrowGuard
 *  and extensionCommitment default to zero. null when anything is off. */
export function stateFromJson(s) {
  if (!s || typeof s !== "object") return null;
  const amount = naturalU63(s.amount);
  const owner = hex32(s.owner);
  const scheme = naturalU63(s.ownerScheme);
  if (amount == null || owner == null || scheme == null || scheme > 255n) return null;
  const borrow = naturalU63(s.borrowScheme ?? 0);
  if (borrow == null || borrow > 255n) return null;
  const guard = hex32(s.borrowGuard ?? "0".repeat(64));
  const ext = hex32(s.extensionCommitment ?? "0".repeat(64));
  if (!guard || !ext) return null;
  return makeState({ amount, owner, ownerScheme: Number(scheme), borrowScheme: Number(borrow), borrowGuard: guard, extensionCommitment: ext });
}

/** Whether a builder's state JSON is exactly `state` (iOS `KusdtTransfer.sameState`). */
export function stateJsonMatches(j, state) {
  if (!j || typeof j !== "object") return false;
  return jsonU64(j.amount) === BigInt(state.amount)
    && String(j.owner ?? "").toLowerCase() === hex(state.owner)
    && jsonU64(j.ownerScheme) === BigInt(state.ownerScheme)
    && (jsonU64(j.borrowScheme) ?? 0n) === BigInt(state.borrowScheme)
    && String(j.borrowGuard ?? "").toLowerCase() === hex(state.borrowGuard)
    && String(j.extensionCommitment ?? "").toLowerCase() === hex(state.extensionCommitment);
}

// MARK: - Scripts and addresses

/** The coin's redeem script: `prefix ‖ state ‖ suffix`. */
export function redeemScript(state, template) {
  return concat(template.prefix, encodeState(state), template.suffix);
}

/** Its P2SH locking script (`OP_BLAKE2B <hash> OP_EQUAL`), script version 0. */
export function lockingScript(state, template) {
  return p2shScript(redeemScript(state, template));
}

/** The address the node lists the coin under, on `network`'s prefix. */
export function coinAddress(lockScript, network = NETWORK_ID) {
  return p2shAddress(lockScript, kusdtDeployment(network).hrp);
}

/** The KCC-2 owner an address stands for: a Schnorr key address's x-only key, on `network`'s
 *  prefix (iOS `Kusdt.schnorrOwner(of:)`). null for anything else: KaChat never holds tokens on a
 *  script (P2SH, quantum-safe) or ECDSA address, and an address of the other network is refused
 *  here (its script would be built from the payload alone). */
export function schnorrOwner(address, network = NETWORK_ID) {
  const decoded = decodeAddress(String(address ?? "").trim().toLowerCase());
  if (!decoded || decoded.hrp !== kusdtDeployment(network).hrp) return null;
  if (decoded.version !== 0 || decoded.payload.length !== 32) return null;
  return decoded.payload;
}

/** Whether an x-only key is a point on secp256k1. A key that isn't passes the address checksum,
 *  and nothing could ever sign for it: kUSDT sent there is lost for good (kusdt-open
 *  `address_script` refuses such a key for change; the transfer builder takes the owner bytes as
 *  given, so it's checked here for the recipient - a KaChat addition to iOS). */
export function isOnCurveXOnly(xonly) {
  try {
    secp256k1.Point.fromHex(`02${hex(xonly)}`).assertValidity();
    return true;
  } catch {
    return false;
  }
}

/** Whether `address` can hold and send kUSDT in KaChat: a Schnorr key address of `network` (the
 *  Chatting Address or a regular, legacy spending address). Never a quantum-safe or other script
 *  address: sending a token from one reveals its key, and Trestly's builder doesn't take one. */
export function canHoldKusdt(address, network = NETWORK_ID) {
  return schnorrOwner(address, network) != null;
}

/** The address of an x-only key on `network` (a token recipient written back as an address). */
export function addressOfOwner(owner, network = NETWORK_ID) {
  return encodeAddress(kusdtDeployment(network).hrp, 0, owner);
}

/** "0000" + the script's hex: the node's and the builder's scriptPublicKey form (2-byte version
 *  0, then the script). */
export function spkHex(script) { return `0000${hex(script)}`; }

/** The plain P2PK (Schnorr) script of `owner`, as change back to the sender is paid. */
export function senderScript(owner) { return p2pkScript(owner); }

/** "txid:index", the outpoint key every list here uses (txid lower case). */
export function outpointKey(transactionId, index) {
  return `${String(transactionId).toLowerCase()}:${Number(index)}`;
}

// MARK: - Amounts

/** "125.5" (or "125.50" with `keepCents`): no grouping, "." the decimal point - what an amount
 *  field types (Max). iOS `TokenAmount.typed`. */
export function typedKusdt(units, { keepCents = false } = {}) {
  const u = BigInt(units);
  const whole = u / UNIT_SCALE;
  let frac = String(u % UNIT_SCALE).padStart(KUSDT_DECIMALS, "0");
  const keep = keepCents ? 2 : 0;
  while (frac.length > keep && frac.endsWith("0")) frac = frac.slice(0, -1);
  return frac ? `${whole}.${frac}` : String(whole);
}

/** "125.50", "0.25", "1,250.00", "0.000001": grouped, at least two decimals (a dollar token),
 *  trailing zeros past that dropped. iOS `TokenAmount.plain`. */
export function plainKusdt(units, { commaDecimal = false } = {}) {
  return groupedAmountText(typedKusdt(units, { keepCents: true }), { commaDecimal });
}

/** "125.50 kUSDT" (iOS `TokenAmount.amount`). */
export function formatKusdt(units, opts = {}) {
  return `${plainKusdt(units, opts)} ${KUSDT_SYMBOL}`;
}

/** "$125.50": two decimals, rounded half to even as iOS's NumberFormatter does, in `locale`. */
export function kusdtDollars(units, locale = "en-US") {
  const u = BigInt(units);
  const per = UNIT_SCALE / 100n;
  let cents = u / per;
  const rest = u % per;
  if (rest * 2n > per || (rest * 2n === per && cents % 2n === 1n)) cents += 1n;
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })
      .format(Number(cents) / 100);
  } catch {
    return `$${groupedAmountText(`${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`)}`;
  }
}

/** Typed text ("12.5", "1,250.25") to base units; null for nothing, zero, more decimals than 6, or
 *  more than a u64 holds (iOS `TokenAmount.units(fromTyped:)`). */
export function kusdtUnitsFromText(text) {
  const clean = String(text ?? "").replaceAll(",", "");
  if (!clean) return null;
  const parts = clean.split(".");
  if (parts.length > 2) return null;
  const whole = parts[0] === "" ? "0" : parts[0];
  const fracText = parts.length === 2 ? parts[1] : "";
  if (!/^[0-9]+$/.test(whole) || !/^[0-9]*$/.test(fracText)) return null;
  if (fracText.length > KUSDT_DECIMALS) return null;
  const frac = BigInt((fracText + "0".repeat(KUSDT_DECIMALS - fracText.length)) || "0");
  const total = BigInt(whole) * UNIT_SCALE + frac;
  if (total <= 0n || total > U64_MAX) return null;
  return total;
}

// MARK: - Exact JSON (kusdt-open bridge/packages/core/src/exactJson.ts, MIT, Trestly)

/** The most digits kept as an exact integer: a uint256. Past it the text itself stays. */
const MAX_INTEGER_DIGITS = 78;

function exactInteger(token) {
  const m = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!m) return null;
  const digits = m[2] + (m[3] ?? "");
  const point = m[2].length + (m[4] ? Number(m[4]) : 0);
  const first = digits.search(/[1-9]/);
  if (first < 0) return null; // zero
  if (digits.slice(Math.max(point, 0)).search(/[1-9]/) >= 0) return null; // a fraction
  const count = point - first;
  if (count < 16) return null;
  if (count > MAX_INTEGER_DIGITS) return token;
  return m[1] + digits.slice(first, point).padEnd(count, "0");
}

function quoteLargeIntegers(text) {
  let out = "";
  let copied = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 34) { // a string: to its closing quote, past escapes
      i += 1;
      while (i < text.length && text.charCodeAt(i) !== 34) i += text.charCodeAt(i) === 92 ? 2 : 1;
      i += 1;
    } else if (c === 45 || (c >= 48 && c <= 57)) { // a number, fraction and exponent included
      const start = i;
      i += 1;
      for (; i < text.length; i += 1) {
        const d = text.charCodeAt(i);
        if (!((d >= 48 && d <= 57) || d === 46 || d === 101 || d === 69 || d === 43 || d === 45)) break;
      }
      const exact = exactInteger(text.slice(start, i));
      if (exact !== null) {
        out += `${text.slice(copied, start)}"${exact}"`;
        copied = i;
      }
    } else {
      i += 1;
    }
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/** JSON.parse that keeps every integer of 16 or more digits exact, as a string of digits. */
export function parseExactJson(text) {
  return JSON.parse(quoteLargeIntegers(String(text)));
}

/** JSON.stringify that writes BigInt values as exact JSON integers. */
export function stringifyExact(value) {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Uint8Array) return JSON.stringify(hex(value));
  if (typeof value.toJSON === "function") return stringifyExact(value.toJSON());
  if (Array.isArray(value)) return `[${value.map((v) => stringifyExact(v) ?? "null").join(",")}]`;
  const fields = [];
  for (const [k, v] of Object.entries(value)) {
    const written = stringifyExact(v);
    if (written !== undefined) fields.push(`${JSON.stringify(k)}:${written}`);
  }
  return `{${fields.join(",")}}`;
}

/** A non-negative u64 from a JSON number (a safe integer) or a string of digits; null otherwise
 *  (a Bool, a fraction, a negative, anything bigger than a u64). iOS `KusdtTransfer.number`. */
export function jsonU64(v) {
  if (typeof v === "string") {
    if (!/^[0-9]+$/.test(v)) return null;
    const n = BigInt(v);
    return n <= U64_MAX ? n : null;
  }
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v === "bigint") return v >= 0n && v <= U64_MAX ? v : null;
  return null;
}

/** A non-negative integer under 2^63 (iOS `KusdtBalances.natural`). */
export function naturalU63(v) {
  const n = jsonU64(v);
  return n != null && n < 1n << 63n ? n : null;
}

function hex32(v) {
  if (typeof v !== "string" || v.length !== 64 || !/^[0-9a-fA-F]+$/.test(v)) return null;
  return unhex(v.toLowerCase());
}
