import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuard, MemoryStore } from '../src/index.js';
import { fakeSmtp, fakeResolver, closedPort, mx, clock, DAY } from './helpers/fakes.js';

async function setup({ users = [], acceptAll = false, zones, smtp = {}, rcpt, ...options } = {}) {
  const server = await fakeSmtp({ users, acceptAll, rcpt });
  const resolver = fakeResolver(
    zones ?? {
      'acme.test': mx(),
      'gmail.com': mx(),
      'gmial.com': mx(),
      'catchall.test': mx(),
      'other.test': mx(),
      'nomail.test': { mx: [{ exchange: '', priority: 0 }] },
      'parked.test': { mx: 'ENODATA' },
      'flaky.test': { mx: 'ESERVFAIL' },
    },
  );
  const guard = createGuard({
    dns: { resolver },
    smtp: { from: 'verify@sender.test', port: server.port, connectTimeout: 2000, commandTimeout: 2000, ...smtp },
    serverInterval: 0,
    ...options,
  });
  return { guard, server, resolver };
}

test('a confirmed mailbox is deliverable and sent to', async () => {
  const { guard, server } = await setup({ users: ['jane@acme.test'] });
  try {
    const r = await guard.check('Jane@ACME.test');
    assert.equal(r.email, 'Jane@ACME.test');
    assert.equal(r.address, 'Jane@acme.test');
    assert.equal(r.verdict, 'deliverable');
    assert.equal(r.reason, 'mailbox_exists');
    assert.equal(r.send, true);
    assert.equal(r.score, 90);
    assert.equal(r.flags.acceptAll, false);
    assert.equal(r.mx, '127.0.0.1');
    assert.equal(r.smtp.code, 250);
    assert.equal(r.cached, false);
  } finally {
    await server.close();
  }
});

test('a mailbox the server rejects is undeliverable and held', async () => {
  const { guard, server } = await setup({ users: ['jane@acme.test'] });
  try {
    const r = await guard.check('ghost@acme.test');
    assert.equal(r.verdict, 'undeliverable');
    assert.equal(r.reason, 'mailbox_not_found');
    assert.equal(r.send, false);
    assert.equal(r.score, 0);
    assert.equal(r.smtp.enhanced, '5.1.1');
  } finally {
    await server.close();
  }
});

test('an accept-all domain is risky but sent by default, and the domain is remembered', async () => {
  const { guard, server } = await setup({ acceptAll: true });
  try {
    const first = await guard.check('anyone@catchall.test');
    assert.equal(first.verdict, 'risky');
    assert.equal(first.reason, 'accept_all');
    assert.equal(first.flags.acceptAll, true);
    assert.equal(first.send, true);
    const connections = server.connections;
    const second = await guard.check('someone.else@catchall.test');
    assert.equal(second.reason, 'accept_all');
    assert.equal(server.connections, connections, 'no new connection for a known accept-all domain');
  } finally {
    await server.close();
  }
});

test('sendRisky: false holds risky addresses', async () => {
  const { guard, server } = await setup({ acceptAll: true, policy: { sendRisky: false } });
  try {
    assert.equal((await guard.check('anyone@catchall.test')).send, false);
  } finally {
    await server.close();
  }
});

test('syntax errors never touch the network and can suggest a fix', async () => {
  const { guard, server, resolver } = await setup();
  try {
    const r = await guard.check('jane@gmail');
    assert.equal(r.verdict, 'undeliverable');
    assert.equal(r.reason, 'invalid_syntax');
    assert.equal(r.send, false);
    assert.equal(r.suggestion, 'jane@gmail.com');
    assert.match(r.message, /needs a dot/);
    assert.equal(r.address, null);
    assert.equal(resolver.calls.length, 0);
    assert.equal(server.connections, 0);
    assert.equal((await guard.check('jane@gmail,com')).suggestion, 'jane@gmail.com');
  } finally {
    await server.close();
  }
});

