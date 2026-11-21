// The kUSDT screens (KaPay iOS 3d126db Views/Tokens/*.swift, the Wallet card and Help's guide):
// the Wallet card's kUSDT page and its pills, Swap Stablecoins, Wallet Send's asset chooser, Send
// kUSDT (To / From / How much / Review), Fund This Address, Combine Coins, Manage kUSDT with its row
// menu, kUSDT Actions and Address Visibility, an address's page and history, About kUSDT, Receive
// kUSDT and the kUSDT Guide.
//
// Built from Desktop's own pieces so they look like the rest of the app: the step flow and the
// swipe-up review of Send Kaspa (ui/send-steps.js, ui/send-kaspa-components.js; "Tap to Send" on a
// computer, owner 2026-11-15), Manage Addresses' rows and floating actions button, the receive
// screens' white QR card, the app's dialogs (ui/dialogs.js). The state lives in ui/kusdt-wallet.js;
// app.js hands in what only it knows through `deps` (initKusdtScreens), as ui/kaposts.js does.
//
// Desktop differences (owner 2026-11-20 unless noted): Swap Stablecoins opens Trestly's swap page
// in a new tab (a web page can't hand window.kusdt to Trestly's site), so there's no in-app
// browser, connect or approval sheet, and no Swapped / Bridged rows. Mine while porting: the From
// step is shown (not skipped) when no address holds kUSDT, saying so, and Manage kUSDT shows
// "No kUSDT Yet" under the Chatting Address while nothing holds any.
//
// Nothing here asks for the password: plain sends need none (owner, 2026-11-17). Every build, read
// and send is tied to the account it started on; an answer after a switch is dropped.

import {
  KUSDT_TOKEN, kusdtDeployment, formatKusdt, typedKusdt, kusdtDollars, kusdtUnitsFromText, canHoldKusdt, KUSDT_DECIMALS,
} from "../engine/kusdt.js";
import {
  prepareTransfer, prepareCombine, isReviewStale, staleReviewOutcome, createPrepareGate, KusdtTransferError,
  TRANSFER_MESSAGES, MAX_TOKEN_INPUTS,
} from "../engine/kusdt-transfer.js";
import { KusdtCoreError } from "../engine/kusdt-core.js";
import { KusdtBalanceError } from "../engine/kusdt-balances.js";
import { sendFeeChangedError, SEND_OUTCOME_UNKNOWN } from "../engine/transactions.js";
import { addressNumber } from "../engine/quantum.js";
import {
  escapeSendHtml as esc, recipientCardHtml, createSwipeUpScreen, SWIPE_UP_LABELS, selectablePillHtml, setSelectedPill,
  shortSendAddress, SEND_ICONS,
} from "./send-kaspa-components.js";
import {
  createStepFlow, keypadHtml, wireKeypad, applyKeypadKey, keypadAmountTextHtml, paintKeypadAmount, stepChipHtml,
  reviewRowHtml,
} from "./send-steps.js";
import { chooseDialog, confirmDialog, promptDialog, infoSheet, userFacingError } from "./dialogs.js";
import { scanKaspaAddress } from "./qr-scan.js";
import { kusdtCoinIconHtml, kaspaCoinIconHtml, KUSDT_ICONS, receiveNoteIcon } from "./kusdt-icons.js";
import {
  receiveNotesFor, kasAmountText, kusdtFeeText, isHoldingUsed, shortKusdtAddress, visibilityShortAddress,
  KUSDT_VISIBILITY_PAGE, holdingIdFor, makeHolding,
} from "./kusdt-wallet.js";

let deps = null;
let wallet = null;

const SYMBOL = KUSDT_TOKEN.symbol;
const KAS_PER_COIN = KUSDT_TOKEN.kasPerCoinSompi;
const kas = (sompi) => kasAmountText(sompi, deps?.kasUnit || "KAS");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exact strings (spec §1-§13, iOS 3d126db). */
export const KUSDT_TEXT = Object.freeze({
  scriptRecipient: "kUSDT can only go to a regular Kaspa address, not a quantum-safe or other script address.",
  fromFootnote: "The KAS for the fee comes from the same address, so the send doesn't link it to your other addresses.",
  fromNone: "None of your addresses holds kUSDT yet.",
  fromChecking: "Checking your addresses for kUSDT…",
  overBalance: "More than your kUSDT.",
  feeFromTokenKas: "This address had no KAS, so the network fee came out of the KAS that goes with the kUSDT.",
  waitingForKas: "Waiting for your KAS to arrive…",
  building: "Building the transaction…",
  notLanded: "The KAS you sent hasn't shown up on this address yet. It usually takes a few seconds.",
  coinHoldsKas: "Every kUSDT coin holds 1.5 KAS. It goes to the recipient with the kUSDT, so the KAS isn't lost.",
  fundCaption: "Pick which of your addresses the KAS comes from, tap Send, and you're back here.",
  fundMemo: "KAS for a kUSDT send",
  noKeyHere: "This address's key isn't available on this computer.",
  combineNote: "Every kUSDT coin holds 1.5 KAS. Combining them into one coin gives the extra KAS back to this address as regular KAS, less the network fee. Your kUSDT stays the same.",
  combineMore: `Up to ${MAX_TOKEN_INPUTS} coins combine at a time. Combine again for the rest.`,
  aboutText: "kUSDT is USDT from Ethereum and BNB Chain, held 1:1 in Trestly's vault and issued as a token on Kaspa. It isn't issued by Tether, and only Trestly can turn it back into USDT.",
  risk: "Not independently audited yet. Hold only what you can afford to lose.",
  aboutCoin: "Every kUSDT coin holds 1.5 KAS. It goes along with the kUSDT when you send it.",
  emptyTitle: "No kUSDT Yet",
  emptyText: "Receive it on a fresh address, or buy it with Swap Stablecoins on the Wallet tab.",
  historyEmpty: "No kUSDT activity yet.",
  historyEmptyNote: "Sends, receives and combines on this computer show here from now on.",
  swapRowSubtitle: "On Trestly's site, in a new tab",
  swapFooter: "More stablecoins will show here as K adds them.",
  visibilityEmptyPage: "These addresses couldn't be derived right now. Go back a page or reopen this screen to retry.",
  // §14 Send Dollars (KaChat iOS 5b7c772c) and §15 KaPost's Tip In (KaPost iOS f954738)
  sendDollarsTitle: "Send Dollars",
  sendDollarsQuestion: "Which stablecoin are you sending?",
  // A send from a chat or a tip whose review was open too long (KaChat iOS TokenSendView.send).
  lockedChanged: "This send changed while the screen was open. Nothing was sent: check it again and swipe.",
  tipTitle: "Tip",
  tipQuestion: "What are you tipping in?",
  tipKusdtSubtitle: "Not counted on the post",
  tipFootnote: "Set what Tip sends in Settings > KaPost > Tip In.",
});

/** A "Not confirmed" send from a chat is looked up this often, this many times: if it landed, the
 *  chat still gets its bubble and notice, even once the screen is closed (KaChat iOS 5b7c772c). */
export const LOCKED_SEND_POLL_MS = 10_000;
export const LOCKED_SEND_POLL_TRIES = 18;

// MARK: - Small pieces

function messageFor(error) {
  if (error instanceof KusdtTransferError) return error.code === "noKey" ? KUSDT_TEXT.noKeyHere : error.message;
  if (error instanceof KusdtCoreError || error instanceof KusdtBalanceError) return error.message;
  return userFacingError(error);
}
function spinnerLine(text) {
  return `<p class="kusdt-status muted"><span class="sk-spinner" aria-hidden="true"></span>${esc(text)}</p>`;
}
function iconHtml(name) { return KUSDT_ICONS[name] || ""; }
const holdingLabel = (h) => wallet.labelOf(h);
function dateText(ms) {
  try { return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); } catch { return ""; }
}
function middle(text, keep = 10) {
  const t = String(text || "");
  return t.length > keep * 2 + 1 ? `${t.slice(0, keep)}…${t.slice(-keep)}` : t;
}
function openExternal(url) {
  try { window.open(url, "_blank", "noopener,noreferrer"); } catch { /* blocked: nothing to do */ }
}
function topOverlayOpen() {
  return [...document.querySelectorAll(".modal-backdrop:not([hidden])")].length > 0;
}

/** A receive screen's privacy line and notes (iOS AddressReceiveView): `screen` as
 *  ui/kusdt-wallet.js receiveNotesFor names it. Trusted markup. */
export function receiveNotesHtml(screen) {
  const { privacy, notes } = receiveNotesFor(screen);
  const line = (note) => `<span class="receive-note" data-kind="${esc(note.kind)}"><span class="receive-note-icon">${receiveNoteIcon(note.kind)}</span><span>${esc(note.text)}</span></span>`;
  return {
    privacyHtml: privacy ? line(privacy) : "",
    notesHtml: notes.length ? notes.map(line).join("") : "",
  };
}

// MARK: - Choice sheets (iOS SendStepHeader + rows: Swap Stablecoins, Send's asset chooser)

let sheetHost = null;
let sheetSettle = null;
// kUSDT Actions' Discover progress, repainted while that sheet is up (null otherwise).
let actionsSheetPaint = null;
function ensureSheet() {
  if (sheetHost) return sheetHost;
  sheetHost = document.createElement("div");
  sheetHost.className = "modal-backdrop kusdt-sheet-backdrop";
  sheetHost.hidden = true;
  sheetHost.innerHTML = '<div class="contact-modal app-dialog kusdt-sheet" role="dialog" aria-modal="true" tabindex="-1" style="outline: none" data-kusdt-sheet-body></div>';
  document.body.appendChild(sheetHost);
  sheetHost.addEventListener("mousedown", (event) => { if (event.target === sheetHost) closeSheet(null); });
  sheetHost.addEventListener("click", (event) => {
    if (event.target.closest("[data-kusdt-sheet-cancel]")) { closeSheet(null); return; }
    const row = event.target.closest("[data-kusdt-sheet-pick]");
    if (row && !row.disabled) closeSheet(row.dataset.kusdtSheetPick);
  });
  sheetHost.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSheet(null); }
  });
  return sheetHost;
}
function closeSheet(value) {
  if (sheetHost) sheetHost.hidden = true;
  const settle = sheetSettle;
  sheetSettle = null;
  settle?.(value);
}
/** A sheet of rows: `{ title, question, rows: [{ id, iconHtml, title, subtitle, trailing, disabled }],
 *  footer, extraHtml }`. Resolves the picked row's id, or null. */
