// KaPost rules that follow X (K 961fc05a, owner 2026-11-25: "match X"): what a thread is, the order
// replies are shown in, the focused post's time, "Replying to", and when the notifications poll.
// Pure: no DOM, no CSS, so node tests import it (tools/test-kapost-conversations.mjs).

function sameAddress(a, b) {
  return Boolean(a) && String(a).toLowerCase() === String(b || "").toLowerCase();
}

/**
 * The next link of a poster's own thread among one post's replies (K loadSelfThreadChain): the
 * poster's earliest reply, and nothing else. A thread is the poster's own posts, each under their
 * previous one, as on X: someone else's reply is a comment, never part of the thread, even when
 * it's the only reply. Following any lone reply made a post with one comment from someone else
 * show "View thread" and put that comment in the Thread section.
 */
export function nextSelfThreadSegment(replies, posterAddress) {
  let best = null;
  for (const reply of replies || []) {
    if (!reply?.remoteId || !sameAddress(reply.posterAddress, posterAddress)) continue;
    if (!best || (Number(reply.timestamp) || 0) < (Number(best.timestamp) || 0)) best = reply;
  }
  return best;
}

/** Whether a reply page shows the poster answering their own post: the probe's question. */
export function pageHasPosterReply(replies, posterAddress) {
  return (replies || []).some((reply) => sameAddress(reply?.posterAddress, posterAddress));
}

/**
 * Replies in X's order (K commentsExcludingThread): the poster's own first, then yours, then people
 * you follow, then everyone else; within each the most liked first, then the oldest.
 * `isFollowing(address)` answers for the reader.
 */
export function rankReplies(replies, { posterAddress = "", me = "", isFollowing = () => false } = {}) {
  const tier = (reply) => {
    if (sameAddress(reply.posterAddress, posterAddress)) return 0;
    if (me && sameAddress(reply.posterAddress, me)) return 1;
    if (isFollowing(reply.posterAddress)) return 2;
    return 3;
  };
  return (replies || [])
    .map((reply, index) => ({ reply, index, tier: tier(reply) }))
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      const likes = (Number(b.reply.likes) || 0) - (Number(a.reply.likes) || 0);
      if (likes) return likes;
      const age = (Number(a.reply.timestamp) || 0) - (Number(b.reply.timestamp) || 0);
      return age || a.index - b.index;
    })
    .map((entry) => entry.reply);
}

/** A reply's key in the remembered order: its txid, or its local id before it has one. */
export function replyOrderKey(reply) {
  return String(reply?.remoteId || reply?.id || "");
}

/**
 * Each open post's reply order, kept while it's open (K CommentOrderMemo, audit 2026-11-25 L4).
 * Ranked once, when the replies first show: re-sorting on every render moved rows under the reader
 * each time a page or a like landed. Rows already shown keep their place; replies that arrive later
 * (the next page) are ranked among themselves and go below, except your own fresh reply (not sent
 * yet, or within ten minutes), which goes up after the poster's and yours, as X shows it.
 */
