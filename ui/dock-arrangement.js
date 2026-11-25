// The left dock (owner, 2026-11-12): on a computer the dock runs down the left side and holds every
// screen, grouped by the iOS app each comes from (KaChat, KaPost, KaPay, KaPlay, then the extras),
// with Profile and Settings at the bottom. There is no Kaspa Hub and nothing to customize. Phones
// and narrow windows keep a bottom bar of five, the last of which is More, holding the rest.
// The old saved arrangement (Kaspa Hub and its Customize Dock moves) was removed in Build 289.
export const RAIL_ORDER = [
  // No Public Chats item (owner, 2026-11-21, KaChat 148a5331): its rooms are rows in Chats.
  "chats", "address-book",
  "kaposts",
  "wallet", "portfolio", "cold-storage", "kachat-names", "swaps",
  // No Leaderboard item (K 428a797b): it's a card inside KaPlay > Chess again.
  "chess",
  // No KaChat Bots item (owner, 2026-11-12): the bots live in Chats, as circles above the list.
  // Explorer (K 961fc05a) took KaChat Stats' place.
  "explorer", "apps",
  "profile", "settings",
];
/** Tabs that were replaced: a saved spot or link asking for the old one lands on the new one.
 *  KaChat Stats is gone; the Explorer replaced it (K 961fc05a). */
export const RETIRED_TABS = Object.freeze({ "kachat-stats": "explorer" });
export function currentTabId(tab) {
  return Object.hasOwn(RETIRED_TABS, tab) ? RETIRED_TABS[tab] : tab;
}
// iOS's default dock (KaChat 148a5331): Wallet, Chats, Profile, Settings, with More for the Hub.
export const PHONE_BAR = ["chats", "wallet", "profile", "settings", "hub"];

/** What the dock holds for the window's width: `{dock, hub}`, the hub being More's list. */
export function dockLayoutFor(wide) {
  if (wide) return { dock: [...RAIL_ORDER], hub: [] };
  return { dock: [...PHONE_BAR], hub: RAIL_ORDER.filter((tab) => !PHONE_BAR.includes(tab)) };
}
