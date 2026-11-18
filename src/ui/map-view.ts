import L from 'leaflet';
import type { Fix } from '../core/fix-filter';
import type { LatLng } from '../core/geo';
import type { RouteLine } from '../core/route-line';

export type MapStyle = 'dark' | 'light';

const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

/**
 * OpenStreetMap's own tiles (no API key). The dark style is the same tiles
 * through a CSS filter (see .map-shell[data-style='dark'] in main.css), which
 * only touches the tile layer, never markers or the route.
 */
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

const wrapLng = (lng: number) => ((((lng + 180) % 360) + 360) % 360) - 180;
const tuple = (p: LatLng): L.LatLngTuple => [p.lat, p.lng];

const destIcon = L.divIcon({
  className: 'hx-dest-icon',
  html:
    '<span class="hx-dest-pulse"></span>' +
    '<svg viewBox="0 0 36 48" width="36" height="48" aria-hidden="true">' +
    '<path d="M18 1C8.6 1 1 8.4 1 17.6 1 30.4 18 47 18 47s17-16.6 17-29.4C35 8.4 27.4 1 18 1z" fill="#2dd4bf" stroke="#042f2e" stroke-width="2"/>' +
    '<circle cx="18" cy="17.5" r="6.5" fill="#042f2e"/></svg>',
  iconSize: [36, 48],
  iconAnchor: [18, 46],
});

const userIcon = L.divIcon({
  className: 'hx-user-icon',
  html:
    '<svg class="hx-user-arrow" viewBox="0 0 48 48" aria-hidden="true"><path d="M24 2 31 15 24 12 17 15Z"/></svg>' +
    '<span class="hx-user-dot"></span>',
  iconSize: [26, 26],
  iconAnchor: [13, 13],
});

