package com.hibernateexpress.external;

import com.hibernateexpress.geo.Geo;
import com.hibernateexpress.geo.LatLng;
import com.hibernateexpress.parse.CoordinateParser;
import com.hibernateexpress.parse.PlusCode;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * One search box for everything, like Google Maps: place names and addresses (Photon, plus
 * Nominatim when you ask for more), "near me" searches ("bus stand", "atm in Ameerpet"),
 * coordinates, plus codes and Google Maps / OpenStreetMap links — short WhatsApp links included.
 */
public final class PlaceSearch {

  /** Results; {@code more} = a thorough search could find more; {@code message} explains an empty list. */
  public record Result(List<Place> places, boolean more, String message) {}

  static final int LIMIT = 15;
  private static final int NEARBY_MAX = 8;
  /** Nearby results that arrive later are cached for the next keystroke rather than waited for. */
  private static final long NEARBY_BUDGET_MS = 5000;
  /** Same name this close = the same place from two sources. */
  private static final double SAME_PLACE_M = 300;

  private static final Pattern URL = Pattern.compile("(?i)\\b(?:https?://|geo:)\\S+");
  private static final Pattern COORDINATES_ONLY = Pattern.compile("^[\\s\\d.,;:°º'\"′″+\\-()NSEWnsew]+$");
  private static final Pattern DIGIT_GROUPS = Pattern.compile("\\d+(?:\\.\\d+)?");
  private static final Pattern PLACE_IN_URL = Pattern.compile("/maps/place/([^/@?]+)|[?&](?:q|query)=([^&]+)", Pattern.CASE_INSENSITIVE);
  private static final Pattern NON_WORD = Pattern.compile("[^\\p{L}\\p{M}\\p{N}]+");

  private final Geocoder geocoder;
  private final NearbyFinder nearby;
  private final LinkResolver links;

  public PlaceSearch(Geocoder geocoder, NearbyFinder nearby, LinkResolver links) {
    this.geocoder = geocoder;
    this.nearby = nearby;
    this.links = links;
  }

  public CompletableFuture<Result> search(String raw, LatLng bias, int zoom, boolean explicit) {
    String q = raw.trim();
    Matcher url = URL.matcher(q);
    if (url.find()) return fromLink(url.group(), bias, zoom);
    if (COORDINATES_ONLY.matcher(q).matches() && countDigitGroups(q) >= 2) {
      if (CoordinateParser.parse(q) instanceof CoordinateParser.Ok ok) return done(List.of(pin(ok.value(), "Coordinates")), null);
    }
    PlusCode.Found code = PlusCode.find(q);
    if (code != null) return fromPlusCode(code, bias, zoom);
    return places(q, bias, zoom, explicit);
  }

  /** Coordinates from text or any map link, expanding short links (for the "paste a link" box). */
  public CompletableFuture<CoordinateParser.Result> coordinates(String text) {
    String t = text == null ? "" : text.trim();
    Matcher url = URL.matcher(t);
    if (url.find() && LinkResolver.isShortLink(url.group())) {
      return links
          .expand(url.group())
          .handle((expanded, err) -> {
            if (err != null || expanded == null) return new CoordinateParser.Err("Couldn't open that link. Check your internet, or copy the coordinates from Google Maps.");
            CoordinateParser.Result parsed = CoordinateParser.parse(expanded);
            return parsed instanceof CoordinateParser.Ok
                ? parsed
                : new CoordinateParser.Err("That link names a place but has no coordinates. Search for the place name instead.");
          });
    }
    return CompletableFuture.completedFuture(CoordinateParser.parse(t));
  }

  // ---------------------------------------------------------------------- places

  private CompletableFuture<Result> places(String q, LatLng bias, int zoom, boolean explicit) {
    CompletableFuture<List<Place>> text = geocoder.search(q, bias, zoom).handle((v, e) -> e == null ? v : null);
    CompletableFuture<List<Place>> thorough =
        explicit ? geocoder.searchFallback(q, bias).handle((v, e) -> e == null ? v : null) : CompletableFuture.completedFuture(List.of());
    CompletableFuture<List<Place>> near = nearby(NearbyCategory.match(q), bias, zoom);
    return CompletableFuture.allOf(text, thorough, near).thenApply(ignored -> {
      List<Place> t = text.join();
      List<Place> m = thorough.join();
      List<Place> n = near.join();
      boolean textFailed = t == null && (!explicit || m == null);
      if (textFailed && n.isEmpty()) throw new IllegalStateException("Search isn't reachable right now");
      List<Place> merged = merge(n, t == null ? List.of() : t, m == null ? List.of() : m, q, bias);
      return new Result(merged, !explicit, null);
    });
  }

