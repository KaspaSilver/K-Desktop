import { NETWORK_ID, isNetworkAddress, isValidKaspaAddress } from "./network.js";
import { supportedNetworks as kachatNetworks } from "./kachat-names/manifest.js";
import { normalize as kachatNormalize, isValid as kachatIsValid } from "./kachat-names/codec.js";
// The name service K reads: only `.kachat`, KaChat's own names (Kaspa covenants, KACHAT_NAMES.md),
// read through the app's registry hooks. Every other Kaspa name service - KNS's .kas, dotk's .k
// and Kaspa Names' .kaspa - was removed on 2026-11-23 (owner's call; K 518fdc8c
// NameServices.swift): K resolves, shows and manages .kachat names only. A typed name gets one
// answer.
//
// Read-only: nothing here needs a wallet key or makes a transaction. No DOM, no storage.
//
// Swift -> JS notes: Swift `.whitespacesAndNewlines` (Unicode Z* + U+0009..U+000D + U+0085) is
// spelled out below; JS `trim()` differs (it strips U+FEFF and leaves U+0085), so it is not used.

// --- the service --------------------------------------------------------------------------

/**
 * @typedef {"kachat"} NameServiceTLD
 */

/**
 * @typedef {Object} NameServiceInfo
 * @property {NameServiceTLD} tld        "kachat".
 * @property {string} suffix             ".kachat".
 * @property {string} serviceName        "KaChat Names".
 * @property {boolean} isLive            Whether its registry is launched here (testnet-10 and mainnet).
 */

/** Every TLD the app reads: .kachat alone. */
export const NAME_SERVICE_TLDS = Object.freeze(["kachat"]);

/**
 * Per-TLD metadata, keyed by TLD.
 * @type {Readonly<Record<NameServiceTLD, Readonly<NameServiceInfo>>>}
 */
export const NAME_SERVICES = Object.freeze({
  kachat: Object.freeze({
    tld: "kachat",
    suffix: ".kachat",
    serviceName: "KaChat Names",
    // Readable where its registry is launched (iOS 25cc2c9, 7227d69 isLaunched): testnet-10, and
    // mainnet since 2026-10-09 (iOS ef6b21e).
    isLive: kachatNetworks.includes(NETWORK_ID),
  }),
});

// --- typed input --------------------------------------------------------------------------

// Foundation's CharacterSet.whitespacesAndNewlines.
const SWIFT_WS_NL = /[\p{Z}\u0009-\u000D\u0085]/u;

/** Swift `trimmingCharacters(in: .whitespacesAndNewlines)`. BMP-only set, so a code-unit scan. */
function swiftTrim(input) {
  const s = String(input ?? "");
  let a = 0;
  let b = s.length;
  while (a < b && SWIFT_WS_NL.test(s[a])) a++;
  while (b > a && SWIFT_WS_NL.test(s[b - 1])) b--;
  return s.slice(a, b);
}

/**
 * Splits typed input into its label and the ".kachat" ending, if typed (case-insensitive). Trims
 * whitespace/newlines; the label keeps its case. Any other ending is part of the label.
 * @param {string} input e.g. " Bob.KACHAT "
 * @returns {{label: string, tld: NameServiceTLD|null}} e.g. { label: "Bob", tld: "kachat" }
 */
export function splitTypedName(input) {
  const trimmed = swiftTrim(input);
  if (trimmed.toLowerCase().endsWith(".kachat")) return { label: trimmed.slice(0, -7), tld: "kachat" };
  return { label: trimmed, tld: null };
}

// Foundation's CharacterSet.alphanumerics (Unicode L*, M*, N*) plus "-" and "_".
const NAME_LIKE = /^[\p{L}\p{M}\p{N}_-]+$/u;

/**
 * Whether typed input could be a .kachat name (and is not an address): a bare label, or a label
 * ending in ".kachat".
 * @param {string} input
 * @returns {boolean}
 */
export function looksLikeName(input) {
  const trimmed = swiftTrim(input).toLowerCase();
  if (trimmed.startsWith("kaspa:") || trimmed.startsWith("kaspatest:")) return false;
  const { label } = splitTypedName(trimmed);
  return label.length > 0 && NAME_LIKE.test(label);
}

