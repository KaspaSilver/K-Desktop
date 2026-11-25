// The Explorer's data and rules (K 961fc05a, Views/Explorer/ExplorerAPI.swift, ExplorerModels.swift,
// ExplorerChartView.swift): K's own block explorer. Pure: no DOM, no storage, no fetch. The screen
// (ui/explorer.js) asks kaspa.stream's REST API (api.kaspa.stream; api-tn10.kaspa.stream on
// testnet-10), K's indexer (/stats) and Kaspalytics, and hands the answers to these functions.
//
// Transactions are labelled by what they are in K from their payload's first bytes and the
// covenants they touch (`classifyTransaction`, K's ExplorerAPI.classify). Amounts are sompi as
// Numbers: kaspa.stream's JSON numbers are doubles already, and nothing here is spent.

import { KUSDT_DEPLOYMENTS } from "./kusdt.js";
import { ARENA_CHANNEL } from "./chess-tournament.js";
import { CHESS_BOTS_CHANNEL } from "./chess-bot.js";

/** K's ArcadeStamp.channel: KaPlay's arcade scores (engine/broadcasts.js SERVICE_BROADCAST_CHANNELS). */
export const ARCADE_CHANNEL = "kplay-arcade";

/** kaspa.stream for the network (K ExplorerAPI.baseURL). */
export function explorerApiBase(networkId) {
  return networkId === "mainnet" ? "https://api.kaspa.stream" : "https://api-tn10.kaspa.stream";
}

// MARK: - Kinds (K ExplorerTxKind)

/** Every kind, with K's title, plural (K Activity), explanation and glyph. Order is K's. */
export const TX_KINDS = Object.freeze({
  payment: { title: "Payment", plural: "Payments", icon: "arrows", explanation: "Kaspa sent from one address to another." },
  kachatMessage: { title: "KaChat Message", plural: "KaChat Messages", icon: "lock", explanation: "An end-to-end encrypted KaChat message. Only the two people in the chat can read it." },
  handshake: { title: "Handshake", plural: "Handshakes", icon: "wave", explanation: "Opens an encrypted KaChat chat between two addresses." },
  paymentNotice: { title: "Payment Notice", plural: "Payment Notices", icon: "bell", explanation: "Tells a chat about a payment made from another address." },
  kapost: { title: "KaPost", plural: "KaPosts", icon: "post", explanation: "A public post on KaPost, signed by its author." },
  publicChat: { title: "Public Chat", plural: "Public Chat Messages", icon: "hash", explanation: "A message in a public chat room, readable by anyone." },
  kachatName: { title: "Username", plural: "Username Actions", icon: "at", explanation: "A .kachat username registered, renewed or traded on the registry." },
  kusdtTransfer: { title: "kUSDT Transfer", plural: "kUSDT Transfers", icon: "dollar", explanation: "kUSDT, a dollar token on Kaspa, moved between addresses." },
  kusdtSwap: { title: "Swap", plural: "Swaps", icon: "swap", explanation: "KAS and kUSDT swapped through Trestly's pool." },
  chessMove: { title: "Chess Move", plural: "Chess Moves", icon: "board", explanation: "A move in an online chess game, played in KaPlay." },
  arcadeStamp: { title: "Arcade Score", plural: "Arcade Scores", icon: "controller", explanation: "A KaPlay arcade score, stamped on chain so anyone can replay it." },
  coinbase: { title: "Mining Reward", plural: "Mining Rewards", icon: "hammer", explanation: "New KAS paid to miners for the blocks they found." },
  other: { title: "Transaction", plural: "Transactions", icon: "cube", explanation: "A Kaspa transaction." },
});

/** One of K's own protocols (the K Activity list shows only these). */
export function isKKind(kind) {
  return kind !== "payment" && kind !== "coinbase" && kind !== "other" && Boolean(TX_KINDS[kind]);
}

/** How much of a payload a list reads for its kind: K's prefixes, an action and a room's name all
 *  fit in the first 128 bytes, so a 100 KB photo isn't decoded to label a row. */
export const KIND_PREFIX_HEX_LENGTH = 256;

const LOOSE_UTF8 = new TextDecoder("utf-8");
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

