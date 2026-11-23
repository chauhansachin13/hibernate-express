import type { Place } from '../api';
import type { LatLng } from '../core/geo';

/* eslint-disable @typescript-eslint/no-explicit-any -- the Google Maps JS API is loaded at runtime */

/**
 * Google Maps Platform, when a key is configured (VITE_GOOGLE_MAPS_KEY, restricted to this site):
 * Google's map and Google's place search, so every place Google Maps knows can be found. Without a
 * key, or if Google can't be reached, the app keeps its OpenStreetMap map and search.
 */
const KEY = ((import.meta.env.VITE_GOOGLE_MAPS_KEY as string | undefined) ?? '').trim();
/** A vector Map ID (needed for Google's markers); Google's demo ID works until you make your own. */
export const GOOGLE_MAP_ID = ((import.meta.env.VITE_GOOGLE_MAP_ID as string | undefined) ?? '').trim() || 'DEMO_MAP_ID';

export const googleConfigured = (): boolean => KEY.length > 0;

declare global {
  interface Window {
    __hxGoogleReady?: () => void;
    gm_authFailure?: () => void;
  }
}

export type Google = any;
let loading: Promise<Google> | null = null;

/** Loads the Maps JavaScript API once; rejects if it fails or Google refuses the key. */
export function loadGoogle(): Promise<Google> {
  if (!KEY) return Promise.reject(new Error('No Google Maps key configured'));
  loading ??= new Promise<Google>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Google Maps took too long to load')), 15_000);
    window.__hxGoogleReady = () => {
      window.clearTimeout(timer);
      resolve((window as any).google);
    };
    // Google calls this when the key is wrong, restricted elsewhere, or billing is off.
    window.gm_authFailure = () => {
      window.clearTimeout(timer);
      reject(new Error('Google refused the Maps key'));
      window.dispatchEvent(new Event('hx-google-failed'));
    };
    const script = document.createElement('script');
    const params = new URLSearchParams({
      key: KEY,
      v: 'weekly',
      loading: 'async',
      libraries: 'places,marker',
      language: 'en',
      region: 'IN',
      callback: '__hxGoogleReady',
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;
    script.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error("Couldn't load Google Maps"));
    };
    document.head.append(script);
  });
  return loading;
}

// ------------------------------------------------------------------ places

export interface PlaceSuggestion {
  id: string;
  name: string;
  detail: string;
  kind: Place['kind'];
  category: string;
  distanceM: number | null;
}

/** Google's place search, as the search box needs it. */
export interface PlacesProvider {
  suggest(q: string, bias: { lat: number; lng: number; zoom: number } | null, user: LatLng | null): Promise<PlaceSuggestion[]>;
  resolve(id: string): Promise<Place>;
}

const KINDS: [Place['kind'], string[]][] = [
  ['bus', ['bus_station', 'bus_stop', 'transit_station', 'transit_depot']],
  ['train', ['train_station', 'subway_station', 'light_rail_station']],
  ['airport', ['airport', 'international_airport']],
  ['education', ['school', 'university', 'primary_school', 'secondary_school', 'preschool']],
  ['hospital', ['hospital', 'doctor', 'pharmacy', 'medical_lab', 'dental_clinic']],
  ['worship', ['hindu_temple', 'church', 'mosque', 'place_of_worship', 'synagogue']],
  ['food', ['restaurant', 'cafe', 'bakery', 'meal_takeaway', 'food']],
  ['shop', ['store', 'shopping_mall', 'supermarket', 'grocery_store', 'market', 'clothing_store']],
  ['fuel', ['gas_station']],
  ['park', ['park', 'national_park']],
  ['hotel', ['lodging', 'hotel']],
  ['city', ['locality', 'sublocality', 'sublocality_level_1', 'neighborhood', 'administrative_area_level_1',
    'administrative_area_level_2', 'administrative_area_level_3', 'postal_code', 'colloquial_area']],
  ['street', ['route', 'street_address', 'premise', 'subpremise', 'intersection']],
];

const GENERIC = new Set(['point_of_interest', 'establishment', 'political', 'geocode']);

function kindOf(types: string[]): Place['kind'] {
  for (const [kind, names] of KINDS) if (types.some((t) => names.includes(t))) return kind;
  return 'poi';
}

function categoryOf(types: string[]): string {
  const t = types.find((x) => !GENERIC.has(x));
  if (!t) return '';
  const words = t.replace(/_level_\d/, '').replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Autocomplete (New) with session tokens: Google bills a typed search plus the place you pick as
 * one session, which keeps a small app inside Google's free monthly allowance.
 */
export function googlePlaces(g: Google): PlacesProvider {
  let token: any = null;
  const predictions = new Map<string, any>();
  return {
    async suggest(q, bias, user) {
      const { AutocompleteSuggestion, AutocompleteSessionToken } = await g.maps.importLibrary('places');
      token ??= new AutocompleteSessionToken();
      const request: Record<string, unknown> = { input: q, sessionToken: token, language: 'en', region: 'in' };
      if (bias) request.locationBias = { center: { lat: bias.lat, lng: bias.lng }, radius: 50_000 };
      if (user) request.origin = { lat: user.lat, lng: user.lng };
      const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions(request);
      predictions.clear();
      const out: PlaceSuggestion[] = [];
      for (const s of suggestions ?? []) {
        const p = s.placePrediction;
        if (!p) continue;
        predictions.set(p.placeId, p);
        const types: string[] = p.types ?? [];
        out.push({
          id: p.placeId,
          name: p.mainText?.text ?? p.text?.text ?? '',
          detail: p.secondaryText?.text ?? '',
          kind: kindOf(types),
          category: categoryOf(types),
          distanceM: typeof p.distanceMeters === 'number' ? p.distanceMeters : null,
        });
      }
      return out;
    },
    async resolve(id) {
      const prediction = predictions.get(id);
      const { Place: GPlace } = await g.maps.importLibrary('places');
      const place = prediction ? prediction.toPlace() : new GPlace({ id });
      await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location', 'types'] });
      token = null; // the session ends with the pick
      const types: string[] = place.types ?? [];
      return {
        name: place.displayName ?? '',
        detail: place.formattedAddress ?? '',
        lat: place.location.lat(),
        lng: place.location.lng(),
        kind: kindOf(types),
        category: categoryOf(types),
      } as Place;
    },
  };
}
