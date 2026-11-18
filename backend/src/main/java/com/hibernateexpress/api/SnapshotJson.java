package com.hibernateexpress.api;

import com.hibernateexpress.geo.LatLng;
import com.hibernateexpress.route.Polyline;
import com.hibernateexpress.route.RouteLine;
import com.hibernateexpress.trip.Fix;
import com.hibernateexpress.trip.RouteData;
import com.hibernateexpress.trip.TripSnapshot;
import java.util.LinkedHashMap;
import java.util.Map;

/** Converts trip snapshots to the JSON the phone reads. */
final class SnapshotJson {

  private SnapshotJson() {}

  /**
   * @param knownRouteVersion the route version the phone already has; the (large) route geometry
   *     is only included when it changed
   */
  static Map<String, Object> of(TripSession session, TripSnapshot s, int knownRouteVersion, long wall) {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("phase", s.phase().json());
    m.put("mode", s.mode().json());
    m.put("remaining", round(s.remaining(), 1));
    m.put("remainingIsEstimate", s.remainingIsEstimate());
    m.put("initialRemaining", round(s.initialRemaining(), 1));
    m.put("progress", round(s.progress(), 4));
    m.put("alarmProgress", round(s.alarmProgress(), 4));
    m.put("etaSec", round(s.etaSec(), 0));
    m.put("speedMps", round(s.speedMps(), 2));
    m.put("paceMps", round(s.paceMps(), 2));
    m.put("onRoute", s.onRoute());
    m.put("rerouting", s.rerouting());
    m.put("gpsLost", s.gpsLost());
    m.put("lastFixAgeMs", s.lastFixAgeMs() < 0 ? null : s.lastFixAgeMs());
    m.put("ringing", s.ringing() == null ? null : s.ringing().json());
    m.put("snoozeLeftMs", s.snoozedUntil() < 0 ? null : Math.max(0, s.snoozedUntil() - s.now()));
    m.put("approachFired", s.approachFired());
    m.put("along", round(s.along(), 1));
    m.put("snapped", latLng(s.snapped()));
    m.put("fix", fix(s.fix()));
    m.put("routeError", s.routeError());
    m.put("reroutes", s.reroutes());
    m.put("routeVersion", s.routeVersion());
    RouteData route = s.route();
    m.put("routeKind", route == null ? null : route.kind().json());
    m.put("routeProvider", route == null ? null : route.provider());
    if (route != null && s.routeVersion() != knownRouteVersion) {
      Map<String, Object> r = new LinkedHashMap<>();
      r.put("version", s.routeVersion());
      r.put("polyline", Polyline.encode(route.points()));
      r.put("length", round(new RouteLine(route.points()).length(), 1));
      r.put("kind", route.kind().json());
      m.put("route", r);
    }
    m.put("demo", session.isDemo());
    m.put("timeScale", round(session.timeScale(), 2));
    m.put("now", s.now());
    m.put("serverTime", wall);
    return m;
  }

  static Map<String, Object> latLng(LatLng p) {
    if (p == null) return null;
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("lat", round(p.lat(), 6));
    m.put("lng", round(p.lng(), 6));
    return m;
  }

  private static Map<String, Object> fix(Fix f) {
    if (f == null) return null;
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("lat", round(f.lat(), 6));
    m.put("lng", round(f.lng(), 6));
    m.put("accuracy", round(f.accuracy(), 1));
    m.put("speed", round(f.speed(), 2));
    m.put("heading", round(f.heading(), 1));
    return m;
  }

  static Double round(double value, int decimals) {
    if (!Double.isFinite(value)) return null;
    double k = Math.pow(10, decimals);
    return Math.round(value * k) / k;
  }
}
