package com.hibernateexpress.api;

import com.hibernateexpress.external.GeocodingClient;
import com.hibernateexpress.external.Place;
import com.hibernateexpress.external.PlaceSearch;
import com.hibernateexpress.external.PrefetchedGeocoder;
import com.hibernateexpress.external.RoutingException;
import com.hibernateexpress.geo.Geo;
import com.hibernateexpress.geo.LatLng;
import com.hibernateexpress.json.Json;
import com.hibernateexpress.parse.CoordinateParser;
import com.hibernateexpress.push.PushSender;
import com.hibernateexpress.push.PushSubscription;
import com.hibernateexpress.push.WebPush;
import com.hibernateexpress.trip.AlarmReason;
import com.hibernateexpress.route.Polyline;
import com.hibernateexpress.route.RouteLine;
import com.hibernateexpress.sim.RideSimulator;
import com.hibernateexpress.trip.EngineOptions;
import com.hibernateexpress.trip.Fix;
import com.hibernateexpress.trip.RouteData;
import com.hibernateexpress.trip.TravelMode;
import com.hibernateexpress.trip.TripEngine;
import com.hibernateexpress.trip.TripSnapshot;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * The Hibernate Express REST API on the JDK's built-in HTTP server, one virtual thread per request.
 *
 * <pre>
 * GET    /api/health
 * GET    /api/search?q=&amp;lat=&amp;lng=&amp;zoom=&amp;explicit=1   place search (type-ahead)
 * POST   /api/search   {q, lat, lng, zoom, explicit, photon[]}   the same, with the phone's Photon results
 * GET    /api/reverse?lat=&amp;lng=                          name a dropped pin
 * GET    /api/route?from=lat,lng&amp;to=lat,lng              road route preview
 * POST   /api/coordinates      {text}                    parse pasted coordinates / map links
 * POST   /api/trips            {destination, settings, origin?, demo?}
 * GET    /api/trips/{id}?routeVersion=N                  current trip state
 * POST   /api/trips/{id}/fixes {sentAt, fixes[], approachFired?, arrivalFired?}
 * POST   /api/trips/{id}/ack | /snooze
 * DELETE /api/trips/{id}
 * </pre>
 */
public final class ApiServer {

  public static final String VERSION = "1.0.0";
  private static final Logger LOG = Logger.getLogger(ApiServer.class.getName());
  private static final int MAX_BODY_BYTES = 512 * 1024;
  private static final int MAX_FIXES_PER_REQUEST = 600;
  private static final int MAX_PHONE_LOOKUPS = 4;
  private static final long WAIT_SECONDS = 20;
  private static final long MAX_FIX_AGE_MS = 15 * 60_000;

  private final HttpServer server;
  private final ExecutorService executor;
  private final ScheduledExecutorService janitor;
  private final Services services;
  private final PlaceSearch placeSearch;
  private final TripStore trips;
  private final RateLimiter limiter;
  private final String allowedOrigin;
  private final WebPush webPush;
  private final PushSender pushSender;
  private final String keepAwakeUrl;
  private final HttpClient keepAwakeClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

  /** A phone that hasn't called for this long has had its page paused (it calls every second). */
  static final long PHONE_QUIET_MS = 8_000;
  /** Who runs this server, for push services (RFC 8292 "sub"); a URL, so no e-mail is shared. */
  public static final String PUSH_SUBJECT = "https://hibernate-express.netlify.app";

  public ApiServer(InetSocketAddress address, Services services, Path staticRoot, String allowedOrigin)
      throws IOException {
    this(address, services, staticRoot, allowedOrigin, WebPush.generate(PUSH_SUBJECT), PushSender.jdk(), null);
  }

