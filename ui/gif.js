// Animated GIFs sent on chain (KaChat iOS d7c56280 GIFPrep, MESSAGING.md "GIFs"). Each photo tier
// buys the largest GIF that fits its byte budget: re-encoded at a smaller long edge, then with every
// second or third frame (a kept frame stays up for the dropped ones' time), so it still plays at its
// own speed. Re-encoding leaves out every bit of metadata, and the result is always image/gif.
//
// A browser has no GIF encoder (canvas writes PNG, JPEG and WebP only), so this reads and writes
// GIFs itself, in plain JavaScript: the same code in every browser and in the Node tests.
//   readGifFrames  - the frames as full RGBA pictures, composed as browsers show them
//   encodeGif      - a looping GIF from palette-indexed frames
//   prepareGifForTiers - iOS's search: edges 480 … 96, frame steps 1, 2, 3, first fit per budget

/** Longest edges tried, largest first (never larger than the GIF itself). */
export const GIF_EDGES = Object.freeze([480, 400, 360, 320, 280, 240, 200, 160, 128, 96]);
export const GIF_FRAME_STEPS = Object.freeze([1, 2, 3]);
/** What is read of a long GIF: a few seconds is what fits on chain anyway. */
export const GIF_MAX_FRAMES = 300;
export const GIF_MAX_SECONDS = 30;

export class GifNotAnimatedError extends Error {
  constructor() { super("That isn't an animated GIF. Please pick another."); this.name = "GifNotAnimatedError"; }
}

const yieldToPage = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

function isGifHeader(b) {
  return b.length >= 13 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61;
}

/** Skips a run of data sub-blocks starting at `pos` (its first length byte); the position after. */
function skipSubBlocks(b, pos) {
  while (pos < b.length) {
    const size = b[pos];
    pos += 1;
    if (size === 0) return pos;
    pos += size;
  }
  return b.length;
}

/** The GIF's structure without decoding pixels: screen size, global palette, and each image's
 *  descriptor, graphic control and where its compressed data sits. */
function parseGif(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isGifHeader(b)) return null;
  const width = b[6] | (b[7] << 8);
  const height = b[8] | (b[9] << 8);
  const flags = b[10];
  let pos = 13;
  let globalPalette = null;
  if (flags & 0x80) {
    const size = 3 * (1 << ((flags & 7) + 1));
    globalPalette = b.subarray(pos, pos + size);
    pos += size;
  }
  const images = [];
  let control = null;
  while (pos < b.length) {
    const marker = b[pos];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const label = b[pos + 1];
      if (label === 0xf9 && b[pos + 2] >= 4) {
        const packed = b[pos + 3];
        control = {
          disposal: (packed >> 2) & 7,
          transparent: (packed & 1) ? b[pos + 6] : -1,
          delayCs: b[pos + 4] | (b[pos + 5] << 8),
        };
      }
      pos = skipSubBlocks(b, pos + 2);
      continue;
    }
    if (marker === 0x2c) {
      if (pos + 10 > b.length) break;
      const left = b[pos + 1] | (b[pos + 2] << 8);
      const top = b[pos + 3] | (b[pos + 4] << 8);
      const w = b[pos + 5] | (b[pos + 6] << 8);
      const h = b[pos + 7] | (b[pos + 8] << 8);
      const packed = b[pos + 9];
      pos += 10;
      let palette = globalPalette;
      if (packed & 0x80) {
        const size = 3 * (1 << ((packed & 7) + 1));
        palette = b.subarray(pos, pos + size);
        pos += size;
      }
      const minCodeSize = b[pos];
      const dataStart = pos + 1;
      pos = skipSubBlocks(b, dataStart);
      images.push({ left, top, w, h, interlaced: Boolean(packed & 0x40), palette, minCodeSize, dataStart, dataEnd: pos, control: control || { disposal: 0, transparent: -1, delayCs: 0 } });
      control = null;
      continue;
    }
    break; // not a block a GIF has: what came before is all there is
  }
  return { bytes: b, width, height, images };
}

