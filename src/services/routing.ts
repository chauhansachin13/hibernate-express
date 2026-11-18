import type { LatLng } from '../core/geo';
import type { RouteData } from '../core/trip-engine';

/**
 * Public OSRM servers (OpenStreetMap road data). The second one is run by
 * FOSSGIS for openstreetmap.org and is used when the first is busy.
 */
const ENDPOINTS = [
  { name: 'OSRM', base: 'https://router.project-osrm.org/route/v1/driving/' },
  { name: 'OSRM (openstreetmap.de)', base: 'https://routing.openstreetmap.de/routed-car/route/v1/driving/' },
];

export class RoutingError extends Error {
  readonly noRoute: boolean;

  constructor(message: string, noRoute = false) {
    super(message);
    this.name = 'RoutingError';
    this.noRoute = noRoute;
  }
}

interface OsrmResponse {
  code?: string;
  message?: string;
  routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] } }[];
}

async function fetchWithTimeout(url: string, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forward = () => controller.abort();
  signal?.addEventListener('abort', forward, { once: true });
  try {
    return await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}

/** Fetches the real road route (full geometry) between two points. */
export async function fetchRoadRoute(from: LatLng, to: LatLng, signal?: AbortSignal): Promise<RouteData> {
  const coords = `${from.lng.toFixed(6)},${from.lat.toFixed(6)};${to.lng.toFixed(6)},${to.lat.toFixed(6)}`;
  const query = '?overview=full&geometries=geojson&alternatives=false&steps=false';
  let lastError: unknown = new RoutingError('Routing service unavailable');

  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetchWithTimeout(endpoint.base + coords + query, 15_000, signal);
      const data = (await res.json().catch(() => null)) as OsrmResponse | null;
      if (data?.code === 'NoRoute' || data?.code === 'NoSegment') {
        throw new RoutingError('No road route found to this place', true);
      }
      const route = data?.routes?.[0];
      if (!res.ok || data?.code !== 'Ok' || !route || route.geometry.coordinates.length < 2) {
        lastError = new RoutingError(data?.message ?? `${endpoint.name} responded ${res.status}`);
        continue;
      }
      return {
        points: route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
        distance: route.distance,
        duration: route.duration,
        kind: 'road',
        provider: endpoint.name,
      };
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof RoutingError && err.noRoute) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new RoutingError('Routing service unavailable');
}