function hexBytes(hex) {
  const clean = String(hex || "").trim().toLowerCase();
  if (!clean || clean.length % 2 || !/^[0-9a-f]+$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A payload's text as a one-paragraph preview (K String.trimmedPreview). */
export function trimmedPreview(text) {
  const flat = String(text ?? "").trim();
  if (!flat) return null;
  const chars = [...flat];
  return chars.length > 280 ? `${chars.slice(0, 280).join("")}…` : flat;
}

/** The covenant ids of kUSDT and its pool on `network`. */
function kusdtIds(network) {
  const d = KUSDT_DEPLOYMENTS[network === "mainnet" ? "mainnet" : "testnet-10"];
  return { pool: d.poolId, token: d.covenantId };
}

/**
 * A transaction's kind and what K can show of it (K ExplorerAPI.classify): K's own protocols
 * (`kchat:1:`, the older `ciph_msg:`, KaPost's legacy `k:1:`), kUSDT and its pool, and mining
 * rewards. Lists read only the payload's first bytes and leave `decoded` null; `full` (a
 * transaction's own page) decodes it all. `parsePost(text)` is KaPost's chain payload parser
 * (engine/kaposts.js parseChainPayload), used only with `full`.
 * @returns {{ kind: string, decoded: string|null }}
 */
export function classifyTransaction({ payloadHex, subnetwork = null, covenants = [], network = "mainnet", full = false, parsePost = null } = {}) {
  if (typeof subnetwork === "string" && subnetwork.startsWith("01")) return { kind: "coinbase", decoded: null };
  const ids = kusdtIds(network);
  const lowered = (covenants || []).map((c) => String(c || "").toLowerCase());
  if (lowered.includes(ids.pool)) return { kind: "kusdtSwap", decoded: null };
  if (lowered.includes(ids.token)) return { kind: "kusdtTransfer", decoded: null };
  const hex = String(payloadHex || "");
  if (!hex) return { kind: "payment", decoded: null };
  let text;
  if (full) {
    const bytes = hexBytes(hex);
    if (!bytes) return { kind: "payment", decoded: null };
    // K's payloads start with plain text; anything else is some other app's
    try { text = STRICT_UTF8.decode(bytes); } catch { return { kind: "other", decoded: null }; }
  } else {
    const bytes = hexBytes(hex.slice(0, KIND_PREFIX_HEX_LENGTH - (KIND_PREFIX_HEX_LENGTH % 2)));
    if (!bytes) return { kind: "payment", decoded: null };
    // cut mid-character at worst: only the prefixes below are compared
    text = LOOSE_UTF8.decode(bytes);
  }
  const postText = () => (full && typeof parsePost === "function" ? trimmedPreview(parsePost(text)?.message) : null);
  let rest;
  if (text.startsWith("kchat:1:")) rest = text.slice("kchat:1:".length);
  else if (text.startsWith("ciph_msg:1:")) rest = text.slice("ciph_msg:1:".length);
  else if (text.startsWith("ciph_msg:")) rest = text.slice("ciph_msg:".length);
  else if (text.startsWith("k:1:")) return { kind: "kapost", decoded: postText() };
  else return { kind: "other", decoded: null };
  const colon = rest.indexOf(":");
  const action = colon < 0 ? rest : rest.slice(0, colon);
  rest = colon < 0 ? "" : rest.slice(colon + 1);
  switch (action) {
    case "handshake": case "self_stash": return { kind: "handshake", decoded: null };
    case "comm": case "gcomm": case "gctl": case "dm": return { kind: "kachatMessage", decoded: null };
    case "pay": case "tip": return { kind: "payment", decoded: null };
    case "name": case "offer": case "profile": return { kind: "kachatName", decoded: null };
    case "bcast": {
      const at = rest.indexOf(":");
      const channel = at < 0 ? rest : rest.slice(0, at);
      const content = at < 0 ? "" : rest.slice(at + 1);
      if (channel === ARENA_CHANNEL || channel === CHESS_BOTS_CHANNEL) return { kind: "chessMove", decoded: null };
      if (channel === ARCADE_CHANNEL) return { kind: "arcadeStamp", decoded: null };
      return { kind: "publicChat", decoded: full ? trimmedPreview(`#${channel}: ${content}`) : null };
    }
    // post, reply, quote, vote, follow...: KaPost shares the root
    default: return { kind: "kapost", decoded: postText() };
  }
}

/** A transaction a list built, with its payload read in full for its own page (K readFully). */
export function readFully(tx, { network = "mainnet", parsePost = null } = {}) {
  if (!tx || tx.decoded != null || (tx.kind !== "kapost" && tx.kind !== "publicChat")) return tx;
  const { decoded } = classifyTransaction({ payloadHex: tx.payloadHex, network, full: true, parsePost });
  return { ...tx, decoded };
}

// MARK: - Numbers as the APIs send them

/** A u64 as the node's JSON writes it: a string, a number or a BigInt; 0 when missing or bad. */
export function flexNumber(value) {
  if (typeof value === "bigint") return Number(value);
  if (value == null || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** KAS from an API as sompi, never NaN or negative (K ExplorerAPI.sompi(fromKAS:)). */
export function sompiFromKas(kas) {
  const n = Number(kas);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1e8) : 0;
}

// MARK: - Mapping (K ExplorerAPI.transaction / block)

/** A transaction as the indexer keeps it (`/transactions/{id}`, an address's history). */
export function transactionFromIndexed(tx, { virtualBlueScore = null, network = "mainnet", full = false, parsePost = null, now = Date.now() } = {}) {
  const rawInputs = Array.isArray(tx?.inputs) ? tx.inputs : [];
  const rawOutputs = Array.isArray(tx?.outputs) ? tx.outputs : [];
  const inputs = rawInputs.map((input, offset) => ({
    index: Number.isInteger(input?.index) ? input.index : offset,
    address: String(input?.previous_outpoint_address || ""),
    amount: flexNumber(input?.previous_outpoint_amount),
  }));
  const outputs = rawOutputs.map((output, offset) => ({
    index: Number.isInteger(output?.index) ? output.index : offset,
    address: String(output?.script_public_key_address || ""),
    amount: flexNumber(output?.amount),
  }));
  const covenants = [...rawInputs, ...rawOutputs].map((io) => io?.covenant_id).filter(Boolean);
  const { kind, decoded } = classifyTransaction({ payloadHex: tx?.payload, subnetwork: tx?.subnetwork_id, covenants, network, full, parsePost });
  // the fee is only known when every input's amount came back
  const resolved = rawInputs.length > 0 && rawInputs.every((input) => input?.previous_outpoint_amount != null);
  const inSum = inputs.reduce((s, io) => s + io.amount, 0);
  const outSum = outputs.reduce((s, io) => s + io.amount, 0);
  const fee = kind === "coinbase" ? 0 : (resolved && inSum >= outSum ? inSum - outSum : null);
  let confirmations = 0;
  const accepted = flexNumber(tx?.accepting_block_blue_score);
  if (tx?.is_accepted === true && accepted && virtualBlueScore) {
    confirmations = Math.max(0, virtualBlueScore - accepted) + 1;
  }
  return {
    id: String(tx?.transaction_id || ""),
    kind,
    time: Number(tx?.block_time) || now,
    blockHash: Array.isArray(tx?.block_hash) && tx.block_hash.length ? String(tx.block_hash[0]) : null,
    confirmations,
    fee,
    mass: flexNumber(tx?.mass),
    inputs,
    outputs,
    payloadHex: String(tx?.payload || ""),
    tokenUnits: null,
    decoded,
    isAccepted: tx?.is_accepted === true ? true : tx?.is_accepted === false ? false : null,
  };
}

/** An output's address from a node block: its verbose data, else `addressOf(output)`. */
function nodeOutputAddress(output, addressOf) {
  const verbose = output?.verboseData || output?.verbose_data || null;
  const direct = String(verbose?.scriptPublicKeyAddress || verbose?.script_public_key_address || "");
  if (direct) return direct;
  if (typeof addressOf === "function") { try { return String(addressOf(output) || ""); } catch { return ""; } }
  return "";
}

/**
 * A block as the node shows it, for both kaspa.stream's `/blocks/{hash}` (the node's JSON) and a
 * block-added notification from K's own node (the WASM SDK's objects: `value` for an output's
 * amount, BigInt u64s, `parentsByLevel`). Its transactions carry outputs only: an input is just
 * the coin it spends, so its address and amount aren't known (shown as "–").
 */
export function blockFromNode(block, { network = "mainnet", addressOf = null } = {}) {
  const header = block?.header || {};
  const verbose = block?.verboseData || block?.verbose_data || {};
  const hash = String(verbose.hash || header.hash || "");
  const time = flexNumber(header.timestamp);
  const parents = Array.isArray(header.parents) ? (header.parents[0]?.parentHashes || header.parents[0]?.parent_hashes || [])
    : Array.isArray(header.parentsByLevel) ? (header.parentsByLevel[0] || []) : [];
  const ids = Array.isArray(verbose.transactionIds) ? verbose.transactionIds : [];
  const transactions = (Array.isArray(block?.transactions) ? block.transactions : []).map((tx, offset) => {
    const txVerbose = tx?.verboseData || tx?.verbose_data || null;
    const outputs = (Array.isArray(tx?.outputs) ? tx.outputs : []).map((output, index) => ({
      index,
      address: nodeOutputAddress(output, addressOf),
      amount: flexNumber(output?.amount ?? output?.value),
    }));
    const covenants = (Array.isArray(tx?.outputs) ? tx.outputs : []).map((o) => o?.covenantId || o?.covenant_id).filter(Boolean);
    const { kind, decoded } = classifyTransaction({ payloadHex: payloadHexOf(tx?.payload), subnetwork: String(tx?.subnetworkId ?? tx?.subnetwork_id ?? ""), covenants, network });
    return {
      id: String(txVerbose?.transactionId || txVerbose?.transaction_id || ids[offset] || ""),
      kind,
      time,
      blockHash: hash,
      confirmations: 0,
      fee: kind === "coinbase" ? 0 : null,
      mass: flexNumber(tx?.mass),
      inputs: (Array.isArray(tx?.inputs) ? tx.inputs : []).map((_, index) => ({ index, address: "", amount: 0 })),
      outputs,
      payloadHex: payloadHexOf(tx?.payload),
      tokenUnits: null,
      decoded,
      isAccepted: null,
    };
  }).filter((tx) => tx.id);
  return {
    id: hash,
    blueScore: flexNumber(header.blueScore ?? verbose.blueScore),
    daaScore: flexNumber(header.daaScore),
    time,
    isChainBlock: verbose.isChainBlock === true,
    difficulty: Number(verbose.difficulty) || 0,
    parents: parents.map(String),
    children: (Array.isArray(verbose.childrenHashes) ? verbose.childrenHashes : []).map(String),
    mergeSetBlues: Array.isArray(verbose.mergeSetBluesHashes) ? verbose.mergeSetBluesHashes.length : 0,
    mergeSetReds: Array.isArray(verbose.mergeSetRedsHashes) ? verbose.mergeSetRedsHashes.length : 0,
    transactionIds: ids.map(String),
    transactions,
  };
}

/** A payload as hex, whatever the SDK handed over (string, bytes). */
export function payloadHexOf(payload) {
  if (payload == null) return "";
  if (typeof payload === "string") return payload.trim().toLowerCase();
  let bytes = null;
  if (payload instanceof Uint8Array) bytes = payload;
  else if (Array.isArray(payload)) bytes = Uint8Array.from(payload);
  else if (ArrayBuffer.isView(payload)) bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  if (!bytes) return "";
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// MARK: - What a transaction did (K ExplorerTransaction)

export function isNotAccepted(tx) { return tx?.isAccepted === false; }
export function isInMempool(tx) { return !tx?.blockHash; }

/** What it moved, change excluded: the outputs that don't go back to the first input's address.
 *  Null when that can't be told: a transaction read off the node has no input addresses, so its
 *  change can't be picked out (a 1 KAS payment from a 10,000 KAS coin would read 10,000). One
 *  output has no change. */
export function movedAmount(tx) {
  const inputs = tx?.inputs || [];
  const outputs = tx?.outputs || [];
  const addressesKnown = inputs.length === 0 || inputs.some((io) => io.address);
  if (!addressesKnown) return outputs.length === 1 ? outputs[0].amount : null;
  const from = inputs[0]?.address;
  const away = outputs.filter((io) => io.address !== from);
  // a self-send (a message, a post) moves its first output's amount
  if (!away.length) return outputs[0]?.amount ?? 0;
  return away.reduce((s, io) => s + io.amount, 0);
}

/** What it did to `address`: what came to it less what it spent, as a direction and an amount. */
export function netFor(tx, address) {
  const into = (tx?.outputs || []).filter((io) => io.address === address).reduce((s, io) => s + io.amount, 0);
  const out = (tx?.inputs || []).filter((io) => io.address === address).reduce((s, io) => s + io.amount, 0);
  return into >= out ? { isIncoming: true, amount: into - out } : { isIncoming: false, amount: out - into };
}

/** An address page's history: unaccepted mining rewards left out entirely (owner, 2026-11-25),
 *  since every block merging a found block carries one and only one counts. Other unaccepted
 *  transactions stay, marked Not Accepted. */
export function addressHistory(transactions) {
  return (transactions || []).filter((tx) => !(tx.kind === "coinbase" && isNotAccepted(tx)));
}

/** Received and sent over the last 30 days from the first page of history (what the network
 *  accepted only), and whether that page reaches back far enough to be complete. */
export function addressSummary(transactions, address, { nextPageBefore = null, now = Date.now() } = {}) {
  const monthAgo = now - 30 * 86_400_000;
  let received = 0;
  let sent = 0;
  for (const tx of transactions || []) {
    if (tx.time < monthAgo || isNotAccepted(tx)) continue;
    const net = netFor(tx, address);
    if (net.isIncoming) received += net.amount; else sent += net.amount;
  }
  const last = (transactions || [])[transactions.length - 1];
  const coversMonth = nextPageBefore == null || (last ? last.time < monthAgo : true);
  return { received30d: received, sent30d: sent, summaryCoversMonth: coversMonth };
}

/** Address pages load 20, then 40 per Load More (K ExplorerAPI.firstAddressPage / laterAddressPage). */
export const FIRST_ADDRESS_PAGE = 20;
export const LATER_ADDRESS_PAGE = 40;

/** Where the next page starts: kaspa.stream's `x-next-page-before`, none once a page came back short. */
export function nextPageCursor(count, limit, header) {
  if (count < limit) return null;
  const n = Number(header);
  return header != null && header !== "" && Number.isFinite(n) ? n : null;
}

// MARK: - Search (K ExplorerView.lookUpTyped / ExplorerAPI.search)

/** A Kaspa address anywhere in pasted text ("send to kaspa:qq…, thanks"). */
export function addressIn(text) {
  const match = /kaspa(test)?:[a-z0-9]{50,70}/.exec(String(text || "").toLowerCase());
  return match ? match[0] : null;
}

/** What typed text is: "address" (starts with kaspa:/kaspatest:), "id" (64 hex), "name", or "". */
export function queryKind(text) {
  let lower = String(text || "").trim().toLowerCase();
  const found = addressIn(lower);
  if (found) lower = found;
  if (!lower) return { kind: "", value: "" };
  if (lower.startsWith("kaspa:") || lower.startsWith("kaspatest:")) return { kind: "address", value: lower };
  if (lower.length === 64 && /^[0-9a-f]+$/.test(lower)) return { kind: "id", value: lower };
  return { kind: "name", value: String(text || "").trim() };
}

// MARK: - Formatting (K ExplorerFormat)

const enGrouped = new Intl.NumberFormat("en-US");

export function grouped(value) {
  const n = Number(value);
  return Number.isFinite(n) ? enGrouped.format(Math.max(0, Math.floor(n))) : "0";
}

/** An address split into two even lines. */
export function twoLines(text) {
  const s = String(text || "");
  if (s.length <= 30) return s;
  const half = Math.ceil(s.length / 2);
  return `${s.slice(0, half)}\n${s.slice(half)}`;
}

/** "kaspa:qzkw...q6w9" (owner, 2026-11-25), "a805f2…9eb9ae". */
export function shortId(text) {
  const s = String(text || "");
  if (s.length <= 18) return s;
  const colon = s.indexOf(":");
  const prefix = colon >= 0 ? s.slice(0, colon + 1) : "";
  const body = colon >= 0 ? s.slice(colon + 1) : s;
  if (body.length <= 14) return s;
  if (prefix) return `${prefix}${body.slice(0, 4)}...${body.slice(-4)}`;
  return `${body.slice(0, 6)}…${body.slice(-6)}`;
}

const relative = new Intl.RelativeTimeFormat("en", { style: "short", numeric: "always" });
/** "just now", "12 sec. ago", "3 min. ago", "2 hr. ago", "4 days ago" (K ExplorerFormat.ago). */
export function ago(time, now = Date.now()) {
  const seconds = Math.max(0, (now - Number(time)) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return relative.format(-Math.floor(seconds), "second");
  if (seconds < 3600) return relative.format(-Math.floor(seconds / 60), "minute");
  if (seconds < 86_400) return relative.format(-Math.floor(seconds / 3600), "hour");
  if (seconds < 7 * 86_400) return relative.format(-Math.floor(seconds / 86_400), "day");
  if (seconds < 30 * 86_400) return relative.format(-Math.floor(seconds / (7 * 86_400)), "week");
  if (seconds < 365 * 86_400) return relative.format(-Math.floor(seconds / (30 * 86_400)), "month");
  return relative.format(-Math.floor(seconds / (365 * 86_400)), "year");
}

/** H/s with its unit, two decimals: "323.28 PH/s". */
export function hashrateText(hashesPerSecond) {
  const units = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s", "ZH/s"];
  let value = Number(hashesPerSecond) || 0;
  let index = 0;
  while (value >= 1000 && index < units.length - 1) { value /= 1000; index += 1; }
  return `${value.toFixed(2)} ${units[index]}`;
}

export function difficultyText(value) {
  return (Number(value) || 0).toExponential(3);
}

const fraction = (min, max) => new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });
const compact = (max) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: max });

/** A block reward, up to four decimals: "1.9446 KAS". */
export function rewardText(sompi, unit = "KAS") {
  return `${fraction(2, 4).format((Number(sompi) || 0) / 1e8)} ${unit}`;
}

/** "$2.34B". */
export function compactUsd(dollars) {
  return `$${compact(2).format(Number(dollars) || 0)}`;
}

/** "26.18B KAS". */
export function compactKas(sompi, unit = "KAS") {
  return `${compact(2).format((Number(sompi) || 0) / 1e8)} ${unit}`;
}

/** A row's amount: "1.25 KAS", "12.3K KAS". */
export function shortKas(sompi, unit = "KAS") {
  const kas = (Number(sompi) || 0) / 1e8;
  return `${kas >= 1000 ? compact(1).format(kas) : fraction(0, 2).format(kas)} ${unit}`;
}

/** Sompi in full, up to eight decimals: "1,234.5 KAS" (K KaspaUnit.amount). */
export function kasAmount(sompi, unit = "KAS") {
  return `${fraction(0, 8).format((Number(sompi) || 0) / 1e8)} ${unit}`;
}

export function usdText(dollars) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(dollars) || 0);
}

