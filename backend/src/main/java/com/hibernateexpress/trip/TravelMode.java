package com.hibernateexpress.trip;

/** Road vehicles follow the real road route; trains use the straight-line distance. */
public enum TravelMode {
  ROAD("road"),
  RAIL("rail");

  private final String json;

  TravelMode(String json) {
    this.json = json;
  }

  public String json() {
    return json;
  }

  public static TravelMode fromJson(String value) {
    return "rail".equalsIgnoreCase(value) ? RAIL : ROAD;
  }

  @Override
  public String toString() {
    return json;
  }
}