test('throwaway domains are held without a network check', async () => {
  const { guard, server, resolver } = await setup();
  try {
    const r = await guard.check('x@mailinator.com');
    assert.equal(r.verdict, 'risky');
    assert.equal(r.reason, 'disposable');
    assert.equal(r.send, false);
    assert.equal(resolver.calls.length, 0);
  } finally {
    await server.close();
  }
});

test('allowDisposable lets them through; disposableDomains adds your own', async () => {
  const { guard, server } = await setup({ policy: { allowDisposable: true }, disposableDomains: ['burner.test'] });
  try {
    assert.equal((await guard.check('x@mailinator.com')).send, true);
    assert.equal((await guard.check('x@burner.test')).reason, 'disposable');
  } finally {
    await server.close();
  }
});

test('domain problems are undeliverable', async () => {
  const { guard, server } = await setup();
  try {
    const [missing, nullMx, parked] = await guard.checkMany(['a@missing.test', 'a@nomail.test', 'a@parked.test']);
    assert.equal(missing.reason, 'no_domain');
    assert.equal(nullMx.reason, 'null_mx');
    assert.equal(parked.reason, 'no_mail_server');
    for (const r of [missing, nullMx, parked]) {
      assert.equal(r.verdict, 'undeliverable');
      assert.equal(r.send, false);
    }
    assert.equal(server.connections, 0);
  } finally {
    await server.close();
  }
});

test('a DNS failure is unknown and still sent: a flaky resolver must not drop real people', async () => {
  const { guard, server } = await setup();
  try {
    const r = await guard.check('a@flaky.test');
    assert.equal(r.verdict, 'unknown');
    assert.equal(r.reason, 'dns_error');
    assert.equal(r.send, true);
  } finally {
    await server.close();
  }
});

test('port 25 blocked: unknown, still sent, and rechecked within the hour', async () => {
  const port = await closedPort();
  const now = clock();
  const guard = createGuard({
    dns: { resolver: fakeResolver({ 'acme.test': mx() }) },
    smtp: { from: 'verify@sender.test', port, connectTimeout: 500 },
    serverInterval: 0,
    now,
  });
  const r = await guard.check('jane@acme.test');
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reason, 'smtp_unreachable');
  assert.equal(r.send, true);
  const record = await guard.get('jane@acme.test');
  assert.equal(record.check.nextCheckAt - record.check.checkedAt, 3_600_000);
});

test('sendUnknown: false holds what could not be checked', async () => {
  const { guard, server } = await setup({ policy: { sendUnknown: false } });
  try {
    assert.equal((await guard.check('a@flaky.test')).send, false);
  } finally {
    await server.close();
  }
});

test('a server that blocks the check gives unknown, not undeliverable', async () => {
  const { guard, server } = await setup({ rcpt: () => '554 5.7.1 Service unavailable; Client host [127.0.0.1] blocked using zen.spamhaus.org' });
  try {
    const r = await guard.check('jane@acme.test');
    assert.equal(r.verdict, 'unknown');
    assert.equal(r.reason, 'smtp_blocked');
    assert.equal(r.send, true);
  } finally {
    await server.close();
  }
});

test('greylisting is unknown; a full mailbox is risky', async () => {
  const { guard, server } = await setup({
    rcpt: (a) => (a.startsWith('grey') ? '450 4.2.0 Greylisted, try again later' : a.startsWith('full') ? '552 5.2.2 Mailbox full' : undefined),
  });
  try {
    const [grey, full] = await guard.checkMany(['grey@acme.test', 'full@acme.test']);
    assert.equal(grey.reason, 'smtp_temporary');
    assert.equal(grey.verdict, 'unknown');
    assert.equal(full.reason, 'mailbox_full');
    assert.equal(full.verdict, 'risky');
  } finally {
    await server.close();
  }
});

