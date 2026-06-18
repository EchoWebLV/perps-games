export interface CarOption { name: string; url: string; scale?: number; }

export function setHudMenuMode(parent: HTMLElement, menuRoot: HTMLElement, open: boolean): void {
  for (const child of Array.from(parent.children) as HTMLElement[]) {
    if (child === menuRoot) continue;
    child.style.display = open ? "none" : "";
  }
}

/** Full-screen game menu. Keeps the scene visible under an 80% black veil. */
export function createCarPicker(parent: HTMLElement, cars: CarOption[], onPick: (c: CarOption) => void): void {
  const wrap = document.createElement("div");
  wrap.className = "pe";
  wrap.style.cssText = "position:absolute;top:calc(50% - 21px);right:max(12px,env(safe-area-inset-right));z-index:8;display:block";

  const overlay = document.createElement("div");
  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:9",
    "display:none",
    "align-items:center",
    "justify-content:center",
    "padding:max(22px,env(safe-area-inset-top)) max(18px,env(safe-area-inset-right)) max(22px,env(safe-area-inset-bottom)) max(18px,env(safe-area-inset-left))",
    "background:rgba(0,0,0,.8)",
    "backdrop-filter:blur(2px)",
    "pointer-events:auto",
  ].join(";");

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.style.cssText = [
    "width:min(360px,92vw)",
    "padding:16px",
    "display:flex",
    "flex-direction:column",
    "gap:10px",
    "background:rgba(12,10,26,.86)",
    "border-color:rgba(132,150,224,.28)",
    "pointer-events:auto",
  ].join(";");

  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:2px";
  head.innerHTML = `<span class="lbl">garage</span>`;
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "Close menu");
  close.textContent = "x";
  close.style.cssText = "cursor:pointer;color:var(--mut);font:700 16px/1 Chakra Petch,ui-monospace,monospace;padding:3px 5px;border:0;background:transparent";
  head.appendChild(close);
  panel.appendChild(head);

  const btns: HTMLElement[] = [];
  const mark = (active: HTMLElement) => {
    for (const b of btns) { b.style.borderColor = "var(--line2)"; b.style.color = "var(--mut)"; b.style.background = "rgba(12,10,26,.55)"; }
    active.style.borderColor = "var(--grn)"; active.style.color = "var(--grn)"; active.style.background = "rgba(46,230,166,.16)";
  };
  for (const c of cars) {
    const b = document.createElement("div");
    b.className = "seg";
    b.style.cssText = "flex:none;padding:11px 12px;font-size:13px;border-radius:8px;cursor:pointer;text-transform:none;letter-spacing:0;text-align:left";
    b.textContent = c.name;
    b.onclick = () => { onPick(c); mark(b); };
    panel.appendChild(b);
    btns.push(b);
  }
  if (btns[0]) mark(btns[0]);

  const menuButton = document.createElement("button");
  menuButton.type = "button";
  menuButton.setAttribute("aria-label", "Open menu");
  menuButton.className = "panel";
  menuButton.style.cssText = [
    "width:42px",
    "height:42px",
    "padding:0",
    "display:grid",
    "place-items:center",
    "border-radius:9px",
    "cursor:pointer",
    "background:rgba(12,10,26,.74)",
  ].join(";");
  menuButton.innerHTML = `<span style="display:flex;flex-direction:column;gap:5px;width:18px">
    <span style="height:2px;background:var(--ink);border-radius:2px;box-shadow:0 0 8px rgba(39,231,255,.45)"></span>
    <span style="height:2px;background:var(--ink);border-radius:2px;box-shadow:0 0 8px rgba(39,231,255,.45)"></span>
    <span style="height:2px;background:var(--ink);border-radius:2px;box-shadow:0 0 8px rgba(39,231,255,.45)"></span>
  </span>`;

  const setOpen = (open: boolean) => {
    overlay.style.display = open ? "flex" : "none";
    menuButton.style.display = open ? "none" : "grid";
    setHudMenuMode(parent, wrap, open);
  };

  close.onclick = () => setOpen(false);
  menuButton.onclick = () => setOpen(true);
  overlay.onclick = (e) => { if (e.target === overlay) setOpen(false); };
  addEventListener("keydown", (e) => { if (e.key === "Escape" && overlay.style.display !== "none") setOpen(false); });

  overlay.appendChild(panel);
  wrap.appendChild(menuButton);
  wrap.appendChild(overlay);
  parent.appendChild(wrap);
}
