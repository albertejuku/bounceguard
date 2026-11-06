// Your sending reputation over a sliding window. Providers act on these two rates: Amazon SES reviews an
// account at a 5% bounce rate and may pause it at 10%; complaints are reviewed at 0.1% and paused at 0.5%.
// The guard pauses itself first, so a bad list costs you a paused campaign instead of a paused account.
const HOUR = 3_600_000;
const KINDS = ['sent', 'delivered', 'bounce', 'softBounce', 'complaint'];

const percent = (rate) => `${(rate * 100).toFixed(rate < 0.01 ? 2 : 1)}%`;

export class Reputation {
  #buckets = new Map();

  constructor({
    windowMs = 7 * 24 * HOUR,
    bucketMs = HOUR,
    minSample = 100,
    bounceWarn = 0.05,
    bouncePause = 0.1,
    complaintWarn = 0.001,
    complaintPause = 0.005,
    now = Date.now,
    state = null,
  } = {}) {
    Object.assign(this, { windowMs, bucketMs, minSample, bounceWarn, bouncePause, complaintWarn, complaintPause, now });
    for (const [start, counts] of state?.buckets ?? []) this.#buckets.set(Number(start), { ...counts });
  }

  add(kind, n = 1) {
    if (!KINDS.includes(kind)) throw new TypeError(`Unknown reputation event "${kind}"`);
    const start = Math.floor(this.now() / this.bucketMs) * this.bucketMs;
    let bucket = this.#buckets.get(start);
    if (!bucket) this.#buckets.set(start, (bucket = {}));
    bucket[kind] = (bucket[kind] || 0) + n;
    this.#prune();
  }

  stats() {
    this.#prune();
    const sum = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
    for (const bucket of this.#buckets.values()) for (const kind of KINDS) sum[kind] += bucket[kind] || 0;
    // If sends aren't recorded, the outcomes still give a usable denominator.
    const sample = Math.max(sum.sent, sum.delivered + sum.bounce + sum.softBounce);
    const bounceRate = sample ? sum.bounce / sample : 0;
    const complaintRate = sample ? sum.complaint / sample : 0;

    let status = 'ok';
    const reasons = [];
    if (sample >= this.minSample) {
      if (bounceRate >= this.bouncePause) reasons.push(`Bounce rate ${percent(bounceRate)} is at or over ${percent(this.bouncePause)}.`);
      if (complaintRate >= this.complaintPause) reasons.push(`Complaint rate ${percent(complaintRate)} is at or over ${percent(this.complaintPause)}.`);
      if (reasons.length) status = 'paused';
      else {
        if (bounceRate >= this.bounceWarn) reasons.push(`Bounce rate ${percent(bounceRate)} is at or over ${percent(this.bounceWarn)}.`);
        if (complaintRate >= this.complaintWarn) reasons.push(`Complaint rate ${percent(complaintRate)} is at or over ${percent(this.complaintWarn)}.`);
        if (reasons.length) status = 'warning';
      }
    }
    return {
      status,
      reasons,
      sent: sum.sent,
      delivered: sum.delivered,
      bounces: sum.bounce,
      softBounces: sum.softBounce,
      complaints: sum.complaint,
      sample,
      bounceRate,
      complaintRate,
      windowMs: this.windowMs,
    };
  }

  reset() {
    this.#buckets.clear();
  }

  /** Serialisable state; pass it back as `state` to carry the window across restarts. */
  toJSON() {
    return { buckets: [...this.#buckets] };
  }

  #prune() {
    const cutoff = this.now() - this.windowMs;
    for (const start of this.#buckets.keys()) if (start + this.bucketMs <= cutoff) this.#buckets.delete(start);
  }
}