test('a typo domain is risky with a suggestion, even when its server says yes', async () => {
  const { guard, server } = await setup({ users: ['jane@gmial.com'] });
  try {
    const r = await guard.check('jane@gmial.com');
    assert.equal(r.verdict, 'risky');
    assert.equal(r.reason, 'typo');
    assert.equal(r.suggestion, 'jane@gmail.com');
    assert.equal(r.flags.typo, true);
    assert.match(r.message, /typo of gmail\.com/);
    const gone = await guard.check('nobody@gmial.com');
    assert.equal(gone.verdict, 'undeliverable');
    assert.equal(gone.suggestion, 'nobody@gmail.com');
  } finally {
    await server.close();
  }
});

test('without a probe sender, mailboxes are not checked and nothing is cached', async () => {
  const resolver = fakeResolver({ 'acme.test': mx() });
  const guard = createGuard({ dns: { resolver } });
  const r = await guard.check('jane@acme.test');
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reason, 'smtp_disabled');
  assert.equal(r.send, true);
  assert.equal(await guard.get('jane@acme.test'), null);
});

test('rejects a probe sender that is not a real address', () => {
  assert.throws(() => createGuard({ smtp: { from: 'nope' } }), /smtp\.from/);
  assert.throws(() => createGuard({ smtp: {} }), /smtp\.from/);
  assert.throws(() => createGuard({ smtp: { from: 'a@b.test', helo: 'bad host\r\n' } }), /helo/);
});

test('results are cached until the recheck date, and fresh: true asks again', async () => {
  const now = clock();
  const { guard, server } = await setup({ users: ['jane@acme.test'], now });
  try {
    await guard.check('jane@acme.test');
    const connections = server.connections;
    const cached = await guard.check('jane@acme.test');
    assert.equal(cached.cached, true);
    assert.equal(cached.reason, 'mailbox_exists');
    assert.equal(server.connections, connections);

    const fresh = await guard.check('jane@acme.test', { fresh: true });
    assert.equal(fresh.cached, false);
    assert.equal(server.connections, connections + 1);

    now.advance(91 * DAY);
    const expired = await guard.check('jane@acme.test');
    assert.equal(expired.cached, false);
    assert.equal(server.connections, connections + 2);
  } finally {
    await server.close();
  }
});

test('checkMany keeps input order, checks duplicates once and shares one session per server', async () => {
  const { guard, server } = await setup({ users: ['a@acme.test', 'b@other.test'] });
  try {
    const results = await guard.checkMany(['a@acme.test', 'bad', 'ghost@acme.test', 'A@acme.test', 'b@other.test']);
    assert.deepEqual(results.map((r) => r.email), ['a@acme.test', 'bad', 'ghost@acme.test', 'A@acme.test', 'b@other.test']);
    assert.deepEqual(results.map((r) => r.verdict), ['deliverable', 'undeliverable', 'undeliverable', 'deliverable', 'deliverable']);
    assert.equal(server.connections, 1, 'acme.test and other.test share 127.0.0.1');
    const asked = server.rcpts().filter((a) => !a.startsWith('bg'));
    assert.deepEqual(asked.sort(), ['a@acme.test', 'b@other.test', 'ghost@acme.test']);
  } finally {
    await server.close();
  }
});

test('large lists are split into sessions of recipientsPerSession', async () => {
  const users = Array.from({ length: 7 }, (_, i) => `u${i}@acme.test`);
  const { guard, server } = await setup({ users, smtp: { recipientsPerSession: 3, detectAcceptAll: false } });
  try {
    const results = await guard.checkMany(users);
    assert.ok(results.every((r) => r.verdict === 'deliverable'));
    assert.equal(server.connections, 3);
  } finally {
    await server.close();
  }
});

