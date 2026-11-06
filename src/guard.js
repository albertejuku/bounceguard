// The guard: checks addresses before you send, learns from what your email provider reports afterwards,
// keeps the suppression list, and pauses sending before your bounce or complaint rate gets your account paused.
import { parseAddress } from './syntax.js';
import { suggestDomain, repairDomain, isFreeProvider } from './typos.js';
import { isDisposableDomain } from './disposable.js';
import { isRoleAddress } from './roles.js';
import { createResolver, lookupMail } from './dns.js';
import { probeMailboxes } from './smtp.js';
import { Limiter } from './limiter.js';
import { Reputation } from './reputation.js';
import { MemoryStore } from './store.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_RECHECK = Object.freeze({
  delivered: 180 * DAY, // delivered to before
  deliverable: 90 * DAY, // mailbox confirmed by its server
  risky: 30 * DAY,
  unknown: DAY,
  undeliverable: 365 * DAY, // the server said the mailbox doesn't exist
  domain: 7 * DAY, // the domain doesn't exist or takes no mail
  error: HOUR, // a lookup or connection failed
});

const DOMAIN_REASONS = new Set(['no_domain', 'null_mx', 'no_mail_server']);
const ERROR_REASONS = new Set(['dns_error', 'smtp_unreachable', 'smtp_error']);

const BASE_SCORE = {
  trusted_domain: 100,
  delivered_before: 95,
  mailbox_exists: 90,
  accept_all: 60,
  role_account: 50,
  mailbox_full: 40,
  typo: 30,
  disposable: 20,
};

const MESSAGES = {
  trusted_domain: 'The domain is on your trusted list.',
  no_domain: "The domain doesn't exist.",
  null_mx: 'The domain says it accepts no email.',
  no_mail_server: 'The domain has no mail server.',
  mailbox_not_found: "The mail server says this mailbox doesn't exist.",
  hard_bounce: 'Mail to this address bounced permanently.',
  mailbox_full: 'The mailbox is full.',
  accept_all: "The domain accepts mail for any address, so this mailbox can't be confirmed.",
  disposable: 'This is a throwaway (disposable) address.',
  role_account: 'This is a shared role address, like info@ or admin@.',
  mailbox_exists: 'The mail server confirmed this mailbox.',
  delivered_before: 'Mail to this address has been delivered before.',
  smtp_disabled: "The domain takes mail. The mailbox itself wasn't checked (no probe sender is set).",
  smtp_unreachable: "Couldn't reach the domain's mail server on port 25 (many cloud hosts block it).",
  smtp_blocked: 'The mail server refused to answer the check (policy or blocklist), so the mailbox is unconfirmed.',
  smtp_temporary: 'The mail server asked to try again later (greylisting or a temporary error).',
  smtp_unverifiable: "The mail server doesn't confirm mailboxes.",
  smtp_error: 'The mail server gave an unexpected answer.',
  dns_error: "Couldn't look up the domain's mail servers just now.",
  sender_paused: 'Sending is paused: your bounce or complaint rate is too high.',
};

const SUPPRESSION_MESSAGES = {
  hard_bounce: 'Suppressed: an earlier email to this address bounced permanently.',
  soft_bounces: 'Suppressed for now: recent emails to this address kept soft-bouncing.',
  complaint: 'Suppressed: the recipient marked an email as spam.',
  unsubscribed: 'Suppressed: the recipient unsubscribed.',
  provider_suppressed: 'Suppressed: your email provider has this address on its suppression list.',
  manual: 'Suppressed by you.',
};

// A stronger reason replaces a weaker one; a delivery only lifts the deliverability ones.
const SUPPRESSION_RANK = { soft_bounces: 0, hard_bounce: 1, provider_suppressed: 1, manual: 2, unsubscribed: 3, complaint: 4 };
const LIFTED_BY_DELIVERY = new Set(['soft_bounces', 'hard_bounce', 'provider_suppressed']);
const rankOf = (reason) => SUPPRESSION_RANK[reason] ?? SUPPRESSION_RANK.manual;

