package com.hibernateexpress.api;

import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;

/** Fixed-window request limit per client, protecting the public map services we call. */
final class RateLimiter {

  private record Window(long start, int count) {}

  private final ConcurrentHashMap<String, Window> windows = new ConcurrentHashMap<>();
  private final int limit;
  private final long windowMs;
  private final LongSupplier clock;

  RateLimiter(int limit, long windowMs, LongSupplier clock) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
  }

  boolean allow(String key) {
    long now = clock.getAsLong();
    Window w =
        windows.compute(
            key,
            (k, old) -> old == null || now - old.start() >= windowMs ? new Window(now, 1) : new Window(old.start(), old.count() + 1));
    return w.count() <= limit;
  }

  void purge() {
    long now = clock.getAsLong();
    windows.entrySet().removeIf(e -> now - e.getValue().start() >= windowMs);
  }
}
