import { timingSafeEqual } from 'node:crypto';

export function toText(body) {
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  return JSON.stringify(body);
}

export function toBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
}

export function toJSON(body) {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) {
    try {
      return JSON.parse(toText(body));
    } catch {
      return null;
    }
  }
  return body;
}

/** Case-insensitive header lookup on a plain object, a Node IncomingHttpHeaders or a fetch Headers. */
export function header(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

/** "Jane <jane@example.com>" -> "jane@example.com". */
export function addressOf(value) {
  if (typeof value !== 'string') return null;
  const angle = /<([^<>]+)>/.exec(value);
  const address = (angle ? angle[1] : value).trim();
  return address.includes('@') ? address : null;
}

/** Seconds, milliseconds or a date string -> milliseconds, or null. */
export function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value < 1e12 ? Math.round(value * 1000) : value;
  if (/^\d+(\.\d+)?$/.test(String(value))) return toMs(Number(value));
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function event(provider, type, email, extra = {}) {
  return {
    provider,
    type,
    email: addressOf(email),
    bounce: extra.bounce ?? null,
    diagnostic: extra.diagnostic ?? null,
    messageId: extra.messageId ?? null,
    timestamp: extra.timestamp ?? null,
  };
}

export class WebhookError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebhookError';
    this.code = code;
  }
}
