// SendGrid, Mailgun, Postmark, Resend and ZeptoMail webhooks -> the same normalised events.
// Each parse() takes the body (string, Buffer or parsed object); each verify() needs the raw body bytes.
import { createHmac, verify as verifySignature } from 'node:crypto';
import { toJSON, toText, toBuffer, header, toMs, safeEqual, event } from './util.js';

// ---- SendGrid Event Webhook ----------------------------------------------------------------------------

export const sendgrid = {
  parse(body) {
    const data = toJSON(body);
    const list = Array.isArray(data) ? data : data ? [data] : [];
    const events = [];
    for (const e of list) {
      const extra = { messageId: e.sg_message_id ?? null, diagnostic: e.reason ?? e.response ?? null, timestamp: toMs(e.timestamp) };
      switch (e.event) {
        case 'processed':
          events.push(event('sendgrid', 'sent', e.email, extra));
          break;
        case 'delivered':
          events.push(event('sendgrid', 'delivered', e.email, extra));
          break;
        case 'bounce':
          // type "blocked" is a temporary refusal (often aimed at the sending IP), "bounce" a permanent one.
          events.push(event('sendgrid', 'bounce', e.email, { ...extra, bounce: e.type === 'blocked' ? 'soft' : 'hard' }));
          break;
        case 'dropped':
          events.push(event('sendgrid', 'suppressed', e.email, extra));
          break;
        case 'deferred':
          events.push(event('sendgrid', 'deferred', e.email, extra));
          break;
        case 'spamreport':
          events.push(event('sendgrid', 'complaint', e.email, extra));
          break;
        case 'unsubscribe':
        case 'group_unsubscribe':
          events.push(event('sendgrid', 'unsubscribe', e.email, extra));
          break;
        case 'open':
        case 'click':
          events.push(event('sendgrid', e.event, e.email, extra));
          break;
        default:
          break;
      }
    }
    return events;
  },

  /** Signed Event Webhook: ECDSA over timestamp + raw body, with the public key from SendGrid's settings. */
  verify(rawBody, headers, publicKey) {
    const signature = header(headers, 'x-twilio-email-event-webhook-signature');
    const timestamp = header(headers, 'x-twilio-email-event-webhook-timestamp');
    if (!signature || !timestamp || !publicKey) return false;
    const key = publicKey.includes('BEGIN PUBLIC KEY')
      ? publicKey
      : `-----BEGIN PUBLIC KEY-----\n${publicKey.replace(/\s+/g, '').match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n`;
    try {
      return verifySignature('sha256', Buffer.concat([Buffer.from(timestamp, 'utf8'), toBuffer(rawBody)]), key, Buffer.from(signature, 'base64'));
    } catch {
      return false;
    }
  },
};

// ---- Mailgun webhooks ----------------------------------------------------------------------------------

export const mailgun = {
  parse(body) {
    const data = toJSON(body);
    const e = data?.['event-data'];
    if (!e) return [];
    const status = e['delivery-status'] ?? {};
    const extra = {
      messageId: e.message?.headers?.['message-id'] ?? null,
      diagnostic: status.message || status.description || e.reason || null,
      timestamp: toMs(e.timestamp),
    };
    switch (e.event) {
      case 'accepted':
        return [event('mailgun', 'sent', e.recipient, extra)];
      case 'delivered':
        return [event('mailgun', 'delivered', e.recipient, extra)];
      case 'failed':
        // Temporary failures are retried by Mailgun, so they are delays, not bounces.
        if (e.severity !== 'permanent') return [event('mailgun', 'deferred', e.recipient, extra)];
        if (/^suppress-/.test(e.reason ?? '')) return [event('mailgun', 'suppressed', e.recipient, extra)];
        // "old": Mailgun gave up after retrying for hours, which is a soft bounce in the end.
        return [event('mailgun', 'bounce', e.recipient, { ...extra, bounce: e.reason === 'old' ? 'soft' : 'hard' })];
      case 'complained':
        return [event('mailgun', 'complaint', e.recipient, extra)];
      case 'unsubscribed':
        return [event('mailgun', 'unsubscribe', e.recipient, extra)];
      case 'opened':
        return [event('mailgun', 'open', e.recipient, extra)];
      case 'clicked':
        return [event('mailgun', 'click', e.recipient, extra)];
      default:
        return [];
    }
  },

  /** HMAC-SHA256 of timestamp + token with your webhook signing key. */
  verify(body, signingKey, { maxAgeSeconds = null, now = Date.now } = {}) {
    const signature = toJSON(body)?.signature;
    if (!signature?.timestamp || !signature?.token || !signature?.signature || !signingKey) return false;
    if (maxAgeSeconds && Math.abs(now() / 1000 - Number(signature.timestamp)) > maxAgeSeconds) return false;
    const expected = createHmac('sha256', signingKey).update(`${signature.timestamp}${signature.token}`).digest('hex');
    return safeEqual(expected, signature.signature);
  },
};

// ---- Postmark webhooks ---------------------------------------------------------------------------------

const POSTMARK_HARD = new Set(['HardBounce', 'BadEmailAddress', 'ManuallyDeactivated']);
const POSTMARK_SOFT = new Set(['SoftBounce', 'Transient', 'DnsError', 'Blocked']);