function openChoiceSheet({ title, question = "", rows = [], footer = "", extraHtml = "", onMount = null }) {
  const host = ensureSheet();
  actionsSheetPaint = null; // a running Discover paints only the sheet that shows it
  const previous = sheetSettle;
  sheetSettle = null;
  previous?.(null);
  host.querySelector("[data-kusdt-sheet-body]").innerHTML = `
    <div class="modal-header"><div><h2>${esc(title)}</h2></div>
      <button class="modal-close" type="button" data-kusdt-sheet-cancel aria-label="Close">×</button></div>
    ${question ? `<p class="kusdt-sheet-question">${esc(question)}</p>` : ""}
    ${extraHtml}
    <div class="cold-action-rows kusdt-sheet-rows">
      ${rows.map((row) => `
        <button type="button" class="cold-action-row kusdt-choice-row${row.destructive ? " cold-action-row-danger" : ""}" data-kusdt-sheet-pick="${esc(row.id)}"${row.disabled ? " disabled" : ""}>
          ${row.iconHtml ? `<span class="kusdt-choice-icon">${row.iconHtml}</span>` : ""}
          <span class="cold-action-copy"><strong>${esc(row.title)}</strong>${row.subtitle ? `<small>${esc(row.subtitle)}</small>` : ""}</span>
          ${row.trailing != null ? `<span class="kusdt-choice-trailing">${esc(row.trailing)}</span>` : ""}
          ${row.chevron === false ? "" : `<span class="kusdt-choice-chevron">${KUSDT_ICONS.chevronRight}</span>`}
        </button>`).join("")}
    </div>
    ${footer ? `<p class="field-hint kusdt-sheet-footer" data-kusdt-sheet-footer>${esc(footer)}</p>` : '<p class="field-hint kusdt-sheet-footer" data-kusdt-sheet-footer hidden></p>'}
    <div class="modal-actions"><button class="secondary-button kusdt-sheet-cancel" type="button" data-kusdt-sheet-cancel>Cancel</button></div>`;
  host.hidden = false;
  host.querySelector("[data-kusdt-sheet-body]").focus?.({ preventScroll: true });
  try { onMount?.(host); } catch { /* the caller's */ }
  return new Promise((resolve) => { sheetSettle = resolve; });
}

// MARK: - §1 The Wallet card pager

let walletPage = 0;
function setWalletPage(page, { animate = true } = {}) {
  const track = document.querySelector("[data-wallet-card-track]");
  walletPage = Math.max(0, Math.min(1, Number(page) || 0));
  if (track) {
    track.classList.toggle("no-anim", !animate);
    track.style.transform = `translateX(${-walletPage * 100}%)`;
  }
  document.querySelectorAll("[data-wallet-card-pill]").forEach((pill) => {
    const on = Number(pill.dataset.walletCardPill) === walletPage;
    pill.classList.toggle("selected", on);
    pill.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll("[data-wallet-card-page]").forEach((card) => {
    const on = Number(card.dataset.walletCardPage) === walletPage;
    card.setAttribute("aria-hidden", on ? "false" : "true");
    card.inert = !on;
  });
  if (walletPage === 1) wallet?.refreshIfStale().catch(() => {});
}

/** The kUSDT page's figures (iOS TokenBalanceCard). */
export function renderKusdtWalletCard() {
  const card = document.querySelector("[data-kusdt-card]");
  if (!card || !wallet) return;
  const units = wallet.balance();
  card.querySelector("[data-kusdt-card-amount]").textContent = units == null ? "--" : formatKusdt(units);
  const dollars = card.querySelector("[data-kusdt-card-dollars]");
  dollars.textContent = units == null ? "" : kusdtDollars(units);
  dollars.hidden = units == null;
  card.querySelector("[data-kusdt-card-held-on]").textContent = wallet.heldOnText();
  card.querySelector("[data-kusdt-card-kas-held]").textContent = units == null ? "--" : kas(wallet.kasHeld());
}

function initWalletCards() {
  const icon = document.querySelector("[data-kusdt-card-icon]");
  if (icon) icon.innerHTML = kusdtCoinIconHtml(22);
  document.querySelectorAll("[data-wallet-card-pill]").forEach((pill) => {
    pill.addEventListener("click", () => setWalletPage(Number(pill.dataset.walletCardPill)));
  });
  document.querySelector("[data-kusdt-card]")?.addEventListener("click", () => openManageKusdt());
  // The Kaspa page opens Manage Addresses; its total keeps its own click (copies the balance).
  document.querySelector("[data-wallet-kaspa-card]")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-wallet-total]")) return;
    deps.openManageAddresses?.();
  });
  document.querySelector("[data-wallet-kaspa-card]")?.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) { event.preventDefault(); deps.openManageAddresses?.(); }
  });
  // A finger drags the cards (iOS SlidingCardPager); a mouse uses the pills.
  const pager = document.querySelector("[data-wallet-card-pager]");
  let start = null;
  pager?.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse") return;
    start = { x: event.clientX, y: event.clientY };
  });
  pager?.addEventListener("pointerup", (event) => {
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    start = null;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
    setWalletPage(walletPage + (dx < 0 ? 1 : -1));
  });
  pager?.addEventListener("pointercancel", () => { start = null; });
  setWalletPage(0, { animate: false });
  document.querySelector("[data-wallet-swap]")?.addEventListener("click", () => openSwapStablecoins());
  renderKusdtWalletCard();
}

// MARK: - §2 Swap Stablecoins

/** Which stablecoin, then Trestly's swap page in a new tab (owner, 2026-11-20). */
export async function openSwapStablecoins() {
  const pick = await openChoiceSheet({
    title: "Swap Stablecoins",
    question: "Which stablecoin?",
    rows: [{ id: "kusdt", iconHtml: kusdtCoinIconHtml(44), title: SYMBOL, subtitle: KUSDT_TEXT.swapRowSubtitle }],
    footer: KUSDT_TEXT.swapFooter,
  });
  if (pick !== "kusdt") return;
  openExternal(`${kusdtDeployment(deps.network).siteUrl}/swap`);
}

// MARK: - §3 Wallet Send's asset chooser

export async function openWalletSend() {
  if (!deps.account()) return;
  const total = deps.kaspaTotalSompi?.();
  const units = wallet.balance();
  const pick = await openChoiceSheet({
    title: "Send",
    question: "What are you sending?",
    rows: [
      { id: "kaspa", iconHtml: kaspaCoinIconHtml(40), title: "Kaspa", subtitle: deps.kasUnit || "KAS", trailing: total == null ? "--" : kas(total) },
      { id: "kusdt", iconHtml: kusdtCoinIconHtml(40), title: SYMBOL, subtitle: KUSDT_TOKEN.name, trailing: units == null ? "--" : formatKusdt(units) },
    ],
  });
  if (pick === "kaspa") deps.openSendKaspa?.({});
  else if (pick === "kusdt") openKusdtSend({});
  wallet.refreshIfStale().catch(() => {});
}

// MARK: - §4 Send kUSDT

const S = {
  open: false, owner: "", recipient: null, recipientName: null, fromId: null, startFrom: null, amountText: "",
  prepared: null, preparing: false, prepareError: null, rebuildWhenDone: false,
  fundShort: null, fundForChange: false, fundingSent: false, awaitingFunds: false, fundingRun: 0,
  outcomeUnknown: false, sending: false, failure: null, gate: createPrepareGate(), lockedName: null,
  // A send whose recipient is fixed (a 1:1 chat's Send Dollars, a KaPost tip in kUSDT): no To step,
  // it opens on From with a "To <name>" chip, and From has no Back (KaChat iOS 5b7c772c
  // TokenSendView(chatRecipient:), KaPost iOS f954738 TokenSendView(tipRecipient:)).
  locked: false,
  // (txid, index, amount) once the transfer is accepted (Send Dollars records it in the chat).
  onSent: null,
  // KaPost's tip: balances refreshed on open and whenever the window comes back to the front.
  refreshOnFocus: false,
};
let send = null; // the mounted modal: { backdrop, card, flow, swipe, controller, ... }

function sendHoldings() { return wallet.heldHoldings() || []; }
function sendFrom() {
  const list = sendHoldings();
  if (S.fromId) { const picked = list.find((h) => h.id === S.fromId); if (picked) return picked; }
  if (S.startFrom) return list.find((h) => h.id === S.startFrom.id) || S.startFrom;
  return list.length === 1 ? list[0] : null;
}
function sendSkipsFrom() { return !S.locked && (S.startFrom != null || sendHoldings().length === 1); }
function sendBalance() { return sendFrom()?.units ?? 0n; }
function sendUnits() { return kusdtUnitsFromText(S.amountText); }
function amountTooHigh() { return (sendUnits() ?? 0n) > sendBalance(); }
function recipientIsScript() { return Boolean(S.recipient) && !canHoldKusdt(S.recipient, deps.network); }
function buildKey() {
  const from = sendFrom();
  const units = sendUnits();
  if (!from || !S.recipient || units == null) return null;
  return { from: from.id, recipient: S.recipient, amount: String(units) };
}
function preparedIsCurrent() {
  const key = buildKey();
  const p = S.prepared;
  return Boolean(p && key && p.from.holdingId === key.from && p.recipient === key.recipient.toLowerCase() && String(p.amount) === key.amount);
}
function sendRecipientShown() { return S.recipientName || S.recipient || ""; }

function closeSend() {
  if (!send || send.swipe.sending) return;
  S.open = false;
  S.refreshOnFocus = false;
  S.gate.invalidate();
  S.fundingRun += 1;
  send.backdrop.hidden = true;
}

function goSend(step, options = {}) {
  if (!send) return;
  // leaving or entering the review: what it built belongs to the old amount and recipient (iOS go)
  if (send.flow.current === "review" || step === "review") {
    S.gate.invalidate();
    S.prepared = null;
    S.prepareError = null;
    S.failure = null;
    S.outcomeUnknown = false;
  }
  send.swipe.setBack(() => goSend("amount"));
  send.flow.go(step, options);
  if (step === "review") {
    paintReview();
    prepareSend();
  }
}

