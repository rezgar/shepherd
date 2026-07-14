// Synthesized notification sounds via Web Audio — no external asset files,
// works offline. Distinct envelopes per outcome so they're tellable apart
// without looking at the screen.

let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** Browsers suspend AudioContext until a user gesture — call once on the
 *  first click/keydown anywhere on the page to warm it up. */
export function unlockAudio(): void {
  getCtx();
}

function tone(freq: number, startOffset: number, duration: number, type: OscillatorType, peak = 0.15): void {
  const c = getCtx();
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(c.destination);
  const t0 = c.currentTime + startOffset;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
  osc.start(t0);
  osc.stop(t0 + duration + 0.03);
}

/** A turn finished cleanly — short ascending two-note chime. */
export function playDone(): void {
  tone(660, 0, 0.14, 'sine');
  tone(880, 0.1, 0.18, 'sine');
}

/** The session needs your input — a brighter, repeated attention ping. */
export function playNeedsYou(): void {
  tone(880, 0, 0.1, 'triangle', 0.18);
  tone(880, 0.14, 0.12, 'triangle', 0.18);
}

/** The session stopped on an error (rate limit, API error, etc.) — lower,
 *  harsher, descending. */
export function playError(): void {
  tone(440, 0, 0.14, 'sawtooth', 0.12);
  tone(220, 0.12, 0.22, 'sawtooth', 0.12);
}
