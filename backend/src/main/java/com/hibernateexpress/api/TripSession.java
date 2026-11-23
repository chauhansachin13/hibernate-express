package com.hibernateexpress.api;

import com.hibernateexpress.external.Place;
import com.hibernateexpress.push.PushSubscription;
import com.hibernateexpress.sim.RideSimulator;
import com.hibernateexpress.trip.AlarmReason;
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

  // ------------------------------------------------- push: the alarm with the screen off

  /** Repeat an unanswered alarm this often, this many times, like an alarm clock. */
  static final long PUSH_REPEAT_MS = 30_000;
  static final int MAX_PUSHES = 8;

  private volatile PushSubscription push;
  private AlarmReason pushedFor;
  private int pushCount;
  private long lastPushAt;

  public PushSubscription push() {
    return push;
  }

  public void setPush(PushSubscription subscription) {
    push = subscription;
  }

  /** The push service says the subscription is gone (404/410): stop trying it. */
  public void dropPush(PushSubscription subscription) {
    if (push == subscription) push = null;
  }

  /**
   * Whether to send the alarm as a push now: a new alarm at once, the same one again every 30 s
   * until it is answered (eight times at most). Answering ("I'm awake") or a snooze resets it.
   */
  synchronized boolean pushDue(AlarmReason ringing, long wall) {
    if (ringing == null) {
      pushedFor = null;
      pushCount = 0;
      return false;
    }
    if (ringing != pushedFor) {
      pushedFor = ringing;
      pushCount = 1;
      lastPushAt = wall;
      return true;
    }
    if (pushCount >= MAX_PUSHES || wall - lastPushAt < PUSH_REPEAT_MS) return false;
    pushCount++;
    lastPushAt = wall;
    return true;
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