function mountSend() {
  if (send) return send;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop kusdt-send-backdrop";
  backdrop.hidden = true;
  backdrop.innerHTML = `
    <section class="contact-modal send-kaspa-modal kusdt-send-modal" role="dialog" aria-modal="true" aria-label="Send kUSDT">
      <div class="modal-header"><h2>Send kUSDT</h2></div>
      <div class="sk-screen"><div class="ss-review-stack kusdt-review" data-kusdt-review></div></div>
    </section>`;
  const anchor = deps.modalAnchor?.();
  if (anchor?.parentNode) anchor.parentNode.insertBefore(backdrop, anchor);
  else document.body.appendChild(backdrop);
  const card = backdrop.querySelector(".kusdt-send-modal");
  const swipe = createSwipeUpScreen(card, {
    screenTitle: "Review", barTitle: "Swipe up to Send", labels: SWIPE_UP_LABELS.send, kasUnit: deps.kasUnit,
    getPreview: () => ({ amountText: sendUnits() != null ? formatKusdt(sendUnits()) : null, recipient: sendRecipientShown() }),
    getFailureMessage: () => S.failure,
    onCancel: closeSend,
    onDone: closeSend,
    onAction: () => { sendNow(); },
  });
  const flow = createStepFlow(card, { title: `Send ${SYMBOL}`, onCancel: closeSend });
  flow.setOrder(["to", "from", "amount", "review"]);

  // To
  const toBody = flow.addStep("to", {
    question: "Who are you sending to?",
    back: () => null,
    canContinue: () => Boolean(S.recipient) && !recipientIsScript(),
    onContinue: () => goSend(sendSkipsFrom() ? "amount" : "from"),
    onShow: () => toBody.querySelector("[data-kusdt-send-recipient]")?.focus({ preventScroll: true }),
  });
  toBody.insertAdjacentHTML("beforeend", `${recipientCardHtml({ prefix: "kusdt-send" })}
    <p class="kusdt-status bad" data-kusdt-send-script hidden>${KUSDT_ICONS.octagonX}<span>${esc(KUSDT_TEXT.scriptRecipient)}</span></p>`);
  const input = toBody.querySelector("[data-kusdt-send-recipient]");
  const controller = deps.makeRecipientController({
    recipient: input,
    statusEl: toBody.querySelector("[data-kusdt-send-status]"),
    cardHost: toBody.querySelector("[data-kusdt-send-resolution]"),
    addressBook: { root: toBody, prefix: "kusdt-send" },
  }, {
    onRecipientChange: (address) => {
      if (S.locked) return; // the chat's or the poster's address, never retyped
      S.recipient = address ? String(address).toLowerCase() : null;
      const text = String(controller.recipientText() || "");
      S.recipientName = S.lockedName && S.recipient && S.recipient === String(deps.account()).toLowerCase()
        ? S.lockedName
        : (S.recipient && text && text.toLowerCase() !== S.recipient && !/^kaspa(test)?:/i.test(text) ? text : (S.recipient ? deps.addressBookName?.(S.recipient) || null : null));
      toBody.querySelector("[data-kusdt-send-script]").hidden = !recipientIsScript();
      flow.refresh();
    },
  });
  input.addEventListener("input", () => { if (input.value.trim().toLowerCase() !== String(deps.account()).toLowerCase()) S.lockedName = null; });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || flow.current !== "to" || !S.recipient || recipientIsScript()) return;
    event.preventDefault();
    goSend(sendSkipsFrom() ? "amount" : "from");
  });
  toBody.querySelector("[data-kusdt-send-paste]")?.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) { input.value = text.trim(); input.dispatchEvent(new Event("input")); }
    } catch { deps.showToast?.("Clipboard unavailable. Paste manually."); }
  });
  toBody.querySelector("[data-kusdt-send-scan]")?.addEventListener("click", async () => {
    const scanned = await scanKaspaAddress({ title: "Scan a recipient code", hint: "Point the camera at the address QR code you want to send to." });
    if (scanned) { input.value = scanned; input.dispatchEvent(new Event("input")); }
  });
  toBody.querySelector("[data-kusdt-send-address-book]")?.addEventListener("click", async () => {
    const entry = await deps.pickFromAddressBook?.();
    if (entry?.address) { input.value = entry.address; input.dispatchEvent(new Event("input")); }
  });

  // From
  const fromBody = flow.addStep("from", {
    question: "Where are you sending from?",
    className: "ss-from-step",
    back: () => (S.locked ? null : "to"),
    canContinue: () => sendFrom() != null,
    onContinue: () => goSend("amount"),
    onShow: () => { paintFrom(); wallet.refreshIfStale().catch(() => {}); },
  });
  fromBody.insertAdjacentHTML("afterbegin", '<div class="ss-chips start" data-kusdt-from-chips hidden></div>');
  fromBody.insertAdjacentHTML("beforeend", `<div class="sk-source-list ss-address-list" data-kusdt-from-list role="listbox" aria-label="Your addresses holding kUSDT"></div>
    <p class="ss-note kusdt-from-footnote">${esc(KUSDT_TEXT.fromFootnote)}</p>`);
  fromBody.querySelector("[data-kusdt-from-list]").addEventListener("click", (event) => {
    // None held, from a chat or a tip: Swap Stablecoins (Desktop's stand-in for iOS's Get KaPay,
    // owner 2026-11-20), over this screen.
    if (event.target.closest("[data-kusdt-from-swap]")) { openSwapStablecoins(); return; }
    const row = event.target.closest("[data-kusdt-from]");
    if (!row || S.sending) return;
    S.fromId = row.dataset.kusdtFrom;
    S.amountText = ""; // a new address: its own balance (iOS fromRow)
    paintFrom();
  });

  // How much
  const amountBody = flow.addStep("amount", {
    className: "ss-amount-step",
    continueTitle: "Review",
    question: "How much?",
    back: () => (sendSkipsFrom() ? "to" : "from"), // a locked send never skips From
    canContinue: () => sendUnits() != null && !amountTooHigh(),
    onContinue: () => goSend("review"),
    onShow: () => paintAmount(),
  });
  amountBody.insertAdjacentHTML("beforeend", `
    <div class="ss-chips start" data-kusdt-chips></div>
    <div class="ss-keypad-stage">
      ${keypadAmountTextHtml({ unit: SYMBOL, attr: "kusdt-amount" })}
      <div class="sk-pills kusdt-max-row"><button type="button" class="sk-pill sk-pill-button kusdt-max" data-kusdt-max>Max</button></div>
      <p class="ss-footnote" data-kusdt-amount-note></p>
    </div>
    ${keypadHtml()}`);
  wireKeypad(amountBody.querySelector(".ss-keypad"), (key) => {
    if (S.sending) return false;
    const next = applyKeypadKey(key, S.amountText, KUSDT_DECIMALS);
    if (next === S.amountText) return false;
    S.amountText = next;
    paintAmount();
    return true;
  });
  amountBody.querySelector("[data-kusdt-max]").addEventListener("click", () => {
    S.amountText = typedKusdt(sendBalance());
    if (S.amountText === "0") S.amountText = "";
    paintAmount();
  });

  // Review: Fund This Address, Check Again, Try Again (the build)
  const review = card.querySelector("[data-kusdt-review]");
  review.addEventListener("click", (event) => {
    if (event.target.closest("[data-kusdt-fund]")) openFunding();
    else if (event.target.closest("[data-kusdt-check-again]")) prepareAfterFunding(true);
    else if (event.target.closest("[data-kusdt-rebuild]")) prepareSend();
  });

  send = { backdrop, card, flow, swipe, controller, toBody, fromBody, amountBody, review, input };
  wallet.subscribe(() => {
    if (!send || send.backdrop.hidden) return;
    if (send.flow.current === "from") paintFrom();
    if (send.flow.current === "amount") paintAmount();
    send.flow.refresh();
  });
  return send;
}

function paintFrom() {
  if (!send) return;
  const list = send.fromBody.querySelector("[data-kusdt-from-list]");
  const holdings = sendHoldings();
  const selected = sendFrom();
  // From a chat or a tip: who it goes to, above the question (iOS SendStepChip "To <name>").
  const chips = send.fromBody.querySelector("[data-kusdt-from-chips]");
  chips.hidden = !(S.locked && S.recipient);
  chips.innerHTML = S.locked && S.recipient ? stepChipHtml({ label: "To", value: S.recipientName || S.recipient, isAddress: !S.recipientName }) : "";
  if (!holdings.length) {
    // Still looking (Send Dollars' Discover, a refresh): "Checking"; else none held, with Swap
    // Stablecoins where iOS offers Get KaPay (owner 2026-11-20).
    list.innerHTML = wallet.discovering || wallet.refreshing || !wallet.known
      ? `<div class="sk-source-empty">${spinnerLine(KUSDT_TEXT.fromChecking)}</div>`
      : `<div class="sk-source-empty kusdt-from-none"><p>${esc(KUSDT_TEXT.fromNone)}</p>
          <button type="button" class="primary-button kusdt-fund-button kusdt-from-swap" data-kusdt-from-swap>${KUSDT_ICONS.dollarCircle}<span>Swap Stablecoins</span></button></div>`;
  } else {
    list.innerHTML = holdings.map((h) => {
      const current = selected?.id === h.id;
      return `<button type="button" class="sk-source-row${current ? " current" : ""}" role="option" aria-selected="${current}" data-kusdt-from="${esc(h.id)}">
        <span class="sk-source-copy">
          <span class="sk-source-name">${esc(holdingLabel(h))}</span>
          <code class="sk-source-address">${esc(shortSendAddress(h.address))}</code>
        </span>
        <span class="sk-source-balance">${esc(formatKusdt(h.units))}</span>
        <span class="sk-source-check" aria-hidden="true">${current ? SEND_ICONS.check : ""}</span>
      </button>`;
    }).join("");
  }
  send.flow.refresh();
}

function paintAmount() {
  if (!send) return;
  const from = sendFrom();
  send.amountBody.querySelector("[data-kusdt-chips]").innerHTML = `${S.recipient ? stepChipHtml({ label: "To", value: S.recipientName || S.recipient, isAddress: !S.recipientName }) : ""}${from ? stepChipHtml({ label: "From", value: holdingLabel(from) }) : ""}`;
  paintKeypadAmount(send.amountBody.querySelector("[data-kusdt-amount]"), S.amountText, SYMBOL);
  const note = send.amountBody.querySelector("[data-kusdt-amount-note]");
  const over = amountTooHigh();
  note.textContent = over ? KUSDT_TEXT.overBalance : `Available: ${formatKusdt(sendBalance())}`;
  note.classList.toggle("error", over);
  send.flow.refresh();
}

function reviewStatusHtml() {
  const short = S.fundShort;
  if (S.awaitingFunds) return spinnerLine(KUSDT_TEXT.waitingForKas);
  if (S.preparing) return spinnerLine(KUSDT_TEXT.building);
  if (S.fundingSent && short != null) {
    return `<div class="kusdt-fund">
      <p class="kusdt-status muted">${KUSDT_ICONS.clock}<span>${esc(KUSDT_TEXT.notLanded)}</span></p>
      <button type="button" class="primary-button kusdt-fund-button" data-kusdt-check-again>Check Again</button>
      <button type="button" class="linklike-button kusdt-fund-more" data-kusdt-fund>${esc(`Add ${kas(short)} More`)}</button>
    </div>`;
  }
  if (S.prepareError) {
    return `<div class="kusdt-fund">
      <p class="kusdt-status bad">${KUSDT_ICONS.warning}<span>${esc(S.prepareError)}</span></p>
      ${short != null
    ? `<button type="button" class="primary-button kusdt-fund-button" data-kusdt-fund>${KUSDT_ICONS.arrowToLine}<span>${esc(S.fundForChange ? `Add ${kas(short)} for Fee and Change Coin` : `Add ${kas(short)} for the Network Fee`)}</span></button>
         <p class="kusdt-fund-caption">${esc(KUSDT_TEXT.fundCaption)}</p>`
    : '<button type="button" class="linklike-button kusdt-fund-more" data-kusdt-rebuild>Try Again</button>'}
    </div>`;
  }
  return "";
}

