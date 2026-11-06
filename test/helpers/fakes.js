import net from 'node:net';

/**
 * A scriptable SMTP server on 127.0.0.1. `users` exist; everything else gets 550 5.1.1 unless `acceptAll`.
 * Override any reply with greeting (or greeting(connectionNumber)) / ehlo / helo / mailFrom / rcpt(address).
 */
export async function fakeSmtp({ users = [], acceptAll = false, greeting = '220 mx.test ESMTP ready', ehlo, helo, mailFrom, rcpt } = {}) {
  const known = new Set(users.map((u) => u.toLowerCase()));
  const commands = [];
  const sockets = new Set();
  let connections = 0;

  const server = net.createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    const send = (reply) => {
      if (reply === null) return; // say nothing
      socket.write([].concat(reply).map((line) => `${line}\r\n`).join(''));
    };
    const hello = typeof greeting === 'function' ? greeting(connections) : greeting;
    if (hello === null) return;
    send(hello);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        commands.push(line);
        const verb = line.split(/[ :]/)[0].toUpperCase();
        if (verb === 'EHLO') send(ehlo ?? ['250-mx.test greets you', '250-PIPELINING', '250-SIZE 35882577', '250 8BITMIME']);
        else if (verb === 'HELO') send(helo ?? '250 mx.test');
        else if (verb === 'MAIL') send(mailFrom ?? '250 2.1.0 Sender OK');
        else if (verb === 'RCPT') {
          const address = /<(.*)>/.exec(line)[1].toLowerCase();
          const custom = rcpt?.(address);
          if (custom !== undefined) send(custom);
          else send(acceptAll || known.has(address) ? '250 2.1.5 Recipient OK' : '550 5.1.1 <' + address + '>: Recipient address rejected: User unknown');
          if (custom && /^421/.test([].concat(custom)[0])) socket.end();
        } else if (verb === 'RSET') send('250 2.0.0 OK');
        else if (verb === 'QUIT') {
          send('221 2.0.0 Bye');
          socket.end();
        } else send('502 5.5.2 Command not recognised');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    commands,
    get connections() {
      return connections;
    },
    rcpts: () => commands.filter((c) => c.startsWith('RCPT')).map((c) => /<(.*)>/.exec(c)[1]),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A port with nothing listening on it. */
export async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const dnsError = (code) => Object.assign(new Error(`queryMx ${code}`), { code });

/**
 * A resolver from a table: { 'example.com': { mx: [{ exchange, priority }] | 'ENODATA' | 'ESERVFAIL', a: [...], aaaa: [...] } }.
 * Domains not in the table don't exist (ENOTFOUND).
 */
export function fakeResolver(zones) {
  const calls = [];
  const lookup = (domain, type) => {
    calls.push(`${type} ${domain}`);
    const zone = zones[domain];
    if (!zone) throw dnsError('ENOTFOUND');
    const value = zone[type];
    if (typeof value === 'string') throw dnsError(value);
    if (!value?.length) throw dnsError('ENODATA');
    return value;
  };
  return {
    calls,
    async resolveMx(domain) {
      return lookup(domain, 'mx');
    },
    async resolve4(domain) {
      return lookup(domain, 'a');
    },
    async resolve6(domain) {
      return lookup(domain, 'aaaa');
    },
  };
}

export const mx = (exchange = '127.0.0.1', priority = 10) => ({ mx: [{ exchange, priority }] });

/** A clock you move by hand. */
export function clock(start = Date.UTC(2026, 0, 1)) {
  let now = start;
  const fn = () => now;
  fn.advance = (ms) => {
    now += ms;
  };
  return fn;
}

export const DAY = 24 * 3_600_000;
