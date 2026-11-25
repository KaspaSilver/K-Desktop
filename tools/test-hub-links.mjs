// Kaspa Hub card links (K 961fc05a): https://kachat.app/hub/<slug> (and kachat://hub/<slug>) opens
// that card's screen for whoever taps it. Desktop has no Hub, so the link opens the matching dock
// screen, chats and KaPost draw it as a card, and a right-click on a dock item copies its link.
// Nothing here needs the Explorer screen to exist: a screen this build lacks fails safely.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { HUB_LINK_SLUGS, hubCardForSlug, hubSlugForAppTab, hubLinkUrl, parseHubLink, hubLinkIn } from "../ui/hub-links.js";
import { kapostsPaymentRequestIn, kapostsPreviewLinkIn } from "../ui/kaposts-format.js";

const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
const kaposts = readFileSync(new URL("../ui/kaposts.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../ui/kaposts-conversation.css", import.meta.url), "utf8");

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}
function fnSource(source, name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} exists`);
  let depth = 0;
  for (let i = source.indexOf(") {", start) + 2; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

// The owner's map from K's Hub cards to Desktop's screens.
const MAP = {
  contacts: "address-book", portfolio: "portfolio", "cold-storage": "cold-storage", usernames: "kachat-names",
  kapost: "kaposts", kaplay: "chess", websites: "apps", explorer: "explorer",
};

test("the eight fixed slugs, each to its Desktop screen", () => {
  assert.deepEqual(Object.keys(HUB_LINK_SLUGS).sort(), Object.keys(MAP).sort());
  for (const [slug, tab] of Object.entries(MAP)) {
    assert.equal(hubCardForSlug(slug).tab, tab, slug);
    assert.equal(hubSlugForAppTab(tab), slug, tab);
    assert.equal(hubLinkUrl(slug), `https://kachat.app/hub/${slug}`);
  }
  // the dock's own screens aren't Hub cards on K
  for (const tab of ["chats", "wallet", "profile", "settings", "swaps", "kachat-stats", "hub"]) assert.equal(hubSlugForAppTab(tab), null, tab);
  assert.equal(hubLinkUrl("nope"), null);
});

test("both forms parse, any case, with a trailing slash or a query", () => {
  for (const [slug, tab] of Object.entries(MAP)) {
    for (const raw of [`https://kachat.app/hub/${slug}`, `kachat://hub/${slug}`, `http://www.kachat.app/hub/${slug.toUpperCase()}/`, `https://kachat.app/hub/${slug}?from=share`]) {
      assert.deepEqual(parseHubLink(raw), { kind: "hub", slug, tab }, raw);
    }
  }
});

test("anything else is not a Hub link", () => {
  for (const raw of [
    "https://kachat.app/hub/", "https://kachat.app/hub/nope", "https://kachat.app/hub/kapost/extra",
    "https://kachat.app.evil.com/hub/kapost", "https://evil.com/kachat.app/hub/kapost", "kapay://hub/kapost",
    "https://kachat.app/hub/%E0%A4%A", "https://kachat.app/hub/constructor", "https://kachat.app/hub/__proto__",
    "https://kachat.app/post/kapost", "",
  ]) assert.equal(parseHubLink(raw), null, raw);
});

test("in text: the link, without trailing punctuation, and the text without it", () => {
  assert.deepEqual(hubLinkIn("Play with me: https://kachat.app/hub/kaplay!"), { slug: "kaplay", tab: "chess", raw: "https://kachat.app/hub/kaplay", bodyText: "Play with me: !" });
  assert.deepEqual(hubLinkIn("kachat://hub/explorer"), { slug: "explorer", tab: "explorer", raw: "kachat://hub/explorer", bodyText: "" });
  // an unknown card is skipped for a known one after it
  assert.equal(hubLinkIn("https://kachat.app/hub/nope and https://kachat.app/hub/websites").slug, "websites");
  assert.equal(hubLinkIn("no link here"), null);
});

test("a KaPost with a Hub link still finds its payment request, and never previews the Hub link as a site", () => {
  const pay = "https://kachat.app/pay/kaspa:qabc?amount=1";
  const found = kapostsPaymentRequestIn(`https://kachat.app/hub/kapost then ${pay}`, (raw) => (raw === pay ? { ok: true } : null));
  assert.equal(found?.raw, pay);
  assert.equal(kapostsPreviewLinkIn("https://kachat.app/hub/kapost", { named: true }), null);
});

// --- ui/app.js: parsing, opening, chats' card ---------------------------------------------------

