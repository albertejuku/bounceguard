#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createGuard } from '../src/index.js';

const HELP = `bounceguard: check email addresses before you send to them.

Usage
  bounceguard <address...> [options]
  bounceguard --file list.csv [options]

Options
  --from <address>   Ask each mail server whether the mailbox exists, using this
                     sender (an address on a domain you control). Without it only
                     syntax, typos, throwaway domains and mail servers are checked.
  --helo <hostname>  Hostname to introduce yourself with (default: the --from domain).
  --file, -f <path>  Read addresses from a file: one per line, or a CSV (the first
                     cell on each line that contains an @).
  --json             Print the full results as JSON.
  --timeout <ms>     Mail server timeout (default 15000).
  --port <port>      Mail server port (default 25).
  --help, -h         Show this help.
  --version, -v      Show the version.

Exit code 1 when any address shouldn't be sent to.`;

function fail(message) {
  process.stderr.write(`${message}\n\nRun bounceguard --help for usage.\n`);
  process.exit(2);
}

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      from: { type: 'string' },
      helo: { type: 'string' },
      file: { type: 'string', short: 'f' },
      json: { type: 'boolean' },
      timeout: { type: 'string' },
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
} catch (err) {
  fail(err.message);
}
const { values, positionals } = args;

if (values.help) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}
if (values.version) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

const addresses = positionals[0] === 'check' ? positionals.slice(1) : [...positionals];
if (values.file) {
  let text;
  try {
    text = readFileSync(values.file, 'utf8');
  } catch (err) {
    fail(`Can't read ${values.file}: ${err.message}`);
  }
  for (const line of text.split(/\r?\n/)) {
    const cell = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, '')).find((c) => c.includes('@'));
    if (cell) addresses.push(cell);
  }
}
if (!addresses.length) fail('Give at least one address, or --file.');

const number = (value, name) => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) fail(`--${name} must be a whole number.`);
  return n;
};
const timeout = number(values.timeout, 'timeout');
const port = number(values.port, 'port');

let guard;
try {
  guard = createGuard({
    smtp: values.from ? { from: values.from, helo: values.helo, port, commandTimeout: timeout, connectTimeout: timeout } : undefined,
    reputation: false,
  });
} catch (err) {
  fail(err.message);
}
if (!values.from && !values.json) {
  process.stderr.write('Mailboxes are not being checked. Add --from verify@your-domain.com to ask each mail server.\n\n');
}

const results = await guard.checkMany(addresses);

if (values.json) {
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} else {
  const rows = results.map((r) => [r.address ?? r.email, r.verdict, r.send ? 'yes' : 'no', r.message + (r.suggestion ? ` Did you mean ${r.suggestion}?` : '')]);
  const head = ['ADDRESS', 'VERDICT', 'SEND', 'WHY'];
  const widths = [0, 1, 2].map((i) => Math.max(head[i].length, ...rows.map((row) => String(row[i]).length)));
  const line = (row) => row.map((cell, i) => (i < 3 ? String(cell).padEnd(widths[i]) : cell)).join('  ');
  process.stdout.write(`${[line(head), ...rows.map(line)].join('\n')}\n`);
  if (results.length > 1) {
    const send = results.filter((r) => r.send).length;
    process.stdout.write(`\n${send} to send, ${results.length - send} held back.\n`);
  }
}
process.exitCode = results.every((r) => r.send) ? 0 : 1;