/** More than one frame: an animated GIF. */
export function isAnimatedGif(bytes) {
  try { return (parseGif(bytes)?.images.length || 0) > 1; } catch { return false; }
}

/** One image's compressed data, its sub-blocks joined. */
function imageData(b, image) {
  const parts = [];
  let total = 0;
  let pos = image.dataStart;
  while (pos < image.dataEnd) {
    const size = b[pos];
    if (!size) break;
    const chunk = b.subarray(pos + 1, Math.min(pos + 1 + size, b.length));
    parts.push(chunk);
    total += chunk.length;
    pos += size + 1;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** GIF LZW, as every decoder reads it. A short or broken stream leaves the rest of the picture 0. */
export function lzwDecode(data, minCodeSize, pixelCount) {
  const out = new Uint8Array(pixelCount);
  if (!(minCodeSize >= 2 && minCodeSize <= 8)) return out;
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  for (let c = 0; c < clear; c += 1) suffix[c] = c;
  let codeSize = minCodeSize + 1;
  let codeMask = (1 << codeSize) - 1;
  let avail = clear + 2;
  let oldCode = -1;
  let first = 0;
  let datum = 0;
  let bits = 0;
  let di = 0;
  let pi = 0;
  let top = 0;
  while (pi < pixelCount) {
    if (top === 0) {
      while (bits < codeSize) {
        if (di >= data.length) return out;
        datum |= data[di] << bits;
        di += 1;
        bits += 8;
      }
      let code = datum & codeMask;
      datum >>>= codeSize;
      bits -= codeSize;
      if (code === clear) {
        codeSize = minCodeSize + 1;
        codeMask = (1 << codeSize) - 1;
        avail = clear + 2;
        oldCode = -1;
        continue;
      }
      if (code === eoi) return out;
      if (oldCode === -1) {
        if (code >= clear) return out;
        out[pi] = suffix[code];
        pi += 1;
        oldCode = code;
        first = code;
        continue;
      }
      const inCode = code;
      if (code >= avail) {
        stack[top] = first;
        top += 1;
        code = oldCode;
      }
      while (code >= clear) {
        stack[top] = suffix[code];
        top += 1;
        code = prefix[code];
      }
      first = suffix[code];
      stack[top] = first;
      top += 1;
      if (avail < 4096) {
        prefix[avail] = oldCode;
        suffix[avail] = first;
        avail += 1;
        if ((avail & codeMask) === 0 && avail < 4096) {
          codeSize += 1;
          codeMask += avail;
        }
      }
      oldCode = inCode;
    }
    top -= 1;
    out[pi] = stack[top];
    pi += 1;
  }
  return out;
}

/** Interlaced rows come in four passes; the row each decoded row belongs on. */
function interlacedRowOrder(h) {
  const rows = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < h; y += step) rows.push(y);
  }
  return rows;
}

/**
 * Every frame as the full picture a browser shows (disposal and transparency applied), handed to
 * `onFrame(rgba, width, height, delaySeconds)` one at a time - the buffer is reused, so copy what
 * you keep. Stops at `maxFrames` or once `maxSeconds` have been read. Delays under 20 ms count as
 * 100 ms, as browsers play them. Returns the number of frames read.
 */
