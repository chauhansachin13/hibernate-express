import type { AlarmReason } from './core/alarm-policy';
import { parseCoordinates } from './core/coords';
import type { Fix } from './core/fix-filter';
import {
  formatAgo,
  formatClock,
  formatCoord,
  formatDistance,
  formatDuration,
  formatSpeed,
  splitDistance,
} from './core/format';
import { bearing, clamp, destinationPoint, haversine, isValidLatLng, type LatLng } from './core/geo';
import { RouteLine } from './core/route-line';
import { SOUNDS, type SoundId } from './core/sound-synth';
import {
  directRoute,
  TripEngine,
  type EngineOptions,
  type EngineState,
  type RouteData,
  type TravelMode,
  type TripSnapshot,
} from './core/trip-engine';
import { AlarmPlayer } from './services/alarm-player';
import {
  clearNotifications,
  KEYS,
  loadJSON,
  notify,
  removeKey,
  requestNotificationPermission,
  saveJSON,
  ScreenWakeLock,
} from './services/device';
import { reverseGeocode, type Place } from './services/geocoding';
import { getCurrentFix, LocationError, LocationWatcher } from './services/location';
import { fetchRoadRoute, RoutingError } from './services/routing';
import { RideSimulator } from './services/simulator';
import { icon, kindIcon } from './ui/icons';
import { MapView, type MapStyle } from './ui/map-view';
import { SearchBox } from './ui/search-box';

interface Settings {
  mode: TravelMode;
  distanceM: number;
  timeMin: number;
  sound: SoundId;
  vibrate: boolean;
}

interface SavedTrip {
  v: 1;
  destination: Place;
  route: { points: [number, number][]; distance: number; duration: number; kind: 'road' | 'direct'; provider: string };
  settings: Settings;
  startedAt: number;
  engine: EngineState;
}

interface Trip {
  engine: TripEngine;
  destination: Place;
  settings: Settings;
  demo: boolean;
  timeScale: number;
  watcher: LocationWatcher | null;
  simulator: RideSimulator | null;
  startedAt: number;
  ticker: number;
  unsubscribe: () => void;
  savedAt: number;
  savedRoute: RouteData | null;
  savedPoints: [number, number][];
  ringing: AlarmReason | null;
  snapshot: TripSnapshot | null;
  bgNotified: boolean;
  joke: string;
}

type TripParts = Pick<Trip, 'engine' | 'destination' | 'settings' | 'demo' | 'timeScale' | 'watcher' | 'simulator' | 'startedAt'>;

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

const DISTANCES = [500, 1000, 2000, 3000, 5000, 10_000];
const TIMES = [0, 5, 10, 15, 20, 30];
const DEFAULT_SETTINGS: Settings = { mode: 'road', distanceM: 2000, timeMin: 10, sound: 'classic', vibrate: true };
/** Buses run slower than the cars routing engines model. */
const BUS_FACTOR = 0.85;
const RAIL_SPEED = 55 / 3.6;
const BASE_TITLE = document.title;
const DEMO_PLACE: Place = {
  name: 'NIT Warangal',
  detail: 'Hanamkonda, Telangana, India',
  lat: 17.9837,
  lng: 79.5307,
  kind: 'education',
};
const JOKES = [
  'Even Kumbhakaran is getting up 🐻',
  'Uth ja bhai, stop aa gaya! 🚌',
  'No depot naps today 🛑',
  'Rise and shine, sleepyhead ☀️',
  'Grab your bag, champ 🎒',
];
const SHARE_TEXT =
  'Sleep on the bus without worrying 😴 Hibernate Express wakes you up before your stop 🔔 Even Kumbhakaran won’t miss his stop now!';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

function isPlace(value: unknown): value is Place {
  const p = value as Place | null;
  return !!p && typeof p.name === 'string' && typeof p.detail === 'string' && isValidLatLng(p);
}

function sanitizeSettings(raw: Partial<Settings> | null | undefined): Settings {
  const s = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  return {
    mode: s.mode === 'rail' ? 'rail' : 'road',
    distanceM: DISTANCES.includes(s.distanceM) ? s.distanceM : DEFAULT_SETTINGS.distanceM,
    timeMin: TIMES.includes(s.timeMin) ? s.timeMin : DEFAULT_SETTINGS.timeMin,
    sound: SOUNDS.some((x) => x.id === s.sound) ? s.sound : DEFAULT_SETTINGS.sound,
    vibrate: typeof s.vibrate === 'boolean' ? s.vibrate : true,
  };
}

const placeKey = (p: LatLng) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
/** "about 7 min" / "under a minute" */
const etaPhrase = (sec: number) => (sec < 60 ? 'under a minute' : `about ${formatDuration(sec)}`);
const alarmSettings = (s: Settings) => ({ distanceM: s.distanceM, timeSec: s.timeMin > 0 ? s.timeMin * 60 : null });
const engineOptions = (s: Settings): Partial<EngineOptions> => ({
  mode: s.mode,
  arrivalRadiusM: s.mode === 'rail' ? 400 : 150,
});
const alarmRule = (s: Settings) =>
  `Alarm at ${formatDistance(s.distanceM)}${s.timeMin > 0 ? ` or ${s.timeMin} min` : ''}`;

