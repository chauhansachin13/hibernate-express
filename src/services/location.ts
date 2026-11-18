import type { Fix } from '../core/fix-filter';

export type LocationErrorCode = 'denied' | 'unavailable' | 'timeout' | 'unsupported' | 'insecure';

export class LocationError extends Error {
  readonly code: LocationErrorCode;

  constructor(code: LocationErrorCode, message: string) {
    super(message);
    this.name = 'LocationError';
    this.code = code;
  }
}

const finite = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Converts a browser position into our Fix. The timestamp is the time we
 * received it: some phones stamp fixes with GPS time, which can be off.
 */
export function toFix(pos: GeolocationPosition): Fix {
  const c = pos.coords;
  return {
    lat: c.latitude,
    lng: c.longitude,
    accuracy: finite(c.accuracy) ?? 50,
    speed: finite(c.speed),
    heading: finite(c.heading),
    timestamp: Date.now(),
  };
}

function fromPositionError(err: GeolocationPositionError): LocationError {
  if (err.code === err.PERMISSION_DENIED) {
    return new LocationError('denied', 'Location access is blocked for this site.');
  }
  if (err.code === err.TIMEOUT) return new LocationError('timeout', 'Still waiting for a GPS fix…');
  return new LocationError('unavailable', 'GPS position is unavailable right now.');
}

function preflight(): LocationError | null {
  if (!window.isSecureContext) {
    return new LocationError('insecure', 'Location only works on a secure (https) connection.');
  }
  if (!('geolocation' in navigator)) {
    return new LocationError('unsupported', "This browser can't share your location.");
  }
  return null;
}

/** One position, e.g. for "show my location". */
export function getCurrentFix(timeoutMs = 20_000): Promise<Fix> {
  return new Promise((resolve, reject) => {
    const problem = preflight();
    if (problem) {
      reject(problem);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(toFix(pos)),
      (err) => reject(fromPositionError(err)),
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: timeoutMs },
    );
  });
}

/** Continuous high-accuracy GPS with automatic restarts when a watch goes quiet. */
export class LocationWatcher {
  private watchId: number | null = null;
  private restartTimer: number | null = null;
  private lastFixAt = 0;

  start(onFix: (fix: Fix) => void, onError: (err: LocationError) => void): void {
    this.stop();
    const problem = preflight();
    if (problem) {
      onError(problem);
      return;
    }
    const watch = () => {
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => {
          this.lastFixAt = Date.now();
          onFix(toFix(pos));
        },
        (err) => {
          const e = fromPositionError(err);
          if (e.code === 'denied') this.stop();
          onError(e);
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
      );
    };
    this.lastFixAt = Date.now();
    watch();
    // Some browsers silently stop delivering positions after errors or when
    // the screen was off for a while. Restart the watch if it goes quiet.
    this.restartTimer = window.setInterval(() => {
      if (this.watchId !== null && Date.now() - this.lastFixAt > 45_000) {
        navigator.geolocation.clearWatch(this.watchId);
        this.lastFixAt = Date.now();
        watch();
      }
    }, 15_000);
  }

  stop(): void {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    if (this.restartTimer !== null) window.clearInterval(this.restartTimer);
    this.restartTimer = null;
  }
}
