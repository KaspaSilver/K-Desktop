// Link-preview images as blob: URLs, so a re-render doesn't fetch them again (audit 2026-11-25 #19).
//
// Each blob: URL holds its image in memory until it is revoked. The old plain Map never revoked
// one and never forgot one, and two loads of the same image at once each made a URL, the first
// lost without being freed. Here:
//   - at most `max` (200) are kept, the least recently used going first; one an element on the
//     page still shows (`inUse`) is skipped then, so a card on screen never loses its picture;
//   - an evicted URL is revoked (freed);
//   - loads of the same image share one fetch (`load`), and a URL made while another for the same
//     image landed is revoked at once.

export const PREVIEW_IMAGE_CACHE_MAX = 200;

export function createBlobUrlCache({
  max = PREVIEW_IMAGE_CACHE_MAX,
  revoke = (url) => URL.revokeObjectURL(url),
  inUse = () => false,
} = {}) {
  const urls = new Map();    // key -> blob: url, least recently used first
  const pending = new Map(); // load key -> Promise<url>

  function evict() {
    if (urls.size <= max) return;
    for (const [key, url] of urls) {
      if (urls.size <= max) break;
      let shown = false;
      try { shown = Boolean(inUse(url)); } catch { shown = false; }
      if (shown) continue;
      urls.delete(key);
      try { revoke(url); } catch { /* already gone */ }
    }
  }

  const cache = {
    get size() { return urls.size; },
    has(key) { return urls.has(key); },
    /** The URL for `key` (now the most recently used), or null. */
    get(key) {
      if (!urls.has(key)) return null;
      const url = urls.get(key);
      urls.delete(key);
      urls.set(key, url);
      return url;
    },
    /** Keeps `url` for `key`. When one is already kept the new one is revoked and the kept one
     *  returned, so no URL is ever dropped unfreed. */
    set(key, url) {
      if (urls.has(key)) {
        const kept = cache.get(key);
        if (kept !== url) { try { revoke(url); } catch { /* already gone */ } }
        return kept;
      }
      urls.set(key, url);
      evict();
      return url;
    },
    /** The URL for `key`, made by `loader()` once however many ask at the same time. Loads with
     *  different `loadKey`s (different fetch rules) run apart but end in the one kept URL. */
    load(key, loader, loadKey = key) {
      const hit = cache.get(key);
      if (hit) return Promise.resolve(hit);
      if (pending.has(loadKey)) return pending.get(loadKey);
      const job = Promise.resolve()
        .then(loader)
        .then((url) => cache.set(key, url))
        .finally(() => pending.delete(loadKey));
      pending.set(loadKey, job);
      return job;
    },
  };
  return cache;
}
