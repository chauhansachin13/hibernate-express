/**
 * The phone's safety net. The Java backend is the source of truth for the trip, but buses cross
 * dead zones and bus stands have bad signal: when the server can't be reached the phone works out
 * the distance left itself (see TripClient) and this decides whether an alarm is due.
 */
export interface GuardInput {
  /** Best known metres left: road distance, or a straight-line lower bound. */
  remaining: number;
  /** Trip-clock milliseconds since that was known (0 for a fresh GPS fix). */
  ageMs: number;
  /** Measured pace of the trip (m/s), if known. */
  paceMps: number | null;
  /** Straight-line metres to the stop from a fresh GPS fix, or null without GPS. */
  directNow: number | null;
  distanceM: number;
  /** Time rule in seconds, or null when off. */
  timeSec: number | null;
  arrivalRadiusM: number;
}

export interface GuardResult {
  remaining: number;
  etaSec: number | null;
  /** The "you're nearly there" alarm should ring. */
  approach: boolean;
  /** Which rule asked for it (distance wins a tie). */
  rule: 'distance' | 'time' | null;
  arrived: boolean;
}

/** Counting forward without GPS runs this much faster than the measured pace: early, never late. */
export const EARLY_FACTOR = 1.15;

export function offlineEstimate(i: GuardInput): GuardResult {
  const pace = i.paceMps !== null && i.paceMps > 0.5 ? i.paceMps : null;
  const remaining = Math.max(0, pace !== null ? i.remaining - pace * EARLY_FACTOR * (i.ageMs / 1000) : i.remaining);
  const etaSec = pace !== null ? remaining / pace : null;
  const byDistance = remaining <= i.distanceM;
  const byTime = i.timeSec !== null && etaSec !== null && etaSec <= i.timeSec;
  const arrived = i.directNow !== null && i.directNow <= i.arrivalRadiusM;
  return { remaining, etaSec, approach: byDistance || byTime, rule: byDistance ? 'distance' : byTime ? 'time' : null, arrived };
}
