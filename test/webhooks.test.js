import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { webhooks } from '../src/index.js';

const { ses, sendgrid, mailgun, postmark, resend, zeptomail } = webhooks;

// ---- SES via SNS -------------------------------------------------------------------------------------------

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = rsa.publicKey.export({ type: 'spki', format: 'pem' });
const CERT_URL = 'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc.pem';
const TOPIC = 'arn:aws:sns:eu-west-1:123456789012:ses-events';
const fetchCert = async (url) => {
  assert.equal(url, CERT_URL);
  return publicPem;
};

function snsEnvelope(message, { type = 'Notification', version = '1', extra = {} } = {}) {
  const envelope = {
    Type: type,
    MessageId: 'b7c7d4f4-0000-4000-8000-000000000001',
    TopicArn: TOPIC,
    Message: typeof message === 'string' ? message : JSON.stringify(message),
    Timestamp: '2026-11-06T10:00:00.000Z',
    SignatureVersion: version,
    SigningCertURL: CERT_URL,
    ...extra,
  };
  const fields = type === 'Notification' ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'] : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  const text = fields.filter((f) => envelope[f] !== undefined).map((f) => `${f}\n${envelope[f]}\n`).join('');
  envelope.Signature = createSign(version === '2' ? 'RSA-SHA256' : 'RSA-SHA1').update(text).sign(rsa.privateKey, 'base64');
  return envelope;
}

const bounceEvent = {
  eventType: 'Bounce',
  bounce: {
    bounceType: 'Permanent',
    bounceSubType: 'General',
    bouncedRecipients: [
      { emailAddress: 'jane@example.com', action: 'failed', status: '5.1.1', diagnosticCode: 'smtp; 550 5.1.1 user unknown' },
      { emailAddress: 'joe@example.com', action: 'failed', status: '5.1.1', diagnosticCode: 'smtp; 550 5.1.1 user unknown' },
    ],
    timestamp: '2026-11-06T10:00:00.000Z',
  },
  mail: { messageId: '0102018f-msg', destination: ['jane@example.com', 'joe@example.com'], timestamp: '2026-11-06T09:59:58.000Z' },
};

test('SES: a permanent bounce is a hard bounce per recipient', () => {
  const events = ses.parse(snsEnvelope(bounceEvent));
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    provider: 'ses',
    type: 'bounce',
    email: 'jane@example.com',
    bounce: 'hard',
    diagnostic: 'smtp; 550 5.1.1 user unknown',
    messageId: '0102018f-msg',
    timestamp: Date.parse('2026-11-06T10:00:00.000Z'),
  });
});

test('SES: transient and undetermined bounces are soft; account-suppressed ones are "suppressed"', () => {
  const transient = ses.parse({ ...bounceEvent, bounce: { ...bounceEvent.bounce, bounceType: 'Transient', bounceSubType: 'MailboxFull' } });
  assert.equal(transient[0].bounce, 'soft');
  const undetermined = ses.parse({ notificationType: 'Bounce', bounce: { ...bounceEvent.bounce, bounceType: 'Undetermined' }, mail: bounceEvent.mail });
  assert.equal(undetermined[0].bounce, 'soft');
  const suppressed = ses.parse({ ...bounceEvent, bounce: { ...bounceEvent.bounce, bounceSubType: 'OnAccountSuppressionList' } });
  assert.equal(suppressed[0].type, 'suppressed');
  assert.equal(suppressed[0].bounce, null);
});

