// Amazon SES events and notifications, delivered by SNS (or EventBridge). SNS messages are signed by AWS:
// verify() checks the signature against Amazon's certificate, and handle() refuses anything unsigned or from a
// topic you didn't list, so nobody can suppress your recipients by posting fake bounces to your endpoint.
import { createVerify } from 'node:crypto';
import https from 'node:https';
import { toJSON, toMs, event, WebhookError } from './util.js';

const AWS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
const NOTIFICATION_FIELDS = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'];
const SUBSCRIPTION_FIELDS = ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
const certificates = new Map();

function awsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === 'https:' && AWS_HOST.test(url.hostname) && !url.port && !url.username ? url : null;
}

function get(url, { maxBytes = 65536, timeout = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GET ${url} answered ${res.statusCode}`));
        return;
      }
      let size = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) req.destroy(new Error('Response too large'));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`GET ${url} timed out`)));
    req.on('error', reject);
  });
}

/** True when an SNS message's signature is valid and was made with Amazon's certificate. */
export async function verify(body, { fetchCert = get } = {}) {
  const message = toJSON(body);
  if (!message || typeof message !== 'object') return false;
  const fields =
    message.Type === 'Notification'
      ? NOTIFICATION_FIELDS
      : message.Type === 'SubscriptionConfirmation' || message.Type === 'UnsubscribeConfirmation'
        ? SUBSCRIPTION_FIELDS
        : null;
  const algorithm = message.SignatureVersion === '2' ? 'RSA-SHA256' : message.SignatureVersion === '1' ? 'RSA-SHA1' : null;
  if (!fields || !algorithm || typeof message.Signature !== 'string') return false;
  const certUrl = awsUrl(message.SigningCertURL);
  if (!certUrl || !certUrl.pathname.endsWith('.pem')) return false;

  let certificate = certificates.get(certUrl.href);
  if (!certificate) {
    try {
      certificate = await fetchCert(certUrl.href);
    } catch {
      return false;
    }
    if (typeof certificate !== 'string' || !certificate.includes('-----BEGIN')) return false;
    if (certificates.size > 50) certificates.clear();
    certificates.set(certUrl.href, certificate);
  }

  const signed = fields
    .filter((field) => message[field] !== undefined && message[field] !== null)
    .map((field) => `${field}\n${message[field]}\n`)
    .join('');
  try {
    return createVerify(algorithm).update(signed, 'utf8').verify(certificate, message.Signature, 'base64');
  } catch {
    return false;
  }
}

/** Confirms an SNS subscription by visiting its SubscribeURL (only ever an Amazon address). */
export async function confirmSubscription(body, { fetchUrl = get } = {}) {
  const message = toJSON(body);
  const url = awsUrl(message?.SubscribeURL);
  if (!url) throw new WebhookError('BAD_SUBSCRIBE_URL', 'SubscribeURL is not an Amazon SNS address');
  await fetchUrl(url.href);
  return true;
}

function sesMessage(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.Type === 'Notification') return toJSON(data.Message);
  if (data['detail-type'] && data.detail) return data.detail; // EventBridge
  return data;
}

/** SES event (or SNS envelope, or EventBridge event) -> normalised events, one per recipient. */
export function parse(body) {
  const message = sesMessage(toJSON(body));
  if (!message || typeof message !== 'object') return [];
  const kind = String(message.eventType ?? message.notificationType ?? '').toLowerCase();
  const mail = message.mail ?? {};
  const messageId = mail.messageId ?? null;
  const destinations = Array.isArray(mail.destination) ? mail.destination : [];
  const at = (value) => toMs(value ?? mail.timestamp);

  switch (kind) {
    case 'bounce': {
      const bounce = message.bounce ?? {};
      const permanent = bounce.bounceType === 'Permanent';
      // OnAccountSuppressionList: SES didn't even try, and it doesn't count toward your bounce rate.
      const suppressed = permanent && bounce.bounceSubType === 'OnAccountSuppressionList';
      return (bounce.bouncedRecipients ?? []).map((r) =>
        event('ses', suppressed ? 'suppressed' : 'bounce', r.emailAddress, {
          bounce: suppressed ? null : permanent ? 'hard' : 'soft',
          diagnostic: r.diagnosticCode ?? `${bounce.bounceType}/${bounce.bounceSubType}`,
          messageId,
          timestamp: at(bounce.timestamp),
        }),
      );
    }
    case 'complaint': {
      const complaint = message.complaint ?? {};
      const suppressed = complaint.complaintSubType === 'OnAccountSuppressionList';
      return (complaint.complainedRecipients ?? []).map((r) =>
        event('ses', suppressed ? 'suppressed' : 'complaint', r.emailAddress, {
          diagnostic: complaint.complaintFeedbackType ?? null,
          messageId,
          timestamp: at(complaint.timestamp),
        }),
      );
    }
    case 'delivery': {
      const delivery = message.delivery ?? {};
      return (delivery.recipients ?? destinations).map((email) =>
        event('ses', 'delivered', email, { diagnostic: delivery.smtpResponse ?? null, messageId, timestamp: at(delivery.timestamp) }),
      );
    }
    case 'deliverydelay': {
      const delay = message.deliveryDelay ?? {};
      return (delay.delayedRecipients ?? []).map((r) =>
        event('ses', 'deferred', r.emailAddress, { diagnostic: r.diagnosticCode ?? delay.delayType ?? null, messageId, timestamp: at(delay.timestamp) }),
      );
    }
    case 'send':
      return destinations.map((email) => event('ses', 'sent', email, { messageId, timestamp: at() }));
    case 'open':
      return destinations.map((email) => event('ses', 'open', email, { messageId, timestamp: at(message.open?.timestamp) }));
    case 'click':
      return destinations.map((email) => event('ses', 'click', email, { messageId, timestamp: at(message.click?.timestamp) }));
    case 'subscription': {
      const unsubscribed = message.subscription?.newTopicPreferences?.unsubscribeAll === true;
      return unsubscribed ? destinations.map((email) => event('ses', 'unsubscribe', email, { messageId, timestamp: at(message.subscription?.timestamp) })) : [];
    }
    default:
      return [];
  }
}

/**
 * Everything an SNS endpoint needs: checks the signature (and topic, if you list yours), confirms
 * subscriptions, and returns the events. Throws a WebhookError for anything that should get a 4xx.
 */
export async function handle(body, { verify: shouldVerify = true, topics = null, confirm = true, fetchCert, fetchUrl } = {}) {
  const data = toJSON(body);
  if (!data || typeof data !== 'object') throw new WebhookError('BAD_BODY', 'The body is not JSON');
  if (shouldVerify) {
    if (!data.Type) throw new WebhookError('UNVERIFIABLE', 'Not an SNS message, so it cannot be verified (pass verify: false for EventBridge)');
    if (!(await verify(data, { fetchCert }))) throw new WebhookError('BAD_SIGNATURE', 'The SNS signature is not valid');
  }
  if (topics && data.TopicArn && !topics.includes(data.TopicArn)) {
    throw new WebhookError('UNKNOWN_TOPIC', `Topic ${data.TopicArn} is not one of yours`);
  }
  if (data.Type === 'SubscriptionConfirmation') {
    if (confirm) await confirmSubscription(data, { fetchUrl });
    return { events: [], subscribed: Boolean(confirm) };
  }
  if (data.Type === 'UnsubscribeConfirmation') return { events: [], subscribed: false };
  return { events: parse(data), subscribed: false };
}
