// A short two-note chime for new work at the pass. Kitchens are loud and the tablet is often not in
// anyone's hand, so a sound is the only way a new ticket gets noticed.
//
// Browsers only allow audio after a tap, so the screen has an on/off button; turning it on is the tap
// that unlocks it. Everything here fails quietly: a tablet that cannot play the sound must still show
// the ticket.

let context = null;

function audio() {
  if (context) return context;
  const Ctx = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
  if (!Ctx) return null;
  try {
    context = new Ctx();
  } catch {
    context = null;
  }
  return context;
}

/** Call from a tap. Lets later chimes play without another tap. */
export function unlockAudio() {
  const ctx = audio();
  if (ctx && ctx.state === 'suspended') ctx.resume?.().catch?.(() => {});
  return Boolean(ctx);
}

/** Play the chime. Returns whether it could. */
export function playChime() {
  const ctx = audio();
  if (!ctx) return false;
  try {
    if (ctx.state === 'suspended') ctx.resume?.();
    const start = ctx.currentTime + 0.01;
    [[880, 0], [1175, 0.16]].forEach(([freq, offset]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.35, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start + offset);
      osc.stop(start + offset + 0.32);
    });
    return true;
  } catch {
    return false;
  }
}
