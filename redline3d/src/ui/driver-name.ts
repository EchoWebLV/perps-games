import { validateName } from "./identity";

export interface DriverNameDialog {
  el: HTMLElement;
  close(): void;
}

export interface DriverNameDialogOptions {
  currentName: string;
  requiredForHighway: boolean;
  onSave(name: string): Promise<void>;
  onCancel(): void;
}

export function createDriverNameDialog(
  parent: HTMLElement,
  opts: DriverNameDialogOptions,
): DriverNameDialog {
  const el = document.createElement("div");
  el.style.cssText = [
    "position:fixed", "inset:0", "z-index:42", "display:flex", "align-items:center", "justify-content:center",
    "padding:20px", "background:rgba(4,3,14,.78)", "backdrop-filter:blur(3px)", "pointer-events:auto",
  ].join(";");

  const card = document.createElement("div");
  card.className = "panel";
  card.style.cssText = "width:min(400px,94vw);padding:22px 20px 18px;border-radius:16px;text-align:center;display:flex;flex-direction:column;gap:13px";
  card.innerHTML =
    `<div class="num" style="font-size:24px;letter-spacing:.14em;color:var(--cyan)">DRIVER NAME</div>` +
    `<div class="lbl" style="line-height:1.5;color:#cfc4f5">${opts.requiredForHighway ? "Choose a name before entering Highway" : "This name appears above your car"}</div>` +
    `<input id="driver-name-input" aria-label="Driver name" maxlength="16" autocomplete="off" spellcheck="false" placeholder="e.g. liq_dodger"` +
      ` style="width:100%;box-sizing:border-box;padding:13px 14px;border-radius:11px;border:1px solid var(--line);background:rgba(10,8,22,.85);color:#eef1ff;font:700 17px 'Chakra Petch',ui-monospace,monospace;letter-spacing:.06em;text-align:center;outline:none"/>` +
    `<div id="driver-name-message" class="lbl" style="min-height:15px;color:#ff9db1"></div>` +
    `<div style="display:grid;grid-template-columns:1fr 1.4fr;gap:10px">` +
      `<button id="driver-name-cancel" type="button" class="panel" style="padding:13px;cursor:pointer;color:var(--mut)">CANCEL</button>` +
      `<button id="driver-name-save" type="button" class="cta" style="width:100%"><span></span><span>SAVE NAME</span></button>` +
    `</div>`;
  el.appendChild(card);
  parent.appendChild(el);

  const input = card.querySelector("#driver-name-input") as HTMLInputElement;
  const message = card.querySelector("#driver-name-message") as HTMLElement;
  const saveButton = card.querySelector("#driver-name-save") as HTMLButtonElement;
  const cancelButton = card.querySelector("#driver-name-cancel") as HTMLButtonElement;
  input.value = opts.currentName;

  let busy = false;
  const setBusy = (next: boolean) => {
    busy = next;
    input.disabled = next;
    saveButton.disabled = next;
    cancelButton.disabled = next;
    const label = saveButton.querySelector("span:last-child");
    if (label) label.textContent = next ? "SAVING..." : "SAVE NAME";
  };
  const close = () => el.remove();
  const submit = async () => {
    if (busy) return;
    const name = validateName(input.value);
    if (!name) {
      message.textContent = "3-16 characters: letters, numbers, underscores";
      input.focus();
      return;
    }
    message.textContent = "";
    setBusy(true);
    try {
      await opts.onSave(name);
      close();
    } catch {
      message.textContent = "Couldn't save your driver name. Try again.";
      setBusy(false);
      input.focus();
    }
  };

  saveButton.onclick = () => { void submit(); };
  cancelButton.onclick = () => { if (busy) return; opts.onCancel(); close(); };
  input.addEventListener("input", () => { message.textContent = ""; });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); void submit(); }
    event.stopPropagation();
  });
  input.addEventListener("keyup", (event) => event.stopPropagation());
  setTimeout(() => { input.focus(); input.select(); }, 0);

  return { el, close };
}