function paintReview() {
  if (!send) return;
  const units = sendUnits();
  const from = sendFrom();
  const p = preparedIsCurrent() ? S.prepared : null;
  const fee = p ? kas(p.fee) : (S.preparing ? "…" : "--");
  send.review.innerHTML = `
    <div class="ss-review-amount kusdt-review-amount">
      <span class="ss-review-eyebrow">You're sending</span>
      ${units != null ? `<span class="kusdt-review-big">${kusdtCoinIconHtml(34)}<span class="ss-review-big">${esc(formatKusdt(units))}</span></span>
      <span class="ss-review-fiat">${esc(kusdtDollars(units))}</span>` : ""}
    </div>
    <div class="kusdt-review-to">
      <span class="kusdt-section-label">To</span>
      <div data-kusdt-review-card>${S.recipient ? deps.addressCardHtml(S.recipient, { domain: S.recipientName }) : ""}</div>
    </div>
    <div class="sk-card ss-review-card kusdt-review-box">
      ${reviewRowHtml("From", `<strong>${esc(from ? holdingLabel(from) : "--")}</strong>`)}
      ${reviewRowHtml("Goes With It", `<strong>${esc(kas(p ? p.kasToRecipient : KAS_PER_COIN))}</strong>`)}
      ${reviewRowHtml("Network Fee", `<strong>${esc(fee)}</strong>`)}
      <div class="ss-review-row kusdt-review-total"><span class="ss-review-label">Total KAS</span><span class="ss-review-value"><strong>${esc(p ? kas(p.kasToRecipient + p.fee) : "--")}</strong></span></div>
      ${reviewRowHtml("KAS Paid From", `<strong>${esc(from ? holdingLabel(from) : "--")}</strong>`)}
    </div>
    ${p?.feeFromTokenKas ? `<p class="kusdt-status muted">${KUSDT_ICONS.info}<span>${esc(KUSDT_TEXT.feeFromTokenKas)}</span></p>` : ""}
    ${reviewStatusHtml()}
    <p class="ss-review-note">${esc(KUSDT_TEXT.coinHoldsKas)}</p>`;
  send.swipe.setEnabled(preparedIsCurrent() && !S.preparing && !amountTooHigh());
}

/** Builds and signs the transfer for what the review shows (iOS prepare). Kept only if nothing
 *  changed meanwhile (the gate, the account); a build asked for meanwhile runs after this one. */
async function prepareSend() {
  const from = sendFrom();
  const key = buildKey();
  if (!send || !from || !key) return;
  if (S.preparing) { S.rebuildWhenDone = true; return; }
  const owner = S.owner;
  if (!owner || deps.account() !== owner) return;
  const ticket = S.gate.begin(key);
  const isCurrent = () => S.open && ticket.isCurrent(buildKey()) && deps.account() === owner;
  S.preparing = true;
  S.prepareError = null;
  paintReview();
  try {
    let secretKey = null;
    try { secretKey = deps.secretKeyFor(from); } catch { secretKey = null; }
    const built = await prepareTransfer({
      from: { address: from.address, holdingId: from.id, label: holdingLabel(from) },
      coins: wallet.coinsOf(from), recipient: key.recipient, amount: BigInt(key.amount), secretKey,
      engine: deps.engine, store: wallet.storeFor(owner), network: deps.network, log: deps.log,
    });
    secretKey = null;
    if (isCurrent()) {
      built.owner = owner;
      built.recipientLabel = S.recipientName || null;
      S.prepared = built;
      S.fundShort = null;
      S.fundingSent = false;
    }
  } catch (error) {
    if (isCurrent()) {
      S.prepared = null;
      if (error instanceof KusdtTransferError && error.code === "notEnoughKas") {
        S.fundShort = error.short;
        S.fundForChange = Boolean(error.forChangeCoin);
      } else {
        S.fundShort = null;
      }
      S.prepareError = messageFor(error);
    }
  } finally {
    S.preparing = false;
  }
  if (send.flow.current === "review" && S.open) paintReview();
  if (S.rebuildWhenDone) {
    S.rebuildWhenDone = false;
    if (send.flow.current === "review" && !preparedIsCurrent()) await prepareSend();
  }
}

/** Fund This Address (iOS openFunding): Send Kaspa, already filled in as a request for the
 *  shortfall to the sending address, signed by the Chatting Address. Desktop's Send Kaspa sheet
 *  comes over this one; when it closes the review builds again. */
function openFunding() {
  const from = sendFrom();
  if (!from || S.fundShort == null) return;
  const request = deps.makeFundingRequest?.({ address: from.address, amountSompi: S.fundShort, memo: KUSDT_TEXT.fundMemo });
  if (!request) return;
  deps.openSendKaspa?.({
    paymentRequest: request,
    onClosed: ({ sent }) => {
      if (!S.open) return;
      if (sent) S.fundingSent = true;
      prepareAfterFunding(Boolean(sent));
    },
  });
}

/** Built again until the KAS has landed (iOS prepareAfterFunding): every 3 s, 20 times after a
 *  send, 3 after a close without one. */
async function prepareAfterFunding(sent) {
  const run = ++S.fundingRun;
  S.awaitingFunds = sent;
  paintReview();
  try {
    for (let attempt = 0; attempt < (sent ? 20 : 3); attempt += 1) {
      if (attempt > 0) await sleep(3000);
      if (run !== S.fundingRun || !S.open || send.flow.current !== "review") return;
      while (S.preparing) await sleep(200);
      if (attempt > 0 || sent) await wallet.refresh().catch(() => {});
      await prepareSend();
      if (S.prepared || S.fundShort == null) return;
    }
  } finally {
    if (run === S.fundingRun) { S.awaitingFunds = false; if (S.open && send.flow.current === "review") paintReview(); }
  }
}

/** The tap (iOS TokenSendView.send). A review older than 2 minutes is built again and shown, not
 *  sent; "Not confirmed" keeps the signed transaction, and Try Again resends that same one. */
async function sendNow() {
  if (S.sending) return;
  S.failure = null;
  S.sending = true;
  send.swipe.setBusy(true);
  try {
    while (S.preparing) await sleep(200);
    const built = S.prepared;
    if (!built || !preparedIsCurrent()) {
      S.failure = S.prepareError || TRANSFER_MESSAGES.cantBuild;
      return;
    }
    if (!S.outcomeUnknown && isReviewStale(built)) {
      S.prepared = null;
      await prepareSend();
      while (S.preparing) await sleep(200);
      const outcome = staleReviewOutcome(built, preparedIsCurrent() ? S.prepared : null);
      S.failure = outcome.code === "cantBuild" ? (S.prepareError || outcome.message)
        // from a chat or a tip (KaChat iOS TokenSendView.send's wording)
        : S.locked ? KUSDT_TEXT.lockedChanged
          : outcome.code === "feeChanged" ? sendFeeChangedError(outcome.feeSompi).message : outcome.message;
      return;
    }
    const onSent = S.onSent;
    try {
      const result = await wallet.submit(built, { retryingUnknown: S.outcomeUnknown });
      S.outcomeUnknown = false;
      // the recipient's coin is output 0 (engine/kusdt-transfer.js: the recipient's output first)
      if (onSent) { try { onSent(result.txid, 0, built.amount); } catch (error) { deps.log?.(`[kUSDT] recording the chat payment failed: ${error?.message || error}`); } }
      send.swipe.setSent({ txid: result.txid, amountText: formatKusdt(built.amount), recipient: sendRecipientShown(), explorerUrl: deps.explorerTxUrl?.(result.txid) || null });
    } catch (error) {
      if (error?.code === SEND_OUTCOME_UNKNOWN) {
        S.outcomeUnknown = true;
        S.failure = error.notConfirmedMessage || TRANSFER_MESSAGES.notConfirmed;
        // From a chat: if it did land, the chat still gets its bubble and notice, even once this
        // screen is closed (the caller records each txid once).
        if (onSent) pollUnknownChatSend(built.txid, built.amount, onSent, built.owner || S.owner);
      } else {
        S.failure = messageFor(error);
      }
    }
  } finally {
    S.sending = false;
    send.swipe.setBusy(false);
    if (send.flow.current === "review") paintReview();
  }
}

/** A "Not confirmed" send from a chat (KaChat iOS 5b7c772c): looked up every 10 s, 18 times; once
 *  the network has accepted it, `onSent` records it (the caller does that once per txid, and keeps
 *  the notice for the account that paid if another one is open by then). */
async function pollUnknownChatSend(txid, amount, onSent, owner) {
  for (let attempt = 0; attempt < LOCKED_SEND_POLL_TRIES; attempt += 1) {
    await sleep(LOCKED_SEND_POLL_MS);
    let accepted = false;
    try { accepted = (await deps.isTransactionAccepted?.(txid)) === true; } catch { accepted = false; }
    if (!accepted) continue;
    deps.log?.(`[kUSDT] the chat send ${String(txid).slice(0, 12)} that wasn't confirmed was accepted`);
    try { onSent(txid, 0, amount, { owner }); } catch { /* the chat's own problem */ }
    return;
  }
}

// KaPost's tip in kUSDT: the balances are looked up again whenever the window comes back to the
// front while it is open (KaPost iOS f954738 scenePhase .active), so kUSDT just bought on Trestly's
// site is there to send.
let focusRefreshWired = false;
function wireFocusRefresh() {
  if (focusRefreshWired || typeof window === "undefined") return;
  focusRefreshWired = true;
  window.addEventListener("focus", () => {
    if (S.open && S.refreshOnFocus && deps.account() === S.owner) wallet.refresh().catch(() => {});
  });
}

/**
 * Send kUSDT. `startFrom`: a holding the send leaves from (its page's Send; no From step).
 * `recipient` / `recipientName`: the To filled in (Send to Chatting Address), opening on How much
 * (or From when more than one address could send).
 * `locked`: the recipient is fixed - a 1:1 chat's Send Dollars or a KaPost tip in kUSDT (KaChat
 * iOS 5b7c772c, KaPost iOS f954738): no To step, it always opens on From (with no Back) and a
 * "To <recipientName>" chip. `onSent(txid, index, amount)`: the transfer was accepted (also after
 * a "Not confirmed" that turns out to have landed). `refresh`: "always" looks the balances up as it
 * opens and again on window focus (the tip); "discover" leaves it to Send Dollars' own Discover.
 */
export function openKusdtSend({ startFrom = null, recipient = null, recipientName = null, locked = false, onSent = null, refresh = "stale" } = {}) {
  const owner = deps.account();
  if (!owner) return;
  mountSend();
  const lock = Boolean(locked && recipient);
  Object.assign(S, {
    open: true, owner, recipient: null, recipientName: null, fromId: null, startFrom: lock ? null : startFrom, amountText: "",
    prepared: null, preparing: false, prepareError: null, rebuildWhenDone: false, fundShort: null, fundForChange: false,
    fundingSent: false, awaitingFunds: false, outcomeUnknown: false, sending: false, failure: null, lockedName: recipientName,
    locked: false, onSent: lock && typeof onSent === "function" ? onSent : null, refreshOnFocus: lock && refresh === "always",
  });
  S.gate.invalidate();
  S.fundingRun += 1;
  send.swipe.reset();
  send.swipe.setKasUnit(deps.kasUnit);
  send.backdrop.hidden = false;
  send.controller.open();
  send.toBody.querySelector("[data-kusdt-send-script]").hidden = true;
  if (lock) {
    // the chat's or the poster's chatting address, as it is: the To step never shows
    send.input.value = "";
    S.locked = true;
    S.recipient = String(recipient).trim().toLowerCase();
    S.recipientName = recipientName || null;
  } else if (recipient) {
    send.input.value = recipient;
    send.input.dispatchEvent(new Event("input"));
  }
  if (S.refreshOnFocus) { wireFocusRefresh(); wallet.refresh().catch(() => {}); }
  else if (refresh !== "discover") wallet.refreshIfStale().catch(() => {});
  goSend(lock ? "from" : recipient ? (startFrom ? "amount" : "from") : "to", { instant: true });
}

