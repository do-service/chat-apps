import { createHash } from "node:crypto";

const stylesheet = `
* { box-sizing: border-box; }
:root { color-scheme: light dark; }
html, body { width: 100%; height: 100%; margin: 0; }
body { background: #fff; color: #20222b; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
main { height: 100%; display: flex; flex-direction: column; padding: 32px; overflow: auto; }
h1 { font-size: 25px; line-height: 1.25; letter-spacing: -.65px; margin: 0 0 12px; }
p { margin: 0 0 24px; color: #626979; font-size: 14px; line-height: 1.6; }
label { display: block; margin-bottom: 9px; font-size: 14px; font-weight: 600; }
input { width: 100%; height: 46px; padding: 10px 13px; border: 1px solid #a6adbd; border-radius: 10px; background: #f5f6f9; color: inherit; font: inherit; font-size: 15px; }
.hint { margin: 9px 0 0; font-size: 12px; }
.error { min-height: 44px; margin: 10px 0 14px; color: #ac2738; font-size: 13px; overflow-wrap: anywhere; }
.footer { margin-top: auto; padding-top: 14px; display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 10px; }
button { min-height: 44px; padding: 10px 17px; border: 0; border-radius: 10px; background: #f1f3f7; color: #4d5464; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
#server-confirm { background: #5b65cf; color: #fff; }
button:hover { filter: brightness(.96); }
button:active { filter: brightness(.94); }
button:disabled { cursor: default; opacity: .65; }
button:focus-visible, input:focus-visible { outline: 3px solid #8994ec; outline-offset: 3px; }
@media (prefers-color-scheme: dark) {
  body { background: #23262f; color: #f1f2f7; }
  p { color: #aeb4c5; }
  input { background: #2c303b; border-color: #747e94; }
  button { background: #303540; color: #c0c5d5; }
  #server-confirm { background: #7d8ae8; color: #151a31; }
  .error { color: #ff9ba9; }
}
`;
const styleHash = createHash("sha256").update(stylesheet).digest("base64");
export const serverSelectionContentSecurityPolicy = `default-src 'none'; script-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'none'`;

function escapedText(value: string): string {
  return value.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function serverSelectionDocument(initialURL: string, switching: boolean): string {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${serverSelectionContentSecurityPolicy}">
<title>Сервер Чата</title><style>${stylesheet}</style></head>
<body><main aria-labelledby="server-title">
<h1 id="server-title">${switching ? "Сменить сервер" : "Подключиться к Чату"}</h1>
<p>${switching ? "После сохранения приложение будет перезапущено. Текущий звонок может прерваться, а несохранённый текст — потеряться. Сеансы других серверов сохранятся." : "Укажите адрес вашего сервера. Подключение выполняется только по HTTPS. Позже сервер можно сменить в меню приложения."}</p>
<label for="server-url">Адрес сервера</label>
<input id="server-url" type="text" inputmode="url" dir="ltr" value="${escapedText(initialURL)}" maxlength="8192" spellcheck="false" autocomplete="off" autocapitalize="off" aria-describedby="server-hint server-error" autofocus>
<p id="server-hint" class="hint">Только HTTPS-адрес без пути, параметров и данных входа.</p>
<p id="server-error" class="error" role="alert" aria-live="polite"></p>
<div class="footer"><button id="server-cancel" type="button">Отмена</button><button id="server-confirm" type="button">${switching ? "Сохранить и перезапустить" : "Подключиться"}</button></div>
</main></body></html>`;
}
