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
import com.hibernateexpress.push.WebPush;
import com.hibernateexpress.push.WebPushTest;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Flow;
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
  void searchRanksPhotonResultsSentByThePhone() throws Exception {
    // A Photon reply as the phone fetched it: the server's own geocoder would answer "National
    // Institute of Technology" for anything, so the result shows the phone's data was used.
    Map<String, Object> station = Map.of(
        "type", "Feature",
        "geometry", Map.of("type", "Point", "coordinates", List.of(79.5113, 17.9748)),
        "properties", Map.of("name", "Kazipet Junction", "osm_key", "railway", "osm_value", "station", "state", "Telangana"));
    Map<String, Object> body = Map.of(
        "q", "kazipet junction",
        "lat", 17.98,
        "lng", 79.53,
        "zoom", 13,
        "explicit", false,
        "photon", List.of(Map.of("q", "Kazipet Junction", "result", Map.of("type", "FeatureCollection", "features", List.of(station)))));
    Reply reply = call("POST", "/api/search", body);
    assertEquals(200, reply.status());
    assertEquals("Kazipet Junction", Json.object(Json.list(reply.json(), "places").get(0)).get("name"));
    assertNull(reply.json().get("photonNeeded"));

    // Junk from a phone is ignored, never an error.
    Reply junk = call("POST", "/api/search", Map.of("q", "NIT Warangal", "photon", List.of(Map.of("q", "NIT Warangal", "result", "nonsense"))));
    assertEquals(200, junk.status());
    assertEquals(400, call("POST", "/api/search", Map.of("q", "a")).status());
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
  void ringsAPausedPhoneByPushUntilItAnswers() throws Exception {
    List<HttpRequest> sent = new CopyOnWriteArrayList<>();
    ApiServer pushing = new ApiServer(
        new InetSocketAddress("127.0.0.1", 0),
        new Services(ROUTER, GEOCODER, clock::get),
        null,
        "*",
        WebPush.generate(ApiServer.PUSH_SUBJECT),
        request -> {
          sent.add(request);
          return CompletableFuture.completedFuture(201);
        },
        null);
    pushing.start();
    String main = base;
    base = "http://127.0.0.1:" + pushing.port();
    try {
      assertEquals(87, ((String) call("GET", "/api/push/key", null).json().get("publicKey")).length());

      LatLng origin = Geo.destinationPoint(DEST, 200, 2600);
      Map<String, Object> body = new LinkedHashMap<>();
      body.put("destination", destination());
      body.put("settings", settings(2000, 0));
      body.put("origin", Map.of("lat", origin.lat(), "lng", origin.lng()));
      String id = (String) call("POST", "/api/trips", body).json().get("tripId");
      Map<String, Object> subscription = Map.of(
          "endpoint", "https://fcm.googleapis.com/fcm/send/test-phone",
          "keys", Map.of("p256dh", WebPushTest.UA_PUBLIC, "auth", WebPushTest.AUTH),
          "apiBase", "https://api.example");
      assertEquals(true, call("POST", "/api/trips/" + id + "/push", subscription).json().get("ok"));
      assertEquals(400, call("POST", "/api/trips/" + id + "/push", Map.of("endpoint", "https://evil.example/x")).status());

      // The phone reports the bus 1.9 km out: the 2 km alarm rings on the phone, which is awake.
      RouteLine road = new RouteLine(ROUTER.route(origin, DEST).join().points());
      for (double along : new double[] {0, 350, 700}) {
        clock.addAndGet(20_000);
        LatLng p = road.pointAt(along);
        Map<String, Object> fix = Map.of("lat", p.lat(), "lng", p.lng(), "accuracy", 8, "speed", 15, "timestamp", clock.get());
        call("POST", "/api/trips/" + id + "/fixes", Map.of("sentAt", clock.get(), "fixes", List.of(fix)));
      }
      pushing.pushTick();
      assertEquals(0, sent.size(), "no push while the phone itself is calling");

      // Then the screen locks and the page is paused: the server sends the alarm.
      clock.addAndGet(ApiServer.PHONE_QUIET_MS + 1000);
      pushing.pushTick();
      assertEquals(1, sent.size());
      HttpRequest push = sent.get(0);
      assertEquals("https://fcm.googleapis.com/fcm/send/test-phone", push.uri().toString());
      assertEquals("aes128gcm", push.headers().firstValue("Content-Encoding").orElse(""));
      assertTrue(push.headers().firstValue("Authorization").orElse("").startsWith("vapid t="));
      KeyPair phone = WebPush.keyPair(WebPush.b64d(WebPushTest.UA_PUBLIC), WebPush.b64d(WebPushTest.UA_PRIVATE));
      Map<String, Object> message = Json.object(Json.parse(
          new String(WebPushTest.decrypt(bodyOf(push), phone, WebPush.b64d(WebPushTest.AUTH)), StandardCharsets.UTF_8)));
      assertEquals("alarm", message.get("type"));
      assertEquals(id, message.get("tripId"));
      assertEquals("distance", message.get("reason"));
      assertEquals("https://api.example", message.get("api"));
      assertTrue(((String) message.get("title")).contains("Wake up"), message.toString());

      // Like an alarm clock: again after 30 s, not before.
      pushing.pushTick();
      assertEquals(1, sent.size());
      clock.addAndGet(31_000);
      pushing.pushTick();
      assertEquals(2, sent.size());

      // "I'm awake" (from the notification) stops it.
      call("POST", "/api/trips/" + id + "/ack", null);
      clock.addAndGet(ApiServer.PHONE_QUIET_MS + 31_000);
      pushing.pushTick();
      assertEquals(2, sent.size());
    } finally {
      base = main;
      pushing.stop();
    }
  }

  @Test
  void screenLockedLongBeforeTheStopStillGetsTheAlarmOnTime() throws Exception {
    List<Long> pushedAt = new CopyOnWriteArrayList<>();
    ApiServer pushing = new ApiServer(
        new InetSocketAddress("127.0.0.1", 0), new Services(ROUTER, GEOCODER, clock::get), null, "*",
        WebPush.generate(ApiServer.PUSH_SUBJECT),
        request -> {
          pushedAt.add(clock.get());
          return CompletableFuture.completedFuture(201);
        },
        null);
    pushing.start();
    String main = base;
    base = "http://127.0.0.1:" + pushing.port();
    try {
      // 8 km out, 2 km alarm, the bus at a steady 15 m/s (54 km/h).
      LatLng origin = Geo.destinationPoint(DEST, 200, 8000);
      Map<String, Object> body = new LinkedHashMap<>();
      body.put("destination", destination());
      body.put("settings", settings(2000, 0));
      body.put("origin", Map.of("lat", origin.lat(), "lng", origin.lng()));
      String id = (String) call("POST", "/api/trips", body).json().get("tripId");
      call("POST", "/api/trips/" + id + "/push", Map.of(
          "endpoint", "https://fcm.googleapis.com/fcm/send/test-phone",
          "keys", Map.of("p256dh", WebPushTest.UA_PUBLIC, "auth", WebPushTest.AUTH)));
      RouteLine road = new RouteLine(ROUTER.route(origin, DEST).join().points());
      long start = clock.get();
      // Two minutes of GPS from the awake phone, then the screen locks 6.2 km from the stop.
      for (int t = 0; t <= 120; t += 2) {
        clock.set(start + t * 1000L);
        LatLng p = road.pointAt(15.0 * t);
        Map<String, Object> fix = Map.of("lat", p.lat(), "lng", p.lng(), "accuracy", 8, "speed", 15, "timestamp", clock.get());
        call("POST", "/api/trips/" + id + "/fixes", Map.of("sentAt", clock.get(), "fixes", List.of(fix)));
      }
      // The bus drives on; only the server's own 2-second check runs.
      for (int t = 122; t <= 600 && pushedAt.isEmpty(); t += 2) {
        clock.set(start + t * 1000L);
        pushing.pushTick();
      }
      assertEquals(1, pushedAt.size(), "pushed once");
      double trulyLeft = road.length() - 15.0 * (pushedAt.get(0) - start) / 1000.0;
      // Never late, and not absurdly early: counting on without GPS leans early on purpose.
      assertTrue(trulyLeft >= 2000 && trulyLeft <= 2900, "rang with " + trulyLeft + " m truly left");
    } finally {
      base = main;
      pushing.stop();
    }
  }

  static byte[] bodyOf(HttpRequest request) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    CompletableFuture<Void> done = new CompletableFuture<>();
    request.bodyPublisher().orElseThrow().subscribe(new Flow.Subscriber<ByteBuffer>() {
      @Override
      public void onSubscribe(Flow.Subscription s) {
        s.request(Long.MAX_VALUE);
      }

      @Override
      public void onNext(ByteBuffer b) {
        byte[] bytes = new byte[b.remaining()];
        b.get(bytes);
        out.writeBytes(bytes);
      }

      @Override
      public void onError(Throwable t) {
        done.completeExceptionally(t);
      }

      @Override
      public void onComplete() {
        done.complete(null);
      }
    });
    done.join();
    return out.toByteArray();
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
