// A chat payment (or tip) sent From a spending address whose send got no answer
// (SEND_OUTCOME_UNKNOWN): its payment_notice waits until the payment shows up, then goes from the
// account that made it only (K 01f71184 audit C5, ChatService.owedSpendingNotices). Sent at once it
// could name a payment that never lands; never sent, the payee has the KAS with no bubble or memo.
// In memory, a week at most, as on K. Pure, for tools/test-ios-01f71184-bell.mjs.

export const OWED_NOTICE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

const lower = (value) => String(value || "").trim().toLowerCase();

export function createOwedSpendingNotices({ now = () => Date.now() } = {}) {
  const owed = new Map(); // txid -> { contactAddress, amountSompi, memo, owner, at }
  const prune = () => {
    const at = now();
    for (const [key, entry] of owed) if (at - entry.at >= OWED_NOTICE_KEEP_MS) owed.delete(key);
  };
  return {
    /** Remembers the notice `txId` owes. False (nothing kept) without a txid, contact or owner. */
    owe({ txId, contactAddress, amountSompi, memo = "", owner }) {
      const key = lower(txId);
      if (!/^[0-9a-f]{64}$/.test(key) || !lower(contactAddress) || !String(owner || "").trim()) return false;
      let amount;
      try { amount = BigInt(amountSompi); } catch { return false; }
      if (amount <= 0n) return false;
      prune();
      owed.set(key, { contactAddress: String(contactAddress), amountSompi: amount, memo: String(memo || ""), owner: String(owner), at: now() });
      return true;
    },
    /** The "Not confirmed" payment `txId` to `contactAddress` turned out sent: the notice it owes,
     *  taken off the list, when `account` (the one open now) made it; else null, and it stays. */
    take({ txId, contactAddress, account }) {
      prune();
      const key = lower(txId);
      const entry = owed.get(key);
      if (!entry || lower(entry.contactAddress) !== lower(contactAddress)) return null;
      if (!account || entry.owner !== account) return null;
      owed.delete(key);
      return { txId: key, ...entry };
    },
    get size() { prune(); return owed.size; },
  };
}
