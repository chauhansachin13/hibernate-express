package com.hibernateexpress.trip;

import com.hibernateexpress.geo.Geo;
import com.hibernateexpress.geo.LatLng;
import com.hibernateexpress.route.RouteLine;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.function.LongSupplier;

/**
 * Turns a stream of GPS fixes into "how far is my stop, when will I get there, and should the
 * alarm ring now". Times are passed in explicitly (wall clock for live trips, a simulated clock
 * for demo rides and the accuracy simulation), so the same engine runs everywhere.
 *
 * <p>Thread-safe: every public method synchronizes on the engine, including route callbacks
 * that complete on HTTP client threads.
 */
public final class TripEngine {

  private record Estimate(double remaining, boolean gpsLost, boolean estimated) {}

  private final LatLng destination;
  private final AlarmSettings settings;
  private final AlarmPolicy policy;
  private final RouteProvider router;
  private final LongSupplier wallClock;
  private final EngineOptions opts;
  private final FixFilter filter = new FixFilter();

  private RouteData routeData;
  private RouteLine routeLine;
  private RouteTracker tracker;
  private PaceEstimator pace;
  private int routeVersion;

  private Fix lastFix;
  private long lastFixAt;
  private double displaySpeed = Double.NaN;
  private LatLng snapped;
  private double along;
  private double remainingAtFix = Double.NaN;
  private long remainingAtFixTime;
  private boolean remainingIsEstimate;
  private double initialRemaining = Double.NaN;
  private boolean onRoute = true;
  private long offRouteSince = -1;
  /** Straight-line radius around the stop matching the alarm point on this route (NaN = off). */
  private double safetyCircle = Double.NaN;

  private boolean routing;
  private CompletableFuture<Void> pending = CompletableFuture.completedFuture(null);
  private boolean attemptedRoute;
  private long lastRouteAttemptWall;
  private long rerouteBackoffMs;
  private int reroutes;
  private String routeError;
  private boolean disposed;

  public TripEngine(
      LatLng destination,
      AlarmSettings settings,
      RouteProvider router,
      LongSupplier wallClock,
      EngineOptions options,
      RouteData initialRoute) {
    this.destination = destination;
    this.settings = settings;
    this.router = router;
    this.wallClock = wallClock;
    this.opts = options;
    this.policy = new AlarmPolicy(settings, options.arrivalRadiusM());
    if (initialRoute != null) installRoute(initialRoute);
  }

  public LatLng destination() {
    return destination;
  }

  public AlarmSettings settings() {
    return settings;
  }

  public synchronized RouteData route() {
    return routeData;
  }

  public synchronized int routeVersion() {
    return routeVersion;
  }

  /** Completes once the latest routing request has been handled (useful in tests). */
  public synchronized CompletableFuture<Void> pendingRoute() {
    return pending;
  }

  /** Starts fetching the road route from where the rider is, before the first GPS fix. */
  public synchronized void prefetchRoute(LatLng origin) {
    if (disposed || routeLine != null || routing || opts.mode() == TravelMode.RAIL) return;
    requestRoute(origin, true);
  }

  /** Feeds one GPS fix that was taken at engine time {@code at}. */
  public synchronized void handleFix(Fix fix, long at) {
    if (disposed) return;
    if (filter.check(fix) != FixFilter.Verdict.OK) return;
    updateDisplaySpeed(fix);
    lastFix = fix;
    lastFixAt = at;
    if (routeLine == null) {
      if (opts.mode() == TravelMode.RAIL) {
        installRoute(RouteData.direct(fix.position(), destination, opts.railSpeedMps()));
      } else {
        if (!routing) requestRoute(fix.position(), true);
        return;
      }
    }
    track(fix, at);
  }

  /** Call about once a second: GPS loss, snooze expiry and between-fix estimation. */
  public synchronized void tick(long now) {
    if (disposed) return;
    if (routeLine != null && !Double.isNaN(remainingAtFix)) evaluate(now);
  }

  public synchronized void acknowledge() {
    policy.acknowledge();
  }

  public synchronized void snooze(long now) {
    policy.snooze(now);
  }

