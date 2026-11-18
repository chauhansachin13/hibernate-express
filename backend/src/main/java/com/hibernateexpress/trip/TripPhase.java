package com.hibernateexpress.trip;

/** Where a trip is in its life cycle. */
public enum TripPhase {
  LOCATING("locating"),
  ROUTING("routing"),
  TRACKING("tracking"),
  ARRIVED("arrived");

  private final String json;

  TripPhase(String json) {
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
