package com.hibernateexpress;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.hibernateexpress.geo.Geo;
import com.hibernateexpress.geo.LatLng;
import com.hibernateexpress.geo.SegmentProjection;
import com.hibernateexpress.json.Json;
import com.hibernateexpress.route.Polyline;
import com.hibernateexpress.route.RouteLine;
import com.hibernateexpress.route.RouteMatch;
import com.hibernateexpress.sim.AccuracySimulation;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Random;
import org.junit.jupiter.api.Test;

class GeoAndRouteTest {

  static final LatLng W = AccuracySimulation.WARANGAL;
  static final RouteLine REAL = AccuracySimulation.realRoute();

  static double length(List<LatLng> pts) {
    double sum = 0;
    for (int i = 1; i < pts.size(); i++) sum += Geo.haversine(pts.get(i - 1), pts.get(i));
    return sum;
  }

  @Test
  void oneDegreeOfLatitudeIsPiOver180TimesRadius() {
    assertEquals(Math.PI / 180 * Geo.EARTH_RADIUS_M, Geo.haversine(new LatLng(0, 0), new LatLng(1, 0)), 1e-3);
  }

  @Test
  void haversineIsSymmetricAndZeroForSamePoint() {
    LatLng hyd = new LatLng(17.385, 78.4867);
    assertEquals(Geo.haversine(hyd, W), Geo.haversine(W, hyd), 1e-6);
    assertEquals(0, Geo.haversine(hyd, hyd));
  }

  @Test
  void destinationPointRoundTripsDistanceAndBearing() {
    for (double brg : new double[] {0, 45, 90, 137, 200, 315}) {
      LatLng p = Geo.destinationPoint(W, brg, 12_345);
      assertEquals(12_345, Geo.haversine(W, p), 0.01);
      assertEquals(0, Geo.angleBetween(brg, Geo.bearing(W, p)), 0.01);
    }
  }

  @Test
  void projectsOntoSegmentsAndClampsToTheEnds() {
    LatLng a = new LatLng(0, 0);
    LatLng b = new LatLng(0, 0.01);
    SegmentProjection mid = Geo.projectOnSegment(new LatLng(0.001, 0.005), a, b);
    assertEquals(0.5, mid.t(), 1e-6);
    assertEquals(Geo.haversine(new LatLng(0.001, 0.005), new LatLng(0, 0.005)), mid.distance(), 0.1);
    assertEquals(1, Geo.projectOnSegment(new LatLng(0, 0.02), a, b).t());
    assertEquals(0, Geo.projectOnSegment(new LatLng(0, -0.02), a, b).t());
    assertEquals(111.19, Geo.projectOnSegment(new LatLng(0.001, 0), a, a).distance(), 0.01);
  }

  @Test
  void angleBetweenWrapsAround() {
    assertEquals(10, Geo.angleBetween(355, 5), 1e-9);
    assertEquals(180, Geo.angleBetween(0, 180), 1e-9);
    assertEquals(90, Geo.angleBetween(-45, 45), 1e-9);
  }

  @Test
  void realRouteLengthMatchesOsrmWithinHalfAPercent() throws Exception {
    try (InputStream in = getClass().getResourceAsStream("/fixtures/hyderabad-warangal.json")) {
      double osrm = Json.number(Json.object(Json.parse(new String(in.readAllBytes(), StandardCharsets.UTF_8))), "distance", 0);
      assertTrue(Math.abs(REAL.length() - osrm) / osrm < 0.005, "length " + REAL.length() + " vs OSRM " + osrm);
    }
  }

  @Test
  void findsTheAlongRoutePositionOfPointsOnTheRoute() {
    Random random = new Random(7);
    for (int i = 0; i < 200; i++) {
      double along = random.nextDouble() * REAL.length();
      RouteMatch m = REAL.nearest(REAL.pointAt(along));
      assertTrue(m.distance() < 0.5);
      assertEquals(along, m.along(), 1.0);
    }
  }

  @Test
  void travelledAndRemainingSlicesAddUp() {
    double along = REAL.length() * 0.37;
    assertEquals(REAL.length(), length(REAL.sliceTo(along)) + length(REAL.sliceFrom(along)), 0.5);
    assertEquals(along, length(REAL.sliceTo(along)), 0.5);
  }

  @Test
  void removesDuplicatesAndSurvivesASinglePoint() {
    RouteLine line = new RouteLine(List.of(W, W, W));
    assertEquals(2, line.size());
    assertEquals(0, line.length());
    assertEquals(W, line.pointAt(10));
  }

  @Test
  void polylineRoundTripsWithinOneMetre() {
    String encoded = Polyline.encode(REAL.points());
    List<LatLng> decoded = Polyline.decode(encoded);
    assertEquals(REAL.size(), decoded.size());
    for (int i = 0; i < decoded.size(); i++) assertTrue(Geo.haversine(REAL.point(i), decoded.get(i)) < 1.2);
    assertTrue(encoded.length() < REAL.size() * 12, "encoded polyline should be compact");
    assertEquals("_p~iF~ps|U_ulLnnqC_mqNvxq`@", Polyline.encode(List.of(
        new LatLng(38.5, -120.2), new LatLng(40.7, -120.95), new LatLng(43.252, -126.453))));
    assertFalse(Polyline.decode("").iterator().hasNext());
  }
}
