// KaChat Web Push: what a push payload becomes on screen. Loaded by public/sw.js with
// importScripts (a classic script, so it defines one global, KaChatPushMap) and by
// tools/test-web-push.mjs in a sandbox. No I/O here: the worker reads the mirror from IndexedDB
// and hands it in.
//
// The payload is the JSON object docs/WEB_PUSH_SERVER.md §5 defines: the push service's FCM data
// map (string values), never message text - 1:1 and group messages are end-to-end encrypted and
// the keys stay in the app's locked vault, so the worker shows what iOS's notification extension
// falls back to when it cannot decrypt: who (from the app's mirrored address -> name map) and
// what kind ("New message", "Sent you 1.5 KAS").
//
// `mirror` (written by ui/web-push.js, names and flags only):
//   { account, unit, sound, childMode, names: {addr: name}, quiet: [addr], blocked: [addr],
//     groups: {blindedIdHex: {g: groupId, n: groupName, m: memberAddress}}, addressLabels: {addr: label} }
(function (root) {
  "use strict";

  function lower(value) { return String(value || "").trim().toLowerCase(); }
  function shortAddress(address) {
    const text = String(address || "");
    const colon = text.indexOf(":");
    const body = colon >= 0 ? text.slice(colon + 1) : text;
    if (body.length <= 14) return text;
    return `${text.slice(0, colon + 1)}${body.slice(0, 6)}...${body.slice(-6)}`;
  }
  function prefixOf(address) { const text = lower(address); const colon = text.indexOf(":"); return colon > 0 ? text.slice(0, colon) : ""; }
  // "1.5" from sompi, trailing zeros trimmed (iOS NotificationService.handlePayment).
  function kasFromSompi(value) {
    let sompi;
    try { sompi = BigInt(String(value || "0").trim()); } catch { return null; }
    if (sompi <= 0n) return null;
    const whole = sompi / 100000000n;
    const fraction = (sompi % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : String(whole);
  }
  function nameFor(mirror, address) {
    const names = (mirror && mirror.names) || {};
    return String(names[lower(address)] || "").trim() || shortAddress(address);
  }
  function has(list, address) { return Array.isArray(list) && list.indexOf(lower(address)) >= 0; }
  // A public room's or K body can be a JSON envelope (a reply, a reaction): the text inside, never
  // raw JSON on a lock screen (iOS publicChatPreviewText).
  function tidy(text, fallback) {
    const raw = String(text || "").trim();
    if (!raw) return fallback;
    if (raw[0] === "{") {
      try {
        const parsed = JSON.parse(raw);
        const inner = parsed && (parsed.text || parsed.message || parsed.content || parsed.body);
        return typeof inner === "string" && inner.trim() ? inner.trim().slice(0, 240) : fallback;
      } catch { return fallback; }
    }
    if (raw.length > 200 && !/\s/.test(raw)) return fallback; // base64 / hex blob
    return raw.slice(0, 240);
  }
  // A room push's body is the raw on-chain message (KaChat iOS 148a5331 publicChatPreviewText): the
  // content after the kchat:1:bcast:<channel>: prefix, a lone base64 run decoded, and an envelope
  // read for what it is - a reaction, a chess move, a reply's own text, a voice note, a photo, a
  // video, an edit - never raw JSON.
  function looseJsonString(name, json) {
    const start = new RegExp(`"${name}"\\s*:\\s*"`).exec(json);
    if (!start) return null;
    let out = "";
    let escaped = false;
    for (const ch of json.slice(start.index + start[0].length)) {
      if (escaped) { out += ch === "n" ? "\n" : ch === "t" ? "\t" : ch; escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') break;
      out += ch;
    }
    out = out.trim();
    return out || null;
  }
  function roomEnvelope(raw) {
    try { const parsed = JSON.parse(raw); return parsed && typeof parsed === "object" ? parsed : null; } catch { return null; }
  }
  function isRoomEdit(text) {
    const raw = String(text || "").trim();
    if (raw[0] !== "{") return false;
    const parsed = roomEnvelope(raw);
    if (parsed) return parsed.type === "edit" && Boolean(parsed.targetTxId);
    return raw.replace(/ /g, "").includes('"type":"edit"'); // a cut-off envelope still says what it is
  }
  function roomPreviewText(body) {
    let text = String(body || "").trim();
    for (const prefix of ["kchat:1:bcast:", "ciph_msg:1:bcast:"]) {
      if (!text.startsWith(prefix)) continue;
      const rest = text.slice(prefix.length);
      const colon = rest.indexOf(":");
      if (colon >= 0) text = rest.slice(colon + 1).trim();
    }
    if (text[0] !== "{" && text.length >= 16 && /^[A-Za-z0-9+/=_-]+$/.test(text)) {
      try {
        let b64 = text.replace(/-/g, "+").replace(/_/g, "/");
        while (b64.length % 4) b64 += "=";
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (decoded && !/[\u0000-\u0008\u000B-\u001F]/.test(decoded)) text = decoded.replace(/\u2060/g, "").trim();
      } catch { /* not base64 text: shown as it is */ }
    }
    if (text[0] !== "{") {
      // a long run that didn't decode to text is a blob (base64 / hex), never shown as it is
      if (!text || (text.length > 200 && !/\s/.test(text))) return "New message";
      return text.slice(0, 240);
    }
    const parsed = roomEnvelope(text);
    if (parsed) {
      if (parsed.type === "reaction" && typeof parsed.emoji === "string" && parsed.emoji) {
        return parsed.action === "remove" ? `Removed their ${parsed.emoji} reaction` : `Reacted ${parsed.emoji} to a message`;
      }
      if (typeof parsed.type === "string" && parsed.type.startsWith("chess")) return "Chess move";
      if (parsed.type === "reply" && typeof parsed.text === "string" && parsed.text.trim()) {
        const inner = parsed.text.trim();
        return inner[0] === "{" ? roomPreviewText(inner) : inner.slice(0, 240);
      }
    }
    const compact = text.replace(/ /g, "");
    if (compact.includes('"type":"reply"')) return looseJsonString("text", text) || "Replied to a message";
    if (compact.includes('"mimeType":"audio')) return "Voice message";
    if (compact.includes('"mimeType":"image')) return "Photo";
    if (compact.includes('"mimeType":"video')) return "Video";
    if (compact.includes('"type":"edit"')) return "Edited a message";
    return (looseJsonString("text", text) || "New message").slice(0, 240);
  }
  function joined(a, b, sep) { return a && b ? `${a}${sep}${b}` : (a || b || ""); }

  // A reply or quote push opens the reply or quote itself, the same target the in-app bell uses
  // (KaPosts-iPhone 093fe4d kaPostsPushOpensAction). post_id is the post it was made ON, and opening
  // that left you on your own post waiting for the indexer to list the reply. iOS reads the action's
  // txid from the APNs collapse id; here it is the payload's tx_id, the same value on the server.
  function kapostsPushTarget(p) {
    const action = lower(p.tx_id);
    const kind = String(p.kaposts_kind || "");
    const body = String(p.body || "").toLowerCase();
    const opensAction = kind
      ? kind === "reply" || kind === "quote"
      : body.indexOf("replied to your") >= 0 || body.indexOf("quoted your") >= 0;
    if (opensAction && /^[0-9a-f]{64}$/.test(action)) return action;
    // a post is a txid, or there is no post to open (KaPost b78fdb0)
    const post = lower(p.post_id);
    return /^[0-9a-f]{64}$/.test(post) ? post : "";
  }

  /**
   * payload -> { title, options, badge: "increment" | number | null, suppress }.
   * `suppress` = iOS would show nothing (your own message, a blocked sender, the other network):
   * the worker still has to show something (Safari revokes a subscription whose pushes show
   * nothing) and closes it straight away.
   */
  function notificationFromPush(payload, mirror, opts) {
    const p = payload && typeof payload === "object" ? payload : {};
    const m = mirror && typeof mirror === "object" ? mirror : {};
    const o = opts || {};
    const type = String(p.type || "");
    const unit = m.unit || "KAS";
    const account = lower(m.account);
    const sender = lower(p.sender);
    const soundOn = m.sound !== false;
    const unreadHint = Number.isFinite(Number(p.unread)) && String(p.unread).trim() !== "" ? Math.max(0, Math.floor(Number(p.unread))) : null;
    const out = {
      title: "K",
      options: { body: "", tag: "kachat-push", icon: o.icon || undefined, badge: o.badgeIcon || undefined, silent: !soundOn, renotify: false, data: { route: { kind: "tab", tab: "chats" }, key: String(p.tx_id || p.dedup || ""), push: true } },
      badge: null,
      suppress: false,
    };
    const otherNetwork = (address) => Boolean(account && address && prefixOf(address) && prefixOf(address) !== prefixOf(account));

    if (type === "contextual" || type === "payment" || type === "handshake" || type === "audio") {
      if (!sender || sender === account || otherNetwork(sender) || has(m.blocked, sender)) out.suppress = true;
      // A message from someone you haven't accepted: one "New message request" per sender (a tag
      // per sender, so a second message replaces rather than adds). Payments ring as payments.
      if (p.inbox === "true" && type !== "payment") {
        out.title = "New message request";
        out.options.body = `${shortAddress(p.sender)} wants to chat with you.`;
        out.options.tag = `kachat-request-${sender}`;
        // The sender rides along, so the tap opens their request (Accept / Reject), not just the list.
        out.options.data.route = { kind: "requests", address: sender };
        return out;
      }
      out.title = nameFor(m, p.sender);
      if (type === "payment") {
        const kas = kasFromSompi(p.amount);
        out.options.body = kas ? `Sent you ${kas} ${unit}` : "Sent you a payment";
      } else if (type === "handshake") out.options.body = "Started a conversation";
      else if (type === "audio") out.options.body = "Voice message";
      else out.options.body = "New message";
      out.options.tag = `kachat-chat-${sender}`;
      out.options.renotify = true;
      out.options.silent = !soundOn || has(m.quiet, sender);
      out.options.data.route = { kind: "chatAddress", address: sender };
      out.badge = out.suppress ? null : (unreadHint ?? "increment");
      return out;
    }

    if (type === "group_message" || type === "group_control") {
      const group = (m.groups || {})[lower(p.blinded_group_id)] || null;
      if (sender && (sender === account || otherNetwork(sender))) out.suppress = true;
      const control = type === "group_control";
      // A control message (members, keys, a rename) is the group's own bookkeeping: the worker can't
      // read it, so it never rings or counts (iOS 83806b3d lets only a readable invite ring, and
      // nothing here can read one).
      if (control) out.suppress = true;
      if (group) {
        out.title = String(group.n || "").trim() || "Group";
        const who = nameFor(m, group.m || p.sender);
        out.options.body = control ? "Group update" : `${who}: New message`;
        out.options.tag = `kachat-group-${group.g}`;
        out.options.data.route = { kind: "group", groupId: group.g };
      } else {
        // A blinded id the app hasn't mirrored (a group joined on another device): iOS's fallback.
        out.title = "Group chat";
        out.options.body = control ? "Group update" : "New group message";
        out.options.tag = "kachat-group";
        out.options.data.route = { kind: "tab", tab: "chats" };
      }
      out.options.renotify = !control;
      if (!control && !out.suppress) out.badge = unreadHint ?? "increment";
      return out;
    }

    if (type === "broadcast") {
      const channel = lower(p.channel);
      if (m.childMode) out.suppress = true;
      // only a joined room with its bell on rings (KaPost b78fdb0): one left or muted since the
      // push service last heard is silent
      if (Array.isArray(m.rooms) && !m.rooms.includes(channel)) out.suppress = true;
      // An edit changes an earlier message in place: nothing to announce (KaChat iOS 148a5331).
      if (isRoomEdit(p.body)) out.suppress = true;
      out.title = String(p.title || "").trim() || `#${channel}`;
      out.options.body = joined(String(p.subtitle || "").trim(), roomPreviewText(p.body), ": ");
      out.options.tag = `kachat-broadcast-${p.tx_id || channel}`;
      out.options.data.route = { kind: "room", channel };
      return out;
    }

    if (type === "kaposts") {
      if (m.childMode) out.suppress = true;
      // someone this account muted or blocked on KaPost never rings (KaPost 369794e)
      const actor = lower(p.actor_pubkey);
      if (actor && Array.isArray(m.kapostsHidden) && m.kapostsHidden.includes(actor.length === 66 ? actor.slice(2) : actor)) out.suppress = true;
      out.title = "KaPost";
      out.options.body = joined(String(p.subtitle || "").trim(), tidy(p.body, ""), " ") || "New activity";
      out.options.tag = `kachat-kaposts-${p.tx_id || p.post_id || "activity"}`;
      const target = kapostsPushTarget(p);
      out.options.data.route = target ? { kind: "kapost", txId: target } : { kind: "tab", tab: "kaposts" };
      return out;
    }

    if (type === "name_event") {
      out.title = String(p.title || "").trim() || ".kachat";
      out.options.body = String(p.body || "").trim();
      out.options.tag = `kachat-name-${String(p.dedup || p.tx_id || p.name || "event").slice(0, 64)}`;
      out.options.data.route = { kind: "tab", tab: "kachat-names", name: String(p.name || "") };
      return out;
    }

    if (type === "address_activity") {
      const address = String(p.address || "").trim();
      const kas = String(p.amount_kas || "").trim() || kasFromSompi(p.amount_sompi);
      out.title = kas ? `Received ${kas} ${unit}` : "Funds received";
      out.options.body = String(((m.addressLabels || {})[lower(address)]) || "").trim() || shortAddress(address);
      out.options.tag = `kachat-addr-activity-${p.tx_id || address}`;
      out.options.data.route = { kind: "address", address };
      return out;
    }

    // A type this build doesn't know yet: the server's own wording.
    out.title = String(p.title || "").trim() || "K";
    out.options.body = String(p.body || "").trim() || "Something new in K";
    out.options.tag = `kachat-push-${p.tx_id || type || "other"}`;
    return out;
  }

  /** The route a focused screen is showing, in the same terms a push's route uses, so the worker
   *  can tell "this is the chat you are looking at" (iOS willPresent's active-conversation rule). */
  function routeKey(route) {
    const r = route || {};
    if (r.kind === "chatAddress" && r.address) return `chat:${lower(r.address)}`;
    if (r.kind === "group" && r.groupId) return `group:${r.groupId}`;
    if (r.kind === "room" && r.channel) return `room:${lower(r.channel)}`;
    return "";
  }

  // iOS ca013fc8 part_push_bursts: a push the extension can't read joins its sender's burst (by
  // sender in 1:1, by blinded group id in a group), and one within 60 s of the last is delivered
  // quiet, as a later part of a long voice note or multi-part photo would be. This worker never
  // reads a message, so every chat and group message push is such a push. Payments, requests and
  // group updates always ring.
  const PART_BURST_MS = 60 * 1000;
  function partBurstKey(payload) {
    const p = payload && typeof payload === "object" ? payload : {};
    const type = String(p.type || "");
    if ((type === "contextual" || type === "audio") && String(p.inbox || "") !== "true" && lower(p.sender)) return `chat:${lower(p.sender)}`;
    if (type === "group_message" && lower(p.blinded_group_id)) return `group:${lower(p.blinded_group_id)}`;
    return null;
  }
  /** Makes `mapped` quiet when the burst's last push was under 60 s before `now`. */
  function applyPartBurst(mapped, lastAt, now) {
    const last = Number(lastAt);
    if (!mapped || !Number.isFinite(last) || now - last < 0 || now - last >= PART_BURST_MS) return mapped;
    mapped.options = { ...mapped.options, silent: true, renotify: false };
    mapped.badge = null;
    mapped.quietBurst = true;
    return mapped;
  }

  root.KaChatPushMap = { notificationFromPush, routeKey, shortAddress, kasFromSompi, partBurstKey, applyPartBurst, PART_BURST_MS };
})(typeof self !== "undefined" ? self : globalThis);
