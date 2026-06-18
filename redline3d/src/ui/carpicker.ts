export interface CarOption { name: string; url: string; }

/** A tiny, easily-hideable car picker for testing different GLB models. */
export function createCarPicker(parent: HTMLElement, cars: CarOption[], onPick: (c: CarOption) => void): void {
  const wrap = document.createElement("div");
  wrap.className = "pe";
  wrap.style.cssText = "position:absolute;top:140px;left:50%;transform:translateX(-50%);z-index:6;display:flex;flex-direction:column;align-items:center;gap:6px";

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.style.cssText = "padding:9px 11px;display:flex;flex-direction:column;gap:6px;min-width:170px";

  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:1px";
  head.innerHTML = `<span class="lbl">car · test</span>`;
  const close = document.createElement("span");
  close.textContent = "✕";
  close.style.cssText = "cursor:pointer;color:var(--mut);font-size:13px;line-height:1;padding:2px 3px";
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
    b.style.cssText = "flex:none;padding:8px 10px;font-size:12px;border-radius:8px;cursor:pointer;text-transform:none;letter-spacing:0";
    b.textContent = c.name;
    b.onclick = () => { onPick(c); mark(b); };
    panel.appendChild(b);
    btns.push(b);
  }
  if (btns[0]) mark(btns[0]);

  // hidden state: a tiny chip to bring it back
  const reopen = document.createElement("div");
  reopen.className = "panel";
  reopen.textContent = "🚗";
  reopen.style.cssText = "display:none;padding:5px 9px;font-size:15px;cursor:pointer;border-radius:9px";

  close.onclick = () => { panel.style.display = "none"; reopen.style.display = "block"; };
  reopen.onclick = () => { panel.style.display = "flex"; reopen.style.display = "none"; };

  wrap.appendChild(panel);
  wrap.appendChild(reopen);
  parent.appendChild(wrap);
}
