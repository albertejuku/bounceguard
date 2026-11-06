export type Verdict = 'deliverable' | 'undeliverable' | 'risky' | 'unknown';

export type Reason =
  | 'trusted_domain'
  | 'invalid_syntax'
  | 'suppressed'
  | 'no_domain'
  | 'null_mx'
  | 'no_mail_server'
  | 'mailbox_not_found'
  | 'hard_bounce'
  | 'mailbox_full'
  | 'accept_all'
  | 'disposable'
  | 'typo'
  | 'role_account'
  | 'mailbox_exists'
  | 'delivered_before'
  | 'smtp_disabled'
  | 'smtp_unreachable'
  | 'smtp_blocked'
  | 'smtp_temporary'
  | 'smtp_unverifiable'
  | 'smtp_error'
  | 'dns_error'
  | 'sender_paused';

export type SuppressionReason = 'hard_bounce' | 'soft_bounces' | 'complaint' | 'unsubscribed' | 'provider_suppressed' | 'manual' | (string & {});

export interface CheckResult {
  /** The address exactly as given. */
  email: string;
  /** Normalised address (domain lowercased, punycode), or null when the syntax is invalid. */
  address: string | null;
  domain: string | null;
  verdict: Verdict;
  /** Whether to send, after applying your policy, suppressions and the reputation pause. */
  send: boolean;
  reason: Reason;
  /** One plain sentence explaining the reason. */
  message: string;
  /** 0-100, higher is safer. */
  score: number;
  /** "Did you mean" address for typos and broken domains, or null. */
  suggestion: string | null;
  flags: { free: boolean; role: boolean; disposable: boolean; typo: boolean; acceptAll: boolean | null };
  suppressed: { reason: SuppressionReason; at: number; until: number | null } | null;
  /** The primary mail server. */
  mx: string | null;
  /** The mail server's answer to RCPT TO, when it was asked. */
  smtp: { host: string; code: number; enhanced: string | null; message: string } | null;
  /** True when this came from the store instead of a fresh check. */
  cached: boolean;
  checkedAt: number;
}

export interface AddressRecord {
  address: string;
  domain: string;
  sent: number;
  delivered: number;
  hardBounces: number;
  softBounces: number;
  consecutiveSoftBounces: number;
  complaints: number;
  lastSentAt: number | null;
  lastDeliveredAt: number | null;
  lastBounceAt: number | null;
  lastBounceDiagnostic: string | null;
  lastEngagedAt: number | null;
  suppressed: boolean;
  suppressedReason: SuppressionReason | null;
  suppressedAt: number | null;
  suppressedUntil: number | null;
  check: {
    verdict: Verdict;
    reason: Reason;
    suggestion: string | null;
    flags: Partial<CheckResult['flags']>;
    mx: string | null;
    smtp: CheckResult['smtp'];
    checkedAt: number;
    nextCheckAt: number;
  } | null;
  createdAt: number;
  updatedAt: number;
}

export interface Store {
  get(key: string): Promise<AddressRecord | null>;
  set(key: string, record: AddressRecord): Promise<void>;
}

export interface DnsResolver {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolve4(domain: string): Promise<string[]>;
  resolve6(domain: string): Promise<string[]>;
}

export interface ReputationOptions {
  /** Sliding window. Default 7 days. */
  windowMs?: number;
  bucketMs?: number;
  /** Emails needed in the window before a warning or pause. Default 100. */
  minSample?: number;
  /** Default 0.05 */
  bounceWarn?: number;
  /** Default 0.10 */
  bouncePause?: number;
  /** Default 0.001 */
  complaintWarn?: number;
  /** Default 0.005 */
  complaintPause?: number;
  state?: { buckets: [number, Record<string, number>][] } | null;
}

