package com.hibernateexpress.geo;

/** Geographic primitives. All distances are metres, all angles degrees. */
public final class Geo {

  /** Mean Earth radius (IUGG), metres. */
  public static final double EARTH_RADIUS_M = 6_371_008.8;

  private static final double RAD = Math.PI / 180;
  private static final double DEG = 180 / Math.PI;

  private Geo() {}

  public static double clamp(double value, double min, double max) {
    return value < min ? min : value > max ? max : value;
  }

  /** Great-circle distance (haversine formula). */
  public static double haversine(LatLng a, LatLng b) {
    double dLat = (b.lat() - a.lat()) * RAD;
    double dLng = (b.lng() - a.lng()) * RAD;
    double s1 = Math.sin(dLat / 2);
    double s2 = Math.sin(dLng / 2);
    double h = s1 * s1 + Math.cos(a.lat() * RAD) * Math.cos(b.lat() * RAD) * s2 * s2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /** Initial bearing from a to b, clockwise from north, in [0, 360). */
  public static double bearing(LatLng a, LatLng b) {
    double phi1 = a.lat() * RAD;
    double phi2 = b.lat() * RAD;
    double dLambda = (b.lng() - a.lng()) * RAD;
    double y = Math.sin(dLambda) * Math.cos(phi2);
    double x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
    return (Math.atan2(y, x) * DEG + 360) % 360;
  }

  /** The point reached after travelling distance metres from 'from' on the given bearing. */
  public static LatLng destinationPoint(LatLng from, double bearingDeg, double distance) {
    double delta = distance / EARTH_RADIUS_M;
    double theta = bearingDeg * RAD;
    double phi1 = from.lat() * RAD;
    double lambda1 = from.lng() * RAD;
    double sinPhi2 = Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
    double phi2 = Math.asin(clamp(sinPhi2, -1, 1));
    double y = Math.sin(theta) * Math.sin(delta) * Math.cos(phi1);
    double x = Math.cos(delta) - Math.sin(phi1) * sinPhi2;
    double lambda2 = lambda1 + Math.atan2(y, x);
    return new LatLng(phi2 * DEG, ((lambda2 * DEG + 540) % 360) - 180);
  }

  /**
   * Projects p onto segment a-b in a local equirectangular frame centred on p. For road
   * segments the error is far below GPS noise and it is much cheaper than spherical maths.
   */
  public static SegmentProjection projectOnSegment(LatLng p, LatLng a, LatLng b) {
    double kx = Math.cos(p.lat() * RAD) * RAD * EARTH_RADIUS_M;
    double ky = RAD * EARTH_RADIUS_M;
    double ax = (a.lng() - p.lng()) * kx;
    double ay = (a.lat() - p.lat()) * ky;
    double dx = (b.lng() - a.lng()) * kx;
    double dy = (b.lat() - a.lat()) * ky;
    double len2 = dx * dx + dy * dy;
    double t = len2 > 0 ? clamp(-(ax * dx + ay * dy) / len2, 0, 1) : 0;
    double px = ax + dx * t;
    double py = ay + dy * t;
    LatLng point = new LatLng(a.lat() + (b.lat() - a.lat()) * t, a.lng() + (b.lng() - a.lng()) * t);
    return new SegmentProjection(t, point, Math.sqrt(px * px + py * py));
  }

  /** Smallest absolute difference between two bearings, in [0, 180]. */
  public static double angleBetween(double a, double b) {
    return Math.abs(((((a - b) % 360) + 540) % 360) - 180);
  }
}
