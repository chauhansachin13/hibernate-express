import { encodeWav, synthesize, type SoundId } from '../core/sound-synth';

type AudioSessionNavigator = Navigator & { audioSession?: { type: string } };
type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

const VIBRATION = [600, 250, 600, 250, 900];

/**
 * Plays the alarm. Browsers only allow sound after a user gesture, so
 * `unlock()` must run inside the tap on "Start trip"; after that the same
 * audio element may start playing on its own when the alarm fires.
 */
export class AlarmPlayer {
  private readonly audio: HTMLAudioElement;
  private readonly wavs = new Map<SoundId, ArrayBuffer>();
  private readonly urls = new Map<SoundId, string>();
  private ctx: AudioContext | null = null;
  private fallback: AudioBufferSourceNode | null = null;
  private vibrateTimer: number | null = null;
  private previewTimer: number | null = null;
  private playing = false;

  constructor() {
    this.audio = new Audio();
    this.audio.loop = true;
    this.audio.preload = 'auto';
    this.audio.setAttribute('playsinline', '');
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Call synchronously inside a user gesture. */
  unlock(id: SoundId): void {
    try {
      const session = (navigator as AudioSessionNavigator).audioSession;
      if (session) session.type = 'playback'; // iOS: play even with the silent switch on
    } catch {
      // Older browsers: nothing to do.
    }
    this.setSource(id);
    if (!this.playing) {
      this.audio.muted = true;
      const attempt = this.audio.play();
      attempt
        ?.then(() => {
          if (!this.playing) {
            this.audio.pause();
            this.audio.currentTime = 0;
          }
        })
        .catch(() => undefined)
        .finally(() => {
          this.audio.muted = false;
        });
    }
    try {
      const Ctx = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
      if (Ctx && !this.ctx) this.ctx = new Ctx();
      void this.ctx?.resume();
    } catch {
      this.ctx = null;
    }
  }

  async start(id: SoundId, vibrate: boolean): Promise<void> {
    this.clearPreview();
    this.playing = true;
    this.setSource(id);
    this.audio.loop = true;
    this.audio.muted = false;
    this.audio.volume = 1;
    try {
      this.audio.currentTime = 0;
      await this.audio.play();
    } catch {
      await this.playWithWebAudio(id);
    }
    if (vibrate) this.startVibration();
  }

  stop(): void {
    this.playing = false;
    this.clearPreview();
    this.audio.pause();
    try {
      this.audio.currentTime = 0;
    } catch {
      // Not loaded yet.
    }
    try {
      this.fallback?.stop();
    } catch {
      // Already stopped.
    }
    this.fallback = null;
    this.stopVibration();
  }

  /** Short sample for the "Test" button (itself a user gesture). */
  async preview(id: SoundId, vibrate: boolean, ms = 2600): Promise<void> {
    this.unlock(id);
    await this.start(id, vibrate);
    this.previewTimer = window.setTimeout(() => this.stop(), ms);
  }

  private wav(id: SoundId): ArrayBuffer {
    let wav = this.wavs.get(id);
    if (!wav) {
      wav = encodeWav(synthesize(id));
      this.wavs.set(id, wav);
    }
    return wav;
  }

  private setSource(id: SoundId): void {
    let url = this.urls.get(id);
    if (!url) {
      url = URL.createObjectURL(new Blob([this.wav(id)], { type: 'audio/wav' }));
      this.urls.set(id, url);
    }
    if (this.audio.src !== url) this.audio.src = url;
  }

  private async playWithWebAudio(id: SoundId): Promise<void> {
    if (!this.ctx) return;
    try {
      await this.ctx.resume();
      const buffer = await this.ctx.decodeAudioData(this.wav(id).slice(0));
      this.fallback?.stop();
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(this.ctx.destination);
      source.start();
      this.fallback = source;
    } catch {
      // Nothing else we can do: vibration and the on-screen alarm still work.
    }
  }

  private startVibration(): void {
    if (!('vibrate' in navigator)) return;
    this.stopVibration();
    navigator.vibrate(VIBRATION);
    this.vibrateTimer = window.setInterval(() => navigator.vibrate(VIBRATION), 3200);
  }

  private stopVibration(): void {
    if (this.vibrateTimer !== null) window.clearInterval(this.vibrateTimer);
    this.vibrateTimer = null;
    if ('vibrate' in navigator) navigator.vibrate(0);
  }

  private clearPreview(): void {
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    this.previewTimer = null;
  }
}
