# Chat Desktop Spike

Самостоятельная Electron-оболочка для [Chat](https://chat.exz-vps.ru), предназначенная для репозитория `do-service/chat-apps`. Обычная сборка загружает удалённый HTTPS-сайт, а не встроенный frontend. Backend, frontend сайта и инфраструктура в этот репозиторий не входят.

**Статус:** тестовый desktop-клиент с native bridge, не принятый production-релиз. Наличие исходников, успешная сборка или `accepted: true` от API не подтверждают показ уведомления ОС, работу реального IdP либо установленного приложения. План и ограничения приёмки — в [ACCEPTANCE.md](<ACCEPTANCE.md>).

## Границы проекта

- В [app-config.json](<app-config.json>) закреплён origin `https://chat.exz-vps.ru`. Оболочка использует текущую развёрнутую версию этого сайта.
- Экспортированный исходный срез включает D3-совместимый desktop bridge, в том числе выборочное снятие уведомлений. Это **не доказательство**, что соответствующий frontend-адаптер уже развёрнут на сайте. Исходники и deployment сайта — отдельные поставки; эта задача не развёртывает сайт.
- Локальный `--spike` — диагностика уведомлений и lifecycle с искусственными событиями, не offline-версия Chat и не проверка реальных сообщений.
- Сохраняются существующие имя `Chat Desktop Spike`, npm package `chat-desktop-spike`, версия `0.1.0` и app ID `ru.exz-vps.chat.desktop.spike`.
- Публичная доступность репозитория не выдаёт open-source лицензию. В [package.json](<package.json>) остаются `license: UNLICENSED` и `private: true`; последнее запрещает случайную npm-публикацию, а не определяет видимость репозитория.

## Инструменты и локальная проверка

Требуется **Node.js 24.x** (`>=24 <25`); CI закрепляет `24.19.0`. Прямые devDependencies закреплены точными версиями, транзитивный граф — в [package-lock.json](<package-lock.json>):

| Инструмент | Версия |
| --- | --- |
| Electron | 45.2.3 |
| electron-builder | 26.18.0 |
| TypeScript | 5.9.3 |
| esbuild | 0.28.2 |
| @types/node | 24.10.1 |

Команды ниже — инструкции для отдельного проверочного запуска, **не отчёт о выполненных проверках**:

```sh
node --version
npm ci
node -e "require('electron')"
npm run typecheck
npm test
npm run build
npm start
```

`npm ci` устанавливает locked-зависимости; отдельный `require('electron')` завершает lazy download Electron последовательно, до параллельных тестов. `npm test` компилирует тесты в `dist-tests`, `npm run build` — приложение в `dist`; `npm start` повторяет сборку и открывает remote-сайт. Отдельного `lint` script в manifest нет. Не используйте обычный Node.js запуск вместо Electron для приложения.

Обычная сборка встраивает origin из [app-config.json](<app-config.json>). Необязательный `DESKTOP_APP_URL` переопределяет его при сборке или запуске; разрешён только HTTPS origin без credentials, пути, query и fragment. Смена origin создаёт отдельный session-профиль, а не переносит существующий вход. Без валидного origin normal mode завершается ошибкой, а не незаметно переключается в локальную диагностику. Правила — в [src/config.ts](<src/config.ts>) и [scripts/build.mjs](<scripts/build.mjs>).

### Локальная диагностика

```sh
npm run spike
```

Открывается `chat-spike://app/` с кнопками тестовых уведомлений, account switch, TTL, badge и проверками границ bridge. System-browser auth в этом режиме выключен. Для отдельной распакованной диагностической сборки:

```sh
npm run package:spike
```

Её build marker сохраняет diagnostic mode и при холодном запуске без аргумента `--spike`. После диагностики `npm run build` или обычная platform-package команда снова создаёт remote-сборку. Диагностические сборки не являются обычными CI installers.

## Архитектура и безопасность

| Исходник | Назначение |
| --- | --- |
| [src/main.ts](<src/main.ts>) | Окно, session policy, tray/menu, проверка IPC sender, native notifications и auth |
| [src/preload.ts](<src/preload.ts>), [src/contract.ts](<src/contract.ts>) | Ограниченный versioned `window.chatDesktop` API; никаких Node.js или произвольных IPC для сайта |
| [src/security.ts](<src/security.ts>) | Trusted origin/frame, URL и payload validation |
| [src/notifications.ts](<src/notifications.ts>), [src/electron-notifications.ts](<src/electron-notifications.ts>) | Дедупликация, группировка, TTL, activation и best-effort OS history |
| [src/notification-store.ts](<src/notification-store.ts>) | Локальный журнал metadata без title/body уведомлений |
| [src/desktop-auth.ts](<src/desktop-auth.ts>), [src/electron-auth.ts](<src/electron-auth.ts>) | System-browser login, isolated auth attempt и установка/проверка session cookie |
| [src/lifecycle.ts](<src/lifecycle.ts>) | Восстановление скрытого окна после завершения renderer |

Remote renderer работает с sandbox/context isolation, без Node integration и webview. Bridge инъецируется только в trusted top-level frame; main отдельно проверяет источник и аргументы IPC. Чужие origin/IdP нельзя открывать внутри окна. Внешняя HTTPS-ссылка может быть открыта в системном браузере только после подтверждения; cookies приложения туда не передаются.

### Уведомления и lifecycle

Сайт должен обнаружить bridge, связать account, подписаться на события и вызвать `ready()`. Оболочка сама не подключается к message backend и не заменяет frontend notification adapter. Contract версии 1 поддерживает capabilities, auth, account, show/close/clear/dismiss notifications, badge и события activation/window-state/resume.

- Native API support и принятие запроса не гарантируют banner, звук, центр уведомлений или callback ОС. Влияют разрешения, Focus/DND, desktop environment и signing/identity.
- Журнал хранит идентификаторы account/event/chat/call, TTL и OS metadata, но не title/body. Он не является архивом сообщений и всё равно содержит чувствительные идентификаторы; Electron session отдельно хранит cookies сайта.
- Уведомления привязаны к account, дедуплицируются по event ID, заменяются в группе chat/call и ограничены TTL/лимитами. Badge сейчас доступен только на macOS.
- Крестик скрывает окно; при отсутствии tray на Windows/Linux окно сворачивается. Tray/menu/Dock позволяют вернуть окно. Получение событий зависит от живого renderer и подключения сайта.
- **«Выход» / Quit завершает процесс и получение новых событий.** Background push/service после Quit не реализован. Activation уже доставленного уведомления после restart — отдельный best-effort сценарий, не гарантия cold-start на каждой ОС.
- macOS history restoration — best effort. На Windows отсутствует публичный remove-by-ID для старого toast, объект которого потерян после restart; видимый stale toast может остаться, но не должен вести в чужой/истёкший route.

### Вход через системный браузер

Production auth требует совместимого сервера: `/auth/desktop/transactions`, `/auth/desktop/exchange`, `/auth/desktop/ack`, `/auth/desktop/cancel`, страницы `/auth/desktop/authorize`, а также `/api/me` и `/auth/logout`. Desktop-код создаёт proof S256, показывает ограниченный по времени код, открывает системный браузер и ждёт явного подтверждения аккаунта. Сессия проверяется до завершения login; произвольные cookies из браузера не импортируются.

Переход `/auth/login` может запускать эту процедуру для совместимости, но embedded OAuth/IdP fallback запрещён. Наличие кода не доказывает доступность server endpoints или успешность реального IdP: это отдельная ещё не принятая проверка.

### Media и файлы: текущая deny policy

[Session policy](<src/main.ts#L194-L219>) отказывает browser permissions, device permissions, display capture и File System Access. **Камера, микрофон, screen sharing и media-звонки не приняты и сейчас заблокированы**; macOS usage descriptions/entitlements не отменяют runtime deny.

Скачивание допускается только из trusted main frame с same-origin initiator и HTTPS URL, если вся redirect chain остаётся в trusted origin. Используются session приложения и native save dialog. **Blob/P2P/external-origin downloads запрещены**; это не обещание поддержки всех вложений. Uploads, drag-and-drop и системные file-picker сценарии требуют отдельной приёмки.

## Упаковка и тестовые CI artifacts

[Конфигурация упаковки](<electron-builder.yml>) сохраняет ASAR, Electron fuses, существующую identity и локальные иконки. Platform-команды выполняются на соответствующей ОС:

```sh
npm run package:win       # Windows: NSIS x64
npm run package:mac       # macOS: DMG arm64 и x64
npm run package:linux     # Linux: AppImage x64
npm run package:dir       # распакованное приложение текущей ОС
```

Результат появляется в `release`. Базовое имя: `chat-desktop-spike-0.1.0-<os>-<arch>.<ext>`. Для публичного распространения эти команды сами по себе недостаточны: нужны отдельные решения о signing, notarization и установленная OS-приёмка.

[Desktop CI](<.github/workflows/desktop.yml>) предназначен для тестовых native-сборок на стандартных hosted runners:

| Платформа | Hosted runner | Тестовый artifact |
| --- | --- | --- |
| Windows x64 | `windows-2025` | NSIS `.exe` |
| macOS Apple Silicon | `macos-15` | DMG `arm64` |
| macOS Intel | `macos-15` (тот же packaging job) | DMG `x64` |
| Linux x64 | `ubuntu-24.04` | AppImage |

CI выполняет locked install, последовательную инициализацию Electron (до трёх попыток штатного installer с timeout; после неудачи job завершается ошибкой), typecheck, tests, artifact-helper tests, build и packaging. Native Windows/Linux x64 packaging использует уже установленный Electron dist без повторной сетевой загрузки; macOS dual-arch собирается отдельно. Reuse dist может сохранить штатные дополнительные ресурсы Electron, например `default_app.asar`; основной код приложения остаётся в `app.asar`. [Artifact helper](<scripts/artifacts.mjs>) проверяет точный allowlist и создаёт `SHA256SUMS.txt`; его команда — `node scripts/artifacts.mjs windows` (либо `macos`/`linux`) после platform packaging. Он отказывает при существующем checksum manifest, а не перезаписывает его.

Проверка обеих macOS архитектур в packaging не заменяет запуск на обоих типах Mac. macOS CI использует **ad-hoc signing только для теста**, без Developer ID и notarization. CLI overrides `mac.identity=-`, `mac.hardenedRuntime=false`, `mac.notarize=false` относятся только к тестовому job; базовая конфигурация с `hardenedRuntime: true` не меняется. Это не обход Gatekeeper и не подтверждение допуска/показа уведомлений ОС.

Workflow создаёт Actions artifacts `desktop-test-<platform>-<run_id>-<run_attempt>` со сроком хранения **7 дней** для ручной проверки, **не GitHub Release**. Автоматическая публикация отключена (`publish: null`, `--publish never`), updater не подключён. Download artifact из CI не означает, что приложение принято или безопасно для production. Не добавляйте signing keys, cookies, `.env`, локальные профили или credentials в artifacts.

## Приёмка и известные риски

[ACCEPTANCE.md](<ACCEPTANCE.md>) разделяет исходные факты, команды автоматической проверки и ручную matrix. До заполнения evidence остаются непринятыми installed Windows/macOS/Linux, реальный IdP/system-browser flow, сайт с нужным frontend adapter и фактические OS notifications. Автоматические тесты не заменяют эти проверки.

Известная оговорка: отдельный audit от 2026-11-08 сообщил moderate advisory [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) в build-time цепочке `minimatch` через packaging tools; high/critical не зафиксированы. Manifest и lock подтверждают devDependency-цепочку; это не утверждение об exploit в renderer. Подробности — в [ACCEPTANCE.md](<ACCEPTANCE.md>). Исправление/override зависимостей здесь не выполнялись. Audit нужно повторять отдельно; закреплённые версии и отсутствие production npm dependencies не означают «уязвимостей нет».

Документация сверена с экспортированными исходниками и конфигурацией 2026-11-08. Она не переносит результаты прежних запусков и не служит протоколом production deployment.
