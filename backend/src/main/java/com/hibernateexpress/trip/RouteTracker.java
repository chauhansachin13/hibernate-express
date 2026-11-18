package com.hibernateexpress.trip;

import com.hibernateexpress.geo.Geo;
import com.hibernateexpress.geo.LatLng;
import com.hibernateexpress.route.ProgressPrediction;
import com.hibernateexpress.route.RouteLine;
import com.hibernateexpress.route.RouteMatch;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

/**
 * Map-matches a stream of GPS fixes onto a route and keeps track of progress.
 *
 * <p>The search is windowed around the previous position and biased towards the progress
 * predicted from ground speed and the travel direction, so progress can't jump to a later (or
 * earlier) pass of the same road. A safety net re-anchors to the opposite pass of a road if
 * progress keeps sliding backwards while the vehicle is clearly moving.
 */
public final class RouteTracker {

  public record Options(
      double backtrackM,
      double lookaheadM,
      double maxSpeedMps,
      double offRouteMinM,
      double offRouteMaxM,
      double offRouteAccuracyFactor,
      double nearRouteFactor) {

    public static Options defaults() {
      return new Options(200, 1500, 45, 75, 300, 2, 2.5);
    }
  }

  /**
   * @param along metres travelled along the route
   * @param remaining road metres left to the end of the route
   * @param matchAlong where the latest fix matched (may differ from along while off-route)
   * @param offRouteBy metres between the fix and the route
   * @param onRoute fix is within the off-route threshold
   * @param nearRoute fix is close enough that progress was still updated
   * @param snapped closest point on the route
   * @param threshold off-route threshold used for this fix
   */
  public record Result(
      double along,
      double remaining,
      double matchAlong,
      double offRouteBy,
      boolean onRoute,
      boolean nearRoute,
      LatLng snapped,
      double threshold) {}

  private record TimedPoint(LatLng p, long t) {}

  private record Motion(double heading, double speed) {}

  private final RouteLine route;
  private final Options opts;
  private final List<TimedPoint> recent = new ArrayList<>();
  private final ArrayDeque<double[]> progressLog = new ArrayDeque<>();
  private double along;
  private double speed;
  private double groundSpeed = Double.NaN;
  private long lastTime;
  private boolean hasLastTime;
  private boolean matched;

  public RouteTracker(RouteLine route) {
    this(route, Options.defaults());
  }

  public RouteTracker(RouteLine route, Options options) {
    this.route = route;
    this.opts = options;
  }

  public double progress() {
    return along;
  }

  /**
   * @param heading device-reported travel direction (only while moving), or NaN
   * @param deviceSpeed device-reported ground speed in m/s, or NaN
   */
  public Result update(LatLng p, double accuracyM, long timestamp, double heading, double deviceSpeed) {
    double accuracy = Double.isFinite(accuracyM) ? accuracyM : opts.offRouteMaxM();
    double threshold =
        Geo.clamp(accuracy * opts.offRouteAccuracyFactor(), opts.offRouteMinM(), opts.offRouteMaxM());
    double dt = hasLastTime ? Geo.clamp((timestamp - lastTime) / 1000.0, 0, 6 * 3600) : 0;

    // Motion straight from GPS, independent of map matching: if the matcher ever picks the wrong
    // pass of a road its own progress can't be trusted, but ground speed and a steady travel
    // direction still can.
    Motion motion = motion(p, accuracyM, timestamp);
    double travelHeading = Double.isNaN(heading) ? motion.heading() : heading;
    double ground = Double.isFinite(deviceSpeed) && deviceSpeed >= 0 ? deviceSpeed : motion.speed();
    if (!Double.isNaN(ground)) {
      groundSpeed = Double.isNaN(groundSpeed) ? ground : groundSpeed * 0.6 + ground * 0.4;
    }
    recent.add(new TimedPoint(p, timestamp));
    while (recent.size() > 40 || (recent.size() > 1 && timestamp - recent.get(0).t() > 90_000)) {
      recent.remove(0);
    }

    RouteMatch match;
    if (!matched) {
      match = route.nearest(p);
    } else {
      // Progress is predictable between fixes: anything within the plausible travel since the
      // last fix is cheap, a jump beyond it (to another pass of the same road) must be strongly
      // justified by the GPS position. After long gaps the tolerance opens up.
      double v = Double.isNaN(groundSpeed) ? speed : groundSpeed;
      double step = v * dt;
      double tolerance = 30 + 0.5 * step + (dt > 60 ? opts.maxSpeedMps() * dt * 0.5 : 0);
      double ahead = Math.max(opts.lookaheadM(), opts.maxSpeedMps() * dt * 1.25);
      match =
          route.match(
              p,
              along - opts.backtrackM(),
              along + ahead,
              new ProgressPrediction(along + step, tolerance),
              travelHeading);
      if (match.distance() > threshold) {
        // The window lost us (long GPS gap, a shortcut or a bad first match): trust distance.
        RouteMatch global = route.match(p, 0, route.length(), null, travelHeading);
        if (global.distance() <= threshold) match = global;
      }
    }

    boolean onRoute = match.distance() <= threshold;
    boolean nearRoute = match.distance() <= threshold * opts.nearRouteFactor();
    if (!matched || nearRoute) {
      if (matched && dt > 0) {
        double v = Geo.clamp((match.along() - along) / dt, 0, opts.maxSpeedMps());
        speed = speed == 0 ? v : speed * 0.6 + v * 0.4;
      }
      along = match.along();
      matched = true;
    }
    lastTime = timestamp;
    hasLastTime = true;

    if (onRoute) {
      RouteMatch reanchored = escapeWrongPass(p, match.segment(), threshold, timestamp);
      if (reanchored != null) match = reanchored;
    }

    return new Result(
        along,
        Math.max(0, route.length() - along),
        match.along(),
        match.distance(),
        onRoute,
        nearRoute,
        match.point(),
        threshold);
  }

