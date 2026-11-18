// Which web links in KaPost (posts and Public Chats) may draw a preview card - KaPost iOS b78fdb0
// KaPostLinkPreviewPolicy, the owner's call of 2026-11-18. Only a poster or room sender with a
// .kachat name gets previews at all, and then only for popular, mainstream sites on this list, so a
// preview never fetches from an unknown server or shows adult content. Anything else stays a plain
// link. A host matches itself and its subdomains (www., m., mobile.). The same list holds for every
// hop: a redirect is followed only to an allowed https page (allowsPreviewRedirect), and a preview's
// image loads only from the site or a known image server of it (allowsPreviewImage).
//
// Pure: used by the page (ui/kaposts.js, ui/broadcasts.js, ui/app.js) and by both relays
// (tools/relay-rules.mjs), which check every redirect hop of a KaPost preview against it.
// 1:1 and group chats keep KaChat's own rules and don't use it.

export const PREVIEW_ALLOWED_DOMAINS = new Set([
  // social and video
  "x.com", "twitter.com", "youtube.com", "youtu.be", "instagram.com", "facebook.com",
  "linkedin.com", "tiktok.com", "threads.net",
  // code, reference and writing
  "github.com", "wikipedia.org", "medium.com", "substack.com", "apple.com",
  // news
  "bbc.com", "bbc.co.uk", "reuters.com", "bloomberg.com", "cnbc.com", "cnn.com",
  "nytimes.com", "theguardian.com", "forbes.com", "apnews.com",
  // crypto news and data
  "coindesk.com", "cointelegraph.com", "decrypt.co", "theblock.co",
  "coingecko.com", "coinmarketcap.com",
  // Kaspa and KaChat
  "kaspa.org", "kas.fyi", "kaspa.stream", "kachat.app",
]);

/** The allowed sites' image servers, for a preview's og:image (and YouTube's thumbnail). Shared
 *  hosting that serves anyone's files is left out on purpose. */
export const PREVIEW_IMAGE_CDN_DOMAINS = new Set([
  // X, YouTube, Meta (Instagram, Facebook, Threads), LinkedIn, TikTok
  "twimg.com", "ytimg.com", "ggpht.com", "yt3.googleusercontent.com",
  "cdninstagram.com", "fbcdn.net", "licdn.com", "tiktokcdn.com", "tiktokcdn-us.com",
  // GitHub, Substack, Wikipedia, Apple
  "githubassets.com", "avatars.githubusercontent.com", "repository-images.githubusercontent.com",
  "substackcdn.com", "wikimedia.org", "mzstatic.com",
  // BBC, New York Times, Guardian, CNBC, Bloomberg, The Block
  "bbci.co.uk", "nyt.com", "guim.co.uk", "cnbcfm.com", "bwbx.io", "tbstat.com",
]);

// Anywhere in the decoded, lowercased URL: none sits inside an ordinary word.
const BLOCKED_SUBSTRINGS = ["porn", "xxx", "nsfw", "nude", "hentai", "onlyfans"];
// Only as a whole word (between non-letters), so Sussex, Essex and unisex pass.
const BLOCKED_TOKENS = new Set(["sex", "sexy"]);

/** KaChat's own site (home.kachat.app, any page): it previews by itself for a named sender. */
export const KACHAT_SITE_HOST = "home.kachat.app";

function parsed(url) {
  try { return url instanceof URL ? url : new URL(String(url)); } catch { return null; }
}
function hostIn(host, domains) {
  for (const domain of domains) if (host === domain || host.endsWith(`.${domain}`)) return true;
  return false;
}
function plainWeb(u, { httpsOnly = false } = {}) {
  if (!u) return false;
  const scheme = u.protocol.toLowerCase();
  if (httpsOnly ? scheme !== "https:" : scheme !== "https:" && scheme !== "http:") return false;
  return !u.username && !u.password && !u.port && Boolean(u.hostname);
}