export interface GuardOptions {
  /** Where address records live. Default: in memory. */
  store?: Store;
  /** Ask mail servers whether mailboxes exist. Off unless `from` is set. */
  smtp?: {
    /** An address on a domain you control. Required to probe. */
    from: string;
    /** Hostname to EHLO with. Default: the domain of `from`. */
    helo?: string;
    port?: number;
    connectTimeout?: number;
    commandTimeout?: number;
    /** How many of a domain's MX hosts to try. Default 2. */
    maxHosts?: number;
    /** Addresses asked about per connection. Default 25. */
    recipientsPerSession?: number;
    /** Probe a random address to detect accept-all domains. Default true. */
    detectAcceptAll?: boolean;
  };
  dns?: { resolver?: DnsResolver; timeout?: number; tries?: number; servers?: string[] };
  policy?: {
    /** Send to risky addresses (accept-all, full mailbox, typo). Default true. */
    sendRisky?: boolean;
    /** Send when the mailbox couldn't be checked. Default true. */
    sendUnknown?: boolean;
    /** Default false. */
    allowDisposable?: boolean;
    /** Default true. */
    allowRole?: boolean;
  };
  /** How long each kind of result is trusted, in ms. */
  recheck?: Partial<Record<'delivered' | 'deliverable' | 'risky' | 'unknown' | 'undeliverable' | 'domain' | 'error', number>>;
  /** Soft bounces in a row (no delivery between) before suppressing. Default 3. */
  softBounceLimit?: number;
  /** How long a soft-bounce suppression lasts, in ms. Default 30 days. */
  softBounceSuppression?: number;
  /** Domains (and their subdomains) that skip every check except suppression. */
  trustedDomains?: string[];
  /** Extra throwaway domains. */
  disposableDomains?: string[];
  /** Parallel SMTP sessions. Default 10. */
  concurrency?: number;
  /** Pause between sessions to the same mail server, in ms. Default 1000. */
  serverInterval?: number;
  /** Bounce and complaint tracking; `pause: false` reports without pausing; `false` turns it off. */
  reputation?: (ReputationOptions & { pause?: boolean }) | false;
  /** Clock, for tests. */
  now?: () => number;
}

export type EventType = 'sent' | 'delivered' | 'bounce' | 'complaint' | 'unsubscribe' | 'suppressed' | 'deferred' | 'open' | 'click' | 'other';

export interface DeliveryEvent {
  provider: string;
  type: EventType;
  email: string | null;
  bounce: 'hard' | 'soft' | null;
  diagnostic: string | null;
  messageId: string | null;
  timestamp: number | null;
}

export interface ReputationStats {
  status: 'ok' | 'warning' | 'paused';
  reasons: string[];
  sent: number;
  delivered: number;
  bounces: number;
  softBounces: number;
  complaints: number;
  sample: number;
  bounceRate: number;
  complaintRate: number;
  windowMs: number;
}

export class BounceGuard {
  constructor(options?: GuardOptions);
  readonly store: Store;
  readonly reputation: Reputation | null;
  check(email: string, options?: { fresh?: boolean }): Promise<CheckResult>;
  checkMany(emails: string[], options?: { fresh?: boolean }): Promise<CheckResult[]>;
  filter(emails: string[], options?: { fresh?: boolean }): Promise<{ send: string[]; hold: CheckResult[]; results: CheckResult[] }>;
  recordSent(email: string): Promise<AddressRecord | null>;
  recordDelivered(email: string): Promise<AddressRecord | null>;
  recordBounce(email: string, options?: { type?: 'hard' | 'soft' | string; diagnostic?: string | null }): Promise<AddressRecord | null>;
  recordComplaint(email: string): Promise<AddressRecord | null>;
  recordUnsubscribe(email: string): Promise<AddressRecord | null>;
  recordEngagement(email: string): Promise<AddressRecord | null>;
  record(event: Partial<DeliveryEvent> & { type: EventType; email: string | null }): Promise<AddressRecord | null>;
  recordEvents(events: Array<Partial<DeliveryEvent> & { type: EventType; email: string | null }>): Promise<void>;
  suppress(email: string, reason?: SuppressionReason, options?: { until?: number | null }): Promise<AddressRecord | null>;
  unsuppress(email: string): Promise<AddressRecord | null>;
  isSuppressed(email: string): Promise<boolean>;
  get(email: string): Promise<AddressRecord | null>;
  health(): (ReputationStats & { pauses: boolean }) | null;
}

export function createGuard(options?: GuardOptions): BounceGuard;
export const DEFAULT_RECHECK: Readonly<Record<'delivered' | 'deliverable' | 'risky' | 'unknown' | 'undeliverable' | 'domain' | 'error', number>>;

export class MemoryStore implements Store {
  get(key: string): Promise<AddressRecord | null>;
  set(key: string, record: AddressRecord): Promise<void>;
  delete(key: string): Promise<void>;
  readonly size: number;
  entries(): IterableIterator<[string, AddressRecord]>;
}

