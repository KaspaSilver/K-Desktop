// Creating a group and adding members, as half sheets (K bdf29425, GroupActionSheets.swift): a
// confirmation sheet in place of the old alert, then a progress sheet that shows every transaction
// as it goes out (setting up, inviting each person, the recovery copy, the photo), so a slow
// network reads as "working", not "broken". The steps are fed by the group engine's `report(key,
// phase)` hook (engine/group-store.js createGroup / addMember).
//
// `GroupActionProgress` and the step builders are pure (tools/test-k-mentions.mjs); the two sheet
// functions build their DOM only when called. Each sheet is a `.modal-backdrop` that is not an
// alert, so ui/sheets.js raises it from the bottom on a phone; on a desktop it is the usual card.

/** Step keys the engine reports besides members' addresses (K GroupActionStep). */
export const GROUP_STEP = Object.freeze({ setUp: "#setup", recoveryCopy: "#recovery", photo: "#photo" });

export class GroupActionProgress {
  /** `steps`: [{ id, title, detail? }], each starting as "waiting". */
  constructor(headline, steps) {
    this.headline = String(headline || "");
    this.steps = (steps || []).map((s) => ({ id: String(s.id), title: String(s.title || ""), detail: s.detail ?? null, state: "waiting", error: null }));
    this.isFinished = false;
    this.listeners = new Set();
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed() { for (const fn of this.listeners) { try { fn(this); } catch { /* a listener's own problem */ } } }
  find(id) { const key = String(id || "").toLowerCase(); return this.steps.find((s) => s.id.toLowerCase() === key) || null; }
  get doneCount() { return this.steps.filter((s) => s.state === "done").length; }
  get failedCount() { return this.steps.filter((s) => s.state === "failed").length; }
  /** Done or failed: what the bar and "k of n" count. */
  get settledCount() { return this.steps.filter((s) => s.state === "done" || s.state === "failed").length; }
  /** `state`: "waiting" | "working" | "done" | "failed" (`error`: what went wrong). */
  set(id, state, { detail, error } = {}) {
    const step = this.find(id);
    if (!step) return;
    step.state = state;
    step.error = state === "failed" ? String(error || "Not sent") : null;
    if (detail !== undefined) step.detail = detail;
    this.changed();
  }
  setDetail(id, detail) {
    const step = this.find(id);
    if (!step) return;
    step.detail = detail;
    this.changed();
  }
  /** A step's news from the group engine (its key is the step's id). */
  apply(key, phase, error = null) {
    if (phase === "started") this.set(key, "working");
    else if (phase === "finished") this.set(key, "done");
    else if (phase === "failed") this.set(key, "failed", { error: error?.message || error || "Not sent" });
  }
  /** Anything still waiting or working when the action ends failed with it. */
  finish(message = null) {
    for (const step of this.steps) {
      if (step.state === "waiting" || step.state === "working") { step.state = "failed"; step.error = String(message || "Not sent"); }
    }
    this.isFinished = true;
    this.changed();
  }
}

/** Creating a group's steps (K AddContactView.createGroupChat): setting up, each invite, the
 *  recovery copy, and the photo when there is one. `nameOf(address)` names a member. */
export function groupCreateProgress({ name, members, nameOf, withPhoto = false }) {
  const steps = [{ id: GROUP_STEP.setUp, title: "Setting up the group" }];
  for (const address of members || []) steps.push({ id: address, title: `Inviting ${nameOf(address)}` });
  steps.push({ id: GROUP_STEP.recoveryCopy, title: "Saving a recovery copy" });
  if (withPhoto) steps.push({ id: GROUP_STEP.photo, title: "Adding the group photo" });
  return new GroupActionProgress(`Creating "${String(name || "").trim()}"`, steps);
}

/** Adding members' steps (K AddGroupMembersView.addSelected): one per person added; each add
 *  rotates the group key and sends it to every member, counted in the step's detail. */
export function groupAddProgress({ members, nameOf }) {
  const list = members || [];
  return new GroupActionProgress(
    list.length === 1 ? "Adding 1 member" : `Adding ${list.length} members`,
    list.map((address) => ({ id: address, title: `Adding ${nameOf(address)}` })),
  );
}

/** The detail an add shows while its key goes out: "Sending the new group key: 3 of 10". */
export function groupKeyDetail(sent, total) {
  const t = Math.max(1, Number(total) || 1);
  return `Sending the new group key: ${Math.min(Math.max(0, Number(sent) || 0), t)} of ${t}`;
}

// ---- The sheets (DOM) ---------------------------------------------------------------------------

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * "Create group" / "Add members": what will happen and what it costs, with the button that does it
 * and Cancel (K GroupActionConfirmSheet). Resolves true when confirmed.
 */
export function groupActionConfirmSheet({ title, message, feeLine = "", confirmLabel }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop group-action-backdrop";
    backdrop.innerHTML = `
      <section class="contact-modal group-action-sheet group-action-confirm" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <h2>${esc(title)}</h2>
        <p class="group-action-message">${esc(message)}</p>
        ${feeLine ? `<p class="group-action-fee">${esc(feeLine)}</p>` : ""}
        <button type="button" class="group-action-primary" data-group-action-ok>${esc(confirmLabel)}</button>
        <button type="button" class="group-action-cancel" data-close data-group-action-cancel>Cancel</button>
      </section>`;
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); done(false); }
    };
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop || event.target.closest("[data-group-action-cancel]")) { done(false); return; }
      if (event.target.closest("[data-group-action-ok]")) done(true);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(backdrop);
    backdrop.querySelector("[data-group-action-ok]")?.focus({ preventScroll: true });
  });
}

