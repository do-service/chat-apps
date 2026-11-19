import { ipcRenderer, type IpcRendererEvent } from "electron";

function argument(prefix: string): string | undefined {
  const matches = process.argv.filter((value) => value.startsWith(prefix));
  const value = matches.length === 1 ? matches[0]?.slice(prefix.length) : undefined;
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

function initializeDialog(token: string) {
  const cleanup: (() => void)[] = [];
  let active = true;
  const dispose = () => {
    active = false;
    for (const remove of cleanup.splice(0)) remove();
  };
  const onClick = (button: HTMLButtonElement, action: () => void) => {
    const click = (event: MouseEvent) => { if (active && event.isTrusted) action(); };
    button.addEventListener("click", click);
    cleanup.push(() => button.removeEventListener("click", click));
  };
  const onReply = (channel: string, reply: (value: unknown) => void) => {
    const receive = (_event: IpcRendererEvent, ...args: unknown[]) => {
      if (active && args.length === 2 && args[0] === token) reply(args[1]);
    };
    ipcRenderer.on(channel, receive);
    cleanup.push(() => ipcRenderer.removeListener(channel, receive));
  };
  const bindServer = (gear: HTMLButtonElement | undefined, proxyIsOpen: () => boolean) => {
    const cancel = document.getElementById("server-cancel");
    const confirm = document.getElementById("server-confirm");
    const input = document.getElementById("server-url");
    const error = document.getElementById("server-error");
    if (!(cancel instanceof HTMLButtonElement) || !(confirm instanceof HTMLButtonElement)
        || !(input instanceof HTMLInputElement) || !(error instanceof HTMLElement)) return;
    const choose = (value: string | null) => {
      if (proxyIsOpen() || (confirm.disabled && value !== null)) return;
      if (value === null) dispose();
      else {
        confirm.disabled = true;
        if (gear) gear.disabled = true;
        error.textContent = "";
        input.removeAttribute("aria-invalid");
      }
      ipcRenderer.send("chat:server-selection-choice", token, value);
    };
    onReply("chat:server-selection-error", (value) => {
      if (!confirm.disabled || typeof value !== "string" || value.length > 256) return;
      confirm.disabled = false;
      if (gear) gear.disabled = false;
      error.textContent = value;
      input.setAttribute("aria-invalid", "true");
      input.focus();
    });
    onClick(cancel, () => choose(null));
    onClick(confirm, () => choose(input.value));
    return { focus: () => input.focus(), order: () => [input, ...(gear ? [gear] : []), cancel, confirm],
      cancel: () => choose(null), enter: (element: Element | null) => {
        if (element === cancel) choose(null);
        else if (element === input || element === confirm) choose(input.value);
      } };
  };
  const bindProxy = (panel: HTMLElement, inline?: { gear: HTMLButtonElement; serverPanel: HTMLElement }) => {
    const mode = document.getElementById("proxy-mode");
    const scope = document.getElementById("proxy-scope");
    const fields = document.getElementById("proxy-fields");
    const host = document.getElementById("proxy-host");
    const port = document.getElementById("proxy-port");
    const error = document.getElementById("proxy-error");
    const save = document.getElementById("proxy-save");
    const cancel = document.getElementById("proxy-cancel");
    if (!(mode instanceof HTMLSelectElement) || !(scope instanceof HTMLSelectElement) || !(fields instanceof HTMLElement)
        || !(host instanceof HTMLInputElement) || !(port instanceof HTMLInputElement) || !(error instanceof HTMLElement)
        || !(save instanceof HTMLButtonElement) || !(cancel instanceof HTMLButtonElement)) return;
    const manual = () => mode.value === "http" || mode.value === "https" || mode.value === "socks5";
    const savedFields = [mode, scope, host, port];
    let baseline = savedFields.map((field) => field.value);
    const updateControls = () => {
      fields.hidden = !manual();
      mode.disabled = scope.disabled = save.disabled;
      host.disabled = port.disabled = fields.hidden || save.disabled;
      cancel.disabled = save.disabled;
    };
    const clearError = () => {
      error.textContent = "";
      host.removeAttribute("aria-invalid");
      port.removeAttribute("aria-invalid");
    };
    const closePanel = () => {
      if (inline) {
        panel.hidden = true;
        inline.serverPanel.hidden = false;
        inline.gear.setAttribute("aria-expanded", "false");
        inline.gear.focus();
      }
    };
    const cancelProxy = () => {
      if (panel.hidden || save.disabled) return;
      if (inline) {
        savedFields.forEach((field, index) => { field.value = baseline[index] ?? ""; });
        updateControls();
        clearError();
        closePanel();
      } else {
        dispose();
        ipcRenderer.send("chat:server-selection-proxy", token, null);
      }
    };
    const invalid = (field: HTMLInputElement, message: string) => {
      error.textContent = message;
      field.setAttribute("aria-invalid", "true");
      field.focus();
    };
    const saveProxy = () => {
      if (panel.hidden || save.disabled) return;
      clearError();
      const value = { mode: mode.value, scope: scope.value };
      let payload: unknown = value;
      if (manual()) {
        if (!host.value.trim()) { invalid(host, "Укажите хост прокси."); return; }
        const number = Number(port.value);
        if (!/^\d{1,5}$/.test(port.value) || number < 1 || number > 65535) {
          invalid(port, "Укажите порт от 1 до 65535."); return;
        }
        payload = { ...value, host: host.value.trim(), port: number };
      }
      save.disabled = true;
      updateControls();
      ipcRenderer.send("chat:server-selection-proxy", token, payload);
    };
    onReply("chat:server-selection-proxy-result", (value) => {
      if (!save.disabled || typeof value !== "boolean") return;
      save.disabled = false;
      updateControls();
      if (!value) {
        error.textContent = "Не удалось сохранить настройки прокси. Проверьте введённые данные и повторите попытку.";
        save.focus();
        return;
      }
      if (!manual()) host.value = port.value = "";
      baseline = savedFields.map((field) => field.value);
      const reset = document.getElementById("proxy-reset");
      if (reset) reset.hidden = true;
      closePanel();
    });
    const modeChanged = (event: Event) => { if (event.isTrusted) { updateControls(); clearError(); } };
    mode.addEventListener("change", modeChanged);
    cleanup.push(() => mode.removeEventListener("change", modeChanged));
    updateControls();
    onClick(save, saveProxy);
    onClick(cancel, cancelProxy);
    const focus = () => mode.focus();
    const open = () => {
      if (inline && !inline.gear.disabled && panel.hidden) {
        panel.hidden = false;
        inline.gear.setAttribute("aria-expanded", "true");
        inline.serverPanel.hidden = true;
        focus();
      }
    };
    if (inline) onClick(inline.gear, open);
    return { focus, open, order: () => [mode, host, port, scope, cancel, save], cancel: cancelProxy,
      enter: (element: Element | null) => {
        if (element === cancel) cancelProxy();
        else if (element === save || element === host || element === port) saveProxy();
      } };
  };
  const initialize = () => {
    document.removeEventListener("DOMContentLoaded", initialize);
    if (!active) return;
    const panel = document.getElementById("proxy-panel");
    const gear = document.getElementById("server-proxy");
    const serverPanel = document.getElementById("server-panel");
    const inline = gear instanceof HTMLButtonElement && serverPanel instanceof HTMLElement ? { gear, serverPanel } : undefined;
    const proxyIsOpen = () => panel instanceof HTMLElement && !panel.hidden;
    const proxy = panel instanceof HTMLElement ? bindProxy(panel, inline) : undefined;
    const server = !proxyIsOpen() ? bindServer(inline?.gear, proxyIsOpen) : undefined;
    if ((panel && !proxy) || (!proxyIsOpen() && !server) || (panel?.hidden && !inline)) { dispose(); return; }
    const keydown = (event: KeyboardEvent) => {
      if (!event.isTrusted || !active) return;
      const controls = proxyIsOpen() ? proxy : server;
      if (!controls) return;
      const focused = document.activeElement;
      if (event.key === "Escape") { event.preventDefault(); controls.cancel(); }
      if (event.key === "Tab") {
        event.preventDefault();
        const order = controls.order().filter((element) => !element.disabled);
        const index = order.findIndex((element) => element === focused);
        const next = index < 0 ? (event.shiftKey ? order.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + order.length) % order.length;
        order[next]?.focus();
      }
      if (event.key === "Enter" && !event.isComposing && !(focused instanceof HTMLSelectElement)) {
        event.preventDefault();
        if (!proxyIsOpen() && focused === inline?.gear) proxy?.open();
        else controls.enter(focused);
      }
    };
    document.addEventListener("keydown", keydown);
    cleanup.push(() => document.removeEventListener("keydown", keydown));
    (proxyIsOpen() ? proxy : server)?.focus();
  };
  window.addEventListener("pagehide", dispose);
  cleanup.push(() => window.removeEventListener("pagehide", dispose));
  cleanup.push(() => document.removeEventListener("DOMContentLoaded", initialize));
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize);
  else initialize();
}

const token = argument("--chat-server-selection-token=");
const documentId = argument("--chat-server-selection-document=");

// This isolated preload owns local DOM events and exposes no API to the main world.
if (process.isMainFrame && window.top === window && token && documentId
    && window.location.href === `chat-server-selection://dialog/${documentId}`) initializeDialog(token);