export function createReplyOrderMemo() {
  const orders = new Map();
  return {
    forget(postId) { orders.delete(postId); },
    clear() { orders.clear(); },
    /** Closed posts rank afresh next time, with the likes as they are then. */
    retain(openIds) { for (const id of [...orders.keys()]) if (!openIds.has(id)) orders.delete(id); },
    ordered(replies, postId, { posterAddress = "", me = "", isFollowing = () => false, now = Date.now() } = {}) {
      const list = replies || [];
      const byKey = new Map();
      for (const reply of list) {
        const key = replyOrderKey(reply);
        if (key && !byKey.has(key)) byKey.set(key, reply);
      }
      const previous = orders.get(postId) || [];
      let shown = previous.map((key) => byKey.get(key)).filter(Boolean);
      const known = new Set(previous);
      const seenNew = new Set();
      const arrived = list.filter((reply) => {
        const key = replyOrderKey(reply);
        if (!key || known.has(key) || seenNew.has(key)) return false;
        seenNew.add(key);
        return true;
      });
      if (!arrived.length && shown.length === previous.length) return shown;
      const ranked = rankReplies(arrived, { posterAddress, me, isFollowing });
      if (!previous.length) {
        shown = ranked;
      } else {
        const isMine = (reply) => Boolean(me) && sameAddress(reply.posterAddress, me);
        const goesUp = (reply) => isMine(reply) && (!reply.remoteId || now - (Number(reply.timestamp) || 0) < 600_000);
        const isTopTier = (reply) => sameAddress(reply.posterAddress, posterAddress) || isMine(reply);
        const up = ranked.filter(goesUp);
        // after the replies already shown at the top (the poster's own and yours)
        let insertAt = shown.findIndex((reply) => !isTopTier(reply));
        if (insertAt < 0) insertAt = shown.length;
        shown.splice(insertAt, 0, ...up);
        shown.push(...ranked.filter((reply) => !goesUp(reply)));
      }
      orders.set(postId, shown.map(replyOrderKey));
      return shown;
    },
  };
}

/** X's time on the post you opened: "12:00 PM · Nov 25, 2026", in the reader's locale
 *  (K KaPostCellView.focusedTimestamp: short time, medium date). */
export function focusedTimestamp(timestampMs, locale = undefined) {
  const date = new Date(Number(timestampMs) || Date.now());
  const time = date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const day = date.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });
  return `${time} · ${day}`;
}

/**
 * Who a reply answers, for "Replying to <name>" on a reply shown outside its conversation (a
 * profile's Replies, Bookmarks; K replyingToLabel): the parent's author when it's known (this
 * session's reply carries it, or the parent is loaded), else the first signed mention other than
 * the poster, which K writes as the parent's author. Null for a post, or when nothing names one.
 * `addressFromPubkey` maps a signed key to its address; `findParentAuthor(parentId)` looks the
 * parent up among loaded posts.
 */
export function replyingToAddress(post, { addressFromPubkey = () => null, findParentAuthor = () => null } = {}) {
  if (!post?.parentRemoteId) return null;
  if (post.parentPosterPubkey) {
    const address = addressFromPubkey(post.parentPosterPubkey);
    if (address) return address;
  }
  const author = findParentAuthor(post.parentRemoteId);
  if (author) return author;
  for (const pubkey of post.mentionedPubkeys || []) {
    const address = addressFromPubkey(pubkey);
    if (address && !sameAddress(address, post.posterAddress)) return address;
  }
  return null;
}

/** How often KaPost's notifications poll without push (Desktop's usual poll), and with push
 *  registered, when the push is the notice and the poll only a safety net (K 961fc05a). */
export const KAPOSTS_NOTIF_POLL_MS = 90_000;
export const KAPOSTS_NOTIF_PUSH_SAFETY_NET_MS = 5 * 60_000;
/** A poll that ran this recently answers a push or the bell showing (K pollSoon's 15 s). */
export const KAPOSTS_NOTIF_SOON_GAP_MS = 15_000;

/** Whether the timer's tick polls now (K KaPostsNotificationService.start): with push registered
 *  only every 5 minutes, else at the usual interval. Asked each tick, so registering or losing push
 *  takes effect at once. */
export function kaPostsNotifPollDue({ now, lastPollAt = 0, pushRegistered = false }) {
  const interval = pushRegistered ? KAPOSTS_NOTIF_PUSH_SAFETY_NET_MS : KAPOSTS_NOTIF_POLL_MS;
  return !lastPollAt || now - lastPollAt >= interval - 5_000;
}

/** Whether a push, the app coming back or the bell showing polls now (K pollSoon): unless one ran
 *  in the last 15 s. */
export function kaPostsNotifPollSoonDue({ now, lastPollAt = 0 }) {
  return !lastPollAt || now - lastPollAt >= KAPOSTS_NOTIF_SOON_GAP_MS;
}