function setRadio(group: HTMLElement, value: string): void {
  for (const b of group.querySelectorAll<HTMLButtonElement>('[role="radio"]')) {
    const on = b.dataset.value === value;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

function bindRadio(group: HTMLElement, onChange: (value: string) => void): void {
  group.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[role="radio"]');
    if (!b?.dataset.value) return;
    setRadio(group, b.dataset.value);
    onChange(b.dataset.value);
  });
  group.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    const current = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const next = buttons[(current + step + buttons.length) % buttons.length];
    next.focus();
    next.click();
  });
}

export class App {
  private settings = sanitizeSettings(loadJSON<Partial<Settings> | null>(KEYS.settings, null));
  private destination: Place | null = null;
  private userFix: Fix | null = null;
  private preview: { route: RouteData; length: number; from: LatLng; at: number; key: string } | null = null;
  private previewState: 'idle' | 'loading' | 'error' = 'idle';
  private previewError = '';
  private previewCtrl: AbortController | null = null;
  private reverseCtrl: AbortController | null = null;
  private trip: Trip | null = null;
  private nightMode = false;
  private installPrompt: InstallPromptEvent | null = null;
  private toastTimer = 0;
  private readonly alarm = new AlarmPlayer();
  private readonly wakeLock = new ScreenWakeLock();
  private readonly map: MapView;
  private readonly mapShell = el('mapShell');
  private readonly mapHome: { parent: HTMLElement; next: Node | null };

  constructor() {
    const style: MapStyle = loadJSON<MapStyle>(KEYS.mapStyle, 'dark') === 'light' ? 'light' : 'dark';
    this.map = new MapView(el('map'), style);
    this.mapHome = { parent: this.mapShell.parentElement!, next: this.mapShell.nextSibling };
  }

  start(): void {
    this.bindPlanner();
    this.bindRide();
    this.bindShareAndInstall();
    this.registerServiceWorker();
    this.renderSettings();
    this.renderDestination();
    this.renderRecents();
    this.updatePlanState();
    this.checkResume();
    void this.autoLocate();
  }

  // ---------------------------------------------------------------- planner

  private bindPlanner(): void {
    new SearchBox({
      input: el<HTMLInputElement>('searchInput'),
      panel: el('searchPanel'),
      list: el('searchList'),
      status: el('searchStatus'),
      clear: el<HTMLButtonElement>('searchClear'),
      getBias: () => (this.userFix ? { lat: this.userFix.lat, lng: this.userFix.lng, zoom: 12 } : this.map.bias()),
      onSelect: (place) => this.setDestination(place, true),
    });

    this.map.onTap((p) => {
      if (!this.trip) this.dropPin(p, false);
    });
    el('locateBtn').addEventListener('click', () => void this.locate(true, false));
    el('styleBtn').addEventListener('click', () => {
      const next: MapStyle = this.map.style === 'dark' ? 'light' : 'dark';
      this.map.setStyle(next);
      saveJSON(KEYS.mapStyle, next);
    });

    el<HTMLFormElement>('manualForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.applyManualCoordinates();
    });

    bindRadio(el('modeGroup'), (value) => {
      this.settings.mode = value === 'rail' ? 'rail' : 'road';
      this.saveSettings();
      void this.refreshPreview();
    });
    bindRadio(el('distGroup'), (value) => {
      this.settings.distanceM = Number(value);
      this.saveSettings();
    });
    bindRadio(el('timeGroup'), (value) => {
      this.settings.timeMin = Number(value);
      this.saveSettings();
    });

    const sound = el<HTMLSelectElement>('soundSelect');
    sound.replaceChildren(...SOUNDS.map((s) => new Option(s.label, s.id)));
    sound.addEventListener('change', () => {
      this.settings.sound = sound.value as SoundId;
      this.saveSettings();
    });
    el('testSoundBtn').addEventListener('click', () => {
      void this.alarm.preview(this.settings.sound, this.settings.vibrate);
    });
    el<HTMLInputElement>('vibrateToggle').addEventListener('change', (e) => {
      this.settings.vibrate = (e.target as HTMLInputElement).checked;
      this.saveSettings();
    });