/** "6 days", "1 day" or "hours" until `date`. */
export function daysUntil(date, now = Date.now()) {
  const days = Math.floor(Math.max(0, Number(date) - now) / 86_400_000);
  if (days === 0) return "hours";
  if (days === 1) return "1 day";
  return `${days} days`;
}

/** "4.2%", "15.1%", "27,743%": big changes lose their decimals. */
export function percentText(change) {
  const size = Math.abs(Number(change) || 0);
  return `${size >= 100 ? fraction(0, 0).format(size) : fraction(1, 1).format(size)}%`;
}

/** What a transaction moved for its row or hero: kUSDT for a token transaction, else KAS; "–" when
 *  it can't be told (read off the node, its change unknown). `formatKusdt(units)` for tokens. */
export function amountLine(tx, { short = false, unit = "KAS", formatKusdt = null } = {}) {
  if (tx?.tokenUnits != null && typeof formatKusdt === "function") return formatKusdt(tx.tokenUnits);
  const moved = movedAmount(tx);
  if (moved == null) return "–";
  return short ? shortKas(moved, unit) : kasAmount(moved, unit);
}

/** An address page's row amount: what the transaction did to that address, "+" or "−". */
export function perspectiveAmount(tx, address, unit = "KAS") {
  const net = netFor(tx, address);
  return `${net.isIncoming ? "+" : "−"}${shortKas(net.amount, unit)}`;
}

