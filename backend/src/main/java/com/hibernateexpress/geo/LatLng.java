package com.hibernateexpress.geo;

import java.util.Locale;

/** A WGS-84 position in degrees. */
public record LatLng(double lat, double lng) {

  public boolean isValid() {
    return Double.isFinite(lat) && Double.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  }

  @Override
  public String toString() {
    return String.format(Locale.ROOT, "%.6f,%.6f", lat, lng);
  }
}