test('SES: complaints, deliveries, delays, sends, opens, clicks and unsubscribes', () => {
  const mail = { messageId: 'm1', destination: ['a@example.com'] };
  assert.equal(ses.parse({ eventType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'a@example.com' }], complaintFeedbackType: 'abuse' }, mail })[0].type, 'complaint');
  assert.deepEqual(ses.parse({ eventType: 'Delivery', delivery: { recipients: ['a@example.com'], smtpResponse: '250 ok' }, mail }).map((e) => e.type), ['delivered']);
  assert.equal(ses.parse({ eventType: 'DeliveryDelay', deliveryDelay: { delayedRecipients: [{ emailAddress: 'a@example.com' }] }, mail })[0].type, 'deferred');
  assert.equal(ses.parse({ eventType: 'Send', mail })[0].type, 'sent');
  assert.equal(ses.parse({ eventType: 'Open', open: {}, mail })[0].type, 'open');
  assert.equal(ses.parse({ eventType: 'Click', click: {}, mail })[0].type, 'click');
  assert.equal(ses.parse({ eventType: 'Subscription', subscription: { newTopicPreferences: { unsubscribeAll: true } }, mail })[0].type, 'unsubscribe');
  assert.deepEqual(ses.parse({ eventType: 'Reject', mail }), []);
  assert.deepEqual(ses.parse('not json'), []);
});

test('SES: EventBridge events parse too', () => {
  const events = ses.parse({ 'detail-type': 'Email Bounced', source: 'aws.ses', detail: bounceEvent });
  assert.equal(events.length, 2);
});

test('SNS: valid signatures verify (versions 1 and 2), tampering does not', async () => {
  assert.equal(await ses.verify(snsEnvelope(bounceEvent), { fetchCert }), true);
  assert.equal(await ses.verify(JSON.stringify(snsEnvelope(bounceEvent, { version: '2' })), { fetchCert }), true);
  const withSubject = snsEnvelope(bounceEvent, { extra: { Subject: 'Amazon SES Email Event Notification' } });
  assert.equal(await ses.verify(withSubject, { fetchCert }), true);
  const tampered = snsEnvelope(bounceEvent);
  tampered.Message = tampered.Message.replace('jane@example.com', 'victim@example.com');
  assert.equal(await ses.verify(tampered, { fetchCert }), false);
});

test('SNS: certificates from anywhere but Amazon are refused without being fetched', async () => {
  let fetched = 0;
  const spy = async () => {
    fetched++;
    return publicPem;
  };
  for (const url of ['https://evil.example.com/cert.pem', 'http://sns.eu-west-1.amazonaws.com/cert.pem', 'https://sns.eu-west-1.amazonaws.com.evil.com/cert.pem', 'https://sns.eu-west-1.amazonaws.com/cert.txt', 'not a url']) {
    const envelope = snsEnvelope(bounceEvent, { extra: { SigningCertURL: url } });
    assert.equal(await ses.verify(envelope, { fetchCert: spy }), false, url);
  }
  assert.equal(fetched, 0);
  assert.equal(await ses.verify({ Type: 'Notification', SignatureVersion: '3' }, { fetchCert: spy }), false);
  assert.equal(await ses.verify('garbage', { fetchCert: spy }), false);
});

test('SNS handle(): verifies, checks the topic, confirms subscriptions and returns events', async () => {
  const { events } = await ses.handle(snsEnvelope(bounceEvent), { fetchCert, topics: [TOPIC] });
  assert.equal(events.length, 2);

  await assert.rejects(ses.handle(snsEnvelope(bounceEvent), { fetchCert, topics: ['arn:aws:sns:eu-west-1:999:other'] }), { code: 'UNKNOWN_TOPIC' });
  const forged = { ...snsEnvelope(bounceEvent), Signature: Buffer.from('forged').toString('base64') };
  await assert.rejects(ses.handle(forged, { fetchCert }), { code: 'BAD_SIGNATURE' });
  await assert.rejects(ses.handle(bounceEvent, { fetchCert }), { code: 'UNVERIFIABLE' });
  assert.equal((await ses.handle(bounceEvent, { verify: false })).events.length, 2);

  const visited = [];
  const subscribeUrl = 'https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=t';
  const subscription = snsEnvelope('You have chosen to subscribe', { type: 'SubscriptionConfirmation', extra: { SubscribeURL: subscribeUrl, Token: 't' } });
  const result = await ses.handle(subscription, { fetchCert, fetchUrl: async (url) => visited.push(url) });
  assert.deepEqual(result, { events: [], subscribed: true });
  assert.deepEqual(visited, [subscribeUrl]);

  const evil = snsEnvelope('x', { type: 'SubscriptionConfirmation', extra: { SubscribeURL: 'https://evil.example.com/', Token: 't' } });
  await assert.rejects(ses.handle(evil, { fetchCert, fetchUrl: async () => {} }), { code: 'BAD_SUBSCRIBE_URL' });
});