test('filter splits a list into addresses to send and the ones held back', async () => {
  const { guard, server } = await setup({ users: ['a@acme.test', 'b@acme.test'] });
  try {
    const { send, hold, results } = await guard.filter(['a@acme.test', 'A@ACME.test', 'b@acme.test', 'ghost@acme.test', 'x@mailinator.com', 'nope']);
    assert.deepEqual(send, ['a@acme.test', 'b@acme.test']);
    assert.deepEqual(hold.map((r) => r.reason), ['mailbox_not_found', 'disposable', 'invalid_syntax']);
    assert.equal(results.length, 6);
  } finally {
    await server.close();
  }
});

test('trusted domains skip every check, but suppression still applies', async () => {
  const { guard, server, resolver } = await setup({ trustedDomains: ['ourcompany.test'] });
  try {
    const r = await guard.check('anyone@mail.ourcompany.test');
    assert.equal(r.reason, 'trusted_domain');
    assert.equal(r.send, true);
    assert.equal(resolver.calls.length, 0);
    await guard.recordBounce('anyone@mail.ourcompany.test', { type: 'hard' });
    assert.equal((await guard.check('anyone@mail.ourcompany.test')).send, false);
  } finally {
    await server.close();
  }
});

test('role addresses are flagged, and held only when the policy says so', async () => {
  const { guard, server } = await setup({ users: ['info@acme.test'] });
  try {
    const r = await guard.check('info@acme.test');
    assert.equal(r.flags.role, true);
    assert.equal(r.send, true);
  } finally {
    await server.close();
  }
  const strict = await setup({ users: ['info@acme.test'], policy: { allowRole: false } });
  try {
    const r = await strict.guard.check('info@acme.test');
    assert.equal(r.reason, 'role_account');
    assert.equal(r.send, false);
  } finally {
    await strict.server.close();
  }
});

// ---- Learning ----------------------------------------------------------------------------------------

test('a hard bounce suppresses the address for good', async () => {
  const { guard, server } = await setup({ users: ['jane@acme.test'] });
  try {
    await guard.recordBounce('Jane@acme.test', { type: 'hard', diagnostic: 'smtp; 550 5.1.1 user unknown' });
    const r = await guard.check('jane@acme.test');
    assert.equal(r.send, false);
    assert.equal(r.reason, 'suppressed');
    assert.equal(r.suppressed.reason, 'hard_bounce');
    assert.equal(r.score, 0);
    assert.match(r.message, /bounced permanently/);
    assert.equal(await guard.isSuppressed('jane@acme.test'), true);
    const record = await guard.get('jane@acme.test');
    assert.equal(record.hardBounces, 1);
    assert.equal(record.lastBounceDiagnostic, 'smtp; 550 5.1.1 user unknown');
  } finally {
    await server.close();
  }
});

test('soft bounces suppress after the limit, for a while, and a delivery resets them', async () => {
  const now = clock();
  const { guard, server } = await setup({ users: ['jane@acme.test'], now, softBounceLimit: 3 });
  try {
    await guard.recordBounce('jane@acme.test', { type: 'soft' });
    await guard.recordBounce('jane@acme.test', { type: 'Transient' });
    assert.equal(await guard.isSuppressed('jane@acme.test'), false);
    await guard.recordDelivered('jane@acme.test');
    assert.equal((await guard.get('jane@acme.test')).consecutiveSoftBounces, 0);

    for (let i = 0; i < 3; i++) await guard.recordBounce('jane@acme.test', { type: 'soft' });
    const r = await guard.check('jane@acme.test');
    assert.equal(r.suppressed.reason, 'soft_bounces');
    assert.equal(r.send, false);
    now.advance(31 * DAY);
    assert.equal(await guard.isSuppressed('jane@acme.test'), false);
  } finally {
    await server.close();
  }
});