  /** Alarms the phone already rang on its own (e.g. offline) must not ring again. */
  public synchronized void markFired(boolean approach, boolean arrival) {
    policy.markFired(approach, arrival);
  }

  public synchronized void dispose() {
    disposed = true;
  }

  public synchronized TripSnapshot snapshot(long now) {
    Estimate est = routeLine != null ? estimate(now) : null;
    double remaining = est != null ? est.remaining() : Double.NaN;
    TripPhase phase;
    if (policy.arrived()) phase = TripPhase.ARRIVED;
    else if (lastFix == null) phase = TripPhase.LOCATING;
    else if (routeLine == null || Double.isNaN(remainingAtFix)) phase = TripPhase.ROUTING;
    else phase = TripPhase.TRACKING;

    boolean hasInitial = !Double.isNaN(initialRemaining) && initialRemaining > 0;
    double progress = hasInitial && !Double.isNaN(remaining) ? Geo.clamp(1 - remaining / initialRemaining, 0, 1) : 0;
    double alarmProgress = hasInitial ? Geo.clamp(1 - settings.distanceM() / initialRemaining, 0, 1) : Double.NaN;
    double eta = !Double.isNaN(remaining) && pace != null ? pace.eta(remaining) : Double.NaN;

    return new TripSnapshot(
        phase,
        opts.mode(),
        destination,
        routeData,
        routeVersion,
        lastFix,
        snapped,
        along,
        remaining,
        est != null && est.estimated(),
        initialRemaining,
        progress,
        alarmProgress,
        eta,
        displaySpeed,
        pace != null ? pace.alarmSpeed() : Double.NaN,
        onRoute,
        routing && routeLine != null,
        est != null && est.gpsLost(),
        Double.isNaN(remainingAtFix) ? -1 : Math.max(0, now - remainingAtFixTime),
        policy.ringing(),
        policy.snoozedUntil(),
        policy.approachFired(),
        routeError,
        reroutes,
        now);
  }

  private void track(Fix fix, long at) {
    RouteLine route = routeLine;
    LatLng position = fix.position();
    double direct = Geo.haversine(position, destination);
    double remaining;
    boolean estimate = false;
    boolean retryRoad = false;
    boolean considerReroute = false;

    if (routeData.kind() == RouteData.Kind.DIRECT) {
      // Straight line: a physical lower bound on the distance left, so alarms err early.
      remaining = direct;
      estimate = true;
      snapped = position;
      along = Geo.clamp(route.length() - direct, 0, route.length());
      onRoute = true;
      offRouteSince = -1;
      retryRoad = true;
    } else {
      double heading = fix.hasHeading() && fix.hasSpeed() && fix.speed() >= 3 ? fix.heading() : Double.NaN;
      RouteTracker.Result r =
          tracker.update(position, fix.accuracy(), at, heading, fix.hasSpeed() ? fix.speed() : Double.NaN);
      snapped = r.snapped();
      along = r.along();
      if (r.onRoute()) {
        remaining = r.remaining();
        onRoute = true;
        offRouteSince = -1;
      } else {
        onRoute = false;
        if (offRouteSince < 0) offRouteSince = at;
        estimate = true;
        if (r.nearRoute()) {
          // A noisy fix or a parallel service road: progress along the route still holds.
          remaining = r.remaining();
        } else {
          // Really somewhere else until the re-route arrives: assume the rest of the trip winds
          // like the rest of the planned route.
          double roadLeft = route.length() - r.matchAlong();
          double straightLeft = Geo.haversine(route.pointAt(r.matchAlong()), route.end());
          double winding = straightLeft > 200 ? Geo.clamp(roadLeft / straightLeft, 1, 2.5) : 1.3;
          remaining = Math.max(direct, Math.min(roadLeft + r.offRouteBy(), direct * winding));
        }
        considerReroute = true;
      }
    }

    remainingAtFix = remaining;
    remainingAtFixTime = at;
    remainingIsEstimate = estimate;
    if (Double.isNaN(initialRemaining)) initialRemaining = remaining;
    pace.add(at, remaining);
    evaluate(at);

    // Last, because a route provider may answer synchronously and re-track this fix.
    if (considerReroute) maybeReroute(fix, at);
    if (retryRoad) maybeRetryRoad(fix);
  }