// MARK: - Charts (K ExplorerChartView, ExplorerKPeriod)

export const PERIODS = Object.freeze([
  { id: "day", title: "24 Hours" },
  { id: "week", title: "7 Days" },
  { id: "month", title: "30 Days" },
  { id: "allTime", title: "All Time" },
]);
export const periodTitle = (id) => PERIODS.find((p) => p.id === id)?.title || "";

/** Kaspa's mainnet launch (All Time starts here), Crescendo (ten blocks a second) and the chromatic
 *  emission phase. Unix ms. */
export const MAINNET_LAUNCH = 1_636_329_600_000; // 2021-11-08
export const CRESCENDO = 1_746_403_200_000; // 2025-05-05
export const CHROMATIC_START = 1_651_536_000_000; // 2022-05-03
const MONTH_MS = 30.44 * 86_400_000;

/** KAS a block pays: 500 a second before the chromatic phase, then 440 falling by 2^(1/12) every
 *  month; one block a second before Crescendo, ten after. */
export function rewardPerBlock(date) {
  const t = Number(date);
  const perSecond = t < CHROMATIC_START ? 500 : 440 * Math.pow(0.5, Math.floor((t - CHROMATIC_START) / MONTH_MS) / 12);
  return t < CRESCENDO ? perSecond : perSecond / 10;
}