    el('startBtn').addEventListener('click', () => this.startTrip(false));
    el('demoBtn').addEventListener('click', () => this.startTrip(true));
  }

  private renderSettings(): void {
    setRadio(el('modeGroup'), this.settings.mode);
    setRadio(el('distGroup'), String(this.settings.distanceM));
    setRadio(el('timeGroup'), String(this.settings.timeMin));
    el<HTMLSelectElement>('soundSelect').value = this.settings.sound;
    el<HTMLInputElement>('vibrateToggle').checked = this.settings.vibrate;
  }

  private saveSettings(): void {
    saveJSON(KEYS.settings, this.settings);
    this.renderDestination();
    this.updatePlanState();
  }

  private setDestination(place: Place, fly: boolean): void {
    this.reverseCtrl?.abort();
    this.destination = place;
    this.map.setDestination(place);
    if (this.preview && this.preview.key !== placeKey(place)) {
      this.preview = null;
      this.map.setPreviewRoute(null);
    }
    if (fly) {
      if (this.userFix) this.map.fit([this.userFix, place]);
      else this.map.focus(place, 15);
    }
    this.renderDestination();
    this.updatePlanState();
    void this.refreshPreview();
  }

  private dropPin(p: LatLng, fly: boolean): void {
    const pin: Place = { name: 'Dropped pin', detail: formatCoord(p), lat: p.lat, lng: p.lng, kind: 'pin' };
    this.setDestination(pin, fly);
    const ctrl = new AbortController();
    this.reverseCtrl = ctrl;
    reverseGeocode(p, ctrl.signal)
      .then((named) => {
        if (!named || ctrl.signal.aborted || this.destination !== pin) return;
        // Keep the exact tapped coordinates; only borrow the name.
        this.destination = { ...named, lat: p.lat, lng: p.lng };
        this.renderDestination();
      })
      .catch(() => undefined);
  }

  private clearDestination(): void {
    this.reverseCtrl?.abort();
    this.previewCtrl?.abort();
    this.destination = null;
    this.preview = null;
    this.previewState = 'idle';
    this.map.setDestination(null);
    this.map.setPreviewRoute(null);
    el<HTMLInputElement>('searchInput').value = '';
    el('searchClear').hidden = true;
    this.renderDestination();
    this.updatePlanState();
  }

  private applyManualCoordinates(): void {
    const input = el<HTMLInputElement>('manualInput');
    const error = el('manualError');
    const parsed = parseCoordinates(input.value);
    if (!parsed.ok) {
      error.textContent = parsed.error;
      error.hidden = false;
      input.focus();
      return;
    }
    error.hidden = true;
    input.value = '';
    el<HTMLDetailsElement>('manualBox').open = false;
    this.dropPin(parsed.value, true);
  }

  private async refreshPreview(): Promise<void> {
    const dest = this.destination;
    const fix = this.userFix;
    this.previewCtrl?.abort();
    this.previewCtrl = null;
    if (!dest || !fix || this.settings.mode === 'rail') {
      this.previewState = 'idle';
      if (this.settings.mode === 'rail') this.map.setPreviewRoute(null);
      this.renderDestination();
      this.updatePlanState();
      return;
    }
    const key = placeKey(dest);
    if (this.preview && this.preview.key === key && haversine(this.preview.from, fix) < 150) {
      if (!this.trip) this.map.setPreviewRoute(this.preview.route.points);
      this.renderDestination();
      return;
    }
    const ctrl = new AbortController();
    this.previewCtrl = ctrl;
    const from = { lat: fix.lat, lng: fix.lng };
    this.previewState = 'loading';
    this.renderDestination();
    try {
      const route = await fetchRoadRoute(from, dest, ctrl.signal);
      if (ctrl.signal.aborted || !this.destination || placeKey(this.destination) !== key) return;
      this.preview = { route, length: new RouteLine(route.points).length, from, at: Date.now(), key };
      this.previewState = 'idle';
      if (!this.trip) {
        this.map.setPreviewRoute(route.points);
        this.map.fit(route.points);
      }
    } catch (err) {
      if (ctrl.signal.aborted) return;
      this.preview = null;
      this.previewState = 'error';
      this.previewError =
        err instanceof RoutingError && err.noRoute
          ? "No road route found to this pin — we'll use the straight-line distance."
          : "Couldn't reach the routing service — we'll try again when you start.";
    } finally {
      if (this.previewCtrl === ctrl) this.previewCtrl = null;
      if (!ctrl.signal.aborted) {
        this.renderDestination();
        this.updatePlanState();
      }
    }
  }

  private renderDestination(): void {
    const box = el('destSummary');
    const dest = this.destination;
    this.mapShell.classList.toggle('has-dest', !!dest);
    if (!dest) {
      const empty = document.createElement('p');
      empty.className = 'dest-empty';
      empty.textContent = 'No pin yet — tap the map above';
      box.replaceChildren(empty);
      return;
    }
    const row = document.createElement('div');
    row.className = 'dest-row';
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.innerHTML = kindIcon(dest.kind);
    const info = document.createElement('div');
    info.className = 'dest-info';
    const name = document.createElement('strong');
    name.textContent = dest.name;
    const detail = document.createElement('p');
    detail.className = 'detail';
    const coords = formatCoord(dest);
    detail.textContent = dest.detail && dest.detail !== coords ? `${dest.detail} · ${coords}` : coords;
    const metrics = document.createElement('div');
    metrics.className = 'dest-metrics';
    this.fillMetrics(metrics, dest);
    info.append(name, detail, metrics);
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'dest-clear';
    clear.setAttribute('aria-label', 'Remove this destination');
    clear.innerHTML = icon('i-x');
    clear.addEventListener('click', () => this.clearDestination());
    row.append(kind, info, clear);
    box.replaceChildren(row);
  }

  private fillMetrics(target: HTMLElement, dest: Place): void {
    const metric = (value: string, rest: string) => {
      const span = document.createElement('span');
      const b = document.createElement('b');
      b.textContent = value;
      span.append(b, ` ${rest}`);
      target.append(span);
    };
    const note = (text: string, warn = false) => {
      const span = document.createElement('span');
      span.className = warn ? 'metric-note warn' : 'metric-note';
      span.textContent = text;
      target.append(span);
    };
    const locateLink = (label: string) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'link-btn';
      b.textContent = label;
      b.addEventListener('click', () => void this.locate(true, false));
      target.append(b);
    };

    if (this.settings.mode === 'rail') {
      if (this.userFix) metric(formatDistance(haversine(this.userFix, dest)), 'straight line from you');
      else {
        note('Distance is measured from your live location.');
        locateLink('Measure now');
      }
      return;
    }
    if (!this.userFix) {
      note('Road distance is measured from your live location.');
      locateLink('Measure now');
      return;
    }
    if (this.previewState === 'loading') return note('Measuring the road distance…');
    if (this.previewState === 'error') return note(this.previewError, true);
    if (this.preview) {
      metric(formatDistance(this.preview.length), 'by road');
      metric(`≈ ${formatDuration(this.preview.route.duration / BUS_FACTOR)}`, 'by bus');
    }
  }

  private renderRecents(): void {
    const list = loadJSON<unknown[]>(KEYS.recents, []).filter(isPlace);
    el('recentsBox').hidden = list.length === 0;
    el('recentChips').replaceChildren(
      ...list.map((place) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'recent-chip';
        b.title = place.detail ? `${place.name}, ${place.detail}` : place.name;
        b.innerHTML = kindIcon(place.kind);
        const label = document.createElement('span');
        label.className = 'recent-label';
        label.textContent = place.name;
        b.append(label);
        b.addEventListener('click', () => this.setDestination(place, true));
        return b;
      }),
    );
  }

  private addRecent(place: Place): void {
    const list = loadJSON<unknown[]>(KEYS.recents, [])
      .filter(isPlace)
      .filter((p) => haversine(p, place) > 50);
    list.unshift({ name: place.name, detail: place.detail, lat: place.lat, lng: place.lng, kind: place.kind });
    saveJSON(KEYS.recents, list.slice(0, 6));
    this.renderRecents();
  }

  /** Start button, stepper and the "alarm would ring immediately" warning. */
  private updatePlanState(): void {
    const dest = this.destination;
    const start = el<HTMLButtonElement>('startBtn');
    start.disabled = !dest || !!this.trip;
    el('startLabel').textContent = dest ? 'Start trip & wake me up' : 'Pick your stop to start';

    const steps = el('planView').querySelectorAll('.stepper li');
    steps[0]?.classList.toggle('is-done', !!dest);
    steps[0]?.classList.toggle('is-current', !dest);
    steps[1]?.classList.toggle('is-current', !!dest);

    let warning = '';
    if (dest && this.settings.mode === 'road' && this.preview && this.preview.key === placeKey(dest)) {
      const busSec = this.preview.route.duration / BUS_FACTOR;
      if (this.preview.length <= this.settings.distanceM) {
        warning = `Your stop is only ${formatDistance(this.preview.length)} away by road, so the alarm would ring straight away. Pick a smaller distance.`;
      } else if (this.settings.timeMin > 0 && busSec <= this.settings.timeMin * 60) {
        warning = `Your stop is only about ${formatDuration(busSec)} away, so the time alarm would ring straight away. Pick a shorter time or switch it off.`;
      }
    } else if (dest && this.settings.mode === 'rail' && this.userFix) {
      const d = haversine(this.userFix, dest);
      if (d <= this.settings.distanceM) {
        warning = `Your station is only ${formatDistance(d)} away, so the alarm would ring straight away. Pick a smaller distance.`;
      }
    }
    const warn = el('thresholdWarn');
    warn.textContent = warning;
    warn.hidden = !warning;
  }

  // --------------------------------------------------------------- location

  private async locate(focus: boolean, quiet: boolean): Promise<void> {
    const btn = el('locateBtn');
    btn.classList.add('is-busy');
    try {
      const fix = await getCurrentFix();
      this.userFix = fix;
      if (!this.trip) {
        this.map.setUser(fix);
        if (focus) {
          if (this.destination) this.map.fit([fix, this.destination]);
          else this.map.focus(fix, 14);
        }
      }
      this.renderDestination();
      void this.refreshPreview();
    } catch (err) {
      if (!quiet) this.toast(this.locationHelp(err), 'warn', 7000);
    } finally {
      btn.classList.remove('is-busy');
    }
  }

  private async autoLocate(): Promise<void> {
    try {
      const status = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
      if (status?.state === 'granted') await this.locate(true, true);
    } catch {
      // Permissions API not available: wait for the user to ask.
    }
  }

  private locationHelp(err: unknown): string {
    if (!(err instanceof LocationError)) return "Couldn't get your location.";
    switch (err.code) {
      case 'denied':
        return 'Location is blocked. Tap the lock icon next to the address bar, allow Location, then try again.';
      case 'insecure':
        return 'Location only works on a secure https:// connection.';
      case 'unsupported':
        return "This browser can't share your location. Try Chrome or Safari.";
      case 'timeout':
        return 'GPS is taking a while. Move near a window and try again.';
      default:
        return 'Your GPS position is unavailable. Check that location is switched on.';
    }
  }

  // ------------------------------------------------------------------- trip

  private startTrip(demo: boolean): void {
    if (this.trip) return;
    if (!demo && !this.destination) {
      this.toast('Pick your stop first — search or tap the map.', 'warn');
      return;
    }
    // These need the user's tap, so they run before anything asynchronous.
    this.alarm.unlock(this.settings.sound);
    void this.wakeLock.enable();
    if (!demo) void requestNotificationPermission();
    if (demo) void this.beginDemo();
    else this.beginLive(this.destination!, null);
  }

  private beginLive(destination: Place, saved: SavedTrip | null): void {
    const settings = saved ? sanitizeSettings(saved.settings) : { ...this.settings };
    let initial: RouteData | undefined;
    if (saved) {
      initial = {
        points: saved.route.points.map(([lat, lng]) => ({ lat, lng })),
        distance: saved.route.distance,
        duration: saved.route.duration,
        kind: saved.route.kind,
        provider: saved.route.provider,
      };
    } else if (
      settings.mode === 'road' &&
      this.preview &&
      this.preview.key === placeKey(destination) &&
      Date.now() - this.preview.at < 10 * 60_000
    ) {
      initial = this.preview.route;
    }
    const engine = new TripEngine(
      destination,
      alarmSettings(settings),
      { route: (a, b) => fetchRoadRoute(a, b), now: () => Date.now() },
      engineOptions(settings),
      initial,
    );
    if (saved) engine.restore(saved.engine);
    const watcher = new LocationWatcher();
    const trip = this.attachTrip({
      engine,
      destination,
      settings,
      demo: false,
      timeScale: 1,
      watcher,
      simulator: null,
      startedAt: saved?.startedAt ?? Date.now(),
    });
    if (!saved) this.addRecent(destination);
    watcher.start(
      (fix) => {
        this.userFix = fix;
        engine.handleFix(fix);
      },
      (err) => this.onLocationError(trip, err),
    );
  }

  private async beginDemo(): Promise<void> {
    const settings = { ...this.settings };
    const destination = this.destination ?? DEMO_PLACE;
    if (!this.destination) this.setDestination(DEMO_PLACE, false);
    const demoBtn = el<HTMLButtonElement>('demoBtn');
    const label = demoBtn.innerHTML;
    demoBtn.disabled = true;
    demoBtn.textContent = 'Preparing your demo ride…';
    try {
      // Start far enough out that both alarm rules have room to trigger.
      const timeNeed = settings.timeMin > 0 ? settings.timeMin * 60 * (42 / 3.6) * 1.6 : 0;
      const offset = clamp(Math.max(4000, settings.distanceM * 2.2, timeNeed), 4000, 18_000);
      const towards = this.userFix && haversine(this.userFix, destination) > 1000 ? bearing(destination, this.userFix) : 215;
      const start = destinationPoint(destination, towards, offset);
      let route: RouteData;
      if (settings.mode === 'rail') route = directRoute(start, destination, RAIL_SPEED);
      else {
        try {
          route = await fetchRoadRoute(start, destination);
        } catch {
          route = directRoute(start, destination, 25 / 3.6);
        }
      }
      if (this.trip) return;
      const simulator = new RideSimulator(new RouteLine(route.points), {
        speedKmh: settings.mode === 'rail' ? 75 : 42,
        realDurationSec: 40,
        tickMs: 500,
        noiseM: 6,
      });
      const engine = new TripEngine(
        destination,
        alarmSettings(settings),
        { route: (a, b) => fetchRoadRoute(a, b), now: simulator.now, wallNow: () => Date.now() },
        engineOptions(settings),
        route,
      );
      this.attachTrip({
        engine,
        destination,
        settings,
        demo: true,
        timeScale: simulator.timeScale,
        watcher: null,
        simulator,
        startedAt: Date.now(),
      });
      simulator.start((fix) => engine.handleFix(fix));
    } finally {
      demoBtn.disabled = false;
      demoBtn.innerHTML = label;
    }
  }

  private attachTrip(parts: TripParts): Trip {
    const trip: Trip = {
      ...parts,
      ticker: 0,
      unsubscribe: () => undefined,
      savedAt: 0,
      savedRoute: null,
      savedPoints: [],
      ringing: null,
      snapshot: null,
      bgNotified: false,
      joke: JOKES[Math.floor(Math.random() * JOKES.length)],
    };
    this.trip = trip;
    this.enterRide(trip);
    trip.unsubscribe = trip.engine.subscribe((s) => this.onSnapshot(trip, s));
    trip.ticker = window.setInterval(() => trip.engine.tick(), 1000);
    this.updatePlanState();
    return trip;
  }

  private enterRide(trip: Trip): void {
    document.body.classList.add('is-riding');
    el('planView').hidden = true;
    el('rideView').hidden = false;
    el('rideMapSlot').append(this.mapShell);
    this.map.setPreviewRoute(null);
    this.map.setFollowing(true);
    el('rideEyebrow').textContent = trip.demo ? 'Demo ride to' : 'Heading to';
    el('rideDestName').textContent = trip.destination.name;
    el('rideDestDetail').textContent = trip.destination.detail;
    el('alarmRule').textContent = alarmRule(trip.settings);
    window.scrollTo({ top: 0 });
    requestAnimationFrame(() => {
      this.map.invalidate();
      this.map.fit(this.userFix ? [this.userFix, trip.destination] : [trip.destination]);
    });
  }

  private leaveRide(): void {
    document.body.classList.remove('is-riding');
    el('rideView').hidden = true;
    el('planView').hidden = false;
    this.mapHome.parent.insertBefore(this.mapShell, this.mapHome.next);
    el('followBtn').hidden = true;
    requestAnimationFrame(() => {
      this.map.invalidate();
      this.map.setUser(this.userFix);
      if (this.preview && this.destination && this.preview.key === placeKey(this.destination)) {
        this.map.setPreviewRoute(this.preview.route.points);
      }
      if (this.destination) this.map.fit(this.userFix ? [this.userFix, this.destination] : [this.destination]);
    });
  }

  private endTrip(message?: string): void {
    const trip = this.trip;
    if (!trip) return;
    this.trip = null;
    trip.unsubscribe();
    window.clearInterval(trip.ticker);
    trip.watcher?.stop();
    trip.simulator?.stop();
    trip.engine.dispose();
    this.alarm.stop();
    el('alarmOverlay').hidden = true;
    this.setNight(false);
    void this.wakeLock.disable();
    void clearNotifications('hx-alarm');
    void clearNotifications('hx-bg');
    if (!trip.demo) removeKey(KEYS.trip);
    this.map.setTripRoute(null, 0, null);
    this.leaveRide();
    this.updatePlanState();
    // You've probably moved during the trip: measure the road distance again.
    if (!trip.demo) void this.refreshPreview();
    document.title = BASE_TITLE;
    if (message) this.toast(message, 'ok', 5000);
  }

  private onLocationError(trip: Trip, err: LocationError): void {
    if (this.trip !== trip) return;
    if (err.code === 'denied' || err.code === 'insecure' || err.code === 'unsupported') {
      this.endTrip();
      this.toast(this.locationHelp(err), 'bad', 9000);
    }
    // Timeouts and short outages: the engine shows "GPS lost" and keeps estimating.
  }

  // ------------------------------------------------------------------- ride

  private bindRide(): void {
    el('nightBtn').addEventListener('click', () => this.setNight(true));
    el('nightExit').addEventListener('click', () => this.setNight(false));
    el('followBtn').addEventListener('click', () => {
      this.map.setFollowing(true);
      const trip = this.trip;
      const fix = trip?.snapshot?.fix;
      if (trip && fix) this.map.fit([fix, trip.destination]);
    });
    this.map.onFollowChange = (following) => {
      el('followBtn').hidden = following || !this.trip;
    };

    const dialog = el<HTMLDialogElement>('endDialog');
    el('endBtn').addEventListener('click', () => {
      if (typeof dialog.showModal === 'function') {
        dialog.returnValue = '';
        dialog.showModal();
      } else if (window.confirm('End this trip? The alarm will be switched off.')) {
        this.endTrip('Trip ended.');
      }
    });
    dialog.addEventListener('close', () => {
      if (dialog.returnValue === 'end') this.endTrip('Trip ended.');
    });

    el('awakeBtn').addEventListener('click', () => {
      const trip = this.trip;
      if (!trip) return;
      const reason = trip.ringing;
      trip.engine.acknowledge();
      if (reason === 'arrival') {
        this.endTrip(
          trip.demo
            ? 'Demo complete — that is exactly how it wakes you on a real ride. 🎉'
            : "You've arrived. Trip ended — have a great day! 🎉",
        );
      }
    });
    el('snoozeBtn').addEventListener('click', () => this.trip?.engine.snooze());

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.nightMode) this.setNight(false);
    });
    document.addEventListener('visibilitychange', () => {
      const trip = this.trip;
      if (!trip) return;
      if (document.visibilityState === 'hidden') {
        if (!trip.demo && !trip.bgNotified) {
          trip.bgNotified = true;
          void notify('Hibernate Express is still tracking', 'Keep this tab open so we can wake you before your stop.', {
            tag: 'hx-bg',
          });
        }
      } else {
        trip.engine.tick();
        void clearNotifications('hx-bg');
      }
    });
    window.addEventListener('beforeunload', (e) => {
      if (this.trip && !this.trip.demo) e.preventDefault();
    });
    this.wakeLock.onChange(() => {
      if (this.trip?.snapshot) this.renderRide(this.trip, this.trip.snapshot);
    });
  }

  private onSnapshot(trip: Trip, s: TripSnapshot): void {
    if (this.trip !== trip) return;
    const routeChanged = trip.snapshot?.route !== s.route;
    trip.snapshot = s;
    this.renderRide(trip, s);
    if (s.ringing !== trip.ringing) {
      const was = trip.ringing;
      trip.ringing = s.ringing;
      if (s.ringing) this.startRinging(trip, s);
      else if (was) this.stopRinging(trip);
    } else if (s.ringing) {
      this.fillAlarmText(trip, s);
    }
    if (!trip.demo && (routeChanged || Date.now() - trip.savedAt > 20_000)) this.saveTrip(trip);
  }

  private renderRide(trip: Trip, s: TripSnapshot): void {
    const now = trip.simulator ? trip.simulator.now() : Date.now();

    const value = el('remainValue');
    const unit = el('remainUnit');
    if (s.remaining === null) {
      value.textContent = '—';
      unit.textContent = '';
    } else {
      const d = splitDistance(s.remaining);
      value.textContent = `${s.remainingIsEstimate ? '~' : ''}${d.value}`;
      unit.textContent = d.unit;
    }
    el('remainLabel').textContent = this.remainingLabel(s);

    const eta = el('etaValue');
    const etaLabel = el('etaLabel');
    if (s.phase === 'arrived') {
      eta.textContent = 'Here!';
      etaLabel.textContent = 'you have arrived';
    } else if (s.remaining === null) {
      eta.textContent = '—';
      etaLabel.textContent = 'estimated arrival';
    } else if (s.etaSec === null) {
      eta.textContent = 'Stopped';
      etaLabel.textContent = 'waiting to move';
    } else {
      eta.textContent = formatDuration(s.etaSec);
      etaLabel.textContent = trip.demo ? 'left · simulated time' : `arrive ≈ ${formatClock(now + s.etaSec * 1000)}`;
    }

    const pct = Math.round(s.progress * 100);
    el('progressFill').style.width = `${s.progress * 100}%`;
    el('progressBar').setAttribute('aria-valuenow', String(pct));
    el('progressText').textContent = s.phase === 'arrived' ? 'Arrived' : `${pct}% of the way`;
    const marker = el('progressAlarm');
    const showMarker = s.alarmProgress !== null && s.alarmProgress > 0.02 && s.alarmProgress < 0.98 && !s.approachFired;
    marker.hidden = !showMarker;
    if (showMarker) marker.style.left = `${s.alarmProgress! * 100}%`;

    el('statSpeed').textContent = formatSpeed(s.speedMps);
    el('statGps').textContent = s.fix ? `±${Math.round(s.fix.accuracy)} m` : '—';
    el('statUpdated').textContent = formatAgo(s.lastFixAgeMs);

    const [tone, text, pill, pillText] = this.statusFor(trip, s, now);
    const status = el('rideStatus');
    status.dataset.tone = tone;
    status.textContent = text;
    const pillEl = el('livePill');
    pillEl.dataset.state = pill;
    el('livePillText').textContent = pillText;

    document.title = s.remaining !== null ? `${formatDistance(s.remaining)} to go · Hibernate Express` : BASE_TITLE;
    if (this.nightMode) this.renderNight(trip, s);
    else this.renderRideMap(trip, s);
  }

  private renderRideMap(trip: Trip, s: TripSnapshot): void {
    if (s.route) {
      const alarmAlong = s.route.length > trip.settings.distanceM ? s.route.length - trip.settings.distanceM : null;
      this.map.setTripRoute(s.route, s.along, alarmAlong);
    }
    this.map.setUser(s.fix);
    if (s.fix) this.map.track(s.fix, trip.destination);
  }

  private remainingLabel(s: TripSnapshot): string {
    if (s.phase === 'locating') return 'getting your location…';
    if (s.phase === 'routing') return 'finding the road route…';
    if (s.gpsLost) return 'estimated — GPS signal lost';
    if (s.routeKind === 'direct') return s.mode === 'rail' ? 'straight-line distance left' : 'straight-line distance (approx.)';
    if (!s.onRoute) return 'estimated — away from the planned road';
    return 'road distance left';
  }

  private statusFor(
    trip: Trip,
    s: TripSnapshot,
    now: number,
  ): ['ok' | 'warn' | 'info', string, string, string] {
    const live = trip.demo ? 'demo' : 'live';
    const liveText = trip.demo ? 'DEMO' : 'LIVE';
    const prefix = trip.demo ? `Demo · simulated GPS at ${Math.round(trip.timeScale)}× speed. ` : '';
    if (s.phase === 'locating') return ['info', `${prefix}Getting your GPS location… allow location access if asked.`, 'locating', 'GPS'];
    if (s.phase === 'routing') return ['info', `${prefix}Finding the road route to your stop…`, 'locating', 'ROUTE'];
    if (s.phase === 'arrived') return ['ok', `You've arrived at ${trip.destination.name}! 🎉`, 'done', 'ARRIVED'];
    if (s.gpsLost) {
      return ['warn', `${prefix}GPS signal lost (last fix ${formatAgo(s.lastFixAgeMs)}). Estimating from your last speed — the alarm still works.`, 'warn', 'NO GPS'];
    }
    if (s.rerouting) return ['warn', `${prefix}Your bus took a different road — recalculating the route…`, 'warn', 'REROUTE'];
    if (!s.onRoute) return ['warn', `${prefix}You're away from the planned road — checking…`, 'warn', 'OFF ROUTE'];
    if (s.snoozedUntil !== null) {
      const left = Math.max(0, s.snoozedUntil - now);
      return ['info', `${prefix}Snoozed — ringing again in ${formatDuration(left / 1000)}.`, live, liveText];
    }
    if (s.routeKind === 'direct' && s.mode === 'road') {
      return ['warn', `${prefix}Road route unavailable — using straight-line distance, so the alarm rings a little early.`, live, liveText];
    }
    if (!trip.demo && !this.wakeLock.active) {
      return [
        'warn',
        this.wakeLock.supported
          ? 'Keep this screen on and the tab in front so tracking keeps running.'
          : "This browser can't keep the screen on — set your screen timeout to the maximum.",
        live,
        liveText,
      ];
    }
    if (s.approachFired) return ['ok', `${prefix}Alarm done — we'll ring once more when you arrive.`, live, liveText];
    if (s.mode === 'rail') return ['ok', `${prefix}Train mode: straight-line distance to your station. Alarm armed.`, live, liveText];
    return ['ok', `${prefix}Tracking live · alarm armed. Keep this screen open.`, live, liveText];
  }

  private startRinging(trip: Trip, s: TripSnapshot): void {
    void this.alarm.start(trip.settings.sound, trip.settings.vibrate);
    this.fillAlarmText(trip, s);
    // Leave night mode so you see the trip (not a black screen) after "I'm awake".
    if (this.nightMode) this.setNight(false);
    el('alarmOverlay').hidden = false;
    el('snoozeBtn').hidden = s.ringing === 'arrival';
    el('awakeBtn').textContent =
      s.ringing === 'arrival' ? (trip.demo ? 'Finish demo' : "I'm awake — end trip") : "I'm awake";
    el('awakeBtn').focus();
    if (!trip.demo) {
      const arrival = s.ringing === 'arrival';
      void notify(
        arrival ? `🎉 You've arrived at ${trip.destination.name}` : '⏰ Wake up! Your stop is near',
        arrival ? 'Time to get off.' : `${s.remaining !== null ? formatDistance(s.remaining) : 'Almost there'} to ${trip.destination.name}`,
        { tag: 'hx-alarm', urgent: true },
      );
      this.saveTrip(trip);
    }
  }

  private stopRinging(trip: Trip): void {
    this.alarm.stop();
    el('alarmOverlay').hidden = true;
    void clearNotifications('hx-alarm');
    if (!trip.demo) this.saveTrip(trip);
  }

  private fillAlarmText(trip: Trip, s: TripSnapshot): void {
    const name = trip.destination.name;
    const dist = s.remaining !== null ? formatDistance(s.remaining) : 'A short way';
    const eta = s.etaSec !== null ? etaPhrase(s.etaSec) : null;
    let eyebrow = 'Wake up!';
    let title = 'Your stop is coming up';
    let text = `${dist}${eta ? ` · ${eta}` : ''} to ${name}.`;
    if (s.ringing === 'arrival') {
      eyebrow = "You're here!";
      title = "You've arrived";
      text = `${name} — grab your bag, it's time to get off.`;
    } else if (s.ringing === 'gps-lost') {
      title = 'Your stop may be close';
      text = `GPS is weak, so we're waking you early to be safe. About ${dist} to ${name}.`;
    } else if (s.ringing === 'time' && eta) {
      text = `${eta.charAt(0).toUpperCase()}${eta.slice(1)} to ${name} (${dist}).`;
    } else if (s.ringing === 'snooze') {
      eyebrow = 'Snooze is over';
    }
    el('alarmEyebrow').textContent = eyebrow;
    el('alarmTitle').textContent = title;
    el('alarmText').textContent = text;
    el('alarmJoke').textContent = trip.joke;
  }

  private setNight(on: boolean): void {
    this.nightMode = on;
    el('nightOverlay').hidden = !on;
    const trip = this.trip;
    if (trip?.snapshot) {
      if (on) this.renderNight(trip, trip.snapshot);
      else this.renderRideMap(trip, trip.snapshot);
    }
  }

  private renderNight(trip: Trip, s: TripSnapshot): void {
    el('nightValue').textContent = s.remaining !== null ? formatDistance(s.remaining) : '—';
    el('nightLabel').textContent = `to ${trip.destination.name}`;
    el('nightEta').textContent = s.etaSec !== null ? etaPhrase(s.etaSec) : '';
  }

  // ------------------------------------------------------- persistence

  private saveTrip(trip: Trip): void {
    const route = trip.engine.route;
    if (trip.demo || !route) return;
    if (trip.savedRoute !== route) {
      trip.savedRoute = route;
      trip.savedPoints = route.points.map((p) => [+p.lat.toFixed(6), +p.lng.toFixed(6)]);
    }
    const data: SavedTrip = {
      v: 1,
      destination: trip.destination,
      route: {
        points: trip.savedPoints,
        distance: route.distance,
        duration: route.duration,
        kind: route.kind,
        provider: route.provider,
      },
      settings: trip.settings,
      startedAt: trip.startedAt,
      engine: trip.engine.exportState(),
    };
    saveJSON(KEYS.trip, data);
    trip.savedAt = Date.now();
  }

  private checkResume(): void {
    const saved = loadJSON<SavedTrip | null>(KEYS.trip, null);
    const valid =
      !!saved &&
      saved.v === 1 &&
      isPlace(saved.destination) &&
      Array.isArray(saved.route?.points) &&
      saved.route.points.length >= 2 &&
      Date.now() - saved.startedAt < 12 * 3600_000;
    if (!valid) {
      removeKey(KEYS.trip);
      return;
    }
    const bar = el('resumeBar');
    el('resumeName').textContent = saved.destination.name;
    bar.hidden = false;
    el('resumeBtn').addEventListener(
      'click',
      () => {
        bar.hidden = true;
        if (this.trip) return;
        const settings = sanitizeSettings(saved.settings);
        this.alarm.unlock(settings.sound);
        void this.wakeLock.enable();
        this.setDestination(saved.destination, false);
        this.beginLive(saved.destination, { ...saved, settings });
      },
      { once: true },
    );
    el('discardBtn').addEventListener(
      'click',
      () => {
        bar.hidden = true;
        removeKey(KEYS.trip);
      },
      { once: true },
    );
  }

  // ------------------------------------------------ share, install, offline

  private bindShareAndInstall(): void {
    const url = `${location.origin}/`;
    el<HTMLAnchorElement>('whatsappLink').href = `https://wa.me/?text=${encodeURIComponent(`${SHARE_TEXT} ${url}`)}`;
    el('shareBtn').addEventListener('click', () => void this.share(url));
    el('copyLinkBtn').addEventListener('click', () => void this.copyLink(url));

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.installPrompt = e as InstallPromptEvent;
      el('installBtn').hidden = false;
    });
    el('installBtn').addEventListener('click', () => {
      const prompt = this.installPrompt;
      this.installPrompt = null;
      el('installBtn').hidden = true;
      void prompt?.prompt();
    });
    window.addEventListener('appinstalled', () => {
      el('installBtn').hidden = true;
      this.toast('Installed! Open Hibernate Express from your home screen.', 'ok');
    });
  }

  private async share(url: string): Promise<void> {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Hibernate Express', text: SHARE_TEXT, url });
        return;
      } catch (err) {
        if ((err as DOMException).name === 'AbortError') return;
      }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(`${SHARE_TEXT} ${url}`)}`, '_blank', 'noopener');
  }

  private async copyLink(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      this.toast('Link copied — paste it in any chat 👍', 'ok');
    } catch {
      this.toast(url, 'ok', 8000);
    }
  }

  private registerServiceWorker(): void {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'hx-stop-alarm') this.trip?.engine.acknowledge();
    });
    if (import.meta.env.PROD) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => undefined);
      });
    }
  }

  private toast(message: string, tone: 'ok' | 'warn' | 'bad' = 'ok', ms = 3800): void {
    const t = el('toast');
    t.textContent = message;
    t.dataset.tone = tone;
    t.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      t.hidden = true;
    }, ms);
  }
}
