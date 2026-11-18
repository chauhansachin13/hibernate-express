package com.hibernateexpress.parse;

import com.hibernateexpress.geo.LatLng;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reads a destination from whatever people paste: decimal pairs, degrees-minutes-seconds,
 * hemisphere letters, Google Maps / OpenStreetMap links and geo: URIs.
 */
public final class CoordinateParser {

  /** Either a position or a human-readable error. */
  public sealed interface Result permits Ok, Err {}

  public record Ok(LatLng value) implements Result {}

  public record Err(String error) implements Result {}

  private static final String NUM = "[-+]?\\d+(?:\\.\\d+)?";
  private static final String EXAMPLE = "Try something like 17.9833, 79.5308";

  private static final Pattern GOOGLE_PIN = Pattern.compile("!3d(" + NUM + ")!4d(" + NUM + ")");
  private static final Pattern QUERY_PARAM =
      Pattern.compile(
          "[?&](?:q|query|ll|destination|daddr|center|sll)=(?:loc:)?\\s*(" + NUM + ")\\s*,\\s*(" + NUM + ")",
          Pattern.CASE_INSENSITIVE);
  private static final Pattern AT_CENTRE = Pattern.compile("@(" + NUM + "),(" + NUM + ")");
  /** Dropped-pin links: google.com/maps/search/17.98,+79.53 or /maps/place/17.98,79.53. */
  private static final Pattern MAPS_PATH =
      Pattern.compile("/maps/(?:search|place)/(" + NUM + ")\\s*,\\s*\\+?\\s*(" + NUM + ")", Pattern.CASE_INSENSITIVE);
  private static final Pattern OSM_HASH = Pattern.compile("#map=\\d+(?:\\.\\d+)?/(" + NUM + ")/(" + NUM + ")");
  private static final Pattern OSM_MARKER = Pattern.compile("mlat=(" + NUM + ").*?mlon=(" + NUM + ")");
  private static final Pattern GEO_URI = Pattern.compile("^geo:(" + NUM + "),(" + NUM + ")", Pattern.CASE_INSENSITIVE);
  private static final Pattern SHORT_LINK = Pattern.compile("(maps\\.app\\.goo\\.gl|goo\\.gl/maps)", Pattern.CASE_INSENSITIVE);
  private static final Pattern NUMBER = Pattern.compile(NUM);
  private static final Pattern UNSIGNED = Pattern.compile("\\d+(?:\\.\\d+)?");
  private static final Pattern LETTER = Pattern.compile("[NSEW]");
  private static final Pattern NEGATIVE = Pattern.compile("(^|[^\\d.])-\\s*\\d");

  private CoordinateParser() {}

  public static Result parse(String raw) {
    String input = raw == null ? "" : raw.trim();
    if (input.isEmpty()) return fail("Enter coordinates. " + EXAMPLE);
    if (SHORT_LINK.matcher(input).find()) {
      return fail(
          "Short Google Maps links can't be opened here. Open the link, long-press the pin and copy the coordinates instead.");
    }
    String text = input;
    try {
      text = URLDecoder.decode(input, StandardCharsets.UTF_8);
    } catch (IllegalArgumentException e) {
      // Not URI-encoded; use as is.
    }

    for (Pattern p : List.of(GOOGLE_PIN, QUERY_PARAM, MAPS_PATH, AT_CENTRE, OSM_HASH, OSM_MARKER, GEO_URI)) {
      Matcher m = p.matcher(text);
      if (m.find()) return build(Double.parseDouble(m.group(1)), Double.parseDouble(m.group(2)));
    }
    if (text.regionMatches(true, 0, "http", 0, 4)) return fail("Couldn't find coordinates in that link.");
    return parseText(text);
  }

  private record Component(double value, Character axis) {}

  private static Result parseText(String text) {
    String s =
        text.toUpperCase(Locale.ROOT)
            .replaceAll("[’′‘`´]", "'")
            .replaceAll("[”″“]", "\"")
            .replace("''", "\"")
            .replaceAll("[º˚]", "°")
            .replaceAll("\\s+", " ")
            .trim();
    if (!s.matches(".*\\d.*")) return fail("Couldn't find any numbers. " + EXAMPLE);

    List<Integer> letters = new ArrayList<>();
    Matcher lm = LETTER.matcher(s);
    while (lm.find()) letters.add(lm.start());

    String[] parts = null;
    if (letters.size() == 2) {
      int first = letters.get(0);
      int second = letters.get(1);
      // "17.98N 79.53E" has letters after the numbers, "N 17.98 E 79.53" before.
      boolean trailing = s.substring(0, first).matches(".*\\d.*");
      int cut = trailing ? first + 1 : second;
      parts = new String[] {s.substring(0, cut), s.substring(cut)};
    } else if (letters.isEmpty()) {
      if (s.contains(",")) parts = s.split(",", -1);
      else if (s.contains(";")) parts = s.split(";", -1);
      else {
        List<String> numbers = new ArrayList<>();
        Matcher nm = NUMBER.matcher(s);
        while (nm.find()) numbers.add(nm.group());
        if (numbers.size() == 2) parts = numbers.toArray(String[]::new);
      }
    } else {
      return fail("Use one N/S letter and one E/W letter, e.g. 17.98 N, 79.53 E.");
    }

    if (parts == null || parts.length != 2) return fail("Couldn't read that. " + EXAMPLE);
    Component a = component(parts[0]);
    Component b = component(parts[1]);
    if (a == null || b == null) return fail("Couldn't read that. " + EXAMPLE);
    if (a.axis() != null && a.axis().equals(b.axis())) {
      return fail("Both values point the same way. Use one N/S and one E/W.");
    }
    boolean swap = (a.axis() != null && a.axis() == 'E') || (b.axis() != null && b.axis() == 'N');
    return swap ? build(b.value(), a.value()) : build(a.value(), b.value());
  }

  private static Component component(String part) {
    Matcher lm = LETTER.matcher(part);
    Character letter = lm.find() ? part.charAt(lm.start()) : null;
    List<String> numbers = new ArrayList<>();
    Matcher nm = UNSIGNED.matcher(part);
    while (nm.find()) numbers.add(nm.group());
    if (numbers.isEmpty() || numbers.size() > 3) return null;
    double degrees = Double.parseDouble(numbers.get(0));
    double minutes = numbers.size() > 1 ? Double.parseDouble(numbers.get(1)) : 0;
    double seconds = numbers.size() > 2 ? Double.parseDouble(numbers.get(2)) : 0;
    if (minutes >= 60 || seconds >= 60) return null;
    if (numbers.size() > 1 && degrees != Math.floor(degrees)) return null;
    double value = degrees + minutes / 60 + seconds / 3600;
    if (NEGATIVE.matcher(part).find()) value = -value;
    if (letter != null && (letter == 'S' || letter == 'W')) value = -Math.abs(value);
    Character axis = null;
    if (letter != null) axis = letter == 'N' || letter == 'S' ? 'N' : 'E';
    return new Component(value, axis);
  }

  private static Result build(double lat, double lng) {
    if (!Double.isFinite(lat) || !Double.isFinite(lng)) return fail("Couldn't read those numbers. " + EXAMPLE);
    if (Math.abs(lat) > 90) return fail("Latitude must be between -90 and 90.");
    if (Math.abs(lng) > 180) return fail("Longitude must be between -180 and 180.");
    return new Ok(new LatLng(lat, lng));
  }

  private static Result fail(String error) {
    return new Err(error);
  }
}
