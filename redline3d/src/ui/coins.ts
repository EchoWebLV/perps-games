import { coinLabel } from "../core/coins";

export interface CoinCounter {
  set(total: number): void;
}

export function createCoinCounter(parent: HTMLElement): CoinCounter {
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
    <span id="coinTotal" class="num" style="font-size:17px;line-height:1.08;color:var(--amb);text-shadow:0 0 11px rgba(255,209,102,.55)">0</span>`;

  const totalEl = wrap.querySelector("#coinTotal") as HTMLElement;
  parent.appendChild(wrap);

  return {
    set(total) { totalEl.textContent = coinLabel(total); },
  };
}