/** §14's second step and §15's chooser rows' kUSDT figure: the total, "--" before it is known. */
export function kusdtTotalText() {
  const units = wallet?.balance();
  return units == null ? "--" : formatKusdt(units);
}
/** Whether kUSDT is being looked up right now (the rows' spinner). */
export function kusdtLooking() {
  return Boolean(wallet && (wallet.discovering || wallet.refreshing));
}

/**
 * §15 KaPost's Tip with Tip In on Ask Each Time (KaPost iOS f954738 KaPostTipFlow.chooser): "Tip" /
 * "What are you tipping in?", Kaspa (KAS, the chatting balance) or kUSDT ("Not counted on the
 * post", the kUSDT total), the footnote, Cancel. Resolves "kaspa", "kusdt" or null. The kUSDT
 * figure follows the balances while it is open (looked up if stale).
 */
export async function openTipAssetChooser({ kaspaBalanceText = "--" } = {}) {
  if (!deps?.account()) return null;
  let unsubscribe = null;
  const pick = openChoiceSheet({
    title: KUSDT_TEXT.tipTitle,
    question: KUSDT_TEXT.tipQuestion,
    rows: [
      { id: "kaspa", iconHtml: kaspaCoinIconHtml(44), title: "Kaspa", subtitle: deps.kasUnit || "KAS", trailing: kaspaBalanceText || "--" },
      { id: "kusdt", iconHtml: kusdtCoinIconHtml(44), title: SYMBOL, subtitle: KUSDT_TEXT.tipKusdtSubtitle, trailing: kusdtTotalText() },
    ],
    footer: KUSDT_TEXT.tipFootnote,
    onMount: (host) => {
      const paint = () => {
        const cell = host.querySelector('[data-kusdt-sheet-pick="kusdt"] .kusdt-choice-trailing');
        if (cell) cell.textContent = kusdtTotalText();
      };
      unsubscribe = wallet.subscribe(paint);
    },
  });
  wallet.refreshIfStale().catch(() => {});
  try { return await pick; } finally { try { unsubscribe?.(); } catch { /* gone */ } }
}

// MARK: - §6 Combine Coins

const C = { open: false, owner: "", holding: null, prepared: null, preparing: false, prepareError: null, sending: false, failure: null, outcomeUnknown: false, run: 0 };
let combine = null;
const COMBINE_LABELS = {
  release: "Release to Confirm", working: "Sending", workingDetail: "Broadcasting to the Kaspa BlockDAG...",
  done: "Coins Combined", hint: "Swipe up, then let go to combine.", recipientWord: "", failedFallback: "The transaction didn't go out.",
};
function mountCombine() {
  if (combine) return combine;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop kusdt-send-backdrop";
  backdrop.hidden = true;
  backdrop.innerHTML = `
    <section class="contact-modal send-kaspa-modal kusdt-send-modal" role="dialog" aria-modal="true" aria-label="Combine Coins">
      <div class="modal-header"><h2>Combine Coins</h2></div>
      <div class="sk-screen"><div class="ss-review-stack kusdt-review" data-kusdt-combine></div></div>
    </section>`;
  const anchor = deps.modalAnchor?.();
  if (anchor?.parentNode) anchor.parentNode.insertBefore(backdrop, anchor);
  else document.body.appendChild(backdrop);
  const card = backdrop.querySelector(".kusdt-send-modal");
  const swipe = createSwipeUpScreen(card, {
    screenTitle: "Combine Coins", barTitle: "Swipe up to Combine", labels: COMBINE_LABELS, kasUnit: deps.kasUnit,
    getPreview: () => ({}),
    getFailureMessage: () => C.failure,
    onCancel: closeCombine,
    onDone: closeCombine,
    onAction: () => { combineNow(); },
  });
  const body = card.querySelector("[data-kusdt-combine]");
  body.addEventListener("click", (event) => { if (event.target.closest("[data-kusdt-rebuild]")) prepareCombineNow(); });
  combine = { backdrop, card, swipe, body };
  return combine;
}
function closeCombine() {
  if (!combine || combine.swipe.sending) return;
  C.open = false;
  C.run += 1;
  combine.backdrop.hidden = true;
}
function paintCombine() {
  if (!combine || !C.holding) return;
  const h = C.holding;
  const coinCount = wallet.coinsOf(h).length;
  const merging = C.prepared?.spentCoins.length ?? Math.min(coinCount, MAX_TOKEN_INPUTS);
  const p = C.prepared;
  const pending = C.preparing ? "…" : "--";
  combine.body.innerHTML = `
    <div class="ss-review-amount kusdt-review-amount">
      ${kusdtCoinIconHtml(44)}
      <span class="ss-review-eyebrow">${esc(holdingLabel(h))}</span>
      <span class="ss-review-big kusdt-combine-big">${esc(`${merging} coins into 1`)}</span>
    </div>
    <p class="ss-review-note">${esc(KUSDT_TEXT.combineNote)}</p>
    <div class="sk-card ss-review-card kusdt-review-box">
      ${reviewRowHtml("Combined", `<strong>${esc(p ? formatKusdt(p.amount) : "--")}</strong>`)}
      ${reviewRowHtml("KAS Held With It", `<strong>${esc(`${kas(BigInt(merging) * KAS_PER_COIN)} → ${kas(KAS_PER_COIN)}`)}</strong>`)}
      ${reviewRowHtml("Network Fee", `<strong>${esc(p ? kas(p.fee) : pending)}</strong>`)}
      <div class="ss-review-row kusdt-review-total"><span class="ss-review-label">Back to This Address</span><span class="ss-review-value"><strong>${esc(p ? kas(p.kasBack) : pending)}</strong></span></div>
    </div>
    ${coinCount > MAX_TOKEN_INPUTS ? `<p class="kusdt-status muted">${KUSDT_ICONS.info}<span>${esc(KUSDT_TEXT.combineMore)}</span></p>` : ""}
    ${C.preparing ? spinnerLine(KUSDT_TEXT.building) : ""}
    ${!C.preparing && C.prepareError ? `<div class="kusdt-fund"><p class="kusdt-status bad">${KUSDT_ICONS.warning}<span>${esc(C.prepareError)}</span></p>
      <button type="button" class="linklike-button kusdt-fund-more" data-kusdt-rebuild>Try Again</button></div>` : ""}`;
  combine.swipe.setEnabled(Boolean(p) && !C.preparing);
}
async function prepareCombineNow() {
  if (!combine || C.preparing || !C.holding) return;
  const owner = C.owner;
  const run = C.run;
  const h = C.holding;
  const isCurrent = () => C.open && run === C.run && deps.account() === owner;
  C.preparing = true;
  C.prepareError = null;
  paintCombine();
  try {
    let secretKey = null;
    try { secretKey = deps.secretKeyFor(h); } catch { secretKey = null; }
    const built = await prepareCombine({
      from: { address: h.address, holdingId: h.id, label: holdingLabel(h) }, coins: wallet.coinsOf(h), secretKey,
      engine: deps.engine, store: wallet.storeFor(owner), network: deps.network, log: deps.log,
    });
    secretKey = null;
    if (isCurrent()) { built.owner = owner; C.prepared = built; }
  } catch (error) {
    if (isCurrent()) { C.prepared = null; C.prepareError = messageFor(error); }
  } finally {
    C.preparing = false;
  }
  if (isCurrent()) paintCombine();
}
async function combineNow() {
  if (C.sending) return;
  C.failure = null;
  C.sending = true;
  combine.swipe.setBusy(true);
  try {
    while (C.preparing) await sleep(200);
    const built = C.prepared;
    if (!built) { C.failure = C.prepareError || TRANSFER_MESSAGES.cantBuild; return; }
    if (!C.outcomeUnknown && isReviewStale(built)) {
      C.prepared = null;
      await prepareCombineNow();
      const outcome = staleReviewOutcome(built, C.prepared);
      C.failure = outcome.code === "feeChanged" ? sendFeeChangedError(outcome.feeSompi).message
        : outcome.code === "cantBuild" ? (C.prepareError || outcome.message) : outcome.message;
      return;
    }
    try {
      const result = await wallet.submit(built, { retryingUnknown: C.outcomeUnknown });
      C.outcomeUnknown = false;
      combine.swipe.setSent({ txid: result.txid, explorerUrl: deps.explorerTxUrl?.(result.txid) || null });
    } catch (error) {
      if (error?.code === SEND_OUTCOME_UNKNOWN) { C.outcomeUnknown = true; C.failure = error.notConfirmedMessage || TRANSFER_MESSAGES.notConfirmed; }
      else C.failure = messageFor(error);
    }
  } finally {
    C.sending = false;
    combine.swipe.setBusy(false);
    paintCombine();
  }
}
export function openCombineCoins(holding) {
  const owner = deps.account();
  if (!owner || !holding) return;
  mountCombine();
  Object.assign(C, { open: true, owner, holding, prepared: null, preparing: false, prepareError: null, sending: false, failure: null, outcomeUnknown: false });
  C.run += 1;
  combine.swipe.reset();
  combine.swipe.setKasUnit(deps.kasUnit);
  combine.backdrop.hidden = false;
  paintCombine();
  prepareCombineNow();
}

// MARK: - Overlays (Manage kUSDT, an address's page, Visibility, Receive, the Guide)

function overlay(className, label, inner) {
  const el = document.createElement("div");
  el.className = `chatting-address-screen ${className}`;
  el.hidden = true;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", label);
  el.innerHTML = inner;
  document.body.appendChild(el);
  return el;
}
const backButtonHtml = (attr) => `<button class="chatting-address-back" type="button" ${attr} aria-label="Back">${KUSDT_ICONS.chevronLeft}</button>`;

// MARK: §7 Manage kUSDT

