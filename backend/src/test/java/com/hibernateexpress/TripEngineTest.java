package com.hibernateexpress;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.hibernateexpress.geo.Geo;
import com.hibernateexpress.geo.LatLng;
import com.hibernateexpress.route.RouteLine;
import com.hibernateexpress.sim.AccuracySimulation;
import com.hibernateexpress.sim.RideSimulator;
import com.hibernateexpress.trip.AlarmReason;
import com.hibernateexpress.trip.AlarmSettings;
import com.hibernateexpress.trip.EngineOptions;
import com.hibernateexpress.trip.Fix;
import com.hibernateexpress.trip.RouteData;
import com.hibernateexpress.trip.RouteProvider;
import com.hibernateexpress.trip.TravelMode;
import com.hibernateexpress.trip.TripEngine;
import com.hibernateexpress.trip.TripPhase;
import com.hibernateexpress.trip.TripSnapshot;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class TripEngineTest {

  static final LatLng W = AccuracySimulation.WARANGAL;
  static final RouteLine LINE = new RouteLine(AccuracySimulation.walk(W, new double[][] {{90, 20_000}}, 100));
  static final RouteData ROUTE = new RouteData(LINE.points(), LINE.length(), LINE.length() / 15, RouteData.Kind.ROAD, "test");
  static final AlarmSettings TWO_KM = AlarmSettings.of(2000, 0);

  static TripEngine engine(RouteProvider router, long[] clock, EngineOptions opts, RouteData initial) {
    return new TripEngine(LINE.end(), TWO_KM, router, () -> clock[0], opts, initial);
  }

  @Test
  void movesFromLocatingToRoutingToTracking() {
    long[] clock = {0};
    CompletableFuture<RouteData> pending = new CompletableFuture<>();
    TripEngine engine = engine((a, b) -> pending, clock, EngineOptions.defaults(), null);
    assertEquals(TripPhase.LOCATING, engine.snapshot(0).phase());
    engine.handleFix(Fix.at(LINE.start(), 10, Double.NaN, 0), 0);
    assertEquals(TripPhase.ROUTING, engine.snapshot(0).phase());
    pending.complete(ROUTE);
    engine.pendingRoute().join();
    TripSnapshot s = engine.snapshot(0);
    assertEquals(TripPhase.TRACKING, s.phase());
    assertEquals(RouteData.Kind.ROAD, s.route().kind());
    assertEquals(LINE.length(), s.remaining(), 10);
  }

  @Test
  void prefetchedRouteIsReadyForTheFirstFix() {
    long[] clock = {0};
    AtomicInteger calls = new AtomicInteger();
    TripEngine engine = engine((a, b) -> {
      calls.incrementAndGet();
      return CompletableFuture.completedFuture(ROUTE);
    }, clock, EngineOptions.defaults(), null);
    engine.prefetchRoute(LINE.start());
    engine.handleFix(Fix.at(LINE.pointAt(100), 10, Double.NaN, 0), 0);
    assertEquals(1, calls.get());
    assertEquals(TripPhase.TRACKING, engine.snapshot(0).phase());
  }

  @Test
  void fallsBackToAStraightLineWhenRoutingFails() {
    long[] clock = {0};
    TripEngine engine =
        engine((a, b) -> CompletableFuture.failedFuture(new IllegalStateException("offline")), clock, EngineOptions.defaults(), null);
    engine.handleFix(Fix.at(LINE.start(), 10, Double.NaN, 0), 0);
    engine.pendingRoute().join();
    TripSnapshot s = engine.snapshot(0);
    assertEquals(RouteData.Kind.DIRECT, s.route().kind());
    assertEquals(Geo.haversine(LINE.start(), LINE.end()), s.remaining(), 1);
    assertEquals("offline", s.routeError());
  }

  @Test
  void trainModeUsesTheStraightLineWithoutCallingTheRouter() {
    long[] clock = {0};
    AtomicInteger calls = new AtomicInteger();
    TripEngine engine = engine((a, b) -> {
      calls.incrementAndGet();
      return CompletableFuture.completedFuture(ROUTE);
    }, clock, EngineOptions.forMode(TravelMode.RAIL), null);
    engine.handleFix(Fix.at(LINE.start(), 10, Double.NaN, 0), 0);
    assertEquals(0, calls.get());
    assertEquals(TripPhase.TRACKING, engine.snapshot(0).phase());
    assertEquals(RouteData.Kind.DIRECT, engine.snapshot(0).route().kind());
  }

  @Test
  void deadReckonsThroughAGpsGapAndRingsEarlyRatherThanLate() {
    long[] clock = {0};
    TripEngine engine = engine((a, b) -> CompletableFuture.completedFuture(ROUTE), clock, EngineOptions.defaults(), ROUTE);
    for (double along = 0; along <= 10_000; along += 75) {
      engine.handleFix(Fix.at(LINE.pointAt(along), 8, 15, clock[0]), clock[0]);
      clock[0] += 5000;
    }
    double before = engine.snapshot(clock[0]).remaining();
    clock[0] += 9 * 60_000; // nine minutes in a tunnel
    engine.tick(clock[0]);
    TripSnapshot s = engine.snapshot(clock[0]);
    assertTrue(s.gpsLost());
    assertTrue(s.remaining() < before - 8000);
    assertEquals(AlarmReason.GPS_LOST, s.ringing());
  }

  @Test
  void reroutesWhenTheBusLeavesThePlannedRoad() {
    long[] clock = {0};
    RouteLine detour =
        new RouteLine(AccuracySimulation.walk(LINE.pointAt(5000), new double[][] {{0, 1500}, {90, 15_000}, {180, 1500}}, 100));
    AtomicInteger calls = new AtomicInteger();
    RouteProvider provider = (from, to) -> {
      calls.incrementAndGet();
      double along = detour.nearest(from).along();
      return CompletableFuture.completedFuture(
          new RouteData(detour.sliceFrom(along), detour.length() - along, (detour.length() - along) / 15, RouteData.Kind.ROAD, "test"));
    };
    TripEngine engine = engine(provider, clock, EngineOptions.defaults(), ROUTE);
    List<LatLng> truthPoints = new ArrayList<>(LINE.sliceTo(5000));
    truthPoints.addAll(detour.points().subList(1, detour.size()));
    RouteLine truth = new RouteLine(truthPoints);
    for (double along = 0; along < truth.length(); along += 30) {
      engine.handleFix(Fix.at(truth.pointAt(along), 8, 15, clock[0]), clock[0]);
      clock[0] += 2000;
    }
    assertTrue(calls.get() >= 1);
    assertTrue(engine.snapshot(clock[0]).reroutes() >= 1);
  }

  @Test
  void alarmsAlreadyRungOnThePhoneAreNotRepeated() {
    long[] clock = {0};
    TripEngine engine = engine((a, b) -> CompletableFuture.completedFuture(ROUTE), clock, EngineOptions.defaults(), ROUTE);
    engine.markFired(true, false);
    engine.handleFix(Fix.at(LINE.pointAt(18_500), 10, Double.NaN, 0), 0);
    assertNull(engine.snapshot(0).ringing());
  }

  @Test
  void demoSimulatorRingsThenArrives() {
    long wall = 1_800_000_000_000L;
    RideSimulator sim = new RideSimulator(LINE, 42, 40, 500, 6, 42, wall);
    TripEngine engine = new TripEngine(LINE.end(), TWO_KM, (a, b) -> CompletableFuture.completedFuture(ROUTE), () -> 0, EngineOptions.defaults(), ROUTE);
    sim.start(engine);
    AlarmReason first = null;
    boolean arrived = false;
    for (int second = 1; second <= 60 && !arrived; second++) {
      long now = sim.advanceTo(wall + second * 1000L, engine);
      engine.tick(now);
      TripSnapshot s = engine.snapshot(now);
      if (first == null && s.ringing() != null) {
        first = s.ringing();
        assertTrue(s.remaining() <= 2000 && s.remaining() > 1200, "rang at " + s.remaining());
        engine.acknowledge();
      }
      if (s.ringing() == AlarmReason.ARRIVAL) arrived = true;
    }
    assertEquals(AlarmReason.DISTANCE, first);
    assertTrue(arrived, "the demo bus should arrive within its 40 seconds");
  }
}