  private Estimate estimate(long now) {
    if (Double.isNaN(remainingAtFix) || pace == null) return null;
    long age = Math.max(0, now - remainingAtFixTime);
    if (age < 1500) return new Estimate(remainingAtFix, false, remainingIsEstimate);
    // Between fixes keep moving at the measured pace, so phones that report GPS only every
    // 5-15 s don't make the alarm late. Once GPS counts as lost, dead reckoning assumes a
    // slightly higher speed so it errs early.
    boolean gpsLost = age > opts.gpsLostAfterMs();
    double speed = pace.alarmSpeed();
    double lostSec = Math.max(0, age - opts.gpsLostAfterMs()) / 1000.0;
    double travelled = speed * (age / 1000.0) + speed * (opts.deadReckoningFactor() - 1) * lostSec;
    return new Estimate(Math.max(0, remainingAtFix - travelled), gpsLost, remainingIsEstimate || age > 15_000);
  }

  private void evaluate(long now) {
    Estimate est = estimate(now);
    if (est == null) return;
    // The time rule goes by the bus's measured pace, never the routing engine's car-speed guess.
    double etaSec = pace.eta(est.remaining(), pace.timeRuleSpeed());
    double direct =
        lastFix != null && !est.gpsLost()
            ? Geo.haversine(lastFix.position(), destination)
            : Double.POSITIVE_INFINITY;
    policy.evaluate(new AlarmPolicy.Input(now, est.remaining(), etaSec, est.gpsLost(), direct, currentCircle(now)));
  }

  private void maybeReroute(Fix fix, long now) {
    if (routing || opts.mode() == TravelMode.RAIL) return;
    if (offRouteSince < 0 || now - offRouteSince < opts.rerouteAfterMs()) return;
    long wall = wallClock.getAsLong();
    long wait = Math.max(opts.rerouteMinIntervalMs(), rerouteBackoffMs);
    if (attemptedRoute && wall - lastRouteAttemptWall < wait) return;
    requestRoute(fix.position(), false);
  }

  private void maybeRetryRoad(Fix fix) {
    if (routing || opts.mode() == TravelMode.RAIL) return;
    if (attemptedRoute && wallClock.getAsLong() - lastRouteAttemptWall < opts.roadRetryMs()) return;
    requestRoute(fix.position(), false);
  }

  private void requestRoute(LatLng origin, boolean initial) {
    routing = true;
    attemptedRoute = true;
    lastRouteAttemptWall = wallClock.getAsLong();
    CompletableFuture<RouteData> future;
    try {
      future = router.route(origin, destination);
    } catch (RuntimeException e) {
      future = CompletableFuture.failedFuture(e);
    }
    if (future == null) future = CompletableFuture.failedFuture(new IllegalStateException("No route"));
    pending = future.handle((data, error) -> {
      onRouteResult(origin, initial, data, error);
      return null;
    });
  }

  private synchronized void onRouteResult(LatLng origin, boolean initial, RouteData data, Throwable error) {
    routing = false;
    if (disposed) return;
    if (error == null && data != null && data.points().size() >= 2) {
      routeError = null;
      rerouteBackoffMs = 0;
      if (!initial) reroutes++;
      installRoute(data);
    } else {
      routeError = describe(error);
      if (initial || routeLine == null) {
        installRoute(RouteData.direct(origin, destination, opts.fallbackSpeedMps()));
      } else {
        rerouteBackoffMs = Math.min(opts.maxRerouteBackoffMs(), Math.max(60_000, rerouteBackoffMs * 2));
      }
    }
    if (lastFix != null && routeLine != null) track(lastFix, lastFixAt);
  }

