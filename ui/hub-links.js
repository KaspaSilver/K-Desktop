// Kaspa Hub card links (K 961fc05a): `https://kachat.app/hub/<slug>`, also `kachat://hub/<slug>`.
// On K a hold on a Hub card copies its link, and the link opens that card for whoever taps it
// (`AppTab.linkSlug`, `KaChatInternalLink.hubSection`). Desktop has no Hub: each card is a dock
// item (ui/dock-arrangement.js), so a link opens that screen, and a right-click on the dock item
// (or its More tile on a narrow window) copies it.
//
// The slugs are fixed words, never a screen's code name, so renaming a screen can't break links
// already shared. Pure: no DOM, no CSS, so node tests import it directly.

export const HUB_LINK_HOST = "kachat.app";

/** slug -> the Desktop screen it opens (setActiveAppTab's name), K's card name and its line. */
export const HUB_LINK_SLUGS = Object.freeze({
  contacts: Object.freeze({ tab: "address-book", label: "Contacts", blurb: "Your saved Kaspa addresses." }),
  portfolio: Object.freeze({ tab: "portfolio", label: "Portfolio", blurb: "Track your coins and their value." }),
  "cold-storage": Object.freeze({ tab: "cold-storage", label: "Cold Storage", blurb: "Watch and sign for your cold wallets." }),
  usernames: Object.freeze({ tab: "kachat-names", label: "Usernames", blurb: "Claim, buy and sell .kachat usernames." }),
  kapost: Object.freeze({ tab: "kaposts", label: "KaPost", blurb: "Posts and replies on Kaspa." }),
  kaplay: Object.freeze({ tab: "chess", label: "KaPlay", blurb: "Chess, Snake and 2048, scores on chain." }),
  websites: Object.freeze({ tab: "apps", label: "Websites", blurb: "Websites built on Kaspa." }),
  explorer: Object.freeze({ tab: "explorer", label: "Explorer", blurb: "Blocks, transactions and addresses, live." }),
});

/** The card a slug names, case-insensitively (K `AppTab(linkSlug:)`); null for anything unknown. */
export function hubCardForSlug(slug) {
  const key = String(slug ?? "").trim().toLowerCase();
  if (!key || !Object.prototype.hasOwnProperty.call(HUB_LINK_SLUGS, key)) return null;
  return { slug: key, ...HUB_LINK_SLUGS[key] };
}

/** The slug for a Desktop screen, or null for a screen that isn't a Hub card on K (Chats, Wallet,
 *  Profile, Settings, Swaps, Stats...). */
export function hubSlugForAppTab(tab) {
  for (const [slug, card] of Object.entries(HUB_LINK_SLUGS)) if (card.tab === tab) return slug;
  return null;
}

/** The link a card's Copy Link copies (K `hubSectionShareURL`): always the https form, which
 *  previews everywhere and opens K where it is installed. Null for an unknown slug. */
export function hubLinkUrl(slug) {
  const card = hubCardForSlug(slug);
  return card ? `https://${HUB_LINK_HOST}/hub/${card.slug}` : null;
}

// One whole link: the slug alone after /hub/, an optional trailing slash, and a query or fragment
// ignored (as the other kachat.app links are read).
const HUB_LINK_RE = /^(?:kachat:\/\/hub\/|https?:\/\/(?:www\.)?kachat\.app\/hub\/)([^/?#\s]+)\/?(?:[?#][^\s]*)?$/i;

/** `{ kind: "hub", slug, tab }` for a Hub card link, else null. Everything a pasted link carries is
 *  untrusted: only the fixed slugs are accepted. */
export function parseHubLink(raw) {
  const match = String(raw ?? "").trim().match(HUB_LINK_RE);
  if (!match) return null;
  let slug;
  try { slug = decodeURIComponent(match[1]); } catch { return null; }
  const card = hubCardForSlug(slug);
  return card ? { kind: "hub", slug: card.slug, tab: card.tab } : null;
}

// A Hub link inside text (a post, a message), as the other internal links are found.
const HUB_LINK_IN_TEXT_RE = /(?:kachat:\/\/hub\/|https?:\/\/(?:www\.)?kachat\.app\/hub\/)[^\s<>"']+/gi;

/** The first Hub card link in `text`: `{ slug, tab, raw, bodyText }`, `bodyText` being the text
 *  without that link (the card stands for it, K KaPostCellView.textParts `hubLink`), or null.
 *  Trailing prose punctuation is not part of the link. */
export function hubLinkIn(text) {
  const value = String(text ?? "");
  if (!/\/hub\//i.test(value)) return null;
  for (const match of value.matchAll(HUB_LINK_IN_TEXT_RE)) {
    const raw = match[0].replace(/[.,;:!?)\]}'"*]+$/, "");
    const link = parseHubLink(raw);
    if (!link) continue;
    return { slug: link.slug, tab: link.tab, raw, bodyText: (value.slice(0, match.index) + value.slice(match.index + raw.length)).trim() };
  }
  return null;
}
