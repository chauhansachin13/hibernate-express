package com.hibernateexpress.sim;

import com.hibernateexpress.geo.Geo;
import com.hibernateexpress.geo.LatLng;
import com.hibernateexpress.route.RouteLine;
import com.hibernateexpress.trip.Fix;
import com.hibernateexpress.trip.TripEngine;
import java.util.Random;

/**
 * Drives a virtual bus along a route on a fast-forwarded clock and feeds noisy GPS fixes to a
 * trip engine. The simulation advances lazily: each time the phone asks for the trip state, the
 * bus catches up to "now", so no background thread is needed. ETAs, the time-based alarm and
 * snooze all run on the simulated clock, exactly as on a real ride.
 */
public final class RideSimulator {

  private final RouteLine route;
  private final double cruiseMps;
  private final double timeScale;
  private final long tickSimMs;
  private final long startWall;
  private final double noiseM;
  private final Random random;
  private long simTime;
  private double along;

  /**
   * @param speedKmh cruise speed of the bus
   * @param realDurationSec how long the whole ride should take in real time
   * @param tickRealMs real milliseconds between simulated GPS fixes
   * @param noiseM GPS noise (1 sigma, metres)
   * @param startWall wall-clock time the ride starts; the simulated clock starts there too
   */
  public RideSimulator(
      RouteLine route, double speedKmh, double realDurationSec, long tickRealMs, double noiseM, long seed, long startWall) {
    this.route = route;
    this.cruiseMps = speedKmh / 3.6;
    double travelSec = route.length() / cruiseMps;
    this.timeScale = Math.max(1, travelSec / realDurationSec);
    this.tickSimMs = Math.max(1, Math.round(tickRealMs * timeScale));
    this.startWall = startWall;
    this.simTime = startWall;
    this.noiseM = noiseM;
    this.random = new Random(seed);
  }

  /** How much faster than real time the demo runs. */
  public double timeScale() {
    return timeScale;
  }

  public double routeLength() {
    return route.length();
  }

  /** Emits the first fix at the start of the route. */
  public void start(TripEngine engine) {
    engine.handleFix(fix(), simTime);
    engine.tick(simTime);
  }

  /** Advances the bus to the simulated time matching {@code wall}; returns that simulated time. */
  public long advanceTo(long wall, TripEngine engine) {
    long target = startWall + Math.round((wall - startWall) * timeScale);
    while (simTime + tickSimMs <= target) {
      double dt = tickSimMs / 1000.0;
      simTime += tickSimMs;
      along = Math.min(route.length(), along + speed() * dt);
      engine.handleFix(fix(), simTime);
      engine.tick(simTime);
    }
    return Math.max(simTime, target);
  }

  /** Cruise with gentle variation, slowing down over the last kilometre. */
  private double speed() {
    double remaining = route.length() - along;
    if (remaining <= 0) return 0;
    double wobble = 1 + 0.12 * Math.sin(simTime / 47_000.0);
    double approach = Math.min(1, 0.35 + remaining / 1500);
    return cruiseMps * wobble * approach;
  }

  private Fix fix() {
    LatLng truth = route.pointAt(along);
    double north = random.nextGaussian() * noiseM;
    double east = random.nextGaussian() * noiseM;
    LatLng noisy = Geo.destinationPoint(truth, Math.toDegrees(Math.atan2(east, north)), Math.hypot(north, east));
    double accuracy = Math.round(noiseM * 1.6 + random.nextDouble() * 4);
    return new Fix(noisy.lat(), noisy.lng(), accuracy, speed(), Double.NaN, simTime);
  }
}