  /**
   * Safety net for roads the route uses twice in opposite directions. If the matched position has
   * been sliding backwards while GPS says we're moving, and another pass of the route runs here
   * the other way, we are on that pass. Without this one bad match at a U-turn could freeze
   * progress and the alarm would never ring.
   */
  private RouteMatch escapeWrongPass(LatLng p, int segment, double threshold, long timestamp) {
    progressLog.addLast(new double[] {timestamp, along});
    while (progressLog.size() > 1 && timestamp - (long) progressLog.peekFirst()[0] > 40_000) {
      progressLog.pollFirst();
    }
    if (Double.isNaN(groundSpeed) || groundSpeed < 2) return null;
    if (timestamp - (long) progressLog.peekFirst()[0] < 8_000) return null;
    double max = along;
    for (double[] entry : progressLog) max = Math.max(max, entry[1]);
    if (max - along < Math.max(40, threshold)) return null;

    RouteMatch alt = route.match(p, along + 2 * threshold, route.length(), null, Double.NaN);
    if (alt.distance() > threshold) return null;
    double here = Geo.bearing(route.point(segment), route.point(segment + 1));
    double there = Geo.bearing(route.point(alt.segment()), route.point(alt.segment() + 1));
    if (Geo.angleBetween(here, there) < 120) return null;

    along = alt.along();
    speed = groundSpeed;
    progressLog.clear();
    progressLog.addLast(new double[] {timestamp, alt.along()});
    return alt;
  }

  /**
   * Ground speed and travel direction from recent fixes, for devices that don't report them. The
   * baseline is long enough that GPS jitter can't fake movement, and a direction is only reported
   * when the fixes along it form a fairly straight line: a stretch containing a U-turn has a
   * misleading end-to-end direction, so it is ignored.
   */
  private Motion motion(LatLng p, double accuracyM, long timestamp) {
    double accuracy = Double.isFinite(accuracyM) ? accuracyM : 50;
    double baseline = Math.max(40, 3 * Math.min(accuracy, 50));
    // Direction is measured twice: up to the previous fix, and up to the current one. It is only
    // trusted when both agree. The previous-fixes view goes stale right after a U-turn; the
    // current-fix view can be flipped by a single outlier fix. Either way, disagreement means
    // "don't know", and progress continuity decides instead.
    Motion previous =
        recent.isEmpty()
            ? new Motion(Double.NaN, Double.NaN)
            : stretch(recent.size() - 1, recent.get(recent.size() - 1).p(), recent.get(recent.size() - 1).t(), baseline);
    Motion withCurrent = stretch(recent.size(), p, timestamp, baseline);
    boolean agree =
        !Double.isNaN(previous.heading())
            && !Double.isNaN(withCurrent.heading())
            && Geo.angleBetween(previous.heading(), withCurrent.heading()) <= 45;
    double speed = !Double.isNaN(previous.speed()) ? previous.speed() : withCurrent.speed();
    return new Motion(agree ? withCurrent.heading() : Double.NaN, speed);
  }

  /**
   * Direction and speed over the stretch of recent fixes ending at (endP, endT); the fixes
   * {@code recent[0 .. endIndex-1]} come before it.
   */
  private Motion stretch(int endIndex, LatLng endP, long endT, double baseline) {
    int k = -1;
    for (int i = endIndex - 1; i >= 0; i--) {
      TimedPoint prev = recent.get(i);
      if (endT - prev.t() > 30_000) return new Motion(Double.NaN, 0); // crawling or stopped
      if (Geo.haversine(prev.p(), endP) >= baseline) {
        k = i;
        break;
      }
    }
    if (k < 0) return new Motion(Double.NaN, Double.NaN);
    TimedPoint start = recent.get(k);
    double chord = Geo.haversine(start.p(), endP);
    double seconds = (endT - start.t()) / 1000.0;
    double path = 0;
    for (int i = k; i < endIndex - 1; i++) path += Geo.haversine(recent.get(i).p(), recent.get(i + 1).p());
    path += Geo.haversine(recent.get(endIndex - 1).p(), endP);
    double heading = path > 0 && chord / path >= 0.75 ? Geo.bearing(start.p(), endP) : Double.NaN;
    return new Motion(heading, seconds > 0 ? chord / seconds : Double.NaN);
  }
}
