// Bounded in-memory LRU with TTL and hit/miss counters. Process-local by design: a cache
// outage is impossible, and a restart simply starts cold. Use a shared store only when
// running several web instances AND measurements show the hit rate matters.
export class TtlLru<V> {
  private map = new Map<string, { v: V; exp: number }>();
  hits = 0;
  misses = 0;
  evictions = 0;

  constructor(
    public readonly name: string,
    private maxEntries: number,
    private ttlMs: number,
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e || e.exp < Date.now()) {
      if (e) this.map.delete(key);
      this.misses++;
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, e);
    this.hits++;
    return e.v;
  }

  set(key: string, v: V) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { v, exp: Date.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
      this.evictions++;
    }
  }

  delete(key: string) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }

  stats() {
    const total = this.hits + this.misses;
    return { name: this.name, size: this.map.size, hits: this.hits, misses: this.misses, evictions: this.evictions, hitRate: total ? this.hits / total : null };
  }
}