  /**
   * @param keepAwakeUrl this server's public address: while trips are running it is called every
   *     10 minutes, so a host that sleeps idle servers keeps this one awake for the alarm
   */
  public ApiServer(
      InetSocketAddress address,
      Services services,
      Path staticRoot,
      String allowedOrigin,
      WebPush webPush,
      PushSender pushSender,
      String keepAwakeUrl)
      throws IOException {
    this.webPush = webPush;
    this.pushSender = pushSender;
    this.keepAwakeUrl = keepAwakeUrl == null || keepAwakeUrl.isBlank() ? null : keepAwakeUrl.replaceAll("/+$", "");
    this.services = services;
    this.placeSearch = new PlaceSearch(services.geocoder(), services.nearby(), services.links());
    this.allowedOrigin = allowedOrigin == null || allowedOrigin.isBlank() ? "*" : allowedOrigin;
    this.trips = new TripStore(services.wallClock(), 5000, 3 * 3600_000L);
    this.limiter = new RateLimiter(60, 10_000, services.wallClock());
    this.server = HttpServer.create(address, 0);
    this.executor = Executors.newVirtualThreadPerTaskExecutor();
    server.setExecutor(executor);
    server.createContext("/api/", this::handleApi);
    if (staticRoot != null) server.createContext("/", new StaticFiles(staticRoot));
    this.janitor =
        Executors.newSingleThreadScheduledExecutor(r -> {
          Thread t = new Thread(r, "hx-janitor");
          t.setDaemon(true);
          return t;
        });
  }

  public void start() {
    server.start();
    janitor.scheduleAtFixedRate(() -> {
      trips.purge();
      limiter.purge();
    }, 5, 5, TimeUnit.MINUTES);
    // A task that throws is never run again, so these catch everything.
    janitor.scheduleAtFixedRate(() -> {
      try {
        pushTick();
      } catch (RuntimeException e) {
        LOG.log(Level.WARNING, "Push check failed", e);
      }
    }, 2, 2, TimeUnit.SECONDS);
    if (keepAwakeUrl != null) {
      janitor.scheduleAtFixedRate(() -> {
        try {
          keepAwake();
        } catch (RuntimeException e) {
          LOG.log(Level.INFO, "Keep-awake call failed", e);
        }
      }, 10, 10, TimeUnit.MINUTES);
    }
  }

  // ------------------------------------------------------ the alarm with the screen off

  /**
   * Phones pause web pages when the screen locks. The server keeps each trip going (counting on
   * from the last GPS fix at the bus's pace, leaning early), and when an alarm is due on a trip
   * whose phone has gone quiet, sends it as a push notification — again every 30 s until answered.
   */
  void pushTick() {
    long wall = services.wallClock().getAsLong();
    trips.forEach((id, session) -> {
      PushSubscription sub = session.push();
      if (sub == null || session.isDemo() || wall - session.lastSeen() < PHONE_QUIET_MS) return;
      TripSnapshot snap = session.refresh(wall);
      if (!session.pushDue(snap.ringing(), wall)) return;
      byte[] message = Json.stringify(alarmMessage(id, session, snap, sub)).getBytes(StandardCharsets.UTF_8);
      pushSender
          .send(webPush.request(sub, message, 120, wall / 1000))
          .thenAccept(status -> {
            if (status == 404 || status == 410) session.dropPush(sub);
            else if (status >= 400) LOG.info("Push service answered " + status);
          })
          .exceptionally(e -> {
            LOG.info("Push failed: " + e);
            return null;
          });
    });
  }

  static Map<String, Object> alarmMessage(String id, TripSession session, TripSnapshot snap, PushSubscription sub) {
    AlarmReason reason = snap.ringing();
    String stop = session.destination().name();
    boolean arrived = reason == AlarmReason.ARRIVAL;
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("type", "alarm");
    m.put("tripId", id);
    m.put("reason", reason.json());
    m.put("title", arrived ? "📍 You've arrived!" : "⏰ Wake up! Your stop is coming up");
    m.put("body", arrived
        ? stop + " — grab your bag, it's time to get off."
        : distanceText(snap.remaining()) + " to " + stop + (snap.gpsLost() ? " (estimated: your phone's GPS is paused)" : ""));
    if (sub.apiBase() != null) m.put("api", sub.apiBase());
    return m;
  }

  static String distanceText(double metres) {
    if (Double.isNaN(metres)) return "Almost there";
    if (metres < 950) return Math.max(10, Math.round(metres / 10.0) * 10) + " m";
    return String.format(Locale.ROOT, metres < 9_950 ? "%.1f km" : "%.0f km", metres / 1000.0);
  }

