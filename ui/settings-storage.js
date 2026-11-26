// Settings writes that a full storage must not break (audit 2026-11-25 #11).
//
// The site's localStorage is shared by settings (joined rooms, bells, blocks, follows) and by
// caches that can be read again from the network (the public-chat message cache). When a cache
// has filled the storage, a settings write used to throw - joining a room or blocking someone
// then failed half-way. Here a write that fails asks each registered cache to give its space back,
// trying again after each, and never throws: it answers whether the value was stored.

const freers = [];

/** A cache that can give its stored copy back when a settings write needs the room. `free()`
 *  removes (or shrinks) what that cache keeps in storage; its copy in memory stays. */
export function onSettingsStorageFull(free) {
  if (typeof free === "function" && !freers.includes(free)) freers.push(free);
}

/** localStorage.setItem that never throws: true once stored, false when even after every cache
 *  gave its space back it could not be (the value then lives only in memory this session). */
export function setSettingItem(key, value, storage = globalThis.localStorage) {
  try { storage.setItem(key, value); return true; } catch { /* full: make room below */ }
  for (const free of freers) {
    try { free(); } catch { /* the next one may help */ }
    try { storage.setItem(key, value); return true; } catch { /* still full */ }
  }
  return false;
}