let manageEl = null;
let manageUsed = new Set();
function mountManage() {
  if (manageEl) return manageEl;
  manageEl = overlay("manage-address-screen spending-manage-screen kusdt-manage-screen", "Manage kUSDT", `
    <div class="manage-address-card">
      <header class="chatting-address-header">
        ${backButtonHtml("data-kusdt-manage-close")}
        <span class="chatting-address-balance">Manage ${esc(SYMBOL)}</span>
        <button class="chatting-address-back domains-refresh" type="button" data-kusdt-manage-refresh aria-label="Refresh" title="Refresh">${KUSDT_ICONS.refresh}</button>
      </header>
      <div class="manage-address-body">
        <div data-kusdt-manage-summary></div>
        <div class="manage-address-list kusdt-holding-list" data-kusdt-manage-list></div>
      </div>
      <button type="button" class="spending-actions-fab" data-kusdt-actions aria-label="${esc(SYMBOL)} Actions" title="${esc(SYMBOL)} Actions">${KUSDT_ICONS.sliders}</button>
    </div>`);
  manageEl.querySelector("[data-kusdt-manage-close]").addEventListener("click", () => { manageEl.hidden = true; });
  manageEl.querySelector("[data-kusdt-manage-refresh]").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.classList.add("spinning");
    button.disabled = true;
    try { await wallet.discover(); } finally { button.classList.remove("spinning"); button.disabled = false; }
  });
  manageEl.querySelector("[data-kusdt-actions]").addEventListener("click", () => openActionsSheet());
  manageEl.addEventListener("click", (event) => {
    if (event.target.closest("[data-kusdt-about]")) { openAboutKusdt(); return; }
    if (event.target.closest("[data-kusdt-hidden-note]")) { openVisibility(); return; }
    const menu = event.target.closest("[data-kusdt-row-menu]");
    if (menu) { event.stopPropagation(); openRowMenu(menu.dataset.kusdtRowMenu); return; }
    const row = event.target.closest("[data-kusdt-row]");
    if (row) openAddressPage(row.dataset.kusdtRow);
  });
  return manageEl;
}

function summaryHtml() {
  const units = wallet.balance();
  const error = wallet.error;
  return `<div class="spending-total kusdt-summary">
    <span>Total Balance</span>
    <strong>${esc(units == null ? "--" : formatKusdt(units))}</strong>
    ${units != null ? `<small class="kusdt-dollars">${esc(kusdtDollars(units))}</small>` : ""}
    <button type="button" class="sk-pill sk-pill-button kusdt-bridged-pill" data-kusdt-about>Bridged by ${esc(KUSDT_TOKEN.issuer)}${KUSDT_ICONS.info}</button>
    ${error ? `<p class="kusdt-status warn">${KUSDT_ICONS.warning}<span>${esc(`Couldn't check ${SYMBOL} just now: ${error} Refresh to try again.`)}</span></p>` : ""}
    ${wallet.refreshing ? spinnerLine(`Checking your ${SYMBOL}...`) : ""}
  </div>`;
}

function holdingRowHtml(h) {
  const label = holdingLabel(h);
  const used = isHoldingUsed(h, { usedIndices: manageUsed, activity: wallet.activity() });
  const chatting = h.spendingIndex == null;
  return `
    <div class="spending-address-row kusdt-holding-row${chatting ? " chatting-address-row" : ""}">
      <button type="button" class="spending-address-row-main" data-kusdt-row="${esc(h.id)}" aria-label="Open ${esc(label)}">
        <span class="spending-address-label">${esc(label)}<span class="kusdt-row-icon${chatting ? " chatting" : ""}">${chatting ? KUSDT_ICONS.chat : KUSDT_ICONS.eyeSlash}</span></span>
        <span class="spending-address-value">${esc(shortKusdtAddress(h.address))}</span>
        <span class="spending-address-balance kusdt-row-amount">${esc(formatKusdt(h.units))}<small>${esc(`${kas(BigInt(h.coinCount) * KAS_PER_COIN)} held with it`)}</small></span>
        <span class="spending-address-row-tags"><span class="spending-address-usage ${used ? "used" : "unused"}">${used ? "Used" : "Unused"}</span></span>
      </button>
      ${/* Every row has its ⋮, the Chatting Address's too (KaChat iOS 148a5331, owner's call). */ ""}
      <div class="spending-address-row-menu-wrap"><button type="button" class="spending-row-menu-btn" data-kusdt-row-menu="${esc(h.id)}" aria-label="Address Actions">${KUSDT_ICONS.ellipsisVertical}</button></div>
    </div>`;
}

function renderManage() {
  if (!manageEl || manageEl.hidden) return;
  manageEl.querySelector("[data-kusdt-manage-summary]").innerHTML = summaryHtml();
  const rows = wallet.listed();
  const hidden = wallet.hiddenCount();
  const held = wallet.heldHoldings();
  let html = rows.map(holdingRowHtml).join("");
  if (held != null && held.length === 0 && rows.length <= 1) {
    html += `<div class="no-results-card kusdt-empty">${kusdtCoinIconHtml(44)}<strong>${esc(KUSDT_TEXT.emptyTitle)}</strong><span>${esc(KUSDT_TEXT.emptyText)}</span></div>`;
  }
  if (hidden > 0) html += `<button type="button" class="linklike-button kusdt-hidden-note" data-kusdt-hidden-note>${esc(`${hidden} hidden: they still count in the total.`)}</button>`;
  manageEl.querySelector("[data-kusdt-manage-list]").innerHTML = html;
}

/** Manage kUSDT (iOS TokenManageView). Also where a "Received X kUSDT" notification goes. */
export function openManageKusdt() {
  if (!deps.account()) return;
  mountManage();
  manageUsed = deps.usedSpendingIndices?.() || new Set();
  manageEl.hidden = false;
  renderManage();
  wallet.refreshIfStale().catch(() => {});
}

async function openRowMenu(id) {
  const h = wallet.holdingById(id);
  if (!h) return;
  // The Chatting Address's ⋮ has only Copy, Show QR Code and Combine Coins (KaChat iOS 148a5331):
  // it can't be renamed, hidden or sent to itself.
  const chatting = h.spendingIndex == null;
  const options = [
    chatting ? null : { id: "rename", title: "Rename Address", subtitle: "Gives this address a label of your own." },
    { id: "copy", title: "Copy Address", subtitle: "Puts the full address on the clipboard." },
    { id: "qr", title: "Show QR Code", subtitle: "Full screen, for scanning with another device." },
    chatting ? null : { id: "send-chatting", title: "Send to Chatting Address", subtitle: "Moves kUSDT from this address to your Chatting Address.", disabled: !(h.units > 0n) },
    h.coinCount > 1 ? { id: "combine", title: "Combine Coins", subtitle: "Merges its coins into one and gives the extra KAS back." } : null,
    chatting ? null : { id: "hide", title: "Hide Address", subtitle: `Removes it from this list. Re-enable it in ${SYMBOL} Address Visibility.`, destructive: true },
  ];
  const choice = await chooseDialog({ title: holdingLabel(h), message: shortKusdtAddress(h.address), options });
  if (choice === "rename") {
    const next = await promptDialog({ title: "Rename Address", label: "Label", message: "Give this address a label to help you recognize it.", initial: deps.customLabel?.(h.spendingIndex) || "", confirmLabel: "Save" });
    if (next == null) return;
    deps.renameSpending?.(h.spendingIndex, String(next).trim());
    renderManage();
  } else if (choice === "copy") {
    try { await deps.copyText(h.address); deps.showToast?.(deps.addressCopiedToastText?.(h.address) || "Address copied"); } catch { /* clipboard blocked */ }
  } else if (choice === "qr") {
    openKusdtReceive({ fixedHolding: h });
  } else if (choice === "send-chatting") {
    openKusdtSend({ startFrom: h, recipient: deps.account(), recipientName: "Chatting Address" });
  } else if (choice === "combine") {
    openCombineCoins(h);
  } else if (choice === "hide") {
    if (wallet.isListed(h)) wallet.toggleListed(h);
    renderManage();
    deps.showToast?.(`Address hidden. Re-enable it in ${SYMBOL} Address Visibility.`);
  }
}

// kUSDT Actions (iOS actionsSheet): Generate, Discover, Visibility. Discover belongs to the screen:
// closing the sheet doesn't stop it.
let discovering = null; // { checking, found, account }
async function openActionsSheet() {
  const progressHtml = () => (discovering ? `<div class="kusdt-discover-progress" data-kusdt-discover-progress>
      ${spinnerLine(`Checking address #${discovering.checking}`)}
      <p class="field-hint">${esc(discovering.found ? `${discovering.found} found so far` : `No addresses with ${SYMBOL} yet`)}</p>
    </div>` : "");
  const pick = await openChoiceSheet({
    title: `${SYMBOL} Actions`,
    extraHtml: '<div data-kusdt-discover-slot></div>',
    rows: [
      { id: "generate", iconHtml: iconHtml("plusSquares"), title: "Generate New Address", subtitle: "Adds a brand-new regular address of yours to this list.", chevron: false },
      { id: "discover", iconHtml: iconHtml("magnifier"), title: "Discover kUSDT Addresses", subtitle: "Finds your addresses holding kUSDT.", disabled: Boolean(discovering), chevron: false },
      { id: "visibility", iconHtml: iconHtml("checklist"), title: "kUSDT Address Visibility", subtitle: "Check off which addresses holding kUSDT are on the list.", chevron: false },
    ],
    onMount: (host) => {
      const slot = host.querySelector("[data-kusdt-discover-slot]");
      slot.innerHTML = progressHtml();
      if (discovering) host.querySelector(".kusdt-sheet-cancel").textContent = "Close and Keep Scanning";
      actionsSheetPaint = () => {
        if (host.hidden) { actionsSheetPaint = null; return; }
        slot.innerHTML = progressHtml();
        const discoverRow = host.querySelector('[data-kusdt-sheet-pick="discover"]');
        if (discoverRow) discoverRow.disabled = Boolean(discovering);
        host.querySelector(".kusdt-sheet-cancel").textContent = discovering ? "Close and Keep Scanning" : "Cancel";
      };
    },
  });
  actionsSheetPaint = null;
  if (pick === "generate") {
    const number = await wallet.generateFresh();
    if (number != null) deps.showToast?.(`Address #${number} is ready.`);
    renderManage();
  } else if (pick === "discover") {
    runDiscover();
    openActionsSheet();
  } else if (pick === "visibility") {
    openVisibility();
  }
}
async function runDiscover() {
  if (discovering) return;
  const owner = deps.account();
  discovering = { checking: 0, found: 0, account: owner };
  actionsSheetPaint?.();
  let found = null;
  try {
    found = await wallet.discover((checking, soFar) => {
      if (!discovering) return;
      discovering.checking = checking;
      discovering.found = soFar;
      actionsSheetPaint?.();
    });
  } finally {
    discovering = null;
    actionsSheetPaint?.();
  }
  if (deps.account() !== owner || found == null) return;
  const summary = found === 0 ? `No addresses with ${SYMBOL} found.` : `Found ${found} addresses with ${SYMBOL}.`;
  deps.showToast?.(summary);
  const footer = sheetHost && !sheetHost.hidden ? sheetHost.querySelector("[data-kusdt-sheet-footer]") : null;
  if (footer) { footer.textContent = summary; footer.hidden = false; }
}

// MARK: §7 Address Visibility