/** The block reward over `period` from the emission schedule, oldest first (K series(.blockReward)). */
export function blockRewardSeries(period, now = Date.now()) {
  const [start, count] = period === "day" ? [now - 86_400_000, 96]
    : period === "week" ? [now - 7 * 86_400_000, 168]
    : period === "month" ? [now - 30 * 86_400_000, 120]
    : [MAINNET_LAUNCH, 200];
  const step = (now - start) / (count - 1);
  return Array.from({ length: count }, (_, i) => { const date = start + i * step; return { date, value: rewardPerBlock(date) }; });
}

/** Market cap from a price history: each price times the supply as it stood then, worked back from
 *  today's supply (KAS) along the emission schedule (K ExplorerDemo.marketCap). */
export function marketCapSeries(prices, supplyNowKas, now = Date.now()) {
  if (!(supplyNowKas > 0) || !prices?.length) return [];
  let supply = supplyNowKas;
  let later = now;
  const out = [];
  for (let i = prices.length - 1; i >= 0; i -= 1) {
    const point = prices[i];
    const mid = point.date + (later - point.date) / 2;
    const perSecond = rewardPerBlock(mid) * (mid < CRESCENDO ? 1 : 10);
    supply -= perSecond * Math.max(0, later - point.date) / 1000;
    out.push({ date: point.date, value: point.value * Math.max(supply, 0) });
    later = point.date;
  }
  return out.reverse();
}

