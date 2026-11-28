// What a plain repost reposted (K 01f71184 KaPostRepostOrigins, owner 2026-11-27). A repost goes on
// chain as a quote with no words, and the indexer's quote reference carries only the quoted post's
// own words, so a repost OF a repost named the middle reposter over an empty card. The quote card
// (ui/kaposts.js quoteEmbedHtml) and the quote composer show the post that one reposted instead, as
// X does: followed up to 5 reposts deep to the first post with words, by the indexer's get-post,
// else the chain. Answers are kept for the run; a failed lookup is tried again after 2 minutes.
// Pure: no DOM, so node tests import it (tools/test-ios-01f71184-posts.mjs).

export const REPOST_ORIGIN_MAX_HOPS = 5;
export const REPOST_ORIGIN_RETRY_MS = 120_000;

/** A quote card for a repost with no words of its own (one with an id to follow). */
export function isPlainRepost(quoted) {
  const id = quoted?.remoteId;
  if (!id || !String(id)) return false;
  return String(quoted.text ?? "").trim() === "";
}

/**
 * `quoteOf(id)` answers the post `id` quotes as a quote ref ({ remoteId, text, posterAddress,
 * timestamp, posterPubkey }), or null when it quotes nothing or can't be read.
 */
export function createRepostOrigins({ quoteOf, now = () => Date.now() } = {}) {
  const found = new Map();
  const failedAt = new Map();
  const running = new Map();

  async function follow(id) {
    let current = id;
    const seen = new Set([id]);
    for (let hop = 0; hop < REPOST_ORIGIN_MAX_HOPS; hop += 1) {
      let next = null;
      try { next = await quoteOf(current); } catch { next = null; }
      if (!next) return null;
      if (!isPlainRepost(next)) return next;
      const nextId = String(next.remoteId);
      if (seen.has(nextId)) return null; // a loop, or the same post again
      seen.add(nextId);
      current = nextId;
    }
    return null;
  }

  return {
    /** The original already found for this card, or null. */
    cached(quoted) {
      const id = quoted?.remoteId;
      return id ? found.get(String(id)) || null : null;
    },
    /** Whether a lookup for this card is out now (the card shows a spinner in place of no words). */
    looking(quoted) {
      const id = quoted?.remoteId;
      return Boolean(id && running.has(String(id)));
    },
    /** Whether a lookup should be started for this card: a plain repost, not found, not running and
     *  not failed in the last 2 minutes. */
    wants(quoted) {
      if (!isPlainRepost(quoted)) return false;
      const id = String(quoted.remoteId);
      if (found.has(id) || running.has(id)) return false;
      const failed = failedAt.get(id);
      return !(failed != null && now() - failed < REPOST_ORIGIN_RETRY_MS);
    },
    /** The first post with words behind this plain repost, or null. One lookup per id at a time. */
    async original(quoted) {
      if (!isPlainRepost(quoted)) return null;
      const id = String(quoted.remoteId);
      if (found.has(id)) return found.get(id);
      const failed = failedAt.get(id);
      if (failed != null && now() - failed < REPOST_ORIGIN_RETRY_MS) return null;
      if (running.has(id)) return running.get(id);
      const task = follow(id).then((result) => {
        running.delete(id);
        if (result) { found.set(id, result); failedAt.delete(id); }
        else failedAt.set(id, now());
        return result;
      });
      running.set(id, task);
      return task;
    },
    /** Account switch: nothing is kept (a repost's original is public, but lookups follow the run). */
    clear() { found.clear(); failedAt.clear(); },
  };
}

/** What a quote card shows for `quoted`: the original behind a plain repost once found, else the
 *  card's own post. `sameAuthor` says whether it's still the quoted post's author. */
export function quoteCardShown(quoted, cachedOriginal) {
  const shown = cachedOriginal || quoted;
  return { shown, sameAuthor: Boolean(shown && quoted && shown.posterAddress === quoted.posterAddress) };
}

/** The quote composer's card (K quotedPostCard): quoting a plain repost (no words of its own) shows
 *  the post it reposted, with that post's time, as the feed's quote card does. `cachedOriginal` is
 *  what the lookup found behind the repost's own quote, when that is a plain repost too. */
export function composerQuoteShown(target, cachedOriginal = null) {
  if (!target) return null;
  const ownWords = String(target.text ?? "").trim() !== "";
  if (ownWords || !target.quoted) return target;
  const reposted = isPlainRepost(target.quoted) && cachedOriginal ? cachedOriginal : target.quoted;
  return { ...reposted, timestamp: reposted.timestamp ?? null };
}
