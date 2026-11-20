// KaPost Settings > Tipping > Tip In (KaPost iOS f954738, KaPostsSettingsView / KaPostsTipAsset /
// AppSettings.kaPostsTipAssetInUse): what a click on a post's Tip sends - Kaspa (today's tip sheet or
// the instant tip), kUSDT (the kUSDT send to the poster's chatting address, not counted on the post),
// or ask each time. Stored per account (Desktop keeps KaPost's tip settings per account, as Tips
// From, Build 273): `{ [chattingAddress]: "kaspa" | "kusdt" }`, no entry = Ask Each Time.
//
// Pure, so tools/test-kusdt-chat-tips.mjs checks it in Node.

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
  [TIP_IN_KUSDT]: "Tip sends kUSDT to the poster's chatting address. kUSDT tips aren't counted on the post.",
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
