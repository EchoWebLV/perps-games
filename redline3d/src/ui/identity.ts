/**
 * First-launch identity gate — pick a driver name, then ride as guest or sign in.
 * Guests get straight onto the strip (the wallet stays lazy: their first GO pops the
 * login exactly like today). The name is social identity from second one: it's what
 * the jumbotron prints and what a presence tag will show over the car later.
 */

export interface Identity { name: string; mode: "guest" | "privy" }

export interface IdentityGate {
  el: HTMLElement;
  close(): void;
}

/** normalize a driver name: trim, lowercase; 3-16 chars of [a-z0-9_] — or null */
export function validateName(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  return /^[a-z0-9_]{3,16}$/.test(name) ? name : null;
}

const IDENT_KEY = "raider.identity";

export function loadIdentity(): Identity | null {
  try {
    const raw = localStorage.getItem(IDENT_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return typeof p?.name === "string" && validateName(p.name) ? { name: p.name, mode: p.mode === "privy" ? "privy" : "guest" } : null;
  } catch { return null; }
}

export function saveIdentity(id: Identity): void {
  try { localStorage.setItem(IDENT_KEY, JSON.stringify(id)); } catch { /* private mode — gate shows again next boot */ }
}

/** log out / switch driver: forget who this is so the gate greets the next boot too */
export function clearIdentity(): void {
  try { localStorage.removeItem(IDENT_KEY); } catch { /* ignore */ }
}

export function createIdentityGate(
  parent: HTMLElement,
  opts: {
    /** guests need a driver name — it's all they are */
    onGuest(name: string): void;
    /** run the wallet sign-in. The name is OPTIONAL here (null = none typed): sign-in is
     *  the wallet's email/social auth, not the name — the caller derives a default. */
    onSignIn(name: string | null): Promise<boolean>;
    /** pre-fill the name field (re-opening the gate as an existing rider) */
    prefill?: string;
    /** when set, the gate gets a ✕ (an existing rider peeked at it — let them back out) */
    onDismiss?: () => void;
  },
): IdentityGate {
  const el = document.createElement("div");
  el.style.cssText = [
    "position:fixed", "inset:0", "z-index:30", "display:flex", "align-items:center", "justify-content:center",
    "background:rgba(4,3,14,.72)", "backdrop-filter:blur(3px)", "pointer-events:auto",
    "padding:max(20px,env(safe-area-inset-top)) 18px max(20px,env(safe-area-inset-bottom))",
  ].join(";");

  const card = document.createElement("div");
  card.className = "panel";
  card.style.cssText = "position:relative;width:min(400px,94vw);padding:22px 20px 18px;border-radius:16px;text-align:center;display:flex;flex-direction:column;gap:13px";
  card.innerHTML =
    (opts.onDismiss ? `<button id="idclose" type="button" aria-label="Close"
      style="position:absolute;top:10px;right:10px;width:32px;height:32px;padding:0;display:grid;place-items:center;border-radius:8px;border:1px solid var(--line);background:rgba(12,10,26,.74);color:var(--mut);cursor:pointer;font-size:14px">✕</button>` : "") +
    `<div class="num" style="font-size:26px;letter-spacing:.14em;color:var(--cyan);text-shadow:0 0 18px rgba(39,231,255,.5)">PERPS RIDER</div>` +
    `<div class="lbl" style="letter-spacing:.08em;color:#aeb8dc">pick your driver name</div>` +
    `<input id="idname" maxlength="16" autocomplete="off" spellcheck="false" placeholder="e.g. liq_dodger"
      style="width:100%;box-sizing:border-box;padding:13px 14px;border-radius:11px;border:1px solid var(--line);background:rgba(10,8,22,.85);color:#eef1ff;font:700 17px 'Chakra Petch',ui-monospace,monospace;letter-spacing:.06em;text-align:center;outline:none"/>` +
    `<div id="idmsg" class="lbl" style="min-height:13px;color:#ff9db1"></div>` +
    `<button id="idguest" class="cta" style="width:100%"><span></span><span>RIDE AS GUEST</span></button>` +
    `<button id="idsignin" class="panel" type="button"
      style="width:100%;padding:13px;border-radius:11px;cursor:pointer;background:rgba(12,10,26,.74);color:var(--cyan);font:700 14px 'Chakra Petch',ui-monospace,monospace;letter-spacing:.1em">SIGN IN</button>` +
    `<div class="lbl" style="opacity:.75;line-height:1.6">guests race in <b style="color:#2ee6a6">practice mode</b> — free, no wallet<br>sign in (no name needed) to play for real SOL<br>hold the road to drive · park at <b style="color:#14f195">TRACK</b> to race</div>`;
  el.appendChild(card);
  parent.appendChild(el);

  const input = card.querySelector("#idname") as HTMLInputElement;
  const msg = card.querySelector("#idmsg") as HTMLElement;
  const guestBtn = card.querySelector("#idguest") as HTMLButtonElement;
  const signBtn = card.querySelector("#idsignin") as HTMLButtonElement;

  const takeName = (): string | null => {
    const name = validateName(input.value);
    if (!name) {
      msg.textContent = "3-16 characters: letters, numbers, underscores";
      input.focus();
      return null;
    }
    return name;
  };

  const setBusy = (busy: boolean) => {
    guestBtn.disabled = busy; signBtn.disabled = busy;
    signBtn.textContent = busy ? "CONNECTING…" : "SIGN IN";
    el.style.opacity = busy ? "0.85" : "1";
  };

  const close = () => {
    el.remove();
    // The Privy sign-in flow mounts a cross-origin iframe (auth.privy.io). If it keeps keyboard
    // focus after the modal closes, driving keys are delivered to the IFRAME, not the game's
    // window handlers — WASD goes dead in the lobby AND the race until you click the canvas.
    // Blur a lingering focused iframe so keyboard control returns to the game immediately.
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae.tagName === "IFRAME") ae.blur();
  };

  guestBtn.onclick = () => {
    const name = takeName();
    if (!name) return;
    opts.onGuest(name);
    close();
  };
  signBtn.onclick = async () => {
    // sign-in doesn't need a name — but if one was typed, it must be valid (it'll be kept)
    let name: string | null = null;
    if (input.value.trim()) {
      name = takeName();
      if (!name) return;
    }
    setBusy(true);
    try {
      if (await opts.onSignIn(name)) { close(); return; }
      msg.textContent = "Sign-in didn't finish — try again, or ride as guest.";
    } catch {
      msg.textContent = "Sign-in didn't finish — try again, or ride as guest.";
    }
    setBusy(false);
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") guestBtn.click(); e.stopPropagation(); });
  input.addEventListener("keyup", (e) => e.stopPropagation());
  if (opts.prefill) input.value = opts.prefill;
  const closeBtn = card.querySelector("#idclose") as HTMLButtonElement | null;
  if (closeBtn && opts.onDismiss) closeBtn.onclick = () => { opts.onDismiss!(); close(); };
  setTimeout(() => input.focus(), 50);

  return { el, close };
}
