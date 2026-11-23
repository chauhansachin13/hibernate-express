import type { Fix } from '../core/fix';
import { haversine, type LatLng } from '../core/geo';
import type { RoutePath } from '../core/route-path';
import { GOOGLE_MAP_ID, type Google } from '../services/google';
import type { MapStyle } from './map-view';

/* eslint-disable @typescript-eslint/no-explicit-any -- the Google Maps JS API is loaded at runtime */

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const literal = (p: LatLng) => ({ lat: p.lat, lng: p.lng });

const DEST_HTML =
  '<span class="hx-dest-ring"></span><span class="hx-dest-shadow"></span>' +
  '<svg class="hx-dest-pin" viewBox="0 0 36 48" width="36" height="48" aria-hidden="true">' +
  '<path d="M18 1C8.6 1 1 8.4 1 17.6 1 30.4 18 47 18 47s17-16.6 17-29.4C35 8.4 27.4 1 18 1z" fill="#2dd4bf" stroke="#042f2e" stroke-width="2"/>' +
  '<circle cx="18" cy="17.5" r="6.5" fill="#042f2e"/></svg>';
const USER_HTML =
  '<span class="hx-user-ping"></span>' +
  '<svg class="hx-user-arrow" viewBox="0 0 48 48" aria-hidden="true"><path d="M24 2 31 15 24 12 17 15Z"/></svg>' +
  '<span class="hx-user-dot"></span>';
const BELL_HTML = '<span class="hx-alarm-wave"></span><svg class="i" aria-hidden="true"><use href="#i-bell"></use></svg>';

/** Marker content: Google anchors markers at their bottom centre; `centered` puts the middle there. */
function markerContent(className: string, html: string, size: [number, number], centered: boolean): HTMLElement {
  const outer = document.createElement('div');
  outer.className = `hx-gm${centered ? ' hx-gm-centered' : ''}`;
  const inner = document.createElement('div');
  inner.className = className;
  inner.style.width = `${size[0]}px`;
  inner.style.height = `${size[1]}px`;
  inner.innerHTML = html;
  outer.append(inner);
  return outer;
}

/**
 * The same map as MapView, drawn with Google Maps (used when a Google key is configured): Google's
 * map data and look, with this app's pin, "you" dot, alarm bell and route on top.
 */
export class GoogleMapView {
  onFollowChange: ((following: boolean) => void) | null = null;

  private readonly g: Google;
  private readonly container: HTMLElement;
  private readonly bottomInset: () => number;
  private map: any;
  private overlay: any;
  private styleName: MapStyle;
  private tapHandler: ((p: LatLng) => void) | null = null;
  private dest: any = null;
  private user: any = null;
  private userEl: HTMLElement | null = null;
  private accuracy: any = null;
  private preview: any = null;
  private done: any = null;
  private glow: any = null;
  private ahead: any = null;
  private drawnRoute: RoutePath | null = null;
  private drawnAlong = -Infinity;
  private tripAlarm: any = null;
  private tripAlarmEl: HTMLElement | null = null;
  private alarmPreview: any = null;
  private alarmPreviewEl: HTMLElement | null = null;
  private alarmPreviewPath: RoutePath | null = null;
  private alarmPreviewAlong = 0;
  private previewAnim = 0;
  private drawAnim = 0;
  private userAnim = 0;
  private following = true;
  private autoUntil = 0;

  constructor(g: Google, container: HTMLElement, style: MapStyle, bottomInset: () => number) {
    this.g = g;
    this.container = container;
    this.bottomInset = bottomInset;
    this.styleName = style;
    this.create({ lat: 22.6, lng: 79.2 }, 5);
  }

