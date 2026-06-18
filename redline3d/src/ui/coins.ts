import { coinLabel, coinPulseClass } from "../core/coins";

export interface CoinCounter {
  set(total: number): void;
}

let stylesInjected = false;
function injectCoinStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    @keyframes coinAmbientGlow{
      0%,68%,100%{text-shadow:0 0 11px rgba(255,209,102,.55);filter:brightness(1)}
      76%{text-shadow:0 0 18px rgba(255,209,102,.86),0 0 28px rgba(255,57,192,.24);filter:brightness(1.15)}
      82%{text-shadow:0 0 13px rgba(255,209,102,.64);filter:brightness(1.04)}
    }
    @keyframes coinPopGlow{
      0%{transform:scale(1);text-shadow:0 0 11px rgba(255,209,102,.55)}
      36%{transform:scale(1.24);text-shadow:0 0 24px rgba(255,209,102,.95),0 0 32px rgba(46,230,166,.42)}
      100%{transform:scale(1);text-shadow:0 0 11px rgba(255,209,102,.55)}
    }
    .coin-total{display:inline-block;animation:coinAmbientGlow 4.8s ease-in-out infinite;transform-origin:left center}
    .coin-total.coin-pop{animation:coinPopGlow .42s ease-out,coinAmbientGlow 4.8s ease-in-out infinite .42s}
  `;
  document.head.appendChild(s);
}

export function createCoinCounter(parent: HTMLElement): CoinCounter {
  injectCoinStyles();
  const wrap = document.createElement("div");
  wrap.className = "pe panel";
  wrap.setAttribute("aria-label", "Coins collected");
  wrap.style.cssText = [
    "position:absolute",
    "top:144px",
    "left:max(12px,env(safe-area-inset-left))",
    "z-index:8",
    "min-width:74px",
    "height:42px",
    "padding:5px 10px 6px",
    "display:flex",
    "flex-direction:column",
    "justify-content:center",
    "border-radius:9px",
    "background:rgba(12,10,26,.74)",
  ].join(";");

  wrap.innerHTML = `
    <span class="lbl" style="font-size:8px;letter-spacing:.15em;line-height:1">coins</span>
    <span id="coinTotal" class="num coin-total" style="font-size:17px;line-height:1.08;color:var(--amb);text-shadow:0 0 11px rgba(255,209,102,.55)">0</span>`;

  const totalEl = wrap.querySelector("#coinTotal") as HTMLElement;
  let previous = 0;
  parent.appendChild(wrap);

  return {
    set(total) {
      totalEl.textContent = coinLabel(total);
      const pulse = coinPulseClass(previous, total);
      if (pulse) {
        totalEl.classList.remove(pulse);
        void totalEl.offsetWidth;
        totalEl.classList.add(pulse);
      }
      previous = total;
    },
  };
}
