import L from 'leaflet';
import type { Fix } from '../core/fix';
import type { LatLng } from '../core/geo';
import type { RoutePath } from '../core/route-path';

export type MapStyle = 'dark' | 'light';

const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
/** OpenStreetMap's own tiles (no API key); the dark style is a CSS filter on the tile layer. */
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const wrapLng = (lng: number) => ((((lng + 180) % 360) + 360) % 360) - 180;
const tuple = (p: LatLng): L.LatLngTuple => [p.lat, p.lng];

const destIcon = () =>
  L.divIcon({
    className: 'hx-dest',
    html:
      '<span class="hx-dest-ring"></span><span class="hx-dest-shadow"></span>' +
      '<svg class="hx-dest-pin" viewBox="0 0 36 48" width="36" height="48" aria-hidden="true">' +
      '<path d="M18 1C8.6 1 1 8.4 1 17.6 1 30.4 18 47 18 47s17-16.6 17-29.4C35 8.4 27.4 1 18 1z" fill="#2dd4bf" stroke="#042f2e" stroke-width="2"/>' +
      '<circle cx="18" cy="17.5" r="6.5" fill="#042f2e"/></svg>',
    iconSize: [36, 48],
    iconAnchor: [18, 46],
  });

const userIcon = L.divIcon({
  className: 'hx-user',
  html:
    '<span class="hx-user-ping"></span>' +
    '<svg class="hx-user-arrow" viewBox="0 0 48 48" aria-hidden="true"><path d="M24 2 31 15 24 12 17 15Z"/></svg>' +
    '<span class="hx-user-dot"></span>',
  iconSize: [26, 26],
  iconAnchor: [13, 13],
});

/** Full-screen Leaflet map that keeps out from under the bottom sheet. */
export class MapView {
  readonly map: L.Map;
  onFollowChange: ((following: boolean) => void) | null = null;

  private styleName: MapStyle;
  private dest: L.Marker | null = null;
  private user: L.Marker | null = null;
  private accuracy: L.Circle | null = null;
  private preview: L.Polyline | null = null;
  private routeLayers: L.Layer[] = [];
  private ahead: L.Polyline | null = null;
  private glow: L.Polyline | null = null;
  private done: L.Polyline | null = null;
  private drawnRoute: RoutePath | null = null;
  private drawnAlong = -Infinity;
  private tripAlarm: L.Marker | null = null;
  private alarmPreview: L.Marker | null = null;
  private alarmPreviewPath: RoutePath | null = null;
  private alarmPreviewAlong = 0;
  private previewAnim = 0;
  private userAnim = 0;
  private following = true;
  private autoUntil = 0;
  private readonly bottomInset: () => number;

  constructor(container: HTMLElement, style: MapStyle, bottomInset: () => number) {
    this.bottomInset = bottomInset;
    this.map = L.map(container, {
      zoomControl: false,
      attributionControl: true,
      center: [22.6, 79.2],
      zoom: 5,
      minZoom: 3,
      worldCopyJump: true,
    });
    this.map.attributionControl.setPrefix(false);
    // Bottom-left, riding just above the sheet (the buttons sit on the right).
    this.map.attributionControl.setPosition('bottomleft');
    L.tileLayer(TILE_URL, { maxZoom: 19, crossOrigin: true, attribution: ATTRIBUTION }).addTo(this.map);
    this.styleName = style;
    this.markStyle();
    this.map.on('dragstart', () => this.setFollowing(false));
    this.map.on('zoomstart', () => {
      if (Date.now() > this.autoUntil) this.setFollowing(false);
    });
  }

  get style(): MapStyle {
    return this.styleName;
  }

  setStyle(style: MapStyle): void {
    this.styleName = style;
    this.markStyle();
  }

  onTap(handler: (p: LatLng) => void): void {
    this.map.on('click', (e: L.LeafletMouseEvent) => handler({ lat: e.latlng.lat, lng: wrapLng(e.latlng.lng) }));
  }

  bias(): { lat: number; lng: number; zoom: number } {
    const c = this.map.getCenter();
    return { lat: c.lat, lng: wrapLng(c.lng), zoom: this.map.getZoom() };
  }

  setDestination(p: LatLng | null): void {
    this.dest?.remove();
    this.dest = null;
    if (!p) return;
    // A fresh marker each time so the drop animation replays.
    this.dest = L.marker(tuple(p), { icon: destIcon(), keyboard: false, interactive: false, zIndexOffset: 1000 }).addTo(this.map);
  }