  /** Keeps a host that sleeps idle servers from sleeping while a trip may still need its alarm. */
  private void keepAwake() {
    if (!trips.anyLive()) return;
    HttpRequest ping = HttpRequest.newBuilder(URI.create(keepAwakeUrl + "/api/health")).timeout(Duration.ofSeconds(20)).GET().build();
    keepAwakeClient.sendAsync(ping, HttpResponse.BodyHandlers.discarding()).exceptionally(e -> null);
  }

  public void stop() {
    server.stop(0);
    janitor.shutdownNow();
    executor.shutdown();
  }

  public int port() {
    return server.getAddress().getPort();
  }

  TripStore trips() {
    return trips;
  }

  // -------------------------------------------------------------------------- plumbing

  private void handleApi(HttpExchange ex) {
    try {
      Headers h = ex.getResponseHeaders();
      h.set("Access-Control-Allow-Origin", allowedOrigin);
      h.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      h.set("Access-Control-Allow-Headers", "Content-Type");
      h.set("Cache-Control", "no-store");
      h.set("X-Content-Type-Options", "nosniff");
      String method = ex.getRequestMethod().toUpperCase(Locale.ROOT);
      if (method.equals("OPTIONS")) {
        ex.sendResponseHeaders(204, -1);
        return;
      }
      int status = 200;
      Object body;
      try {
        body = dispatch(ex, method);
      } catch (ApiError e) {
        status = e.status();
        body = Map.of("error", e.getMessage());
      } catch (Json.ParseException e) {
        status = 400;
        body = Map.of("error", "Malformed JSON: " + e.getMessage());
      } catch (RuntimeException e) {
        LOG.log(Level.WARNING, "Unhandled API error", e);
        status = 500;
        body = Map.of("error", "Something went wrong on the server");
      }
      sendJson(ex, status, body);
    } catch (IOException e) {
      LOG.log(Level.FINE, "Client went away", e);
    } finally {
      ex.close();
    }
  }

  private Object dispatch(HttpExchange ex, String method) throws IOException {
    String path = ex.getRequestURI().getPath();
    String[] parts =
        Arrays.stream(path.substring("/api/".length()).split("/")).filter(s -> !s.isEmpty()).toArray(String[]::new);
    Map<String, String> query = parseQuery(ex.getRequestURI().getRawQuery());
    if (parts.length == 0) throw ApiError.notFound("Unknown endpoint");
    String ip = clientIp(ex);
    switch (parts[0]) {
      case "health" -> {
        requireMethod(method, "GET");
        return health();
      }
      case "push" -> {
        // GET /api/push/key: the key phones subscribe with, for the screen-off alarm.
        requireMethod(method, "GET");
        if (parts.length != 2 || !parts[1].equals("key")) throw ApiError.notFound("Unknown endpoint");
        return Map.of("publicKey", webPush.publicKey());
      }
      case "search" -> {
        limit(ip);
        if (method.equals("POST")) return searchWithPhoneResults(Json.object(readJson(ex)));
        requireMethod(method, "GET");
        return search(query);
      }
      case "reverse" -> {
        requireMethod(method, "GET");
        limit(ip);
        return reverse(query);
      }
      case "route" -> {
        requireMethod(method, "GET");
        limit(ip);
        return route(query);
      }
      case "coordinates" -> {
        requireMethod(method, "POST");
        return coordinates(Json.object(readJson(ex)));
      }
      case "trips" -> {
        return trips(ex, method, parts, query, ip);
      }
      default -> throw ApiError.notFound("Unknown endpoint");
    }
  }

