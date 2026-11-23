import { api, ApiError, type AlarmReason, type Place, type RoutePreview, type Snapshot, type TravelMode } from './api';
import type { Fix } from './core/fix';
import {
  formatAgo,
  formatClock,
  formatCoord,
  formatDistance,
  formatDuration,
  formatSpeed,
  splitDistance,
} from './core/format';
import { clamp, haversine, isValidLatLng, type LatLng } from './core/geo';
import { decodePolyline } from './core/polyline';
import { RoutePath } from './core/route-path';
import { SOUNDS, type SoundId } from './core/sound-synth';
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
import { getCurrentFix, LocationError } from './services/location';
import { enableScreenOffAlarm, isIos, type ScreenOffAlarm } from './services/push';
import { TripClient, type TripState } from './trip-client';
import { confetti, haptic, installRipples, prefersReducedMotion, revealOnScroll, stagger, tweenNumber, typewriter } from './ui/fx';
import { icon, kindIcon } from './ui/icons';
import type { MapStyle } from './ui/map-view';
import { SmartMap } from './ui/smart-map';
import { googlePlaces, type PlacesProvider } from './services/google';
import { SearchBox } from './ui/search-box';
import { BottomSheet, type Snap } from './ui/sheet';

interface Settings {
  mode: TravelMode;
  distanceM: number;
  timeMin: number;
  sound: SoundId;
  vibrate: boolean;
}

/** What survives a page reload: the server keeps the trip itself. */
interface SavedTrip {
  v: 2;
  tripId: string;
  destination: Place;
  settings: Settings;
  startedAt: number;
}

interface ActiveTrip {
  client: TripClient | null;
  destination: Place;
  settings: Settings;
  demo: boolean;
  startedAt: number;
  state: TripState | null;
  ringing: AlarmReason | null;
  celebrated: boolean;
  bgNotified: boolean;
  batteryWarned?: boolean;
  joke: string;
}

