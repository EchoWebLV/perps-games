export interface GameAudio {
  /** unlock/resume the audio context — must be called from a user gesture */
  resume(): void;
  /** rev drone: pitch + volume follow the throttle; silent when not active */
  engine(frac: number, active: boolean): void;
  /** win sting — a bright ascending arpeggio */
  cashout(): void;
  /** loss sting — a blown-engine drop + noise burst */
  liquidate(): void;
}

/**
 * Fully procedural Web Audio — no sample assets (so it's commercial-safe and adds
 * nothing to the bundle). A synth rev drone tracks the leverage, plus short stings
 * for cash-out / liquidation. The context is created lazily on the first gesture so
 * it never trips the autoplay policy.
 */
export function createAudio(): GameAudio {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let lp: BiquadFilterNode | null = null;
  let eg: GainNode | null = null;
  let o1: OscillatorNode | null = null;
  let o2: OscillatorNode | null = null;

  const ensure = () => {
    if (ctx) return;
    const AC: typeof AudioContext | undefined = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.45; master.connect(ctx.destination);
    lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 700; lp.Q.value = 7;
    eg = ctx.createGain(); eg.gain.value = 0;
    o1 = ctx.createOscillator(); o1.type = "sawtooth"; o1.frequency.value = 70;
    o2 = ctx.createOscillator(); o2.type = "sawtooth"; o2.frequency.value = 70; o2.detune.value = 14;
    o1.connect(lp); o2.connect(lp); lp.connect(eg); eg.connect(master);
    o1.start(); o2.start();
  };

  const ping = (freq: number, at: number, dur: number, type: OscillatorType, vol: number) => {
    if (!ctx || !master) return;
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vol, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(master);
    o.start(at); o.stop(at + dur + 0.03);
  };

  return {
    resume() { ensure(); if (ctx && ctx.state === "suspended") void ctx.resume(); },
    engine(frac, active) {
      if (!ctx || !eg || !o1 || !o2 || !lp) return;
      const f = Math.max(0, Math.min(1, frac));
      const now = ctx.currentTime;
      eg.gain.setTargetAtTime(active ? 0.02 + f * 0.07 : 0, now, 0.08);
      const freq = 70 + f * 190;
      o1.frequency.setTargetAtTime(freq, now, 0.05);
      o2.frequency.setTargetAtTime(freq, now, 0.05);
      lp.frequency.setTargetAtTime(600 + f * 2200, now, 0.06);
    },
    cashout() {
      ensure(); if (!ctx) return;
      const t = ctx.currentTime;
      [0, 4, 7, 12].forEach((s, i) => ping(523.25 * Math.pow(2, s / 12), t + i * 0.075, 0.26, "triangle", 0.16));
    },
    liquidate() {
      ensure(); if (!ctx || !master) return;
      const t = ctx.currentTime;
      const o = ctx.createOscillator(); o.type = "sawtooth";
      o.frequency.setValueAtTime(200, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.55);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.22, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.65);
      // noise burst — the blown engine
      const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.3), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
      const n = ctx.createBufferSource(); n.buffer = buf;
      const ng = ctx.createGain(); ng.gain.value = 0.14;
      n.connect(ng); ng.connect(master); n.start(t);
    },
  };
}