const STEP_ICON = {
  waiting: '<span class="group-step-icon waiting" aria-hidden="true"></span>',
  working: '<span class="group-step-icon working" aria-hidden="true"></span>',
  done: '<span class="group-step-icon done" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m7 12.5 3.2 3.2L17 9"/></svg></span>',
  failed: '<span class="group-step-icon failed" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m8.5 8.5 7 7m0-7-7 7"/></svg></span>',
};

/**
 * The steps of a group action as they happen, with Done once it's over (K GroupActionProgressSheet).
 * It can't be closed while it works: no close control until Done shows. `onDone` runs when Done is
 * clicked; the returned promise resolves then too.
 */
export function groupActionProgressSheet(progress, { onDone = null, failureHint = "Some steps didn't go through. You can send them again from Group Info > Resend invites to all." } = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop group-action-backdrop";
    const card = document.createElement("section");
    card.className = "contact-modal group-action-sheet group-action-progress";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", progress.headline);
    backdrop.append(card);
    const render = () => {
      const total = Math.max(progress.steps.length, 1);
      const settled = progress.settledCount;
      const rows = progress.steps.map((step) => {
        const sub = step.state === "failed" ? `<small class="group-step-error">${esc(step.error)}</small>`
          : step.state === "working" && step.detail ? `<small>${esc(step.detail)}</small>` : "";
        return `<li class="group-step ${step.state}">${STEP_ICON[step.state] || STEP_ICON.waiting}<span class="group-step-text"><span class="group-step-title">${esc(step.title)}</span>${sub}</span></li>`;
      }).join("");
      const footer = progress.isFinished
        ? `${progress.failedCount ? `<p class="group-action-note">${esc(failureHint)}</p>` : ""}<button type="button" class="group-action-primary" data-close data-group-action-done>Done</button>`
        : `<p class="group-action-note">Each step is a transaction on Kaspa and can take a few seconds. Keep K open until it's done.</p>`;
      card.innerHTML = `
        <h2>${esc(progress.headline)}</h2>
        <div class="group-action-bar${progress.failedCount ? " has-failed" : ""}" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${settled}"><span style="width:${Math.round((settled / total) * 100)}%"></span></div>
        <p class="group-action-count">${settled} of ${progress.steps.length}</p>
        <ul class="group-step-list">${rows}</ul>
        ${footer}`;
      if (progress.isFinished) card.querySelector("[data-group-action-done]")?.focus({ preventScroll: true });
    };
    const stop = progress.onChange(render);
    backdrop.addEventListener("click", (event) => {
      if (!event.target.closest("[data-group-action-done]")) return;
      stop();
      backdrop.remove();
      try { onDone?.(); } finally { resolve(); }
    });
    // Escape doesn't close it while it works: the steps are still going out.
    backdrop.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); } });
    render();
    document.body.appendChild(backdrop);
  });
}
