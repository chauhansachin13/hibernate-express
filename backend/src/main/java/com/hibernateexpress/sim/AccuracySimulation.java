package com.hibernateexpress.sim;

import com.hibernateexpress.geo.Geo;
import com.hibernateexpress.geo.LatLng;
import com.hibernateexpress.json.Json;
import com.hibernateexpress.route.RouteLine;
import com.hibernateexpress.trip.AlarmReason;
import com.hibernateexpress.trip.AlarmSettings;
import com.hibernateexpress.trip.EngineOptions;
import com.hibernateexpress.trip.Fix;
import com.hibernateexpress.trip.RouteData;
import com.hibernateexpress.trip.RouteProvider;
import com.hibernateexpress.trip.TripEngine;
import com.hibernateexpress.trip.TripSnapshot;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.CompletableFuture;

/**
 * End-to-end accuracy simulation. A virtual bus drives a route with a known speed profile and
 * reports GPS fixes with Gaussian noise, exactly like a phone would; the real {@link TripEngine}
 * decides when to ring. Because the ground truth is known, we can measure how far from the stop
 * (or how many seconds before it) the alarm actually rang.
 */
public final class AccuracySimulation {

  private static final double KMH = 1 / 3.6;

  /** True speed (m/s) at {@code tSec} seconds into the ride with {@code remaining} metres left. */
  @FunctionalInterface
  public interface SpeedProfile {
    double speed(double tSec, double remaining);
  }

  /** GPS goes silent for {@code durationSec} once fewer than {@code fromRemaining} metres are left. */
  public record Dropout(double fromRemaining, double durationSec) {}

  public enum Metric {
    METRES,
    SECONDS
  }

  public record Scenario(
      String name,
      RouteLine route,
      RouteLine plannedRoute,
      RouteProvider provider,
      double startRemaining,
      double distanceM,
      int timeMin,
      int intervalSec,
      double noiseM,
      SpeedProfile speed,
      Dropout dropout,
      int rides,
      Metric metric,
      AlarmReason expectedReason,
      double lateBudget,
      double earlyBudget,
      String note) {

    public double target() {
      return metric == Metric.METRES ? distanceM : timeMin * 60.0;
    }
  }

  public record Ride(boolean fired, AlarmReason reason, double trueRemaining, double trueSecondsLeft, int reroutes) {}

  /** Error = where it rang minus where it should ring: positive is early, negative late. */
  public record Summary(Scenario scenario, List<Ride> rides, List<Double> errors, int fired) {

    public double percentile(double q) {
      if (errors.isEmpty()) return Double.NaN;
      List<Double> sorted = new ArrayList<>(errors);
      Collections.sort(sorted);
      int idx = (int) Math.round(q * (sorted.size() - 1));
      return sorted.get(Math.max(0, Math.min(sorted.size() - 1, idx)));
    }

    public double worstLate() {
      double worst = 0;
      for (double e : errors) worst = Math.min(worst, e);
      return worst;
    }
  }

  private AccuracySimulation() {}

  public static Summary run(Scenario sc) {
    List<Ride> rides = new ArrayList<>();
    List<Double> errors = new ArrayList<>();
    int fired = 0;
    for (int i = 0; i < sc.rides(); i++) {
      Ride r = ride(sc, 1000L + i * 7919L);
      rides.add(r);
      if (r.fired()) {
        fired++;
        errors.add(sc.metric() == Metric.METRES ? r.trueRemaining() - sc.distanceM() : r.trueSecondsLeft() - sc.target());
      }
    }
    return new Summary(sc, rides, errors, fired);
  }

