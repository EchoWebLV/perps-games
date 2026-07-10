import { coinLabel } from "../core/coins";

// The scrap chip — a raw-steel sibling of the coin chip. Scrap is caught while driving
// (every 3rd–5th pickup comes up scrap instead of a coin) and banked to the garage save;
// it's spent later at the Scrap Yard, never on the leverage upgrades.
export interface ScrapCounter {
  set(total: number, animate?: boolean): void;
  /** the chip is race chrome — hidden while cruising/betting on the strip (mirrors coins) */
  setVisible(visible: boolean): void;
}

let stylesInjected = false;
function injectScrapStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    @keyframes scrapAmbientGlow{
      0%,74%,100%{text-shadow:0 0 9px rgba(154,164,178,.5);filter:brightness(1)}
      82%{text-shadow:0 0 16px rgba(154,164,178,.82);filter:brightness(1.12)}
    }
    @keyframes scrapPopGlow{
      0%{transform:scale(1);text-shadow:0 0 9px rgba(154,164,178,.5)}
      36%{transform:scale(1.22);text-shadow:0 0 22px rgba(154,164,178,.95),0 0 30px rgba(39,231,255,.28)}
      100%{transform:scale(1);text-shadow:0 0 9px rgba(154,164,178,.5)}
    }
    .scrap-total{display:inline-block;animation:scrapAmbientGlow 5.6s ease-in-out infinite;transform-origin:center center}
    .scrap-total.scrap-pop{animation:scrapPopGlow .42s ease-out,scrapAmbientGlow 5.6s ease-in-out infinite .42s}
  `;
  document.head.appendChild(s);
}

export function createScrapCounter(parent: HTMLElement): ScrapCounter {
  injectScrapStyles();
  const wrap = document.createElement("div");
  wrap.className = "pe panel";
  wrap.setAttribute("aria-label", "Scrap collected");
  wrap.style.cssText = [
    "position:absolute",
    // stacked directly under the coin chip: base+134 + 42h + 8 gap = base+184 (194 on desktop).
    // The 50px column pitch (42px chip + 8px gap) must stay constant so the chips never overlap.
    "top:calc(max(10px,env(safe-area-inset-top)) + 184px)",
    "left:max(12px,env(safe-area-inset-left))",
    "z-index:8",
    "min-width:74px",
    "height:42px",
    "padding:5px 10px 6px",
    "display:flex",
    "flex-direction:column",
    "justify-content:center",
    "align-items:center",
    "text-align:center",
    "border-radius:9px",
    "background:rgba(12,10,26,.74)",
  ].join(";");

  wrap.innerHTML = `
    <span class="lbl" style="font-size:8px;letter-spacing:.15em;line-height:1">scrap</span>
    <span id="scrapTotal" class="num scrap-total" style="font-size:17px;line-height:1.08;color:#c2cad6;text-shadow:0 0 9px rgba(154,164,178,.5)">0</span>`;

  const totalEl = wrap.querySelector("#scrapTotal") as HTMLElement;
  let previous = 0;
  parent.appendChild(wrap);

  return {
    set(total, animate = true) {
      totalEl.textContent = coinLabel(total);
      if (animate && total > previous) {
        totalEl.classList.remove("scrap-pop");
        void totalEl.offsetWidth; // restart the pop animation
        totalEl.classList.add("scrap-pop");
      }
      previous = total;
    },
    setVisible(visible) { wrap.style.display = visible ? "flex" : "none"; },
  };
}
