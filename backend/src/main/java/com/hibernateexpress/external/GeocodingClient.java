package com.hibernateexpress.external;

import com.hibernateexpress.geo.Geo;
import com.hibernateexpress.geo.LatLng;
import com.hibernateexpress.json.Json;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;

/**
 * Place search on OpenStreetMap data: Photon (komoot) for type-ahead and reverse look-ups,
 * Nominatim for explicit searches. Nominatim's usage policy allows at most one request per second
 * and no type-ahead, so its calls are spaced out and only made when the user asks for more.
 */
public final class GeocodingClient implements Geocoder, NearbyFinder {

  private static final String PHOTON = "https://photon.komoot.io";
  private static final String NOMINATIM = "https://nominatim.openstreetmap.org";
  private static final Duration TIMEOUT = Duration.ofSeconds(10);
  private static final long NOMINATIM_SPACING_MS = 1100;
  /** Photon results asked for; minor ones (service roads, land use…) are then dropped. */
  private static final int PHOTON_LIMIT = 24;
  private static final int NOMINATIM_LIMIT = 15;
  /** Keep minor results only when fewer major ones than this were found. */
  private static final int ENOUGH = 6;
  private static final int NEARBY_RESULTS = 12;
  /** Two places with the same name this close are one place (e.g. both sides of the road). */
  private static final double SAME_PLACE_M = 150;

  private final HttpFetcher http;
  private final LongSupplier clock;
  private final LruCache<String, List<Place>> searchCache;
  private final LruCache<String, List<Place>> nearbyCache;
  private final LruCache<String, Place> reverseCache;
  private final Object nominatimLock = new Object();
  private long nominatimNext;

  public GeocodingClient(HttpFetcher http, LongSupplier clock) {
    this.http = http;
    this.clock = clock;
    this.searchCache = new LruCache<>(2000, 30 * 60_000, clock);
    this.nearbyCache = new LruCache<>(1000, 30 * 60_000, clock);
    this.reverseCache = new LruCache<>(1000, 30 * 60_000, clock);
  }

  /**
   * The closest places of a kind: Photon's reverse look-up filtered by OpenStreetMap tag returns
   * them nearest first, named or not, without needing their name to contain the search words.
   */
  @Override
  public CompletableFuture<List<Place>> find(NearbyCategory category, LatLng center) {
    String key = String.format(Locale.ROOT, "%s|%.3f,%.3f", category.label(), center.lat(), center.lng());
    List<Place> cached = nearbyCache.get(key);
    if (cached != null) return CompletableFuture.completedFuture(cached);
    StringBuilder url =
        new StringBuilder(PHOTON)
            .append(
                String.format(
                    Locale.ROOT,
                    "/reverse?lat=%.5f&lon=%.5f&radius=%d&limit=%d&lang=en",
                    center.lat(),
                    center.lng(),
                    category.radiusKm(),
                    category.names() == null ? 25 : 50));
    for (String tag : category.tags()) url.append("&osm_tag=").append(encode(tag));
    return http.get(url.toString(), TIMEOUT).thenApply(res -> {
      if (res.status() != 200) throw new IllegalStateException("Nearby search failed (" + res.status() + ")");
      List<Place> places = nearest(fromPhoton(Json.object(Json.parse(res.body())), null, false), category, center);
      nearbyCache.put(key, places);
      return places;
    });
  }

  static List<Place> nearest(List<Place> found, NearbyCategory category, LatLng center) {
    // Name-filtered kinds (temple, mosque…) carry the kind the user asked for, not "Place of worship".
    List<Place> sorted =
        new ArrayList<>(
            found.stream()
                .filter(category::accepts)
                .map(p -> category.names() == null ? p : new Place(p.name(), p.detail(), p.lat(), p.lng(), category.kind(), category.label()))
                .toList());
    sorted.sort(Comparator.comparingDouble(p -> Geo.haversine(center, p.position())));
    List<Place> out = new ArrayList<>();
    for (Place p : sorted) {
      boolean duplicate =
          out.stream().anyMatch(o -> o.name().equalsIgnoreCase(p.name()) && Geo.haversine(o.position(), p.position()) < SAME_PLACE_M);
      if (!duplicate) out.add(p);
      if (out.size() == NEARBY_RESULTS) break;
    }
    return List.copyOf(out);
  }

