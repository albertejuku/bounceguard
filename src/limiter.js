// Runs tasks with a global concurrency cap, at most `perKey` at a time per key, and at least `minInterval` ms
// between one task for a key finishing and the next starting. Tasks wait their turn; nothing is refused.
export class Limiter {
  #queue = [];
  #active = 0;
  #keys = new Map();
  #timer = null;
  #timerAt = 0;

  constructor({ concurrency = 10, perKey = 1, minInterval = 0 } = {}) {
    this.concurrency = Math.max(1, concurrency);
    this.perKey = Math.max(1, perKey);
    this.minInterval = Math.max(0, minInterval);
  }

  get pending() {
    return this.#queue.length;
  }

  get active() {
    return this.#active;
  }

  run(key, task) {
    return new Promise((resolve, reject) => {
      this.#queue.push({ key, task, resolve, reject });
      this.#pump();
    });
  }

  #state(key) {
    let state = this.#keys.get(key);
    if (!state) this.#keys.set(key, (state = { active: 0, last: -Infinity }));
    return state;
  }

  #pump() {
    const now = Date.now();
    let wait = Infinity;
    for (let i = 0; i < this.#queue.length && this.#active < this.concurrency; ) {
      const job = this.#queue[i];
      const state = this.#state(job.key);
      if (state.active >= this.perKey) {
        i++;
        continue;
      }
      const due = state.last + this.minInterval - now;
      if (due > 0) {
        wait = Math.min(wait, due);
        i++;
        continue;
      }
      this.#queue.splice(i, 1);
      this.#start(job, state, now);
    }
    if (wait !== Infinity) this.#wake(now + wait);
    if (this.#keys.size > 1000) this.#sweep(now);
  }

  #start(job, state, now) {
    this.#active++;
    state.active++;
    state.last = now;
    const done = () => {
      this.#active--;
      state.active--;
      state.last = Date.now();
      this.#pump();
    };
    Promise.resolve()
      .then(job.task)
      .then(
        (value) => {
          done();
          job.resolve(value);
        },
        (err) => {
          done();
          job.reject(err);
        },
      );
  }

  #wake(at) {
    if (this.#timer && this.#timerAt <= at) return;
    clearTimeout(this.#timer);
    this.#timerAt = at;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#pump();
    }, Math.max(0, at - Date.now()));
  }

  #sweep(now) {
    const queued = new Set(this.#queue.map((job) => job.key));
    for (const [key, state] of this.#keys) {
      if (!state.active && !queued.has(key) && now - state.last >= this.minInterval) this.#keys.delete(key);
    }
  }
}
