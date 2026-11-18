package com.hibernateexpress.trip;

/**
 * Tuning of the trip engine.
 *
 * @param gpsLostAfterMs no GPS for this long counts as lost and dead reckoning takes over
 * @param rerouteAfterMs off the road for this long before asking for a new route
 * @param rerouteMinIntervalMs minimum wall-clock gap between routing requests (public servers)
 * @param maxRerouteBackoffMs longest back-off after failed re-routes
 * @param roadRetryMs while stuck on a straight-line fallback, retry the road route this often
 * @param busSpeedFactor buses are slower than the cars routing engines model
 * @param fallbackSpeedMps prior speed when the router gave no duration
 * @param railSpeedMps prior speed for trains
 * @param deadReckoningFactor dead reckoning assumes this much faster than measured, to err early
 * @param arrivalRadiusM arrival radius around the stop
 */
public record EngineOptions(
    TravelMode mode,
    long gpsLostAfterMs,
    long rerouteAfterMs,
    long rerouteMinIntervalMs,
    long maxRerouteBackoffMs,
    long roadRetryMs,
    double busSpeedFactor,
    double fallbackSpeedMps,
    double railSpeedMps,
    double deadReckoningFactor,
    double arrivalRadiusM) {

  public static EngineOptions defaults() {
    return new EngineOptions(
        TravelMode.ROAD, 60_000, 12_000, 30_000, 5 * 60_000, 2 * 60_000, 0.85, 25 / 3.6, 55 / 3.6, 1.15, 150);
  }

  /** Defaults for a travel mode: trains get a wider arrival radius (long platforms). */
  public static EngineOptions forMode(TravelMode mode) {
    EngineOptions d = defaults();
    return new EngineOptions(
        mode,
        d.gpsLostAfterMs,
        d.rerouteAfterMs,
        d.rerouteMinIntervalMs,
        d.maxRerouteBackoffMs,
        d.roadRetryMs,
        d.busSpeedFactor,
        d.fallbackSpeedMps,
        d.railSpeedMps,
        d.deadReckoningFactor,
        mode == TravelMode.RAIL ? 400 : 150);
  }
}
