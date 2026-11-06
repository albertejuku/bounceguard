// Where the guard keeps what it knows about each address. Any object with async get(key) and set(key, record)
// works (Redis, Postgres, DynamoDB...); records are plain JSON. This one keeps them in memory.
export class MemoryStore {
  #records = new Map();

  async get(key) {
    const record = this.#records.get(key);
    return record === undefined ? null : structuredClone(record);
  }

  async set(key, record) {
    this.#records.set(key, structuredClone(record));
  }

  async delete(key) {
    this.#records.delete(key);
  }

  get size() {
    return this.#records.size;
  }

  *entries() {
    for (const [key, record] of this.#records) yield [key, structuredClone(record)];
  }
}