export const postmark = {
  parse(body) {
    const e = toJSON(body);
    if (!e?.RecordType) return [];
    const messageId = e.MessageID ?? null;
    switch (e.RecordType) {
      case 'Delivery':
        return [event('postmark', 'delivered', e.Recipient, { messageId, diagnostic: e.Details ?? null, timestamp: toMs(e.DeliveredAt) })];
      case 'Bounce': {
        const extra = { messageId, diagnostic: e.Details || e.Description || null, timestamp: toMs(e.BouncedAt) };
        if (POSTMARK_HARD.has(e.Type)) return [event('postmark', 'bounce', e.Email, { ...extra, bounce: 'hard' })];
        if (POSTMARK_SOFT.has(e.Type)) return [event('postmark', 'bounce', e.Email, { ...extra, bounce: 'soft' })];
        if (e.Type === 'SpamComplaint') return [event('postmark', 'complaint', e.Email, extra)];
        if (e.Type === 'Unsubscribe') return [event('postmark', 'unsubscribe', e.Email, extra)];
        return [event('postmark', 'other', e.Email, extra)]; // auto-replies, challenges, DMARC reports...
      }
      case 'SpamComplaint':
        return [event('postmark', 'complaint', e.Email, { messageId, timestamp: toMs(e.BouncedAt) })];
      case 'SubscriptionChange':
        if (!e.SuppressSending) return [];
        return [
          event('postmark', e.SuppressionReason === 'ManualSuppression' ? 'unsubscribe' : 'suppressed', e.Recipient, {
            messageId,
            diagnostic: e.SuppressionReason ?? null,
            timestamp: toMs(e.ChangedAt),
          }),
        ];
      case 'Open':
        return [event('postmark', 'open', e.Recipient, { messageId, timestamp: toMs(e.ReceivedAt) })];
      case 'Click':
        return [event('postmark', 'click', e.Recipient, { messageId, timestamp: toMs(e.ReceivedAt) })];
      default:
        return [];
    }
  },
};

// ---- Resend webhooks (signed with Svix) ----------------------------------------------------------------

export const resend = {
  parse(body) {
    const e = toJSON(body);
    if (!e?.type || !e.data) return [];
    const to = Array.isArray(e.data.to) ? e.data.to : e.data.to ? [e.data.to] : [];
    const extra = { messageId: e.data.email_id ?? null, timestamp: toMs(e.created_at) };
    const each = (type, more = {}) => to.map((email) => event('resend', type, email, { ...extra, ...more }));
    switch (e.type) {
      case 'email.sent':
        return each('sent');
      case 'email.delivered':
        return each('delivered');
      case 'email.delivery_delayed':
        return each('deferred');
      case 'email.bounced': {
        const bounce = e.data.bounce ?? {};
        const soft = /^(transient|undetermined)$/i.test(bounce.type ?? '');
        return each('bounce', { bounce: soft ? 'soft' : 'hard', diagnostic: bounce.message ?? null });
      }
      case 'email.complained':
        return each('complaint');
      case 'email.opened':
        return each('open');
      case 'email.clicked':
        return each('click');
      default:
        return [];
    }
  },

  /** Svix signature: HMAC-SHA256 of "id.timestamp.body" with the whsec_ secret, within a 5 minute window. */
  verify(rawBody, headers, secret, { toleranceSeconds = 300, now = Date.now } = {}) {
    const id = header(headers, 'svix-id') ?? header(headers, 'webhook-id');
    const timestamp = header(headers, 'svix-timestamp') ?? header(headers, 'webhook-timestamp');
    const signatures = header(headers, 'svix-signature') ?? header(headers, 'webhook-signature');
    if (!id || !timestamp || !signatures || !secret) return false;
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds) || Math.abs(now() / 1000 - seconds) > toleranceSeconds) return false;
    const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
    const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${toText(rawBody)}`).digest('base64');
    return signatures.split(' ').some((part) => {
      const [version, signature] = part.split(',');
      return version === 'v1' && Boolean(signature) && safeEqual(signature, expected);
    });
  },
};

// ---- ZeptoMail webhooks --------------------------------------------------------------------------------

const ZEPTO = {
  sent: 'delivered',
  delivered: 'delivered',
  softbounce: 'bounce',
  hardbounce: 'bounce',
  open: 'open',
  email_open: 'open',
  click: 'click',
  email_link_click: 'click',
  fbl_complaint: 'complaint',
  fbl_compliant: 'complaint',
  unsubscribe: 'unsubscribe',
};

export const zeptomail = {
  parse(body) {
    const data = toJSON(body);
    const events = [];
    for (const message of data?.event_message ?? []) {
      const info = message.email_info ?? {};
      const fallback = info.to?.[0]?.email_address?.address ?? info.to?.[0]?.address ?? null;
      for (const item of message.event_data ?? []) {
        const name = String(item.object ?? '').toLowerCase();
        const type = ZEPTO[name];
        if (!type) continue;
        const details = item.details?.[0] ?? {};
        events.push(
          event('zeptomail', type, details.bounced_recipient ?? details.email_address ?? fallback, {
            bounce: name === 'hardbounce' ? 'hard' : name === 'softbounce' ? 'soft' : null,
            diagnostic: details.diagnostic_message ?? details.reason ?? null,
            messageId: info.email_reference ?? message.request_id ?? null,
            timestamp: toMs(details.time ?? info.processed_time),
          }),
        );
      }
    }
    return events;
  },
};
