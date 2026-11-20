// Pictures anyone can send are checked from their headers before they are drawn (KaChat iOS
// 5b7c772c audit #2: crafted images no longer crash). A file of a few KB can declare a picture of
// gigabytes, or an animation whose every frame is huge; a browser tab that tries to decode it runs
// out of memory. So, from the bytes alone:
//   - a picture over 50,000,000 pixels is never decoded: a placeholder shows instead;
//   - only a real GIF animates (whatever MIME type the message claims), and only with 2 to 300
//     frames and the canvas and every frame at most 1024 px on the long edge;
//   - any other animation (animated WebP, APNG, AVIF sequence), or a GIF past those limits, shows
//     its first frame as a still picture.
// Used for photos in 1:1 and group chats (one message or joined from parts), the full-screen
// preview, and group photos (gctl_photo, which any member can set).

export const MAX_SOURCE_PIXELS = 50_000_000;
export const MAX_PLAY_EDGE = 1024;
export const MAX_PLAY_FRAMES = 300;

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

function gifInfo(b) {
  const width = u16le(b, 6);
  const height = u16le(b, 8);
  let pos = 13;
  if (b[10] & 0x80) pos += 3 * (1 << ((b[10] & 7) + 1));
  let frames = 0;
  let maxFrameEdge = 0;
  let maxFramePixels = 0;
  const skip = (p) => {
    while (p < b.length) {
      const size = b[p];
      p += 1;
      if (!size) return p;
      p += size;
    }
    return b.length;
  };
  while (pos < b.length) {
    const marker = b[pos];
    if (marker === 0x3b) break;
    if (marker === 0x21) { pos = skip(pos + 2); continue; }
    if (marker !== 0x2c || pos + 10 > b.length) break;
    const w = u16le(b, pos + 5);
    const h = u16le(b, pos + 7);
    const packed = b[pos + 9];
    frames += 1;
    maxFrameEdge = Math.max(maxFrameEdge, w, h);
    maxFramePixels = Math.max(maxFramePixels, w * h);
    pos += 10;
    if (packed & 0x80) pos += 3 * (1 << ((packed & 7) + 1));
    pos = skip(pos + 1);
  }
  return { format: "gif", width, height, frames, maxFrameEdge, maxFramePixels, animated: frames > 1 };
}

function pngInfo(b) {
  // IHDR is the first chunk; an acTL chunk before the image data makes it an APNG.
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  let animated = false;
  let pos = 8;
  while (pos + 8 <= b.length) {
    const length = u32be(b, pos);
    const type = ascii(b, pos + 4, 4);
    if (type === "acTL") { animated = true; break; }
    if (type === "IDAT" || type === "IEND") break;
    pos += 12 + length;
  }
  return { format: "png", width, height, animated };
}

function jpegInfo(b) {
  let pos = 2;
  while (pos + 4 <= b.length) {
    if (b[pos] !== 0xff) { pos += 1; continue; }
    const marker = b[pos + 1];
    if (marker === 0xff) { pos += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = u16be(b, pos + 2);
    // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { format: "jpeg", height: u16be(b, pos + 5), width: u16be(b, pos + 7), animated: false };
    }
    pos += 2 + length;
  }
  return null;
}

function webpInfo(b) {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8X") {
    const flags = b[20];
    return { format: "webp", width: u24le(b, 24) + 1, height: u24le(b, 27) + 1, animated: Boolean(flags & 0x02) };
  }
  if (chunk === "VP8L") {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, animated: false };
  }
  if (chunk === "VP8 ") {
    return { format: "webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, animated: false };
  }
  return null;
}

function isobmffInfo(b) {
  // AVIF / HEIF: the largest 'ispe' (image spatial extents) box; an image sequence brand animates.
  const brands = ascii(b, 8, Math.min(32, Math.max(0, u32be(b, 0) - 8)));
  const animated = /avis|msf1|hevs/.test(brands);
  let width = 0;
  let height = 0;
  const limit = Math.min(b.length - 20, 1 << 20);
  for (let i = 4; i < limit; i += 1) {
    if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) {
      const w = u32be(b, i + 8);
      const h = u32be(b, i + 12);
      if (w * h > width * height) { width = w; height = h; }
    }
  }
  if (!width || !height) return null;
  return { format: "heif", width, height, animated };
}

/** What a picture's headers say: { format, width, height, animated, ... }, or null for a file this
 *  can't read. */