  private create(center: LatLng, zoom: number): void {
    const g = this.g;
    this.container.replaceChildren();
    this.container.dataset.engine = 'google';
    this.container.dataset.style = this.styleName;
    this.map = new g.maps.Map(this.container, {
      center: literal(center),
      zoom,
      minZoom: 3,
      mapId: GOOGLE_MAP_ID,
      colorScheme: this.styleName === 'dark' ? g.maps.ColorScheme?.DARK : g.maps.ColorScheme?.LIGHT,
      disableDefaultUI: true,
      clickableIcons: true,
      gestureHandling: 'greedy',
      keyboardShortcuts: false,
    });
    // Only for turning positions into screen pixels.
    this.overlay = new g.maps.OverlayView();
    this.overlay.onAdd = () => undefined;
    this.overlay.draw = () => undefined;
    this.overlay.onRemove = () => undefined;
    this.overlay.setMap(this.map);
    this.map.addListener('dragstart', () => this.setFollowing(false));
    this.map.addListener('zoom_changed', () => {
      if (Date.now() > this.autoUntil) this.setFollowing(false);
    });
    this.map.addListener('click', (e: any) => {
      if (!e.latLng) return;
      if (e.placeId) e.stop(); // a tap on one of Google's places picks it instead of opening its card
      this.tapHandler?.({ lat: e.latLng.lat(), lng: e.latLng.lng() });
    });
    for (const thing of [this.dest, this.user, this.tripAlarm, this.alarmPreview]) if (thing) thing.map = this.map;
    for (const line of [this.accuracy, this.preview, this.done, this.glow, this.ahead]) line?.setMap(this.map);
  }

  get style(): MapStyle {
    return this.styleName;
  }

  /** Google sets dark or light when a map is made, so switching makes a new map in the same place. */
  setStyle(style: MapStyle): void {
    if (style === this.styleName) return;
    this.styleName = style;
    const c = this.map.getCenter();
    this.create({ lat: c.lat(), lng: c.lng() }, this.map.getZoom());
  }

  onTap(handler: (p: LatLng) => void): void {
    this.tapHandler = handler;
  }

  bias(): { lat: number; lng: number; zoom: number } {
    const c = this.map.getCenter();
    return { lat: c.lat(), lng: c.lng(), zoom: this.map.getZoom() };
  }

  private marker(position: LatLng, content: HTMLElement, zIndex: number): any {
    return new this.g.maps.marker.AdvancedMarkerElement({ map: this.map, position: literal(position), content, zIndex, gmpClickable: false });
  }

  setDestination(p: LatLng | null): void {
    if (this.dest) this.dest.map = null;
    this.dest = null;
    if (!p) return;
    // A fresh marker each time so the drop animation replays.
    this.dest = this.marker(p, markerContent('hx-dest', DEST_HTML, [36, 48], false), 1000);
  }

  setUser(fix: Pick<Fix, 'lat' | 'lng' | 'accuracy' | 'heading' | 'speed'> | null, glideMs = 0): void {
    cancelAnimationFrame(this.userAnim);
    if (!fix) {
      if (this.user) this.user.map = null;
      this.accuracy?.setMap(null);
      this.user = this.accuracy = this.userEl = null;
      return;
    }
    const radius = Math.min(Math.max(fix.accuracy, 5), 2000);
    if (this.user && this.accuracy && glideMs > 0 && !reducedMotion()) {
      const from = { lat: this.user.position.lat, lng: this.user.position.lng };
      if (haversine(from, fix) < 1500) {
        this.accuracy.setRadius(radius);
        this.glideUser(from, fix, glideMs);
        this.pointUser(fix);
        return;
      }
    }
    if (this.accuracy) {
      this.accuracy.setCenter(literal(fix));
      this.accuracy.setRadius(radius);
    } else {
      this.accuracy = new this.g.maps.Circle({
        map: this.map,
        center: literal(fix),
        radius,
        strokeColor: '#38bdf8',
        strokeOpacity: 0.45,
        strokeWeight: 1,
        fillColor: '#38bdf8',
        fillOpacity: 0.1,
        clickable: false,
      });
    }
    if (this.user) this.user.position = literal(fix);
    else {
      const content = markerContent('hx-user', USER_HTML, [26, 26], true);
      this.userEl = content.firstElementChild as HTMLElement;
      this.user = this.marker(fix, content, 900);
    }
    this.pointUser(fix);
  }

