"use strict";

if (window.top !== window) {
  document.body.textContent = typeof window.chatDesktop === "undefined"
    ? "PASS: bridge не инъецируется напрямую. Same-origin frame всё ещё доверяет parent и может обращаться к parent.chatDesktop."
    : "FAIL: bridge напрямую инъецирован в iframe";
} else {
  const bridge = window.chatDesktop;
  const events = document.getElementById("events");
  const status = document.getElementById("status");
  const lines = [];
  let lastRequest = null;
  let sequence = 0;
  let delayPending = false;

  function log(label, value) {
    lines.unshift(`${new Date().toLocaleTimeString()}  ${label}${value === undefined ? "" : ` ${JSON.stringify(value)}`}`);
    if (lines.length > 100) lines.length = 100;
    events.textContent = lines.join("\n");
  }
  function value(id) { return document.getElementById(id).value; }
  function action(id, fn) {
    document.getElementById(id).addEventListener("click", () => {
      Promise.resolve().then(fn).catch(() => log("Операция отклонена; проверьте ID, account и локальную диагностику"));
    });
  }
  async function show(kind) {
    const request = {
      id: `spike-${Date.now()}-${sequence++}`,
      accountId: value("account"), kind, title: "Chat Desktop Spike",
      body: value("body"),
      route: { chatId: value("chat"), ...(kind === "call" ? { callId: value("call") } : {}) },
      silent: document.getElementById("silent").checked,
      expiresAt: Date.now() + (kind === "call" ? 20_000 : 300_000),
    };
    lastRequest = request;
    log(`Показ ${kind}, event=${request.id}`, await bridge.showNotification(request));
  }

  if (!bridge || bridge.version !== 1) {
    status.textContent = "FAIL: bridge v1 отсутствует. Проверьте preload и запуск с --spike.";
    document.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  } else {
    bridge.onEvent((event) => {
      log("Событие main", event);
      if (event.type === "window-state") document.getElementById("window-state").textContent = JSON.stringify(event.state);
      if (event.type === "activation") {
        document.getElementById("activation").textContent = `account=${event.accountId}; chat=${event.route.chatId}; call=${event.route.callId ?? "—"}; event=${event.id}`;
      }
    });
    (async () => {
      const capabilities = await bridge.getCapabilities();
      document.getElementById("capabilities").textContent = JSON.stringify(capabilities);
      await bridge.setAccount("spike-account");
      await bridge.ready();
      status.textContent = "Bridge v1 готов. Диагностический account: spike-account. Реальные API/WS не подключены.";
      log("Локальная страница готова", capabilities);
    })().catch(() => { status.textContent = "FAIL: bridge handshake отклонён"; });

    action("set-account", async () => { await bridge.setAccount(value("account")); log("Account установлен", value("account")); });
    action("message", () => show("message"));
    action("call-notification", () => show("call"));
    action("duplicate", async () => {
      if (!lastRequest) { log("Сначала создайте уведомление"); return; }
      log("Повтор event ID", await bridge.showNotification(lastRequest));
    });
    action("delayed", () => {
      if (delayPending) return;
      delayPending = true;
      log("Таймер renderer ≥5 с запущен. Скройте/сверните окно; проверьте уведомление и клик ОС");
      setTimeout(() => {
        delayPending = false;
        show("message").catch(() => log("Отложенный тест отклонён"));
      }, 5000);
    });
    action("close-last", async () => {
      if (!lastRequest) return;
      await bridge.closeNotification({ id: lastRequest.id, accountId: lastRequest.accountId });
      log("Последнее уведомление закрыто");
    });
    action("clear", async () => { await bridge.clearNotifications(); log("Уведомления очищены"); });
    action("logout", async () => { await bridge.setAccount(null); await bridge.setBadge(0); log("Account очищен; pending routes и уведомления сброшены"); });
    action("set-badge", async () => { await bridge.setBadge(Number(value("badge"))); log("Badge запрос отправлен; сверяйте capabilities ОС"); });
    action("clear-log", () => { lines.length = 0; events.textContent = ""; });
    action("permission", async () => { log("Browser Notification.permission", await Notification.requestPermission()); });
    action("iframe", () => {
      const host = document.getElementById("iframe-result");
      host.replaceChildren();
      const iframe = document.createElement("iframe");
      iframe.title = "Проверка отсутствия native bridge в подфрейме";
      iframe.src = "chat-spike://app/";
      iframe.addEventListener("load", () => {
        try { log(typeof iframe.contentWindow.chatDesktop === "undefined" ? "PASS: direct iframe bridge отсутствует; parent доступен same-origin по DOM, это не граница безопасности" : "FAIL: direct iframe bridge присутствует"); }
        catch { log("iframe изолирован; проверьте вывод самого frame"); }
      });
      host.append(iframe);
    });
    action("opaque-iframe", () => {
      const host = document.getElementById("iframe-result");
      host.replaceChildren();
      const iframe = document.createElement("iframe");
      iframe.title = "Opaque sandbox iframe без script и same-origin permissions";
      iframe.setAttribute("sandbox", "");
      iframe.src = "chat-spike://app/";
      iframe.addEventListener("load", () => {
        try {
          void iframe.contentWindow.document;
          log("FAIL: opaque sandbox frame допускает чтение document");
        } catch { log("PASS: opaque sandbox frame изолирован same-origin policy; прямой DOM-доступ запрещён"); }
      });
      host.append(iframe);
    });
    action("idp", () => { log("Попытка перехода на чужой origin; ожидается блокировка, диагностика в меню"); window.location.href = "https://idp.invalid/"; });
    action("dangerous", () => { window.open("file:///etc/passwd", "_blank"); log("Попытка file popup; не должно открыться окно/файл"); });
  }
}
