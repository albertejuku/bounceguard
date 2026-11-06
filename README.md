# bounceguard

Keep your email bounce rate near zero.

bounceguard checks every address before you send, learns from what your email provider reports afterwards, keeps
your suppression list, and pauses sending before your provider pauses your account.

- **Checks before sending:** syntax, typos (`jane@gmial.com` → did you mean `jane@gmail.com`?), throwaway inboxes,
  the domain's mail servers, and (if you allow it) the mail server itself, asked whether the mailbox exists,
  including whether the domain accepts every address.
- **Learns after sending:** feed it webhooks from Amazon SES, SendGrid, Mailgun, Postmark, Resend or ZeptoMail.
  Hard bounces, complaints and unsubscribes are suppressed for good. Repeated soft bounces are suppressed for a while.
  A delivery proves an address works again.
- **Protects your sender reputation:** tracks your bounce and complaint rates over a sliding window and stops
  sending at the same thresholds your provider would act on.
- **Never drops real people by accident:** a DNS timeout, a blocked port 25 or a server that won't answer gives
  `unknown` (sent by default and checked again soon), never `undeliverable`.

No dependencies. Node 20 or newer. MIT licensed.

## Why

A bounce rate over 5% gets an Amazon SES account reviewed, and over 10% it can be paused. Complaints are reviewed at
0.1% and paused at 0.5%. Other providers work the same way. One bad list import can take down the password resets
and invoices sent from the same account. bounceguard keeps bad addresses out before they bounce, and stops a bad
campaign before it costs you the account.

## Install

```sh
npm install github:albertejuku/bounceguard
```

## Quick start

```js
import { createGuard } from 'bounceguard';

const guard = createGuard({
  // Lets bounceguard ask mail servers whether a mailbox exists. Use an address on a domain you control.
  smtp: { from: 'verify@yourdomain.com' },
});

const result = await guard.check('jane@gmial.com');
// {
//   verdict: 'risky', send: true, reason: 'typo',
//   message: 'The domain looks like a typo of gmail.com.',
//   suggestion: 'jane@gmail.com', score: 30, ...
// }

if (result.send) await sendEmail(result.address);
```

To clean a list before a campaign:

```js
const { send, hold } = await guard.filter(addresses);
// send: normalised, de-duplicated addresses that are safe to send to
// hold: full results for the rest, each with a reason and a one-line message
```

After sending, tell the guard what happened. You can call it yourself:

```js
await guard.recordSent(address);
await guard.recordBounce(address, { type: 'hard', diagnostic: '550 5.1.1 user unknown' });
```

Or feed it your provider's webhooks (see [Webhooks](#webhooks)).

## How a check works

Each step can settle the answer. The network is only used when the earlier steps can't decide.

| Step | What it does | Possible results |
| --- | --- | --- |
| Syntax | RFC 5321 lengths, dot-atom local parts, internationalised domains as punycode. Suggests a fix for `jane@gmail` or `jane@gmail,com`. | `invalid_syntax` |
| Suppression list | Hard bounces, complaints, unsubscribes, repeated soft bounces, your own suppressions. | `suppressed` |
| Trusted domains | Your own domains skip every check after this one. | `trusted_domain` |
| Cache | A previous result is reused until its recheck date (see below). | the cached result |
| Throwaway inboxes | 122 throwaway-inbox domains (Mailinator, Guerrilla Mail, YOPmail, 10 Minute Mail and more), plus any you add. | `disposable` |
| Typos | Compares against popular providers, name and ending separately, so `live.co.za` or `mail.com` are left alone. | flags `typo`, sets `suggestion` |
| DNS | MX records, null MX (RFC 7505), and the implicit MX of RFC 5321 when a domain has no MX record. | `no_domain`, `null_mx`, `no_mail_server`, `dns_error` |
| Mail server | `EHLO`, `MAIL FROM`, `RCPT TO` for each address, plus one made-up address to detect accept-all domains, then `QUIT`. `DATA` is never sent, so nothing is delivered. | `mailbox_exists`, `mailbox_not_found`, `accept_all`, `mailbox_full`, `smtp_*` |

