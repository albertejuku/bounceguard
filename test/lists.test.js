import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestDomain, repairDomain, editDistance, isDisposableDomain, isRoleAddress, isFreeProvider } from '../src/index.js';

test('suggests the provider for common typos', () => {
  const cases = {
    'gmial.com': 'gmail.com',
    'gamil.com': 'gmail.com',
    'gmai.com': 'gmail.com',
    'gmaill.com': 'gmail.com',
    'gmail.con': 'gmail.com',
    'gmail.co': 'gmail.com',
    'gmail.cmo': 'gmail.com',
    'gmial.con': 'gmail.com',
    'hotmial.com': 'hotmail.com',
    'hotnail.com': 'hotmail.com',
    'yahooo.com': 'yahoo.com',
    'yaho.com': 'yahoo.com',
    'outlok.com': 'outlook.com',
    'outlook.cm': 'outlook.com',
    'iclod.com': 'icloud.com',
    'googlemial.com': 'googlemail.com',
    'protonmial.com': 'protonmail.com',
    'yahoo.co.uj': 'yahoo.co.uk',
    'comcast.nte': 'comcast.net',
  };
  for (const [typo, meant] of Object.entries(cases)) assert.equal(suggestDomain(typo), meant, typo);
});

test('leaves real domains alone', () => {
  for (const domain of ['gmail.com', 'mail.com', 'email.com', 'ymail.com', 'gmx.com', 'live.co.za', 'mi.com', 'company.co.ke', 'example.com', 'acme.co', 'safaricom.co.ke', 'yahoo.co.ke', 'outlook.co.ke', 'me.com', 'mac.com']) {
    assert.equal(suggestDomain(domain), null, domain);
  }
});

test('fixes endings that are not real top-level domains on any domain', () => {
  assert.equal(suggestDomain('acme.con'), 'acme.com');
  assert.equal(suggestDomain('shop.acme.cmo'), 'shop.acme.com');
  assert.equal(suggestDomain('acme.nett'), 'acme.net');
  assert.equal(suggestDomain('acme.cm'), null); // Cameroon is real
  assert.equal(suggestDomain('acme.om'), null); // Oman is real
});

test('repairs broken domains', () => {
  assert.equal(repairDomain('gmail'), 'gmail.com');
  assert.equal(repairDomain('gmail,com'), 'gmail.com');
  assert.equal(repairDomain('yahoo com'), 'yahoo.com');
  assert.equal(repairDomain('gmial'), null);
  assert.equal(repairDomain('acme'), null);
  assert.equal(repairDomain(''), null);
});

test('edit distance counts transpositions as one edit', () => {
  assert.equal(editDistance('gmail', 'gmail'), 0);
  assert.equal(editDistance('gmail', 'gmial'), 1);
  assert.equal(editDistance('gmail', 'gmal'), 1);
  assert.equal(editDistance('kitten', 'sitting'), 3);
});

test('spots throwaway domains, including their subdomains and your own additions', () => {
  assert.equal(isDisposableDomain('mailinator.com'), true);
  assert.equal(isDisposableDomain('Yopmail.com'), true);
  assert.equal(isDisposableDomain('inbox.mailinator.com'), true);
  assert.equal(isDisposableDomain('gmail.com'), false);
  assert.equal(isDisposableDomain('com'), false);
  assert.equal(isDisposableDomain('throwaway.test', new Set(['throwaway.test'])), true);
});

test('spots role addresses, ignoring +tags', () => {
  assert.equal(isRoleAddress('info'), true);
  assert.equal(isRoleAddress('NoReply'), true);
  assert.equal(isRoleAddress('support+billing'), true);
  assert.equal(isRoleAddress('jane'), false);
});

test('knows the free providers', () => {
  assert.equal(isFreeProvider('gmail.com'), true);
  assert.equal(isFreeProvider('acme.com'), false);
});