// ---- SendGrid ----------------------------------------------------------------------------------------------

test('SendGrid: maps the event types', () => {
  const events = sendgrid.parse(
    JSON.stringify([
      { email: 'a@example.com', event: 'processed', timestamp: 1762423200, sg_message_id: 's1' },
      { email: 'a@example.com', event: 'delivered', timestamp: 1762423200 },
      { email: 'b@example.com', event: 'bounce', type: 'bounce', reason: '550 5.1.1 unknown', status: '5.1.1' },
      { email: 'c@example.com', event: 'bounce', type: 'blocked', reason: '554 blocked' },
      { email: 'd@example.com', event: 'dropped', reason: 'Bounced Address' },
      { email: 'e@example.com', event: 'deferred' },
      { email: 'f@example.com', event: 'spamreport' },
      { email: 'g@example.com', event: 'group_unsubscribe' },
      { email: 'h@example.com', event: 'open' },
      { email: 'h@example.com', event: 'mystery' },
    ]),
  );
  assert.deepEqual(
    events.map((e) => [e.email, e.type, e.bounce]),
    [
      ['a@example.com', 'sent', null],
      ['a@example.com', 'delivered', null],
      ['b@example.com', 'bounce', 'hard'],
      ['c@example.com', 'bounce', 'soft'],
      ['d@example.com', 'suppressed', null],
      ['e@example.com', 'deferred', null],
      ['f@example.com', 'complaint', null],
      ['g@example.com', 'unsubscribe', null],
      ['h@example.com', 'open', null],
    ],
  );
  assert.equal(events[0].timestamp, 1762423200000);
  assert.equal(events[0].messageId, 's1');
});

test('SendGrid: verifies the signed Event Webhook (ECDSA)', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = ec.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const body = '[{"email":"a@example.com","event":"delivered"}]\r\n';
  const timestamp = '1762423200';
  const signature = sign('sha256', Buffer.from(timestamp + body), ec.privateKey).toString('base64');
  const headers = { 'X-Twilio-Email-Event-Webhook-Signature': signature, 'X-Twilio-Email-Event-Webhook-Timestamp': timestamp };
  assert.equal(sendgrid.verify(body, headers, publicKey), true);
  assert.equal(sendgrid.verify(Buffer.from(body), headers, ec.publicKey.export({ type: 'spki', format: 'pem' })), true);
  assert.equal(sendgrid.verify(body.replace('delivered', 'bounce'), headers, publicKey), false);
  assert.equal(sendgrid.verify(body, {}, publicKey), false);
});

// ---- Mailgun -----------------------------------------------------------------------------------------------

function mailgunBody(eventData, key = 'mailgun-key') {
  const timestamp = '1762423200';
  const token = 'a'.repeat(50);
  return { signature: { timestamp, token, signature: createHmac('sha256', key).update(timestamp + token).digest('hex') }, 'event-data': eventData };
}

