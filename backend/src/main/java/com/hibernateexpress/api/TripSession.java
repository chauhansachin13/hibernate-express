package com.hibernateexpress.api;

import com.hibernateexpress.external.Place;
import com.hibernateexpress.sim.RideSimulator;
import com.hibernateexpress.trip.TripEngine;
import com.hibernateexpress.trip.TripSnapshot;

/** One rider's trip on the server: the engine plus, for demo rides, the simulated bus. */
public final class TripSession {

  private final TripEngine engine;
  private final Place destination;
  private final TripSettings settings;
  private final RideSimulator simulator;
  private final long createdAt;
  private volatile long lastSeen;

  public TripSession(TripEngine engine, Place destination, TripSettings settings, RideSimulator simulator, long createdAt) {
    this.engine = engine;
    this.destination = destination;
    this.settings = settings;
    this.simulator = simulator;
    this.createdAt = createdAt;
    this.lastSeen = createdAt;
  }

  public TripEngine engine() {
    return engine;
  }

  public Place destination() {
    return destination;
  }

  public TripSettings settings() {
    return settings;
  }

  public boolean isDemo() {
    return simulator != null;
  }

  public double timeScale() {
    return simulator != null ? simulator.timeScale() : 1;
  }

  public long createdAt() {
    return createdAt;
  }

  public long lastSeen() {
    return lastSeen;
  }

  void touch(long wall) {
    lastSeen = wall;
  }

  /** Engine time matching {@code wall}: the wall clock, or the simulated clock for demo rides. */
  public synchronized long now(long wall) {
    return simulator == null ? wall : simulator.advanceTo(wall, engine);
  }

  /** Brings the trip up to date (between-fix estimation, GPS loss, snooze) and snapshots it. */
  public synchronized TripSnapshot refresh(long wall) {
    long now = now(wall);
    engine.tick(now);
    return engine.snapshot(now);
  }
}
