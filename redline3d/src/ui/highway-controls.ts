import {
  HIGHWAY_LEV_STEP,
  HIGHWAY_MAX_LEV,
  HIGHWAY_MIN_LEV,
  snapHighwayLeverage,
} from "../core/highway-auto";

export interface HighwayControls {
  show(): void;
  hide(): void;
  value(): number;
  setConfirmed(lev: number): void;
  setSyncing(lev: number | null): void;
  setDisabled(disabled: boolean): void;
  setSentiment(longCount: number, shortCount: number, averageLeverage: number): void;
}

export function createHighwayControls(
  mount: HTMLElement,
  opts: { onCommit: (lev: number) => void },
): HighwayControls {
  const panel = document.createElement("section");
  panel.setAttribute("aria-label", "Highway position controls");
  panel.style.cssText = [
    "display:none", "position:fixed", "left:50%", "bottom:max(112px,calc(env(safe-area-inset-bottom) + 94px))",
    "transform:translateX(-50%)", "z-index:40", "width:min(92vw,520px)",
    "box-sizing:border-box", "padding:14px 16px", "border:1px solid rgba(255,255,255,.18)",
    "border-radius:16px", "background:rgba(8,12,18,.9)", "backdrop-filter:blur(14px)",
    "color:#fff", "font:700 12px/1.2 system-ui,sans-serif", "letter-spacing:.06em",
  ].join(";");
  panel.innerHTML = `
    <div style="display:flex;align-items:end;justify-content:space-between;gap:12px">
      <div><div style="opacity:.62;font-size:10px">LEVERAGE</div><div data-highway-requested style="font-size:32px;line-height:1">100x</div></div>
      <div style="text-align:right"><div data-highway-sync style="color:#ffbf69"></div><div data-highway-confirmed style="opacity:.68">CONFIRMED 100x</div></div>
    </div>
    <input data-highway-leverage aria-label="Highway leverage" type="range" min="${HIGHWAY_MIN_LEV}" max="${HIGHWAY_MAX_LEV}" step="${HIGHWAY_LEV_STEP}" value="100" style="width:100%;margin:14px 0 11px;accent-color:#ff6a3d;touch-action:pan-x">
    <div data-highway-sentiment style="display:flex;justify-content:space-between;gap:12px;opacity:.72">
      <span>LONG 0</span><span>SHORT 0</span><span>AVG 0x</span>
    </div>`;
  mount.appendChild(panel);

  const slider = panel.querySelector<HTMLInputElement>("[data-highway-leverage]")!;
  const requestedEl = panel.querySelector<HTMLElement>("[data-highway-requested]")!;
  const confirmedEl = panel.querySelector<HTMLElement>("[data-highway-confirmed]")!;
  const syncingEl = panel.querySelector<HTMLElement>("[data-highway-sync]")!;
  const sentimentEl = panel.querySelector<HTMLElement>("[data-highway-sentiment]")!;

  let requested = 100;
  let confirmed = 100;
  let outstanding: number | null = null;
  let dirty = false;

  const render = () => {
    requestedEl.textContent = `${requested}x`;
    confirmedEl.textContent = `CONFIRMED ${confirmed}x`;
    syncingEl.textContent = outstanding === null ? "" : "SYNCING";
  };
  const readSlider = () => snapHighwayLeverage(Number(slider.value));
  const preview = () => {
    requested = readSlider();
    slider.value = String(requested);
    dirty = true;
    render();
  };
  const commit = () => {
    const next = readSlider();
    requested = next;
    slider.value = String(next);
    if (!dirty && (outstanding === next || (outstanding === null && confirmed === next))) {
      render();
      return;
    }
    dirty = false;
    outstanding = next;
    render();
    opts.onCommit(next);
  };

  slider.addEventListener("input", preview);
  slider.addEventListener("change", commit);
  slider.addEventListener("pointerup", commit);
  slider.addEventListener("touchend", commit, { passive: true });

  return {
    show: () => { panel.style.display = "block"; },
    hide: () => { panel.style.display = "none"; },
    value: () => requested,
    setConfirmed: (lev) => {
      confirmed = snapHighwayLeverage(lev);
      if (outstanding === confirmed) outstanding = null;
      if (outstanding === null) {
        requested = confirmed;
        slider.value = String(confirmed);
      }
      render();
    },
    setSyncing: (lev) => {
      outstanding = lev === null ? null : snapHighwayLeverage(lev);
      if (outstanding !== null) {
        requested = outstanding;
        slider.value = String(outstanding);
      }
      render();
    },
    setDisabled: (disabled) => { slider.disabled = disabled; panel.style.opacity = disabled ? ".55" : "1"; },
    setSentiment: (longCount, shortCount, averageLeverage) => {
      const avg = Number.isFinite(averageLeverage) ? Math.max(0, Math.round(averageLeverage)) : 0;
      sentimentEl.innerHTML = `<span>LONG ${Math.max(0, Math.floor(longCount))}</span><span>SHORT ${Math.max(0, Math.floor(shortCount))}</span><span>AVG ${avg}x</span>`;
    },
  };
}
