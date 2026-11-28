// Following and Feed/Popular each keep their own posts (K 01f71184 stashedFeeds, switchFeedSource;
// smoothness audit 2026-11-27 P1). Feed and Popular share the global feed; Following has its own.
// Switching used to throw the loaded feed away and load page one again, showing the old posts under
// the new filter meanwhile. Now the source left is set aside as it was - its posts, its paging, its
// new-posts pill and where it was scrolled - and comes back that way. Back within 5 minutes only the
// newer posts are asked for, as coming back to the tab does. Pure: node tests import it.

/** The source on screen, set aside. The pager is copied with nothing in flight: a page still out
 *  for it is dropped as stale (the feed generation moves on), and its run would otherwise reset the
 *  copy's `loading` while the restored source pages again. */
export function stashFeedSource({ posts, pager, pendingNewPosts, pendingNewPostsHaveGap, loadedAt, scrollTop }) {
  const kept = pager ? { ...pager, seen: new Set(pager.seen || []), loading: false, firstPageGeneration: null } : null;
  return {
    posts: Array.isArray(posts) ? posts : [],
    pager: kept,
    pendingNewPosts: Array.isArray(pendingNewPosts) ? pendingNewPosts : [],
    pendingNewPostsHaveGap: Boolean(pendingNewPostsHaveGap),
    loadedAt: Number(loadedAt) || 0,
    scrollTop: Math.max(0, Number(scrollTop) || 0),
  };
}

/** Whether what came back is fresh enough to keep (K FeedLoadGates.isFresh): it has posts, a pager
 *  to page on with, and page one landed within `staleAfterMs`. Otherwise page one loads again. */
export function restoredFeedIsFresh(saved, now, staleAfterMs) {
  if (!saved || !saved.posts?.length || !saved.pager || !saved.loadedAt) return false;
  return now - saved.loadedAt < staleAfterMs;
}