interface Preview {
  route: RoutePreview;
  points: LatLng[];
  path: RoutePath;
  from: LatLng;
  at: number;
  key: string;
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

type Tone = 'ok' | 'warn' | 'info';

const DISTANCES = [500, 1000, 2000, 3000, 5000, 10_000];
const TIMES = [0, 5, 10, 15, 20, 30];
const DEFAULT_SETTINGS: Settings = { mode: 'road', distanceM: 2000, timeMin: 10, sound: 'classic', vibrate: true };
/** Buses run slower than the cars routing engines model (the Java engine uses the same factor). */
const BUS_FACTOR = 0.85;
const BASE_TITLE = document.title;
const TAGLINE = 'Even Kumbhakaran won’t miss his stop now 😴';
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
const alarmRule = (s: Settings) => `🔔 at ${formatDistance(s.distanceM)}${s.timeMin > 0 ? ` or ${s.timeMin} min` : ''}`;

/** Restarts a one-shot CSS animation class. */
function replay(node: HTMLElement, className: string): void {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

function setRadio(group: HTMLElement, value: string): void {
  group.dataset.value = value;
  for (const b of group.querySelectorAll<HTMLButtonElement>('[role="radio"]')) {
    const on = b.dataset.value === value;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

function bindRadio(group: HTMLElement, onChange: (value: string) => void): void {
  group.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[role="radio"]');
    if (!b?.dataset.value || b.getAttribute('aria-checked') === 'true') return;
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
  private preview: Preview | null = null;
  private previewState: 'idle' | 'loading' | 'error' = 'idle';
  private previewError = '';
  private previewCtrl: AbortController | null = null;
  private reverseCtrl: AbortController | null = null;
  private trip: ActiveTrip | null = null;
  private starting: 'live' | 'demo' | null = null;
  private nightMode = false;
  private installPrompt: InstallPromptEvent | null = null;
  private toastTimer = 0;
  /** The notification permission question asked when a trip starts. */
  private notifyAsk: Promise<unknown> = Promise.resolve();
  /** Whether the alarm reaches this phone with the screen off (push from the server). */
  private screenOff: ScreenOffAlarm | null = null;
  /** Battery, where the browser tells (Android Chrome): a flat phone rings no alarm. */
  private battery: { level: number; charging: boolean } | null = null;
  private renderedDestKey = '';
  private searchFocused = false;
  private searchPanelOpen = false;
  private readonly alarm = new AlarmPlayer();
  private readonly wakeLock = new ScreenWakeLock();
  private readonly app = el('app');
  private readonly sheetBody = el('sheetBody');
  private readonly sheet: BottomSheet;
  private readonly map: SmartMap;
  private search!: SearchBox;
  /** Google's place search, once Google's map is up (when a Google key is configured). */
  private places: PlacesProvider | null = null;

  constructor() {
    this.sheet = new BottomSheet(el('sheet'), el('sheetHandle'), this.sheetBody, this.app, {
      peek: () => this.peekHeight(),
      onChange: (snap) => this.onSnap(snap),
    });
    const style: MapStyle = loadJSON<MapStyle>(KEYS.mapStyle, 'dark') === 'light' ? 'light' : 'dark';
    this.map = new SmartMap(el('map'), style, () => this.sheet.visibleHeight);
    void this.map.google().then((g) => {
      if (g) this.places = googlePlaces(g);
    });
  }

  start(): void {
    void api.wake(); // free hosting sleeps when idle: start waking the server before the first search
    removeKey('hx.trip.v1'); // trips saved by the old in-browser engine can't be resumed
    // Browsers without overflow: clip can still scroll the app shell when an input gets focus.
    this.app.addEventListener('scroll', () => {
      if (this.app.scrollTop || this.app.scrollLeft) this.app.scrollTo(0, 0);
    });
    installRipples(this.app);
    this.bindPlanner();
    this.bindRide();
    this.bindAbout();
    this.bindShareAndInstall();
    this.registerServiceWorker();
    this.renderSettings();
    this.renderDestination();
    this.renderRecents();
    this.updatePlanState();
    const introShown = this.showIntroIfFirstVisit();
    if (!introShown) window.setTimeout(() => this.revealSheet(), 180);
    this.checkResume();
    void this.autoLocate();
    this.takeSharedPlace();
    this.watchBattery();
  }

  private watchBattery(): void {
    type Battery = EventTarget & { level: number; charging: boolean };
    const nav = navigator as Navigator & { getBattery?: () => Promise<Battery> };
    nav
      .getBattery?.()
      .then((b) => {
        const update = () => {
          this.battery = { level: b.level, charging: b.charging };
          this.renderChecks();
          const trip = this.trip;
          if (trip && !trip.demo && !b.charging && b.level < 0.2 && !trip.batteryWarned) {
            trip.batteryWarned = true;
            this.toast(`🔋 Battery at ${Math.round(b.level * 100)}% — plug in so the alarm can still ring at your stop.`, 'warn', 8000);
          }
        };
        update();
        b.addEventListener('levelchange', update);
        b.addEventListener('chargingchange', update);
      })
      .catch(() => undefined);
  }

  /** Live checks on the ride screen: battery and whether the screen is being kept on. */
  private renderChecks(): void {
    const b = this.battery;
    const battery = el('tipBattery');
    const low = b !== null && !b.charging && b.level < 0.2;
    battery.dataset.state = b === null ? '' : low ? 'warn' : 'ok';
    battery.querySelector('span')!.textContent =
      b === null
        ? 'Charger on long rides'
        : b.charging
          ? `Charging · ${Math.round(b.level * 100)}%`
          : low
            ? `Battery ${Math.round(b.level * 100)}% · plug in!`
            : `Battery ${Math.round(b.level * 100)}%`;
    const screen = el('tipScreen');
    const awake = this.wakeLock.active;
    screen.dataset.state = awake ? 'ok' : '';
    screen.querySelector('span')!.textContent = awake ? 'Screen kept on' : 'Night mode saves battery';
  }

  /** A place shared from Google Maps (Share → Hibernate Express) arrives as ?title=&text=&url=. */
  private takeSharedPlace(): void {
    const p = new URLSearchParams(location.search);
    const shared = ['url', 'text', 'title']
      .map((k) => p.get(k) ?? '')
      .filter(Boolean)
      .join(' ')
      .trim();
    if (!shared) return;
    history.replaceState(null, '', location.pathname);
    this.search.searchFor(shared);
  }

  // ------------------------------------------------------------------ sheet

  /** The collapsed sheet shows the stop card in the planner, and the countdown during a ride. */
  private peekHeight(): number {
    const sheetTop = el('sheet').getBoundingClientRect().top;
    const scroll = this.sheetBody.scrollTop;
    if (this.trip) {
      const meta = el('ridePane').querySelector<HTMLElement>('.track-meta');
      const bottom = meta ? meta.getBoundingClientRect().bottom + scroll : sheetTop + 250;
      return bottom - sheetTop + 18 + this.safeBottom();
    }
    const card = el('destCard').getBoundingClientRect().bottom + scroll;
    return card - sheetTop + 14 + el('planCta').offsetHeight;
  }

  private safeBottom(): number {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;height:var(--safe-bottom)';
    this.app.append(probe);
    const h = probe.offsetHeight;
    probe.remove();
    return h;
  }

  private revealSheet(): void {
    this.sheet.setSnap(this.destination || this.hasRecents() ? 'half' : 'peek');
  }

  private onSnap(snap: Snap): void {
    const fix = this.trip?.state?.snapshot.fix;
    if (this.trip && fix && snap !== 'full') this.map.track(fix, this.trip.destination);
  }

  // ---------------------------------------------------------------- planner

  private bindPlanner(): void {
    const input = el<HTMLInputElement>('searchInput');
    this.search = new SearchBox({
      input,
      panel: el('searchPanel'),
      list: el('searchList'),
      status: el('searchStatus'),
      clear: el<HTMLButtonElement>('searchClear'),
      getBias: () => (this.userFix ? { lat: this.userFix.lat, lng: this.userFix.lng, zoom: 12 } : this.map.bias()),
      getUser: () => this.userFix,
      getRecents: () => loadJSON<unknown[]>(KEYS.recents, []).filter(isPlace),
      getPlaces: () => this.places,
      // Coordinates, links and plus codes become a pin that's then named from the map.
      onSelect: (place) => (place.kind === 'pin' ? this.dropPin(place, true) : this.setDestination(place, true)),
      onOpenChange: (open) => {
        this.searchPanelOpen = open;
        this.updateSearchMode();
      },
    });
    input.addEventListener('focus', () => {
      this.searchFocused = true;
      this.updateSearchMode();
    });
    input.addEventListener('blur', () => {
      this.searchFocused = false;
      window.setTimeout(() => this.updateSearchMode(), 120);
    });

    this.map.onTap((p) => {
      if (this.trip) return;
      if (this.app.classList.contains('search-open')) {
        input.blur();
        return;
      }
      this.dropPin(p, false);
    });
    el('locateBtn').addEventListener('click', () => void this.locate(true, false));
    el('styleBtn').addEventListener('click', () => {
      const next: MapStyle = this.map.style === 'dark' ? 'light' : 'dark';
      this.map.setStyle(next);
      saveJSON(KEYS.mapStyle, next);
      replay(el('styleBtn'), 'flip');
    });

    el<HTMLFormElement>('manualForm').addEventListener('submit', (e) => {
      e.preventDefault();
      void this.applyManualCoordinates();
    });

    bindRadio(el('modeGroup'), (value) => {
      this.settings.mode = value === 'rail' ? 'rail' : 'road';
      if (this.settings.mode === 'rail') this.map.setPreviewRoute(null);
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
    const test = el('testSoundBtn');
    test.addEventListener('click', () => {
      test.classList.add('playing');
      void this.alarm.preview(this.settings.sound, this.settings.vibrate);
      window.setTimeout(() => test.classList.remove('playing'), 2600);
    });
    el<HTMLInputElement>('vibrateToggle').addEventListener('change', (e) => {
      this.settings.vibrate = (e.target as HTMLInputElement).checked;
      if (this.settings.vibrate) haptic(40);
      this.saveSettings();
    });

    el('startBtn').addEventListener('click', () => this.startTrip(false));
    el('demoBtn').addEventListener('click', () => this.startTrip(true));
  }

  /** While searching, the sheet slides away so the keyboard and results have room. */
  private updateSearchMode(): void {
    const open = !this.trip && (this.searchFocused || this.searchPanelOpen);
    if (open === this.app.classList.contains('search-open')) return;
    this.app.classList.toggle('search-open', open);
    this.sheet.setHidden(open);
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
    this.updateAlarmPreview();
  }

  /** The bell on the planned road showing where the alarm will ring (slides when the distance changes). */
  private updateAlarmPreview(): void {
    const dest = this.destination;
    const p = this.preview;
    const show = !this.trip && !!dest && !!p && p.key === placeKey(dest) && this.settings.mode === 'road';
    this.map.setAlarmPreview(show ? p.path : null, this.settings.distanceM, `🔔 ${formatDistance(this.settings.distanceM)}`);
  }

  private setDestination(place: Place, fly: boolean): void {
    this.reverseCtrl?.abort();
    this.destination = place;
    this.map.setDestination(place);
    if (this.preview && this.preview.key !== placeKey(place)) {
      this.preview = null;
      this.map.setPreviewRoute(null);
    }
    this.updateAlarmPreview();
    this.renderDestination();
    this.renderRecents();
    this.updatePlanState();
    if (!this.trip && this.sheet.snap === 'peek') this.sheet.setSnap('half');
    if (fly) {
      if (this.userFix) this.map.fit([this.userFix, place]);
      else this.map.focus(place, 15);
    }
    haptic(12);
    void this.refreshPreview();
  }

  private dropPin(p: LatLng, fly: boolean): void {
    const pin: Place = { name: 'Dropped pin', detail: formatCoord(p), lat: p.lat, lng: p.lng, kind: 'pin' };
    this.search.setValue('');
    this.setDestination(pin, fly);
    if (!fly) this.map.ensureVisible(pin);
    const ctrl = new AbortController();
    this.reverseCtrl = ctrl;
    api
      .reverse(p, ctrl.signal)
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
    this.updateAlarmPreview();
    this.search.setValue('');
    this.renderDestination();
    this.renderRecents();
    this.updatePlanState();
    this.sheet.refresh();
  }

  private async applyManualCoordinates(): Promise<void> {
    const input = el<HTMLInputElement>('manualInput');
    const error = el('manualError');
    const text = input.value.trim();
    const fail = (message: string) => {
      error.textContent = message;
      error.hidden = false;
      replay(error, 'field-error');
      input.focus();
    };
    if (!text) {
      fail('Paste coordinates like 17.9833, 79.5308 or a Google Maps link.');
      return;
    }
    try {
      const res = await api.coordinates(text);
      if (!res.ok || res.lat === undefined || res.lng === undefined) {
        fail(res.error ?? "That doesn't look like a location.");
        return;
      }
      error.hidden = true;
      input.value = '';
      input.blur();
      el<HTMLDetailsElement>('manualBox').open = false;
      this.sheet.setSnap('half');
      this.dropPin({ lat: res.lat, lng: res.lng }, true);
    } catch {
      fail("Can't reach the server to read that right now. Check your internet and try again.");
    }
  }

  private async refreshPreview(): Promise<void> {
    const dest = this.destination;
    const fix = this.userFix;
    this.previewCtrl?.abort();
    this.previewCtrl = null;
    if (!dest || !fix || this.settings.mode === 'rail') {
      this.previewState = 'idle';
      this.renderDestination();
      this.updatePlanState();
      return;
    }
    const key = placeKey(dest);
    if (this.preview && this.preview.key === key && haversine(this.preview.from, fix) < 150) {
      if (!this.trip) this.map.setPreviewRoute(this.preview.points);
      this.updateAlarmPreview();
      this.renderDestination();
      this.updatePlanState();
      return;
    }
    const ctrl = new AbortController();
    this.previewCtrl = ctrl;
    const from = { lat: fix.lat, lng: fix.lng };
    this.previewState = 'loading';
    this.renderDestination();
    try {
      const route = await api.route(from, dest, ctrl.signal);
      if (ctrl.signal.aborted || !this.destination || placeKey(this.destination) !== key) return;
      const points = decodePolyline(route.polyline);
      this.preview = { route, points, path: new RoutePath(points), from, at: Date.now(), key };
      this.previewState = 'idle';
      if (!this.trip) {
        this.map.setPreviewRoute(points);
        this.map.fit(points);
        this.updateAlarmPreview();
      }
    } catch (err) {
      if (ctrl.signal.aborted) return;
      this.preview = null;
      this.previewState = 'error';
      this.previewError =
        err instanceof ApiError && err.status === 422
          ? "No road route to this pin — we'll use the straight-line distance."
          : "Couldn't measure the road right now — we'll try again when you start.";
    } finally {
      if (this.previewCtrl === ctrl) this.previewCtrl = null;
      if (!ctrl.signal.aborted) {
        this.renderDestination();
        this.updatePlanState();
      }
    }
  }

  private renderDestination(): void {
    const box = el('destCard');
    const dest = this.destination;
    const key = dest ? `${placeKey(dest)}|${dest.name}|${dest.detail}` : 'empty';
    if (key !== this.renderedDestKey) {
      // Same spot, new name (the reverse lookup arrived): update without the swap animation.
      const quiet = !!dest && this.renderedDestKey.startsWith(`${placeKey(dest)}|`);
      this.renderedDestKey = key;
      box.replaceChildren(this.destTitle(!!dest), this.destBody(dest, quiet));
    }
    const metrics = box.querySelector<HTMLElement>('.dest-metrics');
    if (metrics && dest) this.fillMetrics(metrics, dest);
  }

  private destTitle(done: boolean): HTMLElement {
    const h = document.createElement('h2');
    h.className = 'block-title';
    const dot = document.createElement('span');
    dot.className = done ? 'step-dot done' : 'step-dot';
    if (done) dot.innerHTML = icon('i-check');
    else dot.textContent = '1';
    h.append(dot, 'Your stop');
    return h;
  }

  private destBody(dest: Place | null, quiet: boolean): HTMLElement {
    const body = document.createElement('div');
    body.className = dest ? 'dest-body' : 'dest-body is-empty';
    if (quiet) body.style.animation = 'none';
    const kind = document.createElement('span');
    kind.className = 'kind kind-lg';
    kind.innerHTML = kindIcon(dest?.kind ?? 'pin');
    const info = document.createElement('div');
    info.className = 'dest-info';
    const name = document.createElement('strong');
    const detail = document.createElement('p');
    detail.className = 'detail';
    if (!dest) {
      name.textContent = 'Where are you getting off?';
      detail.textContent = 'Search above, tap the map, or pick a recent stop.';
      info.append(name, detail);
      body.append(kind, info);
      return body;
    }
    name.textContent = dest.name;
    if (quiet) name.animate?.([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], 350);
    const coords = formatCoord(dest);
    detail.textContent = dest.detail && dest.detail !== coords ? `${dest.detail} · ${coords}` : coords;
    const metrics = document.createElement('div');
    metrics.className = 'dest-metrics';
    info.append(name, detail, metrics);
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'dest-clear';
    clear.setAttribute('aria-label', 'Remove this stop');
    clear.innerHTML = icon('i-x');
    clear.addEventListener('click', () => this.clearDestination());
    body.append(kind, info, clear);
    return body;
  }

  /** Road distance and bus time to the stop; re-rendered only when they change. */
  private fillMetrics(target: HTMLElement, dest: Place): void {
    const rail = this.settings.mode === 'rail';
    const sig = rail
      ? `rail|${this.userFix ? Math.round(haversine(this.userFix, dest) / 50) : 'nofix'}`
      : !this.userFix
        ? 'road|nofix'
        : `road|${this.previewState}|${this.preview?.key === placeKey(dest) ? this.preview.route.length : ''}|${this.previewError}`;
    if (target.dataset.sig === sig) return;
    target.dataset.sig = sig;
    target.replaceChildren();

    const metric = (metres: number | null, text: string, rest: string) => {
      const span = document.createElement('span');
      span.className = 'metric';
      const b = document.createElement('b');
      span.append(b, ` ${rest}`);
      target.append(span);
      if (metres === null) b.textContent = text;
      else {
        b.dataset.value = '0';
        tweenNumber(b, metres, (v) => formatDistance(v), 900);
      }
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

    if (rail) {
      if (this.userFix) metric(haversine(this.userFix, dest), '', 'straight line');
      else {
        note('Measured from your live location.');
        locateLink('Measure now');
      }
      return;
    }
    if (!this.userFix) {
      note('Road distance comes from your live location.');
      locateLink('Measure now');
      return;
    }
    if (this.previewState === 'loading') {
      const loading = document.createElement('span');
      loading.className = 'metric-loading';
      loading.setAttribute('aria-label', 'Measuring the road distance');
      target.append(loading);
      return;
    }
    if (this.previewState === 'error') {
      note(this.previewError, true);
      return;
    }
    if (this.preview && this.preview.key === placeKey(dest)) {
      metric(this.preview.route.length, '', 'by road');
      const sec = this.preview.route.duration;
      if (sec !== null) metric(null, `≈ ${formatDuration(sec / BUS_FACTOR)}`, 'by bus');
    }
  }

  private hasRecents(): boolean {
    return loadJSON<unknown[]>(KEYS.recents, []).some(isPlace);
  }

  private renderRecents(): void {
    const list = loadJSON<unknown[]>(KEYS.recents, []).filter(isPlace);
    const box = el('recentsBox');
    const show = list.length > 0 && !this.destination;
    const wasHidden = box.hidden;
    box.hidden = !show;
    if (!show || !wasHidden) return;
    const chips = el('recentChips');
    chips.replaceChildren(
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
        b.addEventListener('click', () => {
          this.search.setValue(place.name);
          this.setDestination(place, true);
        });
        return b;
      }),
    );
    stagger(chips);
  }

  private addRecent(place: Place): void {
    const list = loadJSON<unknown[]>(KEYS.recents, [])
      .filter(isPlace)
      .filter((p) => haversine(p, place) > 50);
    list.unshift({ name: place.name, detail: place.detail, lat: place.lat, lng: place.lng, kind: place.kind });
    saveJSON(KEYS.recents, list.slice(0, 6));
  }

  /** Start button, step dots and the "alarm would ring immediately" warning. */
  private updatePlanState(): void {
    const dest = this.destination;
    const start = el<HTMLButtonElement>('startBtn');
    const wasDisabled = start.disabled;
    start.disabled = !dest || !!this.trip || this.starting !== null;
    if (wasDisabled && !start.disabled) replay(start, 'wake');
    start.classList.toggle('is-loading', this.starting === 'live');
    el('startLabel').textContent =
      this.starting === 'live' ? 'Starting your trip…' : dest ? 'Start trip & wake me up' : 'Pick your stop to start';
    const demo = el<HTMLButtonElement>('demoBtn');
    demo.disabled = this.starting !== null || !!this.trip;
    el('demoLabel').textContent = this.starting === 'demo' ? 'Preparing your demo ride…' : 'Try a 40-second demo ride';

    let warning = '';
    if (dest && this.settings.mode === 'road' && this.preview && this.preview.key === placeKey(dest)) {
      const length = this.preview.route.length;
      const busSec = this.preview.route.duration !== null ? this.preview.route.duration / BUS_FACTOR : null;
      if (length <= this.settings.distanceM) {
        warning = `Your stop is only ${formatDistance(length)} away by road, so the alarm would ring straight away. Pick a smaller distance.`;
      } else if (this.settings.timeMin > 0 && busSec !== null && busSec <= this.settings.timeMin * 60) {
        warning = `Your stop is only about ${formatDuration(busSec)} away, so the time alarm may ring soon after you set off. Pick a shorter time or switch it off.`;
      }
    } else if (dest && this.settings.mode === 'rail' && this.userFix) {
      const d = haversine(this.userFix, dest);
      if (d <= this.settings.distanceM) {
        warning = `Your station is only ${formatDistance(d)} away, so the alarm would ring straight away. Pick a smaller distance.`;
      }
    }
    const warn = el('thresholdWarn');
    if (warn.textContent !== warning) {
      warn.textContent = warning;
      warn.hidden = !warning;
      if (warning) replay(warn, 'notice');
    }
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
      this.updatePlanState();
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
    if (this.trip || this.starting) return;
    if (!demo && !this.destination) {
      this.toast('Pick your stop first — search or tap the map.', 'warn');
      return;
    }
    // These need the user's tap, so they run before anything asynchronous.
    this.alarm.unlock(this.settings.sound);
    void this.wakeLock.enable();
    this.screenOff = null;
    this.renderScreenOffNote();
    if (!demo) this.notifyAsk = requestNotificationPermission();
    haptic([12, 50, 12]);
    this.launch(el(demo ? 'demoBtn' : 'startBtn'));
    void this.beginTrip(demo, null);
  }

  /** A circle of colour grows from the button and a bus drives through: the alarm is set. */
  private launch(from: HTMLElement): void {
    if (prefersReducedMotion()) return;
    const box = el('launch');
    const a = this.app.getBoundingClientRect();
    const b = from.getBoundingClientRect();
    box.style.setProperty('--x', `${b.left + b.width / 2 - a.left}px`);
    box.style.setProperty('--y', `${b.top + b.height / 2 - a.top}px`);
    box.hidden = false;
    replay(box, 'go');
    window.setTimeout(() => {
      box.hidden = true;
      box.classList.remove('go');
    }, 1300);
  }

  private async beginTrip(demo: boolean, saved: SavedTrip | null): Promise<void> {
    const settings = saved ? sanitizeSettings(saved.settings) : { ...this.settings };
    let destination = saved?.destination ?? this.destination;
    if (demo && !destination) {
      this.setDestination(DEMO_PLACE, false);
      destination = DEMO_PLACE;
    }
    if (!destination) return;
    const trip: ActiveTrip = {
      client: null,
      destination,
      settings,
      demo,
      startedAt: saved?.startedAt ?? Date.now(),
      state: null,
      ringing: null,
      celebrated: false,
      bgNotified: false,
      joke: JOKES[Math.floor(Math.random() * JOKES.length)],
    };
    const client = new TripClient({
      destination,
      settings: { mode: settings.mode, distanceM: settings.distanceM, timeMin: settings.timeMin },
      demo,
      origin: this.userFix ? { lat: this.userFix.lat, lng: this.userFix.lng } : null,
      resumeId: saved?.tripId ?? null,
      onState: (state) => this.onState(trip, state),
      onFatal: (message) => {
        if (this.trip !== trip) return;
        this.endTrip(message, 'bad');
      },
      onTripId: (tripId) => {
        if (demo || this.trip !== trip) return;
        const data: SavedTrip = { v: 2, tripId, destination, settings, startedAt: trip.startedAt };
        saveJSON(KEYS.trip, data);
        void this.armScreenOffAlarm(tripId, trip);
      },
    });
    trip.client = client;
    this.trip = trip;
    if (!demo) {
      // Saved straight away (the server id follows) so a reload can resume even a phone-only trip.
      const data: SavedTrip = { v: 2, tripId: saved?.tripId ?? '', destination, settings, startedAt: trip.startedAt };
      saveJSON(KEYS.trip, data);
    }
    this.starting = demo ? 'demo' : 'live';
    this.updatePlanState();
    this.enterRide(trip);
    try {
      await client.start();
    } catch (err) {
      if (this.trip !== trip) return;
      this.trip = null;
      this.starting = null;
      client.stop();
      void this.wakeLock.disable();
      this.leaveRide();
      this.updatePlanState();
      const message =
        err instanceof ApiError && err.status > 0
          ? `Couldn't start the trip: ${err.message}`
          : "Can't reach the Hibernate Express server. Check your internet and try again.";
      this.toast(message, 'bad', 7000);
      return;
    }
    this.starting = null;
    this.updatePlanState();
    if (this.trip !== trip) return;
    if (!demo && !saved) this.addRecent(destination);
    if (client.phoneOnly) this.toast('No connection — your phone is tracking on its own. The alarm still works.', 'warn', 6500);
  }

  private enterRide(trip: ActiveTrip): void {
    this.app.classList.add('is-riding');
    this.app.classList.remove('search-open');
    el('planPane').hidden = true;
    el('ridePane').hidden = false;
    this.map.setPreviewRoute(null);
    this.map.setAlarmPreview(null, 0, '');
    this.map.setFollowing(true);
    el('rideEyebrow').textContent = trip.demo ? 'Demo ride to' : 'Heading to';
    el('rideDestName').textContent = trip.destination.name;
    el('alarmRule').textContent = alarmRule(trip.settings);
    const value = el('remainValue');
    delete value.dataset.value;
    value.textContent = '—';
    el('remainUnit').textContent = '';
    el('remainLabel').textContent = trip.demo ? 'setting up the simulated bus…' : 'starting your trip…';
    el('etaValue').textContent = '—';
    el('etaLabel').textContent = 'estimated arrival';
    el('trackFill').style.width = '0%';
    el('trackBus').style.left = '0%';
    el('trackBell').hidden = true;
    el('progressText').textContent = '0% of the way';
    for (const id of ['statSpeed', 'statGps', 'statUpdated']) el(id).textContent = '—';
    this.setStatus('info', trip.demo ? 'Preparing a simulated bus ride on real roads…' : 'Starting your trip…', 'locating', 'START');
    requestAnimationFrame(() => {
      this.sheet.setSnap('half');
      this.map.fit(this.userFix ? [this.userFix, trip.destination] : [trip.destination]);
    });
  }

  private leaveRide(): void {
    this.app.classList.remove('is-riding', 'ringing');
    el('ridePane').hidden = true;
    el('planPane').hidden = false;
    el('followBtn').hidden = true;
    this.map.setTripRoute(null, 0, null);
    this.map.setUser(this.userFix);
    requestAnimationFrame(() => {
      this.sheet.setSnap(this.destination ? 'half' : 'peek');
      if (this.preview && this.destination && this.preview.key === placeKey(this.destination)) {
        this.map.setPreviewRoute(this.preview.points);
      }
      this.updateAlarmPreview();
      if (this.destination) this.map.fit(this.userFix ? [this.userFix, this.destination] : [this.destination]);
    });
  }

  private endTrip(message?: string, tone: 'ok' | 'warn' | 'bad' = 'ok'): void {
    const trip = this.trip;
    if (!trip) return;
    this.trip = null;
    this.starting = null;
    trip.client?.stop();
    this.alarm.stop();
    el('alarmOverlay').hidden = true;
    this.setNight(false);
    void this.wakeLock.disable();
    void clearNotifications('hx-alarm');
    void clearNotifications('hx-bg');
    if (!trip.demo) removeKey(KEYS.trip);
    this.leaveRide();
    this.renderDestination();
    this.renderRecents();
    this.updatePlanState();
    // You've probably moved during the trip: measure the road distance again.
    if (!trip.demo) void this.refreshPreview();
    document.title = BASE_TITLE;
    if (message) this.toast(message, tone, 5500);
  }

  // ------------------------------------------------------------------- ride

  private bindRide(): void {
    el('nightBtn').addEventListener('click', () => this.setNight(true));
    el('nightExit').addEventListener('click', () => this.setNight(false));
    el('followBtn').addEventListener('click', () => {
      this.map.setFollowing(true);
      const trip = this.trip;
      const fix = trip?.state?.snapshot.fix;
      if (trip) this.map.fit(fix ? [fix, trip.destination] : [trip.destination]);
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
      trip.client?.acknowledge();
      if (reason === 'arrival') {
        if (!trip.celebrated) this.celebrate(trip);
        this.endTrip(
          trip.demo
            ? 'Demo complete — that is exactly how it wakes you on a real ride. 🎉'
            : "You've arrived. Trip ended — have a great day! 🎉",
        );
      }
    });
    el('snoozeBtn').addEventListener('click', () => {
      this.trip?.client?.snooze();
      this.toast('Snoozed for 2 minutes 😴', 'ok', 3000);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.nightMode) this.setNight(false);
    });
    document.addEventListener('visibilitychange', () => {
      const trip = this.trip;
      if (!trip) return;
      if (document.visibilityState === 'hidden') {
        if (!trip.demo && !trip.bgNotified) {
          trip.bgNotified = true;
          const body =
            this.screenOff === 'on'
              ? "Screen off is fine — if your phone pauses this page, the server will ring your stop as a notification."
              : 'Keep this tab open so we can wake you before your stop.';
          void notify('Hibernate Express is still tracking', body, { tag: 'hx-bg' });
        }
      } else {
        void clearNotifications('hx-bg');
      }
    });
    window.addEventListener('beforeunload', (e) => {
      if (this.trip && !this.trip.demo) e.preventDefault();
    });
    this.wakeLock.onChange(() => {
      const trip = this.trip;
      if (trip?.state) this.renderRide(trip, trip.state);
    });
  }

  private onState(trip: ActiveTrip, state: TripState): void {
    if (this.trip !== trip) return;
    trip.state = state;
    this.renderRide(trip, state);
    if (state.ringing !== trip.ringing) {
      const was = trip.ringing;
      trip.ringing = state.ringing;
      if (state.ringing) this.startRinging(trip, state);
      else if (was) this.stopRinging(trip);
    } else if (state.ringing) {
      this.fillAlarmText(trip, state);
    }
    if (state.snapshot.phase === 'arrived' && !trip.celebrated) this.celebrate(trip);
  }

  private renderRide(trip: ActiveTrip, state: TripState): void {
    const s = state.snapshot;
    this.renderChecks();

    const value = el('remainValue');
    const unit = el('remainUnit');
    if (s.remaining === null) {
      delete value.dataset.value;
      value.textContent = '—';
      unit.textContent = '';
    } else {
      const approx = s.remainingIsEstimate || state.offline;
      tweenNumber(
        value,
        s.remaining,
        (v) => {
          const d = splitDistance(v);
          unit.textContent = d.unit;
          return `${approx ? '~' : ''}${d.value}`;
        },
        trip.demo ? 480 : 900,
      );
    }
    el('remainLabel').textContent = this.remainingLabel(s, state.offline);

    let etaText: string;
    let etaLabel: string;
    if (s.phase === 'arrived') {
      etaText = 'Here!';
      etaLabel = 'you have arrived';
    } else if (s.remaining === null) {
      etaText = '—';
      etaLabel = 'estimated arrival';
    } else if (s.etaSec === null) {
      etaText = s.phase === 'tracking' ? 'Stopped' : '—';
      etaLabel = s.phase === 'tracking' ? 'waiting to move' : 'estimated arrival';
    } else {
      etaText = formatDuration(s.etaSec);
      etaLabel = trip.demo ? 'left · simulated time' : `arrive ≈ ${formatClock(Date.now() + s.etaSec * 1000)}`;
    }
    const eta = el('etaValue');
    if (eta.textContent !== etaText) {
      eta.textContent = etaText;
      replay(eta, 'bump');
    }
    el('etaLabel').textContent = etaLabel;

    const progress = s.phase === 'arrived' ? 1 : clamp(s.progress, 0, 1);
    const pct = Math.round(progress * 1000) / 10;
    el('trackFill').style.width = `${pct}%`;
    el('trackBus').style.left = `${pct}%`;
    el('track').setAttribute('aria-valuenow', String(Math.round(pct)));
    el('progressText').textContent = s.phase === 'arrived' ? 'Arrived 🎉' : `${Math.round(pct)}% of the way`;
    const bell = el('trackBell');
    const ap = s.alarmProgress;
    const showBell = ap !== null && ap > 0.02 && ap < 0.99;
    bell.hidden = !showBell;
    if (showBell) {
      bell.style.left = `${ap * 100}%`;
      bell.classList.toggle('rang', s.approachFired);
      bell.classList.toggle('near', !s.approachFired && progress > ap - 0.15);
    }

    const speed = el('statSpeed');
    if (s.speedMps === null) {
      delete speed.dataset.value;
      speed.textContent = formatSpeed(null);
    } else {
      tweenNumber(speed, Math.max(0, s.speedMps) * 3.6, (v) => `${Math.round(v)} km/h`, 700);
    }
    el('statGps').textContent = s.fix ? `±${Math.round(s.fix.accuracy)} m` : '—';
    el('statUpdated').textContent = state.offline ? 'offline' : formatAgo(s.lastFixAgeMs);

    const [tone, text, pill, pillText] = this.statusFor(trip, state);
    this.setStatus(tone, text, pill, pillText);

    document.title = s.remaining !== null ? `${formatDistance(s.remaining)} to go · Hibernate Express` : BASE_TITLE;
    if (this.nightMode) this.renderNight(trip, state);
    else this.renderRideMap(trip, state);
  }

  private setStatus(tone: Tone, text: string, pill: string, pillText: string): void {
    const status = el('rideStatus');
    if (status.textContent !== text) {
      status.textContent = text;
      replay(status, 'changed');
    }
    if (status.dataset.tone !== tone) status.dataset.tone = tone;
    const pillEl = el('livePill');
    if (pillEl.dataset.state !== pill) pillEl.dataset.state = pill;
    const pillLabel = el('livePillText');
    if (pillLabel.textContent !== pillText) pillLabel.textContent = pillText;
  }

  private renderRideMap(trip: ActiveTrip, state: TripState): void {
    const s = state.snapshot;
    if (state.route) {
      const length = state.route.length;
      const alarmAlong = length > trip.settings.distanceM ? length - trip.settings.distanceM : null;
      this.map.setTripRoute(state.route, s.along ?? 0, alarmAlong);
    }
    this.map.setAlarmNear(!s.approachFired && s.remaining !== null && s.remaining <= trip.settings.distanceM * 1.6);
    // The bus glides between updates instead of jumping.
    this.map.setUser(s.fix, trip.demo ? 480 : 950);
    if (s.fix) this.map.track(s.fix, trip.destination);
  }

  private remainingLabel(s: Snapshot, offline: boolean): string {
    if (s.phase === 'locating') return 'getting your location…';
    if (s.phase === 'routing') return 'finding the road route…';
    if (s.phase === 'arrived') return 'you made it';
    if (offline) return s.routeProvider === 'phone' ? 'straight-line distance · no internet yet' : 'estimated on your phone — no internet';
    if (s.gpsLost) return 'estimated — GPS signal lost';
    if (s.routeKind === 'direct') return s.mode === 'rail' ? 'straight-line distance left' : 'straight-line distance (approx.)';
    if (!s.onRoute) return 'estimated — away from the planned road';
    return 'road distance left';
  }

  private statusFor(trip: ActiveTrip, state: TripState): [Tone, string, string, string] {
    const s = state.snapshot;
    const live = trip.demo ? 'demo' : 'live';
    const liveText = trip.demo ? 'DEMO' : 'LIVE';
    const prefix = trip.demo ? `Demo · simulated GPS at ${Math.round(s.timeScale)}× speed. ` : '';
    if (s.phase === 'arrived') return ['ok', `You've arrived at ${trip.destination.name}! 🎉`, 'done', 'ARRIVED'];
    if (state.offline) {
      return s.routeProvider === 'phone'
        ? ['warn', 'No internet yet — your phone is tracking with GPS on its own, so the alarm still works (it may ring a little early).', 'offline', 'PHONE GPS']
        : ['warn', "No internet — your phone is estimating on its own, so the alarm still works. We'll reconnect automatically.", 'offline', 'OFFLINE'];
    }
    if (s.phase === 'locating') return ['info', `${prefix}Getting your GPS location… allow location access if asked.`, 'locating', 'GPS'];
    if (s.phase === 'routing') return ['info', `${prefix}Finding the road route to your stop…`, 'locating', 'ROUTE'];
    if (s.gpsLost) {
      return ['warn', `${prefix}GPS signal lost (last fix ${formatAgo(s.lastFixAgeMs)}). Estimating from your bus's pace — the alarm still works.`, 'warn', 'NO GPS'];
    }
    if (s.rerouting) return ['warn', `${prefix}Your bus took a different road — recalculating the route…`, 'warn', 'REROUTE'];
    if (!s.onRoute) return ['warn', `${prefix}You're away from the planned road — checking…`, 'warn', 'OFF ROUTE'];
    if (s.snoozeLeftMs !== null) {
      return ['info', `${prefix}Snoozed — ringing again in ${formatDuration(s.snoozeLeftMs / 1000)}.`, live, liveText];
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
    return ['ok', `${prefix}Tracking live on the road · alarm armed. Sleep well 😴`, live, liveText];
  }

  private startRinging(trip: ActiveTrip, state: TripState): void {
    void this.alarm.start(trip.settings.sound, trip.settings.vibrate);
    // A modal "End this trip?" would sit on top of the alarm and block its buttons.
    const dialog = el<HTMLDialogElement>('endDialog');
    if (dialog.open) dialog.close('cancel');
    this.fillAlarmText(trip, state);
    // Leave night mode so you see the trip (not a black screen) after "I'm awake".
    if (this.nightMode) this.setNight(false);
    el('alarmOverlay').hidden = false;
    replay(this.app, 'ringing');
    const arrival = state.ringing === 'arrival';
    el('snoozeBtn').hidden = arrival;
    el('awakeBtn').textContent = arrival ? (trip.demo ? 'Finish demo 🎉' : "I'm awake — end trip") : "I'm awake";
    el('awakeBtn').focus();
    if (!trip.demo) {
      const s = state.snapshot;
      void notify(
        arrival ? `🎉 You've arrived at ${trip.destination.name}` : '⏰ Wake up! Your stop is near',
        arrival ? 'Time to get off.' : `${s.remaining !== null ? formatDistance(s.remaining) : 'Almost there'} to ${trip.destination.name}`,
        { tag: 'hx-alarm', urgent: true },
      );
    }
  }

  private stopRinging(trip: ActiveTrip): void {
    this.alarm.stop();
    el('alarmOverlay').hidden = true;
    this.app.classList.remove('ringing');
    if (!trip.demo) void clearNotifications('hx-alarm');
  }

  private fillAlarmText(trip: ActiveTrip, state: TripState): void {
    const s = state.snapshot;
    const name = trip.destination.name;
    const dist = s.remaining !== null ? formatDistance(s.remaining) : 'A short way';
    const eta = s.etaSec !== null ? etaPhrase(s.etaSec) : null;
    let eyebrow = 'Wake up!';
    let title = 'Your stop is coming up';
    let text = `${dist}${eta ? ` · ${eta}` : ''} to ${name}.`;
    if (state.ringing === 'arrival') {
      eyebrow = "You're here!";
      title = "You've arrived";
      text = `${name} — grab your bag, it's time to get off.`;
    } else if (state.ringing === 'gps-lost') {
      title = 'Your stop may be close';
      text = `GPS is weak, so we're waking you early to be safe. About ${dist} to ${name}.`;
    } else if (state.ringing === 'time' && eta) {
      text = `${eta.charAt(0).toUpperCase()}${eta.slice(1)} to ${name} (${dist}).`;
    } else if (state.ringing === 'snooze') {
      eyebrow = 'Snooze is over';
    }
    el('alarmEyebrow').textContent = eyebrow;
    el('alarmTitle').textContent = title;
    el('alarmText').textContent = text;
    el('alarmJoke').textContent = trip.joke;
  }

  private celebrate(trip: ActiveTrip): void {
    trip.celebrated = true;
    confetti(el<HTMLCanvasElement>('confetti'));
    haptic([30, 60, 30, 60, 120]);
  }

  private setNight(on: boolean): void {
    this.nightMode = on;
    el('nightOverlay').hidden = !on;
    const trip = this.trip;
    if (trip?.state) {
      if (on) this.renderNight(trip, trip.state);
      else this.renderRideMap(trip, trip.state);
    }
  }

  private renderNight(trip: ActiveTrip, state: TripState): void {
    const s = state.snapshot;
    el('nightValue').textContent = s.remaining !== null ? formatDistance(s.remaining) : '—';
    el('nightLabel').textContent = `to ${trip.destination.name}`;
    el('nightEta').textContent = s.etaSec !== null ? etaPhrase(s.etaSec) : '';
  }

  // --------------------------------------------------------------- resume

  private checkResume(): void {
    const saved = loadJSON<SavedTrip | null>(KEYS.trip, null);
    const valid =
      !!saved &&
      saved.v === 2 &&
      typeof saved.tripId === 'string' &&
      isPlace(saved.destination) &&
      typeof saved.startedAt === 'number' &&
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
        void this.beginTrip(false, { ...saved, settings });
      },
      { once: true },
    );
    el('discardBtn').addEventListener(
      'click',
      () => {
        bar.hidden = true;
        removeKey(KEYS.trip);
        void api.endTrip(saved.tripId).catch(() => undefined);
      },
      { once: true },
    );
  }

  // ------------------------------------------------------------ intro, about

  private showIntroIfFirstVisit(): boolean {
    if (loadJSON<boolean>(KEYS.intro, false)) return false;
    const intro = el('intro');
    intro.hidden = false;
    const tagline = el('introTagline');
    window.setTimeout(() => void typewriter(tagline, TAGLINE, 28), prefersReducedMotion() ? 0 : 1300);
    el('introGo').addEventListener(
      'click',
      () => {
        saveJSON(KEYS.intro, true);
        haptic(15);
        intro.classList.add('leaving');
        window.setTimeout(
          () => {
            intro.hidden = true;
            intro.classList.remove('leaving');
            this.revealSheet();
          },
          prefersReducedMotion() ? 0 : 620,
        );
      },
      { once: true },
    );
    return true;
  }

  private bindAbout(): void {
    const about = el('about');
    // The same sleepy-bus scene as the intro, with its own gradient ids.
    el('aboutArt').innerHTML = el('sceneSvg')
      .outerHTML.replace(/hx(Bus|Beam|Glow|Moon)/g, 'ab$1')
      .replace('id="sceneSvg"', 'id="aboutScene"');
    let revealed = false;
    let closeTimer = 0;
    const open = () => {
      if (!about.hidden && !about.classList.contains('leaving')) return;
      window.clearTimeout(closeTimer);
      about.classList.remove('leaving');
      about.hidden = false;
      this.app.classList.add('about-open');
      el('aboutBody').scrollTop = 0;
      if (!revealed) {
        revealed = true;
        revealOnScroll(el('aboutBody'));
      }
      history.pushState({ hxAbout: true }, '');
    };
    const close = (fromHistory: boolean) => {
      if (about.hidden || about.classList.contains('leaving')) return;
      about.classList.add('leaving');
      this.app.classList.remove('about-open');
      closeTimer = window.setTimeout(
        () => {
          about.hidden = true;
          about.classList.remove('leaving');
        },
        prefersReducedMotion() ? 0 : 360,
      );
      if (!fromHistory && (history.state as { hxAbout?: boolean } | null)?.hxAbout) history.back();
    };
    el('aboutBtn').addEventListener('click', open);
    el('aboutBack').addEventListener('click', () => close(false));
    window.addEventListener('popstate', () => close(true));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close(false);
    });
  }

  // ------------------------------------------------ share, install, offline

  private bindShareAndInstall(): void {
    const url = `${location.origin}/`;
    el<HTMLAnchorElement>('whatsappLink').href = `https://wa.me/?text=${encodeURIComponent(`${SHARE_TEXT} ${url}`)}`;
    el('shareBtn').addEventListener('click', () => void this.share(url));
    el('copyLinkBtn').addEventListener('click', () => void this.copyLink(url));
    el('toast').addEventListener('click', () => this.hideToast());

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

  /** Signs the trip up for push, so the alarm still arrives if the phone pauses this page. */
  private async armScreenOffAlarm(tripId: string, trip: ActiveTrip): Promise<void> {
    await this.notifyAsk.catch(() => undefined);
    const state = await enableScreenOffAlarm(tripId);
    if (this.trip !== trip) return;
    this.screenOff = state;
    this.renderScreenOffNote();
  }

  /** Tells the rider whether locking the phone is safe, and what to do if it isn't. */
  private renderScreenOffNote(): void {
    const note = el('screenOffNote');
    const state = this.trip && !this.trip.demo ? this.screenOff : null;
    note.hidden = state === null;
    if (state === null) return;
    note.dataset.state = state;
    const homeScreenApp = (navigator as Navigator & { standalone?: boolean }).standalone === true;
    note.textContent =
      state === 'on'
        ? '🔒 Screen-off alarm on: lock your phone if you like — the alarm arrives as a notification.'
        : state === 'needs-permission'
          ? '🔔 Allow notifications so the alarm reaches you with the screen off. Until then keep the screen on (Night mode).'
          : isIos() && !homeScreenApp
            ? '📱 On iPhone: Share → Add to Home Screen to get the alarm with the screen locked. For now keep the screen on.'
            : '💡 Keep the screen on for the alarm — Night mode saves battery.';
  }

  private registerServiceWorker(): void {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'hx-stop-alarm') this.trip?.client?.acknowledge();
    });
    if (import.meta.env.PROD) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => undefined);
      });
    }
  }

  private toast(message: string, tone: 'ok' | 'warn' | 'bad' = 'ok', ms = 3800): void {
    const t = el('toast');
    el('toastText').textContent = message;
    t.dataset.tone = tone;
    t.style.setProperty('--ms', `${ms}ms`);
    t.classList.remove('out');
    // Restart the slide-in and timer animations.
    t.hidden = true;
    void t.offsetWidth;
    t.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.hideToast(), ms);
  }

  private hideToast(): void {
    const t = el('toast');
    if (t.hidden) return;
    window.clearTimeout(this.toastTimer);
    t.classList.add('out');
    this.toastTimer = window.setTimeout(
      () => {
        t.hidden = true;
        t.classList.remove('out');
      },
      prefersReducedMotion() ? 0 : 300,
    );
  }
}
