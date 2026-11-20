// node tools/test-ios-d7c56280-gif.mjs - GIFs on chain (KaChat iOS d7c56280 GIFPrep): the GIF reader
// and writer round-trip, one frame is "not animated", the tier search keeps iOS's order (edges 480 …
// 96, frame steps 1-3, first fit per budget, a dropped frame's time kept), and a GIF goes as an
// image/gif photo, its parts named animation-iofN.gif.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GIF_EDGES, GIF_FRAME_STEPS, GIF_MAX_FRAMES, GIF_MAX_SECONDS, GifNotAnimatedError,
  encodeGif, readGifFrames, isAnimatedGif, prepareGifForTiers, lzwDecode,
} from "../ui/gif.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");

let failures = 0;
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.log(`FAIL - ${name}\n`, error); }
}

const palette = new Uint8Array(255 * 3);
for (let i = 0; i < 255; i += 1) { palette[i * 3] = i; palette[i * 3 + 1] = (i * 7) & 255; palette[i * 3 + 2] = 255 - i; }
function movie(w, h, count, delay = 0.05, noise = false) {
  const frames = [];
  let seed = 7;
  for (let f = 0; f < count; f += 1) {
    const indices = new Uint8Array(w * h);
    for (let i = 0; i < indices.length; i += 1) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      indices[i] = noise ? seed % 254 : ((i % w) * 3 + f * 5) % 254;
    }
    frames.push({ indices, delay });
  }
  return frames;
}

await test("the writer's GIF reads back pixel for pixel, with its delays", async () => {
  const frames = movie(40, 30, 5, 0.07);
  const gif = encodeGif(frames, 40, 30, palette, 255);
  assert.ok(isAnimatedGif(gif));
  const seen = [];
  await readGifFrames(gif, (rgba, w, h, delay) => seen.push({ rgba: rgba.slice(), w, h, delay }));
  assert.equal(seen.length, 5);
  for (let f = 0; f < 5; f += 1) {
    assert.equal(seen[f].delay, 0.07);
    for (const p of [0, 123, 599, 1199]) {
      const index = frames[f].indices[p];
      assert.deepEqual([...seen[f].rgba.slice(p * 4, p * 4 + 4)], [palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2], 255], `frame ${f} pixel ${p}`);
    }
  }
});
await test("LZW survives a table that fills and clears", () => {
  const frames = movie(300, 200, 2, 0.1, true);
  const gif = encodeGif(frames, 300, 200, palette, 255);
  return readGifFrames(gif, () => {}).then((n) => assert.equal(n, 2));
});
await test("identical frames merge, keeping their time", async () => {
  const one = movie(10, 10, 1)[0];
  const gif = encodeGif([one, { ...one }, movie(10, 10, 2)[1]], 10, 10, palette, 255);
  const delays = [];
  await readGifFrames(gif, (_rgba, _w, _h, delay) => delays.push(delay));
  assert.deepEqual(delays, [0.1, 0.05]);
});
await test("a writer limit returns null instead of an oversized GIF", () => {
  assert.equal(encodeGif(movie(200, 200, 4, 0.05, true), 200, 200, palette, 255, { limit: 5000 }), null);
});
await test("one frame is not animated", async () => {
  const still = encodeGif(movie(8, 8, 1), 8, 8, palette, 255);
  assert.ok(!isAnimatedGif(still));
  assert.ok(!isAnimatedGif(new Uint8Array([1, 2, 3])));
  await assert.rejects(prepareGifForTiers(still, [10_000]), GifNotAnimatedError);
});
await test("iOS's limits and order", () => {
  assert.deepEqual([...GIF_EDGES], [480, 400, 360, 320, 280, 240, 200, 160, 128, 96]);
  assert.deepEqual([...GIF_FRAME_STEPS], [1, 2, 3]);
  assert.equal(GIF_MAX_FRAMES, 300);
  assert.equal(GIF_MAX_SECONDS, 30);
  assert.equal(lzwDecode(new Uint8Array(), 8, 4).length, 4, "a short stream leaves zeros");
});
await test("each budget gets the largest GIF that fits; a dropped frame's time is kept; none for an impossible budget", async () => {
  const big = encodeGif(movie(600, 400, 12, 0.05, true), 600, 400, palette, 255);
  const out = await prepareGifForTiers(big, [400_000, 40_000, 50]);
  assert.ok(!(50 in out), "nothing fits 50 bytes");
  assert.ok(out[400_000].length <= 400_000 && out[40_000].length <= 40_000);
  const sizes = [];
  const delays = [];
  await readGifFrames(out[40_000], (_rgba, w, h, delay) => { sizes.push(Math.max(w, h)); delays.push(delay); });
  assert.ok(GIF_EDGES.includes(sizes[0]), `a listed edge (${sizes[0]})`);
  const total = delays.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 0.6) < 0.011, `plays as long as the original (${total})`);
  let w0 = 0;
  await readGifFrames(out[400_000], (_rgba, w) => { w0 ||= w; });
  assert.ok(w0 >= sizes[0], "the bigger budget is never smaller");
});
await test("a GIF goes as an image/gif photo; its parts are animation-iofN.gif and join as a GIF", async () => {
  const VoiceNotes = await import("../ui/voice-notes.js");
  const one = JSON.parse(VoiceNotes.photoEnvelopes(new Uint8Array(1000), { mimeType: "image/gif" })[0]);
  assert.equal(one.mimeType, "image/gif");
  assert.equal(one.name, "animation.gif");
  assert.match(one.content, /^data:image\/gif;base64,/);
  const parts = VoiceNotes.photoEnvelopes(new Uint8Array(70_000), { mimeType: "image/gif" }).map((t) => JSON.parse(t));
  assert.ok(parts.length > 1);
  assert.equal(parts[0].name, `animation-1of${parts.length}.gif`);
  assert.ok(parts[0].mediaPart);
  assert.equal(JSON.parse(VoiceNotes.photoEnvelopes(new Uint8Array(10))[0]).name, "photo.jpg", "photos unchanged");
  assert.match(read("ui/voice-notes.js"), /const mime = \/"mimeType"/);
});
await test("the composers: GIF tiles, always on chain, GIF Quality and its messages", () => {
  const app = read("ui/app.js");
  const html = read("index.html");
  assert.match(html, /data-composer-gif title="Send an animated GIF from your library\."/);
  assert.match(html, /data-pending-photo-gif hidden aria-hidden="true">GIF</);
  assert.match(html, /data-group-pending-photo-gif hidden/);
  assert.match(app, /\{ id: "gif", title: "GIF", subtitle: "Send an animated GIF from your library to the group\.", icon: ACTION_TILE_ICONS\.gif \}/);
  assert.match(app, /title: "GIF Quality",/);
  assert.match(app, /const GIF_NOT_ANIMATED_TEXT = "That isn't an animated GIF\. Please pick another\.";/);
  assert.match(app, /const GIF_TOO_LONG_TEXT = "This GIF is too long for that quality\. Pick a higher one, or a shorter GIF\.";/);
  assert.match(app, /VoiceNotes\.photoEnvelopes\(gif, \{ group, mimeType: "image\/gif" \}\)/);
  assert.match(app, /photoFileInput\.accept = "image\/gif";/);
  assert.match(app, /groupPhotoInput\.accept = "image\/gif";/);
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log(`ios d7c56280 gif: ${passed} passed`);