export async function readGifFrames(bytes, onFrame, { maxFrames = GIF_MAX_FRAMES, maxSeconds = GIF_MAX_SECONDS } = {}) {
  const gif = parseGif(bytes);
  if (!gif || !gif.width || !gif.height) throw new Error("This GIF can't be read.");
  const { width, height } = gif;
  const canvas = new Uint8ClampedArray(width * height * 4);
  let previousDisposal = 0;
  let previousRect = null;
  let saved = null;
  let count = 0;
  let seconds = 0;
  for (const image of gif.images) {
    if (count >= maxFrames || seconds >= maxSeconds) break;
    // What the previous frame asked to happen once it was shown.
    if (previousDisposal === 2 && previousRect) {
      const { left, top, w, h } = previousRect;
      for (let y = Math.max(0, top); y < Math.min(height, top + h); y += 1) {
        canvas.fill(0, (y * width + Math.max(0, left)) * 4, (y * width + Math.min(width, left + w)) * 4);
      }
    } else if (previousDisposal === 3 && saved) {
      canvas.set(saved);
    }
    const { disposal, transparent, delayCs } = image.control;
    saved = disposal === 3 ? canvas.slice() : null;
    const palette = image.palette;
    if (palette && image.w && image.h) {
      const indices = lzwDecode(imageData(gif.bytes, image), image.minCodeSize, image.w * image.h);
      const rows = image.interlaced ? interlacedRowOrder(image.h) : null;
      const colors = palette.length / 3;
      for (let row = 0; row < image.h; row += 1) {
        const y = image.top + (rows ? rows[row] : row);
        if (y < 0 || y >= height) continue;
        for (let col = 0; col < image.w; col += 1) {
          const x = image.left + col;
          if (x < 0 || x >= width) continue;
          const index = indices[row * image.w + col];
          if (index === transparent || index >= colors) continue;
          const at = (y * width + x) * 4;
          canvas[at] = palette[index * 3];
          canvas[at + 1] = palette[index * 3 + 1];
          canvas[at + 2] = palette[index * 3 + 2];
          canvas[at + 3] = 255;
        }
      }
    }
    const delay = delayCs < 2 ? 0.1 : delayCs / 100;
    await onFrame(canvas, width, height, delay);
    count += 1;
    seconds += delay;
    previousDisposal = disposal;
    previousRect = image;
    if (count % 4 === 0) await yieldToPage();
  }
  return count;
}

// ---------------------------------------------------------------------------------------------
// Scaling and colours
// ---------------------------------------------------------------------------------------------

/** An RGBA picture shrunk to dw × dh by averaging the pixels each new one covers (alpha-weighted,
 *  so a transparent edge doesn't darken it). Same size: a copy. */
export function scaleRgba(src, sw, sh, dw, dh) {
  if (dw === sw && dh === sh) return new Uint8ClampedArray(src);
  const out = new Uint8ClampedArray(dw * dh * 4);
  const xStart = new Int32Array(dw + 1);
  for (let x = 0; x <= dw; x += 1) xStart[x] = Math.min(sw, Math.floor((x * sw) / dw));
  for (let dy = 0; dy < dh; dy += 1) {
    const y0 = Math.floor((dy * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.min(sh, Math.floor(((dy + 1) * sh) / dh)));
    for (let dx = 0; dx < dw; dx += 1) {
      const x0 = xStart[dx];
      const x1 = Math.max(x0 + 1, xStart[dx + 1]);
      let r = 0; let g = 0; let bl = 0; let a = 0; let n = 0;
      for (let y = y0; y < y1; y += 1) {
        let at = (y * sw + x0) * 4;
        for (let x = x0; x < x1; x += 1) {
          const alpha = src[at + 3];
          r += src[at] * alpha;
          g += src[at + 1] * alpha;
          bl += src[at + 2] * alpha;
          a += alpha;
          n += 1;
          at += 4;
        }
      }
      const o = (dy * dw + dx) * 4;
      if (a > 0) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = bl / a;
      }
      out[o + 3] = a / n;
    }
  }
  return out;
}

/** Up to `maxColors` colours for these pictures, by median cut over a 5-bit-per-channel histogram
 *  of their opaque pixels. A Uint8Array of r, g, b triples. */
