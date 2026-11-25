// Each saved account's own picture, kept in this browser (K 8cb4c88e SavedAccountAvatars): written
// while that account is signed in (the dock's Profile picture), read by the sign-in screen's Saved
// Accounts and the Profile tab's account switcher, so neither looks another address up. Filed by
// the account's canonical (mainnet) address, the same on mainnet and testnet, and removed with the
// account.
//
// A picture is kept as a small square PNG data URL. One whose host doesn't allow it to be copied
// (no CORS) is kept as its https link instead, shown with no referrer; a picture that won't load
// shows the person glyph.

export const SAVED_ACCOUNT_AVATARS_KEY = "kachat-saved-account-avatars-v1";
/** Saved at this size: a 40-48 px row on a 2x screen. */
export const SAVED_ACCOUNT_AVATAR_PIXELS = 96;
/** A copy bigger than this isn't kept (localStorage is small and shared with everything else). */
export const SAVED_ACCOUNT_AVATAR_MAX_CHARS = 150_000;

/** Whether `src` may be stored and shown later: a raster data URL or an https link. */
export function isStorableAvatarSrc(src) {
  const value = String(src || "");
  if (!value || value.length > SAVED_ACCOUNT_AVATAR_MAX_CHARS) return false;
  if (/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value)) return true;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

/** The store. `canonicalize(address)` gives an account's one key on either network. */
export function createSavedAccountAvatars({ storage = globalThis.localStorage ?? null, canonicalize = (address) => address } = {}) {
  const keyOf = (address) => {
    try { return String(canonicalize(String(address || "").trim()) || "").trim().toLowerCase(); } catch { return ""; }
  };
  const readAll = () => {
    try {
      const parsed = JSON.parse(storage?.getItem(SAVED_ACCOUNT_AVATARS_KEY) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  };
  const writeAll = (all) => {
    try {
      if (Object.keys(all).length) storage?.setItem(SAVED_ACCOUNT_AVATARS_KEY, JSON.stringify(all));
      else storage?.removeItem(SAVED_ACCOUNT_AVATARS_KEY);
      return true;
    } catch { return false; } // storage full: the row shows the glyph
  };
  return {
    /** The account's saved picture (a src for <img>), or null. */
    get(address) {
      const key = keyOf(address);
      if (!key) return null;
      const src = readAll()[key]?.src;
      return isStorableAvatarSrc(src) ? src : null;
    },
    /** The signed-in account's picture changed (or was first worked out). True when it changed. */
    save(address, src) {
      const key = keyOf(address);
      if (!key || !isStorableAvatarSrc(src)) return false;
      const all = readAll();
      if (all[key]?.src === src) return false;
      all[key] = { src, savedAt: Date.now() };
      return writeAll(all);
    },
    /** The account has no picture any more, or it was deleted. True when one was removed. */
    remove(address) {
      const key = keyOf(address);
      const all = readAll();
      if (!key || !(key in all)) return false;
      delete all[key];
      return writeAll(all);
    },
  };
}

/** Where a picture drawn at `width` x `height` goes in a `side` square, filling it (aspect fill). */
export function coverRect(width, height, side) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const scale = Math.max(side / w, side / h);
  const dw = w * scale;
  const dh = h * scale;
  return { x: (side - dw) / 2, y: (side - dh) / 2, width: dw, height: dh };
}

/** What to keep for `src`: a small square PNG copy, else the https link itself, else null. */
export async function savedAvatarSourceFor(src, { side = SAVED_ACCOUNT_AVATAR_PIXELS, copy = squareCopy } = {}) {
  const value = String(src || "");
  if (!value) return null;
  try {
    const copied = await copy(value, side);
    if (isStorableAvatarSrc(copied)) return copied;
  } catch { /* not copyable (no CORS) or not loadable */ }
  return /^https:\/\//i.test(value) && isStorableAvatarSrc(value) ? value : null;
}

/** The browser's copy: the picture drawn into a `side` square canvas. Throws when it can't load or
 *  its host doesn't allow it to be read back. */
export function squareCopy(src, side) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    if (/^https?:/i.test(src)) image.crossOrigin = "anonymous";
    image.onerror = () => reject(new Error("The picture didn't load."));
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = side;
        canvas.height = side;
        const context = canvas.getContext("2d");
        const rect = coverRect(image.naturalWidth, image.naturalHeight, side);
        context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
        resolve(canvas.toDataURL("image/png"));
      } catch (error) { reject(error); }
    };
    image.src = src;
  });
}
