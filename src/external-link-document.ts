import { createHash } from "node:crypto";

const stylesheet = `
* { box-sizing: border-box; }
:root { color-scheme: light dark; }
html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
body { color: #20222b; background: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
.dialog { position: relative; height: 100%; display: grid; grid-template-rows: minmax(0, 1fr) auto; }
.close { position: absolute; right: 18px; top: 18px; width: 30px; height: 30px; display: grid; place-items: center; color: #737b8b; border: 0; background: transparent; border-radius: 8px; }
.content { min-height: 0; padding: 32px 30px 28px; display: flex; flex-direction: column; overflow: hidden; }
.hero-icon { flex: 0 0 60px; width: 60px; border-radius: 19px; background: #eef0ff; color: #5865cc; display: grid; place-items: center; margin-bottom: 25px; }
h1 { flex-shrink: 0; margin: 0 0 11px; font-size: 25px; line-height: 1.25; font-weight: 650; letter-spacing: -.65px; }
.description { flex-shrink: 0; margin: 0; font-size: 14px; line-height: 1.55; color: #707584; }
.destination { min-height: 48px; margin-top: 25px; padding: 17px 18px; border-radius: 13px; background: #f5f6f9; overflow: auto; }
.domain { display: flex; align-items: flex-start; gap: 9px; color: #303340; font-size: 16px; font-weight: 600; letter-spacing: -.2px; }
.domain svg { color: #969bab; flex: 0 0 auto; margin-top: 1px; }
bdi { unicode-bidi: isolate; overflow-wrap: anywhere; }
.domain bdi { min-width: 0; }
.url { margin: 9px 0 0 27px; color: #697181; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; direction: ltr; }
.note { flex-shrink: 0; display: flex; align-items: flex-start; gap: 7px; margin: 17px 2px 0; font-size: 12px; line-height: 1.5; color: #6f7685; }
.note svg { flex: 0 0 auto; margin-top: 1px; }
.footer { padding: 20px 30px 24px; display: grid; grid-template-columns: 1fr 1.85fr; gap: 10px; border-top: 1px solid #f0f1f5; }
.button { height: 44px; border: none; border-radius: 11px; font-family: inherit; font-size: 13px; font-weight: 600; display: flex; justify-content: center; align-items: center; gap: 8px; white-space: nowrap; }
button { cursor: pointer; }
button:focus-visible, .destination:focus-visible { outline: 3px solid #8994ec; outline-offset: 3px; }
button:disabled { cursor: default; }
.cancel { background: #f1f3f7; color: #686e7c; }
.open { background: #5b65cf; color: #fff; }
.close:hover, .cancel:hover { filter: brightness(.96); }
.open:hover { filter: brightness(1.07); }
.button:active, .close:active { filter: brightness(.94); }
@media (prefers-color-scheme: dark) {
  body { background: #23262f; color: #f1f2f7; }
  .hero-icon { background: #30354f; color: #a0aaf6; }
  .description { color: #999eaf; }
  .destination { background: #2c303b; }
  .domain { color: #e4e7f1; }
  .domain svg { color: #8f96aa; }
  .url { color: #939aae; }
  .note, .close { color: #9097aa; }
  .footer { border-top-color: #30343e; }
  .cancel { background: #303540; color: #c0c5d5; }
  .open { background: #7d8ae8; color: #151a31; }
}
`;
const styleHash = createHash("sha256").update(stylesheet).digest("base64");
export const externalLinkContentSecurityPolicy = `default-src 'none'; script-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'none'`;

function escapedText(value: string): string {
  // Direction controls can disguise the destination even inside an LTR isolate.
  return value.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function externalLinkDocument(url: string): string {
  const host = new URL(url).host;
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${externalLinkContentSecurityPolicy}">
<title>Открыть в браузере?</title><style>${stylesheet}</style></head>
<body><main class="dialog" role="dialog" aria-modal="true" aria-labelledby="external-title" aria-describedby="external-description">
<button id="external-close" class="close" type="button" aria-label="Закрыть"><svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
<div class="content">
<div class="hero-icon"><svg aria-hidden="true" width="29" height="29" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9"/><path d="M10 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4"/></svg></div>
<h1 id="external-title">Открыть в браузере?</h1>
<p id="external-description" class="description">Вы переходите на внешний сайт.<br>Ссылка откроется за пределами Чата.</p>
<div id="external-destination" class="destination" role="group" tabindex="0" aria-label="Адрес внешнего сайта"><div class="domain"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></svg><bdi dir="ltr">${escapedText(host)}</bdi></div><p class="url"><bdi dir="ltr">${escapedText(url)}</bdi></p></div>
<p class="note"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>Сеанс входа в Чат не передаётся сайту.</p>
</div>
<div class="footer"><button id="external-cancel" class="button cancel" type="button" autofocus>Отмена</button><button id="external-open" class="button open" type="button">Открыть в браузере<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M7 7h10v10"/></svg></button></div>
</main></body></html>`;
}