  /** One simulated ride; one loop iteration is one second, like the phone's tick. */
  public static Ride ride(Scenario sc, long seed) {
    Random random = new Random(seed);
    RouteLine truth = sc.route();
    RouteLine planned = sc.plannedRoute() != null ? sc.plannedRoute() : truth;
    RouteData data = new RouteData(planned.points(), planned.length(), planned.length() / (40 * KMH), RouteData.Kind.ROAD, "sim");
    long[] clock = {1_800_000_000_000L};
    RouteProvider provider = sc.provider() != null ? sc.provider() : (a, b) -> CompletableFuture.completedFuture(data);
    TripEngine engine =
        new TripEngine(
            truth.end(),
            AlarmSettings.of(sc.distanceM(), sc.timeMin()),
            provider,
            () -> clock[0],
            EngineOptions.defaults(),
            data);
    double along = Math.max(0, truth.length() - sc.startRemaining());
    long t = 0;
    long dropoutStart = -1;

    for (int guard = 0; guard < 500_000; guard++) {
      double remaining = truth.length() - along;
      double v = sc.speed().speed(t, remaining);
      if (sc.dropout() != null && dropoutStart < 0 && remaining <= sc.dropout().fromRemaining()) dropoutStart = t;
      boolean inDropout = sc.dropout() != null && dropoutStart >= 0 && t - dropoutStart < sc.dropout().durationSec();

      if (t % sc.intervalSec() == 0 && !inDropout) {
        LatLng p = gaussianOffset(truth.pointAt(along), sc.noiseM(), random);
        engine.handleFix(new Fix(p.lat(), p.lng(), Math.max(5, sc.noiseM() * 1.5), v, Double.NaN, clock[0]), clock[0]);
      }
      engine.tick(clock[0]);
      TripSnapshot s = engine.snapshot(clock[0]);
      if (s.ringing() != null) {
        return new Ride(true, s.ringing(), remaining, secondsLeft(truth, sc.speed(), t, along), s.reroutes());
      }
      if (along >= truth.length()) break;
      along = Math.min(truth.length(), along + v);
      t += 1;
      clock[0] += 1000;
    }
    return new Ride(false, null, Double.NaN, Double.NaN, 0);
  }

  private static double secondsLeft(RouteLine route, SpeedProfile speed, long t0, double along0) {
    long t = t0;
    double along = along0;
    while (along < route.length() && t - t0 < 6 * 3600) {
      along += speed.speed(t, route.length() - along);
      t += 1;
    }
    return t - t0;
  }

  // ----------------------------------------------------------------- scenario building

  public static LatLng gaussianOffset(LatLng p, double sigma, Random random) {
    if (sigma <= 0) return p;
    double north = random.nextGaussian() * sigma;
    double east = random.nextGaussian() * sigma;
    return Geo.destinationPoint(p, Math.toDegrees(Math.atan2(east, north)), Math.hypot(north, east));
  }

  /** A polyline built from [bearing, metres] legs with a vertex every {@code step} metres. */
  public static List<LatLng> walk(LatLng start, double[][] legs, double step) {
    List<LatLng> points = new ArrayList<>();
    points.add(start);
    LatLng cur = start;
    for (double[] leg : legs) {
      int n = Math.max(1, (int) Math.round(leg[1] / step));
      for (int i = 0; i < n; i++) {
        cur = Geo.destinationPoint(cur, leg[0], leg[1] / n);
        points.add(cur);
      }
    }
    return points;
  }

  public static final LatLng WARANGAL = new LatLng(17.9837, 79.5307);