  private pointUser(fix: Pick<Fix, 'heading' | 'speed'>): void {
    const el = this.userEl;
    if (!el) return;
    const heading = fix.heading !== null && (fix.speed ?? 0) > 1 ? fix.heading : null;
    el.classList.toggle('has-heading', heading !== null);
    if (heading !== null) el.style.setProperty('--heading', `${heading}deg`);
  }

  private glideUser(from: LatLng, to: LatLng, ms: number): void {
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const e = 1 - (1 - t) * (1 - t);
      const p = { lat: from.lat + (to.lat - from.lat) * e, lng: from.lng + (to.lng - from.lng) * e };
      if (this.user) this.user.position = p;
      this.accuracy?.setCenter(p);
      if (t < 1) this.userAnim = requestAnimationFrame(step);
    };
    this.userAnim = requestAnimationFrame(step);
  }

  /** Where the alarm will ring on the planned road; the bell slides to its new spot. */
  setAlarmPreview(path: RoutePath | null, distanceM: number, label: string): void {
    cancelAnimationFrame(this.previewAnim);
    if (!path || path.length <= distanceM) {
      if (this.alarmPreview) this.alarmPreview.map = null;
      this.alarmPreview = this.alarmPreviewEl = this.alarmPreviewPath = null;
      return;
    }
    const along = path.length - distanceM;
    if (!this.alarmPreview || this.alarmPreviewPath !== path) {
      if (this.alarmPreview) this.alarmPreview.map = null;
      const content = markerContent('hx-alarm-point hx-alarm-preview', `${BELL_HTML}<span class="hx-alarm-tag"></span>`, [30, 30], true);
      this.alarmPreviewEl = content.firstElementChild as HTMLElement;
      this.alarmPreview = this.marker(path.pointAt(along), content, 800);
      this.alarmPreviewPath = path;
      this.alarmPreviewAlong = along;
    }
    const tag = this.alarmPreviewEl?.querySelector('.hx-alarm-tag');
    if (tag) tag.textContent = label;
    const from = this.alarmPreviewAlong;
    if (from === along) return;
    const marker = this.alarmPreview;
    if (reducedMotion()) {
      marker.position = literal(path.pointAt(along));
      this.alarmPreviewAlong = along;
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 700);
      const a = from + (along - from) * (1 - (1 - t) ** 3);
      marker.position = literal(path.pointAt(a));
      this.alarmPreviewAlong = a;
      if (t < 1) this.previewAnim = requestAnimationFrame(step);
    };
    this.previewAnim = requestAnimationFrame(step);
  }

  setAlarmNear(near: boolean): void {
    this.tripAlarmEl?.classList.toggle('near', near);
  }

  /** The planned road, drawn on from your end to the stop. */
  setPreviewRoute(points: LatLng[] | null): void {
    cancelAnimationFrame(this.drawAnim);
    this.preview?.setMap(null);
    this.preview = null;
    if (!points || points.length < 2) return;
    this.preview = new this.g.maps.Polyline({
      map: this.map,
      path: reducedMotion() ? points.map(literal) : [literal(points[0])],
      strokeColor: '#5eead4',
      strokeOpacity: 0.95,
      strokeWeight: 5,
      clickable: false,
      zIndex: 5,
    });
    if (reducedMotion()) return;
    const line = this.preview;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 1100);
      const n = Math.max(2, Math.ceil(points.length * (1 - (1 - t) ** 3)));
      line.setPath(points.slice(0, n).map(literal));
      if (t < 1) this.drawAnim = requestAnimationFrame(step);
    };
    this.drawAnim = requestAnimationFrame(step);
  }

  /** The trip route: travelled part grey, the rest teal with a soft glow, and the alarm bell. */
  setTripRoute(route: RoutePath | null, along: number, alarmAlong: number | null): void {
    if (!route) {
      for (const line of [this.done, this.glow, this.ahead]) line?.setMap(null);
      if (this.tripAlarm) this.tripAlarm.map = null;
      this.done = this.glow = this.ahead = this.tripAlarm = this.tripAlarmEl = null;
      this.drawnRoute = null;
      return;
    }
    if (route !== this.drawnRoute) {
      for (const line of [this.done, this.glow, this.ahead]) line?.setMap(null);
      if (this.tripAlarm) this.tripAlarm.map = null;
      const line = (color: string, weight: number, opacity: number, zIndex: number) =>
        new this.g.maps.Polyline({ map: this.map, path: [], strokeColor: color, strokeWeight: weight, strokeOpacity: opacity, clickable: false, zIndex });
      this.done = line('#64748b', 4, 0.6, 3);
      this.glow = line('#2dd4bf', 13, 0.2, 4);
      this.ahead = line('#2dd4bf', 5, 0.95, 6);
      this.tripAlarm = this.tripAlarmEl = null;
      if (alarmAlong !== null && alarmAlong > 0) {
        const content = markerContent('hx-alarm-point', BELL_HTML, [28, 28], true);
        this.tripAlarmEl = content.firstElementChild as HTMLElement;
        this.tripAlarm = this.marker(route.pointAt(alarmAlong), content, 700);
      }
      this.drawnRoute = route;
      this.drawnAlong = -Infinity;
    }
    if (Math.abs(along - this.drawnAlong) >= 8) {
      const { done, ahead } = route.split(along);
      this.ahead.setPath(ahead.map(literal));
      this.glow.setPath(ahead.map(literal));
      this.done.setPath(done.map(literal));
      this.drawnAlong = along;
    }
  }

  private padding(): { top: number; right: number; bottom: number; left: number } {
    return { top: 120, right: 40, bottom: this.bottomInset() + 40, left: 40 };
  }

  fit(points: LatLng[], maxZoom = 16): void {
    if (points.length === 0) return;
    if (points.length === 1) {
      this.focus(points[0], Math.max(this.map.getZoom(), 14));
      return;
    }
    this.autoUntil = Date.now() + 1200;
    const bounds = new this.g.maps.LatLngBounds();
    for (const p of points) bounds.extend(literal(p));
    this.map.fitBounds(bounds, this.padding());
    this.g.maps.event.addListenerOnce(this.map, 'idle', () => {
      if (this.map.getZoom() > maxZoom) {
        this.autoUntil = Date.now() + 900;
        this.map.setZoom(maxZoom);
      }
    });
  }

  /** Centres a point in the part of the map that isn't covered by the sheet. */
  focus(p: LatLng, zoom = 15): void {
    this.autoUntil = Date.now() + 1200;
    this.map.setZoom(zoom);
    this.map.setCenter(literal(p));
    this.map.panBy(0, (this.bottomInset() - 60) / 2);
  }

  private pixel(p: LatLng): { x: number; y: number } | null {
    const projection = this.overlay?.getProjection?.();
    if (!projection) return null;
    const pt = projection.fromLatLngToContainerPixel(new this.g.maps.LatLng(p.lat, p.lng));
    return pt ? { x: pt.x, y: pt.y } : null;
  }

  ensureVisible(p: LatLng): void {
    const pt = this.pixel(p);
    const w = this.container.clientWidth;
    const bottom = this.container.clientHeight - this.bottomInset() - 50;
    if (!pt || pt.y < 150 || pt.y > bottom || pt.x < 30 || pt.x > w - 30) this.focus(p, this.map.getZoom());
  }

  /** Keeps both the rider and the stop in view, zooming in as they get closer. */
  track(p: LatLng, stop: LatLng): void {
    if (!this.following) return;
    const a = this.pixel(p);
    const b = this.pixel(stop);
    const w = this.container.clientWidth;
    const h = this.container.clientHeight - this.bottomInset() - 30;
    const inside = (q: { x: number; y: number } | null) => q !== null && q.x >= 40 && q.x <= w - 40 && q.y >= 130 && q.y <= h;
    const close = a && b ? Math.hypot(a.x - b.x, a.y - b.y) < Math.min(w, h) * 0.3 : false;
    if (!inside(a) || !inside(b) || close) this.fit([p, stop], 16);
  }

  setFollowing(following: boolean): void {
    if (following === this.following) return;
    this.following = following;
    this.onFollowChange?.(following);
  }

  invalidate(): void {
    // Google Maps follows its container's size by itself.
  }
}
