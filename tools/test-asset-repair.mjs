// Owner, 2026-11-26: desktop.kachat.app showed the bare page, unstyled. Cloudflare answers a built
// file it doesn't have yet (just after a deploy) with the app's page (200, text/html), and
// public/_headers marks /assets/* immutable, so the browser and the service worker kept the page
// under the stylesheet's name. The worker never keeps or serves a page as a built file, and the
// page repairs itself once when its styles are missing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (...parts) => readFileSync(new URL(`../${parts.join("/")}`, import.meta.url), "utf8");
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

const page = () => new Response("<!doctype html><title>K</title>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
const css = () => new Response(":root{--dock-inset:124px}", { status: 200, headers: { "content-type": "text/css" } });

/** sw.js's fetch handler, run against a fake cache and network. */
function loadWorker({ network }) {
  const store = new Map();
  const cache = {
    match: async (req) => store.get(typeof req === "string" ? req : req.url)?.clone() ?? undefined,
    put: async (req, res) => { store.set(req.url, res); },
    delete: async (req) => store.delete(req.url),
  };
  const listeners = {};
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    location: new URL("https://desktop.kachat.app/sw.js"),
    registration: { scope: "https://desktop.kachat.app/" },
    skipWaiting() {},
  };
  const sandbox = {
    self, URL, Request, Response, console,
    importScripts() {},
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
    fetch: async (req) => network(req),
  };
  vm.runInNewContext(read("public", "sw.js"), sandbox);
  const run = async (url) => {
    let answer = null;
    listeners.fetch({ request: new Request(url), respondWith: (p) => { answer = p; } });
    return answer;
  };
  return { run, store };
}

await test("the worker's cache is a new one (v3), so v2's bad copies go on activate", () => {
  assert.match(read("public", "sw.js"), /const CACHE = "kachat-shell-v3";/);
});

await test("a page answered for a built file is asked for again past the browser's cache, never kept", async () => {
  const asked = [];
  let cssReady = false;
  const { run, store } = loadWorker({ network: async (req) => { asked.push(req.cache); return cssReady && req.cache === "reload" ? css() : page(); } });
  const url = "https://desktop.kachat.app/assets/index-abc.css";
  // the file isn't at this Cloudflare location yet: the page, both times, and nothing is kept
  let res = await run(url);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.deepEqual(asked, ["default", "reload"]);
  assert.equal(store.size, 0, "a page is never kept as a built file");
  // it arrives: the browser's cache still has the page, the second ask gets the stylesheet
  cssReady = true;
  res = await run(url);
  assert.equal(await res.text(), ":root{--dock-inset:124px}");
  assert.equal(store.size, 1);
  // and it's served from the worker after that
  asked.length = 0;
  assert.equal(await (await run(url)).text(), ":root{--dock-inset:124px}");
  assert.deepEqual(asked, []);
});

await test("a page already kept under a built file's name (an older worker's) is dropped and fetched again", async () => {
  const { run, store } = loadWorker({ network: async () => css() });
  const url = "https://desktop.kachat.app/assets/index-abc.css";
  store.set(url, page());
  assert.equal(await (await run(url)).text(), ":root{--dock-inset:124px}");
  assert.match(store.get(url).headers.get("content-type"), /text\/css/);
});

