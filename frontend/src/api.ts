import type { LatLng } from './core/geo';

/** Client for the Hibernate Express Java backend. */

export type PlaceKind =
  | 'bus'
  | 'train'
  | 'airport'
  | 'education'
  | 'hospital'
  | 'worship'
  | 'food'
  | 'shop'
  | 'fuel'
  | 'park'
  | 'hotel'
  | 'city'
  | 'street'
  | 'poi'
  | 'pin';
export type TravelMode = 'road' | 'rail';
export type AlarmReason = 'distance' | 'time' | 'gps-lost' | 'arrival' | 'snooze';
export type TripPhase = 'locating' | 'routing' | 'tracking' | 'arrived';

export interface Place {
  name: string;
  detail: string;
  lat: number;
  lng: number;
  kind: PlaceKind;
  /** Short label such as "Bus station" or "Village". */
  category?: string;
}

export interface SearchResult {
  places: Place[];
  /** A thorough search (Enter, or "Search more places") could find more. */
  more: boolean;
  /** Why the list is empty, when there's something useful to say. */
  message?: string;
}

export interface TripSettings {
  mode: TravelMode;
  distanceM: number;
  timeMin: number;
}

export interface RoutePreview {
  kind: 'road' | 'direct';
  provider: string;
  distance: number | null;
  duration: number | null;
  length: number;
  polyline: string;
}

export interface FixJson {
  lat: number;
  lng: number;
  accuracy: number;
  speed: number | null;
  heading: number | null;
}

export interface Snapshot {
  phase: TripPhase;
  mode: TravelMode;
  remaining: number | null;
  remainingIsEstimate: boolean;
  initialRemaining: number | null;
  progress: number;
  alarmProgress: number | null;
  etaSec: number | null;
  speedMps: number | null;
  paceMps: number | null;
  onRoute: boolean;
  rerouting: boolean;
  gpsLost: boolean;
  lastFixAgeMs: number | null;
  ringing: AlarmReason | null;
  snoozeLeftMs: number | null;
  approachFired: boolean;
  along: number | null;
  snapped: LatLng | null;
  fix: FixJson | null;
  routeError: string | null;
  reroutes: number;
  routeVersion: number;
  routeKind: 'road' | 'direct' | null;
  routeProvider: string | null;
  route?: { version: number; polyline: string; length: number; kind: 'road' | 'direct' };
  demo: boolean;
  timeScale: number;
  now: number;
  serverTime: number;
}

export interface TripCreated {
  tripId: string;
  demo: boolean;
  destination: Place;
  settings: TripSettings;
  snapshot: Snapshot;
}

export interface FixPost {
  sentAt: number;
  fixes: { lat: number; lng: number; accuracy: number; speed: number | null; heading: number | null; timestamp: number }[];
  approachFired?: boolean;
  arrivalFired?: boolean;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Same origin by default (the Java server also serves this app); override with VITE_API_BASE. */
const BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/$/, '');

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  const forward = () => controller.abort();
  opts.signal?.addEventListener('abort', forward, { once: true });
  try {
    const res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, json.error ?? `Request failed (${res.status})`);
    return json as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (opts.signal?.aborted) throw err;
    throw new ApiError(0, "Can't reach the Hibernate Express server");
  } finally {
    window.clearTimeout(timer);
    opts.signal?.removeEventListener('abort', forward);
  }
}

const p6 = (v: number) => v.toFixed(6);

export const api = {
  search(q: string, bias: { lat: number; lng: number; zoom: number } | null, explicit: boolean, signal?: AbortSignal) {
    const params = new URLSearchParams({ q });
    if (bias) {
      params.set('lat', bias.lat.toFixed(4));
      params.set('lng', bias.lng.toFixed(4));
      params.set('zoom', String(Math.round(bias.zoom)));
    }
    if (explicit) params.set('explicit', '1');
    return request<SearchResult>('GET', `/search?${params}`, undefined, { signal, timeoutMs: explicit ? 30_000 : 20_000 });
  },

  reverse(at: LatLng, signal?: AbortSignal) {
    return request<{ place: Place | null }>('GET', `/reverse?lat=${p6(at.lat)}&lng=${p6(at.lng)}`, undefined, { signal }).then(
      (r) => r.place,
    );
  },

  route(from: LatLng, to: LatLng, signal?: AbortSignal) {
    const q = `from=${p6(from.lat)},${p6(from.lng)}&to=${p6(to.lat)},${p6(to.lng)}`;
    return request<{ route: RoutePreview }>('GET', `/route?${q}`, undefined, { signal, timeoutMs: 40_000 }).then((r) => r.route);
  },

  coordinates(text: string) {
    return request<{ ok: boolean; lat?: number; lng?: number; error?: string }>('POST', '/coordinates', { text });
  },

  createTrip(body: { destination: Place; settings: TripSettings; demo: boolean; origin?: LatLng | null }) {
    // Demo rides wait for the road route; live trips answer at once (a short wait, then the phone tracks alone).
    return request<TripCreated>('POST', '/trips', body, { timeoutMs: body.demo ? 45_000 : 15_000 });
  },

  trip(id: string, routeVersion: number) {
    return request<Snapshot>('GET', `/trips/${encodeURIComponent(id)}?routeVersion=${routeVersion}`, undefined, { timeoutMs: 10_000 });
  },

  postFixes(id: string, body: FixPost, routeVersion: number) {
    return request<Snapshot>('POST', `/trips/${encodeURIComponent(id)}/fixes?routeVersion=${routeVersion}`, body, { timeoutMs: 10_000 });
  },

  ack(id: string, routeVersion: number) {
    return request<Snapshot>('POST', `/trips/${encodeURIComponent(id)}/ack?routeVersion=${routeVersion}`);
  },

  snooze(id: string, routeVersion: number) {
    return request<Snapshot>('POST', `/trips/${encodeURIComponent(id)}/snooze?routeVersion=${routeVersion}`);
  },

  endTrip(id: string) {
    return request<{ ok: boolean }>('DELETE', `/trips/${encodeURIComponent(id)}`);
  },
};
