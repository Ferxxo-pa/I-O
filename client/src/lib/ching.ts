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
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, start);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.62), start + length);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(gain);
  gain.connect(context.destination);
  osc.start(start);
  osc.stop(start + length + 0.02);
}

/** A short bing. Each tier adds a note and gets louder. Crit is the full figure. */
export function ching(tier: HitTier = "solid") {
  const context = audio();
  if (context.state !== "running") return;
  const now = context.currentTime;
  if (tier === "crit") {
    tone(context, 523, now, 0.2, 0.16);
    tone(context, 659, now + 0.06, 0.24, 0.18);
    tone(context, 784, now + 0.12, 0.28, 0.2);
    tone(context, 1047, now + 0.18, 0.32, 0.36);
    tone(context, 1568, now + 0.28, 0.18, 0.3);
    return;
  }
  if (tier === "big") {
    tone(context, 784, now, 0.18, 0.12);
    tone(context, 1047, now + 0.06, 0.22, 0.16);
    tone(context, 1568, now + 0.12, 0.2, 0.22);
    return;
  }
  if (tier === "solid") {
    tone(context, 988, now, 0.16, 0.1);
    tone(context, 1480, now + 0.07, 0.18, 0.16);
    return;
  }
  tone(context, 1319, now, 0.12, 0.11);
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
