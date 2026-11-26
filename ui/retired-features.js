// One-time removal of what retired features left in this browser's storage.
//
// Simple Mode (the password-locked smaller app, with its "Who will use K?" onboarding step) left
// K iOS in eb2ccac9 (owner, 2026-11-25: "simple mode stays gone") and Desktop with it (audit
// 2026-11-25). Its flag, its salted password record, its wrong-password counters and the
// onboarding's Full/Simple marker are deleted once, so nothing of it stays behind and a browser
// that had it on simply gets the full app. This file is the only place the old key names live.

/** Set once the cleanup has run, so later launches skip it. */
export const RETIRED_FEATURES_DONE_KEY = "kachat-retired-features-cleaned-v1";

/** Every localStorage key Simple Mode ever wrote (all global, none per account). */
export const RETIRED_SIMPLE_MODE_KEYS = Object.freeze([
  "kachat-child-mode-enabled-v1", // the on/off flag
  "kachat-child-mode-record-v1", // { salt, hash, iterations } of its password
  "kachat-simple-mode-failed-attempts", // wrong answers in a row
  "kachat-simple-mode-locked-until", // when the wrong-answer lockout ends
  "kachat-user-type-choice-v1", // the onboarding's Full/Simple answer ("pending" / "chosen")
]);

/** The Show .kachat Endings switch's key (global). */
export const RETIRED_KACHAT_ENDINGS_KEY = "kachat-show-name-endings-v1";

/** Deletes the retired keys once per browser. Returns true when it ran this time. Storage that
 *  throws (private windows, blocked site data) leaves it to the next launch. */
export function removeRetiredFeatureData(storage = globalThis.localStorage) {
  if (!storage) return false;
  // Show .kachat Endings left K in 522fd9f4 (owner, 2026-11-26): names are always bare. Removed on
  // every launch, not behind the done mark, which browsers that ran the Simple Mode cleanup have.
  try { storage.removeItem(RETIRED_KACHAT_ENDINGS_KEY); } catch { /* blocked storage */ }
  try {
    if (storage.getItem(RETIRED_FEATURES_DONE_KEY) === "1") return false;
    for (const key of RETIRED_SIMPLE_MODE_KEYS) storage.removeItem(key);
    storage.setItem(RETIRED_FEATURES_DONE_KEY, "1");
    return true;
  } catch {
    return false;
  }
}