  @Override
  public CompletableFuture<List<Place>> search(String query, LatLng bias, int zoom) {
    StringBuilder url =
        new StringBuilder(PHOTON).append("/api/?q=").append(encode(query)).append("&limit=").append(PHOTON_LIMIT).append("&lang=en");
    String key = "p|" + query.toLowerCase(Locale.ROOT);
    if (bias != null && bias.isValid()) {
      url.append(String.format(Locale.ROOT, "&lat=%.4f&lon=%.4f", bias.lat(), bias.lng()))
          .append("&zoom=")
          .append((int) Geo.clamp(zoom, 4, 16))
          .append("&location_bias_scale=0.4");
      key += String.format(Locale.ROOT, "|%.1f,%.1f", bias.lat(), bias.lng());
    }
    String cacheKey = key;
    List<Place> cached = searchCache.get(cacheKey);
    if (cached != null) return CompletableFuture.completedFuture(cached);
    return http.get(url.toString(), TIMEOUT).thenApply(res -> {
      if (res.status() != 200) {
        throw new IllegalStateException("Photon search failed (" + res.status() + "): " + snippet(res.body()));
      }
      List<Place> places = dedupe(fromPhoton(Json.object(Json.parse(res.body())), null, true));
      searchCache.put(cacheKey, places);
      return places;
    });
  }

  @Override
  public CompletableFuture<List<Place>> searchFallback(String query) {
    return searchFallback(query, null);
  }

  @Override
  public CompletableFuture<List<Place>> searchFallback(String query, LatLng bias) {
    StringBuilder url =
        new StringBuilder(NOMINATIM)
            .append("/search?format=jsonv2&limit=")
            .append(NOMINATIM_LIMIT)
            .append("&accept-language=en&q=")
            .append(encode(query));
    String key = "n|" + query.toLowerCase(Locale.ROOT);
    if (bias != null && bias.isValid()) {
      // Prefer (but don't limit to) a box of about ±110 km around you.
      url.append(
          String.format(
              Locale.ROOT,
              "&viewbox=%.3f,%.3f,%.3f,%.3f&bounded=0",
              bias.lng() - 1,
              Geo.clamp(bias.lat() + 1, -90, 90),
              bias.lng() + 1,
              Geo.clamp(bias.lat() - 1, -90, 90)));
      key += String.format(Locale.ROOT, "|%.0f,%.0f", bias.lat(), bias.lng());
    }
    String cacheKey = key;
    List<Place> cached = searchCache.get(cacheKey);
    if (cached != null) return CompletableFuture.completedFuture(cached);
    return nominatim(url.toString()).thenApply(res -> {
      if (res.status() != 200) throw new IllegalStateException("Search failed (" + res.status() + ")");
      List<Place> places = new ArrayList<>();
      List<Place> minor = new ArrayList<>();
      Object parsed = Json.parse(res.body());
      if (parsed instanceof List<?> list) {
        for (Object item : list) {
          Map<String, Object> r = Json.object(item);
          Place p = fromNominatim(r, null);
          if (p == null) continue;
          (isMinor(Json.string(r, "category", null), Json.string(r, "type", null)) ? minor : places).add(p);
        }
      }
      if (places.size() < ENOUGH) places.addAll(minor);
      places = dedupe(places);
      searchCache.put(cacheKey, places);
      return places;
    });
  }