  /** Moves the "you" marker; with {@code glideMs} it glides there instead of jumping between fixes. */
  setUser(fix: Pick<Fix, 'lat' | 'lng' | 'accuracy' | 'heading' | 'speed'> | null, glideMs = 0): void {
    cancelAnimationFrame(this.userAnim);
    if (!fix) {
      this.user?.remove();
      this.accuracy?.remove();
      this.user = null;
      this.accuracy = null;
      return;
    }
    const at = tuple(fix);
    const radius = Math.min(Math.max(fix.accuracy, 5), 2000);
    if (this.user && this.accuracy && glideMs > 0 && !reducedMotion()) {
      const from = this.user.getLatLng();
      if (this.map.distance(from, at) < 1500) {
        this.accuracy.setRadius(radius);
        this.glideUser(from, L.latLng(at), glideMs);
        this.pointUser(fix);
        return;
      }
    }
    if (this.accuracy) this.accuracy.setLatLng(at).setRadius(radius);
    else {
      this.accuracy = L.circle(at, {
        radius,
        color: '#38bdf8',
        weight: 1,
        opacity: 0.45,
        fillColor: '#38bdf8',
        fillOpacity: 0.1,
        interactive: false,
        className: 'hx-accuracy',
      }).addTo(this.map);
    }
    if (this.user) this.user.setLatLng(at);
    else this.user = L.marker(at, { icon: userIcon, keyboard: false, interactive: false, zIndexOffset: 900 }).addTo(this.map);
    this.pointUser(fix);
  }

  private pointUser(fix: Pick<Fix, 'heading' | 'speed'>): void {
    const el = this.user?.getElement();
    if (!el) return;
    const heading = fix.heading !== null && (fix.speed ?? 0) > 1 ? fix.heading : null;
    el.classList.toggle('has-heading', heading !== null);
    if (heading !== null) el.style.setProperty('--heading', `${heading}deg`);
  }