  private void installRoute(RouteData data) {
    RouteLine line = new RouteLine(data.points());
    double previousRemaining = remainingAtFix;
    routeData = data;
    routeLine = line;
    tracker = new RouteTracker(line);
    onRoute = true;
    offRouteSince = -1;
    safetyCircle = safetyCircle(data, line);
    routeVersion++;
    if (pace == null) {
      pace = new PaceEstimator(priorSpeed(data));
    } else if (!Double.isNaN(previousRemaining) && lastFix != null) {
      // Keep the pace history continuous across the switch to the new route.
      double fresh =
          data.kind() == RouteData.Kind.ROAD
              ? line.length() - line.nearest(lastFix.position()).along()
              : Geo.haversine(lastFix.position(), destination);
      pace.rebase(fresh - previousRemaining);
    }
  }

  /** Off-route this long before the full-size safety circle takes over. */
  private static final long OFF_ROUTE_CIRCLE_AFTER_MS = 10_000;
  /** The last stretch before the alarm point may approach the circle; earlier road must not. */
  private static final double CIRCLE_APPROACH_M = 300;
  /** Earlier road must stay this far outside the circle, so GPS noise there can't trigger it. */
  private static final double CIRCLE_NOISE_MARGIN_M = 60;

  /**
   * The safety circle for a route: the straight-line distance from the stop to the alarm point (the
   * spot where the road distance left equals the alarm distance). A bus following the route enters
   * this circle exactly at the alarm point, so it is an independent check that needs no map
   * matching. It is switched off when the route passes this close to the stop earlier — a U-turn
   * or a loop past the stop — where it would ring too soon.
   */
  private double safetyCircle(RouteData data, RouteLine line) {
    double alarmAlong = line.length() - settings.distanceM();
    if (data.kind() != RouteData.Kind.ROAD || alarmAlong <= 0) return Double.NaN;
    double radius = Geo.haversine(line.pointAt(alarmAlong), destination);
    double earlierUntil = alarmAlong - CIRCLE_APPROACH_M;
    for (int i = 0; i + 1 < line.size() && line.cumulative(i) < earlierUntil; i++) {
      // A long straight segment running past the cut-off is checked up to the cut-off only.
      LatLng end = line.cumulative(i + 1) <= earlierUntil ? line.point(i + 1) : line.pointAt(earlierUntil);
      if (Geo.projectOnSegment(destination, line.point(i), end).distance() <= radius + CIRCLE_NOISE_MARGIN_M) {
        return Double.NaN;
      }
    }
    return radius;
  }

  /**
   * The circle for this moment. Off the planned road for a while (a wrong turn, a shortcut, a
   * failed re-route) the road estimate can't be trusted, so the circle becomes the full alarm
   * distance: the straight line is never longer than the real road, so it can only ring early.
   */
  private double currentCircle(long now) {
    if (routeData == null || routeData.kind() != RouteData.Kind.ROAD) return Double.NaN;
    if (!onRoute && offRouteSince >= 0 && now - offRouteSince >= OFF_ROUTE_CIRCLE_AFTER_MS) return settings.distanceM();
    return safetyCircle;
  }

  private double priorSpeed(RouteData data) {
    if (opts.mode() == TravelMode.RAIL) return opts.railSpeedMps();
    if (data.kind() == RouteData.Kind.ROAD && data.duration() > 0 && data.distance() > 0) {
      return data.distance() / data.duration() * opts.busSpeedFactor();
    }
    return opts.fallbackSpeedMps();
  }

  private void updateDisplaySpeed(Fix fix) {
    double v = fix.hasSpeed() ? fix.speed() : Double.NaN;
    if (Double.isNaN(v) && lastFix != null) {
      double dt = (fix.timestamp() - lastFix.timestamp()) / 1000.0;
      double moved = Geo.haversine(lastFix.position(), fix.position());
      if (dt > 0 && dt < 120) v = moved < fix.accuracy() ? 0 : moved / dt;
    }
    if (Double.isNaN(v)) return;
    displaySpeed = Double.isNaN(displaySpeed) ? v : displaySpeed * 0.5 + v * 0.5;
  }

  private static String describe(Throwable error) {
    Throwable e = error;
    while (e instanceof CompletionException && e.getCause() != null) e = e.getCause();
    if (e == null) return "No route";
    return e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
  }
}
