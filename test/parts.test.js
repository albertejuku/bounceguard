import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Limiter, Reputation } from '../src/index.js';
import { clock, DAY } from './helpers/fakes.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Limiter ---------------------------------------------------------------------------------------------

test('limiter: one task per key at a time, others in parallel, nothing refused', async () => {
  const limiter = new Limiter({ concurrency: 10, perKey: 1 });
  const running = new Map();
  let peakSameKey = 0;
  let peakTotal = 0;
  let total = 0;
  const task = (key) => async () => {
    running.set(key, (running.get(key) ?? 0) + 1);
    total++;
    peakSameKey = Math.max(peakSameKey, running.get(key));
    peakTotal = Math.max(peakTotal, total);
    await sleep(20);
    running.set(key, running.get(key) - 1);
    total--;
    return key;
  };
  const results = await Promise.all(['a', 'a', 'a', 'b', 'c'].map((key) => limiter.run(key, task(key))));
  assert.deepEqual(results, ['a', 'a', 'a', 'b', 'c']);
  assert.equal(peakSameKey, 1);
  assert.equal(peakTotal, 3);
});

test('limiter: respects the global concurrency cap', async () => {
  const limiter = new Limiter({ concurrency: 2, perKey: 5 });
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      limiter.run(`k${i}`, async () => {
        peak = Math.max(peak, ++active);
        await sleep(10);
        active--;
      }),
    ),
  );
  assert.equal(peak, 2);
});

test('limiter: waits minInterval between tasks for the same key', async () => {
  const limiter = new Limiter({ minInterval: 60 });
  const starts = [];
  await Promise.all([1, 2, 3].map(() => limiter.run('mx', async () => starts.push(Date.now()))));
  assert.ok(starts[1] - starts[0] >= 55, `${starts[1] - starts[0]}`);
  assert.ok(starts[2] - starts[1] >= 55, `${starts[2] - starts[1]}`);
});

test('limiter: a failing task rejects its own promise and the queue keeps going', async () => {
  const limiter = new Limiter();
  const failing = limiter.run('k', async () => {
    throw new Error('boom');
  });
  const next = limiter.run('k', async () => 'ok');
  await assert.rejects(failing, /boom/);
  assert.equal(await next, 'ok');
  assert.equal(limiter.active, 0);
  assert.equal(limiter.pending, 0);
});

// ---- Reputation -------------------------------------------------------------------------------------------

test('reputation: ok, warning and paused by bounce and complaint rates', () => {
  const now = clock();
  const reputation = new Reputation({ minSample: 100, now });
  reputation.add('sent', 100);
  assert.equal(reputation.stats().status, 'ok');
  reputation.add('bounce', 5);
  assert.equal(reputation.stats().status, 'warning');
  reputation.add('bounce', 5);
  const stats = reputation.stats();
  assert.equal(stats.status, 'paused');
  assert.equal(stats.bounceRate, 0.1);

  const complaints = new Reputation({ minSample: 100, now });
  complaints.add('sent', 1000);
  complaints.add('complaint', 1);
  assert.equal(complaints.stats().status, 'warning');
  complaints.add('complaint', 4);
  assert.equal(complaints.stats().status, 'paused');
  assert.match(complaints.stats().reasons[0], /Complaint rate 0\.50%/);
});

test('reputation: a small sample never pauses', () => {
  const reputation = new Reputation({ minSample: 100 });
  reputation.add('sent', 10);
  reputation.add('bounce', 9);
  assert.equal(reputation.stats().status, 'ok');
});

test('reputation: uses outcomes as the denominator when sends are not recorded', () => {
  const reputation = new Reputation({ minSample: 10 });
  reputation.add('delivered', 9);
  reputation.add('bounce', 1);
  const stats = reputation.stats();
  assert.equal(stats.sample, 10);
  assert.equal(stats.bounceRate, 0.1);
  assert.equal(stats.status, 'paused');
});

test('reputation: old events leave the window, and state survives a restart', () => {
  const now = clock();
  const reputation = new Reputation({ minSample: 1, now });
  reputation.add('sent', 10);
  reputation.add('bounce', 5);
  const restored = new Reputation({ minSample: 1, now, state: JSON.parse(JSON.stringify(reputation)) });
  assert.equal(restored.stats().bounces, 5);
  now.advance(7 * DAY + 3_600_000);
  assert.equal(reputation.stats().sent, 0);
  assert.equal(reputation.stats().status, 'ok');
  assert.throws(() => reputation.add('nonsense'), /Unknown reputation event/);
});

// ---- CLI --------------------------------------------------------------------------------------------------

const cli = fileURLToPath(new URL('../bin/bounceguard.js', import.meta.url));
const run = (...args) =>
  promisify(execFile)(process.execPath, [cli, ...args]).then(
    (r) => ({ code: 0, ...r }),
    (err) => ({ code: err.code, stdout: err.stdout, stderr: err.stderr }),
  );

test('cli: prints a table and exits 1 when something should be held', async () => {
  const { code, stdout } = await run('jane@gmail', 'x@mailinator.com');
  assert.equal(code, 1);
  assert.match(stdout, /ADDRESS\s+VERDICT\s+SEND\s+WHY/);
  assert.match(stdout, /jane@gmail\s+undeliverable\s+no .*Did you mean jane@gmail\.com\?/);
  assert.match(stdout, /x@mailinator\.com\s+risky\s+no\s+This is a throwaway/);
  assert.match(stdout, /0 to send, 2 held back\./);
});

test('cli: --json prints the full results', async () => {
  const { stdout } = await run('--json', 'jane@gmail');
  const [result] = JSON.parse(stdout);
  assert.equal(result.reason, 'invalid_syntax');
  assert.equal(result.suggestion, 'jane@gmail.com');
});

test('cli: usage errors exit 2', async () => {
  assert.equal((await run()).code, 2);
  assert.equal((await run('--from', 'nope', 'a@b.com')).code, 2);
  assert.equal((await run('--nonsense')).code, 2);
  const help = await run('--help');
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage/);
  assert.match((await run('--version')).stdout, /^\d+\.\d+\.\d+/);
});
