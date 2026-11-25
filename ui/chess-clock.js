// The 1:1 chess clock's timing (K 961fc05a ChessGameView / ChessClockChip, audit 2026-11-25 B14),
// without a DOM, for tools/test-k-961-chat.mjs.
//
// My clock runs only while it's my turn in a timed game in progress, the board is open AND the page
// is showing: time with the board closed or the tab hidden isn't thinking time. The elapsed time
// is worked out from when the running stretch began, so nothing ticks to keep it. It used to be a
// 5x-a-second timer writing localStorage on every tick, in untimed games too. Now the chip is
// redrawn just after the shown second changes (every tenth under 10 s, where it shows tenths), the
// thinking time is saved every 5 s while it runs and when it stops, and an untimed game has no
// timer at all.

/** How often a running clock's thinking time is saved, so a reload hands back at most this. */
export const CHESS_CLOCK_SAVE_MS = 5_000;

/** Whether my clock should be running now. */
export function chessClockShouldRun({ timed, over, myTurn, timeoutSent, boardShown, pageVisible }) {
  return Boolean(timed && !over && myTurn && !timeoutSent && boardShown && pageVisible);
}

/** The wait before the chip next needs drawing: until the shown second changes, or the shown
 *  tenth under 10 s (formatChessClock rounds down, so "0:12" shows until 11.999 s are left).
 *  0 once the clock has run out. */
export function chessClockNextTickMs(remainingMs) {
  const ms = Math.max(0, Math.floor(Number(remainingMs) || 0));
  if (ms <= 0) return 0;
  const step = ms < 10_000 ? 100 : 1_000;
  return (ms % step) + 1;
}