test('Mailgun: maps the event types', () => {
  const type = (data) => mailgun.parse(mailgunBody({ recipient: 'a@example.com', timestamp: 1762423200.5, message: { headers: { 'message-id': 'mg1' } }, ...data }))[0];
  assert.equal(type({ event: 'delivered' }).type, 'delivered');
  assert.equal(type({ event: 'accepted' }).type, 'sent');
  const hard = type({ event: 'failed', severity: 'permanent', reason: 'bounce', 'delivery-status': { code: 550, message: '5.1.1 unknown' } });
  assert.deepEqual([hard.type, hard.bounce, hard.diagnostic, hard.messageId, hard.timestamp], ['bounce', 'hard', '5.1.1 unknown', 'mg1', 1762423200500]);
  assert.equal(type({ event: 'failed', severity: 'permanent', reason: 'old' }).bounce, 'soft');
  assert.equal(type({ event: 'failed', severity: 'permanent', reason: 'suppress-bounce' }).type, 'suppressed');
  assert.equal(type({ event: 'failed', severity: 'temporary' }).type, 'deferred');
  assert.equal(type({ event: 'complained' }).type, 'complaint');
  assert.equal(type({ event: 'unsubscribed' }).type, 'unsubscribe');
  assert.equal(type({ event: 'opened' }).type, 'open');
  assert.equal(type({ event: 'clicked' }).type, 'click');
  assert.deepEqual(mailgun.parse({}), []);
});

test('Mailgun: verifies the HMAC signature', () => {
  const body = mailgunBody({ event: 'delivered', recipient: 'a@example.com' });
  assert.equal(mailgun.verify(body, 'mailgun-key'), true);
  assert.equal(mailgun.verify(JSON.stringify(body), 'mailgun-key'), true);
  assert.equal(mailgun.verify(body, 'wrong-key'), false);
  assert.equal(mailgun.verify(body, 'mailgun-key', { maxAgeSeconds: 300, now: () => 1762423200000 + 299_000 }), true);
  assert.equal(mailgun.verify(body, 'mailgun-key', { maxAgeSeconds: 300, now: () => 1762423200000 + 301_000 }), false);
});

// ---- Postmark ----------------------------------------------------------------------------------------------

test('Postmark: maps record and bounce types', () => {
  const one = (body) => postmark.parse(body)[0];
  assert.equal(one({ RecordType: 'Delivery', Recipient: 'a@example.com', MessageID: 'p1', DeliveredAt: '2026-11-06T10:00:00Z' }).type, 'delivered');
  assert.equal(one({ RecordType: 'Bounce', Type: 'HardBounce', Email: 'a@example.com' }).bounce, 'hard');
  assert.equal(one({ RecordType: 'Bounce', Type: 'BadEmailAddress', Email: 'a@example.com' }).bounce, 'hard');
  assert.equal(one({ RecordType: 'Bounce', Type: 'SoftBounce', Email: 'a@example.com' }).bounce, 'soft');
  assert.equal(one({ RecordType: 'Bounce', Type: 'Transient', Email: 'a@example.com' }).bounce, 'soft');
  assert.equal(one({ RecordType: 'Bounce', Type: 'AutoResponder', Email: 'a@example.com' }).type, 'other');
  assert.equal(one({ RecordType: 'Bounce', Type: 'SpamComplaint', Email: 'a@example.com' }).type, 'complaint');
  assert.equal(one({ RecordType: 'SpamComplaint', Email: 'a@example.com' }).type, 'complaint');
  assert.equal(one({ RecordType: 'SubscriptionChange', Recipient: 'a@example.com', SuppressSending: true, SuppressionReason: 'ManualSuppression' }).type, 'unsubscribe');
  assert.equal(one({ RecordType: 'SubscriptionChange', Recipient: 'a@example.com', SuppressSending: true, SuppressionReason: 'HardBounce' }).type, 'suppressed');
  assert.deepEqual(postmark.parse({ RecordType: 'SubscriptionChange', Recipient: 'a@example.com', SuppressSending: false }), []);
  assert.equal(one({ RecordType: 'Open', Recipient: 'a@example.com' }).type, 'open');
  assert.equal(one({ RecordType: 'Click', Recipient: 'a@example.com' }).type, 'click');
});

// ---- Resend ------------------------------------------------------------------------------------------------

