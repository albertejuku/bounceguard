import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupMail } from '../src/index.js';
import { fakeResolver } from './helpers/fakes.js';

test('returns mail servers sorted by priority, lowercased and without trailing dots', async () => {
  const resolver = fakeResolver({
    'example.com': { mx: [{ exchange: 'MX2.Example.com.', priority: 20 }, { exchange: 'mx1.example.com', priority: 10 }] },
  });
  const mail = await lookupMail('example.com', resolver);
  assert.deepEqual(mail, {
    status: 'ok',
    hosts: [{ exchange: 'mx1.example.com', priority: 10 }, { exchange: 'mx2.example.com', priority: 20 }],
    implicit: false,
  });
});

test('recognises a null MX (the domain takes no mail)', async () => {
  const resolver = fakeResolver({ 'nomail.example': { mx: [{ exchange: '', priority: 0 }] } });
  assert.equal((await lookupMail('nomail.example', resolver)).status, 'null_mx');
  const dotted = fakeResolver({ 'nomail.example': { mx: [{ exchange: '.', priority: 0 }] } });
  assert.equal((await lookupMail('nomail.example', dotted)).status, 'null_mx');
});

test('falls back to the domain itself when it has an address but no MX', async () => {
  const resolver = fakeResolver({ 'small.example': { mx: 'ENODATA', a: ['203.0.113.10'] } });
  assert.deepEqual(await lookupMail('small.example', resolver), {
    status: 'ok',
    hosts: [{ exchange: 'small.example', priority: 0 }],
    implicit: true,
  });
  const v6 = fakeResolver({ 'six.example': { mx: 'ENODATA', aaaa: ['2001:db8::1'] } });
  assert.equal((await lookupMail('six.example', v6)).implicit, true);
});

test('no MX and no address means no mail server', async () => {
  const resolver = fakeResolver({ 'parked.example': { mx: 'ENODATA' } });
  assert.equal((await lookupMail('parked.example', resolver)).status, 'no_mail');
});

test('a domain that does not exist', async () => {
  assert.equal((await lookupMail('nope.example', fakeResolver({}))).status, 'no_domain');
});

test('a resolver that times out on MX but answers NXDOMAIN for A: the domain does not exist', async () => {
  const resolver = fakeResolver({ 'gone.example': { mx: 'ETIMEOUT', a: 'ENOTFOUND' } });
  assert.equal((await lookupMail('gone.example', resolver)).status, 'no_domain');
});

test('a failing resolver is an error, never "no mail server"', async () => {
  const resolver = fakeResolver({ 'flaky.example': { mx: 'ESERVFAIL', a: ['203.0.113.1'] } });
  assert.deepEqual(await lookupMail('flaky.example', resolver), { status: 'error', hosts: [], error: 'ESERVFAIL' });
  const noAnswer = fakeResolver({ 'quiet.example': { mx: 'ETIMEOUT', a: 'ETIMEOUT' } });
  assert.equal((await lookupMail('quiet.example', noAnswer)).status, 'error');
  const timeout = fakeResolver({ 'slow.example': { mx: 'ENODATA', a: 'ETIMEOUT' } });
  assert.equal((await lookupMail('slow.example', timeout)).status, 'error');
});
