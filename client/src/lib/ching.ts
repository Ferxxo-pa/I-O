import type { HitTier } from "@shared/fight";

let ctx: AudioContext | null = null;

function audio(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

/** Browsers stay silent until a click or tap. */
export function unlockChing() {
  const context = audio();
  if (context.state === "suspended") void context.resume();
}

function tone(context: AudioContext, freq: number, start: number, peak: number, length: number) {
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(gain);
  gain.connect(context.destination);
  osc.start(start);
  osc.stop(start + length + 0.02);
}

/** A short coin ching. Crit is a different, louder figure. */
export function ching(tier: HitTier = "solid") {
  const context = audio();
  if (context.state !== "running") return;
  const now = context.currentTime;
  if (tier === "crit") {
    tone(context, 392, now, 0.22, 0.18);
    tone(context, 784, now + 0.09, 0.28, 0.22);
    tone(context, 1175, now + 0.18, 0.24, 0.28);
    return;
  }
  const peak = tier === "small" ? 0.09 : tier === "big" ? 0.22 : 0.16;
  const notes = tier === "big" ? [1568, 1976, 2349] : [1760, 2217];
  notes.forEach((freq, index) => tone(context, freq, now + index * 0.045, peak, 0.24));
}

/** One soft figure when the team clears break-even. */
export function clearedChime() {
  const context = audio();
  if (context.state !== "running") return;
  const now = context.currentTime;
  [523, 659, 784, 1046].forEach((freq, index) => {
    tone(context, freq, now + index * 0.07, 0.16, 0.22);
  });
}