  @Override
  public CompletableFuture<Place> reverse(LatLng at) {
    String key = String.format(Locale.ROOT, "%.5f,%.5f", at.lat(), at.lng());
    Place cached = reverseCache.get(key);
    if (cached != null) return CompletableFuture.completedFuture(cached);
    String photon = String.format(Locale.ROOT, "%s/reverse?lat=%.6f&lon=%.6f&lang=en&limit=1", PHOTON, at.lat(), at.lng());
    return http.get(photon, TIMEOUT)
        .handle((res, err) -> {
          if (err != null || res.status() != 200) return null;
          try {
            List<Place> places = fromPhoton(Json.object(Json.parse(res.body())), at, false);
            return places.isEmpty() ? null : places.get(0);
          } catch (RuntimeException e) {
            return null;
          }
        })
        .thenCompose(place -> {
          if (place != null) return CompletableFuture.completedFuture(place);
          String url =
              String.format(
                  Locale.ROOT,
                  "%s/reverse?format=jsonv2&zoom=17&accept-language=en&lat=%.6f&lon=%.6f",
                  NOMINATIM,
                  at.lat(),
                  at.lng());
          return nominatim(url).thenApply(res -> res.status() == 200 ? fromNominatim(Json.object(Json.parse(res.body())), at) : null);
        })
        .thenApply(place -> {
          if (place != null) reverseCache.put(key, place);
          return place;
        });
  }

  /** Spaces Nominatim requests at least 1.1 s apart across the whole server. */
  private CompletableFuture<HttpFetcher.Response> nominatim(String url) {
    long delay;
    synchronized (nominatimLock) {
      long now = clock.getAsLong();
      long start = Math.max(now, nominatimNext);
      nominatimNext = start + NOMINATIM_SPACING_MS;
      delay = start - now;
    }
    if (delay <= 0) return http.get(url, TIMEOUT);
    return CompletableFuture.supplyAsync(() -> null, CompletableFuture.delayedExecutor(delay, TimeUnit.MILLISECONDS))
        .thenCompose(ignored -> http.get(url, TIMEOUT));
  }

  // ------------------------------------------------------------------------ mapping

  /**
   * Service roads, land use, rail switches and the like clutter type-ahead results; they are
   * dropped when enough real places were found.
   */
  static boolean isMinor(String key, String value) {
    String k = key == null ? "" : key;
    String v = value == null ? "" : value;
    return switch (k) {
      case "highway" -> switch (v) {
        case "service", "footway", "path", "track", "steps", "corridor", "cycleway", "bridleway", "proposed", "construction",
            "elevator", "street_lamp", "crossing", "turning_circle", "traffic_signals", "speed_camera" -> true;
        default -> false;
      };
      case "railway" -> switch (v) {
        case "technical_station", "switch", "signal", "crossing", "level_crossing", "buffer_stop", "rail", "abandoned",
            "disused", "platform_edge", "milestone" -> true;
        default -> false;
      };
      case "landuse", "power", "man_made", "barrier", "waterway", "natural" -> true;
      default -> false;
    };
  }

  static List<Place> fromPhoton(Map<String, Object> collection, LatLng at, boolean dropMinor) {
    List<Place> major = new ArrayList<>();
    List<Place> minor = new ArrayList<>();
    for (Object f : Json.list(collection, "features")) {
      Map<String, Object> feature = Json.object(f);
      Map<String, Object> p = Json.object(feature.get("properties"));
      List<?> coords = Json.list(Json.object(feature.get("geometry")), "coordinates");
      if (coords.size() < 2 || !(coords.get(0) instanceof Number lng) || !(coords.get(1) instanceof Number lat)) continue;
      String street = joinNonEmpty(" ", Json.string(p, "housenumber", null), Json.string(p, "street", null));
      String name = firstNonEmpty(
          Json.string(p, "name", null),
          street,
          Json.string(p, "locality", null),
          Json.string(p, "district", null),
          Json.string(p, "city", null),
          Json.string(p, "county", null),
          Json.string(p, "state", null));
      if (name == null) continue;
      List<String> parts = new ArrayList<>();
      if (Json.string(p, "name", null) != null && !street.isEmpty()) parts.add(street);
      for (String k : List.of("locality", "district", "city", "county", "state", "country")) {
        String v = Json.string(p, k, null);
        if (v != null) parts.add(v);
      }
      String detail = String.join(", ", unique(parts, name, 3));
      String key = Json.string(p, "osm_key", null);
      String value = Json.string(p, "osm_value", null);
      String type = Json.string(p, "type", null);
      Place.Kind kind = Place.Kind.classify(key, value, type);
      String category = Json.string(p, "name", null) == null && !street.isEmpty() ? "Address" : Place.label(key, value, type);
      double plat = at != null ? at.lat() : lat.doubleValue();
      double plng = at != null ? at.lng() : lng.doubleValue();
      Place place = new Place(name, detail, plat, plng, kind, category);
      (dropMinor && isMinor(key, value) ? minor : major).add(place);
    }
    if (major.size() < ENOUGH) major.addAll(minor);
    return major;
  }