  private Object trips(HttpExchange ex, String method, String[] parts, Map<String, String> query, String ip)
      throws IOException {
    long wall = services.wallClock().getAsLong();
    int knownRoute = intParam(query, "routeVersion", -1);
    if (parts.length == 1) {
      requireMethod(method, "POST");
      limit(ip);
      return createTrip(Json.object(readJson(ex)), wall);
    }
    TripSession session = trips.get(parts[1]);
    if (parts.length == 2) {
      if (method.equals("GET")) return SnapshotJson.of(session, session.refresh(wall), knownRoute, wall);
      if (method.equals("DELETE")) {
        trips.remove(parts[1]);
        return Map.of("ok", true);
      }
      throw new ApiError(405, "Method not allowed");
    }
    if (parts.length == 3) {
      requireMethod(method, "POST");
      switch (parts[2]) {
        case "fixes" -> {
          return postFixes(session, Json.object(readJson(ex)), knownRoute, wall);
        }
        case "ack" -> {
          session.engine().acknowledge();
          return SnapshotJson.of(session, session.refresh(wall), knownRoute, wall);
        }
        case "snooze" -> {
          synchronized (session) {
            session.engine().snooze(session.now(wall));
          }
          return SnapshotJson.of(session, session.refresh(wall), knownRoute, wall);
        }
        case "push" -> {
          // The phone's push subscription, so the alarm still arrives if its page gets paused.
          PushSubscription sub;
          try {
            sub = PushSubscription.parse(Json.object(readJson(ex)));
          } catch (IllegalArgumentException bad) {
            throw ApiError.badRequest(bad.getMessage());
          }
          if (session.isDemo()) return Map.of("ok", false);
          session.setPush(sub);
          return Map.of("ok", true);
        }
        default -> throw ApiError.notFound("Unknown trip action");
      }
    }
    throw ApiError.notFound("Unknown endpoint");
  }

  // ------------------------------------------------------------------------- endpoints

  private Object health() {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("ok", true);
    m.put("service", "hibernate-express");
    m.put("version", VERSION);
    m.put("activeTrips", trips.size());
    return m;
  }

  private Object search(Map<String, String> query) {
    LatLng bias = latLngParams(query.get("lat"), query.get("lng"));
    int zoom = (int) doubleParam(query, "zoom", 12);
    boolean explicit = "1".equals(query.get("explicit")) || "true".equals(query.get("explicit"));
    return runSearch(query.getOrDefault("q", ""), bias, zoom, explicit, null);
  }

  /**
   * The same search, plus type-ahead results the phone fetched from Photon itself
   * ({@code photon: [{q, result}]}): the public Photon server refuses search requests from some
   * cloud hosts, while each phone has its own connection. {@code photonNeeded} in the reply lists
   * look-ups the server still couldn't make ("ameerpet" in "atm in ameerpet"), for the phone to
   * fetch and ask once more. The ranking, near-me places, plus codes and links stay in Java.
   */
  private Object searchWithPhoneResults(Map<String, Object> body) {
    LatLng bias =
        body.get("lat") instanceof Number lat && body.get("lng") instanceof Number lng
            ? new LatLng(lat.doubleValue(), lng.doubleValue())
            : null;
    if (bias != null && !bias.isValid()) bias = null;
    int zoom = body.get("zoom") instanceof Number z ? z.intValue() : 12;
    boolean explicit = Boolean.TRUE.equals(body.get("explicit"));
    Map<String, List<Place>> supplied = new HashMap<>();
    List<?> photon = Json.list(body, "photon");
    for (Object item : photon.subList(0, Math.min(photon.size(), MAX_PHONE_LOOKUPS))) {
      Map<String, Object> entry = Json.object(item);
      String lookup = Json.string(entry, "q", "").trim();
      if (lookup.isEmpty() || lookup.length() > 200) continue;
      supplied.put(lookup, GeocodingClient.parsePhotonSearch(entry.get("result")));
    }
    return runSearch(Json.string(body, "q", ""), bias, zoom, explicit, new PrefetchedGeocoder(services.geocoder(), supplied));
  }

