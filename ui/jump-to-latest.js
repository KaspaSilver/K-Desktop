// Jump to the newest message without gliding across the whole history (K 01f71184, smoothness
// audit 2026-11-27 C6, `landNearBottomIfFar`).
//
// After "jump to start" (which draws a chat's whole history) or a long scroll up, the scroll-to-
// latest button's smooth scroll ran through every row in between. Far from the bottom (more than
// three screens), the list now lands one screen short of the newest at once, and only that last
// screen is animated. Shared by the 1:1 thread, the group thread and public rooms.
//
// No DOM at import: tools/test-ios-01f71184-chats.mjs runs it in node.

export const FAR_FROM_BOTTOM_SCREENS = 3;

/** Where an unanimated landing should put scrollTop before the glide, or null when the newest
 *  message is close enough to glide all the way. */
export function nearBottomStart({ scrollTop, scrollHeight, clientHeight }, screens = FAR_FROM_BOTTOM_SCREENS) {
  const view = Number(clientHeight) || 0;
  if (view <= 0) return null;
  const bottom = Math.max(0, (Number(scrollHeight) || 0) - view);
  if (bottom - (Number(scrollTop) || 0) <= view * screens) return null;
  return Math.max(0, bottom - view);
}

/** The scroll-to-latest button's action. */
export function jumpToLatest(el) {
  if (!el) return;
  const start = nearBottomStart(el);
  if (start != null) el.scrollTop = start;
  el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
}
