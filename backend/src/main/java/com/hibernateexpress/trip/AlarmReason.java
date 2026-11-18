package com.hibernateexpress.trip;

/** Why the alarm is ringing. */
public enum AlarmReason {
  DISTANCE("distance"),
  TIME("time"),
  GPS_LOST("gps-lost"),
  ARRIVAL("arrival"),
  SNOOZE("snooze");

  private final String json;

  AlarmReason(String json) {
    this.json = json;
  }

  public String json() {
    return json;
  }

  @Override
  public String toString() {
    return json;
  }
}