  private glideUser(from: L.LatLng, to: L.LatLng, ms: number): void {
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const e = 1 - (1 - t) * (1 - t);
      const p = L.latLng(from.lat + (to.lat - from.lat) * e, from.lng + (to.lng - from.lng) * e);
      this.user?.setLatLng(p);
      this.accuracy?.setLatLng(p);
      if (t < 1) this.userAnim = requestAnimationFrame(step);
    };
    this.userAnim = requestAnimationFrame(step);
  }

  /**
   * Shows where the alarm will ring on the planned road. When the distance setting changes the
   * bell slides along the road to its new spot.
   */
  setAlarmPreview(path: RoutePath | null, distanceM: number, label: string): void {
    cancelAnimationFrame(this.previewAnim);
    if (!path || path.length <= distanceM) {
      this.alarmPreview?.remove();
      this.alarmPreview = null;
      this.alarmPreviewPath = null;
      return;
    }
    const along = path.length - distanceM;
    if (!this.alarmPreview || this.alarmPreviewPath !== path) {
      this.alarmPreview?.remove();
      this.alarmPreview = L.marker(tuple(path.pointAt(along)), {
        icon: L.divIcon({
          className: 'hx-alarm-point hx-alarm-preview',
          html:
            '<span class="hx-alarm-wave"></span><svg class="i" aria-hidden="true"><use href="#i-bell"></use></svg><span class="hx-alarm-tag"></span>',
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        }),
        keyboard: false,
        interactive: false,
        zIndexOffset: 800,
      }).addTo(this.map);
      this.alarmPreviewPath = path;
      this.alarmPreviewAlong = along;
    }
    const tag = this.alarmPreview.getElement()?.querySelector('.hx-alarm-tag');
    if (tag) tag.textContent = label;
    const from = this.alarmPreviewAlong;
    if (from === along) return;
    if (reducedMotion()) {
      this.alarmPreview.setLatLng(tuple(path.pointAt(along)));
      this.alarmPreviewAlong = along;
      return;
    }
    const marker = this.alarmPreview;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 700);
      const a = from + (along - from) * (1 - (1 - t) ** 3);
      marker.setLatLng(tuple(path.pointAt(a)));
      this.alarmPreviewAlong = a;
      if (t < 1) this.previewAnim = requestAnimationFrame(step);
    };
    this.previewAnim = requestAnimationFrame(step);
  }

  /** The bell on the trip route rings faster as the bus gets close to it. */
  setAlarmNear(near: boolean): void {
    this.tripAlarm?.getElement()?.classList.toggle('near', near);
  }

  /** Dashed preview of the road route, drawn on with an animation. */
  setPreviewRoute(points: LatLng[] | null): void {
    this.preview?.remove();
    this.preview = null;
    if (!points || points.length < 2) return;
    this.preview = L.polyline(points.map(tuple), {
      color: '#5eead4',
      weight: 5,
      opacity: 0.95,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false,
      className: 'hx-route-draw',
    }).addTo(this.map);
    this.preview.getElement()?.setAttribute('pathLength', '1');
  }

  /** The trip route, split into travelled (grey) and remaining (teal) parts. */
  setTripRoute(route: RoutePath | null, along: number, alarmAlong: number | null): void {
    if (!route) {
      this.routeLayers.forEach((layer) => layer.remove());
      this.routeLayers = [];
      this.ahead = this.glow = this.done = null;
      this.tripAlarm = null;
      this.drawnRoute = null;
      return;
    }
    if (route !== this.drawnRoute) {
      this.routeLayers.forEach((layer) => layer.remove());
      this.done = L.polyline([], { color: '#64748b', weight: 4, opacity: 0.6, interactive: false });
      this.glow = L.polyline([], {
        color: '#2dd4bf',
        weight: 13,
        opacity: 0.2,
        lineCap: 'round',
        interactive: false,
        className: 'hx-route-glow',
      });
      this.ahead = L.polyline([], {
        color: '#2dd4bf',
        weight: 5,
        opacity: 0.95,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false,
        className: 'hx-route-flow',
      });
      this.routeLayers = [this.done, this.glow, this.ahead];
      this.tripAlarm = null;
      if (alarmAlong !== null && alarmAlong > 0) {
        this.tripAlarm = L.marker(tuple(route.pointAt(alarmAlong)), {
          icon: L.divIcon({
            className: 'hx-alarm-point',
            html: '<span class="hx-alarm-wave"></span><svg class="i" aria-hidden="true"><use href="#i-bell"></use></svg>',
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          }),
          keyboard: false,
          interactive: false,
        });
        this.routeLayers.push(this.tripAlarm);
      }
      this.routeLayers.forEach((layer) => layer.addTo(this.map));
      this.drawnRoute = route;
      this.drawnAlong = -Infinity;
    }
    if (Math.abs(along - this.drawnAlong) >= 8) {
      const { done, ahead } = route.split(along);
      this.ahead!.setLatLngs(ahead.map(tuple));
      this.glow!.setLatLngs(ahead.map(tuple));
      this.done!.setLatLngs(done.map(tuple));
      this.drawnAlong = along;
    }
  }

  private padding(): { paddingTopLeft: L.PointTuple; paddingBottomRight: L.PointTuple } {
    return { paddingTopLeft: [40, 120], paddingBottomRight: [40, this.bottomInset() + 40] };
  }

  fit(points: LatLng[], maxZoom = 16): void {
    if (points.length === 0) return;
    this.autoUntil = Date.now() + 900;
    if (points.length === 1) {
      this.focus(points[0], Math.max(this.map.getZoom(), 14));
      return;
    }
    this.map.fitBounds(L.latLngBounds(points.map(tuple)), { ...this.padding(), maxZoom });
  }

  /** Centres a point in the part of the map that isn't covered by the sheet. */
  focus(p: LatLng, zoom = 15): void {
    this.autoUntil = Date.now() + 900;
    const target = this.map.project(tuple(p), zoom).add([0, (this.bottomInset() - 60) / 2]);
    this.map.setView(this.map.unproject(target, zoom), zoom, { animate: true });
  }

  /** Pans just enough to bring a point out from under the sheet or the search bar. */
  ensureVisible(p: LatLng): void {
    const size = this.map.getSize();
    const pt = this.map.latLngToContainerPoint(tuple(p));
    const bottom = size.y - this.bottomInset() - 50;
    if (pt.y < 150 || pt.y > bottom || pt.x < 30 || pt.x > size.x - 30) this.focus(p, this.map.getZoom());
  }

  /** Keeps both the rider and the stop in view, zooming in as they get closer. */
  track(p: LatLng, stop: LatLng): void {
    if (!this.following) return;
    const both = L.latLngBounds([tuple(p), tuple(stop)]);
    const size = this.map.getSize();
    const inner = L.bounds(L.point(40, 130), L.point(size.x - 40, size.y - this.bottomInset() - 30));
    const a = this.map.latLngToContainerPoint(tuple(p));
    const b = this.map.latLngToContainerPoint(tuple(stop));
    const wanted = Math.min(16, this.map.getBoundsZoom(both, false, L.point(110, this.bottomInset() + 200)));
    if (!inner.contains(a) || !inner.contains(b) || wanted >= this.map.getZoom() + 1) {
      this.autoUntil = Date.now() + 900;
      this.map.fitBounds(both, { ...this.padding(), maxZoom: 16 });
    }
  }

  setFollowing(following: boolean): void {
    if (following === this.following) return;
    this.following = following;
    this.onFollowChange?.(following);
  }

  invalidate(): void {
    this.map.invalidateSize({ pan: false });
  }

  private markStyle(): void {
    this.map.getContainer().dataset.style = this.styleName;
  }
}