  private Object runSearch(String raw, LatLng bias, int zoom, boolean explicit, PrefetchedGeocoder phone) {
    String q = raw.trim();
    if (q.length() < 2) throw ApiError.badRequest("Type at least 2 characters");
    if (q.length() > 200) q = q.substring(0, 200);
    PlaceSearch search = phone == null ? placeSearch : new PlaceSearch(phone, services.nearby(), services.links());
    PlaceSearch.Result result;
    try {
      result = await(search.search(q, bias, zoom, explicit), "Search");
    } catch (ApiError e) {
      // Nothing found only because a look-up is missing: the phone fetches it and asks again.
      if (phone == null || phone.missing().isEmpty() || e.status() != 502) throw e;
      result = new PlaceSearch.Result(List.of(), true, null);
    }
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("places", result.places().stream().map(Place::toJson).toList());
    m.put("more", result.more());
    if (result.message() != null) m.put("message", result.message());
    if (phone != null && !phone.missing().isEmpty()) m.put("photonNeeded", phone.missing());
    return m;
  }

  private Object reverse(Map<String, String> query) {
    LatLng at = latLngParams(query.get("lat"), query.get("lng"));
    if (at == null) throw ApiError.badRequest("lat and lng are required");
    Place place = await(services.geocoder().reverse(at), "Place lookup");
    Map<String, Object> m = new HashMap<>();
    m.put("place", place == null ? null : place.toJson());
    return m;
  }

  private Object route(Map<String, String> query) {
    LatLng from = latLngParam(query.get("from"));
    LatLng to = latLngParam(query.get("to"));
    if (from == null || to == null) throw ApiError.badRequest("from and to must look like lat,lng");
    RouteData route = await(services.router().route(from, to), "Routing");
    Map<String, Object> r = new LinkedHashMap<>();
    r.put("kind", route.kind().json());
    r.put("provider", route.provider());
    r.put("distance", SnapshotJson.round(route.distance(), 1));
    r.put("duration", SnapshotJson.round(route.duration(), 1));
    r.put("length", SnapshotJson.round(new RouteLine(route.points()).length(), 1));
    r.put("polyline", Polyline.encode(route.points()));
    return Map.of("route", r);
  }

  private Object coordinates(Map<String, Object> body) {
    String text = Json.string(body, "text", "");
    if (text.length() > 2000) throw ApiError.badRequest("That text is too long");
    CoordinateParser.Result result = await(placeSearch.coordinates(text), "Link look-up");
    Map<String, Object> m = new LinkedHashMap<>();
    if (result instanceof CoordinateParser.Ok ok) {
      m.put("ok", true);
      m.put("lat", ok.value().lat());
      m.put("lng", ok.value().lng());
    } else if (result instanceof CoordinateParser.Err err) {
      m.put("ok", false);
      m.put("error", err.error());
    }
    return m;
  }

  private Object createTrip(Map<String, Object> body, long wall) {
    Place destination = place(Json.object(body.get("destination")));
    TripSettings settings = TripSettings.fromJson(Json.object(body.get("settings")));
    boolean demo = Json.bool(body, "demo", false);
    Map<String, Object> originJson = Json.object(body.get("origin"));
    LatLng origin = originJson.isEmpty() ? null : latLng(originJson);

    TripSession session = demo ? createDemo(destination, settings, origin, wall) : createLive(destination, settings, origin, wall);
    String id = trips.add(session);
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("tripId", id);
    m.put("demo", demo);
    m.put("destination", destination.toJson());
    m.put("settings", settings.toJson());
    m.put("snapshot", SnapshotJson.of(session, session.refresh(wall), -1, wall));
    return m;
  }

  private TripSession createLive(Place destination, TripSettings settings, LatLng origin, long wall) {
    TripEngine engine =
        new TripEngine(
            destination.position(),
            settings.alarm(),
            services.router(),
            services.wallClock(),
            EngineOptions.forMode(settings.mode()),
            null);
    if (origin != null) engine.prefetchRoute(origin);
    return new TripSession(engine, destination, settings, null, wall);
  }

