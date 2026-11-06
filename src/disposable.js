// Throwaway inbox services. Mail to them "works" until the inbox expires, then bounces, and nobody reads it in
// the meantime. This is a compact list of the services seen most often; pass `disposableDomains` to the guard to
// add your own, or load the community list at https://github.com/disposable-email-domains/disposable-email-domains.
export const DISPOSABLE_DOMAINS = Object.freeze([
  // Mailinator and its aliases
  'mailinator.com', 'mailinator.net', 'mailinator2.com', 'mailinater.com', 'notmailinator.com', 'binkmail.com',
  'bobmail.info', 'chammy.info', 'devnullmail.com', 'letthemeatspam.com', 'mailtothis.com', 'reallymymail.com',
  'reconmail.com', 'safetymail.info', 'sendspamhere.com', 'sogetthis.com', 'spambooger.com', 'spamherelots.com',
  'spamhereplease.com', 'suremail.info', 'thisisnotmyrealemail.com', 'tradermail.info', 'veryrealemail.com',
  'zippymail.info',
  // Guerrilla Mail
  'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz', 'guerrillamail.de',
  'guerrillamail.info', 'guerrillamailblock.com', 'sharklasers.com', 'grr.la', 'pokemail.net', 'spam4.me',
  // YOPmail
  'yopmail.com', 'yopmail.net', 'yopmail.fr', 'cool.fr.nf', 'jetable.fr.nf', 'courriel.fr.nf', 'moncourrier.fr.nf',
  'monemail.fr.nf', 'monmail.fr.nf', 'nospam.ze.tc', 'nomail.xl.cx', 'mega.zik.dyndns.org',
  // Fake Mail Generator
  'armyspy.com', 'cuvox.de', 'dayrep.com', 'einrot.com', 'fleckens.hu', 'gustr.com', 'jourrapide.com', 'rhyta.com',
  'superrito.com', 'teleworm.us', 'fakemailgenerator.com',
  // 1secmail
  '1secmail.com', '1secmail.net', '1secmail.org', 'esiix.com', 'wwjmp.com', 'xojxe.com', 'yoggm.com',
  // Trashmail and Wegwerfmail
  'trashmail.com', 'trashmail.net', 'trashmail.de', 'trashmail.at', 'trashmail.me', 'trash-mail.com',
  'wegwerfmail.de', 'wegwerfmail.net', 'wegwerfmail.org', 'wegwerfemail.de',
  // Everything else
  '10minutemail.com', '10minutemail.net', '20minutemail.com', '10mail.org', 'temp-mail.org', 'temp-mail.io',
  'tempmail.net', 'tempmailo.com', 'tempail.com', 'tempr.email', 'tempinbox.com', 'tempmailaddress.com',
  'discard.email', 'discardmail.com', 'dispostable.com', 'throwawaymail.com', 'getnada.com', 'maildrop.cc',
  'mailnesia.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com', 'fakeinbox.com', 'mailcatch.com',
  'mytemp.email', 'burnermail.io', 'spamgourmet.com', 'inboxkitten.com', 'harakirimail.com', 'moakt.com',
  'mailexpire.com', 'dropmail.me', 'emltmp.com', 'spambox.us', 'mailpoof.com', 'emailfake.com',
  'linshiyouxiang.net', 'mailforspam.com', 'getairmail.com', 'anonbox.net', 'incognitomail.org', 'mailnull.com',
  'spamex.com', 'jetable.org', 'mt2015.com', 'trbvm.com', 'filzmail.com',
]);

const SET = new Set(DISPOSABLE_DOMAINS);

/** True when the domain, or a domain it sits under (x.mailinator.com), is a throwaway inbox service. */
export function isDisposableDomain(domain, extra) {
  let d = String(domain).toLowerCase();
  for (;;) {
    if (SET.has(d) || extra?.has(d)) return true;
    const dot = d.indexOf('.');
    if (dot === -1 || d.indexOf('.', dot + 1) === -1) return false;
    d = d.slice(dot + 1);
  }
}
