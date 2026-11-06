// What a mail server's answer to RCPT TO means for the mailbox. The enhanced status code (RFC 3463) decides
// when there is one; otherwise the wording does. A refusal aimed at *us* (blocklists, policy, our IP, our
// sender) says nothing about the mailbox, so it is "blocked", never "rejected": that difference is what keeps
// a real person from being dropped because the checking server had a bad day.

const MAILBOX_GONE = /(user|mailbox|recipient|address|account)\s+(is\s+)?(unknown|not found|does ?n[o']t exist|not exist|unavailable|disabled|deactivated|inactive|invalid|not valid)|no such (user|mailbox|recipient|address|account)|(unknown|invalid|bad) (user|mailbox|recipient|address|account)|does ?n[o']t (exist|have an? .{0,40}account)|not a valid (mailbox|recipient|user|address)|mailbox (unavailable|not available)|unrouteable address|undeliverable address/i;

const MAILBOX_FULL = /mailbox (is )?full|over ?quota|quota exceeded|exceeded (its|the|their) (storage|quota)|insufficient (system )?storage|out of storage/i;

const ABOUT_US = /spamhaus|barracuda|spamcop|sorbs|block ?list|black ?list|blocked|dnsbl|\brbl\b|\blisted\b|reputation|banned|policy|spam|abuse|client host|your ip|ip address|\bhelo\b|\behlo\b|reverse dns|\bptr\b|rdns|not permitted|access denied|relay(ing)? (denied|not permitted)|too many|rate limit|throttl|try again later|authenticat|starttls|tls required|\bsender\b/i;

const GONE_CODES = new Set(['5.1.0', '5.1.1', '5.1.2', '5.1.3', '5.1.6', '5.1.10', '5.2.1', '5.4.1', '5.4.4']);
const SENDER_CODES = new Set(['5.1.7', '5.1.8']);

/**
 * Classifies an SMTP reply ({ code, enhanced, message }) to RCPT TO as
 * 'accepted' | 'rejected' | 'full' | 'blocked' | 'temporary' | 'unverifiable' | 'error'.
 */
export function classifyReply({ code, enhanced = null, message = '' }) {
  const text = String(message || '');
  if (code === 250 || code === 251) return 'accepted';
  if (code === 252) return 'unverifiable';

  if (code >= 400 && code < 500) {
    if (enhanced === '4.2.2' || MAILBOX_FULL.test(text)) return 'full';
    return 'temporary';
  }
  if (code < 500 || code > 599) return 'error';

  if (enhanced === '5.2.2' || MAILBOX_FULL.test(text)) return 'full';
  const gone = MAILBOX_GONE.test(text);
  if (SENDER_CODES.has(enhanced)) return 'blocked';
  if (/\bsender\b/i.test(text) && !gone) return 'blocked';
  if (enhanced && GONE_CODES.has(enhanced)) return 'rejected';
  if (enhanced?.startsWith('5.7.')) return gone ? 'rejected' : 'blocked';
  if (gone) return 'rejected';
  if (ABOUT_US.test(text)) return 'blocked';

  if (code === 550 || code === 551 || code === 553 || code === 556) return 'rejected';
  if (code === 552) return 'full';
  if (code >= 500 && code <= 504) return 'error';
  return 'blocked';
}