Addresses on the same mail server share one connection (up to 25 per session). Each server gets one session at a
time, with a one-second pause between sessions, and a domain found to accept every address isn't asked again for a
day.

### Verdicts

| Verdict | Means | Sent by default |
| --- | --- | --- |
| `deliverable` | The mailbox was confirmed by its server, delivered to before, or is on a trusted domain. | yes |
| `risky` | It may deliver, but something is off: an accept-all domain, a full mailbox, a likely typo, a throwaway inbox, or a role address if you hold those. | yes (`policy.sendRisky`), except throwaway (`policy.allowDisposable`) |
| `unknown` | The domain takes mail, but the mailbox couldn't be checked. | yes (`policy.sendUnknown`) |
| `undeliverable` | It will bounce: bad syntax, no such domain, no mail server, or the server said the mailbox doesn't exist. | no |

`send` is the final answer after your policy, the suppression list and the reputation pause. The `reason` field says
why, and `message` explains it in one sentence:

| Reason | Verdict |
| --- | --- |
| `mailbox_exists`, `delivered_before`, `trusted_domain` | deliverable |
| `accept_all`, `mailbox_full`, `typo`, `disposable`, `role_account` | risky |
| `smtp_disabled`, `smtp_unreachable`, `smtp_blocked`, `smtp_temporary`, `smtp_unverifiable`, `smtp_error`, `dns_error` | unknown |
| `invalid_syntax`, `no_domain`, `null_mx`, `no_mail_server`, `mailbox_not_found`, `hard_bounce` | undeliverable |
| `suppressed` | the last known verdict, never sent |
| `sender_paused` | the real verdict, held because your reputation is paused |

Every result also carries a `score` from 0 to 100, `flags` (`free`, `role`, `disposable`, `typo`, `acceptAll`),
the primary `mx`, the server's raw `smtp` reply when one was asked, and whether it came from the `cache`.

### Recheck schedule

| Result | Trusted for |
| --- | --- |
| Delivered to before | 180 days |
| Mailbox confirmed | 90 days |
| Risky | 30 days |
| Unknown | 1 day |
| Mailbox doesn't exist | 365 days |
| Domain doesn't exist or takes no mail | 7 days |
| DNS or connection failure | 1 hour |

Change any of these with `recheck: { deliverable: ms, ... }`, or pass `{ fresh: true }` to `check` to ask again
right away.

## Learning from your provider

| Event | Effect |
| --- | --- |
| Hard bounce | Suppressed for good. Counts toward your bounce rate. |
| Soft bounce | After 3 in a row with no delivery in between, suppressed for 30 days (`softBounceLimit`, `softBounceSuppression`). |
| Complaint (marked as spam) | Suppressed for good. Counts toward your complaint rate. |
| Unsubscribe | Suppressed for good. |
| Provider suppression (the provider refused because the address is on its own list) | Suppressed, without counting as a new bounce. |
| Delivery | Marks the address deliverable for 180 days, resets soft bounces, and lifts a bounce-based suppression. Never lifts a complaint or an unsubscribe. |
| Open or click | Resets soft bounces. |

A stronger reason replaces a weaker one (complaint > unsubscribe > manual > hard bounce > soft bounces), never the
other way round. `guard.suppress(address, reason, { until })` and `guard.unsuppress(address)` manage the list by
hand. `unsuppress` also forgets the last check, so the next check asks the mail server again.

Record each send once: either call `recordSent()` when you send, or feed your provider's send events
(`processed` / `Send` / `accepted`). Doing both counts every email twice.

## Webhooks

Every parser turns a provider's webhook into the same events:

```js
{ provider, type, email, bounce, diagnostic, messageId, timestamp }
// type: sent | delivered | bounce | complaint | unsubscribe | suppressed | deferred | open | click | other
// bounce: 'hard' | 'soft' | null
```

`guard.recordEvents(events)` applies them.

