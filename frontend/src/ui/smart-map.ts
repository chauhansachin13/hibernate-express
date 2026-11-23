import type { Fix } from '../core/fix';
import type { LatLng } from '../core/geo';
import type { RoutePath } from '../core/route-path';
import { googleConfigured, loadGoogle, type Google } from '../services/google';
import { GoogleMapView } from './google-map-view';
import { MapView, type MapStyle } from './map-view';

/** What the app needs from a map, whichever one draws it. */
export interface MapEngine {
  onFollowChange: ((following: boolean) => void) | null;
  readonly style: MapStyle;
  setStyle(style: MapStyle): void;
  onTap(handler: (p: LatLng) => void): void;
  bias(): { lat: number; lng: number; zoom: number };
  setDestination(p: LatLng | null): void;
  setUser(fix: Pick<Fix, 'lat' | 'lng' | 'accuracy' | 'heading' | 'speed'> | null, glideMs?: number): void;
  setAlarmPreview(path: RoutePath | null, distanceM: number, label: string): void;
  setAlarmNear(near: boolean): void;
  setPreviewRoute(points: LatLng[] | null): void;
  setTripRoute(route: RoutePath | null, along: number, alarmAlong: number | null): void;
  fit(points: LatLng[], maxZoom?: number): void;
  focus(p: LatLng, zoom?: number): void;
  ensureVisible(p: LatLng): void;
  track(p: LatLng, stop: LatLng): void;
  setFollowing(following: boolean): void;
  invalidate(): void;
}

const NO_GOOGLE = 'hx.noGoogle';

/**
 * Google's map when a Google key is configured and works, OpenStreetMap otherwise. Calls made
 * while Google loads are replayed on whichever map takes over. If Google later refuses the key,
 * the app reloads once on OpenStreetMap rather than show Google's error box.
 */
export class SmartMap implements MapEngine {
  onFollowChange: ((following: boolean) => void) | null = null;

  private impl: MapEngine | null = null;
  private queue: ((m: MapEngine) => void)[] = [];
  private styleName: MapStyle;
  private readonly ready: Promise<Google | null>;

  constructor(container: HTMLElement, style: MapStyle, bottomInset: () => number) {
    this.styleName = style;
    let skip = false;
    try {
      skip = sessionStorage.getItem(NO_GOOGLE) === '1';
    } catch {
      skip = false;
    }
    if (googleConfigured() && !skip) {
      window.addEventListener('hx-google-failed', () => {
        try {
          sessionStorage.setItem(NO_GOOGLE, '1');
        } catch {
          // private mode: it will try Google again next time
        }
        location.reload();
      });
      this.ready = loadGoogle()
        .then((g) => {
          this.use(new GoogleMapView(g, container, this.styleName, bottomInset));
          return g;
        })
        .catch(() => {
          this.use(new MapView(container, this.styleName, bottomInset));
          return null;
        });
    } else {
      this.use(new MapView(container, style, bottomInset));
      this.ready = Promise.resolve(null);
    }
  }

  /** Google's API once its map is up, or null when the OpenStreetMap map is used. */
  google(): Promise<Google | null> {
    return this.ready;
  }

  private use(engine: MapEngine): void {
    this.impl = engine;
    engine.onFollowChange = (following) => this.onFollowChange?.(following);
    for (const call of this.queue) call(engine);
    this.queue = [];
  }

  private run(call: (m: MapEngine) => void): void {
    if (this.impl) call(this.impl);
    else this.queue.push(call);
  }

  get style(): MapStyle {
    return this.styleName;
  }

  setStyle(style: MapStyle): void {
    this.styleName = style;
    this.run((m) => m.setStyle(style));
  }

  onTap(handler: (p: LatLng) => void): void {
    this.run((m) => m.onTap(handler));
  }

  bias(): { lat: number; lng: number; zoom: number } {
    return this.impl ? this.impl.bias() : { lat: 22.6, lng: 79.2, zoom: 5 };
  }

  setDestination(p: LatLng | null): void {
    this.run((m) => m.setDestination(p));
  }

  setUser(fix: Pick<Fix, 'lat' | 'lng' | 'accuracy' | 'heading' | 'speed'> | null, glideMs = 0): void {
    this.run((m) => m.setUser(fix, glideMs));
  }

  setAlarmPreview(path: RoutePath | null, distanceM: number, label: string): void {
    this.run((m) => m.setAlarmPreview(path, distanceM, label));
  }

  setAlarmNear(near: boolean): void {
    this.run((m) => m.setAlarmNear(near));
  }

  setPreviewRoute(points: LatLng[] | null): void {
    this.run((m) => m.setPreviewRoute(points));
  }

  setTripRoute(route: RoutePath | null, along: number, alarmAlong: number | null): void {
    this.run((m) => m.setTripRoute(route, along, alarmAlong));
  }

  fit(points: LatLng[], maxZoom = 16): void {
    this.run((m) => m.fit(points, maxZoom));
  }

  focus(p: LatLng, zoom = 15): void {
    this.run((m) => m.focus(p, zoom));
  }

  ensureVisible(p: LatLng): void {
    this.run((m) => m.ensureVisible(p));
  }

  track(p: LatLng, stop: LatLng): void {
    this.run((m) => m.track(p, stop));
  }

  setFollowing(following: boolean): void {
    this.run((m) => m.setFollowing(following));
  }

  invalidate(): void {
    this.run((m) => m.invalidate());
  }
}