export class Reputation {
  constructor(options?: ReputationOptions & { now?: () => number });
  add(kind: 'sent' | 'delivered' | 'bounce' | 'softBounce' | 'complaint', n?: number): void;
  stats(): ReputationStats;
  reset(): void;
  toJSON(): { buckets: [number, Record<string, number>][] };
}

export class Limiter {
  constructor(options?: { concurrency?: number; perKey?: number; minInterval?: number });
  run<T>(key: string, task: () => T | Promise<T>): Promise<T>;
  readonly pending: number;
  readonly active: number;
}

export type ParsedAddress =
  | { valid: true; local: string; domain: string; address: string; key: string }
  | { valid: false; message: string; local: string | null; domain: string | null };

export function parseAddress(input: unknown): ParsedAddress;
export function isValidSyntax(input: unknown): boolean;
export function suggestDomain(domain: string): string | null;
export function repairDomain(raw: string): string | null;
export function isFreeProvider(domain: string): boolean;
export function editDistance(a: string, b: string): number;
export const FREE_PROVIDERS: readonly string[];
export function isDisposableDomain(domain: string, extra?: Set<string>): boolean;
export const DISPOSABLE_DOMAINS: readonly string[];
export function isRoleAddress(local: string): boolean;
export const ROLE_NAMES: readonly string[];

export interface MailServers {
  status: 'ok' | 'null_mx' | 'no_domain' | 'no_mail' | 'error';
  hosts: { exchange: string; priority: number }[];
  implicit?: boolean;
  error?: string;
}
export function lookupMail(domain: string, resolver: DnsResolver): Promise<MailServers>;
export function createResolver(options?: { timeout?: number; tries?: number; servers?: string[] }): DnsResolver;

export type ProbeStatus = 'accepted' | 'rejected' | 'full' | 'blocked' | 'temporary' | 'unverifiable' | 'unreachable' | 'error';
export function probeMailboxes(options: {
  hosts: string[];
  recipients: string[];
  from: string;
  helo: string;
  port?: number;
  connectTimeout?: number;
  commandTimeout?: number;
  detectAcceptAll?: boolean;
  transcript?: string[] | null;
}): Promise<{
  results: Map<string, { status: ProbeStatus; host: string | null; code?: number; enhanced?: string | null; message: string }>;
  acceptAll: Map<string, boolean | null>;
}>;
export function classifyReply(reply: { code: number; enhanced?: string | null; message?: string }): Exclude<ProbeStatus, 'unreachable'>;

type Body = string | Buffer | Uint8Array | object;
type Headers = Record<string, string | string[] | undefined> | { get(name: string): string | null };

export namespace webhooks {
  class WebhookError extends Error {
    code: 'BAD_BODY' | 'UNVERIFIABLE' | 'BAD_SIGNATURE' | 'UNKNOWN_TOPIC' | 'BAD_SUBSCRIBE_URL';
  }
  function parse(provider: 'ses' | 'sendgrid' | 'mailgun' | 'postmark' | 'resend' | 'zeptomail', body: Body): DeliveryEvent[];
  const ses: {
    parse(body: Body): DeliveryEvent[];
    verify(body: Body, options?: { fetchCert?: (url: string) => Promise<string> }): Promise<boolean>;
    confirmSubscription(body: Body, options?: { fetchUrl?: (url: string) => Promise<unknown> }): Promise<true>;
    handle(
      body: Body,
      options?: {
        verify?: boolean;
        topics?: string[] | null;
        confirm?: boolean;
        fetchCert?: (url: string) => Promise<string>;
        fetchUrl?: (url: string) => Promise<unknown>;
      },
    ): Promise<{ events: DeliveryEvent[]; subscribed: boolean }>;
  };
  const sendgrid: { parse(body: Body): DeliveryEvent[]; verify(rawBody: string | Buffer, headers: Headers, publicKey: string): boolean };
  const mailgun: {
    parse(body: Body): DeliveryEvent[];
    verify(body: Body, signingKey: string, options?: { maxAgeSeconds?: number | null; now?: () => number }): boolean;
  };
  const postmark: { parse(body: Body): DeliveryEvent[] };
  const resend: {
    parse(body: Body): DeliveryEvent[];
    verify(rawBody: string | Buffer, headers: Headers, secret: string, options?: { toleranceSeconds?: number; now?: () => number }): boolean;
  };
  const zeptomail: { parse(body: Body): DeliveryEvent[] };
}
