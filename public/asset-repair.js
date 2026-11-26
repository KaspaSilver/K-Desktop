// Styles that never arrived, repaired once (owner, 2026-11-26: desktop.kachat.app showed the bare
// page, unstyled). Cloudflare Pages answers a built file it doesn't have yet with the app's own
// page (200, text/html), and public/_headers marks everything under /assets/ immutable for a
// year. Right after a deploy, before the new files reach every Cloudflare location, a browser can
// ask for the new stylesheet, get the page instead, and keep it: in its own cache and in the
// service worker's. The app's stylesheet always sets --dock-inset on the root; when the page has
// loaded and that is empty, the styles are missing. Then, at most once a minute (never a reload
// loop): the service worker's caches are emptied first (an older worker serves its copy without
// asking), each built file is asked for again past the browser's cache, and the page reloads.
// Written in old JavaScript, like browser-check.js. A file, not inline, for the CSP (DSK-014).
(function () {
  var KEY = "kachat-asset-repair-at";

  function stylesMissing() {
    try {
      return !getComputedStyle(document.documentElement).getPropertyValue("--dock-inset").replace(/\s/g, "");
    } catch (e) {
      return false;
    }
  }

  function builtFiles() {
    var out = [];
    var nodes = document.querySelectorAll('link[rel="stylesheet"][href], link[rel="modulepreload"][href], script[src]');
    for (var i = 0; i < nodes.length; i += 1) {
      var url = nodes[i].href || nodes[i].src;
      try {
        var parsed = new URL(url, location.href);
        if (parsed.origin === location.origin && parsed.pathname.indexOf("/assets/") !== -1) out.push(parsed.href);
      } catch (e) { /* not a URL */ }
    }
    return out;
  }

  function repair() {
    if (!stylesMissing() || typeof fetch !== "function" || typeof Promise !== "function") return;
    var last = 0;
    try { last = Number(sessionStorage.getItem(KEY)) || 0; } catch (e) { return; }
    if (Date.now() - last < 60000) return;
    try { sessionStorage.setItem(KEY, String(Date.now())); } catch (e) { return; }
    var clear = (window.caches && caches.keys)
      ? caches.keys().then(function (names) { return Promise.all(names.map(function (name) { return caches.delete(name); })); })
      : Promise.resolve();
    var reload = function () { location.reload(); };
    clear.catch(function () {}).then(function () {
      return Promise.all(builtFiles().map(function (url) {
        return fetch(url, { cache: "reload", credentials: "same-origin" }).catch(function () {});
      }));
    }).then(reload, reload);
  }

  window.addEventListener("load", function () { setTimeout(repair, 0); });
})();
