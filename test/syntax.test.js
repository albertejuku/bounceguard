import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAddress, isValidSyntax } from '../src/index.js';

test('accepts ordinary addresses and normalises the domain', () => {
  const parsed = parseAddress('  Jane.Doe+news@Example.COM ');
  assert.equal(parsed.valid, true);
  assert.equal(parsed.local, 'Jane.Doe+news');
  assert.equal(parsed.domain, 'example.com');
  assert.equal(parsed.address, 'Jane.Doe+news@example.com');
  assert.equal(parsed.key, 'jane.doe+news@example.com');
});

test('accepts the characters RFC 5322 allows in a local part', () => {
  for (const address of ["o'brien@example.com", 'a_b-c@example.co.ke', 'x!#$%&*+/=?^`{|}~@example.org', '1@example.io']) {
    assert.equal(isValidSyntax(address), true, address);
  }
});

test('converts internationalised domains to punycode', () => {
  const parsed = parseAddress('info@bücher.de');
  assert.equal(parsed.valid, true);
  assert.equal(parsed.domain, 'xn--bcher-kva.de');
});

test('drops a trailing dot on the domain', () => {
  assert.equal(parseAddress('a@example.com.').domain, 'example.com');
});

test('refuses broken addresses with a reason', () => {
  const cases = {
    '': 'empty',
    'no-at-sign.example.com': 'no @',
    'a@b@example.com': 'more than one @',
    '@example.com': 'before the @ is empty',
    'jane@': 'missing',
    '.jane@example.com': 'misplaced dot',
    'jane.@example.com': 'misplaced dot',
    'ja..ne@example.com': 'misplaced dot',
    'ja ne@example.com': "aren't allowed",
    '"jane doe"@example.com': "aren't allowed",
    'jöhn@example.com': 'non-ASCII',
    'jane@localhost': 'needs a dot',
    'jane@[192.168.0.1]': 'IP-address',
    'jane@192.168.0.1': 'ending',
    'jane@example.c': 'ending',
    'jane@-example.com': "aren't allowed",
    'jane@exa_mple.com': "aren't allowed",
    'jane@exa mple.com': 'spaces',
    'jane\r\n@example.com': 'line breaks',
  };
  for (const [address, fragment] of Object.entries(cases)) {
    const parsed = parseAddress(address);
    assert.equal(parsed.valid, false, address);
    assert.match(parsed.message, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), address);
  }
});

test('enforces RFC 5321 length limits', () => {
  assert.equal(isValidSyntax(`${'a'.repeat(64)}@example.com`), true);
  assert.equal(isValidSyntax(`${'a'.repeat(65)}@example.com`), false);
  assert.equal(isValidSyntax(`a@${'b'.repeat(63)}.com`), true);
  assert.equal(isValidSyntax(`a@${'b'.repeat(64)}.com`), false);
  const long = `${'a'.repeat(64)}@${Array.from({ length: 4 }, () => 'b'.repeat(60)).join('.')}.com`;
  assert.equal(parseAddress(long).valid, false);
});

test('refuses non-strings', () => {
  assert.equal(parseAddress(undefined).valid, false);
  assert.equal(parseAddress(42).valid, false);
});
