// Moderation for KaPost and Public Chats (KaPosts-iPhone 9e22075, App Store guideline 1.2): the
// report that goes to support, the block that also takes an account out of every room, and the
// Terms of Use. No imports and no DOM on load, so tools/test-kapost-moderation.mjs can run it; the
// Terms' screen builds its own elements when asked, and its look is in ui/kapost-terms.css.

/** Where reports go, and the Terms' contact line (iOS ContentReport.supportEmail). */
export const SUPPORT_EMAIL = "kaspasilver@gmail.com";

// ---- reports (iOS ContentReport.swift) ---------------------------------------------------------

export function reportMailUrl(body) {
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("KaPost report")}&body=${encodeURIComponent(body)}`;
}

/** iOS KaPostCellView.reportPost. */
export function postReportBody(post) {
  return [
    "I want to report this post.",
    "",
    `Post: ${post.remoteId || "not yet on chain"}`,
    `Author: ${post.posterAddress}`,
    `Text: ${String(post.text || "").slice(0, 500)}`,
    "",
    "What is wrong with it:",
    "",
  ].join("\n");
}

/** iOS PublicChatChannelView.reportMessage: the message's id, room, sender and text. */
export function roomMessageReportBody({ channel, txId, senderAddress, text }) {
  return [
    "I want to report this public chat message.",
    "",
    `Room: #${channel}`,
    `Message: ${txId}`,
    `Sender: ${senderAddress}`,
    `Text: ${String(text || "").slice(0, 500)}`,
    "",
    "What is wrong with it:",
    "",
  ].join("\n");
}

function openMailUrl(url) {
  const link = document.createElement("a");
  link.href = url;
  link.click();
}

/**
 * Sends a report (iOS ContentReport.send + contentReportFallback). iOS asks the system whether a
 * mail account exists and only then falls back to copying. A browser can't tell whether anything
 * answers a mailto: link, so here every report does both: it is copied, the email opens if there is
 * something to open it, and the same alert says where to send it, with Open Email still on it for
 * another mail app. Copying and opening both start before the first await, while the click that
 * asked for them still counts.
 *
 * `confirm` is confirmDialog from ui/dialogs.js; `openUrl` is only replaced by the test.
 */
export async function sendContentReport(body, { copyText, confirm, openUrl = openMailUrl }) {
  const url = reportMailUrl(body);
  let copying;
  try { copying = Promise.resolve(copyText(body)); } catch (error) { copying = Promise.reject(error); }
  openUrl(url);
  let copied = true;
  try { await copying; } catch { copied = false; }
  const again = await confirm(copied
    ? {
      title: "Report Copied",
      message: `If no email opened, paste the report into an email to ${SUPPORT_EMAIL}.`,
      confirmLabel: "Open Email",
      cancelLabel: "OK",
    }
    : {
      title: "Report",
      message: `If no email opened, send this to ${SUPPORT_EMAIL}:\n\n${body}`,
      confirmLabel: "Open Email",
      cancelLabel: "OK",
    });
  if (again === true) openUrl(url);
  return copied;
}

// ---- blocking (iOS KaPostsModerationStore, PublicChatStore.blockedSenders) ---------------------

/** A block supersedes a mute: no need to track both (iOS KaPostsModerationStore.block). */
export function withBlockedAccount(prefs, address) {
  return {
    ...prefs,
    blocked: [...new Set([...prefs.blocked, address])],
    muted: prefs.muted.filter((entry) => entry !== address),
  };
}

/** Everyone whose messages a room leaves out: its own hides plus blocked accounts. */
export function roomHiddenSenders(roomHides, blocked) {
  return new Set([...(roomHides || []), ...(blocked || [])]);
}

// ---- Terms of Use (iOS TermsOfUseView.swift) ---------------------------------------------------

// The Terms of Use, to read in Settings. Nothing asks for them to be agreed on the website (owner,
// 2026-11-21): KaChat iOS shows them as its first screen because the App Store requires it.
export const KAPOST_TERMS_SECTIONS = [
  {
    title: "No objectionable content or abuse",
    text: "K has no tolerance for objectionable content or abusive users. You may not post anything that is illegal, sexual content involving children, hate speech, threats, harassment, content that encourages violence or self-harm, or scams. Accounts that do can be removed from what K shows, without notice.",
  },
  {
    title: "Your posts are public and permanent",
    text: "Posts, replies, likes and room messages are public transactions on the Kaspa network. You are responsible for what you post. Deleting a post removes it from K, but nobody can erase a transaction from the network.",
  },
  {
    title: "Reporting and blocking",
    text: "Use Report on a post or room message to tell us about objectionable content; a person reads every report. Use Block to stop seeing an account's posts and room messages. We can remove content and accounts from the K indexer, which K reads by default.",
  },
  {
    title: "Your account and your funds",
    text: "Your account is 12 or 24 words kept on your device. We never have them, so we can't recover lost ones or reverse a transaction. Posting pays a network fee in KAS, and you are responsible for the funds you hold and send.",
  },
  {
    title: "No warranty",
    text: "K is provided as it is, without warranty, and to the extent the law allows we are not liable for losses from using it or from what other users post. These terms are between you and K's developer.",
  },
  {
    title: "Contact",
    text: `Questions and reports: ${SUPPORT_EMAIL}`,
  },
];

/** The terms' text, as Settings shows it (iOS KaPostTermsText). No text
 *  here comes from outside this file, so it needs no escaping beyond the apostrophes HTML allows. */
export function kaPostTermsHtml() {
  return `<div class="kapost-terms-text">${KAPOST_TERMS_SECTIONS.map((section) => `
    <section>
      <h3>${section.title}</h3>
      <p>${section.text}</p>
    </section>`).join("")}</div>`;
}
