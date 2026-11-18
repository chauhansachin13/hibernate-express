package com.hibernateexpress.parse;

import com.hibernateexpress.geo.LatLng;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Open Location Code — the "plus codes" Google Maps shows for every place (e.g. 7J9WXG4M+X5, or
 * the short form XG4M+X5 Warangal). Decodes full codes and recovers short ones from a nearby
 * reference point, following the reference implementation's rules.
 */
public final class PlusCode {

  private static final String ALPHABET = "23456789CFGHJMPQRVWX";
  private static final char SEPARATOR = '+';
  private static final int SEPARATOR_POSITION = 8;
  private static final char PADDING = '0';
  private static final int PAIR_LENGTH = 10;
  private static final int MAX_DIGITS = 15;
  private static final double[] PAIR_RESOLUTION = {20.0, 1.0, 0.05, 0.0025, 0.000125};
  private static final int GRID_ROWS = 5;
  private static final int GRID_COLUMNS = 4;
  private static final Pattern TOKEN = Pattern.compile("(?<![0-9A-Za-z+])[0-9A-Za-z]{2,8}\\+[0-9A-Za-z]{0,7}(?![0-9A-Za-z+])");

  /** A code found in text, and the place name written next to it (may be empty). */
  public record Found(String code, String locality) {}

  private PlusCode() {}

  /** Finds the first valid plus code in free text such as "XG4M+X5 Warangal, Telangana". */
  public static Found find(String text) {
    if (text == null || text.indexOf(SEPARATOR) < 0) return null;
    Matcher m = TOKEN.matcher(text);
    while (m.find()) {
      String code = m.group().toUpperCase(Locale.ROOT);
      if (!isValid(code)) continue;
      String after = text.substring(m.end()).replaceFirst("^[\\s,;]+", "").trim();
      String before = text.substring(0, m.start()).replaceFirst("[\\s,;]+$", "").trim();
      return new Found(code, after.isEmpty() ? before : after);
    }
    return null;
  }

  public static boolean isValid(String code) {
    if (code == null || code.length() < 2) return false;
    String c = code.toUpperCase(Locale.ROOT);
    int sep = c.indexOf(SEPARATOR);
    if (sep < 0 || sep != c.lastIndexOf(SEPARATOR) || sep > SEPARATOR_POSITION || sep % 2 == 1) return false;
    int pad = c.indexOf(PADDING);
    if (pad >= 0) {
      if (sep < SEPARATOR_POSITION || pad == 0 || pad % 2 == 1) return false;
      for (int i = pad; i < sep; i++) if (c.charAt(i) != PADDING) return false;
      if (c.length() > sep + 1) return false;
    }
    if (c.length() - sep - 1 == 1) return false;
    for (int i = 0; i < c.length(); i++) {
      char ch = c.charAt(i);
      if (ch != SEPARATOR && ch != PADDING && ALPHABET.indexOf(ch) < 0) return false;
    }
    return true;
  }

  public static boolean isFull(String code) {
    if (!isValid(code)) return false;
    String c = code.toUpperCase(Locale.ROOT);
    if (c.indexOf(SEPARATOR) != SEPARATOR_POSITION) return false;
    if (ALPHABET.indexOf(c.charAt(0)) * PAIR_RESOLUTION[0] >= 180) return false;
    return c.charAt(1) == PADDING || ALPHABET.indexOf(c.charAt(1)) * PAIR_RESOLUTION[0] < 360;
  }

  public static boolean isShort(String code) {
    return isValid(code) && code.indexOf(SEPARATOR) < SEPARATOR_POSITION;
  }

  /** Centre of a full code's area. */
  public static LatLng decode(String code) {
    if (!isFull(code)) throw new IllegalArgumentException("Not a full plus code: " + code);
    String digits = code.toUpperCase(Locale.ROOT).replace(String.valueOf(SEPARATOR), "").replace(String.valueOf(PADDING), "");
    if (digits.length() > MAX_DIGITS) digits = digits.substring(0, MAX_DIGITS);
    double lat = -90;
    double lng = -180;
    double latSize = 0;
    double lngSize = 0;
    int pairDigits = Math.min(digits.length(), PAIR_LENGTH);
    for (int i = 0; i < pairDigits; i += 2) {
      double res = PAIR_RESOLUTION[i / 2];
      lat += ALPHABET.indexOf(digits.charAt(i)) * res;
      if (i + 1 < pairDigits) lng += ALPHABET.indexOf(digits.charAt(i + 1)) * res;
      latSize = res;
      lngSize = res;
    }
    if (digits.length() > PAIR_LENGTH) {
      double rowSize = PAIR_RESOLUTION[PAIR_RESOLUTION.length - 1];
      double colSize = rowSize;
      for (int i = PAIR_LENGTH; i < digits.length(); i++) {
        rowSize /= GRID_ROWS;
        colSize /= GRID_COLUMNS;
        int v = ALPHABET.indexOf(digits.charAt(i));
        lat += (v / GRID_COLUMNS) * rowSize;
        lng += (v % GRID_COLUMNS) * colSize;
      }
      latSize = rowSize;
      lngSize = colSize;
    }
    return new LatLng(Math.min(90, lat + latSize / 2), normalizeLng(lng + lngSize / 2));
  }

  /** The 10-digit code (about 14 m square) containing a point. */
  public static String encode(double lat, double lng) {
    double adjLat = Math.max(-90, Math.min(90, lat)) + 90;
    if (adjLat >= 180) adjLat = 180 - PAIR_RESOLUTION[PAIR_RESOLUTION.length - 1] / 2;
    double adjLng = normalizeLng(lng) + 180;
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < PAIR_RESOLUTION.length; i++) {
      double res = PAIR_RESOLUTION[i];
      int latDigit = Math.min(19, (int) Math.floor(adjLat / res + 1e-9));
      int lngDigit = Math.min(19, (int) Math.floor(adjLng / res + 1e-9));
      adjLat = Math.max(0, adjLat - latDigit * res);
      adjLng = Math.max(0, adjLng - lngDigit * res);
      sb.append(ALPHABET.charAt(latDigit)).append(ALPHABET.charAt(lngDigit));
      if (sb.length() == SEPARATOR_POSITION) sb.append(SEPARATOR);
    }
    return sb.toString();
  }

  /** Recovers a short code (e.g. XG4M+X5) to the nearest matching place to {@code reference}. */
  public static LatLng recover(String shortCode, LatLng reference) {
    String c = shortCode.toUpperCase(Locale.ROOT);
    if (isFull(c)) return decode(c);
    if (!isShort(c)) throw new IllegalArgumentException("Not a plus code: " + shortCode);
    double refLat = Math.max(-90, Math.min(90, reference.lat()));
    double refLng = normalizeLng(reference.lng());
    int missing = SEPARATOR_POSITION - c.indexOf(SEPARATOR);
    double resolution = Math.pow(20, 2 - missing / 2);
    double half = resolution / 2;
    LatLng area = decode(encode(refLat, refLng).substring(0, missing) + c);
    double lat = area.lat();
    double lng = area.lng();
    if (refLat + half < lat && lat - resolution >= -90) lat -= resolution;
    else if (refLat - half > lat && lat + resolution <= 90) lat += resolution;
    if (refLng + half < lng) lng -= resolution;
    else if (refLng - half > lng) lng += resolution;
    return new LatLng(lat, normalizeLng(lng));
  }

  private static double normalizeLng(double lng) {
    double v = ((lng + 180) % 360 + 360) % 360 - 180;
    return v == 180 ? -180 : v;
  }
}
