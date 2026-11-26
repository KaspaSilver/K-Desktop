// Owner, 2026-11-26: the console filled with "Fetch API cannot load data:audio/webm..." and
// "Connecting to 'blob:...' violates ... connect-src". The CSP lets fetch() reach only 'self',
// https: and wss:, so a voice note's waveform (and photo Share, and a still of an animated
// picture) read their own data:/blob: addresses through ui/local-url-bytes.js instead.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const created = [];
const revoked = [];
URL.createObjectURL = (blob) => { const url = `blob:https://desktop.kachat.app/${created.length}`; created.push(blob); return url; };
URL.revokeObjectURL = (url) => { revoked.push(url); };
const { objectUrlFor, revokeObjectUrl, dataUrlBlob, localUrlBlob } = await import("../ui/local-url-bytes.js");
const read = (...p) => readFileSync(new URL(`../${p.join("/")}`, import.meta.url), "utf8");

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}
const fetches = [];
globalThis.fetch = async (url) => { fetches.push(String(url)); return new Response("net", { status: 200 }); };

await test("a data: address is decoded in place, never fetched", async () => {
  const b64 = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0xff]).toString("base64");
  const blob = await localUrlBlob(`data:audio/webm;base64,${b64}`);
  assert.equal(blob.type, "audio/webm");
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0x1a, 0x45, 0xdf, 0xa3, 0xff]);
  assert.equal(await (await localUrlBlob("data:text/plain,hello%20there")).text(), "hello there");
  assert.equal(dataUrlBlob("https://example.com/x"), null);
  assert.deepEqual(fetches, []);
});

await test("the app's own blob: addresses are read back; a stranger's fails, never fetched", async () => {
  const url = objectUrlFor(new Blob(["wav bytes"], { type: "audio/wav" }));
  assert.equal(await (await localUrlBlob(url)).text(), "wav bytes");
  await assert.rejects(localUrlBlob("blob:https://desktop.kachat.app/unknown"));
  revokeObjectUrl(url);
  assert.deepEqual(revoked, [url]);
  await assert.rejects(localUrlBlob(url), "forgotten once revoked");
  assert.deepEqual(fetches, []);
});

await test("only the newest 24 object addresses are kept (a joined note's WAV can be megabytes)", async () => {
  const urls = Array.from({ length: 30 }, (_, i) => objectUrlFor(new Blob([String(i)])));
  await assert.rejects(localUrlBlob(urls[0]));
  assert.equal(await (await localUrlBlob(urls[29])).text(), "29");
  assert.equal(await (await localUrlBlob(urls[6])).text(), "6");
});

await test("anything else is still fetched", async () => {
  assert.equal(await (await localUrlBlob("https://desktop.kachat.app/x.png")).text(), "net");
  assert.deepEqual(fetches, ["https://desktop.kachat.app/x.png"]);
});

await test("the waveform, photo Share and stills read through it; joined notes and shown pictures are remembered", () => {
  const app = read("ui", "app.js");
  assert.match(app, /const bytes = await \(await localUrlBlob\(src\)\)\.arrayBuffer\(\);/);
  assert.match(app, /const blob = await localUrlBlob\(src\);\n\s*const file = new File\(\[blob\], photoPreviewName/);
  const guard = read("ui", "image-guard.js");
  assert.match(guard, /await localUrlBlob\(blobOrUrl\)/);
  assert.match(guard, /if \(plan === "show"\) return objectUrlFor\(blob\);/);
  assert.doesNotMatch(guard, /await fetch\(|\(fetch\(/);
  const notes = read("ui", "voice-notes.js");
  assert.match(notes, /return objectUrlFor\(pcmToWavBlob\(pcm\)\);/);
  assert.match(notes, /setTimeout\(\(\) => revokeObjectUrl\(old\.url\), 60_000\);/);
  // and the policy itself is unchanged
  assert.match(read("public", "_headers"), /connect-src 'self' https: wss:;/);
});

console.log(`local url bytes: ${passed} passed`);
