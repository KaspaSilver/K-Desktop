// Built files on Cloudflare Pages (desktop.kachat.app/assets/*): a file that isn't there is a plain
// 404 that nothing keeps, never the app's page.
//
// Pages answers a path it has no file for with the site's index.html (200, text/html), and
// public/_headers marks everything under /assets/ "public, max-age=31536000, immutable". Just after
// a deploy, before a new file reached every Cloudflare location, a request for it got the page
// under the file's name, and Cloudflare's cache, the browser's and the service worker's all kept
// it as that file for a year: the stylesheet arrived as a page (the site unstyled) and then the
// app's script did (the app never started), owner 2026-11-26. A built file's name changes with its
// content, so nothing under /assets/ is ever a page: one that comes back as a page is turned into
// "not there yet" with no-store, and the next ask gets the real file once it has arrived.
//
// Anything unexpected here hands back what Pages gave: this must never be why a file fails.

export async function onRequest(context) {
  const response = await context.next();
  try {
    const type = response.headers.get("content-type") || "";
    if (response.status === 200 && /text\/html/i.test(type)) {
      return new Response("Not found", {
        status: 404,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
  } catch {
    /* hand back what Pages gave */
  }
  return response;
}
