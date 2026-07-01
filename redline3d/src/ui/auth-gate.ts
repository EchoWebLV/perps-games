export interface AuthGate {
  el: HTMLElement;
  onSignIn(cb: () => void): void;
  show(): void;
  hide(): void;
  setBusy(b: boolean): void;
  setError(msg: string): void;
}

/**
 * Full-screen sign-in gate shown on load. "Sign in" connects the wallet + starts the
 * session (main.ts wires onSignIn → session.init); the game sits behind it until then.
 * Log out (garage menu) calls show() to bring it back. Dev-keypair today; the same slot
 * hosts Privy email/social login when that lands.
 */
export function createAuthGate(parent: HTMLElement): AuthGate {
  const el = document.createElement("div");
  el.className = "auth-gate";
  el.innerHTML =
    '<div class="auth-card">' +
    '<div class="auth-title">PERPS RAIDER</div>' +
    '<div class="auth-sub">Real on-chain perps, skinned as a race. Devnet.</div>' +
    '<button class="auth-btn" type="button">Sign in to play</button>' +
    '<div class="auth-status"></div>' +
    "</div>";
  const style = document.createElement("style");
  style.textContent =
    ".auth-gate{position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999;display:flex;align-items:center;justify-content:center;" +
    "background:radial-gradient(circle at 50% 40%,rgba(20,10,40,.92),rgba(6,4,16,.97));backdrop-filter:blur(6px);}" +
    ".auth-gate[hidden]{display:none;}" +
    ".auth-card{text-align:center;padding:32px 40px;border:1px solid rgba(120,220,255,.25);border-radius:18px;" +
    "background:rgba(10,8,24,.6);box-shadow:0 0 60px rgba(80,200,255,.15);max-width:360px;font-family:inherit;}" +
    ".auth-title{font-size:34px;font-weight:800;letter-spacing:2px;color:#7CFFB2;text-shadow:0 0 18px rgba(124,255,178,.5);}" +
    ".auth-sub{margin:10px 0 24px;color:#9fb3c8;font-size:13px;line-height:1.4;}" +
    ".auth-btn{cursor:pointer;border:none;border-radius:12px;padding:14px 28px;font-size:16px;font-weight:700;" +
    "color:#04121a;background:linear-gradient(90deg,#7CFFB2,#5fe0ff);box-shadow:0 6px 24px rgba(95,224,255,.4);" +
    "transition:transform .08s ease,opacity .2s ease;}" +
    ".auth-btn:active{transform:scale(.97);}" +
    ".auth-btn:disabled{opacity:.5;cursor:default;}" +
    ".auth-status{margin-top:14px;min-height:18px;font-size:12px;color:#ff8fa0;}";
  el.appendChild(style);
  parent.appendChild(el);
  const btn = el.querySelector(".auth-btn") as HTMLButtonElement;
  const status = el.querySelector(".auth-status") as HTMLElement;
  return {
    el,
    onSignIn(cb) { btn.addEventListener("click", cb); },
    show() { el.hidden = false; btn.disabled = false; btn.textContent = "Sign in to play"; status.textContent = ""; },
    hide() { el.hidden = true; },
    setBusy(b) { btn.disabled = b; btn.textContent = b ? "Signing in…" : "Sign in to play"; if (b) status.textContent = ""; },
    setError(msg) { status.textContent = msg; btn.disabled = false; btn.textContent = "Sign in to play"; },
  };
}
