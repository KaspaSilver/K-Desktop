// Which chat payments are KaPost tips, and the post each one tipped (K b0f0a4e6 KaPostTipLedger).
// A tip (`kchat:1:tip:`) is a payment in the tipper's 1:1 chat: its card says "Received tip" /
// "Sent tip" and a click opens the tipped post, and its notification reads "Received a tip".
//
// The answer lives on the payment message itself (`tipPostId`, or `tipChecked` for a payment
// that isn't one), so the chat redraws that card when it lands and it is kept with the message.
// A tip this app sends is marked at once; any other payment's transaction is read once, a few at
// a time, and a read that fails is asked again next session, never in a loop.

const TIP_PREFIX = "kchat:1:tip:";
const MAX_CONCURRENT = 2;

/** The tipped post's txid when a transaction's payload (REST hex) is a KaPost tip:
 *  `kchat:1:tip:<pubkey>:<signature>:<post_id>:<author_pubkey>:<sealed_hex>`; else null. */
export function tipPostIdFromPayloadHex(payloadHex) {
  const hex = String(payloadHex || "").trim().toLowerCase();
  if (!hex || hex.length % 2 || !/^[0-9a-f]+$/.test(hex)) return null;
  const prefixHex = Array.from(new TextEncoder().encode(TIP_PREFIX), (b) => b.toString(16).padStart(2, "0")).join("");
  if (!hex.startsWith(prefixHex)) return null;
  let text = "";
  try {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { return null; }
  const fields = text.slice(TIP_PREFIX.length).split(":");
  if (fields.length !== 5 || !fields[4] || !/^[0-9a-f]{64}$/i.test(fields[2])) return null;
  return fields[2].toLowerCase();
}

/** Whether a payment message could be a tip still to be asked about. */
export function tipNeedsLookup(message) {
  if (!message || message.tipPostId || message.tipChecked) return false;
  return /^[0-9a-f]{64}$/i.test(String(message.txid || ""));
}

/**
 * fetchTx(txid) -> the REST transaction or null; onAnswer(message, { tipPostId } | { tipChecked })
 * patches and saves it. Returns { resolve(message), resolveNow(message) }: `resolve` queues the
 * lookup, `resolveNow` waits for it (the incoming notification asks before it words itself).
 */
export function createTipResolver({ fetchTx, onAnswer }) {
  const asked = new Set(); // this session: a failed read isn't retried until the next one
  const waiting = new Map(); // txid -> promise
  const queue = [];
  let running = 0;

  function pump() {
    while (running < MAX_CONCURRENT && queue.length) {
      const job = queue.shift();
      running += 1;
      job().finally(() => { running -= 1; pump(); });
    }
  }

  function lookup(message) {
    const txid = String(message?.txid || "").toLowerCase();
    if (!tipNeedsLookup(message)) return Promise.resolve(message?.tipPostId || null);
    if (waiting.has(txid)) return waiting.get(txid);
    if (asked.has(txid)) return Promise.resolve(null);
    asked.add(txid);
    const promise = new Promise((resolve) => {
      queue.push(async () => {
        let tx = null;
        try { tx = await fetchTx(txid); } catch { tx = null; }
        // not readable now (not listed yet, offline): asked again next session
        if (!tx) { resolve(null); return; }
        const postId = tipPostIdFromPayloadHex(tx.payload);
        try { onAnswer(message, postId ? { tipPostId: postId } : { tipChecked: true }); } catch { /* the chat moved on */ }
        resolve(postId);
      });
      pump();
    }).finally(() => waiting.delete(txid));
    waiting.set(txid, promise);
    return promise;
  }

  return {
    resolve(message) { lookup(message).catch(() => {}); },
    resolveNow(message, timeoutMs = 4000) {
      return Promise.race([lookup(message), new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))]);
    },
  };
}
