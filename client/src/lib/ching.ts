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

/** A short coin ching. Plays only after the page has been tapped. */
export function ching() {
  const context = audio();
  if (context.state !== "running") return;
  const now = context.currentTime;
  const notes = [1760, 2217];
  notes.forEach((freq, index) => {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, now);
    const start = now + index * 0.04;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.16, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.26);
    osc.connect(gain);
    gain.connect(context.destination);
    osc.start(start);
    osc.stop(start + 0.28);
  });
}
