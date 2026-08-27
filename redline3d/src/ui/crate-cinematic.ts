// Presentation-only crate open: drop → shake → rip → card flip. No economics.
// Classic/OG neon — not comic ink. The caller injects the revealed card HTML.

export type CinematicPhase = "idle" | "drop" | "shake" | "rip" | "flip";

export interface CinematicOpts {
  color: string;
  rarity: number;
  cratePng?: string;
  revealHtml?: string;
  /** shake loops while this stays true (VRF wait). When false, finish the rip/flip. */
  pending?: () => boolean;
}

export interface CrateCinematic {
  play(opts: CinematicOpts): Promise<void>;
  phase(): CinematicPhase;
  dispose(): void;
}

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    @keyframes ccDrop{0%{transform:translateY(-42%) scale(.7);opacity:0}100%{transform:none;opacity:1}}
    @keyframes ccShake{0%,100%{transform:translateX(0) rotate(0)}25%{transform:translateX(-7px) rotate(-4deg)}75%{transform:translateX(7px) rotate(4deg)}}
    @keyframes ccRip{0%{transform:scale(1);filter:brightness(1)}40%{transform:scale(1.18);filter:brightness(1.8)}100%{transform:scale(.2);opacity:0}}
    @keyframes ccFlash{0%{opacity:0}30%{opacity:1}100%{opacity:0}}
    @keyframes ccFlip{0%{transform:rotateY(88deg) scale(.86);opacity:0}100%{transform:none;opacity:1}}
    .cc-stage{position:relative;display:grid;place-items:center;min-height:220px;perspective:900px}
    .cc-crate{width:140px;height:140px;border-radius:16px;background:radial-gradient(circle at 40% 30%,rgba(255,255,255,.22),transparent 55%),var(--cc,#c3ccd8);
      box-shadow:0 0 28px color-mix(in srgb,var(--cc) 55%,transparent),inset 0 0 0 1px rgba(255,255,255,.2);
      background-size:cover;background-position:center}
    .cc-crate.drop{animation:ccDrop .38s cubic-bezier(.2,1.2,.3,1) both}
    .cc-crate.shake{animation:ccShake .16s linear infinite}
    .cc-crate.rip{animation:ccRip .28s ease-in forwards}
    .cc-flash{position:absolute;inset:0;background:radial-gradient(circle,rgba(255,255,255,.85),transparent 62%);opacity:0;pointer-events:none}
    .cc-flash.go{animation:ccFlash .32s ease-out}
    .cc-flip{animation:ccFlip .48s cubic-bezier(.22,1.15,.36,1) both;transform-origin:center}
  `;
  document.head.appendChild(s);
}

export function createCrateCinematic(stage: HTMLElement): CrateCinematic {
  injectStyles();
  let current: CinematicPhase = "idle";

  return {
    phase: () => current,
    dispose() { stage.replaceChildren(); current = "idle"; },
    async play(opts) {
      current = "drop";
      const shakeMs = 90 + Math.min(4, Math.max(0, opts.rarity)) * 35;
      stage.innerHTML =
        `<div class="cc-stage">` +
          `<div class="cc-crate drop${opts.cratePng ? "" : ""}" style="--cc:${opts.color}${opts.cratePng ? `;background-image:url(${opts.cratePng})` : ""}"></div>` +
          `<div class="cc-flash"></div>` +
        `</div>`;
      const crate = stage.querySelector(".cc-crate") as HTMLElement;
      const flash = stage.querySelector(".cc-flash") as HTMLElement;
      await wait(380);
      current = "shake";
      crate.classList.remove("drop");
      crate.classList.add("shake");
      if (opts.pending) {
        while (opts.pending()) await wait(120);
      } else {
        await wait(shakeMs);
      }
      current = "rip";
      crate.classList.remove("shake");
      crate.classList.add("rip");
      flash.classList.add("go");
      await wait(260);
      current = "flip";
      if (opts.revealHtml) {
        stage.innerHTML = `<div class="cc-flip">${opts.revealHtml}</div>`;
        await wait(480);
      }
      current = "idle";
    },
  };
}
