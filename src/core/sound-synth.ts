/**
 * Alarm sounds are synthesised in code (no audio files to download), encoded
 * as WAV and played through an <audio> element, which keeps ringing even when
 * an iPhone's silent switch is on.
 */

export type SoundId = 'classic' | 'siren' | 'buzzer' | 'chime' | 'kumbhakaran';

export const SOUNDS: readonly { id: SoundId; label: string }[] = [
  { id: 'classic', label: 'Classic beeps' },
  { id: 'siren', label: 'Rising siren' },
  { id: 'buzzer', label: 'Loud buzzer' },
  { id: 'chime', label: 'Bright chime' },
  { id: 'kumbhakaran', label: 'Kumbhakaran mode (extra loud)' },
];

export const SAMPLE_RATE = 22_050;
const NYQUIST = SAMPLE_RATE / 2;

type Wave = 'sine' | 'square' | 'saw' | 'triangle';

interface Tone {
  start: number;
  dur: number;
  freq: number | ((t: number) => number);
  wave: Wave;
  gain: number;
  attack?: number;
  release?: number;
  /** Exponential decay rate (1/s) for bell-like tones. */
  decay?: number;
}

/** Band-limited oscillator: only harmonics below Nyquist, so no aliasing hiss. */
function oscillator(wave: Wave, phase: number, freq: number): number {
  if (wave === 'sine') return Math.sin(phase);
  let sum = 0;
  for (let k = 1; k <= 15 && k * freq < NYQUIST * 0.9; k++) {
    if (wave === 'saw') sum += Math.sin(k * phase) / k;
    else if (k % 2 === 1) {
      sum += wave === 'square' ? Math.sin(k * phase) / k : ((k % 4 === 1 ? 1 : -1) * Math.sin(k * phase)) / (k * k);
    }
  }
  if (wave === 'square') return (4 / Math.PI) * sum;
  if (wave === 'saw') return (2 / Math.PI) * sum;
  return (8 / Math.PI ** 2) * sum;
}

function addTone(buf: Float32Array, tone: Tone): void {
  const start = Math.round(tone.start * SAMPLE_RATE);
  const n = Math.round(tone.dur * SAMPLE_RATE);
  const attack = tone.attack ?? 0.004;
  const release = tone.release ?? 0.012;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const idx = start + i;
    if (idx >= buf.length) break;
    const t = i / SAMPLE_RATE;
    const f = typeof tone.freq === 'function' ? tone.freq(t) : tone.freq;
    phase += (2 * Math.PI * f) / SAMPLE_RATE;
    let env = Math.max(0, Math.min(1, t / attack, (tone.dur - t) / release));
    if (tone.decay) env *= Math.exp(-t * tone.decay);
    buf[idx] += oscillator(tone.wave, phase, f) * tone.gain * env;
  }
}

function seconds(sec: number): Float32Array {
  return new Float32Array(Math.round(sec * SAMPLE_RATE));
}

/** Normalises to `peak` and optionally soft-clips for extra perceived loudness. */
function finish(buf: Float32Array, drive: number): Float32Array {
  let max = 0;
  for (const v of buf) max = Math.max(max, Math.abs(v));
  if (max === 0) return buf;
  const norm = Math.tanh(drive);
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] / max;
    buf[i] = drive > 0 ? (Math.tanh(v * drive) / norm) * 0.95 : v * 0.95;
  }
  return buf;
}

export function synthesize(id: SoundId): Float32Array {
  switch (id) {
    case 'classic': {
      const buf = seconds(1);
      for (let k = 0; k < 4; k++) addTone(buf, { start: k * 0.14, dur: 0.09, freq: 1760, wave: 'square', gain: 0.6 });
      return finish(buf, 1.6);
    }
    case 'siren': {
      const buf = seconds(1.6);
      addTone(buf, {
        start: 0,
        dur: 1.6,
        freq: (t) => 720 + 680 * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 1.6)),
        wave: 'triangle',
        gain: 0.9,
        attack: 0.02,
        release: 0.02,
      });
      return finish(buf, 1.8);
    }
    case 'buzzer': {
      const buf = seconds(0.7);
      for (let k = 0; k < 2; k++) {
        addTone(buf, { start: k * 0.32, dur: 0.24, freq: 420, wave: 'saw', gain: 0.55 });
        addTone(buf, { start: k * 0.32, dur: 0.24, freq: 630, wave: 'square', gain: 0.3 });
      }
      return finish(buf, 2);
    }
    case 'chime': {
      const buf = seconds(1.5);
      [1046.5, 1318.5, 1568, 2093].forEach((f, k) => {
        const common = { start: k * 0.16, dur: 0.9, wave: 'sine' as const, attack: 0.003, release: 0.1 };
        addTone(buf, { ...common, freq: f, gain: 0.5, decay: 4 });
        addTone(buf, { ...common, freq: f * 2, gain: 0.15, decay: 6 });
      });
      return finish(buf, 0);
    }
    case 'kumbhakaran': {
      const buf = seconds(1.5);
      addTone(buf, { start: 0, dur: 0.5, freq: (t) => 600 + 2800 * t, wave: 'square', gain: 0.5, attack: 0.01, release: 0.02 });
      for (let k = 0; k < 3; k++) addTone(buf, { start: 0.55 + k * 0.12, dur: 0.08, freq: 2500, wave: 'square', gain: 0.55 });
      addTone(buf, { start: 0.95, dur: 0.45, freq: 380, wave: 'saw', gain: 0.6 });
      addTone(buf, { start: 0.95, dur: 0.45, freq: 570, wave: 'square', gain: 0.35 });
      return finish(buf, 2.4);
    }
  }
}

/** Encodes mono float samples as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}
