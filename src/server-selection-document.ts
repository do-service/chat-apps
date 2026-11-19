import { createHash } from "node:crypto";
import type { ProxySettings } from "./proxy-settings";

export type ProxyFormState = { current: ProxySettings; needsReset?: boolean };

const stylesheet = `
* { box-sizing: border-box; }
:root { color-scheme: light dark; }
html, body { width: 100%; height: 100%; margin: 0; }
body { background: #fff; color: #20222b; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
main { height: 100%; padding: 32px; overflow: auto; }
section { min-height: 100%; display: flex; flex-direction: column; }
[hidden] { display: none !important; }
.title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
#server-proxy { min-width: 44px; padding: 0; margin: -5px 0 8px; font-size: 20px; }
#proxy-panel p { margin-bottom: 12px; }
#proxy-panel label { margin-top: 10px; }
#proxy-fields { display: grid; grid-template-columns: minmax(0, 1fr) 100px; gap: 12px; }
#proxy-error:empty { min-height: 0; margin: 0; }
#proxy-reset { font-weight: 600; }
h1 { font-size: 25px; line-height: 1.25; letter-spacing: -.65px; margin: 0 0 12px; }
p { margin: 0 0 24px; color: #626979; font-size: 14px; line-height: 1.6; }
label { display: block; margin-bottom: 9px; font-size: 14px; font-weight: 600; }
input, select { width: 100%; height: 46px; padding: 10px 13px; border: 1px solid #a6adbd; border-radius: 10px; background: #f5f6f9; color: inherit; font: inherit; font-size: 15px; }
.hint { margin: 9px 0 0; font-size: 12px; }
.error { min-height: 44px; margin: 10px 0 14px; color: #ac2738; font-size: 13px; overflow-wrap: anywhere; }
.footer { margin-top: auto; padding-top: 14px; display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 10px; }
button { min-height: 44px; padding: 10px 17px; border: 0; border-radius: 10px; background: #f1f3f7; color: #4d5464; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
#server-confirm, #proxy-save { background: #5b65cf; color: #fff; }
button:hover { filter: brightness(.96); }
button:active { filter: brightness(.94); }
button:disabled { cursor: default; opacity: .65; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 3px solid #8994ec; outline-offset: 3px; }
@media (prefers-color-scheme: dark) {
  body { background: #23262f; color: #f1f2f7; }
  p { color: #aeb4c5; }
  input, select { background: #2c303b; border-color: #747e94; }
  button { background: #303540; color: #c0c5d5; }
  #server-confirm, #proxy-save { background: #7d8ae8; color: #151a31; }
  .error { color: #ff9ba9; }
}
`;
const styleHash = createHash("sha256").update(stylesheet).digest("base64");
export const serverSelectionContentSecurityPolicy = `default-src 'none'; script-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'none'`;

function escapedText(value: string): string {
  return value.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function documentShell(title: string, content: string): string {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${serverSelectionContentSecurityPolicy}">
<title>${title}</title><style>${stylesheet}</style></head>
<body><main>${content}</main></body></html>`;
}

function proxyForm({ current, needsReset }: ProxyFormState, inline: boolean, restart: boolean): string {
  const selected = (value: string, active: string) => value === active ? " selected" : "";
  const modes = { default: "По умолчанию", direct: "Без прокси", system: "Системные настройки", http: "HTTP", https: "HTTPS", socks5: "SOCKS5" };
  const manual = "host" in current;
  return `<section id="proxy-panel" aria-labelledby="proxy-title"${inline ? " hidden" : ""}>
<h1 id="proxy-title">Настройки прокси</h1>
<p>«По умолчанию» сохраняет текущее поведение. Системный режим следует правилам ОС, включая исключения для прямого подключения. Внешний браузер использует собственные настройки.</p>
${needsReset ? '<p id="proxy-reset" role="status">Не удалось прочитать сохранённые настройки. Сохраните новые настройки, чтобы восстановить подключение.</p>' : ""}
<label for="proxy-mode">Режим</label>
<select id="proxy-mode" aria-describedby="proxy-error">${Object.entries(modes).map(([value, label]) => `<option value="${value}"${selected(value, current.mode)}>${label}</option>`).join("")}</select>
<div id="proxy-fields"${manual ? "" : " hidden"}>
<div><label for="proxy-host">Хост</label><input id="proxy-host" type="text" dir="ltr" value="${manual ? escapedText(current.host) : ""}" maxlength="253" spellcheck="false" autocomplete="off" autocapitalize="off" aria-describedby="proxy-error"${manual ? "" : " disabled"}></div>
<div><label for="proxy-port">Порт</label><input id="proxy-port" type="text" inputmode="numeric" dir="ltr" value="${manual ? escapedText(String(current.port)) : ""}" maxlength="5" autocomplete="off" aria-describedby="proxy-error"${manual ? "" : " disabled"}></div>
</div>
<label for="proxy-scope">Область применения</label>
<select id="proxy-scope" aria-describedby="proxy-scope-hint proxy-error">
<option value="check"${selected("check", current.scope)}>Только проверка обновлений</option>
<option value="all"${selected("all", current.scope)}>Весь трафик клиента</option>
</select>
<p id="proxy-scope-hint" class="hint">Режим «Только проверка обновлений» не меняет маршрут скачивания. В режиме «Весь трафик клиента» ограничены прямые UDP-соединения WebRTC: звонки и прямая передача файлов могут не работать.</p>
${restart ? '<p class="hint">Изменения применятся после перезапуска. Текущий звонок может прерваться, а несохранённый текст — потеряться.</p>' : ""}
<p id="proxy-error" class="error" role="alert" aria-live="polite"></p>
<div class="footer"><button id="proxy-cancel" type="button">Отмена</button><button id="proxy-save" type="button">${!inline ? "Сохранить и перезапустить" : "Сохранить"}</button></div>
</section>`;
}

export function proxyOnlyDocument(proxy: ProxyFormState): string {
  return documentShell("Настройки прокси", proxyForm(proxy, false, true));
}

export function serverSelectionDocument(initialURL: string, switching: boolean, proxy?: ProxyFormState): string {
  return documentShell("Сервер Чата", `<section id="server-panel" aria-labelledby="server-title">
<div class="title-row"><h1 id="server-title">${switching ? "Сменить сервер" : "Подключиться к Чату"}</h1>
${proxy ? '<button id="server-proxy" type="button" aria-label="Настройки прокси" aria-controls="proxy-panel" aria-expanded="false"><span aria-hidden="true">⚙</span></button>' : ""}</div>
<p>${switching ? "После сохранения приложение будет перезапущено. Текущий звонок может прерваться, а несохранённый текст — потеряться. Сеансы других серверов сохранятся." : "Укажите адрес вашего сервера. Подключение выполняется только по HTTPS. Позже сервер можно сменить в меню приложения."}</p>
<label for="server-url">Адрес сервера</label>
<input id="server-url" type="text" inputmode="url" dir="ltr" value="${escapedText(initialURL)}" maxlength="8192" spellcheck="false" autocomplete="off" autocapitalize="off" aria-describedby="server-hint server-error" autofocus>
<p id="server-hint" class="hint">Только HTTPS-адрес без пути, параметров и данных входа.</p>
<p id="server-error" class="error" role="alert" aria-live="polite"></p>
<div class="footer"><button id="server-cancel" type="button">Отмена</button><button id="server-confirm" type="button">${switching ? "Сохранить и перезапустить" : "Подключиться"}</button></div>
</section>${proxy ? proxyForm(proxy, true, switching) : ""}`);
}