// --- forward resolution (typed name -> address) -------------------------------------------

/**
 * @typedef {Object} NameResolution
 * @property {"kachat"} tld
 * @property {string} name   The canonical name with its ending, e.g. "bob.kachat".
 * @property {string|null} address Where it points; null when not registered, or the lookup failed.
 * @property {"resolved"|"notRegistered"|"failed"|"notLive"} state
 *   resolved      - address is set.
 *   notRegistered - the registry answered: no such name (or a lapsed one).
 *   failed        - the registry could not be asked, so "not registered" is unknown.
 *   notLive       - no .kachat registry on this network.
 */

/**
 * What typed input points to as a .kachat name: one answer, or none when the label isn't a valid
 * name (K NameServicesClient.resolveEverywhere). A typed ".kachat" ending is dropped first.
 * @param {string} input What the person typed: "bob", "Bob.kachat" ...
 * @param {Object} deps
 * @param {(canonical: string) => Promise<string|null>} [deps.resolveKachat] The app's registry
 *   lookup: the owner address of a name active or in grace, null when there is none; throws when
 *   the registry can't be read.
 * @returns {Promise<NameResolution[]>} [] or [the .kachat answer].
 */
export async function resolveEverywhere(input, { resolveKachat } = {}) {
  const { label } = splitTypedName(input);
  if (!label) return [];
  const kachat = await resolveKachatEntry(label, resolveKachat);
  return kachat ? [kachat] : [];
}

/**
 * The answer a typed name gets: its .kachat owner, if it has one.
 * @param {NameResolution[]} results From resolveEverywhere.
 * @returns {NameResolution|null}
 */
export function primary(results) {
  const list = Array.isArray(results) ? results : [];
  return list.find((r) => r?.tld === "kachat" && r.address != null) ?? null;
}

/**
 * Why a typed name has no answer (K NameServicesClient.notFoundMessage): no .kachat registry on
 * this network, the registry couldn't be asked, or no such name - "No username found" (K audit
 * 2026-11-24 #36).
 * @param {string} typedInput What was typed.
 * @param {NameResolution[]} [results] resolveEverywhere's answers, when there are any.
 */
export function notFoundMessage(typedInput, results = []) {
  const list = Array.isArray(results) ? results : [];
  if (list.some((r) => r?.state === "notLive") || !NAME_SERVICES.kachat.isLive) return ".kachat names aren't live on this network yet";
  // Couldn't be checked is not "no such name".
  const failed = list.find((r) => r?.state === "failed");
  if (failed) return `Couldn't look up ${failed.name} right now. Try again in a moment.`;
  return "No username found";
}

/** The registry's answer. Its address is checked before it is used (iOS 5.3: name-service
 *  answers validated): trimmed and lower-cased, and only a well-formed address of the network the
 *  app runs on counts - anything else is a failed lookup, never a payee. */
function entry(canonical, address, failed) {
  let checked = null;
  if (!failed && address != null) {
    const clean = String(address).trim().toLowerCase();
    if (isNetworkAddress(clean) && isValidKaspaAddress(clean)) checked = clean;
    else failed = true;
  }
  const state = failed ? "failed" : checked != null ? "resolved" : "notRegistered";
  return { tld: "kachat", name: `${canonical}.kachat`, address: failed ? null : checked, state };
}

// Where the registry isn't live the name is reported as notLive under its canonical name. Where it
// is, the owner of a name that is active or in its grace period - only a lapsed name doesn't
// resolve (KACHAT_NAMES.md section 4). Same rules as the gap: a-z, 0-9, hyphen.
async function resolveKachatEntry(label, resolveKachat) {
  const canonical = kachatNormalize(label);
  if (!kachatIsValid(canonical)) return null;
  if (!NAME_SERVICES.kachat.isLive) {
    return { tld: "kachat", name: `${canonical}.kachat`, address: null, state: "notLive" };
  }
  if (typeof resolveKachat !== "function") return null;
  try {
    const address = await resolveKachat(canonical);
    return entry(canonical, typeof address === "string" ? address : null, false);
  } catch (error) {
    console.warn(`[NameServices] .kachat lookup failed: ${error?.message || error}`);
    return entry(canonical, null, true);
  }
}
