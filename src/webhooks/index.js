import * as ses from './ses.js';
import { sendgrid, mailgun, postmark, resend, zeptomail } from './providers.js';

export { ses, sendgrid, mailgun, postmark, resend, zeptomail };
export { WebhookError } from './util.js';

const PARSERS = { ses, sendgrid, mailgun, postmark, resend, zeptomail };

/** Parses any supported provider's webhook body into normalised events. */
export function parse(provider, body) {
  const parser = PARSERS[String(provider).toLowerCase()];
  if (!parser) throw new TypeError(`Unknown provider "${provider}". Supported: ${Object.keys(PARSERS).join(', ')}`);
  return parser.parse(body);
}
