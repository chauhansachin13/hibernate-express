import { clamp, type LatLng } from '../core/geo';

export type PlaceKind = 'bus' | 'train' | 'airport' | 'education' | 'city' | 'street' | 'poi' | 'pin';

export interface Place {
  name: string;
  detail: string;
  lat: number;
  lng: number;
  kind: PlaceKind;
}

export interface SearchBias {
  lat: number;
  lng: number;
  zoom: number;
}

const PHOTON = 'https://photon.komoot.io';
const NOMINATIM = 'https://nominatim.openstreetmap.org';

type Props = Record<string, string | undefined>;
interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Props;
}

function kindOf(key?: string, value?: string, type?: string): PlaceKind {
  if (value === 'bus_station' || value === 'bus_stop' || (key === 'highway' && value === 'bus_stop')) return 'bus';
  if (key === 'railway' || value === 'station' || value === 'halt' || value === 'train_station') return 'train';
  if (value === 'aerodrome' || value === 'airport' || value === 'terminal') return 'airport';
  if (value === 'university' || value === 'college' || value === 'school') return 'education';
  if (key === 'place' || ['city', 'district', 'locality', 'county', 'state', 'town', 'village'].includes(type ?? '')) {
    return 'city';
  }
  if (type === 'street' || key === 'highway') return 'street';
  return 'poi';
}

function unique(values: (string | undefined)[], exclude: string): string[] {
  const seen = new Set([exclude.toLowerCase()]);
  const out: string[] = [];
  for (const v of values) {
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function fromPhoton(f: PhotonFeature, at?: LatLng): Place | null {
  const p = f.properties;
  const [lng, lat] = f.geometry.coordinates;
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const name = p.name || street || p.locality || p.district || p.city || p.county || p.state;
  if (!name) return null;
  const detail = unique(
    [p.name && street ? street : undefined, p.locality, p.district, p.city, p.county, p.state, p.country],
    name,
  )
    .slice(0, 3)
    .join(', ');
  return { name, detail, lat: at?.lat ?? lat, lng: at?.lng ?? lng, kind: kindOf(p.osm_key, p.osm_value, p.type) };
}

function dedupe(places: Place[]): Place[] {
  const seen = new Set<string>();
  return places.filter((p) => {
    const key = `${p.name}|${p.detail}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Type-ahead search (Photon allows search-as-you-type, Nominatim does not). */
export async function searchPlaces(query: string, bias: SearchBias | null, signal?: AbortSignal): Promise<Place[]> {
  const params = new URLSearchParams({ q: query, limit: '8', lang: 'en' });
  if (bias) {
    params.set('lat', bias.lat.toFixed(4));
    params.set('lon', bias.lng.toFixed(4));
    params.set('zoom', String(clamp(Math.round(bias.zoom), 4, 16)));
    params.set('location_bias_scale', '0.4');
  }
  const res = await fetch(`${PHOTON}/api/?${params}`, { signal });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const data = (await res.json()) as { features?: PhotonFeature[] };
  return dedupe((data.features ?? []).map((f) => fromPhoton(f)).filter((p): p is Place => p !== null));
}

interface NominatimResult {
  lat: string;
  lon: string;
  name?: string;
  display_name?: string;
  category?: string;
  type?: string;
  addresstype?: string;
}

function fromNominatim(r: NominatimResult, at?: LatLng): Place | null {
  const parts = (r.display_name ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const name = r.name || parts[0];
  if (!name) return null;
  return {
    name,
    detail: unique(parts.slice(1), name).slice(0, 3).join(', '),
    lat: at?.lat ?? parseFloat(r.lat),
    lng: at?.lng ?? parseFloat(r.lon),
    kind: kindOf(r.category, r.type, r.addresstype),
  };
}

/** One-shot search used only when the user presses Enter and Photon failed. */
export async function searchPlacesFallback(query: string, signal?: AbortSignal): Promise<Place[]> {
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '8', 'accept-language': 'en' });
  const res = await fetch(`${NOMINATIM}/search?${params}`, { signal });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const data = (await res.json()) as NominatimResult[];
  return dedupe(data.map((r) => fromNominatim(r)).filter((p): p is Place => p !== null));
}

/** Names a dropped pin. The pin keeps its exact coordinates. */
export async function reverseGeocode(at: LatLng, signal?: AbortSignal): Promise<Place | null> {
  try {
    const params = new URLSearchParams({ lat: at.lat.toFixed(6), lon: at.lng.toFixed(6), lang: 'en', limit: '1' });
    const res = await fetch(`${PHOTON}/reverse?${params}`, { signal });
    if (res.ok) {
      const data = (await res.json()) as { features?: PhotonFeature[] };
      const feature = data.features?.[0];
      const place = feature ? fromPhoton(feature, at) : null;
      if (place) return place;
    }
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  const params = new URLSearchParams({
    lat: at.lat.toFixed(6),
    lon: at.lng.toFixed(6),
    format: 'jsonv2',
    zoom: '17',
    'accept-language': 'en',
  });
  const res = await fetch(`${NOMINATIM}/reverse?${params}`, { signal });
  if (!res.ok) return null;
  return fromNominatim((await res.json()) as NominatimResult, at);
}
