import type { LatLng } from './geo';

/** Splits a distance into a display value and unit: 850 m, 2.4 km, 143 km. */
export function splitDistance(metres: number): { value: string; unit: string } {
  if (!Number.isFinite(metres)) return { value: '—', unit: '' };
  const m = Math.max(0, metres);
  if (m < 995) return { value: String(Math.round(m / 10) * 10), unit: 'm' };
  const km = m / 1000;
  if (km < 99.95) return { value: km.toFixed(1), unit: 'km' };
  return { value: String(Math.round(km)), unit: 'km' };
}

export function formatDistance(metres: number): string {
  const { value, unit } = splitDistance(metres);
  return unit ? `${value} ${unit}` : value;
}

/** 45 s → "< 1 min", 1700 s → "28 min", 8000 s → "2 h 13 min". */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return '< 1 min';
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')} min`;
}

export function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatSpeed(mps: number | null): string {
  if (mps === null || !Number.isFinite(mps)) return '—';
  return `${Math.round(Math.max(0, mps) * 3.6)} km/h`;
}

export function formatAgo(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 3) return 'just now';
  if (s < 60) return `${s} s ago`;
  const min = Math.round(s / 60);
  return min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ago`;
}

export function formatCoord(p: LatLng): string {
  return `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
}
