// The Chats dock tab's unread count (KaChat-iPhone 64d63846 AppTabBadge, KaPosts-iPhone eec2e30
// PublicChatUnreadBadge). The dock's KaChat badge carries chats and groups only since K 961fc05a
// (owner, 2026-11-25): the bell-on rooms count on the Chats / Public Chats button beside the title
// and on the app icon, so ui/app.js passes no `rooms` here any more. No DOM in here, so
// tools/test-chat-unread.mjs runs it under node.

/** Unread messages across the chats the Chats list shows (iOS ChatService.chatListUnreadCount).
 *  `isListed(conversation)` is iOS's isConversationVisibleInChatList: Message Requests, blocked and
 *  declined chats don't count, so an unaccepted sender can't keep ringing the badge. */
export function chatListUnreadCount(conversations, isListed) {
  let total = 0;
  for (const conversation of Array.isArray(conversations) ? conversations : []) {
    if (!isListed(conversation)) continue;
    total += Math.max(0, Number(conversation?.unreadCount) || 0);
  }
  return total;
}

/** The Chats tab's count: the 1:1 chats (iOS 64d63846's Chats), the group chats (its Groups tab,
 *  which Desktop doesn't have) and the public rooms (KaPost's Public Chats tab, eec2e30), each
 *  never below zero. */
export function chatsTabUnreadCount({ chats = 0, groups = 0, rooms = 0 } = {}) {
  const part = (n) => Math.max(0, Math.floor(Number(n) || 0));
  return part(chats) + part(groups) + part(rooms);
}

/**
 * Recounts `delayMs` after the last call and publishes only when the number changed (iOS
 * PublicChatUnreadBadge: a 300 ms debounce on the rooms' changes, `if total != count`), so a burst
 * of messages redraws the dock once. Returns the function to call whenever something that moves the
 * count changed. A `publish` that throws (the page not ready yet) leaves the number unrecorded, so
 * the next recount tries again. Timers are injectable for the test.
 */
export function debouncedCountPublisher({ read, publish, delayMs = 300, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let published = null;
  return function schedule() {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      let count = 0;
      try { count = read(); } catch { return; }
      if (count === published) return;
      try { publish(count); published = count; } catch { /* the next change tries again */ }
    }, delayMs);
  };
}

/**
 * The Chats list's rebuild (K 518fdc8c ChatListView.scheduleFilteredConversationsRefresh): coalesced
 * to one run `delayMs` after the last call, but never held more than `maxWaitMs` since the list was
 * last rebuilt. A pure debounce let a long burst (typing on, or a sync's changes) keep the list and
 * its search stale until it paused (audit 2026-11-24 #27). Returns `schedule()`; `schedule.cancel()`
 * drops a pending run. Timers and the clock are injectable for the test.
 */
export function coalescedRunner({ run, delayMs = 180, maxWaitMs = 1000, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now() }) {
  let timer = null;
  let lastRunAt = -Infinity;
  const fire = () => {
    timer = null;
    lastRunAt = now();
    run();
  };
  const schedule = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    // Held a second already: rebuild now.
    if (now() - lastRunAt > maxWaitMs) { fire(); return; }
    timer = setTimer(fire, delayMs);
  };
  schedule.cancel = () => { if (timer !== null) clearTimer(timer); timer = null; };
  return schedule;
}
