// KaPost Settings > Tipping > Tip In (KaPost iOS f954738, KaPostsSettingsView / KaPostsTipAsset /
// AppSettings.kaPostsTipAssetInUse): what a click on a post's Tip sends - Kaspa (today's tip sheet or
// the instant tip), kUSDT (the kUSDT send to the poster's chatting address, not counted on the post),
// or ask each time. Stored per account (Desktop keeps KaPost's tip settings per account, as Tips
// From, Build 273): `{ [chattingAddress]: "kaspa" | "kusdt" }`, no entry = Ask Each Time.
//
// Pure, so tools/test-kusdt-chat-tips.mjs checks it in Node.
//
// Since K 518fdc8c (2026-11-23) these are Settings > Customization > Tipping, and the same choice
// drives Tip in a 1:1 chat's + (chatTipStep below). Settings > KaPost keeps the cool down.

import { kapostsDefaultTipSompi, KAPOSTS_TIP_MIN_SOMPI } from "./kaposts-format.js";

export const TIP_IN_ASK = "ask";
export const TIP_IN_KASPA = "kaspa";
export const TIP_IN_KUSDT = "kusdt";

/** The picker's choices, in iOS's order. */
export const TIP_IN_OPTIONS = Object.freeze([
  Object.freeze({ value: TIP_IN_ASK, label: "Ask Each Time" }),
  Object.freeze({ value: TIP_IN_KASPA, label: "Kaspa" }),
  Object.freeze({ value: TIP_IN_KUSDT, label: "kUSDT" }),
]);

/** The Tipping group's footer for Ask Each Time and kUSDT (Kaspa keeps the instant tip's own). */
export const TIP_IN_FOOTERS = Object.freeze({
  [TIP_IN_ASK]: "Tip asks whether to send Kaspa or kUSDT each time.",
  [TIP_IN_KUSDT]: "Tip sends kUSDT to their chatting address. kUSDT tips aren't counted on a post.",
});

/** The stored choice of `address` ("kaspa" | "kusdt"), or null (nothing stored: Ask Each Time). */
export function storedTipIn(map, address) {
  const value = map && typeof map === "object" ? map[String(address || "")] : null;
  return value === TIP_IN_KASPA || value === TIP_IN_KUSDT ? value : null;
}

/** What a click on Tip sends (iOS kaPostsTipAssetInUse): the stored choice, else Kaspa when an
 *  instant tip is set (those are always Kaspa, and were set before Tip In existed), else Ask. */
export function effectiveTipIn({ stored = null, hasInstantTip = false } = {}) {
  if (stored === TIP_IN_KASPA || stored === TIP_IN_KUSDT) return stored;
  return hasInstantTip ? TIP_IN_KASPA : TIP_IN_ASK;
}

/** The map with `address`'s choice set to `value` (Ask Each Time removes the entry). A new object. */
export function withTipIn(map, address, value) {
  const next = { ...(map && typeof map === "object" ? map : {}) };
  const key = String(address || "");
  if (!key) return next;
  if (value === TIP_IN_KASPA || value === TIP_IN_KUSDT) next[key] = value; else delete next[key];
  return next;
}

/** What the Tipping group shows for a choice (iOS KaPostsSettingsView): the instant-tip switch and
 *  amount only for Kaspa, Tips From for all but kUSDT, and the footer for Ask / kUSDT (null: the
 *  instant tip's own footer, shown while it's on). Choosing anything but Kaspa turns the instant tip
 *  off and clears it (`clearsInstantTip`): an instant tip is always Kaspa. */
export function tipInLayout(value) {
  return {
    instantTipRows: value === TIP_IN_KASPA,
    tipsFrom: value !== TIP_IN_KUSDT,
    footer: TIP_IN_FOOTERS[value] ?? null,
    clearsInstantTip: value !== TIP_IN_KASPA,
  };
}

// --- The default tip's limits (K KaPostsSettingsView.instantTip) ----------------------------------
/** A default tip goes out without asking up to 10 KAS; a bigger one opens the tip screen. */
export const INSTANT_TIP_LIMIT_SOMPI = 10 * 100_000_000;
export const INSTANT_TIP_LIMIT_NOTICE = "Instant tips are limited to 10 KAS. Swipe up to send this one.";
export const INSTANT_TIP_LIMIT_FOOTER = "Up to 10 KAS goes out without asking; a bigger tip opens the tip screen.";

/**
 * What a Kaspa tip with the saved default does now, on a post and in a chat:
 * `{ kind: "none" }` (no default: the tip screen asks the amount), `{ kind: "send", sompi }`,
 * `{ kind: "overLimit" }` (over 10 KAS, or no real amount: the tip screen, which says why),
 * `{ kind: "tooSmall" }` (under what the network takes) or `{ kind: "noPrice" }` (a currency default
 * with no price to turn it into KAS). `price`: 1 KAS in the default's currency, when it has one.
 */
export function instantTipPlan({ defaultTip = null, price = null, minSompi = KAPOSTS_TIP_MIN_SOMPI, limitSompi = INSTANT_TIP_LIMIT_SOMPI } = {}) {
  if (!defaultTip) return { kind: "none" };
  const fiat = Number(defaultTip.fiat) > 0;
  if (!fiat && !(Number(defaultTip.sompi) > 0)) return { kind: "none" };
  if (fiat && !(Number(price) > 0)) return { kind: "noPrice" };
  const sompi = kapostsDefaultTipSompi(defaultTip, price);
  if (!sompi) return { kind: "overLimit" };
  if (sompi < minSompi) return { kind: "tooSmall" };
  if (sompi > limitSompi) return { kind: "overLimit" };
  return { kind: "send", sompi };
}

/**
 * Tip in a 1:1 chat's + (K ChatDetailView.tipFromChat). Tip In picks: kUSDT is the chat's Send
 * Dollars, Ask Each Time asks first, Kaspa follows the default tip. A default that can go out
 * becomes a Tip card waiting in the composer (`{ step: "card", sompi }`) - never a send from the +
 * itself (owner, 2026-11-23): the send button sends it, the trash takes it back. No default (or one
 * over the limit) opens the tip screen; one that can't go out says why.
 * Returns `{ step: "dollars" | "ask" | "sheet" | "card" | "error", ... }`.
 */
export function chatTipStep({ tipIn = TIP_IN_KASPA, plan = { kind: "none" } } = {}) {
  if (tipIn === TIP_IN_KUSDT) return { step: "dollars" };
  if (tipIn !== TIP_IN_KASPA) return { step: "ask" };
  switch (plan?.kind) {
    case "send": return { step: "card", sompi: plan.sompi };
    case "overLimit": return { step: "sheet", notice: INSTANT_TIP_LIMIT_NOTICE };
    case "tooSmall": return { step: "error", reason: "tooSmall" };
    case "noPrice": return { step: "error", reason: "noPrice" };
    default: return { step: "sheet", notice: "" };
  }
}