test('Resend: maps the event types, one per recipient', () => {
  const events = resend.parse({
    type: 'email.bounced',
    created_at: '2026-11-06T10:00:00.000Z',
    data: { email_id: 'r1', to: ['a@example.com', 'Jane <b@example.com>'], bounce: { type: 'Permanent', subType: 'General', message: 'mailbox does not exist' } },
  });
  assert.deepEqual(events.map((e) => [e.email, e.type, e.bounce]), [
    ['a@example.com', 'bounce', 'hard'],
    ['b@example.com', 'bounce', 'hard'],
  ]);
  assert.equal(resend.parse({ type: 'email.bounced', data: { to: ['a@example.com'], bounce: { type: 'Transient' } } })[0].bounce, 'soft');
  assert.equal(resend.parse({ type: 'email.delivered', data: { to: 'a@example.com' } })[0].type, 'delivered');
  assert.equal(resend.parse({ type: 'email.complained', data: { to: ['a@example.com'] } })[0].type, 'complaint');
  assert.equal(resend.parse({ type: 'email.delivery_delayed', data: { to: ['a@example.com'] } })[0].type, 'deferred');
  assert.deepEqual(resend.parse({ type: 'contact.created', data: {} }), []);
});

test('Resend: verifies Svix signatures within the time window', () => {
  const secret = `whsec_${Buffer.from('resend-secret-key').toString('base64')}`;
  const body = '{"type":"email.delivered","data":{"to":["a@example.com"]}}';
  const id = 'msg_123';
  const timestamp = '1762423200';
  const signature = createHmac('sha256', Buffer.from('resend-secret-key')).update(`${id}.${timestamp}.${body}`).digest('base64');
  const headers = { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,bm9wZQ== v1,${signature}` };
  const now = () => 1762423200000;
  assert.equal(resend.verify(body, headers, secret, { now }), true);
  assert.equal(resend.verify(body, new Headers(headers), secret, { now }), true);
  assert.equal(resend.verify(body.replace('delivered', 'bounced'), headers, secret, { now }), false);
  assert.equal(resend.verify(body, headers, secret, { now: () => now() + 301_000 }), false);
  assert.equal(resend.verify(body, { ...headers, 'svix-signature': `v2,${signature}` }, secret, { now }), false);
});

// ---- ZeptoMail ---------------------------------------------------------------------------------------------

test('ZeptoMail: maps bounces, deliveries and complaints', () => {
  const body = {
    event_name: ['hardbounce'],
    event_message: [
      {
        email_info: { client_reference: 'c1', email_reference: 'z1', to: [{ email_address: { address: 'fallback@example.com', name: 'F' } }] },
        event_data: [
          { object: 'hardbounce', details: [{ bounced_recipient: 'a@example.com', diagnostic_message: '550 5.1.1 unknown', time: '2026-11-06T10:00:00Z' }] },
          { object: 'softbounce', details: [{ bounced_recipient: 'b@example.com', diagnostic_message: '452 mailbox full' }] },
          { object: 'delivered', details: [{}] },
          { object: 'fbl_compliant', details: [{}] },
          { object: 'unknown_thing', details: [{}] },
        ],
        request_id: 'req1',
      },
    ],
  };
  assert.deepEqual(
    zeptomail.parse(JSON.stringify(body)).map((e) => [e.email, e.type, e.bounce, e.messageId]),
    [
      ['a@example.com', 'bounce', 'hard', 'z1'],
      ['b@example.com', 'bounce', 'soft', 'z1'],
      ['fallback@example.com', 'delivered', null, 'z1'],
      ['fallback@example.com', 'complaint', null, 'z1'],
    ],
  );
  assert.deepEqual(zeptomail.parse({}), []);
});

test('webhooks.parse dispatches by provider name', () => {
  assert.equal(webhooks.parse('SES', bounceEvent).length, 2);
  assert.throws(() => webhooks.parse('pigeon', {}), /Unknown provider/);
});
