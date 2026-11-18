package com.hibernateexpress.trip;

/**
 * Decides when to ring: once when the rider gets close (distance or time, whichever comes
 * first), again when a snooze ends, and again on arrival in case the rider dozed off after the
 * first alarm.
 */
public final class AlarmPolicy {

  /** Within this distance of the stop the rider has arrived. */
  private final double arrivalRadiusM;
  /**
   * Being near the pin only counts as arrival when the road distance left is also short;
   * otherwise a route that passes the stop earlier (and comes back later) would end the trip.
   */
  private final double directArrivalMaxRemainingM;

  private final long snoozeMs;
  private final AlarmSettings settings;

  private boolean approachFired;
  private boolean arrivalFired;
  private long snoozeUntil = -1;
  private AlarmReason ringing;

  /**
   * @param remaining best estimate of road metres left (dead-reckoned while GPS is lost)
   * @param etaSec conservative seconds-to-arrival, NaN when unknown (stopped)
   * @param gpsLost no GPS fix for a while: remaining is an estimate
   * @param directDistance straight-line metres to the destination pin (infinite when unknown)
   */
  public record Input(long now, double remaining, double etaSec, boolean gpsLost, double directDistance) {}

  public AlarmPolicy(AlarmSettings settings, double arrivalRadiusM) {
    this(settings, arrivalRadiusM, 1500, 2 * 60_000);
  }

  public AlarmPolicy(
      AlarmSettings settings, double arrivalRadiusM, double directArrivalMaxRemainingM, long snoozeMs) {
    this.settings = settings;
    this.arrivalRadiusM = arrivalRadiusM;
    this.directArrivalMaxRemainingM = directArrivalMaxRemainingM;
    this.snoozeMs = snoozeMs;
  }

  public AlarmReason ringing() {
    return ringing;
  }

  public boolean arrived() {
    return arrivalFired;
  }

  public boolean approachFired() {
    return approachFired;
  }

  /** Epoch millis when the snooze ends, or -1. */
  public long snoozedUntil() {
    return snoozeUntil;
  }

  /** Returns the reason when a ring starts (or changes reason) on this evaluation, else null. */
  public AlarmReason evaluate(Input in) {
    boolean nearPin =
        in.directDistance() <= arrivalRadiusM
            && in.remaining() <= Math.max(directArrivalMaxRemainingM, arrivalRadiusM);
    boolean arrived = !in.gpsLost() && (in.remaining() <= arrivalRadiusM || nearPin);

    if (arrived && !arrivalFired) {
      arrivalFired = true;
      approachFired = true;
      snoozeUntil = -1;
      return ring(AlarmReason.ARRIVAL);
    }

    if (!approachFired) {
      boolean byDistance = in.remaining() <= settings.distanceM();
      boolean byTime =
          settings.timeRuleEnabled() && !Double.isNaN(in.etaSec()) && in.etaSec() <= settings.timeSec();
      if (byDistance || byTime) {
        approachFired = true;
        return ring(in.gpsLost() ? AlarmReason.GPS_LOST : byDistance ? AlarmReason.DISTANCE : AlarmReason.TIME);
      }
    }

    if (snoozeUntil >= 0 && in.now() >= snoozeUntil) {
      snoozeUntil = -1;
      return ring(AlarmReason.SNOOZE);
    }
    return null;
  }

  /** "I'm awake": stop ringing. Arrival can still ring later. */
  public void acknowledge() {
    ringing = null;
    snoozeUntil = -1;
  }

  /** Silence now, ring again after the snooze period. */
  public void snooze(long now) {
    ringing = null;
    snoozeUntil = now + snoozeMs;
  }

  /**
   * Records alarms the phone already rang on its own (for example while it had no connection),
   * so the server does not ring the same alarm a second time.
   */
  public void markFired(boolean approach, boolean arrival) {
    if (approach || arrival) approachFired = true;
    if (arrival) arrivalFired = true;
  }

  private AlarmReason ring(AlarmReason reason) {
    if (ringing == reason) return null;
    ringing = reason;
    return reason;
  }
}
