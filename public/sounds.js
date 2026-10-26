// sounds.js — tiny funny sounds for "Do I Need to Do This?", made with the Web Audio API.
// No audio files, nothing downloaded. Usage:
//   import { sfx, setSound, soundOn } from './sounds.js';
//   sfx('snore')   // call from a click handler (browsers only allow audio after a user gesture)
// Sounds: tap, pop, think, flump, snore, slurp, tick, boing, huh, ding, learned

let ctx = null;
let enabled = (() => { try { return localStorage.getItem('dind-sound') !== 'off'; } catch { return true; } })();
export const soundOn = () => enabled;
export function setSound(on) { enabled = !!on; try { localStorage.setItem('dind-sound', on ? 'on' : 'off'); } catch {} }

function ac() {
  if (!ctx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; ctx = new C(); }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
const master = (a, vol = 0.25) => { const g = a.createGain(); g.gain.value = vol; g.connect(a.destination); return g; };

// one tone with a pitch slide and a quick envelope
function tone(a, out, { f0, f1 = f0, t = 0, dur = 0.15, type = 'sine', vol = 1, attack = 0.005 }) {
  const o = a.createOscillator(), g = a.createGain(), s = a.currentTime + t;
  o.type = type; o.frequency.setValueAtTime(f0, s); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), s + dur);
  g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(vol, s + attack); g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
  o.connect(g); g.connect(out); o.start(s); o.stop(s + dur + 0.02);
}
// filtered noise burst (for snores, slurps, flumps)
function noise(a, out, { t = 0, dur = 0.3, freq = 800, q = 1, vol = 1, type = 'bandpass', sweepTo }) {
  const len = Math.floor(a.sampleRate * dur), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain(), s = a.currentTime + t;
  src.buffer = buf; f.type = type; f.Q.value = q; f.frequency.setValueAtTime(freq, s);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, s + dur);
  g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(vol, s + dur * 0.3); g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
  src.connect(f); f.connect(g); g.connect(out); src.start(s); src.stop(s + dur + 0.02);
}

const SOUNDS = {
  // UI
  tap:   (a, o) => tone(a, o, { f0: 900, f1: 1200, dur: 0.05, vol: 0.5 }),
  pop:   (a, o) => tone(a, o, { f0: 400, f1: 900, dur: 0.09, vol: 0.8 }),
  think: (a, o) => { tone(a, o, { f0: 330, f1: 360, dur: 0.18, type: 'triangle', vol: 0.5 }); tone(a, o, { f0: 440, f1: 470, t: 0.2, dur: 0.18, type: 'triangle', vol: 0.5 }); },          // "hmm-mm"
  // verdict landing: Lazy flopping onto the couch
  flump: (a, o) => { noise(a, o, { dur: 0.25, freq: 300, q: 0.8, vol: 0.9, type: 'lowpass', sweepTo: 120 }); tone(a, o, { f0: 120, f1: 60, dur: 0.2, vol: 0.8 }); },
  // verdict moods
  snore: (a, o) => { noise(a, o, { dur: 0.9, freq: 220, q: 3, vol: 0.9, sweepTo: 420 }); tone(a, o, { f0: 90, f1: 130, dur: 0.9, type: 'sawtooth', vol: 0.12, attack: 0.3 }); noise(a, o, { t: 1.0, dur: 0.5, freq: 2500, q: 1, vol: 0.25, sweepTo: 1500 }); }, // skip: snore + whistle out
  slurp: (a, o) => { noise(a, o, { dur: 0.35, freq: 600, q: 6, vol: 0.8, sweepTo: 2400 }); tone(a, o, { f0: 700, f1: 500, t: 0.4, dur: 0.12, vol: 0.4 }); }, // lazy minimum: coffee slurp + "ahh"
  tick:  (a, o) => { [0, 0.18, 0.36].forEach((t, i) => tone(a, o, { f0: i % 2 ? 1500 : 1900, t, dur: 0.04, type: 'square', vol: 0.25 })); tone(a, o, { f0: 880, f1: 1320, t: 0.6, dur: 0.15, vol: 0.4 }); }, // later: tick-tock-tick… "ping"
  boing: (a, o) => { tone(a, o, { f0: 150, f1: 600, dur: 0.35, type: 'triangle', vol: 0.9 }); tone(a, o, { f0: 600, f1: 300, t: 0.33, dur: 0.25, type: 'triangle', vol: 0.5 }); }, // do it: panicked jump
  huh:   (a, o) => { tone(a, o, { f0: 300, f1: 420, dur: 0.25, type: 'triangle', vol: 0.6 }); tone(a, o, { f0: 420, f1: 520, t: 0.26, dur: 0.18, type: 'triangle', vol: 0.5 }); }, // not sure: rising "huh?"
  // feedback
  ding:    (a, o) => { tone(a, o, { f0: 1318, dur: 0.12, vol: 0.5 }); tone(a, o, { f0: 1760, t: 0.1, dur: 0.4, vol: 0.5 }); },
  learned: (a, o) => [523, 659, 784].forEach((f, i) => tone(a, o, { f0: f, t: i * 0.08, dur: 0.18, vol: 0.4 })), // "Lazy learned something" sparkle
};

// verdict kind -> sound
export const VERDICT_SOUND = { skip: 'snore', min: 'slurp', later: 'tick', do: 'boing', unsure: 'huh' };

export function sfx(name, vol = 0.25) {
  if (!enabled) return;
  const a = ac(); if (!a || !SOUNDS[name]) return;
  try { SOUNDS[name](a, master(a, vol)); } catch { /* never break the app for a sound */ }
}
