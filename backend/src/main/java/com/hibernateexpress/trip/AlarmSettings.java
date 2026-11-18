package com.hibernateexpress.trip;

/**
 * When to wake the rider.
 *
 * @param distanceM ring when this many road metres are left
 * @param timeSec also ring when the estimated time left drops to this many seconds; NaN = off
 */
public record AlarmSettings(double distanceM, double timeSec) {

  public boolean timeRuleEnabled() {
    return Double.isFinite(timeSec) && timeSec > 0;
  }

  public static AlarmSettings of(double distanceM, int timeMinutes) {
    return new AlarmSettings(distanceM, timeMinutes > 0 ? timeMinutes * 60.0 : Double.NaN);
  }
}