/** At most `limit` points, evenly picked (K ExplorerAPI.downsample). */
export function downsample(points, limit = 240) {
  if (!Array.isArray(points) || points.length <= limit) return points || [];
  const step = (points.length - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, i) => points[Math.round(i * step)]);
}

const pad2 = (n) => String(n).padStart(2, "0");
const utcDay = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; };
const utcMonth = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`; };

/** Which kaspa.stream hashrate histories `period` needs, and where it starts (K hashrateHistory):
 *  24 Hours the two UTC days it spans, 7 / 30 Days the months, All Time the weekly series. */
export function hashrateRequests(period, now = Date.now()) {
  if (period === "day") {
    const since = now - 86_400_000;
    return { since, paths: [...new Set([utcDay(since), utcDay(now)])].map((d) => `/info/hashrate/history/${d}`) };
  }
  if (period === "week" || period === "month") {
    const since = now - (period === "week" ? 7 : 30) * 86_400_000;
    return { since, paths: [...new Set([utcMonth(since), utcMonth(now)])].map((m) => `/info/hashrate/history/${m}`) };
  }
  return { since: 0, paths: ["/info/hashrate/history?resolution=7d"] };
}

/** kaspa.stream's hashrate samples as points in H/s (`hashrate_kh` x 1000), from `since`, oldest
 *  first, at most 240. */
export function hashratePoints(samples, since = 0) {
  const points = (Array.isArray(samples) ? samples : [])
    .map((s) => ({ date: Number(s?.timestamp), value: Number(s?.hashrate_kh) * 1000 }))
    .filter((p) => Number.isFinite(p.date) && Number.isFinite(p.value) && p.date >= since)
    .sort((a, b) => a.date - b.date);
  return downsample(points, 240);
}

/** A price feed's [[ms, price]] as points, oldest first, at most 240. */
export function pricePoints(pairs) {
  const points = (Array.isArray(pairs) ? pairs : [])
    .map((p) => ({ date: Number(p?.[0]), value: Number(p?.[1]) }))
    .filter((p) => Number.isFinite(p.date) && Number.isFinite(p.value))
    .sort((a, b) => a.date - b.date);
  return downsample(points, 240);
}

/** Days CoinGecko is asked for (0: all time; K priceHistory). */
export function priceDays(period) {
  return period === "day" ? 1 : period === "week" ? 7 : period === "month" ? 30 : 0;
}

/** Each chart's name, glyph, explanation and number format (K ExplorerChartMetric). */
export const METRICS = Object.freeze({
  hashrate: { title: "Hashrate", icon: "bolt", explanation: "How many hashes a second miners point at Kaspa. More hashrate makes the network harder to attack." },
  price: { title: "KAS Price", icon: "kaspa", explanation: "The price of one KAS in US dollars." },
  blockReward: { title: "Block Reward", icon: "hammer", stepped: true, explanation: "New KAS a block pays its miner. It drops a little every month and halves every year. In May 2025 blocks went from one to ten a second, so each block's reward became a tenth." },
  marketCap: { title: "Market Cap", icon: "chart", explanation: "The price of KAS times every KAS mined so far." },
  networkFees: { title: "Network Fees", icon: "gauge", bars: true, explanation: "Everything paid to get transactions into blocks, added up per day or month. The home screen shows the average fee one transaction paid yesterday." },
});

/** Network Fees has no 24 Hours: Kaspalytics' totals are daily. */
export function metricPeriods(metric) {
  return metric === "networkFees" ? PERIODS.filter((p) => p.id !== "day") : [...PERIODS];
}

export function metricFormat(metric, value, unit = "KAS") {
  const v = Number(value) || 0;
  switch (metric) {
    case "hashrate": return hashrateText(v);
    case "price": return v < 0.01 ? `$${v.toFixed(5)}` : `$${v.toFixed(4)}`;
    case "blockReward": return `${fraction(2, 4).format(v)} ${unit}`;
    case "marketCap": return compactUsd(v);
    // a single fee is tiny, a month's total is thousands
    case "networkFees": return `${v >= 1 ? fraction(1, 1).format(v) : fraction(2, 6).format(v)} ${unit}`;
    default: return String(v);
  }
}

/** Shorter, for the chart's axis. */
export function metricAxisLabel(metric, value) {
  const v = Number(value) || 0;
  if (v === 0) return metric === "price" || metric === "marketCap" ? "$0" : "0";
  switch (metric) {
    case "hashrate": return hashrateText(v);
    case "price": return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(3)}`;
    case "blockReward": return fraction(0, 2).format(v);
    case "marketCap": return compactUsd(v);
    case "networkFees": return compact(1).format(v);
    default: return String(v);
  }
}