test("the internal-link parser and finder know Hub links", () => {
  assert.match(app, /const INTERNAL_LINK_IN_TEXT_RE = \/\(\?:kachat:\\\/\\\/\(\?:kapost\|broadcast\|profile\|pay\|hub\)/);
  assert.match(app, /https\?:\\\/\\\/\(\?:www\\\.\)\?kachat\\\.app\\\/\(\?:post\|broadcast\|u\|pay\|hub\)\\\//);
  const sandbox = {
    parseBotChallengeLink: () => null, parseArcadeChallengeLink: () => null, parsePaymentRequestLinkCached: () => null,
    parseHubLink, toActiveNetworkAddress: (a) => a, isValidKaspaAddressString: () => true, isUnsafeObjectKey: () => false,
  };
  vm.runInNewContext(`${fnSource(app, "parseKaChatInternalLink")}; this.parse = parseKaChatInternalLink;`, sandbox);
  assert.deepEqual({ ...sandbox.parse("https://kachat.app/hub/kaplay") }, { kind: "hub", slug: "kaplay", tab: "chess" });
  assert.deepEqual({ ...sandbox.parse("kachat://hub/contacts") }, { kind: "hub", slug: "contacts", tab: "address-book" });
  assert.equal(sandbox.parse("kachat://hub/nope"), null);
  assert.deepEqual({ ...sandbox.parse("kachat://broadcast/kaspa") }, { kind: "broadcast", channel: "kaspa" }, "the others still parse");
});

function openSandbox({ dock = ["chats", "kaposts", "chess", "address-book"], hub = [], screens = ["chats", "kaposts", "chess", "address-book"], childMode = false } = {}) {
  const calls = [];
  const sandbox = {
    calls,
    hubCardForSlug,
    dockPrefs: { dock, hub },
    CHILD_HIDDEN_TABS: ["swaps", "kaposts", "broadcasts", "chess", "kachat-names"],
    isChildModeEnabled: () => childMode,
    showCopyToast: (text) => calls.push(`toast:${text}`),
    closeOpenSheets: () => calls.push("closeOpenSheets"),
    setActiveAppTab: (tab) => calls.push(`setActiveAppTab:${tab}`),
    applyDockLayout: () => calls.push("applyDockLayout"),
    hubCardInfo: (slug) => ({ label: hubCardForSlug(slug).label }),
    CSS: { escape: (v) => v },
    document: { querySelector: (sel) => (screens.some((tab) => sel === `[data-app-tab-screen="${tab}"]`) ? {} : null) },
  };
  vm.runInNewContext(`${fnSource(app, "appTabExists")}\n${fnSource(app, "openHubCardLink")}; this.open = openHubCardLink; this.exists = appTabExists;`, sandbox);
  return sandbox;
}

test("a Hub link opens that screen from the dock", () => {
  const box = openSandbox();
  box.open({ kind: "hub", slug: "kaplay" });
  assert.deepEqual([...box.calls], ["closeOpenSheets", "setActiveAppTab:chess", "applyDockLayout"]);
  // under More on a narrow window it opens there too
  const narrow = openSandbox({ dock: ["chats"], hub: ["kaposts"] });
  narrow.open({ kind: "hub", slug: "kapost" });
  assert.ok(narrow.calls.includes("setActiveAppTab:kaposts"));
});

test("a screen this build doesn't have fails safely: a toast, no tab switch", () => {
  // the Explorer before its screen lands: not in the dock, no screen
  const box = openSandbox();
  assert.equal(box.exists("explorer"), false);
  box.open({ kind: "hub", slug: "explorer" });
  assert.deepEqual([...box.calls], ["toast:Explorer isn't in this version of K yet."]);
  // in the dock list but with no screen in the page: still nothing
  const noScreen = openSandbox({ dock: ["chats", "explorer"], screens: ["chats"] });
  noScreen.open({ kind: "hub", slug: "explorer" });
  assert.ok(!noScreen.calls.some((c) => c.startsWith("setActiveAppTab")));
  // once it exists, it opens
  const landed = openSandbox({ dock: ["chats", "explorer"], screens: ["chats", "explorer"] });
  landed.open({ kind: "hub", slug: "explorer" });
  assert.ok(landed.calls.includes("setActiveAppTab:explorer"));
  // an unknown slug does nothing at all
  const unknown = openSandbox();
  unknown.open({ kind: "hub", slug: "nope" });
  assert.equal(unknown.calls.length, 0);
});

test("Simple Mode: Contacts opens, KaPlay says it isn't available", () => {
  const box = openSandbox({ childMode: true });
  box.open({ kind: "hub", slug: "kaplay" });
  assert.deepEqual([...box.calls], ["toast:Not available in Simple Mode."]);
  const contacts = openSandbox({ childMode: true });
  contacts.open({ kind: "hub", slug: "contacts" });
  assert.ok(contacts.calls.includes("setActiveAppTab:address-book"));
  const opener = fnSource(app, "openKaChatInternalLink");
  assert.match(opener, /link\.kind !== "profile" && link\.kind !== "pay" && link\.kind !== "hub"\) \{ showCopyToast\("Not available in Simple Mode\."\)/);
  assert.match(opener, /if \(link\.kind === "hub"\) \{ openHubCardLink\(link\); return; \}/);
});

test("chats draw it as their internal link card with the card's own icon", () => {
  assert.match(fnSource(app, "buildInternalLinkCard"), /if \(link\?\.kind === "hub"\) return buildHubLinkCard\(link\);/);
  const card = fnSource(app, "buildHubLinkCard");
  assert.match(card, /internal-link-icon hub-link-icon">\$\{info\.iconHtml \|\| ""\}/);
  assert.match(card, /Kaspa Hub<\/span>/);
  assert.match(card, /\$\{escapeHtml\(info\.blurb\)\}<br>Tap to open it in K\./);
  assert.match(fnSource(app, "hubCardInfo"), /const iconHtml = tabIconMarkup\(card\.tab\)\n\s*\|\| '<svg/);
  // the chats list's line: "Kaspa Hub: KaPlay"
  assert.equal((app.match(/return `Kaspa Hub: \$\{hubCardInfo\(internal\.slug\)\?\.label \|\| ""\}`;/g) || []).length, 2);
  assert.match(css, /\.internal-link-icon\.hub-link-icon svg \{/);
});

test("a right-click on a dock item or a More tile offers Copy Link and Open", () => {
  assert.match(app, /sidebarTabButtons\.forEach\(\(button\) => \{\s*button\.addEventListener\("contextmenu", \(event\) => \{\s*if \(!hubSlugForAppTab\(button\.dataset\.appTab\)\) return;\s*event\.preventDefault\(\);\s*openDockItemLinkMenu\(button\.dataset\.appTab\);/);
  assert.match(app, /hubGrid\?\.addEventListener\("contextmenu", \(event\) => \{[\s\S]*?openDockItemLinkMenu\(tile\.dataset\.hubTile\);/);
  const menu = fnSource(app, "openDockItemLinkMenu");
  assert.match(menu, /title: "Copy Link", subtitle: "A link that opens this card in K\."/);
  assert.match(menu, /title: "Open", subtitle: "Opens this card\."/);
  assert.match(menu, /copyTextToClipboard\(url\)\.then\(\(\) => showCopyToast\("Link copied"\)\)/);
  assert.match(menu, /else if \(choice === "open"\) openHubCardLink\(\{ slug \}\);/);
});

// --- KaPost: the card in posts and the composer ----------------------------------------------

test("KaPost draws a Hub link as its card, opening and copying it", () => {
  const cell = fnSource(kaposts, "postCellHtml");
  assert.match(cell, /const hubLink = hubLinkIn\(textBeforeHub\);/);
  assert.match(cell, /\$\{hubLink \? hubLinkCardHtml\(hubLink\.slug, pid\) : ""\}/);
  const card = fnSource(kaposts, "hubLinkCardHtml");
  assert.match(card, /kaposts-hub-card-eyebrow">Kaspa Hub</);
  assert.match(card, /data-kaposts-hub-card="\$\{deps\.escapeHtml\(info\.slug\)\}"/);
  assert.match(card, /pid == null\s*\?\s*`<div class="kaposts-hub-card" inert>/);
  // a click opens it through the app's link router; a right-click offers Copy Link and Open
  assert.match(kaposts, /const url = hubLinkUrl\(hubCard\.dataset\.kapostsHubCard\);\s*if \(url\) deps\.openKaChatLink\?\.\(url\);/);
  assert.match(kaposts, /data-kaposts-link-copy="\$\{deps\.escapeHtml\(hubUrl\)\}"><strong>Copy Link<\/strong>/);
  assert.match(kaposts, /data-kaposts-link-open="\$\{deps\.escapeHtml\(hubUrl\)\}"><strong>Open<\/strong>/);
  assert.match(app, /\/\/ A Kaspa Hub card's name, line and dock icon, for its card in a post \(K 961fc05a\)\.\n\s*hubCardInfo,/);
});

test("the composer shows the card the post will draw, inert, with an x", () => {
  const composer = fnSource(kaposts, "renderComposerHubCard");
  assert.match(composer, /hubLinkCardHtml\(found\.slug, null\)/);
  assert.match(composer, /data-kaposts-composer-hub-remove/);
  assert.match(composer, /composerInput\.value = composerInput\.value\.split\(link\.raw\)\.join\(""\)\.trim\(\);/);
  assert.match(kaposts, /updateMeter\(composerInput, composerMeter, composerSubmit\);\n\s*renderComposerHubCard\(\);/);
});

console.log(`hub links: ${passed} passed`);
