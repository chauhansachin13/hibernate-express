package com.hibernateexpress.external;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.LongSupplier;

/** Small thread-safe LRU cache with a time-to-live, so repeated look-ups don't hit public servers. */
public final class LruCache<K, V> {

  private record Item<V>(V value, long expires) {}

  private final LinkedHashMap<K, Item<V>> map;
  private final long ttlMs;
  private final LongSupplier clock;

  public LruCache(int capacity, long ttlMs, LongSupplier clock) {
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.map =
        new LinkedHashMap<>(16, 0.75f, true) {
          private static final long serialVersionUID = 1L;

          @Override
          protected boolean removeEldestEntry(Map.Entry<K, Item<V>> eldest) {
            return size() > capacity;
          }
        };
  }

  public synchronized V get(K key) {
    Item<V> e = map.get(key);
    if (e == null) return null;
    if (clock.getAsLong() > e.expires()) {
      map.remove(key);
      return null;
    }
    return e.value();
  }

  public synchronized void put(K key, V value) {
    map.put(key, new Item<>(value, clock.getAsLong() + ttlMs));
  }

  public synchronized int size() {
    return map.size();
  }
}