export function inspectImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  try {
    if (b.length >= 13 && ascii(b, 0, 3) === "GIF") return gifInfo(b);
    if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return pngInfo(b);
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpegInfo(b);
    if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return webpInfo(b);
    if (b.length >= 16 && ascii(b, 4, 4) === "ftyp") return isobmffInfo(b);
  } catch { /* a truncated header: unreadable */ }
  return null;
}

/**
 * How a picture may be drawn: "show" (as it is), "still" (its first frame only) or "block" (a
 * placeholder: too big to decode, or not a picture this can read).
 */
export function imageDisplayPlan(bytes) {
  const info = inspectImage(bytes);
  if (!info || !(info.width > 0) || !(info.height > 0)) return "block";
  if (info.width * info.height > MAX_SOURCE_PIXELS) return "block";
  if (info.format === "gif") {
    if (info.maxFramePixels > MAX_SOURCE_PIXELS) return "block";
    if (!info.animated) return "show";
    const playable = info.frames <= MAX_PLAY_FRAMES
      && Math.max(info.width, info.height) <= MAX_PLAY_EDGE
      && info.maxFrameEdge <= MAX_PLAY_EDGE;
    return playable ? "show" : "still";
  }
  return info.animated ? "still" : "show";
}

/** The bytes of a data: URL (base64 or not), or null. */
export function dataUrlBytes(url) {
  const text = String(url || "");
  if (!text.startsWith("data:")) return null;
  const comma = text.indexOf(",");
  if (comma < 0) return null;
  const meta = text.slice(5, comma);
  const body = text.slice(comma + 1);
  try {
    if (/;base64$/i.test(meta)) {
      const binary = atob(body);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
      return out;
    }
    return new TextEncoder().encode(decodeURIComponent(body));
  } catch { return null; }
}

// Plans and stills, by the picture's own URL (a data: URL is its bytes): a thread redraws often.
const plans = new Map();
const stills = new Map();
function remember(map, key, value) {
  if (map.size > 300) map.delete(map.keys().next().value);
  map.set(key, value);
  return value;
}

/** imageDisplayPlan for a data: URL; anything else (a blob: or https: URL) is "show". */
export function planForDataUrl(url) {
  const key = String(url || "");
  if (!key.startsWith("data:")) return "show";
  if (plans.has(key)) return plans.get(key);
  const bytes = dataUrlBytes(key);
  return remember(plans, key, bytes ? imageDisplayPlan(bytes) : "block");
}

/** A picture's first frame as a still (a blob: URL of a PNG). */
export function stillOf(blobOrUrl, key = blobOrUrl) {
  if (typeof key === "string" && stills.has(key)) return stills.get(key);
  const work = (async () => {
    const blob = blobOrUrl instanceof Blob ? blobOrUrl : await (await fetch(blobOrUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    canvas.width = 0;
    canvas.height = 0;
    if (!png) throw new Error("no still");
    return URL.createObjectURL(png);
  })();
  if (typeof key === "string") remember(stills, key, work);
  work.catch(() => { if (typeof key === "string") stills.delete(key); });
  return work;
}

/** The placeholder a picture that can't be shown gets. */
export const BLOCKED_IMAGE_SRC = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 90"><rect width="120" height="90" rx="10" fill="#3a3a3c"/><path d="M42 30h36a4 4 0 0 1 4 4v22a4 4 0 0 1-4 4H42a4 4 0 0 1-4-4V34a4 4 0 0 1 4-4Z" fill="none" stroke="#8e8e93" stroke-width="3"/><path d="m36 26 48 38" stroke="#8e8e93" stroke-width="3" stroke-linecap="round"/></svg>')}`;

/** Draws `src` into `img` by its plan: as it is, as a still, or the placeholder. */
export function setGuardedImageSrc(img, src) {
  const plan = planForDataUrl(src);
  if (plan === "show") { img.src = src; return plan; }
  if (plan === "block") {
    img.src = BLOCKED_IMAGE_SRC;
    img.alt = "This picture can't be shown.";
    img.classList.add("image-blocked");
    return plan;
  }
  stillOf(src, src).then((url) => { img.src = url; }, () => { img.src = BLOCKED_IMAGE_SRC; img.classList.add("image-blocked"); });
  return plan;
}

/** A picture's bytes made safe to put in a blob: URL: as they are, a still, or an error. */
export async function guardedImageBlobUrl(bytes, type) {
  const plan = imageDisplayPlan(bytes);
  if (plan === "block") throw new Error("This picture can't be shown.");
  const blob = new Blob([bytes], { type });
  if (plan === "show") return URL.createObjectURL(blob);
  return stillOf(blob, null);
}