function newRecord(parsed, now) {
  return {
    address: parsed.address,
    domain: parsed.domain,
    sent: 0,
    delivered: 0,
    hardBounces: 0,
    softBounces: 0,
    consecutiveSoftBounces: 0,
    complaints: 0,
    lastSentAt: null,
    lastDeliveredAt: null,
    lastBounceAt: null,
    lastBounceDiagnostic: null,
    lastEngagedAt: null,
    suppressed: false,
    suppressedReason: null,
    suppressedAt: null,
    suppressedUntil: null,
    check: null,
    createdAt: now,
    updatedAt: now,
  };
}

function activeSuppression(record, now) {
  if (!record?.suppressed) return null;
  if (record.suppressedUntil && record.suppressedUntil <= now) return null;
  return { reason: record.suppressedReason, at: record.suppressedAt, until: record.suppressedUntil ?? null };
}

function applySuppression(record, reason, now, until = null) {
  const current = activeSuppression(record, now);
  if (current) {
    const permanentNow = !current.until;
    if (permanentNow && until) return; // a permanent suppression outlives a temporary one
    if (permanentNow && rankOf(current.reason) >= rankOf(reason)) return;
  }
  Object.assign(record, { suppressed: true, suppressedReason: reason, suppressedAt: now, suppressedUntil: until });
}

function clearSuppression(record) {
  Object.assign(record, { suppressed: false, suppressedReason: null, suppressedAt: null, suppressedUntil: null });
}