| Provider | Parse | Signature check |
| --- | --- | --- |
| Amazon SES (SNS, or EventBridge) | `webhooks.ses.parse` | `webhooks.ses.verify`, or `webhooks.ses.handle` for both |
| SendGrid | `webhooks.sendgrid.parse` | `webhooks.sendgrid.verify(rawBody, headers, publicKey)` |
| Mailgun | `webhooks.mailgun.parse` | `webhooks.mailgun.verify(body, signingKey)` |
| Postmark | `webhooks.postmark.parse` | use Basic auth on the webhook URL |
| Resend | `webhooks.resend.parse` | `webhooks.resend.verify(rawBody, headers, secret)` |
| ZeptoMail | `webhooks.zeptomail.parse` | protect the URL with a secret path or token |

**Always check signatures.** Without them, anyone who finds your webhook URL can post fake bounces and suppress
your customers.

### Amazon SES

`handle()` checks the SNS signature against Amazon's certificate (only fetched from `sns.<region>.amazonaws.com`),
refuses topics that aren't yours, confirms the subscription, and returns the events:

```js
import express from 'express';
import { createGuard, webhooks } from 'bounceguard';

const guard = createGuard({ smtp: { from: 'verify@yourdomain.com' } });
const app = express();

// SNS posts JSON as text/plain, so take the body as text.
app.post('/webhooks/ses', express.text({ type: '*/*' }), async (req, res) => {
  try {
    const { events } = await webhooks.ses.handle(req.body, { topics: [process.env.SES_EVENTS_TOPIC_ARN] });
    await guard.recordEvents(events);
    res.sendStatus(200);
  } catch (err) {
    res.sendStatus(err.name === 'WebhookError' ? 403 : 500);
  }
});
```

Both SES event publishing (`eventType`) and the older feedback notifications (`notificationType`) work. SES's
`OnAccountSuppressionList` bounces come through as `suppressed`, because SES doesn't count them toward your bounce rate.

### Resend

```js
app.post('/webhooks/resend', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!webhooks.resend.verify(req.body, req.headers, process.env.RESEND_WEBHOOK_SECRET)) return res.sendStatus(401);
  await guard.recordEvents(webhooks.resend.parse(req.body));
  res.sendStatus(200);
});
```

SendGrid's signed Event Webhook and Mailgun work the same way: verify with the raw body, then parse.

## Reputation

```js
guard.health();
// { status: 'ok' | 'warning' | 'paused', reasons: [...], sent, delivered, bounces, softBounces, complaints,
//   bounceRate, complaintRate, sample, windowMs, pauses: true }
```

Over the last 7 days, once at least 100 emails are counted:

| | Warning | Paused |
| --- | --- | --- |
| Bounce rate (hard bounces) | 5% | 10% |
| Complaint rate | 0.1% | 0.5% |

While paused, every result has `send: false` and `reason: 'sender_paused'`. Sending resumes on its own as the bad
days leave the window, or call `guard.reputation.reset()` once you've cleaned the list. Configure it with
`reputation: { bouncePause, complaintPause, minSample, windowMs, ... }`. Use `pause: false` to report without
pausing, or `reputation: false` to turn it off.

The window lives in memory. To keep it across restarts, save `guard.reputation.toJSON()` and pass it back as
`reputation: { state }`.

## Storage

Records are plain JSON keyed by the lowercased address. The default store is in memory. Any object with async
`get(key)` and `set(key, record)` works. For example, Postgres:

```js
// create table email_addresses (key text primary key, record jsonb not null);
const store = {
  async get(key) {
    const { rows } = await pool.query('select record from email_addresses where key = $1', [key]);
    return rows[0]?.record ?? null;
  },
  async set(key, record) {
    await pool.query(
      `insert into email_addresses (key, record) values ($1, $2)
       on conflict (key) do update set record = excluded.record`,
      [key, record],
    );
  },
};

const guard = createGuard({ store, smtp: { from: 'verify@yourdomain.com' } });
```