await test("the page repairs missing styles once: caches emptied first, files asked for past the cache, then a reload", async () => {
  const order = [];
  const session = new Map();
  let onLoad = null;
  const sandbox = {
    URL, Promise, Number, String, Date,
    location: { href: "https://desktop.kachat.app/", origin: "https://desktop.kachat.app", reload: () => order.push("reload") },
    document: {
      documentElement: {},
      querySelectorAll: () => [
        { href: "https://desktop.kachat.app/assets/index-abc.css" },
        { src: "https://desktop.kachat.app/assets/index-abc.js" },
        { src: "https://desktop.kachat.app/browser-check.js" },
      ],
    },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    sessionStorage: { getItem: (k) => session.get(k) ?? null, setItem: (k, v) => session.set(k, v) },
    caches: { keys: async () => ["kachat-shell-v2"], delete: async (name) => { order.push(`delete ${name}`); return true; } },
    fetch: async (url, init) => { order.push(`fetch ${new URL(url).pathname} ${init.cache}`); return css(); },
    setTimeout: (fn) => fn(),
  };
  sandbox.window = { addEventListener: (type, fn) => { if (type === "load") onLoad = fn; }, caches: sandbox.caches };
  vm.runInNewContext(read("public", "asset-repair.js"), sandbox);
  onLoad();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, [
    "delete kachat-shell-v2",
    "fetch /assets/index-abc.css reload",
    "fetch /assets/index-abc.js reload",
    "reload",
  ]);
  // never a loop: within the minute, a second load does nothing
  order.length = 0;
  onLoad();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, []);
  // styles present: nothing at all
  session.clear();
  sandbox.getComputedStyle = () => ({ getPropertyValue: () => " 124px" });
  onLoad();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, []);
});

await test("a built script that fails to load (the app's script arriving as a page) repairs too", async () => {
  const order = [];
  const session = new Map();
  const listeners = {};
  const sandbox = {
    URL, Promise, Number, String, Date,
    location: { href: "https://desktop.kachat.app/", origin: "https://desktop.kachat.app", reload: () => order.push("reload") },
    document: { documentElement: {}, querySelectorAll: () => [{ src: "https://desktop.kachat.app/assets/index-new.js" }] },
    getComputedStyle: () => ({ getPropertyValue: () => "124px" }), // styles fine
    sessionStorage: { getItem: (k) => session.get(k) ?? null, setItem: (k, v) => session.set(k, v) },
    caches: { keys: async () => [], delete: async () => true },
    fetch: async (url, init) => { order.push(`fetch ${new URL(url).pathname} ${init.cache}`); return css(); },
    setTimeout: (fn) => fn(),
  };
  sandbox.window = { addEventListener: (type, fn, capture) => { listeners[type] = { fn, capture }; }, caches: sandbox.caches };
  vm.runInNewContext(read("public", "asset-repair.js"), sandbox);
  assert.equal(listeners.error.capture, true, "caught on the way down: resource errors don't bubble");
  // someone else's script, or not a built file: nothing
  listeners.error.fn({ target: { tagName: "SCRIPT", src: "https://desktop.kachat.app/browser-check.js" } });
  listeners.error.fn({ target: { tagName: "IMG", src: "https://desktop.kachat.app/assets/x.png" } });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, []);
  listeners.error.fn({ target: { tagName: "SCRIPT", src: "https://desktop.kachat.app/assets/index-new.js" } });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ["fetch /assets/index-new.js reload", "reload"]);
});

await test("Cloudflare: a built file that isn't there is a 404 nothing keeps, never the page", async () => {
  const { onRequest } = await import("../functions/assets/_middleware.js");
  const pageRes = await onRequest({ next: async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" } }) });
  assert.equal(pageRes.status, 404);
  assert.equal(pageRes.headers.get("cache-control"), "no-store");
  const real = new Response("x", { status: 200, headers: { "content-type": "application/javascript" } });
  assert.equal(await onRequest({ next: async () => real }), real, "a real file passes through untouched");
  const notModified = new Response(null, { status: 304 });
  assert.equal(await onRequest({ next: async () => notModified }), notModified);
});

await test("the page loads the repair script before the app", () => {
  const html = read("index.html");
  assert.ok(html.indexOf('<script src="/asset-repair.js"></script>') > 0);
  assert.ok(html.indexOf('<script src="/asset-repair.js"></script>') < html.indexOf('<link rel="stylesheet" href="./ui/styles.css'));
});

console.log(`asset repair: ${passed} passed`);