  private CompletableFuture<List<Place>> nearby(NearbyCategory.Match match, LatLng bias, int zoom) {
    CompletableFuture<List<Place>> found;
    if (match == null) return CompletableFuture.completedFuture(List.of());
    if (match.near().isEmpty()) {
      if (bias == null) return CompletableFuture.completedFuture(List.of());
      found = nearby.find(match.category(), bias);
    } else {
      // "atm in ameerpet": find Ameerpet first, then ATMs around it.
      found =
          geocoder
              .search(match.near(), bias, zoom)
              .thenCompose(list -> list.isEmpty()
                  ? CompletableFuture.completedFuture(List.<Place>of())
                  : nearby.find(match.category(), list.get(0).position()));
    }
    return found.handle((v, e) -> e == null && v != null ? v : List.<Place>of()).completeOnTimeout(List.of(), NEARBY_BUDGET_MS, TimeUnit.MILLISECONDS);
  }

  /** Nearby matches first (nearest first), then text matches ranked by how well the name matches. */
  static List<Place> merge(List<Place> nearby, List<Place> photon, List<Place> thorough, String query, LatLng bias) {
    List<Place> out = new ArrayList<>();
    for (Place p : nearby) {
      if (out.size() == NEARBY_MAX) break;
      addUnique(out, p);
    }
    record Scored(Place place, double score) {}
    String nq = normalize(query);
    List<String> tokens = tokens(nq);
    List<Scored> scored = new ArrayList<>();
    for (int i = 0; i < photon.size(); i++) scored.add(new Scored(photon.get(i), score(photon.get(i), nq, tokens, bias) - i * 0.04));
    for (int i = 0; i < thorough.size(); i++) {
      scored.add(new Scored(thorough.get(i), score(thorough.get(i), nq, tokens, bias) - i * 0.04 - 0.02));
    }
    scored.sort(Comparator.comparingDouble(Scored::score).reversed());
    for (Scored s : scored) {
      if (out.size() == LIMIT) break;
      addUnique(out, s.place());
    }
    return List.copyOf(out);
  }

  /**
   * How well a place answers the query: the name match (typos forgiven, like "hyderbad"), a nudge
   * for towns and transit stops (what people usually ride to), and distance — near places up,
   * other states and countries down.
   */
  static double score(Place p, String nq, List<String> queryTokens, LatLng bias) {
    String name = normalize(p.name());
    List<String> words = tokens(name);
    double text;
    if (name.equals(nq)) text = 3;
    else if (!nq.contains(" ") && words.size() == 1 && similar(nq, name)) text = 2.6;
    else if (name.startsWith(nq)) text = 2.2;
    else if (allMatched(queryTokens, words)) text = 1.8;
    else if (name.contains(nq)) text = 1.4;
    else if (allMatched(queryTokens, tokens(name + " " + normalize(p.detail() + " " + p.category())))) text = 1;
    else text = 0;
    if (text > 0) {
      if (p.kind() == Place.Kind.CITY) text += 0.4;
      else if (p.kind() == Place.Kind.BUS || p.kind() == Place.Kind.TRAIN) text += 0.3;
    }
    if (bias == null) return text;
    double d = Geo.haversine(bias, p.position());
    double near = 0.6 / (1 + d / 15_000);
    if (d > 1_000_000) near -= 1.5;
    else if (d > 300_000) near -= 0.5;
    return text + near;
  }

  /** Every query word starts a word of the name, or is one typo away from one. */
  private static boolean allMatched(List<String> queryTokens, List<String> words) {
    if (queryTokens.isEmpty()) return false;
    for (int i = 0; i < queryTokens.size(); i++) {
      String t = queryTokens.get(i);
      boolean last = i == queryTokens.size() - 1;
      boolean hit = false;
      for (String w : words) {
        if (w.startsWith(t) || similar(t, w) || (last && t.length() >= 5 && w.length() > t.length() && similar(t, w.substring(0, t.length())))) {
          hit = true;
          break;
        }
      }
      if (!hit) return false;
    }
    return true;
  }

  /** Within one edit for 5–7 letters, two for longer words (shorter words must match exactly). */
  static boolean similar(String a, String b) {
    int max = a.length() >= 8 ? 2 : a.length() >= 5 ? 1 : 0;
    return max > 0 && Math.abs(a.length() - b.length()) <= max && editDistance(a, b, max) <= max;
  }