let visEl = null;
let visPage = 0;
let visToken = 0;
function mountVisibility() {
  if (visEl) return visEl;
  visEl = overlay("manage-address-screen spending-visibility-screen kusdt-visibility-screen", "kUSDT Address Visibility", `
    <div class="manage-address-card">
      <header class="chatting-address-header">
        <button class="chatting-address-back spending-visibility-done spending-visibility-hide-all" type="button" data-kusdt-vis-hide-all>Hide All</button>
        <span class="chatting-address-balance">${esc(SYMBOL)} Address Visibility</span>
        <button class="chatting-address-back spending-visibility-done" type="button" data-kusdt-vis-done>Done</button>
      </header>
      <div class="manage-address-body"><div class="manage-address-list spending-visibility-list" data-kusdt-vis-list></div></div>
      <div class="manage-address-actions spending-visibility-pager">
        <button type="button" class="spending-visibility-page-btn" data-kusdt-vis-prev aria-label="Previous page">${KUSDT_ICONS.chevronLeft}</button>
        <span class="spending-visibility-range" data-kusdt-vis-range>#0 - #50</span>
        <button type="button" class="spending-visibility-page-btn" data-kusdt-vis-next aria-label="Next page">${KUSDT_ICONS.chevronRight}</button>
      </div>
    </div>`);
  visEl.querySelector("[data-kusdt-vis-done]").addEventListener("click", () => { visEl.hidden = true; renderManage(); });
  visEl.querySelector("[data-kusdt-vis-prev]").addEventListener("click", () => { if (visPage > 0) { visPage -= 1; renderVisibility(); } });
  visEl.querySelector("[data-kusdt-vis-next]").addEventListener("click", () => { visPage += 1; renderVisibility(); });
  visEl.querySelector("[data-kusdt-vis-hide-all]").addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Hide All Addresses?",
      message: `Manage ${SYMBOL} starts over with only your Chatting Address. Nothing is lost: bring any address back here, and its ${SYMBOL} still counts in your total.`,
      confirmLabel: "Hide All",
      destructive: true,
    });
    if (!ok) return;
    wallet.hideAll();
    renderVisibility();
  });
  visEl.querySelector("[data-kusdt-vis-list]").addEventListener("click", (event) => {
    const row = event.target.closest("[data-kusdt-vis-row]");
    if (!row) return;
    const index = Number(row.dataset.kusdtVisRow);
    const held = (wallet.heldHoldings() || []).find((h) => h.spendingIndex === index);
    wallet.toggleListed(held || makeHolding(index, row.dataset.kusdtVisAddress || "", 0n, 0));
    renderVisibility();
  });
  return visEl;
}
function amountTagHtml(units) {
  return units > 0n
    ? `<span class="spending-address-usage spending-visibility-usage used kusdt-vis-amount">${esc(formatKusdt(units))}</span>`
    : '<span class="spending-address-usage spending-visibility-usage">Unused</span>';
}
const checkSvg = (on) => (on
  ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path class="spending-vis-check" d="m7.5 12.5 3 3 6-6.5"/></svg>'
  : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.2"/></svg>');
async function renderVisibility() {
  if (!visEl || visEl.hidden) return;
  const token = ++visToken;
  const owner = deps.account();
  const start = visPage * KUSDT_VISIBILITY_PAGE;
  const end = start + KUSDT_VISIBILITY_PAGE;
  visEl.querySelector("[data-kusdt-vis-range]").textContent = `#${visPage === 0 ? 0 : addressNumber(start)} - #${addressNumber(end - 1)}`;
  visEl.querySelector("[data-kusdt-vis-prev]").disabled = visPage === 0;
  const list = visEl.querySelector("[data-kusdt-vis-list]");
  const held = new Map((wallet.heldHoldings() || []).filter((h) => h.spendingIndex != null).map((h) => [h.spendingIndex, h]));
  let derived = new Map();
  try { derived = await deps.spendingAddressesInRange?.(start, end) || new Map(); } catch { derived = new Map(); }
  if (token !== visToken || deps.account() !== owner) return;
  const rows = [];
  for (let i = start; i < end; i += 1) {
    const h = held.get(i) || (derived.get(i) ? makeHolding(i, derived.get(i), 0n, 0) : null);
    if (h) rows.push(h);
  }
  const chatting = (wallet.heldHoldings() || []).find((h) => h.spendingIndex == null);
  const chattingRow = visPage === 0 && owner ? `
    <div class="spending-visibility-row spending-visibility-row-fixed">
      <span class="spending-visibility-toggle on locked" aria-hidden="true">${checkSvg(true)}</span>
      <div class="spending-visibility-info">
        <div class="spending-visibility-head"><span class="spending-address-index">#0</span><span class="spending-visibility-label">Chatting Address</span>${amountTagHtml(chatting?.units ?? 0n)}</div>
        <span class="spending-address-value">${esc(visibilityShortAddress(owner))}</span>
      </div>
    </div>` : "";
  list.innerHTML = chattingRow + (rows.length ? rows.map((h) => {
    const on = wallet.isListed(h);
    return `<div class="spending-visibility-row${on ? "" : " off"}" data-kusdt-vis-row="${h.spendingIndex}" data-kusdt-vis-address="${esc(h.address)}" role="button" tabindex="0" aria-pressed="${on}">
      <span class="spending-visibility-toggle${on ? " on" : ""}" aria-hidden="true">${checkSvg(on)}</span>
      <div class="spending-visibility-info">
        <div class="spending-visibility-head"><span class="spending-address-index">#${addressNumber(h.spendingIndex)}</span>${amountTagHtml(h.units)}</div>
        <span class="spending-address-value">${esc(visibilityShortAddress(h.address))}</span>
      </div>
    </div>`;
  }).join("") : `<p class="spending-address-empty">${esc(KUSDT_TEXT.visibilityEmptyPage)}</p>`);
}
function openVisibility() {
  mountVisibility();
  visPage = 0;
  visEl.hidden = false;
  renderVisibility();
}

// MARK: §8 An address's page

let pageEl = null;
let pageHoldingId = null;
function mountAddressPage() {
  if (pageEl) return pageEl;
  pageEl = overlay("manage-address-screen spending-detail-screen kusdt-address-screen", "kUSDT Address", `
    <div class="manage-address-card">
      <header class="chatting-address-header">
        ${backButtonHtml("data-kusdt-page-close")}
        <span class="chatting-address-balance" data-kusdt-page-title></span>
        <div class="manage-address-toolbar"><button type="button" class="manage-address-icon-button" data-kusdt-page-options aria-label="Address Actions">${KUSDT_ICONS.ellipsis}</button></div>
      </header>
      <div class="spending-detail-balance kusdt-page-card" data-kusdt-page-card></div>
      <div class="manage-address-body">
        <p class="settings-group-label kusdt-history-title">${esc(SYMBOL)} History</p>
        <div class="manage-address-list kusdt-history" data-kusdt-page-history></div>
      </div>
      <div class="manage-address-actions">
        <button type="button" class="chatting-address-copy" data-kusdt-page-receive>${KUSDT_ICONS.qr}<span>Receive</span></button>
        <button type="button" class="chatting-address-copy manage-address-send-button" data-kusdt-page-send>${KUSDT_ICONS.send}<span>Send</span></button>
      </div>
    </div>`);
  pageEl.querySelector("[data-kusdt-page-close]").addEventListener("click", () => { pageEl.hidden = true; });
  pageEl.querySelector("[data-kusdt-page-receive]").addEventListener("click", () => {
    const h = wallet.holdingById(pageHoldingId);
    if (h) openKusdtReceive({ fixedHolding: h });
  });
  pageEl.querySelector("[data-kusdt-page-send]").addEventListener("click", () => {
    const h = wallet.holdingById(pageHoldingId);
    if (h && h.units > 0n) openKusdtSend({ startFrom: h });
  });
  pageEl.querySelector("[data-kusdt-page-options]").addEventListener("click", async () => {
    const h = wallet.holdingById(pageHoldingId);
    if (!h) return;
    const choice = await chooseDialog({
      title: "Address Actions",
      options: [
        h.coinCount > 1 ? { id: "combine", title: "Combine Coins", subtitle: "Merges its coins into one and gives the extra KAS back." } : null,
        { id: "explorer", title: "View in Explorer", subtitle: "This address on the Kaspa explorer." },
      ],
    });
    if (choice === "combine") openCombineCoins(h);
    else if (choice === "explorer") openExternal(deps.explorerAddressUrl(h.address));
  });
  pageEl.querySelector("[data-kusdt-page-history]").addEventListener("click", (event) => {
    const row = event.target.closest("[data-kusdt-tx]");
    if (row) openExternal(deps.explorerTxUrl(row.dataset.kusdtTx));
  });
  return pageEl;
}
function activityRowHtml(row) {
  const txid = /^[0-9a-f]{64}$/i.test(String(row.id).split(":")[0]) ? String(row.id).split(":")[0].toLowerCase() : null;
  const isIn = row.kind === "received" || row.kind === "bridged" || (row.kind === "swapped" && row.outgoing !== true);
  const sign = row.kind === "combined" ? "" : (isIn ? "+" : "-");
  const tone = row.kind === "combined" ? "accent" : (isIn ? "in" : "out");
  const title = { received: "Received", sent: "Sent", swapped: "Swapped", bridged: "Bridged In", combined: "Combined Coins" }[row.kind] || row.kind;
  const icon = row.kind === "combined" ? KUSDT_ICONS.merge : (isIn ? KUSDT_ICONS.arrowDown : KUSDT_ICONS.arrowUp);
  const tag = txid ? "button" : "div";
  return `<${tag} ${tag === "button" ? 'type="button" ' : ""}class="kusdt-activity-row" data-tone="${tone}"${txid ? ` data-kusdt-tx="${txid}"` : ""}>
    <span class="kusdt-activity-icon">${icon}</span>
    <span class="kusdt-activity-copy">
      <span class="kusdt-activity-title">${esc(title)}${row.pending ? '<span class="kusdt-pending">Pending</span>' : ""}</span>
      <code>${esc(middle(txid || row.counterparty, 10))}</code>
      <small>${esc(dateText(row.date))}</small>
    </span>
    <span class="kusdt-activity-side">
      <strong>${esc(`${sign}${formatKusdt(row.units)}`)}</strong>
      ${row.fee != null ? `<small>${esc(`Fee ${kusdtFeeText(row.fee, deps.kasUnit)}`)}</small>` : ""}
      ${txid ? `<span class="kusdt-activity-open">${KUSDT_ICONS.openExternal}</span>` : ""}
    </span>
  </${tag}>`;
}
function renderAddressPage() {
  if (!pageEl || pageEl.hidden) return;
  const h = wallet.holdingById(pageHoldingId);
  if (!h) { pageEl.hidden = true; return; }
  pageEl.querySelector("[data-kusdt-page-title]").textContent = holdingLabel(h);
  pageEl.querySelector("[data-kusdt-page-card]").innerHTML = `
    <span class="spending-detail-balance-label">${esc(holdingLabel(h))}</span>
    <span class="spending-detail-balance-value">${esc(formatKusdt(h.units))}</span>
    <small class="kusdt-page-kas">${esc(`${kas(BigInt(h.coinCount) * KAS_PER_COIN)} held with it`)}</small>`;
  const rows = wallet.activity(h);
  pageEl.querySelector("[data-kusdt-page-history]").innerHTML = rows.length
    ? rows.map(activityRowHtml).join("")
    : `<div class="no-results-card"><strong>${esc(KUSDT_TEXT.historyEmpty)}</strong><span>${esc(KUSDT_TEXT.historyEmptyNote)}</span></div>`;
  pageEl.querySelector("[data-kusdt-page-send]").disabled = !(h.units > 0n);
}
export function openAddressPage(id) {
  mountAddressPage();
  pageHoldingId = id;
  pageEl.hidden = false;
  renderAddressPage();
}

// MARK: §9 About kUSDT

export function openAboutKusdt() {
  infoSheet({
    title: `About ${SYMBOL}`,
    html: `<div class="kusdt-about">
      <p class="kusdt-about-head">${kusdtCoinIconHtml(34)}<strong>Bridged by ${esc(KUSDT_TOKEN.issuer)}</strong></p>
      <p>${esc(KUSDT_TEXT.aboutText)}</p>
      <p class="kusdt-status warn">${KUSDT_ICONS.warning}<span>${esc(KUSDT_TEXT.risk)}</span></p>
      <p>${esc(KUSDT_TEXT.aboutCoin)}</p>
      <p class="kusdt-about-links">
        <a class="sk-pill sk-pill-button" href="${esc(KUSDT_TOKEN.backingURL)}" target="_blank" rel="noopener noreferrer">${KUSDT_ICONS.sealCheck}<span>View the Vault</span></a>
        <a class="sk-pill sk-pill-button" href="${esc(KUSDT_TOKEN.issuerSite)}" target="_blank" rel="noopener noreferrer">${KUSDT_ICONS.safari}<span>${esc(KUSDT_TOKEN.issuer)}</span></a>
      </p>
    </div>`,
  });
}

// MARK: §10 Receive kUSDT

let receiveEl = null;
const R = { fixed: null, useFresh: true, fresh: null, address: "", owner: "" };
function mountReceive() {
  if (receiveEl) return receiveEl;
  receiveEl = overlay("kusdt-receive-screen", "Receive kUSDT", `
    <div class="chatting-address-card">
      <header class="chatting-address-header">
        <span class="chatting-address-header-spacer" aria-hidden="true"></span>
        <span class="chatting-address-balance kusdt-receive-title">${kusdtCoinIconHtml(34)}<span>Receive ${esc(SYMBOL)}</span></span>
        <button class="linklike-button chatting-address-done" type="button" data-kusdt-receive-done>Done</button>
      </header>
      <div class="chatting-address-body kusdt-receive-body">
        <div class="sk-pills kusdt-receive-pills" data-kusdt-receive-pills>
          ${selectablePillHtml({ attr: "kusdt-receive-kind", value: "fresh", title: "Fresh Address", selected: true })}
          ${selectablePillHtml({ attr: "kusdt-receive-kind", value: "chatting", title: "Chatting Address" })}
        </div>
        <p class="kusdt-receive-label" data-kusdt-receive-label hidden></p>
        <div class="chatting-address-qr-frame"><canvas width="512" height="512" data-kusdt-receive-qr></canvas></div>
        <p class="chatting-address-value" data-kusdt-receive-address></p>
        <p class="receive-privacy" data-kusdt-receive-privacy></p>
        <p class="qr-tap-hint">Tap anywhere to copy</p>
        <div class="receive-notes" data-kusdt-receive-notes></div>
      </div>
    </div>`);
  receiveEl.querySelector("[data-kusdt-receive-done]").addEventListener("click", () => { receiveEl.hidden = true; });
  receiveEl.querySelector(".kusdt-receive-body").addEventListener("click", async (event) => {
    const pill = event.target.closest("[data-kusdt-receive-kind]");
    if (pill) {
      R.useFresh = pill.dataset.kusdtReceiveKind === "fresh";
      paintReceive();
      return;
    }
    if (!R.address) return;
    try {
      await deps.copyText(R.address);
      deps.showToast?.(deps.addressCopiedToastText?.(R.address) || "Address copied");
    } catch { return; }
    // a fresh address handed out goes on the list from now on (iOS revealIfFresh)
    if (!R.fixed && R.useFresh && R.fresh && deps.account() === R.owner) {
      try { await deps.revealSpendingSlot?.(R.fresh.index, R.owner); } catch { /* shown on the next Discover */ }
    }
  });
  return receiveEl;
}
async function paintReceive() {
  const fixed = R.fixed;
  R.address = fixed ? fixed.address : (R.useFresh ? (R.fresh?.address || "") : R.owner);
  receiveEl.querySelector("[data-kusdt-receive-pills]").hidden = Boolean(fixed);
  setSelectedPill(receiveEl, "kusdt-receive-kind", R.useFresh ? "fresh" : "chatting");
  const label = receiveEl.querySelector("[data-kusdt-receive-label]");
  label.hidden = !fixed;
  label.textContent = fixed ? holdingLabel(fixed) : "";
  receiveEl.querySelector("[data-kusdt-receive-address]").textContent = R.address || "…";
  const screen = fixed ? (fixed.spendingIndex == null ? "kusdt-chatting" : "kusdt-spending") : (R.useFresh ? "kusdt-fresh" : "kusdt-chatting");
  const { privacyHtml, notesHtml } = receiveNotesHtml(screen);
  receiveEl.querySelector("[data-kusdt-receive-privacy]").innerHTML = privacyHtml;
  receiveEl.querySelector("[data-kusdt-receive-notes]").innerHTML = notesHtml;
  const canvas = receiveEl.querySelector("[data-kusdt-receive-qr]");
  canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  if (R.address) { try { await deps.drawQr?.(canvas, R.address); } catch { /* the address is still there to copy */ } }
}
/** Receive kUSDT (iOS TokenReceiveSheet): Fresh Address first, or the Chatting Address; from an
 *  address's page or row (`fixedHolding`) that address only. */
export function openKusdtReceive({ fixedHolding = null } = {}) {
  const owner = deps.account();
  if (!owner) return;
  mountReceive();
  Object.assign(R, { fixed: fixedHolding, useFresh: true, owner, fresh: fixedHolding ? null : wallet.freshReceive() });
  receiveEl.hidden = false;
  paintReceive();
}

// MARK: §12 The kUSDT Guide

let guideEl = null;
const GUIDE_CARDS = [
  { icon: "dollarCircle", title: "What It Is", detail: KUSDT_TEXT.aboutText },
  { icon: "wallet", title: "Where It Lives", detail: "Your Chatting Address and your regular addresses can hold kUSDT. Quantum-resistant addresses can't. Receive gives you a fresh regular address, so a payment isn't tied to your .kachat name." },
  { icon: "hexagons", title: "1.5 KAS in Every Coin", detail: KUSDT_TEXT.aboutCoin },
  { icon: "arrowUp", title: "Sending kUSDT", detail: "A send takes a little KAS from the same address for the network fee, plus 1.5 KAS for your change coin when you keep some kUSDT. If the address is short, Fund This Address tops it up from another of your addresses." },
  { icon: "merge", title: "Combine Coins", detail: "Each payment you receive is its own coin with its own 1.5 KAS. Combine Coins, in an address's menu, merges them into one and gives the extra KAS back." },
  // Desktop rewrite (owner, 2026-11-20): Trestly's own site, in a new tab, not inside the app.
  { icon: "swap", title: "Swapping", detail: "To swap KAS and kUSDT, or add to the pool, click Swap Stablecoins on the Wallet tab and choose kUSDT. Trestly's own site opens in a new tab: connect a wallet there, then send what you swapped to one of your addresses here." },
  { icon: "clock", title: "History", detail: "kUSDT history is kept on this computer: sends, combines and payments received from now on. What happened before, or in another app, isn't shown." },
  { icon: "warning", title: "The Risks", detail: KUSDT_TEXT.risk, tone: "warn" },
];
export function openKusdtGuide() {
  if (!guideEl) {
    guideEl = overlay("manage-address-screen help-screen kusdt-guide-screen", "kUSDT Guide", `
      <div class="manage-address-card">
        <header class="chatting-address-header">
          ${backButtonHtml("data-kusdt-guide-close")}
          <span class="chatting-address-balance">kUSDT Guide</span>
          <span class="chatting-address-header-spacer" aria-hidden="true"></span>
        </header>
        <div class="manage-address-body">
          <div class="kusdt-guide-head">${kusdtCoinIconHtml(52)}<span><strong>kUSDT</strong><small>A dollar stablecoin on Kaspa</small></span></div>
          ${GUIDE_CARDS.map((c) => `<div class="kusdt-guide-card"${c.tone ? ` data-tone="${c.tone}"` : ""}>
            <span class="kusdt-guide-icon">${iconHtml(c.icon)}</span>
            <span class="kusdt-guide-copy"><strong>${esc(c.title)}</strong><span>${esc(c.detail)}</span></span>
          </div>`).join("")}
        </div>
      </div>`);
    guideEl.querySelector("[data-kusdt-guide-close]").addEventListener("click", () => { guideEl.hidden = true; });
  }
  guideEl.hidden = false;
}

// MARK: - Init

/** Wires the screens. `deps` (from app.js):
 *  wallet (ui/kusdt-wallet.js), engine, network, kasUnit, account(), showToast, copyText,
 *  addressCopiedToastText, explorerTxUrl, explorerAddressUrl, addressCardHtml(address, opts),
 *  addressBookName(address), makeRecipientController(els, hooks), pickFromAddressBook(),
 *  drawQr(canvas, address), secretKeyFor(holding), makeFundingRequest({ address, amountSompi, memo }),
 *  openSendKaspa({ paymentRequest, onClosed }), openManageAddresses(), kaspaTotalSompi(),
 *  spendingAddressesInRange(start, end), revealSpendingSlot(index, owner), customLabel(index),
 *  renameSpending(index, label), usedSpendingIndices(), modalAnchor(), log(line). */
export function initKusdtScreens(dependencies) {
  deps = dependencies;
  wallet = deps.wallet;
  initWalletCards();
  wallet.subscribe(() => {
    renderKusdtWalletCard();
    renderManage();
    renderAddressPage();
    if (visEl && !visEl.hidden) renderVisibility();
  });
  // Escape closes the topmost kUSDT screen (the address screens' own rule), unless a sheet is up.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || topOverlayOpen()) return;
    for (const el of [receiveEl, guideEl, visEl, pageEl, manageEl]) {
      if (el && !el.hidden) { el.hidden = true; event.preventDefault(); return; }
    }
  });
  wallet.startPolling();
}

/** Another account came in (app.js activateWalletDataScope): every kUSDT screen of the old one
 *  closes, and a send or combine still building is dropped (a send already going out finishes on
 *  its own account and keeps its screen). */
export function closeKusdtForAccountSwitch() {
  for (const el of [receiveEl, guideEl, visEl, pageEl, manageEl]) if (el) el.hidden = true;
  if (sheetHost && !sheetHost.hidden) closeSheet(null);
  if (send && !send.swipe.sending) closeSend();
  if (combine && !combine.swipe.sending) closeCombine();
  renderKusdtWalletCard();
}

/** The holding id of a regular spending index (for app.js's callers). */
export { holdingIdFor };
