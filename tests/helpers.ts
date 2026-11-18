import type { Fix } from '../src/core/fix-filter';
import { destinationPoint, type LatLng } from '../src/core/geo';

/** Small deterministic PRNG (mulberry32) so simulations are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Moves `p` by 2-D Gaussian noise with per-axis standard deviation `sigma` metres. */
export function gaussianOffset(p: LatLng, sigma: number, random: () => number): LatLng {
  if (sigma <= 0) return p;
  const u = 1 - random();
  const v = random();
  return destinationPoint(p, v * 360, sigma * Math.sqrt(-2 * Math.log(u)));
}

/** Builds a polyline by walking [bearing, metres] legs, with a vertex every `step` metres. */
export function walk(start: LatLng, legs: [number, number][], step = 50): LatLng[] {
  const points = [start];
  let cur = start;
  for (const [brg, dist] of legs) {
    const n = Math.max(1, Math.round(dist / step));
    for (let i = 0; i < n; i++) {
      cur = destinationPoint(cur, brg, dist / n);
      points.push(cur);
    }
  }
  return points;
}

export function fixAt(p: LatLng, timestamp: number, accuracy = 10, speed: number | null = null): Fix {
  return { lat: p.lat, lng: p.lng, accuracy, speed, heading: null, timestamp };
}

export function percentile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx];
}

export const WARANGAL: LatLng = { lat: 17.9837, lng: 79.5307 };
