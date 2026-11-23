package com.hibernateexpress.api;

import java.security.SecureRandom;
import java.util.Base64;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BiConsumer;
import java.util.function.LongSupplier;

/**
 * In-memory trips keyed by unguessable ids (the id is the only credential a trip has). Idle
 * trips are purged, and the total is capped so the server can't be filled up.
 */
public final class TripStore {

  private final ConcurrentHashMap<String, TripSession> sessions = new ConcurrentHashMap<>();
  private final SecureRandom random = new SecureRandom();
  private final LongSupplier wall;
  private final int maxSessions;
  private final long idleTtlMs;

  public TripStore(LongSupplier wall, int maxSessions, long idleTtlMs) {
    this.wall = wall;
    this.maxSessions = maxSessions;
    this.idleTtlMs = idleTtlMs;
  }

  public String add(TripSession session) {
    if (sessions.size() >= maxSessions) purge();
    if (sessions.size() >= maxSessions) throw new ApiError(503, "The server is busy, please try again in a minute");
    byte[] bytes = new byte[18];
    random.nextBytes(bytes);
    String id = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    sessions.put(id, session);
    return id;
  }

  public TripSession get(String id) {
    TripSession session = id == null ? null : sessions.get(id);
    if (session == null) throw ApiError.notFound("Trip not found. It may have ended or expired.");
    session.touch(wall.getAsLong());
    return session;
  }

  public void remove(String id) {
    TripSession session = sessions.remove(id);
    if (session != null) session.engine().dispose();
  }

  public int size() {
    return sessions.size();
  }

  /** Every trip, without counting as the rider looking at it (for the server's own checks). */
  public void forEach(BiConsumer<String, TripSession> action) {
    sessions.forEach(action);
  }

  /** Whether any real (not demo) trip is in progress. */
  public boolean anyLive() {
    return sessions.values().stream().anyMatch(s -> !s.isDemo());
  }

  /** Drops trips nobody has looked at for a while. */
  public void purge() {
    long cutoff = wall.getAsLong() - idleTtlMs;
    sessions.entrySet().removeIf(e -> {
      boolean stale = e.getValue().lastSeen() < cutoff;
      if (stale) e.getValue().engine().dispose();
      return stale;
    });
  }
}
