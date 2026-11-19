package com.hibernateexpress.trip;

import com.hibernateexpress.geo.Geo;
import java.util.ArrayList;
import java.util.List;

/**
 * Estimates how fast the remaining distance is shrinking.
 *
 * <p>Instantaneous GPS speed is useless for ETAs on Indian roads (signals, bus stops, traffic),
 * so progress is measured over a sliding window and blended with the routing engine's expected
 * speed until enough history exists.
 */
public final class PaceEstimator {

  /** History used for the smoothed speed (includes signals and bus stops). */
  static final long WINDOW_MS = 8 * 60_000;
  /** Short history used to react quickly when the bus speeds up. */
  static final long SHORT_WINDOW_MS = 2 * 60_000;
  /** After this much observed history the routing engine's prior is ignored. */
  static final long FULL_CONFIDENCE_MS = 5 * 60_000;
  /** Minimum history before observed speed is trusted at all. */
  static final long MIN_SPAN_MS = 20_000;
  /** Below this speed the vehicle counts as stopped and the ETA is unknown. */
  static final double STOPPED_BELOW_MPS = 0.7;

  private static final class Sample {
    final long t;
    double remaining;

    Sample(long t, double remaining) {
      this.t = t;
      this.remaining = remaining;
    }
  }

  /** Observed speed and the history span it was measured over. */
  public record Observation(double speed, long spanMs) {}

  private final double prior;
  private final List<Sample> samples = new ArrayList<>();

  public PaceEstimator(double priorSpeedMps) {
    this.prior = Geo.clamp(Double.isFinite(priorSpeedMps) ? priorSpeedMps : 9, 2, 35);
  }

  public void add(long t, double remaining) {
    if (!samples.isEmpty()) {
      Sample last = samples.get(samples.size() - 1);
      if (t <= last.t) {
        if (t == last.t) last.remaining = remaining;
        return;
      }
    }
    samples.add(new Sample(t, remaining));
    long cutoff = t - WINDOW_MS;
    while (samples.size() > 2 && samples.get(1).t <= cutoff) samples.remove(0);
  }

  /** Keeps history continuous when a re-route changes the remaining distance. */
  public void rebase(double delta) {
    for (Sample s : samples) s.remaining += delta;
  }

  /** Observed progress speed over the last windowMs, or null if there is too little history. */
  public Observation observed(long windowMs) {
    if (samples.isEmpty()) return null;
    Sample last = samples.get(samples.size() - 1);
    Sample first = null;
    for (Sample s : samples) {
      if (s.t >= last.t - windowMs) {
        first = s;
        break;
      }
    }
    if (first == null || first == last) return null;
    long span = last.t - first.t;
    if (span < MIN_SPAN_MS) return null;
    return new Observation(Math.max(0, (first.remaining - last.remaining) / (span / 1000.0)), span);
  }

  public Observation observed() {
    return observed(WINDOW_MS);
  }

  /** Smoothed speed (m/s) used for the displayed ETA. */
  public double speed() {
    Observation obs = observed();
    if (obs == null) return prior;
    double w = Math.min(1, obs.spanMs() / (double) FULL_CONFIDENCE_MS);
    return w * obs.speed() + (1 - w) * prior;
  }

  /**
   * Speed used for alarm decisions. It never trails the smoothed speed and reacts within about
   * two minutes when the bus speeds up, so the alarm errs early.
   */
  public double alarmSpeed() {
    double smooth = speed();
    Observation recent = observed(SHORT_WINDOW_MS);
    return recent != null ? Math.max(smooth, recent.speed()) : smooth;
  }

  /**
   * Speed for the "N minutes before arrival" rule: measured only. The routing engine's estimate
   * is a car's free-flow speed — far too fast for a city bus with stops — so on its own it would
   * ring the time alarm at the start of a trip. Until about 20 s of driving has been measured the
   * rule waits (NaN); after that it takes the faster of the long and short windows, so it still
   * errs early when the bus speeds up.
   */
  public double timeRuleSpeed() {
    Observation longer = observed();
    if (longer == null) return Double.NaN;
    Observation recent = observed(SHORT_WINDOW_MS);
    return recent != null ? Math.max(longer.speed(), recent.speed()) : longer.speed();
  }

  /** Seconds to cover the remaining metres, or NaN while stopped. */
  public double eta(double remaining, double speed) {
    if (speed < STOPPED_BELOW_MPS) return Double.NaN;
    return Math.max(0, remaining) / speed;
  }

  public double eta(double remaining) {
    return eta(remaining, speed());
  }
}
