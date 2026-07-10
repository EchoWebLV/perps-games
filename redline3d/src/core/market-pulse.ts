export interface MarketPulseFrame {
  volatility: number;
  momentum: number;
  shock: number;
  shockId: number;
  danger: number;
}

export interface MarketPulseInput {
  price: number;
  live: boolean;
  roundLive: boolean;
  buffer: number;
  dt: number;
}

export interface MarketPulse {
  update(input: MarketPulseInput): MarketPulseFrame;
  reset(): void;
}

export const CALM_MARKET_PULSE: Readonly<MarketPulseFrame> = Object.freeze({
  volatility: 0,
  momentum: 0,
  shock: 0,
  shockId: 0,
  danger: 0,
});

const VOL_CALM = 0.0001;
const VOL_FULL = 0.0012;
const MOMENTUM_FULL = 0.0015;
const SHOCK_MIN = 0.0008;
const SHOCK_COOLDOWN = 1;
const VOL_TAU = 0.7;
const MOMENTUM_TAU = 2;
const STALE_TAU = 0.6;
const SHOCK_TAU = 0.25;
const DANGER_TAU = 0.12;

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const ease = (current: number, target: number, dt: number, tau: number) =>
  current + (target - current) * (1 - Math.exp(-dt / tau));
const normalize = (v: number, lo: number, hi: number) => clamp((v - lo) / (hi - lo));
const smoothstep = (v: number) => {
  const x = clamp(v);
  return x * x * (3 - 2 * x);
};

export function createMarketPulse(): MarketPulse {
  let lastPrice = 0;
  let sinceObservation = 0;
  let volatilityEwma = 0;
  let momentumEwma = 0;
  let shock = 0;
  let shockId = 0;
  let shockCooldown = 0;
  let danger = 0;

  const reset = () => {
    lastPrice = 0;
    sinceObservation = 0;
    volatilityEwma = 0;
    momentumEwma = 0;
    shock = 0;
    shockId = 0;
    shockCooldown = 0;
    danger = 0;
  };

  return {
    reset,
    update(input) {
      const dt = clamp(Number.isFinite(input.dt) ? input.dt : 0, 0, 0.1);
      sinceObservation += dt;
      shockCooldown = Math.max(0, shockCooldown - dt);
      shock = ease(shock, 0, dt, SHOCK_TAU);

      if (!input.live) {
        volatilityEwma = ease(volatilityEwma, 0, dt, STALE_TAU);
        momentumEwma = ease(momentumEwma, 0, dt, STALE_TAU);
      } else if (input.price > 0 && input.price !== lastPrice) {
        if (lastPrice > 0) {
          const change = input.price / lastPrice - 1;
          const magnitude = Math.abs(change);
          const observationDt = Math.max(0.016, sinceObservation);
          const previousVolatility = volatilityEwma;
          volatilityEwma = ease(volatilityEwma, magnitude, observationDt, VOL_TAU);
          momentumEwma = ease(momentumEwma, change, observationDt, MOMENTUM_TAU);
          const shockThreshold = Math.max(SHOCK_MIN, 2.5 * Math.max(previousVolatility, 0.00002));
          if (magnitude >= shockThreshold && shockCooldown === 0) {
            shockId += 1;
            shock = clamp(0.4 + (magnitude - shockThreshold) / 0.0026, 0.4, 1);
            shockCooldown = SHOCK_COOLDOWN;
          }
        }
        lastPrice = input.price;
        sinceObservation = 0;
      }

      const dangerTarget = input.roundLive
        ? smoothstep((0.35 - clamp(input.buffer, 0, 1)) / 0.35)
        : 0;
      danger = ease(danger, dangerTarget, dt, DANGER_TAU);

      return {
        volatility: normalize(volatilityEwma, VOL_CALM, VOL_FULL),
        momentum: clamp(momentumEwma / MOMENTUM_FULL, -1, 1),
        shock,
        shockId,
        danger,
      };
    },
  };
}