/** The URL decoded (twice-encoded too, "%2570orn"), lowercased, then checked. */
export function hasBlockedPreviewWords(url) {
  let text = String(url instanceof URL ? url.href : url ?? "");
  for (let i = 0; i < 3; i += 1) {
    let decoded;
    try { decoded = decodeURIComponent(text); } catch { break; }
    if (decoded === text) break;
    text = decoded;
  }
  text = text.toLowerCase();
  if (BLOCKED_SUBSTRINGS.some((word) => text.includes(word))) return true;
  return text.split(/[^\p{L}\p{N}]+/u).some((token) => BLOCKED_TOKENS.has(token));
}

export function isKaChatSitePreviewUrl(url) {
  const u = parsed(url);
  return Boolean(u) && (u.protocol === "https:" || u.protocol === "http:") && u.hostname.toLowerCase() === KACHAT_SITE_HOST && !u.username && !u.port;
}

/** A link on an allowed site (http or https), with no credentials, port or adult words. */
export function allowsPreview(url) {
  const u = parsed(url);
  if (!plainWeb(u)) return false;
  if (!hostIn(u.hostname.toLowerCase(), PREVIEW_ALLOWED_DOMAINS)) return false;
  return !hasBlockedPreviewWords(u);
}
/** A page a preview may fetch: an allowed site or KaChat's own. */
export function allowsPreviewPage(url) {
  return allowsPreview(url) || isKaChatSitePreviewUrl(url);
}
/** A redirect a page fetch may follow: https, to a page allowsPreviewPage takes. */
export function allowsPreviewRedirect(url) {
  const u = parsed(url);
  return Boolean(u) && u.protocol === "https:" && allowsPreviewPage(u);
}
/** An image a preview of `page` may load: https only, no credentials or port, no adult words,
 *  from an allowed site or one of their image servers, for a page that is itself allowed. */
export function allowsPreviewImage(url, page) {
  const u = parsed(url);
  if (!plainWeb(u, { httpsOnly: true }) || !allowsPreviewPage(page) || hasBlockedPreviewWords(u)) return false;
  const host = u.hostname.toLowerCase();
  return hostIn(host, PREVIEW_ALLOWED_DOMAINS) || hostIn(host, PREVIEW_IMAGE_CDN_DOMAINS);
}

// A web link as people write one: http(s)://… or www.… (the text it was written as is returned
// too, so a post can leave it out of its text: the card stands in for it). Trailing punctuation
// that closes a sentence isn't part of it.
const EXPLICIT_LINK_RE = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
/** The first link in `text` written as a link (KaPost b78fdb0 firstLink / isExplicitLink): a bare
 *  "x.com" in a sentence is skipped and stays a word. Returns { url, raw } or null. */
export function firstExplicitLink(text) {
  for (const match of String(text ?? "").matchAll(EXPLICIT_LINK_RE)) {
    const raw = match[0].replace(/[.,;:!?)\]}'"*]+$/, "");
    const url = /^https?:/i.test(raw) ? raw : `https://${raw}`;
    if (parsed(url)) return { url, raw, index: match.index };
  }
  return null;
}

/** The social networks a card draws as the network's own logo on its colour (KaPost b78fdb0
 *  LinkPreviewCardView socialBrand): YouTube keeps its video thumbnail. Null for anything else. */
export function socialPreviewBrand(url) {
  const u = parsed(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  if (hostIn(host, ["x.com", "twitter.com"])) return "x";
  if (hostIn(host, ["instagram.com"])) return "instagram";
  if (hostIn(host, ["facebook.com"])) return "facebook";
  if (hostIn(host, ["linkedin.com"])) return "linkedin";
  if (hostIn(host, ["tiktok.com"])) return "tiktok";
  if (hostIn(host, ["threads.net", "threads.com"])) return "threads";
  return null;
}

/** What the relays check, per hop, for a KaPost preview fetch (`x-preview-policy`): "page" or
 *  "image" (with the page it is for). A reason to refuse, or null. */
export function previewPolicyRefusal(kind, url, { page = null, hop = 0 } = {}) {
  if (kind === "page") return (hop === 0 ? allowsPreviewPage(url) : allowsPreviewRedirect(url)) ? null : "Preview target not allowed";
  if (kind === "image") return allowsPreviewImage(url, page) ? null : "Preview image not allowed";
  return null;
}
