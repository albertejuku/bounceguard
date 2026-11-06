import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeMailboxes } from '../src/index.js';
import { fakeSmtp, closedPort } from './helpers/fakes.js';

const base = { from: 'verify@sender.test', helo: 'sender.test', connectTimeout: 2000, commandTimeout: 2000 };

test('asks about every recipient in one session and never sends DATA', async () => {
  const server = await fakeSmtp({ users: ['jane@acme.test', 'joe@acme.test'] });
  try {
    const { results, acceptAll } = await probeMailboxes({
      ...base,
      hosts: ['127.0.0.1'],
      port: server.port,
      recipients: ['jane@acme.test', 'ghost@acme.test', 'joe@acme.test'],
    });
    assert.equal(results.get('jane@acme.test').status, 'accepted');
    assert.equal(results.get('joe@acme.test').status, 'accepted');
    const ghost = results.get('ghost@acme.test');
    assert.equal(ghost.status, 'rejected');
    assert.equal(ghost.code, 550);
    assert.equal(ghost.enhanced, '5.1.1');
    assert.equal(acceptAll.get('acme.test'), false);
    assert.equal(server.connections, 1);
    assert.equal(server.commands[0], 'EHLO sender.test');
    assert.equal(server.commands[1], 'MAIL FROM:<verify@sender.test>');
    assert.ok(!server.commands.some((c) => /^DATA/i.test(c)));
    for (let i = 0; i < 50 && server.commands.at(-1) !== 'QUIT'; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(server.commands.at(-1), 'QUIT');
  } finally {
    await server.close();
  }
});

test('detects a domain that accepts every address', async () => {
  const server = await fakeSmtp({ acceptAll: true });
  try {
    const { results, acceptAll } = await probeMailboxes({ ...base, hosts: ['127.0.0.1'], port: server.port, recipients: ['anyone@catchall.test'] });
    assert.equal(results.get('anyone@catchall.test').status, 'accepted');
    assert.equal(acceptAll.get('catchall.test'), true);
    assert.equal(server.rcpts().length, 2);
  } finally {
    await server.close();
  }
});

test('skips the accept-all probe when asked to', async () => {
  const server = await fakeSmtp({ acceptAll: true });
  try {
    const { acceptAll } = await probeMailboxes({ ...base, hosts: ['127.0.0.1'], port: server.port, recipients: ['a@catchall.test'], detectAcceptAll: false });
    assert.equal(acceptAll.get('catchall.test'), null);
    assert.equal(server.rcpts().length, 1);
  } finally {
    await server.close();
  }
});

test('reads multi-line replies correctly', async () => {
  const server = await fakeSmtp({
    users: ['jane@acme.test'],
    greeting: ['220-mx.test ESMTP', '220-Unauthorised use prohibited', '220 Ready'],
    rcpt: (address) => (address === 'gone@acme.test' ? ['550-5.1.1 The email account that you tried to reach does', '550 5.1.1 not exist.'] : undefined),
  });
  try {
    const { results } = await probeMailboxes({ ...base, hosts: ['127.0.0.1'], port: server.port, recipients: ['jane@acme.test', 'gone@acme.test'] });
    assert.equal(results.get('jane@acme.test').status, 'accepted');
    const gone = results.get('gone@acme.test');
    assert.equal(gone.status, 'rejected');
    assert.equal(gone.message, '5.1.1 The email account that you tried to reach does\n5.1.1 not exist.');
  } finally {
    await server.close();
  }
});

test('falls back to HELO when EHLO is refused', async () => {
  const server = await fakeSmtp({ users: ['jane@old.test'], ehlo: '502 5.5.2 EHLO not supported' });
  try {
    const { results } = await probeMailboxes({ ...base, hosts: ['127.0.0.1'], port: server.port, recipients: ['jane@old.test'] });
    assert.equal(results.get('jane@old.test').status, 'accepted');
    assert.ok(server.commands.includes('HELO sender.test'));
  } finally {
    await server.close();
  }
});

test('a refused sender is "blocked", not a verdict on the mailbox, and stops at the first server', async () => {
  const server = await fakeSmtp({ mailFrom: '550 5.7.1 Sender rejected: your IP is listed on a blocklist' });
  try {
    const { results } = await probeMailboxes({ ...base, hosts: ['127.0.0.1', '127.0.0.1'], port: server.port, recipients: ['jane@acme.test'] });
    assert.equal(results.get('jane@acme.test').status, 'blocked');
    assert.equal(server.connections, 1);
  } finally {
    await server.close();
  }
});

test('a server that refuses to talk sends us to the next one', async () => {
  const server = await fakeSmtp({ users: ['jane@acme.test'], greeting: (n) => (n === 1 ? '554 5.7.1 No SMTP service here' : '220 backup.test ready') });
  try {
    const { results } = await probeMailboxes({ ...base, hosts: ['127.0.0.1', '127.0.0.1'], port: server.port, recipients: ['jane@acme.test'] });
    assert.equal(results.get('jane@acme.test').status, 'accepted');
    assert.equal(server.connections, 2);
  } finally {
    await server.close();
  }
});

test('when every server refuses to talk, the answer is "blocked"', async () => {
  const server = await fakeSmtp({ greeting: '554 5.7.1 No SMTP service here' });
  try {
    const { results } = await probeMailboxes({ ...base, hosts: ['127.0.0.1', '127.0.0.1'], port: server.port, recipients: ['jane@acme.test'] });
    assert.equal(results.get('jane@acme.test').status, 'blocked');
    assert.equal(results.get('jane@acme.test').code, 554);
  } finally {
    await server.close();
  }
});

test('nothing listening is "unreachable" (port 25 blocked looks like this)', async () => {
  const port = await closedPort();
  const { results } = await probeMailboxes({ ...base, hosts: ['127.0.0.1', '127.0.0.1'], port, recipients: ['a@acme.test', 'b@acme.test'] });
  assert.equal(results.get('a@acme.test').status, 'unreachable');
  assert.equal(results.get('b@acme.test').status, 'unreachable');
});

test('a server that never greets times out as temporary', async () => {
  const silent = await fakeSmtp({ greeting: null });
  try {
    const started = Date.now();
    const { results } = await probeMailboxes({ ...base, commandTimeout: 200, hosts: ['127.0.0.1'], port: silent.port, recipients: ['a@acme.test'] });
    assert.equal(results.get('a@acme.test').status, 'temporary');
    assert.ok(Date.now() - started < 1500);
  } finally {
    await silent.close();
  }
});

test('a server that hangs up mid-session leaves the rest as temporary', async () => {
  const server = await fakeSmtp({
    users: ['a@acme.test'],
    rcpt: (address) => (address === 'b@acme.test' ? '421 4.7.0 Too many errors, closing connection' : undefined),
  });
  try {
    const { results } = await probeMailboxes({ ...base, hosts: ['127.0.0.1'], port: server.port, recipients: ['a@acme.test', 'b@acme.test', 'c@acme.test'] });
    assert.equal(results.get('a@acme.test').status, 'accepted');
    assert.equal(results.get('b@acme.test').status, 'temporary');
    assert.equal(results.get('c@acme.test').status, 'temporary');
  } finally {
    await server.close();
  }
});

test('"too many recipients" leaves the rest as temporary', async () => {
  const server = await fakeSmtp({
    acceptAll: true,
    rcpt: (address) => (address === 'b@acme.test' ? '452 4.5.3 Too many recipients' : undefined),
  });
  try {
    const { results, acceptAll } = await probeMailboxes({ ...base, hosts: ['127.0.0.1'], port: server.port, recipients: ['a@acme.test', 'b@acme.test', 'c@acme.test'] });
    assert.equal(results.get('a@acme.test').status, 'accepted');
    assert.equal(results.get('b@acme.test').status, 'temporary');
    assert.equal(results.get('c@acme.test').status, 'temporary');
    assert.equal(acceptAll.get('acme.test'), null);
    assert.ok(!server.rcpts().includes('c@acme.test'));
  } finally {
    await server.close();
  }
});

test('garbage from the server is handled, not thrown', async () => {
  const server = await fakeSmtp({ greeting: 'HTTP/1.1 400 Bad Request' });
  try {
    const { results } = await probeMailboxes({ ...base, hosts: ['127.0.0.1'], port: server.port, recipients: ['a@acme.test'] });
    assert.equal(results.get('a@acme.test').status, 'temporary');
  } finally {
    await server.close();
  }
});

test('refuses anything that could smuggle in another SMTP command', async () => {
  const server = await fakeSmtp({ users: ['a@acme.test'] });
  try {
    const { results } = await probeMailboxes({ ...base, hosts: ['127.0.0.1'], port: server.port, recipients: ['a@acme.test', 'x@acme.test>\r\nDATA', 'b c@acme.test'] });
    assert.equal(results.get('a@acme.test').status, 'accepted');
    assert.equal(results.get('x@acme.test>\r\nDATA').status, 'error');
    assert.equal(results.get('b c@acme.test').status, 'error');
    assert.ok(!server.commands.some((c) => /^DATA/i.test(c)));
    await assert.rejects(probeMailboxes({ ...base, from: 'a@b.test>\r\nRSET', hosts: ['127.0.0.1'], port: server.port, recipients: ['a@acme.test'] }), TypeError);
    await assert.rejects(probeMailboxes({ ...base, helo: 'x\r\nRSET', hosts: ['127.0.0.1'], port: server.port, recipients: ['a@acme.test'] }), TypeError);
  } finally {
    await server.close();
  }
});