export function buildPalette(pictures, maxColors = 255) {
  const histogram = new Uint32Array(32768);
  const total = pictures.reduce((sum, p) => sum + p.length / 4, 0);
  const stride = Math.max(1, Math.floor(total / 400_000));
  let seen = 0;
  for (const picture of pictures) {
    for (let i = 0; i < picture.length; i += 4 * stride) {
      if (picture[i + 3] < 128) continue;
      histogram[((picture[i] >> 3) << 10) | ((picture[i + 1] >> 3) << 5) | (picture[i + 2] >> 3)] += 1;
      seen += 1;
    }
  }
  if (!seen) return new Uint8Array([0, 0, 0]);
  const bins = [];
  for (let key = 0; key < 32768; key += 1) if (histogram[key]) bins.push(key);
  const channel = (key, c) => (c === 0 ? key >> 10 : c === 1 ? (key >> 5) & 31 : key & 31);
  const boxOf = (keys) => {
    const min = [31, 31, 31];
    const max = [0, 0, 0];
    let count = 0;
    for (const key of keys) {
      for (let c = 0; c < 3; c += 1) {
        const v = channel(key, c);
        if (v < min[c]) min[c] = v;
        if (v > max[c]) max[c] = v;
      }
      count += histogram[key];
    }
    return { keys, min, max, count };
  };
  const boxes = [boxOf(bins)];
  while (boxes.length < maxColors) {
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i];
      if (box.keys.length < 2) continue;
      const range = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
      const score = range * Math.sqrt(box.count);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) break;
    const box = boxes[best];
    const ranges = [0, 1, 2].map((c) => box.max[c] - box.min[c]);
    const axis = ranges.indexOf(Math.max(...ranges));
    const sorted = [...box.keys].sort((a, b) => channel(a, axis) - channel(b, axis));
    let half = box.count / 2;
    let cut = 1;
    for (let i = 0; i < sorted.length - 1; i += 1) {
      half -= histogram[sorted[i]];
      if (half <= 0) { cut = i + 1; break; }
      cut = i + 1;
    }
    boxes.splice(best, 1, boxOf(sorted.slice(0, cut)), boxOf(sorted.slice(cut)));
  }
  const palette = new Uint8Array(boxes.length * 3);
  boxes.forEach((box, i) => {
    let r = 0; let g = 0; let bl = 0;
    for (const key of box.keys) {
      const n = histogram[key];
      r += (((key >> 10) << 3) + 4) * n;
      g += ((((key >> 5) & 31) << 3) + 4) * n;
      bl += (((key & 31) << 3) + 4) * n;
    }
    palette[i * 3] = Math.round(r / box.count);
    palette[i * 3 + 1] = Math.round(g / box.count);
    palette[i * 3 + 2] = Math.round(bl / box.count);
  });
  return palette;
}

/** Maps RGBA pictures onto `palette`: each pixel its nearest colour, alpha under 128 the
 *  transparent index. Nearest colours are worked out once per 5-bit bin. */
export function makePaletteMapper(palette, transparentIndex) {
  const colors = palette.length / 3;
  const cache = new Int16Array(32768).fill(-1);
  const nearest = (key) => {
    const r = ((key >> 10) << 3) + 4;
    const g = (((key >> 5) & 31) << 3) + 4;
    const b = ((key & 31) << 3) + 4;
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < colors; i += 1) {
      const dr = palette[i * 3] - r;
      const dg = palette[i * 3 + 1] - g;
      const db = palette[i * 3 + 2] - b;
      const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (d < bestDistance) { bestDistance = d; best = i; }
    }
    return best;
  };
  return (rgba) => {
    const out = new Uint8Array(rgba.length / 4);
    for (let i = 0, p = 0; p < out.length; i += 4, p += 1) {
      if (rgba[i + 3] < 128) { out[p] = transparentIndex; continue; }
      const key = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
      let index = cache[key];
      if (index < 0) { index = nearest(key); cache[key] = index; }
      out[p] = index;
    }
    return out;
  };
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

class TooBig extends Error {}

class ByteWriter {
  constructor(limit) { this.buf = new Uint8Array(65536); this.length = 0; this.limit = limit; }
  ensure(n) {
    if (this.length + n > this.limit) throw new TooBig();
    if (this.length + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + n));
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  byte(v) { this.ensure(1); this.buf[this.length] = v; this.length += 1; }
  word(v) { this.ensure(2); this.buf[this.length] = v & 255; this.buf[this.length + 1] = (v >> 8) & 255; this.length += 2; }
  bytes(arr) { this.ensure(arr.length); this.buf.set(arr, this.length); this.length += arr.length; }
  result() { return this.buf.slice(0, this.length); }
}

/** GIF LZW at 8-bit minimum code size, written as sub-blocks (giflib's scheme: codes grow from 9 to
 *  12 bits, a clear code when the table fills). */
