export type AlarmReason = 'distance' | 'time' | 'gps-lost' | 'arrival' | 'snooze';

export interface AlarmSettings {
  /** Ring when this many road metres are left. */
  distanceM: number;
  /** Also ring when the estimated time left drops to this many seconds (null = off). */
  timeSec: number | null;
}

export interface AlarmPolicyOptions {
  /** Within this distance of the stop we consider the rider arrived. */
  arrivalRadiusM: number;
  /**
   * Being near the pin only counts as arrival when the road distance left is
   * also short; otherwise a route that passes the stop earlier (and comes back
   * later) would end the trip too soon.
   */
  directArrivalMaxRemainingM: number;
  /** How long "Snooze" silences the alarm. */
  snoozeMs: number;
}

export const DEFAULT_ALARM_OPTIONS: AlarmPolicyOptions = {
  arrivalRadiusM: 150,
  directArrivalMaxRemainingM: 1500,
  snoozeMs: 2 * 60_000,
};

export interface AlarmInput {
  now: number;
  /** Best estimate of road metres left (dead-reckoned while GPS is lost). */
  remaining: number;
  /** Conservative seconds-to-arrival, or null when unknown (stopped). */
  etaSec: number | null;
  /** No GPS fix for a while: `remaining` is an estimate. */
  gpsLost: boolean;
  /** Straight-line metres to the destination pin (Infinity when unknown). */
  directDistance: number;
}

export interface AlarmPolicyState {
  approachFired: boolean;
  arrivalFired: boolean;
  snoozeUntil: number | null;
  ringing: AlarmReason | null;
}

/**
 * Decides when to ring. Rings once when the rider gets close (distance or
 * time, whichever comes first), again when snooze ends, and again on arrival
 * in case the rider dozed off after the first alarm.
 */
export class AlarmPolicy {
  readonly settings: AlarmSettings;
  private readonly opts: AlarmPolicyOptions;
  private state: AlarmPolicyState = {
    approachFired: false,
    arrivalFired: false,
    snoozeUntil: null,
    ringing: null,
  };

  constructor(settings: AlarmSettings, options: Partial<AlarmPolicyOptions> = {}) {
    this.settings = settings;
    this.opts = { ...DEFAULT_ALARM_OPTIONS, ...options };
  }

  get ringing(): AlarmReason | null {
    return this.state.ringing;
  }

  get arrived(): boolean {
    return this.state.arrivalFired;
  }

  get approachFired(): boolean {
    return this.state.approachFired;
  }

  get snoozedUntil(): number | null {
    return this.state.snoozeUntil;
  }

  /** Returns the reason when a ring starts (or changes reason) on this evaluation. */
  evaluate(input: AlarmInput): AlarmReason | null {
    const s = this.state;
    const nearPin =
      input.directDistance <= this.opts.arrivalRadiusM &&
      input.remaining <= Math.max(this.opts.directArrivalMaxRemainingM, this.opts.arrivalRadiusM);
    const arrived = !input.gpsLost && (input.remaining <= this.opts.arrivalRadiusM || nearPin);

    if (arrived && !s.arrivalFired) {
      s.arrivalFired = true;
      s.approachFired = true;
      s.snoozeUntil = null;
      return this.ring('arrival');
    }

    if (!s.approachFired) {
      const byDistance = input.remaining <= this.settings.distanceM;
      const byTime =
        this.settings.timeSec !== null && input.etaSec !== null && input.etaSec <= this.settings.timeSec;
      if (byDistance || byTime) {
        s.approachFired = true;
        return this.ring(input.gpsLost ? 'gps-lost' : byDistance ? 'distance' : 'time');
      }
    }

    if (s.snoozeUntil !== null && input.now >= s.snoozeUntil) {
      s.snoozeUntil = null;
      return this.ring('snooze');
    }
    return null;
  }

  /** "I'm awake": stop ringing. Arrival can still ring later. */
  acknowledge(): void {
    this.state.ringing = null;
    this.state.snoozeUntil = null;
  }

  /** Silence now, ring again after the snooze period. */
  snooze(now: number): void {
    this.state.ringing = null;
    this.state.snoozeUntil = now + this.opts.snoozeMs;
  }

  exportState(): AlarmPolicyState {
    return { ...this.state };
  }

  restoreState(state: Partial<AlarmPolicyState>): void {
    this.state = {
      approachFired: !!state.approachFired,
      arrivalFired: !!state.arrivalFired,
      snoozeUntil: typeof state.snoozeUntil === 'number' ? state.snoozeUntil : null,
      // A restored session never resumes mid-ring; the user restarts it by hand.
      ringing: null,
    };
  }

  private ring(reason: AlarmReason): AlarmReason | null {
    if (this.state.ringing === reason) return null;
    this.state.ringing = reason;
    return reason;
  }
}
