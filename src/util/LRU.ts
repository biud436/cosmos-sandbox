// Tiny LRU cache built on Map's insertion-ordered iteration. When the cache
// is at capacity and a new key is added, the least-recently-touched entry is
// evicted and `onEvict` is called — callers use this to dispose of GPU
// resources (planet meshes, orbit lines).
//
// touch(): pre-fetch a key without inserting; useful when you just want to
//   keep an existing entry hot without creating a new value.

export class LRU<K, V> {
  private readonly map = new Map<K, V>();

  constructor(
    readonly capacity: number,
    private readonly onEvict?: (key: K, value: V) => void,
  ) {
    if (capacity < 1) throw new Error('LRU capacity must be >= 1');
  }

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    // Re-insert to bump to "most recently used" end.
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  /** Move an existing key to the MRU end without changing its value. No-op if missing. */
  touch(key: K): void {
    const v = this.map.get(key);
    if (v === undefined) return;
    this.map.delete(key);
    this.map.set(key, v);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      // Evict the oldest (first inserted, oldest in iteration order).
      const oldestKey = this.map.keys().next().value as K;
      const oldestVal = this.map.get(oldestKey)!;
      this.map.delete(oldestKey);
      this.onEvict?.(oldestKey, oldestVal);
    }
    this.map.set(key, value);
  }

  delete(key: K): boolean {
    const v = this.map.get(key);
    if (v === undefined) return false;
    this.map.delete(key);
    this.onEvict?.(key, v);
    return true;
  }

  clear(): void {
    if (this.onEvict) {
      for (const [k, v] of this.map) this.onEvict(k, v);
    }
    this.map.clear();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }
}