/** Thin wrapper around Leaflet with the layers this app needs. */
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
  private drawnRoute: RouteLine | null = null;
  private drawnAlong = -Infinity;
  private following = true;
  /** Map moves before this time are ours, not the user's. */
  private autoUntil = 0;

  constructor(container: HTMLElement, style: MapStyle) {
    this.map = L.map(container, {
      zoomControl: false,
      center: [22.6, 79.2],
      zoom: 5,
      minZoom: 3,
      worldCopyJump: true,
    });
    this.map.attributionControl.setPrefix(
      '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>',
    );
    L.control.zoom({ position: 'topleft' }).addTo(this.map);
    this.styleName = style;
    L.tileLayer(TILE_URL, { maxZoom: 19, crossOrigin: true, attribution: ATTRIBUTION }).addTo(this.map);
    this.markStyle();
    // A drag or a zoom by the user (not by us) pauses auto-follow.
    this.map.on('dragstart', () => this.setFollowing(false));
    this.map.on('zoomstart', () => {
      if (Date.now() > this.autoUntil) this.setFollowing(false);
    });
  }

  get style(): MapStyle {
    return this.styleName;
  }

  setStyle(style: MapStyle): void {
    if (style === this.styleName) return;
    this.styleName = style;
    this.markStyle();
  }

  onTap(handler: (p: LatLng) => void): void {
    this.map.on('click', (e: L.LeafletMouseEvent) => handler({ lat: e.latlng.lat, lng: wrapLng(e.latlng.lng) }));
  }

  /** Current view, used to bias place search towards what the user is looking at. */
  bias(): { lat: number; lng: number; zoom: number } {
    const c = this.map.getCenter();
    return { lat: c.lat, lng: wrapLng(c.lng), zoom: this.map.getZoom() };
  }

  setDestination(p: LatLng | null): void {
    if (!p) {
      this.dest?.remove();
      this.dest = null;
      return;
    }
    if (this.dest) this.dest.setLatLng(tuple(p));
    else {
      this.dest = L.marker(tuple(p), { icon: destIcon, keyboard: false, interactive: false, zIndexOffset: 1000 }).addTo(
        this.map,
      );
    }
  }

  setUser(fix: Fix | null): void {
    if (!fix) {
      this.user?.remove();
      this.accuracy?.remove();
      this.user = null;
      this.accuracy = null;
      return;
    }
    const at = tuple(fix);
    const radius = Math.min(Math.max(fix.accuracy, 5), 2000);
    if (this.accuracy) this.accuracy.setLatLng(at).setRadius(radius);
    else {
      this.accuracy = L.circle(at, {
        radius,
        color: '#38bdf8',
        weight: 1,
        opacity: 0.5,
        fillColor: '#38bdf8',
        fillOpacity: 0.1,
        interactive: false,
      }).addTo(this.map);
    }
    if (this.user) this.user.setLatLng(at);
    else this.user = L.marker(at, { icon: userIcon, keyboard: false, interactive: false, zIndexOffset: 900 }).addTo(this.map);

    const el = this.user.getElement();
    if (el) {
      const heading = fix.heading !== null && (fix.speed ?? 0) > 1 ? fix.heading : null;
      el.classList.toggle('has-heading', heading !== null);
      if (heading !== null) el.style.setProperty('--heading', `${heading}deg`);
    }
  }

  setPreviewRoute(points: LatLng[] | null): void {
    this.preview?.remove();
    this.preview = null;
    if (points && points.length > 1) {
      this.preview = L.polyline(points.map(tuple), {
        color: '#5eead4',
        weight: 5,
        opacity: 0.9,
        dashArray: '1 10',
        lineCap: 'round',
        interactive: false,
      }).addTo(this.map);
    }
  }

  /** Draws the trip route split into travelled (grey) and remaining (teal) parts. */
  setTripRoute(route: RouteLine | null, along: number, alarmAlong: number | null): void {
    if (!route) {
      this.routeLayers.forEach((layer) => layer.remove());
      this.routeLayers = [];
      this.ahead = this.glow = this.done = null;
      this.drawnRoute = null;
      return;
    }
    if (route !== this.drawnRoute) {
      this.routeLayers.forEach((layer) => layer.remove());
      this.done = L.polyline([], { color: '#64748b', weight: 4, opacity: 0.6, interactive: false });
      this.glow = L.polyline([], { color: '#2dd4bf', weight: 12, opacity: 0.18, lineCap: 'round', interactive: false });
      this.ahead = L.polyline([], {
        color: '#2dd4bf',
        weight: 5,
        opacity: 0.95,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false,
      });
      this.routeLayers = [this.done, this.glow, this.ahead];
      if (alarmAlong !== null && alarmAlong > 0) {
        this.routeLayers.push(
          L.circleMarker(tuple(route.pointAt(alarmAlong)), {
            radius: 7,
            color: '#fbbf24',
            weight: 3,
            fillColor: '#422006',
            fillOpacity: 1,
          }).bindTooltip('Alarm rings here', { direction: 'top', offset: [0, -6] }),
        );
      }
      this.routeLayers.forEach((layer) => layer.addTo(this.map));
      this.drawnRoute = route;
      this.drawnAlong = -Infinity;
    }
    if (Math.abs(along - this.drawnAlong) >= 10) {
      const ahead = route.sliceFrom(along).map(tuple);
      this.ahead!.setLatLngs(ahead);
      this.glow!.setLatLngs(ahead);
      this.done!.setLatLngs(route.sliceTo(along).map(tuple));
      this.drawnAlong = along;
    }
  }

  fit(points: LatLng[], maxZoom = 16): void {
    if (points.length === 0) return;
    this.autoUntil = Date.now() + 800;
    if (points.length === 1) {
      this.map.setView(tuple(points[0]), Math.max(this.map.getZoom(), 14));
      return;
    }
    this.map.fitBounds(L.latLngBounds(points.map(tuple)), { padding: [40, 40], maxZoom });
  }

  focus(p: LatLng, zoom = 15): void {
    this.autoUntil = Date.now() + 800;
    this.map.setView(tuple(p), zoom, { animate: true });
  }

  /**
   * Keeps both the rider and the stop in view, zooming in as they get closer.
   * Does nothing once the user has moved the map themselves.
   */
  track(p: LatLng, stop: LatLng): void {
    if (!this.following) return;
    const both = L.latLngBounds([tuple(p), tuple(stop)]);
    const inner = this.map.getBounds().pad(-0.12);
    const wanted = Math.min(16, this.map.getBoundsZoom(both, false, L.point(100, 100)));
    if (!inner.contains(both) || wanted >= this.map.getZoom() + 1) {
      this.autoUntil = Date.now() + 800;
      this.map.fitBounds(both, { padding: [48, 48], maxZoom: 16 });
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
    const shell = this.map.getContainer().parentElement;
    if (shell) shell.dataset.style = this.styleName;
  }
}
