import { clamp } from './geo';

export interface PaceOptions {
  /** History used for the smoothed speed (includes signals and bus stops). */
  windowMs: number;
  /** Short history used to react quickly when the bus speeds up. */
  shortWindowMs: number;
  /** After this much observed history the routing engine's prior is ignored. */
  fullConfidenceMs: number;
  /** Minimum history before observed speed is trusted at all. */
  minSpanMs: number;
  /** Below this speed the vehicle counts as stopped and ETA is unknown. */
  stoppedBelowMps: number;
}

export const DEFAULT_PACE_OPTIONS: PaceOptions = {
  windowMs: 8 * 60_000,
  shortWindowMs: 2 * 60_000,
  fullConfidenceMs: 5 * 60_000,
  minSpanMs: 20_000,
  stoppedBelowMps: 0.7,
};

interface Sample {
  t: number;
  remaining: number;
}

/**
 * Estimates how fast the remaining distance is shrinking.
 *
 * Instantaneous GPS speed is useless for ETAs on Indian roads (signals, bus
 * stops, traffic), so we measure progress over a sliding window and blend it
 * with the routing engine's expected speed until enough history exists.
 */
export class PaceEstimator {
  private readonly opts: PaceOptions;
  private readonly prior: number;
  private samples: Sample[] = [];

  constructor(priorSpeedMps: number, options: Partial<PaceOptions> = {}) {
    this.opts = { ...DEFAULT_PACE_OPTIONS, ...options };
    this.prior = clamp(Number.isFinite(priorSpeedMps) ? priorSpeedMps : 9, 2, 35);
  }

  add(t: number, remaining: number): void {
    const last = this.samples[this.samples.length - 1];
    if (last && t <= last.t) {
      if (t === last.t) last.remaining = remaining;
      return;
    }
    this.samples.push({ t, remaining });
    const cutoff = t - this.opts.windowMs;
    while (this.samples.length > 2 && this.samples[1].t <= cutoff) this.samples.shift();
  }

  /** Keeps history continuous when a re-route changes the remaining distance. */
  rebase(delta: number): void {
    for (const s of this.samples) s.remaining += delta;
  }

  /** Observed progress speed over the last `windowMs`, or null if too little history. */
  observed(windowMs = this.opts.windowMs): { speed: number; spanMs: number } | null {
    const last = this.samples[this.samples.length - 1];
    if (!last) return null;
    const first = this.samples.find((s) => s.t >= last.t - windowMs);
    if (!first || first === last) return null;
    const spanMs = last.t - first.t;
    if (spanMs < this.opts.minSpanMs) return null;
    return { speed: Math.max(0, (first.remaining - last.remaining) / (spanMs / 1000)), spanMs };
  }

  /** Smoothed speed (m/s) used for the displayed ETA. */
  speed(): number {
    const obs = this.observed();
    if (!obs) return this.prior;
    const w = Math.min(1, obs.spanMs / this.opts.fullConfidenceMs);
    return w * obs.speed + (1 - w) * this.prior;
  }

  /**
   * Speed used for alarm decisions. It never trails the smoothed speed and
   * reacts within ~2 minutes when the bus speeds up, so the alarm errs early.
   */
  alarmSpeed(): number {
    const smooth = this.speed();
    const short = this.observed(this.opts.shortWindowMs);
    return short ? Math.max(smooth, short.speed) : smooth;
  }

  /** Seconds to cover `remaining` metres, or null while stopped. */
  eta(remaining: number, speed = this.speed()): number | null {
    if (speed < this.opts.stoppedBelowMps) return null;
    return Math.max(0, remaining) / speed;
  }
}
