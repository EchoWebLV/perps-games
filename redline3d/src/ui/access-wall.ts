/**
 * The access wall — the game's hard front door, now shown AFTER the identity gate (once the player
 * has chosen Ride as Guest or Sign in), not before. A player who hasn't redeemed a code for their
 * CONTEXT hits this: the game title, one centered code field, an UNLOCK button, nothing else. No
 * guest button, no sign-in, no name field — the gate already owns those. Redemption is context-aware
 * and the wall reacts to either shape: a GUEST redeems locally (a durable per-browser flag, resolved
 * SYNCHRONOUSLY), while a SIGNED-IN player redeems against their ACCOUNT (a server round-trip, a
 * Promise — the unlock then follows them to any device). A valid code (see core/access-code)
 * dismisses the wall for good and hands back to the caller, which resumes the boot it deferred (the
 * welcome gift / crate). The wall never auto-enters as guest.
 *
 * Blocking the game behind the wall reuses the identity gate's suppression mechanism, no new system:
 *  - a full-screen `pointer-events:auto` overlay swallows canvas touches (the drive-anywhere joystick),
 *  - the auto-focused code field makes driving keys yield — controls.ts suppresses WASD/Space/Enter
 *    whenever a genuine text input holds focus (isTextEntry(document.activeElement)),
 *  - the field stops its own key events from bubbling, and the backdrop won't steal focus on a click,
 *    so the field keeps focus and the keyboard stays suppressed the whole time we're walled.
 * The near-opaque backdrop hides the world entirely (not the gate's peek-through blur).
 */

import type { RedeemResult } from "../core/access-code";

export interface AccessWall {
  el: HTMLElement;
  /** tear the wall down (also called internally once a valid code unlocks). */
  close(): void;
}

export function createAccessWall(
  parent: HTMLElement,
  opts: {
    /** redeem a typed code → "granted" | "already" | "invalid". Delegated to the caller, which owns
     *  the grant seams (inventory + coins); the wall only reacts to the outcome. Guest-local redeem
     *  resolves SYNCHRONOUSLY; the signed-in account redeem is a server round-trip (a Promise). */
    onRedeem(code: string): RedeemResult | Promise<RedeemResult>;
    /** fired exactly once when a valid code unlocks the wall — the caller lands the player in-world. */
    onUnlocked(): void;
  },
): AccessWall {
  const el = document.createElement("div");
  el.style.cssText = [
    "position:fixed", "inset:0", "z-index:40", "display:flex", "align-items:center", "justify-content:center",
    // near-opaque + blur: the world is HIDDEN behind the wall (a wall, not the gate's peek-through gauze)
    "background:rgba(5,3,13,.965)", "backdrop-filter:blur(8px)", "pointer-events:auto",
    "padding:max(20px,env(safe-area-inset-top)) 18px max(20px,env(safe-area-inset-bottom))",
  ].join(";");

  const card = document.createElement("div");
  card.className = "panel";
  card.style.cssText = "position:relative;width:min(400px,94vw);padding:26px 22px 22px;border-radius:16px;text-align:center;display:flex;flex-direction:column;gap:15px";
  card.innerHTML =
    `<div class="num" style="font-size:28px;letter-spacing:.14em;color:var(--cyan);text-shadow:0 0 18px rgba(39,231,255,.5)">PERPS RAIDER</div>` +
    `<div class="lbl" style="letter-spacing:.08em;color:#aeb8dc">enter your access code to play</div>` +
    `<input id="awcode" maxlength="24" autocomplete="off" spellcheck="false" placeholder="access code"
      style="width:100%;box-sizing:border-box;padding:14px 15px;border-radius:11px;border:1px solid var(--line);background:rgba(10,8,22,.85);color:#eef1ff;font:700 18px 'Chakra Petch',ui-monospace,monospace;letter-spacing:.12em;text-align:center;outline:none"/>` +
    `<div id="awmsg" class="lbl" style="min-height:13px;color:#ff9db1"></div>` +
    `<button id="awgo" class="cta" style="width:100%"><span></span><span>UNLOCK</span></button>`;
  el.appendChild(card);
  parent.appendChild(el);

  const input = card.querySelector("#awcode") as HTMLInputElement;
  const msg = card.querySelector("#awmsg") as HTMLElement;
  const go = card.querySelector("#awgo") as HTMLButtonElement;

  let unlocked = false;
  let busy = false; // true while an async (account) redeem is in flight — blocks a concurrent re-submit
  const close = () => { el.remove(); };

  // React to a resolved outcome: a valid code (granted OR already) drops the wall and hands back to
  // boot; an invalid code shows a brief inline note and stays walled for a retry.
  const apply = (res: RedeemResult) => {
    if (res === "granted" || res === "already") {
      unlocked = true;
      opts.onUnlocked(); // hand back to boot → the identity path resumes (NOT auto-guest)…
      close();           // …then drop the wall so what it revealed is the front-most screen
      return;
    }
    msg.textContent = "invalid code"; // brief inline state; cleared on the next edit
    input.select();
  };

  const submit = () => {
    if (unlocked || busy) return;
    if (!input.value.trim()) { input.focus(); return; }
    const out = opts.onRedeem(input.value);
    if (typeof out === "string") { apply(out); return; } // guest-local redeem — synchronous
    // account redeem — a server round-trip. Lock the field + button until it resolves so a second
    // Enter/tap can't fire a duplicate redeem mid-flight.
    busy = true;
    go.disabled = true;
    void (async () => {
      try {
        apply(await out);
      } catch {
        msg.textContent = "couldn't reach the server — try again"; // let them retry
        input.select();
      } finally {
        if (!unlocked) { busy = false; go.disabled = false; } // re-arm (unless we just unlocked + closed)
      }
    })();
  };

  go.onclick = submit;
  // The field owns Enter (submit) and must NOT fall through to the game's global key handlers behind
  // the wall (controls.ts drives on Space/Enter/WASD via a capture-phase window listener).
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); submit(); return; }
    if (msg.textContent) msg.textContent = "";
  });
  input.addEventListener("keyup", (e) => e.stopPropagation());
  // Clicking the bare backdrop must not blur the field (a blurred field would wake WASD behind the
  // wall). Only guard the backdrop itself — clicks on the card / button / input keep working.
  el.addEventListener("mousedown", (e) => { if (e.target === el) e.preventDefault(); });
  setTimeout(() => input.focus(), 50);

  return { el, close };
}
