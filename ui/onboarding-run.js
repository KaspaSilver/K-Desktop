// The onboarding-run marker and the password eye toggle.
//
// Onboarding-run pending marker: EVERY account-onboarding run — create or
// import — is fully unskippable end to end, and an interrupted run
// (reload/kill mid-guide) re-presents on the next launch. The marker stores
// the run kind ("create" | "import") so the re-presented guide keeps its
// import-only affordances (the funding step's "Change Chatting Address"
// picker). Cleared only by Finish on the last step. Help replays never set
// this and stay skippable.

const ONBOARDING_RUN_KEY = "kachat-onboarding-run-pending-v1";

export function pendingOnboardingRunKind() {
  const value = localStorage.getItem(ONBOARDING_RUN_KEY);
  return value === "create" || value === "import" ? value : null;
}

export function isOnboardingRunPending() {
  return pendingOnboardingRunKind() !== null;
}

export function markOnboardingRunPending(kind) {
  localStorage.setItem(ONBOARDING_RUN_KEY, kind === "import" ? "import" : "create");
}

export function clearOnboardingRunPending() {
  localStorage.removeItem(ONBOARDING_RUN_KEY);
}

// ---------------------------------------------------------------------------
// Eye toggle (password reveal) — reusable via markup convention:
// <span class="password-field-wrap"><input type="password" …>
//   <button data-eye-toggle>…</button></span>
// A single document-level delegated handler (installed once from app.js)
// serves every such field, including Nextcloud's app-password input.
// ---------------------------------------------------------------------------

export const EYE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.3 12.3C4.4 7.7 8 5.2 12 5.2s7.6 2.5 9.7 7.1a.9.9 0 0 1 0 .8c-2.1 4.6-5.7 7.1-9.7 7.1s-7.6-2.5-9.7-7.1a.9.9 0 0 1 0-.8Z"/><circle cx="12" cy="12.7" r="3.1"/></svg>';
export const EYE_SLASH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 4 20.5 21"/><path d="M9.9 5.7A9.7 9.7 0 0 1 12 5.5c4 0 7.6 2.5 9.7 7.1a.9.9 0 0 1 0 .8 15.6 15.6 0 0 1-2.8 4M6.2 7.2a15.1 15.1 0 0 0-3.9 5.4.9.9 0 0 0 0 .8c2.1 4.6 5.7 7.1 9.7 7.1 1.5 0 3-.4 4.3-1.1"/><path d="M9.9 10.8a3.1 3.1 0 0 0 4.3 4.3"/></svg>';

let eyeToggleInstalled = false;

export function installEyeToggleDelegation() {
  if (eyeToggleInstalled) return;
  eyeToggleInstalled = true;
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-eye-toggle]");
    if (!button) return;
    const input = button.closest(".password-field-wrap")?.querySelector("input");
    if (!input) return;
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    button.innerHTML = reveal ? EYE_SLASH_SVG : EYE_SVG;
    button.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
  });
}
