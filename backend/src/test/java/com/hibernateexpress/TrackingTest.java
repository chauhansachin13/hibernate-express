package com.hibernateexpress;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.hibernateexpress.geo.Geo;
import com.hibernateexpress.geo.LatLng;
import com.hibernateexpress.route.RouteLine;
import com.hibernateexpress.sim.AccuracySimulation;
import com.hibernateexpress.trip.AlarmPolicy;
import com.hibernateexpress.trip.AlarmReason;
import com.hibernateexpress.trip.AlarmSettings;
import com.hibernateexpress.trip.Fix;
import com.hibernateexpress.trip.FixFilter;
import com.hibernateexpress.trip.PaceEstimator;
import com.hibernateexpress.trip.RouteTracker;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Random;
import org.junit.jupiter.api.Test;

/** Map matching, pace estimation, alarm rules and the GPS fix filter. */
class TrackingTest {

  static final LatLng W = AccuracySimulation.WARANGAL;
  static final RouteLine REAL = AccuracySimulation.realRoute();

  static Fix fixAt(LatLng p, long t, double accuracy, double speed) {
    return Fix.at(p, accuracy, speed, t);
  }

  // ------------------------------------------------------------------ RouteTracker

  @Test
  void followsANoisyDriveAlongTheRealRoute() {
    List<Double> errors = new ArrayList<>();
    for (int seed = 0; seed < 5; seed++) {
      RouteTracker tracker = new RouteTracker(REAL);
      Random random = new Random(3 + seed * 101L);
      long t = 0;
      for (double along = 0; along < REAL.length(); along += 25, t += 1000) {
        LatLng p = AccuracySimulation.gaussianOffset(REAL.pointAt(along), 12, random);
        errors.add(Math.abs(tracker.update(p, 15, t, Double.NaN, Double.NaN).along() - along));
      }
    }
    Collections.sort(errors);
    // 99% of fixes within 40 m; the worst moments are at city U-turns where the road passes itself.
    assertTrue(errors.get((int) (errors.size() * 0.99)) < 40, "p99 " + errors.get((int) (errors.size() * 0.99)));
    assertTrue(errors.get(errors.size() - 1) < 80, "max " + errors.get(errors.size() - 1));
  }

  @Test
  void neverJumpsToTheReturnLegOfAnOutAndBackRoad() {
    RouteLine route = new RouteLine(AccuracySimulation.walk(W, new double[][] {{0, 5000}, {180, 4000}}, 50));
    for (int seed = 0; seed < 20; seed++) {
      RouteTracker tracker = new RouteTracker(route);
      Random random = new Random(11 + seed);
      long t = 0;
      for (double along = 0; along <= route.length(); along += 20, t += 2000) {
        LatLng p = AccuracySimulation.gaussianOffset(route.pointAt(along), 8, random);
        double got = tracker.update(p, 10, t, Double.NaN, 10).along();
        assertTrue(Math.abs(got - along) < 80, "seed " + seed + " truth " + along + " got " + got);
      }
    }
  }

  @Test
  void flagsFixesFarFromTheRoadWithoutLosingProgress() {
    RouteLine route = new RouteLine(AccuracySimulation.walk(W, new double[][] {{90, 10_000}}, 50));
    RouteTracker tracker = new RouteTracker(route);
    tracker.update(route.pointAt(3000), 10, 0, Double.NaN, Double.NaN);
    LatLng far = new LatLng(route.pointAt(3100).lat() + 0.006, route.pointAt(3100).lng());
    RouteTracker.Result off = tracker.update(far, 10, 10_000, Double.NaN, Double.NaN);
    assertFalse(off.onRoute());
    assertTrue(off.offRouteBy() > 600);
    assertEquals(3000, off.along(), 5);
  }

  @Test
  void catchesUpAfterALongGpsGap() {
    RouteTracker tracker = new RouteTracker(REAL);
    tracker.update(REAL.pointAt(10_000), 10, 0, Double.NaN, Double.NaN);
    RouteTracker.Result r = tracker.update(REAL.pointAt(25_000), 10, 15 * 60_000, Double.NaN, Double.NaN);
    assertTrue(r.onRoute());
    assertEquals(25_000, r.along(), 5);
  }

  // ----------------------------------------------------------------- PaceEstimator

  @Test
  void paceUsesThePriorThenTheMeasuredPace() {
    PaceEstimator pace = new PaceEstimator(10);
    assertEquals(10, pace.speed());
    for (long t = 0; t <= 6 * 60_000; t += 5000) pace.add(t, 20_000 - 15 * (t / 1000.0));
    assertEquals(15, pace.speed(), 1e-6);
    assertEquals(600, pace.eta(9000), 1e-3);
  }

  @Test
  void paceBlendsWhileHistoryIsShort() {
    PaceEstimator pace = new PaceEstimator(10);
    for (long t = 0; t <= 150_000; t += 5000) pace.add(t, 20_000 - 20 * (t / 1000.0));
    assertTrue(pace.speed() > 10 && pace.speed() < 20);
  }

  @Test
  void etaIsUnknownWhileStopped() {
    PaceEstimator pace = new PaceEstimator(10);
    for (long t = 0; t <= 9 * 60_000; t += 5000) pace.add(t, 5000);
    assertTrue(Double.isNaN(pace.eta(5000)));
  }

