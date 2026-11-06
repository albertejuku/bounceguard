// Domain typo suggestions (gmial.com -> gmail.com, yahoo.con -> yahoo.com). A suggestion is only made
// against well-known mailbox providers, comparing the name and the ending separately, so real domains
// that happen to look alike (live.co.za, mi.com, mail.com) are left alone.

// Most popular first: on a tie the earlier provider wins.
export const FREE_PROVIDERS = Object.freeze([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'live.com', 'msn.com',
  'me.com', 'mac.com', 'googlemail.com', 'ymail.com', 'rocketmail.com', 'proton.me', 'protonmail.com', 'pm.me',
  'zoho.com', 'zohomail.com', 'gmx.com', 'gmx.net', 'gmx.de', 'mail.com', 'email.com', 'yandex.com', 'yandex.ru',
  'mail.ru', 'inbox.ru', 'list.ru', 'bk.ru', 'web.de', 't-online.de', 'freenet.de', 'qq.com', '163.com', '126.com',
  'sina.com', 'naver.com', 'daum.net', 'hanmail.net', 'yahoo.co.uk', 'yahoo.co.in', 'yahoo.fr', 'yahoo.de',
  'yahoo.co.jp', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'hotmail.it', 'live.co.uk', 'comcast.net',
  'verizon.net', 'att.net', 'sbcglobal.net', 'cox.net', 'charter.net', 'earthlink.net', 'btinternet.com', 'sky.com',
  'virginmedia.com', 'orange.fr', 'free.fr', 'laposte.net', 'sfr.fr', 'wanadoo.fr', 'libero.it', 'virgilio.it',
  'tiscali.it', 'alice.it', 'rediffmail.com', 'uol.com.br', 'bol.com.br', 'terra.com.br', 'hey.com', 'fastmail.com',
  'tutanota.com', 'tuta.io', 'hushmail.com', 'mailfence.com', 'seznam.cz', 'wp.pl', 'o2.pl', 'interia.pl', 'onet.pl',
]);

const KNOWN = new Set(FREE_PROVIDERS);

// Endings that are typos when compared with a popular provider's ending.
const ENDING_TYPOS = {
  com: ['con', 'cmo', 'cpm', 'comm', 'ocm', 'vom', 'xom', 'cim', 'coom', 'c0m', 'comn', 'clm', 'co', 'cm', 'om'],
  net: ['nte', 'nett', 'ne', 'ner', 'met', 'nwt'],
  org: ['ogr', 'orgg', 'or', 'rog'],
  'co.uk': ['co.uj', 'co.ik', 'co.yk', 'couk', 'co.u'],
};
// Endings that are not real top-level domains, so they can be fixed on any domain (acme.con -> acme.com).
const NOT_A_TLD = { con: 'com', cmo: 'com', cpm: 'com', comm: 'com', ocm: 'com', vom: 'com', xom: 'com', cim: 'com', coom: 'com', c0m: 'com', comn: 'com', nte: 'net', nett: 'net', ogr: 'org', orgg: 'org' };

const ENDING_FIX = new Map();
for (const [right, typos] of Object.entries(ENDING_TYPOS)) for (const typo of typos) ENDING_FIX.set(typo, right);

const POPULAR = FREE_PROVIDERS.map((domain, rank) => {
  const labels = domain.split('.');
  return { domain, rank, name: labels[0], ending: labels.slice(1).join('.'), labelCount: labels.length };
});
const POPULAR_BY_NAME = new Map();
for (const p of POPULAR) if (!POPULAR_BY_NAME.has(p.name)) POPULAR_BY_NAME.set(p.name, p.domain);

/** Optimal string alignment distance (Levenshtein plus adjacent transpositions). */
export function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d = Array.from({ length: rows }, (_, i) => {
    const row = new Array(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[rows - 1][cols - 1];
}

/** True for well-known free mailbox providers (gmail.com, yahoo.com, ...). */
export function isFreeProvider(domain) {
  return KNOWN.has(String(domain).toLowerCase());
}

/** Returns the domain the person probably meant, or null. Expects a lowercase ASCII domain. */
export function suggestDomain(domain) {
  domain = String(domain).toLowerCase();
  if (KNOWN.has(domain)) return null;
  const labels = domain.split('.');
  if (labels.length < 2) return null;
  const name = labels[0];
  const ending = labels.slice(1).join('.');

  let best = null;
  for (const p of POPULAR) {
    if (p.labelCount !== labels.length) continue;
    const endingTypo = ending !== p.ending;
    if (endingTypo && ENDING_FIX.get(ending) !== p.ending) continue;
    let distance = 0;
    if (name !== p.name) {
      if (p.name.length < 5) continue; // short names (aol, me, qq) collide with real domains too easily
      distance = editDistance(name, p.name);
      if (distance > (p.name.length >= 8 ? 2 : 1)) continue;
    }
    const cost = distance + (endingTypo ? 1 : 0);
    if (cost === 0) continue;
    if (!best || cost < best.cost) best = { domain: p.domain, cost };
  }
  if (best) return best.domain;

  const fixed = NOT_A_TLD[labels[labels.length - 1]];
  return fixed ? [...labels.slice(0, -1), fixed].join('.') : null;
}

/**
 * Best guess at what a broken domain was meant to be ("gmail" -> gmail.com, "gmail,com" -> gmail.com), or null.
 */
export function repairDomain(raw) {
  if (typeof raw !== 'string') return null;
  const d = raw.trim().toLowerCase().replace(/[,;\s]+/g, '.').replace(/\.{2,}/g, '.').replace(/^\.|\.$/g, '');
  if (!d || /[^a-z0-9.-]/.test(d)) return null;
  if (!d.includes('.')) return POPULAR_BY_NAME.get(d) ?? null;
  if (KNOWN.has(d)) return d;
  return suggestDomain(d);
}