  /**
   * A 40-second demo: a simulated bus starts far enough out for both alarm rules to trigger, on
   * a real road route towards the chosen stop.
   */
  private TripSession createDemo(Place destination, TripSettings settings, LatLng user, long wall) {
    LatLng dest = destination.position();
    double timeNeed = settings.timeMin() > 0 ? settings.timeMin() * 60 * (42 / 3.6) * 1.6 : 0;
    double offset = Geo.clamp(Math.max(Math.max(4000, settings.distanceM() * 2.2), timeNeed), 4000, 18_000);
    double towards = user != null && Geo.haversine(dest, user) > 1000 ? Geo.bearing(dest, user) : 215;
    LatLng start = Geo.destinationPoint(dest, towards, offset);
    RouteData route;
    if (settings.mode() == TravelMode.RAIL) {
      route = RouteData.direct(start, dest, 55 / 3.6);
    } else {
      route = tryAwait(services.router().route(start, dest)).orElseGet(() -> RouteData.direct(start, dest, 25 / 3.6));
    }
    RideSimulator simulator =
        new RideSimulator(
            new RouteLine(route.points()),
            settings.mode() == TravelMode.RAIL ? 75 : 42,
            40,
            500,
            6,
            ThreadLocalRandom.current().nextLong(),
            wall);
    TripEngine engine =
        new TripEngine(dest, settings.alarm(), services.router(), services.wallClock(), EngineOptions.forMode(settings.mode()), route);
    simulator.start(engine);
    return new TripSession(engine, destination, settings, simulator, wall);
  }

  private Object postFixes(TripSession session, Map<String, Object> body, int knownRoute, long wall) {
    if (session.isDemo()) throw ApiError.badRequest("Demo rides use simulated GPS");
    List<?> fixes = Json.list(body, "fixes");
    if (fixes.size() > MAX_FIXES_PER_REQUEST) throw ApiError.badRequest("Too many fixes in one request");
    double sentAt = Json.number(body, "sentAt", Double.NaN);
    // Device clocks drift: map device time onto server time using when the batch was sent.
    long offset = Double.isFinite(sentAt) ? wall - (long) sentAt : 0;
    TripEngine engine = session.engine();
    boolean approach = Json.bool(body, "approachFired", false);
    boolean arrival = Json.bool(body, "arrivalFired", false);
    if (approach || arrival) engine.markFired(approach, arrival);

    for (Object item : fixes) {
      Map<String, Object> f = Json.object(item);
      double lat = Json.number(f, "lat", Double.NaN);
      double lng = Json.number(f, "lng", Double.NaN);
      if (!new LatLng(lat, lng).isValid()) continue;
      double accuracy = Json.number(f, "accuracy", 50);
      if (!(accuracy > 0) || !Double.isFinite(accuracy)) accuracy = 50;
      double speed = Json.number(f, "speed", Double.NaN);
      double heading = Json.number(f, "heading", Double.NaN);
      double ts = Json.number(f, "timestamp", Double.isFinite(sentAt) ? sentAt : wall);
      long at = (long) Geo.clamp((long) ts + offset, wall - MAX_FIX_AGE_MS, wall);
      engine.handleFix(new Fix(lat, lng, accuracy, speed, heading, (long) ts), at);
    }
    return SnapshotJson.of(session, session.refresh(wall), knownRoute, wall);
  }

  // ------------------------------------------------------------------------- helpers

  private static Place place(Map<String, Object> json) {
    LatLng p = latLng(json);
    if (p == null) throw ApiError.badRequest("A destination with valid lat and lng is required");
    String name = Json.string(json, "name", "Your stop").trim();
    if (name.isEmpty()) name = "Your stop";
    if (name.length() > 200) name = name.substring(0, 200);
    String detail = Json.string(json, "detail", "");
    if (detail.length() > 300) detail = detail.substring(0, 300);
    return new Place(name, detail, p.lat(), p.lng(), Place.Kind.fromJson(Json.string(json, "kind", "pin")));
  }

  private static LatLng latLng(Map<String, Object> json) {
    LatLng p = new LatLng(Json.number(json, "lat", Double.NaN), Json.number(json, "lng", Double.NaN));
    return p.isValid() ? p : null;
  }

  private static LatLng latLngParam(String value) {
    if (value == null) return null;
    String[] parts = value.split(",");
    if (parts.length != 2) return null;
    return latLngParams(parts[0], parts[1]);
  }

  private static LatLng latLngParams(String lat, String lng) {
    if (lat == null || lng == null) return null;
    try {
      LatLng p = new LatLng(Double.parseDouble(lat.trim()), Double.parseDouble(lng.trim()));
      return p.isValid() ? p : null;
    } catch (NumberFormatException e) {
      return null;
    }
  }

