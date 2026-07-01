/**
 * Death's Door — the Skull car's near-death sequence.
 *
 * A sustained, stateful full-screen overlay (distinct from the one-shot particle FX in
 * fx.ts): when your equity touches the liquidation floor the world drops into a red,
 * desaturated slow-burn — a neon skull ignites, a 2-second fuse ring burns down over it,
 * and the screen edges bleed red. Two resolutions:
 *   - `danger(false)` while active  → you climbed back out: the skull recedes with a green
 *                                     "SURVIVED" flash (you cheated death).
 *   - `kill()`                      → the liquidation landed: the skull shatters.
 *
 * Client-only for now: it reacts to the LOCAL engine equity and the real on-chain outcome.
 * When the on-chain 2s grace lands, the fuse becomes a literal survival window; until then it
 * is the danger telegraph. `pointer-events:none` throughout, so the BAIL button stays live.
 */
export interface DeathsDoor {
  /** gate the whole effect to the Skull car */
  setEnabled(on: boolean): void;
  /** called each live frame — true once equity is at/under the liq floor */
  danger(inDanger: boolean): void;
  /** the liquidation actually settled → shatter */
  kill(): void;
  /** round over / new round / non-skull car → hard reset */
  clear(): void;
}

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    .dd-root{position:fixed;inset:0;z-index:8;pointer-events:none;opacity:0;
      transition:opacity .18s ease;display:flex;align-items:center;justify-content:center;
      will-change:opacity}
    .dd-root.on{opacity:1}
    /* red alert vignette — heavy at the edges, clear centre; breathes while active */
    .dd-vig{position:absolute;inset:0;
      box-shadow:inset 0 0 24vmax 8vmax rgba(255,20,60,.62), inset 0 0 8vmax 0 rgba(255,0,40,.35);
      background:radial-gradient(120% 120% at 50% 46%, transparent 42%, rgba(120,0,20,.28) 78%, rgba(90,0,15,.5) 100%)}
    .dd-root.on .dd-vig{animation:dd-pulse .9s ease-in-out infinite}
    @keyframes dd-pulse{0%,100%{opacity:.72}50%{opacity:1}}
    /* centrepiece: skull + fuse ring */
    .dd-core{position:relative;width:min(58vmin,340px);height:min(58vmin,340px);
      display:flex;align-items:center;justify-content:center;transform:scale(.6);opacity:0;
      transition:transform .28s cubic-bezier(.2,1.4,.35,1), opacity .2s ease}
    .dd-root.on .dd-core{transform:scale(1);opacity:1}
    .dd-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
    /* fuse ring depletes over 2s while active */
    .dd-fuse{stroke-dasharray:var(--c);stroke-dashoffset:0}
    .dd-root.on .dd-fuse{animation:dd-burn 2s linear forwards}
    @keyframes dd-burn{to{stroke-dashoffset:var(--c)}}
    .dd-spark{opacity:0}
    .dd-root.on .dd-spark{opacity:1;animation:dd-spin 2s linear forwards}
    @keyframes dd-spin{to{transform:rotate(360deg)}}
    /* skull: neon outline + igniting eyes */
    .dd-skull{filter:drop-shadow(0 0 10px rgba(255,40,70,.7))}
    .dd-eye{fill:#ff2444;filter:drop-shadow(0 0 6px #ff2444)}
    .dd-root.on .dd-eye{animation:dd-flicker .16s steps(2) infinite}
    @keyframes dd-flicker{0%{opacity:1}100%{opacity:.55}}
    .dd-label{position:absolute;bottom:-9%;left:0;right:0;text-align:center;
      font:800 clamp(15px,3.4vmin,26px)/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.22em;
      color:#ff6a7f;text-shadow:0 0 14px rgba(255,40,70,.8);text-transform:uppercase}
    /* SURVIVED — green flash + pop out */
    .dd-root.survived{animation:dd-survive .7s ease forwards}
    .dd-root.survived .dd-core{transform:scale(1.14);filter:hue-rotate(120deg) saturate(1.3)}
    .dd-root.survived .dd-label{color:#43f5b0;text-shadow:0 0 18px rgba(46,230,166,.9)}
    @keyframes dd-survive{0%{opacity:1}22%{opacity:1;background:radial-gradient(circle at 50% 46%,rgba(46,230,166,.4),transparent 60%)}100%{opacity:0}}
    /* SHATTER — skull cracks apart + red boom */
    .dd-root.shatter .dd-core{animation:dd-crack .5s ease forwards}
    @keyframes dd-crack{0%{transform:scale(1)}18%{transform:scale(1.16)}100%{transform:scale(.55) rotate(8deg);opacity:0;filter:blur(3px) brightness(1.6)}}
    .dd-root.shatter{animation:dd-boom .5s ease forwards}
    @keyframes dd-boom{0%{opacity:1}12%{opacity:1;box-shadow:inset 0 0 30vmax 14vmax rgba(255,30,60,.85)}100%{opacity:0}}
    /* the 3D scene goes cold + desaturated while at death's door */
    #gl.dd-scene{filter:grayscale(.72) contrast(1.16) brightness(.82) saturate(.7);
      transition:filter .22s ease}
  `;
  document.head.appendChild(s);
}

// A stylised neon skull (viewBox 0 0 100 100): cranium + jaw outline, two glowing eye
// sockets, a nose notch and a row of teeth. Drawn once; the eyes flicker via CSS.
const SKULL_SVG = `
  <g class="dd-skull" fill="none" stroke="#ff5069" stroke-width="2.4" stroke-linejoin="round">
    <path d="M50 12 C31 12 20 25 20 42 C20 54 27 60 30 64 L31 74 C31 79 35 82 40 82 L60 82 C65 82 69 79 69 74 L70 64 C73 60 80 54 80 42 C80 25 69 12 50 12 Z"/>
    <circle class="dd-eye" cx="37" cy="45" r="9" stroke="none"/>
    <circle class="dd-eye" cx="63" cy="45" r="9" stroke="none"/>
    <path d="M50 55 l-4 9 h8 z" fill="#ff5069" stroke="none"/>
    <path d="M42 82 v-8 M50 82 v-9 M58 82 v-8" stroke-width="2"/>
  </g>`;

export function createDeathsDoor(): DeathsDoor {
  injectStyles();
  const root = document.createElement("div");
  root.className = "dd-root";
  // fuse ring geometry: r=46 in a 0..100 box → circumference 2πr ≈ 289
  const R = 46, C = (2 * Math.PI * R).toFixed(1);
  root.innerHTML =
    `<div class="dd-vig"></div>
     <div class="dd-core">
       <svg class="dd-svg" viewBox="0 0 100 100" style="--c:${C}">
         <circle cx="50" cy="50" r="${R}" fill="none" stroke="rgba(255,60,90,.18)" stroke-width="3"/>
         <circle class="dd-fuse" cx="50" cy="50" r="${R}" fill="none" stroke="#ff2444" stroke-width="3.4"
           stroke-linecap="round" transform="rotate(-90 50 50)" style="filter:drop-shadow(0 0 5px #ff2444)"/>
         <g class="dd-spark" style="transform-origin:50px 50px"><circle cx="50" cy="${50 - R}" r="3.4" fill="#fff"
           style="filter:drop-shadow(0 0 7px #ff8a3c)"/></g>
         ${SKULL_SVG}
       </svg>
       <div class="dd-label">Death's Door</div>
     </div>`;
  document.body.appendChild(root);
  const label = root.querySelector(".dd-label") as HTMLElement;
  const gl = () => document.getElementById("gl");

  let enabled = false;
  let active = false;   // currently in the death's-door window
  let resolved = false; // survived/shattered this dip — wait for danger to clear before re-arming
  let clearTimer = 0;

  // Restart the CSS animations by removing/re-adding .on (forces the fuse to re-burn).
  const arm = () => {
    root.classList.remove("survived", "shatter");
    label.textContent = "Death's Door";
    void root.offsetWidth; // reflow so the removed animation classes take effect
    root.classList.add("on");
    gl()?.classList.add("dd-scene");
  };
  const disarm = () => {
    root.classList.remove("on", "survived", "shatter");
    gl()?.classList.remove("dd-scene");
  };

  return {
    setEnabled(on) {
      enabled = on;
      if (!on) this.clear();
    },
    danger(inDanger) {
      if (!enabled) return;
      if (inDanger) {
        if (!active && !resolved) { active = true; arm(); }
      } else if (active) {
        // climbed back above the floor before the liq landed → cheated death
        active = false; resolved = true;
        label.textContent = "Survived";
        root.classList.add("survived");
        gl()?.classList.remove("dd-scene");
        clearTimeout(clearTimer);
        clearTimer = window.setTimeout(() => { disarm(); resolved = false; }, 700);
      }
    },
    kill() {
      if (!enabled) return;
      clearTimeout(clearTimer);
      active = false; resolved = true;
      root.classList.add("on"); // ensure visible even if the danger frame never fired
      label.textContent = "Liquidated";
      root.classList.add("shatter");
      gl()?.classList.remove("dd-scene");
      clearTimer = window.setTimeout(() => { disarm(); resolved = false; }, 520);
    },
    clear() {
      clearTimeout(clearTimer);
      active = false; resolved = false;
      disarm();
    },
  };
}
