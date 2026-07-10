export interface GameAudio {
  /** unlock/resume the audio context — must be called from a user gesture */
  resume(): void;
  /** rev drone: pitch + volume follow the throttle; silent when not active */
  engine(frac: number, active: boolean): void;
  /** sampled coin pickup sound; count allows multiple pickups in one frame */
  coin(count?: number): void;
  /** win sting — a bright ascending arpeggio */
  cashout(): void;
  /** loss sting — a blown-engine drop + noise burst */
  liquidate(): void;
  /** master volume (0..1) for ALL game SFX — engine drone, coins, stings. 0 = fully silent.
   *  Scales MASTER_VOL (and the coin HTMLAudio, which bypasses the WebAudio graph). Music is separate. */
  setVolume(v: number): void;
  /** current SFX volume, 0..1 */
  getVolume(): number;
}

export const COIN_VOLUME = 0.1;
const MASTER_VOL = 0.45;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Fully procedural Web Audio — no sample assets (so it's commercial-safe and adds
 * nothing to the bundle). A synth rev drone tracks the leverage, plus short stings
 * for cash-out / liquidation. The context is created lazily on the first gesture so
 * it never trips the autoplay policy.
 */
export function createAudio(startVolume = 1): GameAudio {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let lp: BiquadFilterNode | null = null;  // tone — opens with throttle
  let eg: GainNode | null = null;          // overall engine level (active/throttle)
  let o1: OscillatorNode | null = null;    // firing pulse voice 1
  let o2: OscillatorNode | null = null;    // firing pulse voice 2 (detuned)
  let sub: OscillatorNode | null = null;   // sub-octave body
  let ng: GainNode | null = null;          // combustion / intake noise level
  let coinPool: HTMLAudioElement[] | null = null;
  let coinI = 0;
  let volume = clamp01(startVolume); // SFX master volume 0..1 (Music is the separate radio)

  // soft-clip (tanh) distortion — grit/roar
  const driveCurve = (k: number) => {
    const n = 2048, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x); }
    return c;
  };
  // square/pulse curve for the PWM pulse oscillator (per-cylinder firing pulse)
  const pulseCurve = () => { const c = new Float32Array(256); c.fill(-1, 0, 128); c.fill(1, 128, 256); return c; };

  const ensure = () => {
    if (ctx) return;
    const AC: typeof AudioContext | undefined = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    const C = ctx = new AC();
    master = C.createGain(); master.gain.value = volume * MASTER_VOL; master.connect(C.destination);
    eg = C.createGain(); eg.gain.value = 0; eg.connect(master);

    // tone lowpass (dry path) fed by the distorted engine voices on an excitation bus
    lp = C.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 600; lp.Q.value = 1.2; lp.connect(eg);
    const grit = C.createWaveShaper(); grit.curve = driveCurve(3); grit.oversample = "2x"; grit.connect(lp);
    const exc = C.createGain(); exc.gain.value = 0.5; exc.connect(grit);

    // narrow PULSE oscillator = the per-cylinder firing pulse. At low revs you hear
    // individual pulses (chug); as the firing rate climbs they blend into a dense roar.
    const sq = pulseCurve();
    const makePulse = (detune: number): OscillatorNode => {
      const osc = C.createOscillator(); osc.type = "sawtooth"; osc.frequency.value = 40; osc.detune.value = detune;
      const dc = C.createConstantSource(); dc.offset.value = 1;          // DC offset sets the duty
      const width = C.createGain(); width.gain.value = 0.82;             // narrow pulse
      const sum = C.createGain();
      const shaper = C.createWaveShaper(); shaper.curve = sq;
      osc.connect(sum); dc.connect(width); width.connect(sum); sum.connect(shaper); shaper.connect(exc);
      osc.start(); dc.start();
      return osc;
    };
    o1 = makePulse(0); o2 = makePulse(14);

    // sub-octave square — low-end body
    sub = C.createOscillator(); sub.type = "square"; sub.frequency.value = 20;
    const subG = C.createGain(); subG.gain.value = 0.4; sub.connect(subG); subG.connect(exc); sub.start();

    // exhaust resonance: a feedback comb tuned to a fixed "pipe" frequency, excited by the
    // distorted voices — this resonator is what turns the pulse buzz into a throaty roar.
    const comb = C.createDelay(0.05); comb.delayTime.value = 1 / 82;
    const combLP = C.createBiquadFilter(); combLP.type = "lowpass"; combLP.frequency.value = 2200;
    const combFb = C.createGain(); combFb.gain.value = 0.55;
    lp.connect(comb); comb.connect(combLP); combLP.connect(combFb); combFb.connect(comb);
    const combMix = C.createGain(); combMix.gain.value = 0.6; comb.connect(combMix); combMix.connect(eg);

    // combustion / intake air noise — level follows throttle
    const nb = C.createBuffer(1, C.sampleRate, C.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const noise = C.createBufferSource(); noise.buffer = nb; noise.loop = true;
    const nbp = C.createBiquadFilter(); nbp.type = "bandpass"; nbp.frequency.value = 950; nbp.Q.value = 0.7;
    ng = C.createGain(); ng.gain.value = 0; noise.connect(nbp); nbp.connect(ng); ng.connect(eg);
    noise.start();
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

  const ensureCoinPool = () => {
    if (coinPool) return;
    coinPool = Array.from({ length: 4 }, () => {
      const a = new Audio("/audio/drop-coin.mp3");
      a.preload = "auto";
      a.volume = COIN_VOLUME;
      return a;
    });
  };

  return {
    resume() { ensure(); ensureCoinPool(); if (ctx && ctx.state === "suspended") void ctx.resume(); },
    engine(frac, active) {
      if (!ctx || !eg || !o1 || !o2 || !sub || !ng || !lp) return;
      const f = Math.max(0, Math.min(1, frac));
      const now = ctx.currentTime;
      const fire = 32 + f * 120;                  // firing frequency (Hz): chug → roar
      o1.frequency.setTargetAtTime(fire, now, 0.05);
      o2.frequency.setTargetAtTime(fire, now, 0.05);
      sub.frequency.setTargetAtTime(fire * 0.5, now, 0.05);    // sub-octave rumble
      lp.frequency.setTargetAtTime(500 + f * 3200, now, 0.06); // opens up = brighter roar
      eg.gain.setTargetAtTime(active ? 0.03 + f * 0.11 : 0, now, 0.08);
      ng.gain.setTargetAtTime(active ? 0.005 + f * 0.05 : 0, now, 0.08); // combustion air
    },
    coin(count = 1) {
      if (volume <= 0) return;
      ensureCoinPool();
      if (!coinPool) return;
      const n = Math.max(0, Math.floor(count));
      for (let i = 0; i < n; i++) {
        const a = coinPool[coinI++ % coinPool.length];
        a.volume = COIN_VOLUME * volume; // this element bypasses the WebAudio master — scale it here or the fader won't touch coins
        a.currentTime = 0;
        void a.play().catch(() => {});
      }
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
    setVolume(v) {
      volume = clamp01(v);
      if (ctx && master) master.gain.setTargetAtTime(volume * MASTER_VOL, ctx.currentTime, 0.02);
    },
    getVolume() { return volume; },
  };
}
