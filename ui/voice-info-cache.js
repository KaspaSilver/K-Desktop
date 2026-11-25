// A voice note's length and waveform, worked out once per page (K 961fc05a VoiceNoteInfoCache,
// audit 2026-11-25 B9). The thread is drawn again on every change, and each draw of a voice bubble
// used to start decoding its note again while the last decode was still running; now a bubble
// drawn again, or the same note in another view, shares one decode. At most 500 notes are kept,
// least recently used first out; a note that couldn't be read is tried again next time.

/** The cache key for a player's `src`. A data: URL (an on-chain note, a few tens of KB) is keyed
 *  by its length, two 32-bit hashes over every character and its tail, so a note never reads
 *  another's entry and the cache doesn't hold the notes themselves; anything else (a blob: or
 *  https URL) by itself. */
export function voiceInfoKey(src) {
  const s = String(src || "");
  if (!s.startsWith("data:")) return s;
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    h2 ^= h2 >>> 15;
  }
  return `data:${s.length}:${h1.toString(16)}:${h2.toString(16)}:${s.slice(-32)}`;
}

export const VOICE_INFO_CAP = 500;

export function createVoiceInfoCache({ cap = VOICE_INFO_CAP } = {}) {
  const entries = new Map(); // key -> Promise<info|null>
  return {
    /** `decode()`'s answer for `key`, decoded at most once while it's kept. */
    load(key, decode) {
      if (entries.has(key)) {
        const kept = entries.get(key);
        entries.delete(key);
        entries.set(key, kept);
        return kept;
      }
      const pending = Promise.resolve()
        .then(decode)
        .catch(() => null)
        .then((info) => {
          if (!info && entries.get(key) === pending) entries.delete(key);
          return info || null;
        });
      entries.set(key, pending);
      while (entries.size > cap) entries.delete(entries.keys().next().value);
      return pending;
    },
    has: (key) => entries.has(key),
    get size() { return entries.size; },
    clear: () => entries.clear(),
  };
}
