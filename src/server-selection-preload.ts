import { ipcRenderer, type IpcRendererEvent } from "electron";

function argument(prefix: string): string | undefined {
  const matches = process.argv.filter((value) => value.startsWith(prefix));
  const value = matches.length === 1 ? matches[0]?.slice(prefix.length) : undefined;
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

const token = argument("--chat-server-selection-token=");
const documentId = argument("--chat-server-selection-document=");

// This isolated preload owns local DOM events and exposes no API to the main world.
if (process.isMainFrame && window.top === window && token && documentId
    && window.location.href === `chat-server-selection://dialog/${documentId}`) {
  const privateToken = token;
  let active = true;
  let pending = false;
  const cleanup: (() => void)[] = [];
  const dispose = () => {
    active = false;
    for (const remove of cleanup.splice(0)) remove();
  };
  const initialize = () => {
    document.removeEventListener("DOMContentLoaded", initialize);
    if (!active) return;
    const cancel = document.getElementById("server-cancel");
    const confirm = document.getElementById("server-confirm");
    const input = document.getElementById("server-url");
    const error = document.getElementById("server-error");
    if (!(cancel instanceof HTMLButtonElement) || !(confirm instanceof HTMLButtonElement)
        || !(input instanceof HTMLInputElement) || !(error instanceof HTMLElement)) { dispose(); return; }
    const choose = (value: string | null) => {
      if (!active || (pending && value !== null)) return;
      if (value === null) dispose();
      else {
        pending = true;
        confirm.disabled = true;
        error.textContent = "";
        input.removeAttribute("aria-invalid");
      }
      ipcRenderer.send("chat:server-selection-choice", privateToken, value);
    };
    const validationError = (_event: IpcRendererEvent, ...args: unknown[]) => {
      if (!active || !pending || args.length !== 2 || args[0] !== privateToken || typeof args[1] !== "string" || args[1].length > 256) return;
      pending = false;
      confirm.disabled = false;
      error.textContent = args[1];
      input.setAttribute("aria-invalid", "true");
      input.focus();
    };
    ipcRenderer.on("chat:server-selection-error", validationError);
    cleanup.push(() => ipcRenderer.removeListener("chat:server-selection-error", validationError));
    for (const button of [cancel, confirm]) {
      const click = (event: MouseEvent) => { if (event.isTrusted) choose(button === cancel ? null : input.value); };
      button.addEventListener("click", click);
      cleanup.push(() => button.removeEventListener("click", click));
    }
    const focusOrder = [input, cancel, confirm];
    const keydown = (event: KeyboardEvent) => {
      if (!event.isTrusted || !active) return;
      if (event.key === "Escape") { event.preventDefault(); choose(null); }
      if (event.key === "Tab") {
        event.preventDefault();
        const order = focusOrder.filter((element) => !element.disabled);
        const index = order.findIndex((element) => element === document.activeElement);
        const next = index < 0 ? 0 : (index + (event.shiftKey ? -1 : 1) + order.length) % order.length;
        order[next]?.focus();
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (document.activeElement === cancel) choose(null);
        else if (document.activeElement === input || document.activeElement === confirm) choose(input.value);
      }
    };
    document.addEventListener("keydown", keydown);
    cleanup.push(() => document.removeEventListener("keydown", keydown));
    input.focus();
  };
  window.addEventListener("pagehide", dispose);
  cleanup.push(() => window.removeEventListener("pagehide", dispose));
  cleanup.push(() => document.removeEventListener("DOMContentLoaded", initialize));
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize);
  else initialize();
}