test('a delivery lifts bounce suppression but never a complaint or an unsubscribe', async () => {
  const { guard, server } = await setup();
  try {
    await guard.recordBounce('a@acme.test', { type: 'hard' });
    await guard.recordDelivered('a@acme.test');
    const lifted = await guard.check('a@acme.test');
    assert.equal(lifted.send, true);
    assert.equal(lifted.reason, 'delivered_before');
    assert.equal(lifted.cached, true);

    await guard.recordComplaint('b@acme.test');
    await guard.recordDelivered('b@acme.test');
    assert.equal((await guard.check('b@acme.test')).suppressed.reason, 'complaint');

    await guard.recordUnsubscribe('c@acme.test');
    await guard.recordDelivered('c@acme.test');
    assert.equal((await guard.check('c@acme.test')).suppressed.reason, 'unsubscribed');
  } finally {
    await server.close();
  }
});

test('a stronger suppression reason replaces a weaker one, never the other way round', async () => {
  const { guard, server } = await setup();
  try {
    await guard.recordBounce('a@acme.test', { type: 'hard' });
    await guard.recordComplaint('a@acme.test');
    assert.equal((await guard.get('a@acme.test')).suppressedReason, 'complaint');
    await guard.recordBounce('a@acme.test', { type: 'hard' });
    assert.equal((await guard.get('a@acme.test')).suppressedReason, 'complaint');
    for (let i = 0; i < 3; i++) await guard.recordBounce('a@acme.test', { type: 'soft' });
    const record = await guard.get('a@acme.test');
    assert.equal(record.suppressedReason, 'complaint');
    assert.equal(record.suppressedUntil, null);
  } finally {
    await server.close();
  }
});

test('opens and clicks reset soft bounces', async () => {
  const { guard, server } = await setup({ softBounceLimit: 2 });
  try {
    await guard.recordBounce('a@acme.test', { type: 'soft' });
    await guard.recordBounce('a@acme.test', { type: 'soft' });
    assert.equal(await guard.isSuppressed('a@acme.test'), true);
    await guard.record({ type: 'click', email: 'a@acme.test' });
    assert.equal(await guard.isSuppressed('a@acme.test'), false);
  } finally {
    await server.close();
  }
});

test('manual suppression, with and without an end date, and unsuppress', async () => {
  const now = clock();
  const { guard, server } = await setup({ users: ['a@acme.test'], now });
  try {
    await guard.suppress('a@acme.test', 'legal hold');
    const held = await guard.check('a@acme.test');
    assert.equal(held.send, false);
    assert.equal(held.message, 'Suppressed: legal hold.');
    await guard.unsuppress('a@acme.test');
    assert.equal((await guard.check('a@acme.test')).send, true);

    await guard.suppress('a@acme.test', 'manual', { until: now() + DAY });
    assert.equal(await guard.isSuppressed('a@acme.test'), true);
    now.advance(DAY);
    assert.equal(await guard.isSuppressed('a@acme.test'), false);
  } finally {
    await server.close();
  }
});

test('unsuppress forgets the last check so the server is asked again', async () => {
  const { guard, server } = await setup({ users: ['a@acme.test'] });
  try {
    await guard.recordBounce('a@acme.test', { type: 'hard' });
    await guard.unsuppress('a@acme.test');
    const r = await guard.check('a@acme.test');
    assert.equal(r.reason, 'mailbox_exists');
    assert.equal(r.cached, false);
  } finally {
    await server.close();
  }
});

test('record() routes normalised events, and ignores ones with nothing to learn', async () => {
  const { guard, server } = await setup();
  try {
    await guard.recordEvents([
      { type: 'sent', email: 'a@acme.test' },
      { type: 'delivered', email: 'a@acme.test' },
      { type: 'bounce', email: 'b@acme.test', bounce: 'hard' },
      { type: 'complaint', email: 'c@acme.test' },
      { type: 'unsubscribe', email: 'd@acme.test' },
      { type: 'suppressed', email: 'e@acme.test' },
      { type: 'deferred', email: 'f@acme.test' },
      { type: 'other', email: 'g@acme.test' },
      { type: 'bounce', email: null },
    ]);
    const a = await guard.get('a@acme.test');
    assert.equal(a.sent, 1);
    assert.equal(a.delivered, 1);
    assert.equal((await guard.get('b@acme.test')).suppressedReason, 'hard_bounce');
    assert.equal((await guard.get('c@acme.test')).suppressedReason, 'complaint');
    assert.equal((await guard.get('d@acme.test')).suppressedReason, 'unsubscribed');
    assert.equal((await guard.get('e@acme.test')).suppressedReason, 'provider_suppressed');
    assert.equal(await guard.get('f@acme.test'), null);
    assert.equal(await guard.get('g@acme.test'), null);
  } finally {
    await server.close();
  }
});

