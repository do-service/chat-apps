import { ipcRenderer } from "electron";

function argument(prefix: string): string | undefined {
  const matches = process.argv.filter((value) => value.startsWith(prefix));
  const value = matches.length === 1 ? matches[0]?.slice(prefix.length) : undefined;
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

const token = argument("--chat-external-link-token=");
const documentId = argument("--chat-external-link-document=");

// This preload intentionally exposes nothing to the document's main world.
if (process.isMainFrame && window.top === window && token && documentId
    && window.location.href === `chat-external-link://dialog/${documentId}`) {
  const privateToken = token;
  let active = true;
  const cleanup: (() => void)[] = [];
  const dispose = () => {
    active = false;
    for (const remove of cleanup.splice(0)) remove();
  };
  const initialize = () => {
    document.removeEventListener("DOMContentLoaded", initialize);
    if (!active) return;
    const close = document.getElementById("external-close");
    const cancel = document.getElementById("external-cancel");
    const open = document.getElementById("external-open");
    const destination = document.getElementById("external-destination");
    if (!(close instanceof HTMLButtonElement) || !(cancel instanceof HTMLButtonElement) || !(open instanceof HTMLButtonElement)
        || !(destination instanceof HTMLElement)) return;
    const buttons = [close, cancel, open];
    const focusOrder = [close, destination, cancel, open];
    const choose = (confirmed: boolean) => {
      if (!active) return;
      dispose();
      for (const button of buttons) button.disabled = true;
      ipcRenderer.send("chat:external-link-choice", privateToken, confirmed);
    };
    for (const button of buttons) {
      const click = (event: MouseEvent) => { if (event.isTrusted) choose(button === open); };
      button.addEventListener("click", click);
      cleanup.push(() => button.removeEventListener("click", click));
    }
    const keydown = (event: KeyboardEvent) => {
      if (!event.isTrusted || !active) return;
      if (event.key === "Escape") { event.preventDefault(); choose(false); }
      if (event.key === "Tab") {
        event.preventDefault();
        const index = focusOrder.findIndex((element) => element === document.activeElement);
        const next = index < 0 ? 2 : (index + (event.shiftKey ? -1 : 1) + focusOrder.length) % focusOrder.length;
        focusOrder[next]?.focus();
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (buttons.some((button) => button === document.activeElement)) choose(document.activeElement === open);
      }
    };
    document.addEventListener("keydown", keydown);
    cleanup.push(() => document.removeEventListener("keydown", keydown));
    cancel.focus();
  };
  window.addEventListener("pagehide", dispose);
  cleanup.push(() => window.removeEventListener("pagehide", dispose));
  cleanup.push(() => document.removeEventListener("DOMContentLoaded", initialize));
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize);
  else initialize();
}