## Asking mail servers: what to know

- **Port 25.** Mail servers are asked on port 25. AWS, Google Cloud and Azure block it by default, as do many
  home and office networks. Where it's blocked, every check comes back `smtp_unreachable`: still sent, and checked
  again within the hour. Nothing is wrongly dropped, but nothing is confirmed either. Run checks from a host that
  can reach port 25, or ask your cloud provider to open it.
- **Identify yourself properly.** Use a real address on your own domain as `from`. A `helo` hostname whose reverse
  DNS matches your server's IP gets fewer refusals.
- **Be polite.** One session per server at a time, a second apart, and results are cached. Verifying huge lists
  from a fresh IP can still get that IP blocklisted, so check addresses as they arrive (at sign-up, on import) and
  let the cache do the rest.
- **Accept-all domains** accept every address, real or not, so their mailboxes can't be confirmed. bounceguard
  detects them with a made-up address and reports `accept_all`. This is common on company domains behind mail
  gateways.
- **A refusal aimed at you** (blocklists, policy, your IP, your sender) says nothing about the mailbox, so it gives
  `smtp_blocked` (unknown), never `mailbox_not_found`.
- **No email is sent.** The conversation stops before `DATA`.

Without `smtp.from`, bounceguard checks everything except the mailbox itself, and the result is
`unknown` / `smtp_disabled` for domains that take mail.

## Command line

```sh
npx github:albertejuku/bounceguard jane@gmial.com ghost@example.org
npx github:albertejuku/bounceguard --from verify@yourdomain.com --file signups.csv
npx github:albertejuku/bounceguard --json someone@example.com
```

```
ADDRESS            VERDICT        SEND  WHY
jane@gmial.com     risky          yes   The domain looks like a typo of gmail.com. Did you mean jane@gmail.com?
ghost@example.org  undeliverable  no    The domain says it accepts no email.

1 to send, 1 held back.
```

Exits 1 when any address shouldn't be sent to. `--help` lists the options.

## Options

```js
createGuard({
  store,                       // { get, set }. Default: in memory
  smtp: {
    from: 'verify@yourdomain.com', // required to ask mail servers
    helo: 'mail.yourdomain.com',   // default: the domain of `from`
    port: 25,
    connectTimeout: 10_000,
    commandTimeout: 15_000,
    maxHosts: 2,               // MX hosts to try, in priority order
    recipientsPerSession: 25,
    detectAcceptAll: true,
  },
  dns: { resolver, timeout: 5000, tries: 2, servers: ['1.1.1.1'] },
  policy: { sendRisky: true, sendUnknown: true, allowDisposable: false, allowRole: true },
  recheck: { delivered, deliverable, risky, unknown, undeliverable, domain, error }, // ms
  softBounceLimit: 3,
  softBounceSuppression: 30 * 24 * 3600 * 1000,
  trustedDomains: ['yourcompany.com'],
  disposableDomains: [],       // added to the built-in list
  concurrency: 10,             // parallel SMTP sessions across servers
  serverInterval: 1000,        // ms between sessions to the same server
  reputation: { windowMs, minSample: 100, bounceWarn: 0.05, bouncePause: 0.1, complaintWarn: 0.001, complaintPause: 0.005, pause: true, state },
});
```

The building blocks are exported too: `parseAddress`, `suggestDomain`, `repairDomain`, `isDisposableDomain`,
`isRoleAddress`, `isFreeProvider`, `lookupMail`, `probeMailboxes`, `classifyReply`, `Reputation`, `Limiter` and
`MemoryStore`. TypeScript types are included.

## Testing

```sh
npm test
```

The tests run offline against a scriptable SMTP server and a fake resolver, and cover real-world server replies
(Gmail, Microsoft 365, Yahoo, Postfix, blocklists, greylisting).

## Credits

bounceguard is the Node.js version of the deliverability layer in EikaFlow ERP, built by
[Eikal](https://eikal.co.ke), the team behind [crew bot](https://getcrewbot.com).

MIT License.
