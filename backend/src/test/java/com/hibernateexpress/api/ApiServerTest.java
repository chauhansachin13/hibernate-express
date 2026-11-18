package com.hibernateexpress.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.hibernateexpress.external.Geocoder;
import com.hibernateexpress.external.Place;
import com.hibernateexpress.external.RoutingException;
import com.hibernateexpress.geo.Geo;
import com.hibernateexpress.geo.LatLng;
import com.hibernateexpress.json.Json;
import com.hibernateexpress.route.Polyline;
import com.hibernateexpress.route.RouteLine;
import com.hibernateexpress.sim.AccuracySimulation;
import com.hibernateexpress.trip.RouteData;
import com.hibernateexpress.trip.RouteProvider;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Boots the real HTTP server (random port) with fake map services and a controllable clock. */
class ApiServerTest {

  static final LatLng DEST = AccuracySimulation.WARANGAL;
  static final LatLng FAR_AWAY = new LatLng(-89.9, 0); // a "pin in the sea" for the no-route case

  /** Straight road routes from anywhere to anywhere, vertex every 100 m. */
  static final RouteProvider ROUTER = (from, to) -> {
    if (Geo.haversine(to, FAR_AWAY) < 1000) {
      return CompletableFuture.failedFuture(new RoutingException("No road route found to this place", true));
    }
    double distance = Geo.haversine(from, to);
    List<LatLng> points = new ArrayList<>(AccuracySimulation.walk(from, new double[][] {{Geo.bearing(from, to), distance}}, 100));
    points.set(points.size() - 1, to);
    return CompletableFuture.completedFuture(new RouteData(points, distance, distance / 12, RouteData.Kind.ROAD, "fake"));
  };

  static final Geocoder GEOCODER = new Geocoder() {
    @Override
    public CompletableFuture<List<Place>> search(String query, LatLng bias, int zoom) {
      if (query.equals("nowhere")) return CompletableFuture.completedFuture(List.of());
      return CompletableFuture.completedFuture(
          List.of(new Place("National Institute of Technology", "Warangal, Telangana", DEST.lat(), DEST.lng(), Place.Kind.EDUCATION)));
    }

    @Override
    public CompletableFuture<List<Place>> searchFallback(String query) {
      return CompletableFuture.completedFuture(List.of(new Place("Fallback hit", "", 18, 79, Place.Kind.POI)));
    }

    @Override
    public CompletableFuture<Place> reverse(LatLng at) {
      return CompletableFuture.completedFuture(new Place("Kazipet Junction", "Warangal", at.lat(), at.lng(), Place.Kind.TRAIN));
    }
  };

  @TempDir Path web;
  AtomicLong clock;
  ApiServer server;
  HttpClient http;
  String base;

  @BeforeEach
  void start() throws IOException {
    Files.writeString(web.resolve("index.html"), "<!doctype html><title>Hibernate Express</title>");
    Files.createDirectories(web.resolve("assets"));
    Files.writeString(web.resolve("assets/app-abc123.js"), "console.log(1)");
    clock = new AtomicLong(1_800_000_000_000L);
    server = new ApiServer(new InetSocketAddress("127.0.0.1", 0), new Services(ROUTER, GEOCODER, clock::get), web, "*");
    server.start();
    http = HttpClient.newHttpClient();
    base = "http://127.0.0.1:" + server.port();
  }

  @AfterEach
  void stop() {
    server.stop();
  }

  record Reply(int status, Map<String, Object> json, HttpResponse<String> raw) {}