  /** Levenshtein distance, giving up (returning max + 1) once it exceeds {@code max}. */
  static int editDistance(String a, String b, int max) {
    int[] prev = new int[b.length() + 1];
    int[] cur = new int[b.length() + 1];
    for (int j = 0; j <= b.length(); j++) prev[j] = j;
    for (int i = 1; i <= a.length(); i++) {
      cur[0] = i;
      int rowMin = cur[0];
      for (int j = 1; j <= b.length(); j++) {
        int cost = a.charAt(i - 1) == b.charAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(Math.min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
        rowMin = Math.min(rowMin, cur[j]);
      }
      if (rowMin > max) return max + 1;
      int[] swap = prev;
      prev = cur;
      cur = swap;
    }
    return prev[b.length()];
  }

  private static void addUnique(List<Place> out, Place p) {
    String name = normalize(p.name());
    for (Place o : out) {
      if (normalize(o.name()).equals(name)
          && (Geo.haversine(o.position(), p.position()) < SAME_PLACE_M || o.detail().equalsIgnoreCase(p.detail()))) {
        return;
      }
    }
    out.add(p);
  }

  static String normalize(String text) {
    return NON_WORD.matcher(text.toLowerCase(Locale.ROOT)).replaceAll(" ").trim();
  }

  private static List<String> tokens(String normalized) {
    return normalized.isEmpty() ? List.of() : List.of(normalized.split(" "));
  }

  // ----------------------------------------------------------- links, codes, pins

  private CompletableFuture<Result> fromLink(String link, LatLng bias, int zoom) {
    if (!LinkResolver.isShortLink(link)) return fromFullLink(link, bias, zoom);
    return links
        .expand(link)
        .handle((expanded, err) -> err == null ? expanded : null)
        .thenCompose(expanded -> expanded == null
            ? done(List.of(), "Couldn't open that link. Check your internet, or copy the coordinates from Google Maps.")
            : fromFullLink(expanded, bias, zoom));
  }

  private CompletableFuture<Result> fromFullLink(String link, LatLng bias, int zoom) {
    if (CoordinateParser.parse(link) instanceof CoordinateParser.Ok ok) return done(List.of(pin(ok.value(), "From your link")), null);
    String name = placeNameIn(link);
    if (name != null) return places(name, bias, zoom, false);
    return done(List.of(), "Couldn't find a location in that link.");
  }

  /** "Charminar" from google.com/maps/place/Charminar/… or …?q=Charminar. */
  static String placeNameIn(String link) {
    Matcher m = PLACE_IN_URL.matcher(link);
    if (!m.find()) return null;
    String raw = m.group(1) != null ? m.group(1) : m.group(2);
    String name;
    try {
      name = URLDecoder.decode(raw, StandardCharsets.UTF_8).trim();
    } catch (IllegalArgumentException e) {
      name = raw.replace('+', ' ').trim();
    }
    return name.length() >= 2 ? name : null;
  }

  private CompletableFuture<Result> fromPlusCode(PlusCode.Found found, LatLng bias, int zoom) {
    String label = (found.code() + " " + found.locality()).trim();
    if (PlusCode.isFull(found.code())) return done(List.of(plusCodePlace(label, PlusCode.decode(found.code()))), null);
    CompletableFuture<LatLng> reference =
        found.locality().isEmpty()
            ? CompletableFuture.completedFuture(bias)
            : geocoder
                .search(found.locality(), bias, zoom)
                .handle((list, err) -> err == null && list != null && !list.isEmpty() ? list.get(0).position() : bias);
    return reference.thenApply(ref -> {
      if (ref == null) {
        return new Result(List.of(), false, "Add the town after a short plus code, like XG4M+X5 Warangal.");
      }
      return new Result(List.of(plusCodePlace(label, PlusCode.recover(found.code(), ref))), false, null);
    });
  }

  private static Place plusCodePlace(String label, LatLng p) {
    return new Place(label, String.format(Locale.ROOT, "%.5f, %.5f", p.lat(), p.lng()), p.lat(), p.lng(), Place.Kind.PIN, "Plus code");
  }

  private static Place pin(LatLng p, String category) {
    String coords = String.format(Locale.ROOT, "%.5f, %.5f", p.lat(), p.lng());
    return new Place(coords, "Drop a pin here", p.lat(), p.lng(), Place.Kind.PIN, category);
  }

  private static int countDigitGroups(String q) {
    Matcher m = DIGIT_GROUPS.matcher(q);
    int n = 0;
    while (m.find()) n++;
    return n;
  }

  private static CompletableFuture<Result> done(List<Place> places, String message) {
    return CompletableFuture.completedFuture(new Result(places, false, message));
  }
}
