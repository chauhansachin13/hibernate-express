package com.hibernateexpress.external;

import com.hibernateexpress.geo.LatLng;
import com.hibernateexpress.json.Json;
import com.hibernateexpress.trip.RouteData;
import com.hibernateexpress.trip.RouteProvider;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.function.LongSupplier;

/**
 * Road routes from public OSRM servers (OpenStreetMap data). The second server is run by FOSSGIS
 * for openstreetmap.org and is used when the first is busy. Results are cached for 15 minutes,
 * so the route preview and the trip that follows share one request.
 */
public final class OsrmClient implements RouteProvider {

  public record Endpoint(String name, String baseUrl) {}

  public static final List<Endpoint> PUBLIC_ENDPOINTS =
      List.of(
          new Endpoint("OSRM", "https://router.project-osrm.org/route/v1/driving/"),
          new Endpoint(
              "OSRM (openstreetmap.de)", "https://routing.openstreetmap.de/routed-car/route/v1/driving/"));

  private static final String QUERY = "?overview=full&geometries=geojson&alternatives=false&steps=false";
  private static final Duration TIMEOUT = Duration.ofSeconds(15);

  /** Outcome of one endpoint: a route, a final failure, or an error that allows the next one. */
  private record Outcome(RouteData route, RoutingException fatal, Throwable error) {}

  private final HttpFetcher http;
  private final List<Endpoint> endpoints;
  private final LruCache<String, RouteData> cache;

  public OsrmClient(HttpFetcher http, LongSupplier clock) {
    this(http, PUBLIC_ENDPOINTS, clock);
  }

  public OsrmClient(HttpFetcher http, List<Endpoint> endpoints, LongSupplier clock) {
    this.http = http;
    this.endpoints = List.copyOf(endpoints);
    this.cache = new LruCache<>(500, 15 * 60_000, clock);
  }

  @Override
  public CompletableFuture<RouteData> route(LatLng from, LatLng to) {
    String key = String.format(Locale.ROOT, "%.4f,%.4f>%.4f,%.4f", from.lat(), from.lng(), to.lat(), to.lng());
    RouteData cached = cache.get(key);
    if (cached != null) return CompletableFuture.completedFuture(cached);
    return attempt(0, from, to, null).thenApply(route -> {
      cache.put(key, route);
      return route;
    });
  }

  private CompletableFuture<RouteData> attempt(int index, LatLng from, LatLng to, Throwable lastError) {
    if (index >= endpoints.size()) {
      Throwable error = lastError != null ? lastError : new RoutingException("Routing service unavailable", false);
      return CompletableFuture.failedFuture(error);
    }
    Endpoint endpoint = endpoints.get(index);
    String coords =
        String.format(Locale.ROOT, "%.6f,%.6f;%.6f,%.6f", from.lng(), from.lat(), to.lng(), to.lat());
    return http.get(endpoint.baseUrl() + coords + QUERY, TIMEOUT)
        .handle((res, err) -> err != null ? new Outcome(null, null, unwrap(err)) : interpret(res, endpoint))
        .thenCompose(outcome -> {
          if (outcome.route() != null) return CompletableFuture.completedFuture(outcome.route());
          if (outcome.fatal() != null) return CompletableFuture.failedFuture(outcome.fatal());
          return attempt(index + 1, from, to, outcome.error());
        });
  }

  private static Outcome interpret(HttpFetcher.Response res, Endpoint endpoint) {
    Map<String, Object> data;
    try {
      data = Json.object(Json.parse(res.body()));
    } catch (RuntimeException e) {
      return new Outcome(null, null, new RoutingException(endpoint.name() + " sent an unreadable answer", false));
    }
    String code = Json.string(data, "code", "");
    if (code.equals("NoRoute") || code.equals("NoSegment")) {
      return new Outcome(null, new RoutingException("No road route found to this place", true), null);
    }
    List<?> routes = Json.list(data, "routes");
    if (res.status() != 200 || !code.equals("Ok") || routes.isEmpty()) {
      String message = Json.string(data, "message", endpoint.name() + " responded " + res.status());
      return new Outcome(null, null, new RoutingException(message, false));
    }
    Map<String, Object> route = Json.object(routes.get(0));
    List<?> coordinates = Json.list(Json.object(route.get("geometry")), "coordinates");
    List<LatLng> points = new ArrayList<>(coordinates.size());
    for (Object c : coordinates) {
      if (c instanceof List<?> pair && pair.size() >= 2 && pair.get(0) instanceof Number lng && pair.get(1) instanceof Number lat) {
        points.add(new LatLng(lat.doubleValue(), lng.doubleValue()));
      }
    }
    if (points.size() < 2) {
      return new Outcome(null, null, new RoutingException(endpoint.name() + " returned an empty route", false));
    }
    return new Outcome(
        new RouteData(
            points,
            Json.number(route, "distance", Double.NaN),
            Json.number(route, "duration", Double.NaN),
            RouteData.Kind.ROAD,
            endpoint.name()),
        null,
        null);
  }

  static Throwable unwrap(Throwable error) {
    Throwable e = error;
    while (e instanceof CompletionException && e.getCause() != null) e = e.getCause();
    return e;
  }
}