  static Place fromNominatim(Map<String, Object> r, LatLng at) {
    String display = Json.string(r, "display_name", "");
    List<String> parts = new ArrayList<>();
    for (String s : display.split(",")) {
      String t = s.trim();
      if (!t.isEmpty()) parts.add(t);
    }
    String name = firstNonEmpty(Json.string(r, "name", null), parts.isEmpty() ? null : parts.get(0));
    if (name == null) return null;
    double lat = at != null ? at.lat() : Json.number(r, "lat", Double.NaN);
    double lng = at != null ? at.lng() : Json.number(r, "lon", Double.NaN);
    if (!new LatLng(lat, lng).isValid()) return null;
    String detail = String.join(", ", unique(parts.size() > 1 ? parts.subList(1, parts.size()) : List.of(), name, 3));
    String key = Json.string(r, "category", null);
    String value = Json.string(r, "type", null);
    String type = Json.string(r, "addresstype", null);
    Place.Kind kind = Place.Kind.classify(key, value, type);
    return new Place(name, detail, lat, lng, kind, Place.label(key, value, type));
  }

  private static List<Place> dedupe(List<Place> places) {
    Set<String> seen = new LinkedHashSet<>();
    List<Place> out = new ArrayList<>();
    for (Place p : places) {
      if (seen.add((p.name() + "|" + p.detail()).toLowerCase(Locale.ROOT))) out.add(p);
    }
    return out;
  }

  private static List<String> unique(List<String> values, String exclude, int limit) {
    Set<String> seen = new LinkedHashSet<>();
    seen.add(exclude.toLowerCase(Locale.ROOT));
    List<String> out = new ArrayList<>();
    for (String v : values) {
      if (v == null || v.isBlank()) continue;
      if (seen.add(v.toLowerCase(Locale.ROOT))) out.add(v);
      if (out.size() == limit) break;
    }
    return out;
  }

  private static String firstNonEmpty(String... values) {
    for (String v : values) if (v != null && !v.isBlank()) return v;
    return null;
  }

  private static String joinNonEmpty(String sep, String... values) {
    List<String> parts = new ArrayList<>();
    for (String v : values) if (v != null && !v.isBlank()) parts.add(v);
    return String.join(sep, parts);
  }

  private static String encode(String s) {
    return URLEncoder.encode(s, StandardCharsets.UTF_8);
  }

  /**
   * Photon type-ahead results the phone fetched itself, read exactly like the server's own. Bad
   * input gives an empty list: it only ever shapes the reply to the phone that sent it.
   */
  public static List<Place> parsePhotonSearch(Object json) {
    try {
      return dedupe(fromPhoton(Json.object(json), null, true));
    } catch (RuntimeException e) {
      return List.of();
    }
  }

  /** The start of an error body on one line, for the server log. */
  private static String snippet(String body) {
    if (body == null) return "";
    String s = body.replaceAll("\\s+", " ").trim();
    return s.length() > 160 ? s.substring(0, 160) + "…" : s;
  }
}