  /** The real OSRM road route Hyderabad (MGBS) to Hanamkonda, 143 km, bundled as a fixture. */
  public static RouteLine realRoute() {
    try (InputStream in = AccuracySimulation.class.getResourceAsStream("/fixtures/hyderabad-warangal.json")) {
      if (in == null) throw new IllegalStateException("Route fixture missing");
      Map<String, Object> json = Json.object(Json.parse(new String(in.readAllBytes(), StandardCharsets.UTF_8)));
      List<LatLng> points = new ArrayList<>();
      for (Object o : Json.list(json, "points")) {
        List<?> pair = (List<?>) o;
        points.add(new LatLng(((Number) pair.get(0)).doubleValue(), ((Number) pair.get(1)).doubleValue()));
      }
      return new RouteLine(points);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  public static SpeedProfile constant(double kmh) {
    return (t, remaining) -> kmh * KMH;
  }

  /** City bus: 90 s moving at 30 km/h, then a 30 s signal or bus stop. */
  public static final SpeedProfile STOP_AND_GO = (t, remaining) -> t % 120 < 90 ? 30 * KMH : 0;
  /** Highway at 70 km/h, then city traffic at 25 km/h for the last 6 km. */
  public static final SpeedProfile HIGHWAY_THEN_CITY = (t, remaining) -> (remaining > 6000 ? 70 : 25) * KMH;
  /** Crawling out of a city at 20 km/h, then 70 km/h on the highway for the last 15 km. */
  public static final SpeedProfile CITY_THEN_HIGHWAY = (t, remaining) -> (remaining > 15_000 ? 20 : 70) * KMH;

  public static List<Scenario> distanceScenarios() {
    RouteLine real = realRoute();
    RouteLine outAndBack = new RouteLine(walk(WARANGAL, new double[][] {{0, 5000}, {180, 4000}}, 50));
    RouteLine planned = new RouteLine(walk(WARANGAL, new double[][] {{90, 20_000}}, 100));
    RouteLine detourTail =
        new RouteLine(walk(planned.pointAt(6000), new double[][] {{0, 2500}, {90, 14_000}, {180, 2500}}, 100));
    List<LatLng> detourPoints = new ArrayList<>(planned.sliceTo(6000));
    detourPoints.addAll(detourTail.points().subList(1, detourTail.size()));
    RouteLine detour = new RouteLine(detourPoints);
    RouteProvider detourProvider = (from, to) -> {
      double along = detour.nearest(from).along();
      return CompletableFuture.completedFuture(
          new RouteData(
              detour.sliceFrom(along), detour.length() - along, (detour.length() - along) / (40 * KMH), RouteData.Kind.ROAD, "sim"));
    };
    double inf = Double.POSITIVE_INFINITY;
    return List.of(
        new Scenario("Highway 60 km/h, fix every 1 s, ±10 m GPS", real, null, null, 25_000, 2000, 0, 1, 10,
            constant(60), null, 40, Metric.METRES, AlarmReason.DISTANCE, 60, 45, "Good phone, open sky"),
        new Scenario("Highway 60 km/h, fix every 5 s, ±20 m GPS", real, null, null, 25_000, 2000, 0, 5, 20,
            constant(60), null, 40, Metric.METRES, AlarmReason.DISTANCE, 140, 80, "Battery-saving GPS"),
        new Scenario("Highway 80 km/h, fix every 15 s, ±40 m GPS", real, null, null, 25_000, 2000, 0, 15, 40,
            constant(80), null, 40, Metric.METRES, AlarmReason.DISTANCE, 420, 150, "Cheap phone, sparse fixes"),
        new Scenario("City stop-and-go (30 km/h + 30 s stops), fix every 3 s, ±15 m", real, null, null, 12_000, 1000, 0, 3, 15,
            STOP_AND_GO, null, 40, Metric.METRES, AlarmReason.DISTANCE, 70, 60, "Signals and bus stops"),
        new Scenario("Out-and-back road (same road twice), 40 km/h, ±10 m", outAndBack, null, null, inf, 2000, 0, 2, 10,
            constant(40), null, 200, Metric.METRES, AlarmReason.DISTANCE, 60, 45, "Map-matching continuity + wrong-pass recovery"),
        new Scenario("Bus leaves the planned road (re-route), 50 km/h, ±10 m", detour, planned, detourProvider, inf, 2000, 0, 2, 10,
            constant(50), null, 30, Metric.METRES, AlarmReason.DISTANCE, 70, 45, "Off-route detection + re-route"),
        new Scenario("GPS dead zone: no signal for 5 min starting 6 km out, 60 km/h", real, null, null, 25_000, 2000, 0, 1, 10,
            constant(60), new Dropout(6000, 300), 30, Metric.METRES, AlarmReason.GPS_LOST, 0, 1200,
            "Dead reckoning rings early (safe side)"));
  }

  public static List<Scenario> timeScenarios() {
    RouteLine real = realRoute();
    return List.of(
        new Scenario("10-min alarm, steady 60 km/h, fix every 1 s", real, null, null, 40_000, 300, 10, 1, 10,
            constant(60), null, 30, Metric.SECONDS, AlarmReason.TIME, 15, 30, "Steady highway"),
        new Scenario("10-min alarm, highway 70 km/h then city 25 km/h for the last 6 km", real, null, null, 40_000, 300, 10, 2, 15,
            HIGHWAY_THEN_CITY, null, 30, Metric.SECONDS, AlarmReason.TIME, 30, 600,
            "Bus slows after the alarm: rings early, never late"),
        new Scenario("10-min alarm, city 20 km/h then highway 70 km/h for the last 15 km", real, null, null, 25_000, 300, 10, 2, 15,
            CITY_THEN_HIGHWAY, null, 30, Metric.SECONDS, AlarmReason.TIME, 75, 60,
            "Bus speeds up: short window reacts in ~2 min"),
        new Scenario("10-min alarm, city stop-and-go, fix every 3 s", real, null, null, 15_000, 300, 10, 3, 15,
            STOP_AND_GO, null, 30, Metric.SECONDS, AlarmReason.TIME, 60, 150, "Signals and bus stops"));
  }
}
