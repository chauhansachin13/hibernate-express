package com.hibernateexpress.api;

import com.hibernateexpress.json.Json;
import com.hibernateexpress.trip.AlarmSettings;
import com.hibernateexpress.trip.TravelMode;
import java.util.LinkedHashMap;
import java.util.Map;

/** The rider's alarm choices: travel mode, distance before the stop, minutes before arrival. */
public record TripSettings(TravelMode mode, double distanceM, int timeMin) {

  public static TripSettings fromJson(Map<String, Object> json) {
    TravelMode mode = TravelMode.fromJson(Json.string(json, "mode", "road"));
    double distance = Json.number(json, "distanceM", 2000);
    double minutes = Json.number(json, "timeMin", 10);
    if (!Double.isFinite(distance) || distance < 100 || distance > 50_000) {
      throw ApiError.badRequest("Alarm distance must be between 100 m and 50 km");
    }
    if (!Double.isFinite(minutes) || minutes < 0 || minutes > 180) {
      throw ApiError.badRequest("Alarm time must be between 0 and 180 minutes");
    }
    return new TripSettings(mode, distance, (int) Math.round(minutes));
  }

  public AlarmSettings alarm() {
    return AlarmSettings.of(distanceM, timeMin);
  }

  public Map<String, Object> toJson() {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("mode", mode.json());
    m.put("distanceM", distanceM);
    m.put("timeMin", timeMin);
    return m;
  }
}