function lzwEncode(indices, writer) {
  const clear = 256;
  const eoi = 257;
  const table = new Int16Array(1 << 20).fill(-1);
  const used = new Int32Array(4096);
  let usedCount = 0;
  let next = 258;
  let codeSize = 9;
  let maxCode = 511;
  let clearing = false;
  let cur = 0;
  let curBits = 0;
  const block = new Uint8Array(255);
  let blockLength = 0;
  const flushBlock = () => {
    if (!blockLength) return;
    writer.byte(blockLength);
    writer.bytes(block.subarray(0, blockLength));
    blockLength = 0;
  };
  const emit = (code) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) {
      block[blockLength] = cur & 255;
      blockLength += 1;
      if (blockLength === 255) flushBlock();
      cur >>>= 8;
      curBits -= 8;
    }
    if (clearing) {
      codeSize = 9;
      maxCode = 511;
      clearing = false;
    } else if (next > maxCode && codeSize < 12) {
      codeSize += 1;
      maxCode = codeSize === 12 ? 4096 : (1 << codeSize) - 1;
    }
  };
  writer.byte(8);
  emit(clear);
  if (!indices.length) {
    emit(eoi);
  } else {
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i += 1) {
      const c = indices[i];
      const key = (prefix << 8) | c;
      const code = table[key];
      if (code >= 0) { prefix = code; continue; }
      emit(prefix);
      prefix = c;
      if (next < 4096) {
        table[key] = next;
        used[usedCount] = key;
        usedCount += 1;
        next += 1;
      } else {
        for (let u = 0; u < usedCount; u += 1) table[used[u]] = -1;
        usedCount = 0;
        next = 258;
        clearing = true;
        emit(clear);
      }
    }
    emit(prefix);
    emit(eoi);
  }
  if (curBits > 0) {
    block[blockLength] = cur & 255;
    blockLength += 1;
    if (blockLength === 255) flushBlock();
  }
  flushBlock();
  writer.byte(0);
}

/**
 * A looping GIF (loop count 0, nothing but frames and delays) of `frames`: [{indices, delay}] with
 * `indices` a width × height Uint8Array into `palette` (r, g, b triples, at most 255 colours) and
 * `transparentIndex` the one index left for transparency. Frames after the first carry only the
 * box that changed, unchanged pixels transparent, unless the picture has transparency of its own.
 * Null when it would be larger than `limit` bytes.
 */
export function encodeGif(frames, width, height, palette, transparentIndex, { limit = Infinity } = {}) {
  const writer = new ByteWriter(limit);
  try {
    writer.bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    writer.word(width);
    writer.word(height);
    writer.byte(0xf7); // global table of 256 colours, 8 bits of colour resolution
    writer.byte(0);
    writer.byte(0);
    const table = new Uint8Array(768);
    table.set(palette.subarray(0, Math.min(palette.length, 765)));
    writer.bytes(table);
    // NETSCAPE2.0, loop forever
    writer.bytes([0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, 0x03, 0x01, 0x00, 0x00, 0x00]);
    const ownTransparency = frames.some((frame) => frame.indices.includes(transparentIndex));
    // Identical frames merged: one frame up for both times.
    const merged = [];
    for (const frame of frames) {
      const last = merged[merged.length - 1];
      if (last && !ownTransparency && sameIndices(last.indices, frame.indices)) { last.delay += frame.delay; continue; }
      merged.push({ indices: frame.indices, delay: frame.delay });
    }
    let previous = null;
    for (const frame of merged) {
      let left = 0; let top = 0; let w = width; let h = height;
      let pixels = frame.indices;
      let usesTransparency = ownTransparency;
      if (previous && !ownTransparency) {
        const box = changedBox(previous, frame.indices, width, height);
        left = box.left; top = box.top; w = box.w; h = box.h;
        pixels = new Uint8Array(w * h);
        for (let y = 0; y < h; y += 1) {
          const row = (top + y) * width + left;
          for (let x = 0; x < w; x += 1) {
            const value = frame.indices[row + x];
            pixels[y * w + x] = value === previous[row + x] ? transparentIndex : value;
          }
        }
        usesTransparency = true;
      }
      const centiseconds = Math.max(2, Math.round(frame.delay * 100));
      writer.bytes([0x21, 0xf9, 0x04, ((ownTransparency ? 2 : 1) << 2) | (usesTransparency ? 1 : 0)]);
      writer.word(Math.min(65535, centiseconds));
      writer.byte(usesTransparency ? transparentIndex : 0);
      writer.byte(0);
      writer.byte(0x2c);
      writer.word(left);
      writer.word(top);
      writer.word(w);
      writer.word(h);
      writer.byte(0);
      lzwEncode(pixels, writer);
      previous = frame.indices;
    }
    writer.byte(0x3b);
    return writer.result();
  } catch (error) {
    if (error instanceof TooBig) return null;
    throw error;
  }
}

