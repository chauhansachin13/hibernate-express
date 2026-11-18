import { haversine } from './geo';

/** One GPS reading. `timestamp` is milliseconds (wall or simulated clock). */
export interface Fix {
  lat: number;
  lng: number;
  /** 68% confidence radius in metres. */
  accuracy: number;
  /** Ground speed in m/s if the device reported it. */
  speed: number | null;
  /** Course over ground in degrees if the device reported it. */
  heading: number | null;
  timestamp: number;
}

export type FixVerdict = 'ok' | 'stale' | 'inaccurate' | 'jump';

export interface FixFilterOptions {
  /** Fixes worse than this are skipped while better ones are recent. */
  maxAccuracyM: number;
  /** How long we wait for a good fix before accepting poor ones. */
  poorFixGraceMs: number;
  /** Faster implied movement than this (beyond the error radii) is a GPS jump. */
  maxSpeedMps: number;
  /** After this many rejected jumps in a row we trust the new position. */
  maxConsecutiveJumps: number;
}

export const DEFAULT_FIX_FILTER_OPTIONS: FixFilterOptions = {
  maxAccuracyM: 200,
  poorFixGraceMs: 45_000,
  maxSpeedMps: 60,
  maxConsecutiveJumps: 3,
};

/** Rejects stale, wildly inaccurate and physically impossible GPS fixes. */
export class FixFilter {
  private readonly opts: FixFilterOptions;
  private last: Fix | null = null;
  private jumps = 0;

  constructor(options: Partial<FixFilterOptions> = {}) {
    this.opts = { ...DEFAULT_FIX_FILTER_OPTIONS, ...options };
  }

  check(fix: Fix): FixVerdict {
    const last = this.last;
    if (last) {
      if (fix.timestamp <= last.timestamp) return 'stale';
      const dtMs = fix.timestamp - last.timestamp;
      if (fix.accuracy > this.opts.maxAccuracyM && dtMs < this.opts.poorFixGraceMs) return 'inaccurate';
      const slack = Math.min(fix.accuracy, 500) + Math.min(last.accuracy, 500);
      const implied = Math.max(0, haversine(last, fix) - slack) / (dtMs / 1000);
      if (implied > this.opts.maxSpeedMps && this.jumps < this.opts.maxConsecutiveJumps) {
        this.jumps++;
        return 'jump';
      }
    }
    this.jumps = 0;
    this.last = fix;
    return 'ok';
  }
}
