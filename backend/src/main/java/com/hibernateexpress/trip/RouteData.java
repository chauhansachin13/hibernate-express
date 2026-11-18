package com.hibernateexpress.trip;

import com.hibernateexpress.geo.Geo;
import com.hibernateexpress.geo.LatLng;
import java.util.List;

/**
 * A route to follow.
 *
 * @param distance metres according to the router (informational; the geometry is measured)
 * @param duration seconds according to the router
 * @param kind ROAD = real road geometry; DIRECT = straight line (trains, or routing failed)
 */
public record RouteData(List<LatLng> points, double distance, double duration, Kind kind, String provider) {

  public enum Kind {
    ROAD("road"),
    DIRECT("direct");

    private final String json;

    Kind(String json) {
      this.json = json;
    }

    public String json() {
      return json;
    }

    @Override
    public String toString() {
      return json;
    }
  }

  public RouteData {
    points = List.copyOf(points);
  }

  /** A straight-line "route" used for trains and when road routing is unavailable. */
  public static RouteData direct(LatLng from, LatLng to, double speedMps) {
    double distance = Geo.haversine(from, to);
    return new RouteData(List.of(from, to), distance, distance / speedMps, Kind.DIRECT, "straight-line");
  }
}
