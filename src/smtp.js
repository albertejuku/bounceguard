// Asks a domain's mail server whether mailboxes exist, without sending anything: EHLO, MAIL FROM, one RCPT TO
// per address, then QUIT. DATA is never sent. Several addresses on the same server share one connection, and a
// made-up address on each domain tells whether the domain accepts everything ("accept-all" / catch-all).
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { classifyReply } from './classify.js';

function withCode(err, code) {
  err.code = code;
  return err;
}

function parseReply(lines) {
  const code = Number(lines[0].slice(0, 3));
  const message = lines.map((line) => line.slice(4)).join('\n').trim();
  const enhanced = /^[245]\.\d{1,3}\.\d{1,3}(?=\s|$)/.exec(lines[0].slice(4))?.[0] ?? null;
  return { code, enhanced, message };
}

class SmtpSession {
  #buffer = '';
  #lines = [];
  #replies = [];
  #waiters = [];
  #error = null;

  constructor(socket, host, commandTimeout, transcript) {
    this.socket = socket;
    this.host = host;
    this.transcript = transcript;
    socket.setEncoding('utf8');
    socket.setTimeout(commandTimeout, () => socket.destroy(withCode(new Error(`${host} stopped answering`), 'ETIMEDOUT')));
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (err) => this.#fail(err));
    socket.on('close', () => this.#fail(withCode(new Error(`${host} closed the connection`), 'ECLOSED')));
  }

  #onData(chunk) {
    this.#buffer += chunk;
    if (this.#buffer.length > 65536) {
      this.socket.destroy(withCode(new Error(`${this.host} sent a reply that is too long`), 'EPROTOCOL'));
      return;
    }
    let newline;
    while ((newline = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(newline + 1);
      const match = /^\d{3}([ -]|$)/.exec(line);
      if (!match) {
        this.socket.destroy(withCode(new Error(`${this.host} sent something that isn't SMTP: ${line.slice(0, 120)}`), 'EPROTOCOL'));
        return;
      }
      this.#lines.push(line);
      if (match[1] === '-') continue;
      const reply = parseReply(this.#lines);
      this.#lines = [];
      this.transcript?.push(`< ${reply.code} ${reply.message}`);
      const waiter = this.#waiters.shift();
      if (waiter) waiter.resolve(reply);
      else this.#replies.push(reply);
    }
  }

  #fail(err) {
    if (this.#error) return;
    this.#error = err;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(err);
  }

  read() {
    if (this.#replies.length) return Promise.resolve(this.#replies.shift());
    if (this.#error) return Promise.reject(this.#error);
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  command(line) {
    if (this.#error) return Promise.reject(this.#error);
    this.transcript?.push(`> ${line}`);
    this.socket.write(`${line}\r\n`);
    return this.read();
  }

  quit() {
    const { socket } = this;
    if (this.#error) {
      socket.destroy();
      return;
    }
    this.#fail(withCode(new Error('Session closed'), 'ECLOSED'));
    socket.removeAllListeners('data');
    socket.on('error', () => {});
    socket.end('QUIT\r\n');
    const timer = setTimeout(() => socket.destroy(), 2000);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
  }
}

function connect(host, port, connectTimeout, commandTimeout, transcript) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(withCode(new Error(`No answer from ${host}:${port} within ${connectTimeout} ms`), 'ETIMEDOUT'));
    }, connectTimeout);
    const onError = (err) => {
      clearTimeout(timer);
      reject(err);
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeListener('error', onError);
      resolve(new SmtpSession(socket, host, commandTimeout, transcript));
    });
  });
}

const SAFE_ADDRESS = /^[^\s<>@]+@[A-Za-z0-9.-]+$/;
const domainOf = (address) => address.slice(address.lastIndexOf('@') + 1).toLowerCase();
const randomLocal = () => `bg${randomBytes(6).toString('hex')}`;

function sessionFailure(host, reply) {
  return { status: reply.code >= 500 ? 'blocked' : 'temporary', host, code: reply.code, enhanced: reply.enhanced, message: reply.message };
}