function smtpOptions(options) {
  if (!options) return null;
  const from = parseAddress(options.from ?? '');
  if (!from.valid) {
    throw new TypeError(`smtp.from must be an address on a domain you control, like verify@yourdomain.com (${from.message})`);
  }
  const helo = String(options.helo ?? from.domain).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(helo)) throw new TypeError('smtp.helo must be a hostname');
  return Object.freeze({
    from: from.address,
    helo,
    port: options.port ?? 25,
    connectTimeout: options.connectTimeout ?? 10_000,
    commandTimeout: options.commandTimeout ?? 15_000,
    maxHosts: options.maxHosts ?? 2,
    recipientsPerSession: options.recipientsPerSession ?? 25,
    detectAcceptAll: options.detectAcceptAll !== false,
  });
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export class BounceGuard {
  #domains = new Map();

  constructor(options = {}) {
    this.store = options.store ?? new MemoryStore();
    this.now = options.now ?? Date.now;
    this.resolver = options.dns?.resolver ?? createResolver(options.dns);
    this.smtp = smtpOptions(options.smtp);
    this.policy = Object.freeze({ sendRisky: true, sendUnknown: true, allowDisposable: false, allowRole: true, ...options.policy });
    this.recheck = Object.freeze({ ...DEFAULT_RECHECK, ...options.recheck });
    this.softBounceLimit = options.softBounceLimit ?? 3;
    this.softBounceSuppression = options.softBounceSuppression ?? 30 * DAY;
    this.trustedDomains = new Set((options.trustedDomains ?? []).map((d) => String(d).toLowerCase()));
    this.disposableDomains = new Set((options.disposableDomains ?? []).map((d) => String(d).toLowerCase()));
    this.limiter = new Limiter({ concurrency: options.concurrency ?? 10, perKey: 1, minInterval: options.serverInterval ?? 1000 });
    const reputation = options.reputation === false ? null : (options.reputation ?? {});
    this.reputation = reputation ? new Reputation({ ...reputation, now: this.now }) : null;
    this.pauseOnBadReputation = Boolean(reputation) && reputation.pause !== false;
  }

  // ---- Checking ---------------------------------------------------------------------------------------

  /** Checks one address. See checkMany for the result shape. */
  async check(email, options) {
    const [result] = await this.checkMany([email], options);
    return result;
  }

  /**
   * Checks addresses, in input order. Duplicates are checked once, addresses on the same mail server share
   * one SMTP connection, and servers are asked one session at a time with a pause in between.
   */
  async checkMany(emails, { fresh = false } = {}) {
    if (!Array.isArray(emails)) throw new TypeError('checkMany expects an array of addresses');
    const now = this.now();
    const paused = this.#paused();
    const out = new Array(emails.length);
    const entries = new Map();

    emails.forEach((email, i) => {
      const parsed = parseAddress(email);
      if (!parsed.valid) {
        out[i] = this.#result(email, null, this.#invalid(parsed), null, paused);
        return;
      }
      let entry = entries.get(parsed.key);
      if (!entry) entries.set(parsed.key, (entry = { parsed, indices: [] }));
      entry.indices.push(i);
    });

    const needNetwork = [];
    for (const entry of entries.values()) {
      entry.record = await this.store.get(entry.parsed.key);
      entry.outcome = this.#offline(entry, now, fresh);
      if (!entry.outcome) needNetwork.push(entry);
    }

    const domains = [...new Set(needNetwork.map((e) => e.parsed.domain))];
    await mapLimit(domains, 20, (domain) => this.#mail(domain));
    const needSmtp = [];
    for (const entry of needNetwork) {
      entry.mail = await this.#mail(entry.parsed.domain);
      entry.outcome = this.#afterDns(entry);
      if (!entry.outcome) needSmtp.push(entry);
    }
    await this.#probeAll(needSmtp);

    for (const entry of entries.values()) {
      if (entry.outcome.cache) await this.#saveCheck(entry, now);
      const result = this.#result(null, entry.parsed, entry.outcome, entry.record, paused);
      for (const i of entry.indices) out[i] = { ...result, email: emails[i], flags: { ...result.flags } };
    }
    return out;
  }

  /**
   * Splits a list into addresses to send to (normalised, de-duplicated) and the ones held back, with reasons.
   */
  async filter(emails, options) {
    const results = await this.checkMany(emails, options);
    const send = [];
    const hold = [];
    const seen = new Set();
    for (const result of results) {
      const key = result.address?.toLowerCase() ?? `invalid:${result.email}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (result.send) send.push(result.address);
      else hold.push(result);
    }
    return { send, hold, results };
  }

  #invalid(parsed) {
    let suggestion = null;
    if (parsed.local && parsed.domain && parseAddress(`${parsed.local}@example.com`).valid) {
      const domain = repairDomain(parsed.domain);
      if (domain) suggestion = `${parsed.local}@${domain}`;
    }
    return { verdict: 'undeliverable', reason: 'invalid_syntax', message: parsed.message, suggestion, flags: {} };
  }

  #offline(entry, now, fresh) {
    const { parsed, record } = entry;
    const flags = {
      free: isFreeProvider(parsed.domain),
      role: isRoleAddress(parsed.local),
      disposable: isDisposableDomain(parsed.domain, this.disposableDomains),
      typo: false,
      acceptAll: null,
    };
    entry.flags = flags;
    const suppressed = activeSuppression(record, now);
    if (suppressed) return { verdict: record.check?.verdict ?? 'unknown', reason: 'suppressed', suppressed, flags };
    if (this.#trusted(parsed.domain)) return { verdict: 'deliverable', reason: 'trusted_domain', flags };
    if (!fresh && record?.check && record.check.nextCheckAt > now) {
      const check = record.check;
      return { ...check, flags: { ...flags, ...check.flags }, cached: true };
    }
    if (flags.disposable) return { verdict: 'risky', reason: 'disposable', flags, cache: true };
    const domain = suggestDomain(parsed.domain);
    if (domain) {
      flags.typo = true;
      entry.suggestion = `${parsed.local}@${domain}`;
    }
    return null;
  }

  #afterDns(entry) {
    const { mail, flags } = entry;
    const base = { flags, suggestion: entry.suggestion ?? null, mx: mail.hosts[0]?.exchange ?? null, cache: true };
    if (mail.status === 'no_domain') return { ...base, verdict: 'undeliverable', reason: 'no_domain' };
    if (mail.status === 'null_mx') return { ...base, verdict: 'undeliverable', reason: 'null_mx' };
    if (mail.status === 'no_mail') return { ...base, verdict: 'undeliverable', reason: 'no_mail_server' };
    if (mail.status === 'error') return this.#typo(entry, { ...base, verdict: 'unknown', reason: 'dns_error' });
    if (!this.smtp) return this.#typo(entry, { ...base, verdict: 'unknown', reason: 'smtp_disabled', cache: false });
    if (this.#acceptAll(entry.parsed.domain) === true) {
      flags.acceptAll = true;
      return this.#typo(entry, { ...base, verdict: 'risky', reason: 'accept_all' });
    }
    return null;
  }

  async #probeAll(entries) {
    const groups = new Map();
    for (const entry of entries) {
      const server = entry.mail.hosts[0].exchange;
      if (!groups.has(server)) groups.set(server, []);
      groups.get(server).push(entry);
    }
    const size = Math.max(1, this.smtp?.recipientsPerSession ?? 25);
    const sessions = [];
    for (const [server, group] of groups) {
      for (let i = 0; i < group.length; i += size) {
        const chunk = group.slice(i, i + size);
        sessions.push(this.limiter.run(server, () => this.#probeChunk(chunk)));
      }
    }
    await Promise.all(sessions);
  }

  async #probeChunk(chunk) {
    // A session queued behind another may find its domains already known to accept everything.
    const ask = [];
    for (const entry of chunk) {
      entry.outcome = this.#afterDns(entry);
      if (!entry.outcome) ask.push(entry);
    }
    if (!ask.length) return;

    const smtp = this.smtp;
    let report;
    try {
      report = await probeMailboxes({
        hosts: ask[0].mail.hosts.slice(0, Math.max(1, smtp.maxHosts)).map((h) => h.exchange),
        recipients: ask.map((e) => e.parsed.address),
        from: smtp.from,
        helo: smtp.helo,
        port: smtp.port,
        connectTimeout: smtp.connectTimeout,
        commandTimeout: smtp.commandTimeout,
        detectAcceptAll: smtp.detectAcceptAll,
      });
    } catch (err) {
      report = { results: new Map(ask.map((e) => [e.parsed.address, { status: 'error', message: err.message }])), acceptAll: new Map() };
    }
    for (const [domain, value] of report.acceptAll) if (value !== null) this.#rememberAcceptAll(domain, value);
    for (const entry of ask) {
      entry.outcome = this.#fromSmtp(entry, report.results.get(entry.parsed.address), report.acceptAll.get(entry.parsed.domain) ?? null);
    }
  }

  #fromSmtp(entry, answer, acceptAll) {
    const { flags } = entry;
    const smtp = answer?.code ? { host: answer.host, code: answer.code, enhanced: answer.enhanced ?? null, message: answer.message } : null;
    const base = { flags, suggestion: entry.suggestion ?? null, mx: entry.mail.hosts[0].exchange, smtp, cache: true };
    switch (answer?.status) {
      case 'accepted':
        flags.acceptAll = acceptAll;
        if (acceptAll === true) return this.#typo(entry, { ...base, verdict: 'risky', reason: 'accept_all' });
        return this.#typo(entry, { ...base, verdict: 'deliverable', reason: 'mailbox_exists' });
      case 'rejected':
        return { ...base, verdict: 'undeliverable', reason: 'mailbox_not_found' };
      case 'full':
        return { ...base, verdict: 'risky', reason: 'mailbox_full' };
      case 'blocked':
        return this.#typo(entry, { ...base, verdict: 'unknown', reason: 'smtp_blocked' });
      case 'temporary':
        return this.#typo(entry, { ...base, verdict: 'unknown', reason: 'smtp_temporary' });
      case 'unverifiable':
        return this.#typo(entry, { ...base, verdict: 'unknown', reason: 'smtp_unverifiable' });
      case 'unreachable':
        return this.#typo(entry, { ...base, verdict: 'unknown', reason: 'smtp_unreachable' });
      default:
        return this.#typo(entry, { ...base, verdict: 'unknown', reason: 'smtp_error' });
    }
  }

  // A likely typo outranks "couldn't confirm" and even "mailbox exists": the person most likely meant the other domain.
  #typo(entry, outcome) {
    if (entry.flags.typo && (outcome.verdict === 'unknown' || outcome.verdict === 'deliverable' || outcome.reason === 'accept_all')) {
      return { ...outcome, verdict: 'risky', reason: 'typo' };
    }
    return outcome;
  }

  #result(email, parsed, outcome, record, paused) {
    let { verdict, reason } = outcome;
    const flags = { free: false, role: false, disposable: false, typo: false, acceptAll: null, ...outcome.flags };
    if (flags.role && !this.policy.allowRole && reason !== 'suppressed' && verdict !== 'undeliverable') {
      verdict = 'risky';
      reason = 'role_account';
    }
    let send = this.#shouldSend(verdict, reason);
    let message;
    if (reason === 'suppressed') {
      message = SUPPRESSION_MESSAGES[outcome.suppressed.reason] ?? `Suppressed: ${outcome.suppressed.reason}.`;
    } else if (reason === 'typo') {
      message = `The domain looks like a typo of ${outcome.suggestion.slice(outcome.suggestion.lastIndexOf('@') + 1)}.`;
    } else {
      message = outcome.message ?? MESSAGES[reason];
    }
    const score = this.#score(verdict, reason, record);
    if (send && paused) {
      send = false;
      reason = 'sender_paused';
      message = MESSAGES.sender_paused;
    }
    return {
      email,
      address: parsed?.address ?? null,
      domain: parsed?.domain ?? null,
      verdict,
      send,
      reason,
      message,
      score,
      suggestion: outcome.suggestion ?? null,
      flags,
      suppressed: outcome.suppressed ?? null,
      mx: outcome.mx ?? null,
      smtp: outcome.smtp ?? null,
      cached: Boolean(outcome.cached),
      checkedAt: outcome.checkedAt ?? this.now(),
    };
  }

  #shouldSend(verdict, reason) {
    if (reason === 'suppressed') return false;
    if (verdict === 'deliverable') return true;
    if (verdict === 'undeliverable') return false;
    if (verdict === 'unknown') return Boolean(this.policy.sendUnknown);
    if (reason === 'disposable') return Boolean(this.policy.allowDisposable);
    if (reason === 'role_account') return false;
    return Boolean(this.policy.sendRisky);
  }

  #score(verdict, reason, record) {
    if (reason === 'suppressed' || verdict === 'undeliverable') return 0;
    let score = BASE_SCORE[reason] ?? 50;
    if (record) score += Math.min(record.delivered ?? 0, 5) - (record.consecutiveSoftBounces ?? 0) * 15;
    return Math.max(0, Math.min(100, score));
  }

  #ttl(outcome) {
    const { verdict, reason } = outcome;
    if (verdict === 'deliverable') return reason === 'delivered_before' ? this.recheck.delivered : this.recheck.deliverable;
    if (verdict === 'undeliverable') return DOMAIN_REASONS.has(reason) ? this.recheck.domain : this.recheck.undeliverable;
    if (verdict === 'risky') return this.recheck.risky;
    return ERROR_REASONS.has(reason) ? this.recheck.error : this.recheck.unknown;
  }

  async #saveCheck(entry, now) {
    const { outcome, parsed } = entry;
    const record = (await this.store.get(parsed.key)) ?? newRecord(parsed, now);
    record.check = {
      verdict: outcome.verdict,
      reason: outcome.reason,
      suggestion: outcome.suggestion ?? null,
      flags: { ...outcome.flags },
      mx: outcome.mx ?? null,
      smtp: outcome.smtp ?? null,
      checkedAt: now,
      nextCheckAt: now + this.#ttl(outcome),
    };
    record.updatedAt = now;
    await this.store.set(parsed.key, record);
    entry.record = record;
    outcome.checkedAt = now;
  }

  #trusted(domain) {
    for (let d = domain; d; ) {
      if (this.trustedDomains.has(d)) return true;
      const dot = d.indexOf('.');
      d = dot === -1 ? '' : d.slice(dot + 1);
    }
    return false;
  }

  #paused() {
    return Boolean(this.reputation && this.pauseOnBadReputation && this.reputation.stats().status === 'paused');
  }

  #domain(domain) {
    let info = this.#domains.get(domain);
    if (info) {
      this.#domains.delete(domain); // keep recently used domains at the end
    } else {
      info = {};
    }
    this.#domains.set(domain, info);
    if (this.#domains.size > 10_000) this.#domains.delete(this.#domains.keys().next().value);
    return info;
  }

  #mail(domain) {
    const info = this.#domain(domain);
    if (info.mail && info.mailExpires > this.now()) return Promise.resolve(info.mail);
    if (info.pending) return info.pending;
    info.pending = lookupMail(domain, this.resolver)
      .catch((err) => ({ status: 'error', hosts: [], error: err?.code || String(err?.message || err) }))
      .then((mail) => {
        info.mail = mail;
        info.mailExpires = this.now() + (mail.status === 'error' ? MINUTE : HOUR);
        info.pending = null;
        return mail;
      });
    return info.pending;
  }

  #acceptAll(domain) {
    const info = this.#domains.get(domain);
    return info && info.acceptAllExpires > this.now() ? info.acceptAll : null;
  }

  #rememberAcceptAll(domain, value) {
    const info = this.#domain(domain);
    info.acceptAll = value;
    info.acceptAllExpires = this.now() + DAY;
  }

  // ---- Learning from what happened -----------------------------------------------------------------------

  async #update(email, change) {
    const parsed = parseAddress(email);
    if (!parsed.valid) return null;
    const now = this.now();
    const record = (await this.store.get(parsed.key)) ?? newRecord(parsed, now);
    change(record, now);
    record.updatedAt = now;
    await this.store.set(parsed.key, record);
    return record;
  }

  /** Call once per email you send (or feed your provider's send events to record()). */
  recordSent(email) {
    this.reputation?.add('sent');
    return this.#update(email, (record, now) => {
      record.sent++;
      record.lastSentAt = now;
    });
  }

  /** The provider delivered to this address: it works, and any bounce-based suppression is lifted. */
  recordDelivered(email) {
    this.reputation?.add('delivered');
    return this.#update(email, (record, now) => {
      record.delivered++;
      record.lastDeliveredAt = now;
      record.consecutiveSoftBounces = 0;
      if (activeSuppression(record, now) && LIFTED_BY_DELIVERY.has(record.suppressedReason)) clearSuppression(record);
      record.check = {
        verdict: 'deliverable',
        reason: 'delivered_before',
        suggestion: null,
        flags: { ...record.check?.flags, typo: false },
        mx: record.check?.mx ?? null,
        smtp: record.check?.smtp ?? null,
        checkedAt: now,
        nextCheckAt: now + this.recheck.delivered,
      };
    });
  }

  /**
   * A bounce. type 'hard' (permanent) suppresses the address; 'soft' (temporary) suppresses it for
   * `softBounceSuppression` after `softBounceLimit` in a row with no delivery in between.
   */
  recordBounce(email, { type = 'hard', diagnostic = null } = {}) {
    const hard = !/^(soft|transient|temporary|undetermined)$/i.test(String(type));
    this.reputation?.add(hard ? 'bounce' : 'softBounce');
    return this.#update(email, (record, now) => {
      record.lastBounceAt = now;
      record.lastBounceDiagnostic = diagnostic ?? null;
      if (hard) {
        record.hardBounces++;
        applySuppression(record, 'hard_bounce', now);
        record.check = {
          verdict: 'undeliverable',
          reason: 'hard_bounce',
          suggestion: null,
          flags: { ...record.check?.flags },
          mx: record.check?.mx ?? null,
          smtp: record.check?.smtp ?? null,
          checkedAt: now,
          nextCheckAt: now + this.recheck.undeliverable,
        };
      } else {
        record.softBounces++;
        record.consecutiveSoftBounces++;
        if (record.consecutiveSoftBounces >= this.softBounceLimit) {
          applySuppression(record, 'soft_bounces', now, now + this.softBounceSuppression);
        }
      }
    });
  }

  /** The recipient marked an email as spam: never send to them again. */
  recordComplaint(email) {
    this.reputation?.add('complaint');
    return this.#update(email, (record, now) => {
      record.complaints++;
      applySuppression(record, 'complaint', now);
    });
  }

  /** The recipient unsubscribed. */
  recordUnsubscribe(email) {
    return this.#update(email, (record, now) => applySuppression(record, 'unsubscribed', now));
  }

  /** Opens and clicks prove the mailbox works, so they reset the soft-bounce count. */
  recordEngagement(email) {
    return this.#update(email, (record, now) => {
      record.lastEngagedAt = now;
      record.consecutiveSoftBounces = 0;
      if (activeSuppression(record, now) && record.suppressedReason === 'soft_bounces') clearSuppression(record);
    });
  }

  /** Feeds one normalised event (from the webhook parsers) into the guard. */
  record(event) {
    if (!event?.email) return Promise.resolve(null);
    switch (event.type) {
      case 'sent':
        return this.recordSent(event.email);
      case 'delivered':
        return this.recordDelivered(event.email);
      case 'bounce':
        return this.recordBounce(event.email, { type: event.bounce ?? 'hard', diagnostic: event.diagnostic ?? null });
      case 'complaint':
        return this.recordComplaint(event.email);
      case 'unsubscribe':
        return this.recordUnsubscribe(event.email);
      case 'suppressed':
        return this.suppress(event.email, 'provider_suppressed');
      case 'open':
      case 'click':
        return this.recordEngagement(event.email);
      default:
        return Promise.resolve(null); // deferred, other: nothing to learn
    }
  }

  /** Feeds a list of events, in order. */
  async recordEvents(events) {
    for (const event of events ?? []) await this.record(event);
  }

  /** Suppresses an address yourself. `until` (ms timestamp) makes it temporary. */
  suppress(email, reason = 'manual', { until = null } = {}) {
    return this.#update(email, (record, now) => applySuppression(record, reason, now, until));
  }

  /** Lifts a suppression and forgets the last check, so the next check asks the mail server again. */
  unsuppress(email) {
    return this.#update(email, (record) => {
      clearSuppression(record);
      record.consecutiveSoftBounces = 0;
      record.check = null;
    });
  }

  async isSuppressed(email) {
    const parsed = parseAddress(email);
    if (!parsed.valid) return false;
    return Boolean(activeSuppression(await this.store.get(parsed.key), this.now()));
  }

  /** Everything the guard knows about an address, or null. */
  async get(email) {
    const parsed = parseAddress(email);
    return parsed.valid ? this.store.get(parsed.key) : null;
  }

  /** Bounce and complaint rates over the reputation window, and whether sending is paused. */
  health() {
    if (!this.reputation) return null;
    return { ...this.reputation.stats(), pauses: this.pauseOnBadReputation };
  }
}

export function createGuard(options) {
  return new BounceGuard(options);
}