/** High, low and average; for bars the one still filling is left out (it would pull Low down). */
export function chartSummary(points, { bars = false } = {}) {
  const values = (bars ? (points || []).slice(0, -1) : (points || [])).map((p) => p.value);
  if (!values.length) return { high: 0, low: 0, average: 0 };
  return { high: Math.max(...values), low: Math.min(...values), average: values.reduce((s, v) => s + v, 0) / values.length };
}

/** Percent from the first point to `value`. */
export function chartChange(points, value) {
  const first = points?.[0]?.value || 0;
  return first > 0 ? ((value ?? first) - first) / first * 100 : 0;
}

/** The point nearest `date`; for bars, the bar whose span holds it. */
export function nearestPoint(points, date, { bars = false } = {}) {
  if (!points?.length) return null;
  if (bars) return [...points].reverse().find((p) => p.date <= date) || points[0];
  let best = points[0];
  for (const p of points) if (Math.abs(p.date - date) < Math.abs(best.date - date)) best = p;
  return best;
}

// MARK: - Network fees (Kaspalytics; K ExplorerKStats.loadKaspalytics)

/** Kaspalytics' undocumented chart API: daily since 2023-10, all of Kaspa, mainnet only. */
export const KASPALYTICS_FEES = "https://www.kaspalytics.com/api/charts/transactions/accepted/fees";

/** One dataset of a Kaspalytics chart answer as points, oldest first. */
export function kaspalyticsPoints(answer, label) {
  const labels = Array.isArray(answer?.labels) ? answer.labels : [];
  const data = (Array.isArray(answer?.datasets) ? answer.datasets : []).find((d) => d?.label === label)?.data;
  if (!Array.isArray(data)) return [];
  const out = [];
  labels.forEach((text, i) => {
    const value = data[i];
    const date = Date.parse(String(text));
    if (value == null || !Number.isFinite(Number(value)) || !Number.isFinite(date)) return;
    out.push({ date, value: Number(value) });
  });
  return out.sort((a, b) => a.date - b.date);
}

/** Daily totals summed into calendar months (UTC), for All Time. */
export function monthlySums(daily) {
  const sums = new Map();
  for (const p of daily || []) {
    const d = new Date(p.date);
    const month = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    sums.set(month, (sums.get(month) || 0) + p.value);
  }
  return [...sums].map(([date, value]) => ({ date, value })).sort((a, b) => a.date - b.date);
}

/** The fees chart's points for `period`: 7 Days, 30 Days (daily) and All Time (monthly). */
export function feeSeries(daily, period) {
  if (!daily?.length) return null;
  if (period === "week") return daily.slice(-7);
  if (period === "month") return daily.slice(-30);
  if (period === "allTime") return monthlySums(daily);
  return null;
}

// MARK: - K Activity (K's indexer; K ExplorerKStats)

/** K Activity's periods: 24 Hours, 7 Days and All Time (owner, 2026-11-25: no 30 Days). */
export const K_ACTIVITY_PERIODS = Object.freeze(["day", "week", "allTime"]);

/** `/stats` keys -> what the card calls them. `selfStash` and `groupUpdates` are machinery (a
 *  handshake's saved copy, group control), not left out by accident. */
export const K_CATEGORIES = Object.freeze([
  ["messages", "kachatMessage"], ["groupMessages", "kachatMessage"], ["handshakes", "handshake"],
  ["payments", "payment"], ["paymentNotices", "paymentNotice"], ["kaposts", "kapost"],
  ["kapostActions", "kapost"], ["publicChats", "publicChat"], ["chessMoves", "chessMove"],
  ["kachatNames", "kachatName"], ["kusdtTransfers", "kusdtTransfer"], ["kusdtSwaps", "kusdtSwap"],
  ["arcadeScores", "arcadeStamp"],
]);