// One conversation with one server. Returns { answered: true } once RCPT replies were collected, or
// { failure, stop } when the server wouldn't get that far (stop: the other servers will refuse too).
async function askHost(host, { recipients, domains, results, acceptAll, from, helo, port, connectTimeout, commandTimeout, detectAcceptAll, transcript }) {
  let session;
  try {
    session = await connect(host, port, connectTimeout, commandTimeout, transcript);
  } catch (err) {
    return { failure: { status: 'unreachable', host, message: err.message } };
  }
  try {
    const greeting = await session.read();
    if (greeting.code !== 220) return { failure: sessionFailure(host, greeting) };
    let reply = await session.command(`EHLO ${helo}`);
    if (reply.code !== 250) reply = await session.command(`HELO ${helo}`);
    if (reply.code !== 250) return { failure: sessionFailure(host, reply) };
    reply = await session.command(`MAIL FROM:<${from}>`);
    if (reply.code !== 250) return { failure: sessionFailure(host, reply), stop: reply.code >= 500 };

    let cutOff = null;
    for (const rcpt of recipients) {
      if (cutOff) {
        results.set(rcpt, cutOff);
        continue;
      }
      try {
        reply = await session.command(`RCPT TO:<${rcpt}>`);
      } catch (err) {
        cutOff = { status: 'temporary', host, message: err.message };
        results.set(rcpt, cutOff);
        continue;
      }
      results.set(rcpt, { status: classifyReply(reply), host, code: reply.code, enhanced: reply.enhanced, message: reply.message });
      if (reply.code === 421 || (reply.code === 452 && /4\.5\.3|too many/i.test(`${reply.enhanced} ${reply.message}`))) {
        cutOff = { status: 'temporary', host, code: reply.code, enhanced: reply.enhanced, message: reply.message };
      }
    }

    if (detectAcceptAll && !cutOff) {
      for (const domain of domains) {
        if (!recipients.some((r) => domainOf(r) === domain && results.get(r).status === 'accepted')) continue;
        try {
          reply = await session.command(`RCPT TO:<${randomLocal()}@${domain}>`);
        } catch {
          break;
        }
        const status = classifyReply(reply);
        acceptAll.set(domain, status === 'accepted' ? true : status === 'rejected' ? false : null);
      }
    }
    return { answered: true };
  } catch (err) {
    return { failure: { status: 'temporary', host, message: err.message } };
  } finally {
    session.quit();
  }
}

/**
 * Probes recipients that share a mail server, trying its hosts in priority order.
 * Returns { results: Map(address -> { status, host, code?, enhanced?, message }), acceptAll: Map(domain -> bool|null) }.
 * Throws only for an unsafe `from` or `helo`. A server that can't be reached or won't talk gives every address a non-final status
 * ('unreachable', 'blocked', 'temporary'), never 'rejected'.
 */
export async function probeMailboxes({
  hosts,
  recipients,
  from,
  helo,
  port = 25,
  connectTimeout = 10_000,
  commandTimeout = 15_000,
  detectAcceptAll = true,
  transcript = null,
}) {
  // Everything here ends up on the wire, so nothing that could smuggle in another SMTP command gets through.
  if (!SAFE_ADDRESS.test(String(from))) throw new TypeError('from must be a plain email address');
  if (!/^[A-Za-z0-9.-]+$/.test(String(helo))) throw new TypeError('helo must be a hostname');
  const results = new Map();
  const safe = [];
  for (const rcpt of recipients) {
    if (SAFE_ADDRESS.test(String(rcpt))) safe.push(rcpt);
    else results.set(rcpt, { status: 'error', host: null, message: 'Not a plain email address' });
  }
  const acceptAll = new Map();
  const domains = [...new Set(safe.map(domainOf))];
  for (const domain of domains) acceptAll.set(domain, null);
  if (!safe.length) return { results, acceptAll };
  const context = { recipients: safe, domains, results, acceptAll, from, helo, port, connectTimeout, commandTimeout, detectAcceptAll, transcript };

  let failure = null;
  for (const host of hosts) {
    const outcome = await askHost(host, context);
    if (outcome.answered) break;
    // A server that talked to us explains more than one we couldn't reach.
    if (!failure || failure.status === 'unreachable') failure = outcome.failure;
    if (outcome.stop) break;
  }

  for (const rcpt of safe) {
    if (!results.has(rcpt)) results.set(rcpt, failure ?? { status: 'error', host: null, message: 'No mail server to ask' });
  }
  return { results, acceptAll };
}
