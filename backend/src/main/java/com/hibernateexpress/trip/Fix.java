package com.hibernateexpress.trip;

import com.hibernateexpress.geo.LatLng;

/**
 * One GPS reading.
 *
 * @param accuracy 68% confidence radius in metres
 * @param speed ground speed in m/s, NaN when the device did not report it
 * @param heading course over ground in degrees, NaN when unknown
 * @param timestamp milliseconds on the device (or simulated) clock
 */
public record Fix(double lat, double lng, double accuracy, double speed, double heading, long timestamp) {

  public LatLng position() {
    return new LatLng(lat, lng);
  }

  public boolean hasSpeed() {
    return Double.isFinite(speed) && speed >= 0;
  }

  public boolean hasHeading() {
    return Double.isFinite(heading);
  }

  public static Fix at(LatLng p, double accuracy, double speed, long timestamp) {
    return new Fix(p.lat(), p.lng(), accuracy, speed, Double.NaN, timestamp);
  }
}