test('history nudges the score', async () => {
  const { guard, server } = await setup({ users: ['a@acme.test'] });
  try {
    await guard.recordBounce('a@acme.test', { type: 'soft' });
    const r = await guard.check('a@acme.test');
    assert.equal(r.score, 75);
  } finally {
    await server.close();
  }
});

// ---- Reputation --------------------------------------------------------------------------------------

test('a bounce rate at the pause threshold stops all sending until it recovers', async () => {
  const now = clock();
  const { guard, server } = await setup({ users: ['jane@acme.test'], now, reputation: { minSample: 20 } });
  try {
    for (let i = 0; i < 20; i++) await guard.recordSent(`r${i}@acme.test`);
    for (let i = 0; i < 2; i++) await guard.recordBounce(`r${i}@acme.test`, { type: 'hard' });
    const health = guard.health();
    assert.equal(health.status, 'paused');
    assert.equal(health.bounceRate, 0.1);
    assert.match(health.reasons[0], /Bounce rate 10\.0%/);

    const r = await guard.check('jane@acme.test');
    assert.equal(r.verdict, 'deliverable');
    assert.equal(r.send, false);
    assert.equal(r.reason, 'sender_paused');

    now.advance(8 * DAY);
    assert.equal(guard.health().status, 'ok');
    assert.equal((await guard.check('jane@acme.test')).send, true);
  } finally {
    await server.close();
  }
});

test('reputation pause can be turned off, or reputation tracking entirely', async () => {
  const { guard, server } = await setup({ users: ['jane@acme.test'], reputation: { minSample: 1, pause: false } });
  try {
    await guard.recordSent('x@acme.test');
    await guard.recordComplaint('x@acme.test');
    assert.equal(guard.health().status, 'paused');
    assert.equal((await guard.check('jane@acme.test')).send, true);
  } finally {
    await server.close();
  }
  const off = createGuard({ reputation: false, dns: { resolver: fakeResolver({}) } });
  assert.equal(off.health(), null);
});

test('works with any store that has async get and set', async () => {
  const calls = [];
  const inner = new MemoryStore();
  const store = {
    get: async (key) => (calls.push(`get ${key}`), inner.get(key)),
    set: async (key, value) => (calls.push(`set ${key}`), inner.set(key, value)),
  };
  const { guard, server } = await setup({ users: ['a@acme.test'], store });
  try {
    await guard.check('A@acme.test');
    assert.deepEqual(calls, ['get a@acme.test', 'get a@acme.test', 'set a@acme.test']);
    const saved = await inner.get('a@acme.test');
    assert.equal(saved.check.verdict, 'deliverable');
    assert.equal(JSON.parse(JSON.stringify(saved)).check.reason, 'mailbox_exists');
  } finally {
    await server.close();
  }
});

test('servers are asked one session at a time, with a pause in between', async () => {
  const { guard, server } = await setup({ users: ['a@acme.test', 'b@acme.test'], serverInterval: 150, smtp: { recipientsPerSession: 1, detectAcceptAll: false } });
  try {
    const started = Date.now();
    await guard.checkMany(['a@acme.test', 'b@acme.test']);
    assert.ok(Date.now() - started >= 150);
    assert.equal(server.connections, 2);
  } finally {
    await server.close();
  }
});