/** Counts by `/stats` key -> counts by kind ({ kind: count }), only the keys K shows. */
export function kindCounts(values) {
  const counts = {};
  for (const [key, kind] of K_CATEGORIES) {
    const v = values?.[key];
    if (v == null || !Number.isFinite(Number(v))) continue;
    counts[kind] = (counts[kind] || 0) + Number(v);
  }
  return counts;
}

/** A window's numbers: `{ period, counts, bars|null, previousTotal|null, total, change|null, ranked }`. */
export function kActivity(period, counts, { bars = null, previousTotal = null } = {}) {
  const total = Object.values(counts).reduce((s, v) => s + v, 0);
  const change = previousTotal > 0 && period !== "allTime" ? (total - previousTotal) / previousTotal * 100 : null;
  const ranked = Object.entries(counts).map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);
  return { period, counts, bars, previousTotal, total, change, ranked };
}

/** `/stats` (24 Hours, 7 Days, All Time by category) -> `{ activity: { day, week, allTime }, periods }`,
 *  each period left off where nothing is served for it. Null when nothing is. */
export function activityFromStats(stats) {
  const categories = stats?.categories && typeof stats.categories === "object" ? stats.categories : null;
  if (!categories) return null;
  const pick = (field) => {
    const values = {};
    for (const [key, counts] of Object.entries(categories)) if (counts?.[field] != null) values[key] = counts[field];
    const out = kindCounts(values);
    return Object.keys(values).length && Object.keys(out).length ? out : null;
  };
  const activity = {};
  const day = pick("last24h"); if (day) activity.day = kActivity("day", day);
  const week = pick("last7d"); if (week) activity.week = kActivity("week", week);
  const all = pick("total"); if (all) activity.allTime = kActivity("allTime", all);
  const periods = K_ACTIVITY_PERIODS.filter((p) => activity[p]);
  return periods.length ? { activity, periods } : null;
}

/** `/stats/activity?period=` names. */
export const RICH_PERIOD_NAMES = Object.freeze({ day: "day", week: "week", allTime: "all" });

/** One `/stats/activity?period=` answer (categories, the window before, the bars) as a window. */
export function activityFromRich(period, answer) {
  if (!answer?.categories || typeof answer.categories !== "object") return null;
  const bars = Array.isArray(answer.series)
    ? [...answer.series].filter((b) => Number.isFinite(Number(b?.t))).sort((a, b) => a.t - b.t).map((b) => Number(b.count) || 0)
    : null;
  const previous = answer.previous && typeof answer.previous === "object"
    ? Object.values(kindCounts(answer.previous)).reduce((s, v) => s + v, 0) : null;
  return kActivity(period, kindCounts(answer.categories), { bars, previousTotal: period === "allTime" ? null : previous });
}

/** What the change compares with, and the bars' two ends (K ExplorerKPeriod). */
export const K_PERIOD_TEXT = Object.freeze({
  day: { comparison: "vs the day before", start: "24h ago", end: "now", meaning: "Transactions per hour" },
  week: { comparison: "vs the week before", start: "7 days ago", end: "today", meaning: "Transactions per day" },
  month: { comparison: "vs the 30 days before", start: "30 days ago", end: "today", meaning: "Transactions per day" },
  allTime: { comparison: null, start: "Launch", end: "today", meaning: "Transactions per month" },
});

// MARK: - Mining Estimate (K ExplorerMiningEstimate, moved from Portfolio)

/** Miners talk in TH/s (one KS5 Pro is about 21), so that is the default. */
export const HASHRATE_UNITS = Object.freeze([
  { key: "gh", label: "GH/s", scale: 1e9 },
  { key: "th", label: "TH/s", scale: 1e12 },
  { key: "ph", label: "PH/s", scale: 1e15 },
]);

/** Daily KAS for `yourHs` of `networkHs` at `rewardKas` a block, ten blocks a second. Straight
 *  proportional share: no pool fee, power cost or luck. Null when any figure is missing. */
export function dailyKasEstimate({ yourHs, networkHs, rewardKas }) {
  const yours = Number(yourHs);
  const network = Number(networkHs);
  const reward = Number(rewardKas);
  if (!(yours > 0) || !(network > 0) || !(reward > 0)) return null;
  return reward * 10 * 86_400 * yours / network;
}

/** Typed hashrate ("1,200.5") as a number, or null. */
export function typedNumber(text) {
  const bare = String(text ?? "").replace(/,/g, "").trim();
  if (!bare || !/^\d*\.?\d*$/.test(bare)) return null;
  const n = Number(bare);
  return Number.isFinite(n) ? n : null;
}

/** Typed digits grouped as you type ("1200000" -> "1,200,000"), the fraction left as typed. */
export function groupTyped(text) {
  const raw = String(text ?? "").replace(/[^\d.]/g, "");
  const dot = raw.indexOf(".");
  const whole = (dot < 0 ? raw : raw.slice(0, dot)).replace(/^0+(?=\d)/, "");
  const frac = dot < 0 ? null : raw.slice(dot + 1).replace(/\./g, "");
  const groupedWhole = whole ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : (frac != null ? "0" : "");
  return frac == null ? groupedWhole : `${groupedWhole}.${frac}`;
}
