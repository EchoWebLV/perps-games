import { tToLev, niceLev } from "../core/leverage";

export interface Tach {
  el: HTMLElement;
  lev(): number;
  onChange(cb: (lev: number) => void): void;
}

export function createTach(parent: HTMLElement): Tach {
  const wrap = document.createElement("div");
  wrap.className = "pe";
  wrap.style.cssText = "position:absolute;left:14px;right:14px;bottom:118px;text-align:center";
  wrap.innerHTML = `
    <div id="levval" style="font-family:ui-monospace,monospace;font-weight:900;font-size:22px;color:#2ee6a6">50×</div>
    <input id="thr" type="range" min="0" max="100" value="34" style="width:100%" />
    <div style="font-size:9px;letter-spacing:.12em;color:#6a76a0;font-weight:800">LEVERAGE</div>`;
  parent.appendChild(wrap);
  const thr = wrap.querySelector("#thr") as HTMLInputElement;
  const val = wrap.querySelector("#levval") as HTMLElement;
  let lev = niceLev(tToLev(+thr.value));
  let cb: (lev: number) => void = () => {};
  const recompute = () => {
    lev = niceLev(tToLev(+thr.value));
    val.textContent = lev + "×";
    val.style.color = lev >= 400 ? "#ff4d6d" : lev >= 170 ? "#ffd166" : "#2ee6a6";
    cb(lev);
  };
  thr.addEventListener("input", recompute);
  recompute();
  return { el: wrap, lev: () => lev, onChange: (fn) => (cb = fn) };
}
