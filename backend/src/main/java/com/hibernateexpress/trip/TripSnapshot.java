package com.hibernateexpress.trip;

import com.hibernateexpress.geo.LatLng;

/**
 * Everything the phone needs to draw the ride screen. Absent numbers are NaN, absent times -1.
 *
 * @param route the route currently used for tracking (null before routing)
 * @param routeVersion increases every time the route changes (re-routes)
 * @param along metres travelled along the current route
 * @param remaining best estimate of metres left
 * @param remainingIsEstimate remaining is approximate (off-route, straight line, dead reckoning)
 * @param initialRemaining remaining distance when tracking started (for the progress bar)
 * @param progress 0..1
 * @param alarmProgress 0..1 position on the progress bar where the distance alarm rings
 * @param etaSec seconds to arrival, NaN while stopped or unknown
 * @param speedMps smoothed ground speed for display
 * @param paceMps speed of the remaining distance used for alarm decisions and dead reckoning
 * @param lastFixAgeMs milliseconds since the last tracked fix, -1 before any
 * @param snoozedUntil engine time when the snooze ends, -1 when not snoozed
 * @param now the engine clock (simulated during demo rides)
 */
public record TripSnapshot(
    TripPhase phase,
    TravelMode mode,
    LatLng destination,
    RouteData route,
    int routeVersion,
    Fix fix,
    LatLng snapped,
    double along,
    double remaining,
    boolean remainingIsEstimate,
    double initialRemaining,
    double progress,
    double alarmProgress,
    double etaSec,
    double speedMps,
    double paceMps,
    boolean onRoute,
    boolean rerouting,
    boolean gpsLost,
    long lastFixAgeMs,
    AlarmReason ringing,
    long snoozedUntil,
    boolean approachFired,
    String routeError,
    int reroutes,
    long now) {}
