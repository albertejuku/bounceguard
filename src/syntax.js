// Address syntax, the way real mail servers see it: RFC 5321 limits, dot-atom local parts, and
// internationalised domains converted to their ASCII (punycode) form. Quoted local parts and IP-literal
// domains are valid on paper but nobody sends to them, so they are refused.
import { domainToASCII } from 'node:url';

const ATOM = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function invalid(message, local = null, domain = null) {
  return { valid: false, message, local, domain };
}

/**
 * Parses an address. Returns { valid: true, local, domain, address, key } or { valid: false, message }.
 * `domain` is lowercase ASCII, `address` keeps the local part's case, `key` is fully lowercased for lookups.
 */
export function parseAddress(input) {
  if (typeof input !== 'string') return invalid('The address is not text.');
  const raw = input.trim();
  if (!raw) return invalid('The address is empty.');
  if (/[\r\n\0]/.test(raw)) return invalid('The address has line breaks in it.');

  const at = raw.lastIndexOf('@');
  if (at === -1) return invalid('The address has no @.');
  const local = raw.slice(0, at);
  let domain = raw.slice(at + 1);
  if (local.includes('@')) return invalid('The address has more than one @.', null, domain);
  if (!local) return invalid('The part before the @ is empty.', null, domain);
  if (!domain) return invalid('The domain after the @ is missing.', local, null);

  if (local.length > 64) return invalid('The part before the @ is longer than 64 characters.', local, domain);
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return invalid('The part before the @ has a misplaced dot.', local, domain);
  }
  if (!local.split('.').every((atom) => ATOM.test(atom))) {
    return /[^\x00-\x7f]/.test(local)
      ? invalid("The part before the @ has non-ASCII characters, which most senders can't deliver to.", local, domain)
      : invalid("The part before the @ has characters that aren't allowed.", local, domain);
  }

  if (domain.startsWith('[')) return invalid("IP-address domains aren't accepted.", local, domain);
  if (domain.endsWith('.')) domain = domain.slice(0, -1);
  if (/\s/.test(domain)) return invalid('The domain has spaces in it.', local, domain);
  const ascii = domainToASCII(domain.toLowerCase());
  if (!ascii) return invalid("The domain isn't valid.", local, domain);
  if (ascii.length > 253) return invalid('The domain is longer than 253 characters.', local, domain);

  const labels = ascii.split('.');
  if (labels.length < 2) return invalid('The domain needs a dot, like example.com.', local, domain);
  if (!labels.every((label) => LABEL.test(label))) return invalid("The domain has characters that aren't allowed.", local, domain);
  const tld = labels[labels.length - 1];
  if (tld.length < 2 || /^\d+$/.test(tld)) return invalid("The domain's ending isn't valid.", local, domain);

  const address = `${local}@${ascii}`;
  if (address.length > 254) return invalid('The address is longer than 254 characters.', local, domain);
  return { valid: true, local, domain: ascii, address, key: address.toLowerCase() };
}

/** True when the address is syntactically deliverable. */
export function isValidSyntax(input) {
  return parseAddress(input).valid;
}