function sameIndices(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** The smallest box holding every pixel that changed (at least one pixel). */
function changedBox(before, after, width, height) {
  let minX = width; let minY = height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (before[row + x] !== after[row + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { left: 0, top: 0, w: 1, h: 1 };
  return { left: minX, top: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// ---------------------------------------------------------------------------------------------
// The tiers
// ---------------------------------------------------------------------------------------------

/**
 * The GIF each budget buys, as {budget: Uint8Array} (iOS GIFPrep.prepareForTiers): edges from the
 * GIF's own (at most 480) down to 96, at each every frame, then every second, then every third;
 * each budget takes the first that fits. A budget nothing fits has no entry. Throws
 * GifNotAnimatedError for one frame or none.
 */
export async function prepareGifForTiers(bytes, budgets) {
  const largest = GIF_EDGES[0];
  const frames = [];
  let ownEdge = 0;
  let sourceWidth = 0;
  let sourceHeight = 0;
  let topWidth = 0;
  let topHeight = 0;
  await readGifFrames(bytes, (rgba, width, height, delay) => {
    if (!ownEdge) {
      sourceWidth = width;
      sourceHeight = height;
      ownEdge = Math.max(width, height);
      const top = Math.min(ownEdge, largest);
      topWidth = Math.max(1, Math.round((width * top) / ownEdge));
      topHeight = Math.max(1, Math.round((height * top) / ownEdge));
    }
    frames.push({ rgba: scaleRgba(rgba, sourceWidth, sourceHeight, topWidth, topHeight), delay });
  });
  if (frames.length < 2) throw new GifNotAnimatedError();
  const top = Math.min(ownEdge, largest);
  const candidateEdges = [top, ...GIF_EDGES.filter((edge) => edge < top)];
  const transparentIndex = 255;
  const palette = buildPalette(frames.map((frame) => frame.rgba), 255);
  const toIndices = makePaletteMapper(palette, transparentIndex);

  const open = new Set(budgets);
  const results = {};
  for (const edge of candidateEdges) {
    if (!open.size) break;
    const w = Math.max(1, Math.round((topWidth * edge) / top));
    const h = Math.max(1, Math.round((topHeight * edge) / top));
    const indexed = [];
    for (const frame of frames) {
      indexed.push(toIndices(edge === top ? frame.rgba : scaleRgba(frame.rgba, topWidth, topHeight, w, h)));
      if (indexed.length % 8 === 0) await yieldToPage();
    }
    for (const step of GIF_FRAME_STEPS) {
      if (!open.size) break;
      const kept = [];
      for (let start = 0; start < indexed.length; start += step) {
        let delay = 0;
        for (let i = start; i < Math.min(start + step, indexed.length); i += 1) delay += frames[i].delay;
        kept.push({ indices: indexed[start], delay });
      }
      if (kept.length < 2) continue;
      // Stops as soon as it outgrows the largest budget still open: no budget could take it.
      const encoded = encodeGif(kept, w, h, palette, transparentIndex, { limit: Math.max(...open) });
      await yieldToPage();
      if (!encoded) continue;
      for (const budget of [...open]) {
        if (encoded.length <= budget) {
          results[budget] = encoded;
          open.delete(budget);
        }
      }
    }
  }
  return results;
}
