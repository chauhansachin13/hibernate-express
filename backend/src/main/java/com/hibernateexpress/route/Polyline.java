package com.hibernateexpress.route;

import com.hibernateexpress.geo.LatLng;
import java.util.ArrayList;
import java.util.List;

/**
 * Google's encoded polyline format (precision 1e-5, about 1 m). A 140 km road route shrinks
 * from ~60 KB of JSON coordinates to ~8 KB, which matters on a bus's mobile data.
 */
public final class Polyline {

  private Polyline() {}

  public static String encode(List<LatLng> points) {
    StringBuilder sb = new StringBuilder(points.size() * 6);
    long prevLat = 0;
    long prevLng = 0;
    for (LatLng p : points) {
      long lat = Math.round(p.lat() * 1e5);
      long lng = Math.round(p.lng() * 1e5);
      encodeValue(sb, lat - prevLat);
      encodeValue(sb, lng - prevLng);
      prevLat = lat;
      prevLng = lng;
    }
    return sb.toString();
  }

  public static List<LatLng> decode(String encoded) {
    List<LatLng> out = new ArrayList<>();
    int index = 0;
    long lat = 0;
    long lng = 0;
    while (index < encoded.length()) {
      long[] r = decodeValue(encoded, index);
      lat += r[0];
      index = (int) r[1];
      r = decodeValue(encoded, index);
      lng += r[0];
      index = (int) r[1];
      out.add(new LatLng(lat / 1e5, lng / 1e5));
    }
    return out;
  }

  private static void encodeValue(StringBuilder sb, long value) {
    long v = value < 0 ? ~(value << 1) : value << 1;
    while (v >= 0x20) {
      sb.append((char) ((0x20 | (v & 0x1f)) + 63));
      v >>= 5;
    }
    sb.append((char) (v + 63));
  }

  private static long[] decodeValue(String s, int index) {
    long result = 0;
    int shift = 0;
    int b;
    do {
      b = s.charAt(index++) - 63;
      result |= (long) (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    long value = (result & 1) != 0 ? ~(result >> 1) : result >> 1;
    return new long[] {value, index};
  }
}
