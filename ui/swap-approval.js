// The approval for a kUSDT swap (K iOS Views/Tokens/TrestlyApprovalSheet.swift, `native`, K
// 518fdc8c): what goes in and comes out, as Trestly's own code prepared it, the minimum (1% under
// the quote), the network fee, Trestly's warnings. Nothing is signed until Approve
// (engine/kusdt-trade.js); closing declines. Approve wakes a moment after the sheet appears, so a
// click meant for the screen behind can't land on it, and stays off while the pool's answer says
// the trade would be refused (`blocked`).
//
// HTML only (ui/swaps.js mounts it); amounts are exact (BigInt base units).

import { tradeUnits, kasAmountLabel } from "../engine/kusdt-trade.js";
import { formatKusdt } from "../engine/kusdt.js";

/** Approve stays off this long after the sheet appears (iOS 0.8 s). */
export const APPROVE_ARM_MS = 800;

const kas = (v) => { const n = tradeUnits(v); return n == null ? "--" : kasAmountLabel(n); };
const kusdt = (v) => { const n = tradeUnits(v); return n == null ? "--" : formatKusdt(n); };

export const APPROVAL_TEXT = Object.freeze({
  requote: "The pool moved, and it now gives less than you approved. Nothing was sent. Check the new numbers.",
  paused: "The pool is paused: swaps and new liquidity are stopped for now. Removing liquidity stays open.",
  belowMinimum: "The pool pays less than your minimum right now, so this would be refused. Go back and get a new quote.",
  feeShare: "The network fee is more than a tenth of what this moves.",
  noSellFits: "No sell fits until the limit refills.",
  note: "Built and checked by Trestly's own code inside K. If the pool moves first, it quotes again: it goes ahead only at this quote or better, asks you again for less, and never goes below your minimum, 1% under the quote.",
  nodes: "Trestly's code reads this address's coins and sends the trade through public Kaspa nodes (kaspa.stream and its mirrors), not the node chosen in Settings. Those nodes see this address and your IP address.",
});

/** Trestly's warnings for this answer (iOS `warnings`). */
export function approvalWarnings(prepared) {
  const list = [];
  if (prepared?.paused === true) list.push(APPROVAL_TEXT.paused);
  if (typeof prepared?.breaker === "string") {
    let b = null;
    try { b = JSON.parse(prepared.breaker); } catch { b = null; }
    if (b && typeof b === "object") {
      const fit = tradeUnits(b.fit) ?? 0n;
      list.push(`The pool's circuit breaker lets sells take out at most ${kas(b.maxKasOut)} more right now, so this sell would be refused.`);
      list.push(fit > 0n ? `The most that fits now is ${formatKusdt(fit)}.` : APPROVAL_TEXT.noSellFits);
    }
  }
  if (prepared?.belowMinimum === true) list.push(APPROVAL_TEXT.belowMinimum);
  if (prepared?.feeShare === true) list.push(APPROVAL_TEXT.feeShare);
  return list;
}

/** Whether Approve may be pressed at all (their `blocked`: paused, breaker or under the minimum). */
export function approvalBlocked(prepared) {
  return prepared?.blocked === true;
}

/** The rows: You Pay, You Receive, You Saw (after a requote), Minimum You Get, Kept in Your Token. */
export function approvalRows(request) {
  const p = request?.prepared || {};
  const buy = p.side === "buy";
  const paid = (v) => (buy ? kas(v) : kusdt(v));
  const received = (v) => (buy ? kusdt(v) : kas(v));
  const rows = [
    { label: "You Pay", value: paid(p.amountIn) },
    { label: "You Receive", value: received(p.quote), bold: true },
  ];
  if (request?.seen && tradeUnits(request.seen.quote) != null) rows.push({ label: "You Saw", value: received(request.seen.quote) });
  rows.push({ label: "Minimum You Get", value: received(p.minOut) });
  if (buy) rows.push({ label: "Kept in Your Token", value: kas(p.tokenValue) });
  return rows;
}

/** The sheet's inside. `esc` escapes text; `iconHtml` is the kUSDT coin. */
export function approvalSheetHtml(request, { esc, iconHtml = "" }) {
  const p = request?.prepared || {};
  const title = p.side === "buy" ? "Buy kUSDT" : "Sell kUSDT";
  const line = ({ label, value, bold }) => `<div class="swap-approval-line"><span>${esc(label)}</span><strong class="${bold ? "bold" : ""}">${esc(value)}</strong></div>`;
  const warnings = approvalWarnings(p);
  return `<div class="swap-sheet-header">
      <button type="button" class="swap-link" data-swap-approval-decline data-close>Decline</button>
      <h2>Approve</h2>
      <span class="swap-sheet-spacer" aria-hidden="true"></span>
    </div>
    <div class="swap-approval">
      <div class="swap-approval-head">${iconHtml}<span><small>Through Trestly's pool</small><strong>${esc(title)}</strong></span></div>
      ${request?.seen ? `<p class="swap-approval-warning">${esc(APPROVAL_TEXT.requote)}</p>` : ""}
      <div class="profile-card swap-approval-card">
        ${approvalRows(request).map(line).join("")}
        <hr />
        ${line({ label: "From", value: request?.from || "" })}
        ${line({ label: "Network Fee", value: `about ${kas(p.feeAbout)}` })}
      </div>
      ${warnings.map((w) => `<p class="swap-approval-warning">${esc(w)}</p>`).join("")}
      <p class="swap-approval-note">${esc(APPROVAL_TEXT.note)}</p>
      <p class="swap-approval-note">${esc(APPROVAL_TEXT.nodes)}</p>
      <button type="button" class="primary-button swap-approval-approve" data-swap-approval-approve disabled>Approve</button>
    </div>`;
}