  @Test
  void alarmSpeedReactsToASpeedUp() {
    PaceEstimator pace = new PaceEstimator(5);
    double rem = 30_000;
    for (long t = 0; t <= 8 * 60_000; t += 5000) {
      rem -= (t < 6 * 60_000 ? 5 : 20) * 5;
      pace.add(t, rem);
    }
    assertTrue(pace.alarmSpeed() > pace.speed());
  }

  @Test
  void paceRebasesAfterAReroute() {
    PaceEstimator pace = new PaceEstimator(10);
    pace.add(0, 10_000);
    pace.add(60_000, 9_400);
    pace.rebase(500);
    pace.add(120_000, 9_300);
    assertEquals(10, pace.observed().speed(), 1e-6);
  }

  // ------------------------------------------------------------------- AlarmPolicy

  static AlarmPolicy.Input in(long now, double remaining, double eta, boolean gpsLost, double direct) {
    return new AlarmPolicy.Input(now, remaining, eta, gpsLost, direct);
  }

  @Test
  void ringsOnceByDistanceThenAgainOnArrival() {
    AlarmPolicy policy = new AlarmPolicy(AlarmSettings.of(2000, 0), 150);
    assertNull(policy.evaluate(in(0, 10_000, 1200, false, 8000)));
    assertEquals(AlarmReason.DISTANCE, policy.evaluate(in(0, 1990, 1200, false, 8000)));
    policy.acknowledge();
    assertNull(policy.evaluate(in(0, 1500, 1200, false, 8000)));
    assertNull(policy.ringing());
    assertEquals(AlarmReason.ARRIVAL, policy.evaluate(in(0, 120, 1200, false, 110)));
    assertTrue(policy.arrived());
  }

  @Test
  void ringsByTimeWhenThatComesFirstButNotWhileStopped() {
    AlarmPolicy policy = new AlarmPolicy(AlarmSettings.of(1000, 10), 150);
    assertNull(policy.evaluate(in(0, 6000, 610, false, 5000)));
    assertNull(policy.evaluate(in(0, 5000, Double.NaN, false, 5000)));
    assertEquals(AlarmReason.TIME, policy.evaluate(in(0, 5900, 590, false, 5000)));
  }

  @Test
  void snoozesForTwoMinutes() {
    AlarmPolicy policy = new AlarmPolicy(AlarmSettings.of(2000, 0), 150);
    policy.evaluate(in(0, 1900, 600, false, 1800));
    policy.snooze(1000);
    assertNull(policy.ringing());
    assertNull(policy.evaluate(in(100_000, 1500, 600, false, 1400)));
    assertEquals(AlarmReason.SNOOZE, policy.evaluate(in(121_000, 1200, 600, false, 1100)));
  }

  @Test
  void deadReckonedAlarmsAreLabelledAndNeverFakeArrival() {
    AlarmPolicy policy = new AlarmPolicy(AlarmSettings.of(2000, 0), 150);
    assertEquals(AlarmReason.GPS_LOST, policy.evaluate(in(0, 100, 60, true, Double.POSITIVE_INFINITY)));
    assertFalse(policy.arrived());
  }

  @Test
  void passingNearThePinEarlyIsNotArrival() {
    AlarmPolicy policy = new AlarmPolicy(AlarmSettings.of(2000, 0), 150);
    assertNull(policy.evaluate(in(0, 8000, 900, false, 100)));
    assertFalse(policy.arrived());
  }

  @Test
  void alarmsRungOnThePhoneAreNotRepeated() {
    AlarmPolicy policy = new AlarmPolicy(AlarmSettings.of(2000, 0), 150);
    policy.markFired(true, false);
    assertNull(policy.evaluate(in(0, 1500, 300, false, 1400)));
    assertEquals(AlarmReason.ARRIVAL, policy.evaluate(in(0, 100, 30, false, 90)));
  }

  // --------------------------------------------------------------------- FixFilter

  @Test
  void rejectsStaleInaccurateAndTeleportingFixes() {
    FixFilter filter = new FixFilter();
    assertEquals(FixFilter.Verdict.OK, filter.check(fixAt(W, 1000, 10, Double.NaN)));
    assertEquals(FixFilter.Verdict.STALE, filter.check(fixAt(W, 1000, 10, Double.NaN)));
    assertEquals(FixFilter.Verdict.INACCURATE, filter.check(fixAt(W, 2000, 900, Double.NaN)));
    assertEquals(FixFilter.Verdict.JUMP, filter.check(fixAt(Geo.destinationPoint(W, 90, 5000), 3000, 10, Double.NaN)));
    assertEquals(FixFilter.Verdict.OK, filter.check(fixAt(Geo.destinationPoint(W, 90, 20), 4000, 10, Double.NaN)));
  }

  @Test
  void trustsAPersistentNewPositionAndPoorFixesAfterAWhile() {
    FixFilter filter = new FixFilter();
    filter.check(fixAt(W, 0, 10, Double.NaN));
    LatLng far = Geo.destinationPoint(W, 0, 8000);
    List<FixFilter.Verdict> verdicts = new ArrayList<>();
    for (int i = 1; i <= 4; i++) verdicts.add(filter.check(fixAt(far, i * 1000L, 10, Double.NaN)));
    assertEquals(List.of(FixFilter.Verdict.JUMP, FixFilter.Verdict.JUMP, FixFilter.Verdict.JUMP, FixFilter.Verdict.OK), verdicts);

    FixFilter second = new FixFilter();
    second.check(fixAt(W, 0, 10, Double.NaN));
    assertEquals(FixFilter.Verdict.OK, second.check(fixAt(W, 60_000, 400, Double.NaN)));
  }
}
