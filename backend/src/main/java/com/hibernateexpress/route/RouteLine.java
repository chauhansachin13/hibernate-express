package com.hibernateexpress.route;

import com.hibernateexpress.geo.Geo;
import com.hibernateexpress.geo.LatLng;
import com.hibernateexpress.geo.SegmentProjection;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * An immutable polyline with pre-computed cumulative distances, so "how much road is left from
 * here" is one projection plus one subtraction.
 */
public final class RouteLine {

  private final LatLng[] points;
  private final double[] cumulative;
  private final double length;

  public RouteLine(List<LatLng> input) {
    List<LatLng> pts = new ArrayList<>(input.size() + 1);
    for (LatLng p : input) {
      if (p == null || !Double.isFinite(p.lat()) || !Double.isFinite(p.lng())) continue;
      LatLng prev = pts.isEmpty() ? null : pts.get(pts.size() - 1);
      if (prev != null && prev.lat() == p.lat() && prev.lng() == p.lng()) continue;
      pts.add(p);
    }
    if (pts.isEmpty()) throw new IllegalArgumentException("A route needs at least one valid point");
    if (pts.size() == 1) pts.add(pts.get(0));
    points = pts.toArray(LatLng[]::new);
    cumulative = new double[points.length];
    for (int i = 1; i < points.length; i++) {
      cumulative[i] = cumulative[i - 1] + Geo.haversine(points[i - 1], points[i]);
    }
    length = cumulative[points.length - 1];
  }

  /** Total length in metres. */
  public double length() {
    return length;
  }

  public int size() {
    return points.length;
  }

  public int segmentCount() {
    return points.length - 1;
  }

  public LatLng point(int i) {
    return points[i];
  }

  /** Metres from the start to vertex i. */
  public double cumulative(int i) {
    return cumulative[i];
  }

  public LatLng start() {
    return points[0];
  }

  public LatLng end() {
    return points[points.length - 1];
  }

  public List<LatLng> points() {
    return Collections.unmodifiableList(Arrays.asList(points));
  }

  /** Index of the segment containing the point {@code along} metres from the start. */
  public int segmentAt(double along) {
    if (along <= 0) return 0;
    if (along >= length) return segmentCount() - 1;
    int lo = 0;
    int hi = cumulative.length - 1;
    while (hi - lo > 1) {
      int mid = (lo + hi) >>> 1;
      if (cumulative[mid] <= along) lo = mid;
      else hi = mid;
    }
    return Math.min(lo, segmentCount() - 1);
  }

  /** The point {@code along} metres from the start, clamped to the route. */
  public LatLng pointAt(double along) {
    int i = segmentAt(along);
    LatLng a = points[i];
    LatLng b = points[i + 1];
    double segLength = cumulative[i + 1] - cumulative[i];
    double t = segLength > 0 ? Geo.clamp((along - cumulative[i]) / segLength, 0, 1) : 0;
    return new LatLng(a.lat() + (b.lat() - a.lat()) * t, a.lng() + (b.lng() - a.lng()) * t);
  }

  /** Closest point on the whole route. */
  public RouteMatch nearest(LatLng p) {
    return match(p, 0, length, null, Double.NaN);
  }

  /**
   * Finds where p sits on the route between fromAlong and toAlong.
   *
   * <p>Each candidate is scored by its distance to p, plus a continuity cost for straying from
   * the predicted progress (gentle inside the prediction's tolerance, steep beyond it), plus a
   * penalty when the segment points against the travel heading. Where a road is used twice
   * (out-and-back legs, U-turns, loops, hairpins) distances tie, and continuity and heading pick
   * the pass the vehicle is actually on.
   *
   * @param heading travel direction in degrees, or NaN when unknown
   */
  public RouteMatch match(
      LatLng p, double fromAlong, double toAlong, ProgressPrediction prediction, double heading) {
    int lo = segmentAt(Math.min(fromAlong, toAlong));
    int hi = segmentAt(Math.max(fromAlong, toAlong));
    double bestScore = Double.POSITIVE_INFINITY;
    RouteMatch best = null;
    for (int i = lo; i <= hi; i++) {
      LatLng a = points[i];
      LatLng b = points[i + 1];
      SegmentProjection proj = Geo.projectOnSegment(p, a, b);
      double segLength = cumulative[i + 1] - cumulative[i];
      double along = cumulative[i] + segLength * proj.t();
      double score = proj.distance();
      if (prediction != null) {
        double off = Math.abs(along - prediction.along());
        score += 0.15 * off + 0.8 * Math.max(0, off - prediction.tolerance());
      }
      if (!Double.isNaN(heading) && segLength > 1) {
        // 0 when aligned, ~34 m when driving the opposite way; small deviations are free.
        double misalign = (1 - Math.cos(Math.toRadians(Geo.bearing(a, b) - heading))) / 2;
        score += 40 * Math.max(0, misalign - 0.15);
      }
      if (score < bestScore) {
        bestScore = score;
        best = new RouteMatch(i, proj.t(), proj.point(), proj.distance(), along);
      }
    }
    return best;
  }

  /** Vertices from {@code along} to the end, starting with the exact point at {@code along}. */
  public List<LatLng> sliceFrom(double along) {
    int i = segmentAt(along);
    List<LatLng> out = new ArrayList<>(points.length - i + 1);
    out.add(pointAt(along));
    out.addAll(Arrays.asList(points).subList(i + 1, points.length));
    return out;
  }

  /** Vertices from the start up to the exact point at {@code along}. */
  public List<LatLng> sliceTo(double along) {
    int i = segmentAt(along);
    List<LatLng> out = new ArrayList<>(Arrays.asList(points).subList(0, i + 1));
    out.add(pointAt(along));
    return out;
  }
}
