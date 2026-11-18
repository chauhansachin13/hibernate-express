package com.hibernateexpress.trip;

import com.hibernateexpress.geo.Geo;

/** Rejects stale, wildly inaccurate and physically impossible GPS fixes. */
public final class FixFilter {

  public enum Verdict {
    OK,
    STALE,
    INACCURATE,
    JUMP
  }

  /** Fixes worse than this are skipped while better ones are recent. */
  private static final double MAX_ACCURACY_M = 200;
  /** How long we wait for a good fix before accepting poor ones. */
  private static final long POOR_FIX_GRACE_MS = 45_000;
  /** Faster implied movement than this (beyond the error radii) is a GPS jump. */
  private static final double MAX_SPEED_MPS = 60;
  /** After this many rejected jumps in a row the new position is trusted. */
  private static final int MAX_CONSECUTIVE_JUMPS = 3;

  private Fix last;
  private int jumps;

  public Verdict check(Fix fix) {
    if (last != null) {
      if (fix.timestamp() <= last.timestamp()) return Verdict.STALE;
      long dtMs = fix.timestamp() - last.timestamp();
      if (fix.accuracy() > MAX_ACCURACY_M && dtMs < POOR_FIX_GRACE_MS) return Verdict.INACCURATE;
      double slack = Math.min(fix.accuracy(), 500) + Math.min(last.accuracy(), 500);
      double implied = Math.max(0, Geo.haversine(last.position(), fix.position()) - slack) / (dtMs / 1000.0);
      if (implied > MAX_SPEED_MPS && jumps < MAX_CONSECUTIVE_JUMPS) {
        jumps++;
        return Verdict.JUMP;
      }
    }
    jumps = 0;
    last = fix;
    return Verdict.OK;
  }
}
