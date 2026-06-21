/** Login gate overlay + account row, synthwave styling matched to ui/wallet.ts. */
export function shortWallet(a: string): string {
  return a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export interface AuthGate {
  show(): void;
  hide(): void;
  onLogin(cb: () => void): void;
}

/** A full-screen branded gate shown until authenticated; the CTA calls back to provider.login(). */
export function createAuthGate(parent: HTMLElement): AuthGate {
  const overlay = document.createElement("div");
  overlay.style.cssText = [
    "position:fixed", "inset:0", "z-index:20", "display:none",
    "align-items:center", "justify-content:center",
    "background:radial-gradient(120% 120% at 50% 0%,#1a1547,#0a0820 70%)",
  ].join(";");
  overlay.innerHTML =
    `<div class="panel" style="width:min(360px,92vw);padding:26px 22px;text-align:center;display:flex;flex-direction:column;gap:16px">
       <div class="num" style="font-size:26px;letter-spacing:.04em">PERPS RAIDER</div>
       <div class="lbl" style="opacity:.8">Sign in to race for real coins</div>
       <button id="authcta" class="cta" style="margin-top:4px"><span>SIGN IN</span></button>
     </div>`;
  parent.appendChild(overlay);
  const cta = overlay.querySelector("#authcta") as HTMLButtonElement;
  return {
    show() { overlay.style.display = "flex"; },
    hide() { overlay.style.display = "none"; },
    onLogin(cb) { cta.onclick = cb; },
  };
}
