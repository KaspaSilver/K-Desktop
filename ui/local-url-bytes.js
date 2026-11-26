// Reading what a data: or blob: address holds, without fetch() (owner, 2026-11-26: the console was
// full of "Fetch API cannot load data:audio/webm..." and "Connecting to 'blob:...' violates ...
// connect-src"). The site's Content-Security-Policy lets fetch() reach only 'self', https: and
// wss: (tools/security-headers.mjs, DSK-014), so reading a voice note's own data: address to draw
// its waveform, or a joined note's blob: address, was refused every time and the bars stayed the
// placeholder. Those addresses hold bytes already in this page, so they're read here directly and
// the policy stays as tight as it is:
//   - data: is decoded in place (base64 or percent-encoded);
//   - blob: is looked up among the object addresses the app made through objectUrlFor (a browser
//     can't turn a blob: address back into its Blob without fetch); one it didn't make fails.
//   - anything else is fetched as before.

const MAX_REMEMBERED = 24; // the newest object addresses; a joined voice note's WAV can be megabytes
const remembered = new Map(); // object address -> Blob, oldest first

/** URL.createObjectURL, with the Blob kept so localUrlBlob can read it back. */
export function objectUrlFor(blob) {
  const url = URL.createObjectURL(blob);
  remembered.set(url, blob);
  while (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.keys().next().value);
  return url;
}

/** URL.revokeObjectURL, and the kept Blob goes too. */
export function revokeObjectUrl(url) {
  remembered.delete(url);
  try { URL.revokeObjectURL(url); } catch { /* not one */ }
}

/** A data: address's bytes and type, or null when it isn't one. */
export function dataUrlBlob(src) {
  const text = String(src || "");
  if (!/^data:/i.test(text)) return null;
  const comma = text.indexOf(",");
  if (comma < 0) throw new Error("malformed data address");
  const header = text.slice(5, comma);
  const body = text.slice(comma + 1);
  const parts = header.split(";");
  const type = (parts[0] || "text/plain").trim().toLowerCase();
  let bytes;
  if (parts.slice(1).some((p) => p.trim().toLowerCase() === "base64")) {
    const binary = atob(body.replace(/\s+/g, ""));
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(body));
  }
  return new Blob([bytes], { type });
}

/** The Blob an address holds: data: and the app's own blob: read here, anything else fetched. */
export async function localUrlBlob(src) {
  const text = String(src || "");
  const fromData = dataUrlBlob(text);
  if (fromData) return fromData;
  if (/^blob:/i.test(text)) {
    const blob = remembered.get(text);
    if (blob) return blob;
    throw new Error("not one of this app's object addresses");
  }
  const response = await fetch(text);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.blob();
}
