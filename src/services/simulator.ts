import type { Fix } from '../core/fix-filter';
import { destinationPoint, type LatLng } from '../core/geo';
import type { RouteLine } from '../core/route-line';

export interface SimulationOptions {
  /** Cruise speed of the simulated bus. */
  speedKmh: number;
  /** Real seconds the whole ride should take. */
  realDurationSec: number;
  /** Real milliseconds between simulated GPS fixes. */
  tickMs: number;
  /** GPS noise (1-sigma, metres). */
  noiseM: number;
}

function jitter(p: LatLng, sigma: number): LatLng {
  const u = 1 - Math.random();
  return destinationPoint(p, Math.random() * 360, sigma * Math.sqrt(-2 * Math.log(u)));
}

/**
 * Drives a virtual bus along a route on a fast-forwarded clock, emitting noisy
 * GPS fixes. The trip engine runs on the simulator's clock, so ETAs, alarms
 * and "time before arrival" all behave exactly as on a real ride.
 */
export class RideSimulator {
  readonly timeScale: number;
  private readonly route: RouteLine;
  private readonly opts: SimulationOptions;
  private simTime = Date.now();
  private along = 0;
  private timer: number | null = null;

  constructor(route: RouteLine, options: Partial<SimulationOptions> = {}) {
    this.route = route;
    this.opts = { speedKmh: 42, realDurationSec: 40, tickMs: 500, noiseM: 6, ...options };
    const travelSec = route.length / (this.opts.speedKmh / 3.6);
    this.timeScale = Math.max(1, travelSec / this.opts.realDurationSec);
  }

  readonly now = (): number => this.simTime;

  start(onFix: (fix: Fix) => void): void {
    this.stop();
    const emit = () => {
      const p = jitter(this.route.pointAt(this.along), this.opts.noiseM);
      onFix({
        lat: p.lat,
        lng: p.lng,
        accuracy: Math.round(this.opts.noiseM * 1.6 + Math.random() * 4),
        speed: this.speed(),
        heading: null,
        timestamp: this.simTime,
      });
    };
    emit();
    this.timer = window.setInterval(() => {
      const dt = (this.opts.tickMs * this.timeScale) / 1000;
      this.simTime += dt * 1000;
      this.along = Math.min(this.route.length, this.along + this.speed() * dt);
      emit();
    }, this.opts.tickMs);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  /** Cruise with gentle variation, slowing down over the last kilometre. */
  private speed(): number {
    const remaining = this.route.length - this.along;
    if (remaining <= 0) return 0;
    const cruise = this.opts.speedKmh / 3.6;
    const wobble = 1 + 0.12 * Math.sin(this.simTime / 47_000);
    const approach = Math.min(1, 0.35 + remaining / 1500);
    return cruise * wobble * approach;
  }
}
