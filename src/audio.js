// 極簡 WebAudio 合成音效，不需要任何音檔
let ctx = null, master = null, noiseBuf = null;

export function unlockAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
}

function tone(type, f0, f1, dur, vol) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + dur);
}

function noise(dur, vol, freq, q = 1) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = noiseBuf;
  f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  s.connect(f).connect(g).connect(master);
  s.start(t); s.stop(t + dur);
}

export const sfx = {
  shoot() { tone('square', 900, 180, 0.07, 0.12); noise(0.05, 0.25, 2500, 0.8); },
  enemyShoot() { tone('sawtooth', 500, 120, 0.12, 0.1); noise(0.06, 0.2, 1500); },
  heavyShoot() { tone('sawtooth', 220, 50, 0.25, 0.2); noise(0.2, 0.45, 600, 0.6); },
  hit() { tone('square', 300, 80, 0.06, 0.15); noise(0.04, 0.2, 3500); },
  wall() { noise(0.03, 0.08, 4000, 2); },
  kill() { tone('triangle', 260, 40, 0.3, 0.3); noise(0.25, 0.4, 900, 0.7); },
  hurt() { tone('sawtooth', 160, 40, 0.4, 0.35); noise(0.3, 0.5, 400, 0.5); },
  telegraph() { tone('sine', 1400, 1400, 0.05, 0.05); },
  lunge() { tone('square', 120, 260, 0.15, 0.08); },
  door() { tone('triangle', 400, 900, 0.35, 0.2); },
  die() { tone('sawtooth', 300, 30, 0.9, 0.4); noise(0.8, 0.5, 300, 0.4); },
  reloadStart() { tone('square', 600, 300, 0.05, 0.08); noise(0.04, 0.15, 3000, 2); },
  reloadDone() { tone('square', 300, 800, 0.07, 0.1); noise(0.05, 0.2, 2200, 2); },
  empty() { tone('square', 1300, 1200, 0.03, 0.06); },
  enemyReload() { noise(0.06, 0.12, 2600, 2); },
  breach() { tone('sawtooth', 130, 30, 0.6, 0.45); noise(0.5, 0.9, 500, 0.5); },
  doorHit() { noise(0.08, 0.3, 700, 1); },
  groan() { tone('sawtooth', 95 + Math.random() * 40, 60, 0.55, 0.05); noise(0.45, 0.07, 280, 1.5); },
  roar() { tone('sawtooth', 110, 40, 0.8, 0.22); noise(0.7, 0.35, 240, 0.6); },
  glass() { noise(0.12, 0.25, 6000, 1.5); tone('triangle', 2400, 900, 0.1, 0.06); },
  gate() { noise(0.35, 0.18, 900, 3); tone('square', 70, 55, 0.3, 0.06); },
  switchOn() { tone('square', 500, 500, 0.04, 0.08); tone('square', 900, 900, 0.06, 0.06); },
  thud() { tone('triangle', 90, 30, 0.35, 0.35); noise(0.25, 0.5, 350, 0.6); },
  alert() { tone('square', 900, 1400, 0.08, 0.07); },
  click() { tone('triangle', 700, 900, 0.05, 0.1); },
};