  private static double doubleParam(Map<String, String> query, String key, double fallback) {
    try {
      return query.containsKey(key) ? Double.parseDouble(query.get(key)) : fallback;
    } catch (NumberFormatException e) {
      return fallback;
    }
  }

  private static int intParam(Map<String, String> query, String key, int fallback) {
    try {
      return query.containsKey(key) ? Integer.parseInt(query.get(key)) : fallback;
    } catch (NumberFormatException e) {
      return fallback;
    }
  }

  /** Waits for an upstream call and turns failures into user-facing errors. */
  private static <T> T await(CompletableFuture<T> future, String what) {
    try {
      return future.get(WAIT_SECONDS, TimeUnit.SECONDS);
    } catch (TimeoutException e) {
      throw new ApiError(504, what + " is taking too long, please try again");
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new ApiError(503, what + " was interrupted");
    } catch (ExecutionException e) {
      Throwable cause = e.getCause();
      if (cause instanceof RoutingException re && re.noRoute()) throw new ApiError(422, re.getMessage());
      LOG.log(Level.INFO, what + " failed", cause);
      throw new ApiError(502, what + " service is unreachable right now");
    }
  }

  private static <T> Optional<T> tryAwait(CompletableFuture<T> future) {
    try {
      return Optional.ofNullable(future.get(WAIT_SECONDS, TimeUnit.SECONDS));
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      return Optional.empty();
    } catch (ExecutionException | TimeoutException e) {
      return Optional.empty();
    }
  }

  private void limit(String ip) {
    if (!limiter.allow(ip)) throw new ApiError(429, "Too many requests, slow down a little");
  }

  private static void requireMethod(String method, String expected) {
    if (!method.equals(expected)) throw new ApiError(405, "Method not allowed");
  }

  private static String clientIp(HttpExchange ex) {
    String forwarded = ex.getRequestHeaders().getFirst("X-Forwarded-For");
    if (forwarded != null && !forwarded.isBlank()) return forwarded.split(",")[0].trim();
    return ex.getRemoteAddress().getAddress().getHostAddress();
  }

  private static Map<String, String> parseQuery(String raw) {
    Map<String, String> out = new HashMap<>();
    if (raw == null || raw.isEmpty()) return out;
    for (String pair : raw.split("&")) {
      int eq = pair.indexOf('=');
      String key = eq < 0 ? pair : pair.substring(0, eq);
      String value = eq < 0 ? "" : pair.substring(eq + 1);
      try {
        out.put(URLDecoder.decode(key, StandardCharsets.UTF_8), URLDecoder.decode(value, StandardCharsets.UTF_8));
      } catch (IllegalArgumentException e) {
        // Skip malformed parameters.
      }
    }
    return out;
  }

  private static Object readJson(HttpExchange ex) throws IOException {
    try (InputStream in = ex.getRequestBody()) {
      byte[] bytes = in.readNBytes(MAX_BODY_BYTES + 1);
      if (bytes.length > MAX_BODY_BYTES) throw new ApiError(413, "Request body is too large");
      String text = new String(bytes, StandardCharsets.UTF_8).trim();
      return text.isEmpty() ? Map.of() : Json.parse(text);
    }
  }

  private static void sendJson(HttpExchange ex, int status, Object body) throws IOException {
    byte[] bytes = Json.stringify(body).getBytes(StandardCharsets.UTF_8);
    ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
    ex.sendResponseHeaders(status, bytes.length);
    try (OutputStream out = ex.getResponseBody()) {
      out.write(bytes);
    }
  }

  /** Visible for tests: a JSON list of fixes to post. */
  static List<Map<String, Object>> fixesJson(List<Fix> fixes) {
    List<Map<String, Object>> out = new ArrayList<>();
    for (Fix f : fixes) {
      Map<String, Object> m = new LinkedHashMap<>();
      m.put("lat", f.lat());
      m.put("lng", f.lng());
      m.put("accuracy", f.accuracy());
      m.put("speed", f.speed());
      m.put("timestamp", f.timestamp());
      out.add(m);
    }
    return out;
  }
}