  Reply call(String method, String path, Object body) throws Exception {
    HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base + path));
    if (body != null) {
      b.header("Content-Type", "application/json").method(method, HttpRequest.BodyPublishers.ofString(Json.stringify(body)));
    } else {
      b.method(method, HttpRequest.BodyPublishers.noBody());
    }
    HttpResponse<String> res = http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    String text = res.body();
    Map<String, Object> json = text.startsWith("{") ? Json.object(Json.parse(text)) : Map.of();
    return new Reply(res.statusCode(), json, res);
  }

  static Map<String, Object> destination() {
    Map<String, Object> d = new LinkedHashMap<>();
    d.put("lat", DEST.lat());
    d.put("lng", DEST.lng());
    d.put("name", "NIT Warangal");
    d.put("kind", "education");
    return d;
  }

  static Map<String, Object> settings(double distanceM, int timeMin) {
    return Map.of("mode", "road", "distanceM", distanceM, "timeMin", timeMin);
  }

  // --------------------------------------------------------------------- endpoints

  @Test
  void healthSearchReverseAndCoordinates() throws Exception {
    Reply health = call("GET", "/api/health", null);
    assertEquals(200, health.status());
    assertEquals(true, health.json().get("ok"));

    Reply search = call("GET", "/api/search?q=NIT%20Warangal&lat=17.9&lng=79.5", null);
    assertEquals(200, search.status());
    List<?> places = Json.list(search.json(), "places");
    assertEquals("education", Json.object(places.get(0)).get("kind"));
    assertEquals(true, search.json().get("more"));

    Reply fallback = call("GET", "/api/search?q=nowhere&explicit=1", null);
    assertEquals("Fallback hit", Json.object(Json.list(fallback.json(), "places").get(0)).get("name"));
    assertEquals(400, call("GET", "/api/search?q=a", null).status());

    Reply reverse = call("GET", "/api/reverse?lat=17.97&lng=79.6", null);
    assertEquals("Kazipet Junction", Json.object(reverse.json().get("place")).get("name"));

    Reply coords = call("POST", "/api/coordinates", Map.of("text", "https://www.google.com/maps/@17.9833,79.5308,15z"));
    assertEquals(true, coords.json().get("ok"));
    assertEquals(17.9833, (Double) coords.json().get("lat"), 1e-9);
    Reply bad = call("POST", "/api/coordinates", Map.of("text", "near the temple"));
    assertEquals(false, bad.json().get("ok"));
  }

  @Test
  void routePreviewReturnsACompactPolyline() throws Exception {
    Reply r = call("GET", "/api/route?from=17.93,79.55&to=" + DEST.lat() + "," + DEST.lng(), null);
    assertEquals(200, r.status());
    Map<String, Object> route = Json.object(r.json().get("route"));
    List<LatLng> points = Polyline.decode((String) route.get("polyline"));
    assertTrue(Geo.haversine(points.get(points.size() - 1), DEST) < 2);
    assertTrue((Double) route.get("length") > 5000);

    Reply none = call("GET", "/api/route?from=17.93,79.55&to=" + FAR_AWAY.lat() + "," + FAR_AWAY.lng(), null);
    assertEquals(422, none.status());
    assertEquals(400, call("GET", "/api/route?from=abc&to=1,2", null).status());
  }

  @Test
  void demoRideRingsAcknowledgesArrivesAndEnds() throws Exception {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("destination", destination());
    body.put("settings", settings(2000, 0));
    body.put("demo", true);
    Reply created = call("POST", "/api/trips", body);
    assertEquals(200, created.status());
    String id = (String) created.json().get("tripId");
    Map<String, Object> first = Json.object(created.json().get("snapshot"));
    assertEquals("tracking", first.get("phase"));
    assertNotNull(first.get("route"), "first snapshot carries the route geometry");
    int version = ((Double) first.get("routeVersion")).intValue();

    String firstRing = null;
    boolean arrived = false;
    for (int second = 1; second <= 70 && !arrived; second++) {
      clock.addAndGet(1000);
      Map<String, Object> s = call("GET", "/api/trips/" + id + "?routeVersion=" + version, null).json();
      assertNull(s.get("route"), "route geometry is not re-sent when unchanged");
      Object ringing = s.get("ringing");
      if (firstRing == null && ringing != null) {
        firstRing = (String) ringing;
        assertTrue((Double) s.get("remaining") <= 2000);
        Map<String, Object> acked = call("POST", "/api/trips/" + id + "/ack", null).json();
        assertNull(acked.get("ringing"));
      }
      if ("arrival".equals(ringing)) arrived = true;
    }
    assertEquals("distance", firstRing);
    assertTrue(arrived, "the demo bus arrives within ~40 s of real time");

    assertEquals(400, call("POST", "/api/trips/" + id + "/fixes", Map.of("fixes", List.of())).status());
    assertEquals(200, call("DELETE", "/api/trips/" + id, null).status());
    assertEquals(404, call("GET", "/api/trips/" + id, null).status());
  }

  @Test
  void liveRideFollowsPostedFixesAndRings() throws Exception {
    LatLng origin = Geo.destinationPoint(DEST, 200, 9000);
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("destination", destination());
    body.put("settings", settings(2000, 0));
    body.put("origin", Map.of("lat", origin.lat(), "lng", origin.lng()));
    Reply created = call("POST", "/api/trips", body);
    String id = (String) created.json().get("tripId");
    assertEquals("locating", Json.object(created.json().get("snapshot")).get("phase"));

    RouteLine road = new RouteLine(ROUTER.route(origin, DEST).join().points());
    long deviceClock = 1_700_000_000_000L; // the phone's clock is way off: the server must cope
    int routeVersion = -1;
    String ring = null;
    double ringRemaining = Double.NaN;
    for (double along = 0; along <= road.length() && ring == null; along += 100) {
      clock.addAndGet(10_000);
      deviceClock += 10_000;
      LatLng p = road.pointAt(along);
      Map<String, Object> fix = Map.of("lat", p.lat(), "lng", p.lng(), "accuracy", 8, "speed", 10, "timestamp", deviceClock);
      Map<String, Object> post = Map.of("sentAt", deviceClock, "fixes", List.of(fix));
      Map<String, Object> s = call("POST", "/api/trips/" + id + "/fixes?routeVersion=" + routeVersion, post).json();
      if (s.get("route") != null) routeVersion = ((Double) s.get("routeVersion")).intValue();
      assertEquals("tracking", s.get("phase"));
      assertEquals(road.length() - along, (Double) s.get("remaining"), 60);
      if (s.get("ringing") != null) {
        ring = (String) s.get("ringing");
        ringRemaining = road.length() - along;
      }
    }
    assertEquals("distance", ring);
    assertTrue(ringRemaining <= 2000 && ringRemaining > 1800, "rang at " + ringRemaining);
    assertTrue(routeVersion >= 1);
  }

  @Test
  void phoneCanReportAnAlarmItRangOffline() throws Exception {
    LatLng origin = Geo.destinationPoint(DEST, 200, 3000);
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("destination", destination());
    body.put("settings", settings(2000, 0));
    body.put("origin", Map.of("lat", origin.lat(), "lng", origin.lng()));
    String id = (String) call("POST", "/api/trips", body).json().get("tripId");
    LatLng near = Geo.destinationPoint(DEST, 200, 1500);
    Map<String, Object> fix = Map.of("lat", near.lat(), "lng", near.lng(), "accuracy", 8, "timestamp", clock.get());
    Map<String, Object> post = Map.of("sentAt", clock.get(), "fixes", List.of(fix), "approachFired", true);
    Map<String, Object> s = call("POST", "/api/trips/" + id + "/fixes", post).json();
    assertNull(s.get("ringing"), "the phone already woke the rider");
    assertEquals(true, s.get("approachFired"));
  }

  @Test
  void rejectsBadInputAndUnknownTrips() throws Exception {
    assertEquals(400, call("POST", "/api/trips", Map.of("settings", settings(2000, 0))).status());
    Map<String, Object> badSettings = new LinkedHashMap<>();
    badSettings.put("destination", destination());
    badSettings.put("settings", settings(5, 0));
    assertEquals(400, call("POST", "/api/trips", badSettings).status());
    assertEquals(404, call("GET", "/api/trips/does-not-exist", null).status());
    assertEquals(404, call("GET", "/api/nope", null).status());
    assertEquals(405, call("DELETE", "/api/health", null).status());

    HttpRequest malformed =
        HttpRequest.newBuilder(URI.create(base + "/api/trips")).POST(HttpRequest.BodyPublishers.ofString("{oops")).build();
    assertEquals(400, http.send(malformed, HttpResponse.BodyHandlers.ofString()).statusCode());

    HttpRequest preflight =
        HttpRequest.newBuilder(URI.create(base + "/api/trips")).method("OPTIONS", HttpRequest.BodyPublishers.noBody()).build();
    HttpResponse<String> res = http.send(preflight, HttpResponse.BodyHandlers.ofString());
    assertEquals(204, res.statusCode());
    assertEquals("*", res.headers().firstValue("Access-Control-Allow-Origin").orElse(""));
  }

  @Test
  void servesTheFrontendWithSecurityHeaders() throws Exception {
    Reply page = call("GET", "/", null);
    assertEquals(200, page.status());
    assertTrue(page.raw().body().contains("Hibernate Express"));
    assertTrue(page.raw().headers().firstValue("Content-Security-Policy").orElse("").contains("default-src 'self'"));
    assertEquals("no-cache", page.raw().headers().firstValue("Cache-Control").orElse(""));

    Reply asset = call("GET", "/assets/app-abc123.js", null);
    assertTrue(asset.raw().headers().firstValue("Cache-Control").orElse("").contains("immutable"));
    assertEquals(200, call("GET", "/trip/123", null).status(), "app routes fall back to index.html");
    assertEquals(404, call("GET", "/missing.png", null).status());
    assertFalse(call("GET", "/../pom.xml", null).raw().body().contains("<project"));
  }
}
