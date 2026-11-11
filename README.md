# Chat Desktop Spike

Самостоятельная Electron-оболочка для [Chat](https://chat.exz-vps.ru), предназначенная для репозитория `do-service/chat-apps`. Обычная сборка загружает удалённый HTTPS-сайт, а не встроенный frontend. Backend, frontend сайта и инфраструктура в этот репозиторий не входят.

**Статус:** тестовый desktop-клиент с native bridge, не принятый production-релиз. Наличие исходников, успешная сборка или `accepted: true` от API не подтверждают показ уведомления ОС, работу реального IdP либо установленного приложения. План и ограничения приёмки — в [ACCEPTANCE.md](<ACCEPTANCE.md>).

## Границы проекта

- В [app-config.json](<app-config.json>) закреплён origin `https://chat.exz-vps.ru`. Оболочка использует текущую развёрнутую версию этого сайта.
- Desktop bridge поддерживает выборочное снятие уведомлений и явное macOS-согласие на native notifications. Для полного сценария нужны **обе поставки**: новая оболочка с native addon и совместимый развёрнутый frontend-адаптер. Этот репозиторий не содержит и не развёртывает сайт; состав desktop-сборки не доказывает версию remote frontend или end-to-end результат.
- Локальный `--spike` — диагностика уведомлений и lifecycle с искусственными событиями, не offline-версия Chat и не проверка реальных сообщений.
- Версия preview — `0.1.1-preview.1`. Сохраняются существующие имя `Chat Desktop Spike`, npm package `chat-desktop-spike`, app ID `ru.exz-vps.chat.desktop.spike` и профиль/session partition. Обновление не сбрасывает сохранённые предпочтения пользователя.
- Публичная доступность репозитория не выдаёт open-source лицензию. В [package.json](<package.json>) остаются `license: UNLICENSED` и `private: true`; последнее запрещает случайную npm-публикацию, а не определяет видимость репозитория.

## Preview и загрузки

Готовится публичный **`v0.1.1-preview.1`**, не production-релиз. На момент подготовки этой документации публикация и новая CI-сборка **ещё не подтверждены**. [Страница prerelease](https://github.com/do-service/chat-apps/releases/tag/v0.1.1-preview.1) и прямые ссылки ниже — **ожидаемые адреса после публикации**, до неё могут возвращать 404. Не подменяйте эту версию старыми Actions artifacts `0.1.0`; `/releases/latest` не является адресом preview.

| Платформа | Ожидаемый installer |
| --- | --- |
| Windows x64 | [NSIS .exe](https://github.com/do-service/chat-apps/releases/download/v0.1.1-preview.1/chat-desktop-spike-0.1.1-preview.1-win-x64.exe) |
| macOS Apple Silicon | [DMG arm64](https://github.com/do-service/chat-apps/releases/download/v0.1.1-preview.1/chat-desktop-spike-0.1.1-preview.1-mac-arm64.dmg) |
| macOS Intel | [DMG x64](https://github.com/do-service/chat-apps/releases/download/v0.1.1-preview.1/chat-desktop-spike-0.1.1-preview.1-mac-x64.dmg) |
| Linux x64 | [AppImage x86_64](https://github.com/do-service/chat-apps/releases/download/v0.1.1-preview.1/chat-desktop-spike-0.1.1-preview.1-linux-x86_64.AppImage) |
| Контрольные суммы | [SHA256SUMS.txt — все четыре installer](https://github.com/do-service/chat-apps/releases/download/v0.1.1-preview.1/SHA256SUMS.txt) |

Сверьте SHA-256 до установки. Preview не имеет доверенной Windows-подписи; macOS использует ad-hoc signing, **без Developer ID и notarization**. Возможны SmartScreen/Gatekeeper warnings или отказ запуска. Не отключайте защиты ОС ради запуска; зафиксируйте отказ как ограничение. Updater не подключён, обновление — вручную.

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

На macOS build дополнительно компилирует [native addon](<native/notification-permission.mm>) через [build-native script](<scripts/build-native.mjs>): нужны установленные Command Line Tools/macOS SDK, `clang++` и локальные Node-API headers (`node_api.h`). При нестандартном расположении headers задайте `NODE_API_INCLUDE` на установленный include-каталог. Script не скачивает headers и завершает build ошибкой, если prerequisites отсутствуют. Addon — универсальный `arm64` + `x86_64`, Node-API 8, без новых npm dependencies; в пакете он лежит вне ASAR как `dist/notification-permission.node`. На Windows/Linux этот macOS addon не собирается.

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
| [src/notification-permission.ts](<src/notification-permission.ts>), [native addon](<native/notification-permission.mm>) | macOS query/request notification permission в main process; отказ/неизвестность не считаются согласием |
| [src/media-permissions.ts](<src/media-permissions.ts>) | Отдельное macOS OS-consent для микрофона и камеры только доверенного live main frame |

Remote renderer работает с sandbox/context isolation, без Node integration и webview. Bridge инъецируется только в trusted top-level frame; main отдельно проверяет источник и аргументы IPC. Чужие origin/IdP нельзя открывать внутри окна. Внешняя HTTPS-ссылка может быть открыта в системном браузере только после подтверждения; cookies приложения туда не передаются.

### Уведомления и lifecycle

Сайт должен обнаружить bridge, связать account, подписаться на события и вызвать `ready()`. Оболочка сама не подключается к message backend и не заменяет frontend notification adapter. Contract версии 1 поддерживает capabilities, auth, account, show/close/clear/dismiss notifications, badge и события activation/window-state/resume.

- Native API support и принятие запроса не гарантируют banner, звук, центр уведомлений или callback ОС. Влияют разрешения, Focus/DND, desktop environment и signing/identity.
- Журнал хранит идентификаторы account/event/chat/call, TTL и OS metadata, но не title/body. Он не является архивом сообщений и всё равно содержит чувствительные идентификаторы; Electron session отдельно хранит cookies сайта.
- Уведомления привязаны к account, дедуплицируются по event ID, заменяются в группе chat/call и ограничены TTL/лимитами. Badge сейчас доступен только на macOS.
- На macOS `Cmd+M` использует стандартную menu role `minimize`, `Cmd+H` — `hide`; это разные действия, не глобальные hotkeys. `Cmd+W`/крестик скрывают окно, `Cmd+Q` завершает приложение. На Windows/Linux крестик скрывает окно, а при отсутствии tray — сворачивает; macOS roles туда не добавляются. Tray/menu/Dock позволяют вернуть окно. Получение событий зависит от живого renderer и подключения сайта.
- **«Выход» / Quit завершает процесс и получение новых событий.** Background push/service после Quit не реализован. Activation уже доставленного уведомления после restart — отдельный best-effort сценарий, не гарантия cold-start на каждой ОС.
- macOS history restoration — best effort. На Windows отсутствует публичный remove-by-ID для старого toast, объект которого потерян после restart; видимый stale toast может остаться, но не должен вести в чужой/истёкший route.

### Явное macOS-согласие на уведомления

Совместимый frontend запрашивает native permission только после явного действия пользователя — например, включения уведомлений в настройках. Main проверяет текущий trusted document/account и foreground-окно; addon читает/запрашивает разрешение через macOS UserNotifications. Query при запуске не вызывает новый OS prompt. Только фактический `granted` допускает отправку через новый macOS flow; отсутствие addon, timeout или ошибка дают `unknown`, а не фиктивное согласие. При `denied` совместимый UI может предложить открыть настройки уведомлений ОС.

**Обновление не гарантирует новый startup offer или первый системный диалог.** Сохранённые «включено», «выключено» или закрытое предложение остаются в прежнем профиле; frontend учитывает их при onboarding. Уже принятый/запрещённый OS consent также не обязан показывать повторный диалог. Смена версии не создаёт новую app identity. Windows/Linux не получают этот macOS consent API и не объявляют OS permission `granted` по одному `isSupported()`.

### Вход через системный браузер

Production auth требует совместимого сервера: `/auth/desktop/transactions`, `/auth/desktop/exchange`, `/auth/desktop/ack`, `/auth/desktop/cancel`, страницы `/auth/desktop/authorize`, а также `/api/me` и `/auth/logout`. Desktop-код создаёт proof S256, показывает ограниченный по времени код, открывает системный браузер и ждёт явного подтверждения аккаунта. Сессия проверяется до завершения login; произвольные cookies из браузера не импортируются.

Переход `/auth/login` может запускать эту процедуру для совместимости, но embedded OAuth/IdP fallback запрещён. Наличие кода не доказывает доступность server endpoints или успешность реального IdP: это отдельная ещё не принятая проверка.

### Media и файлы: разрешённый минимум и deny boundaries

[Session policy](<src/main.ts>) и [media policy](<src/media-permissions.ts>) допускают микрофон и камеру **только на macOS**, в обычной remote-сборке, по запросу текущего trusted HTTPS main frame и после отдельного OS consent каждого устройства. Согласие на микрофон не даёт доступ к камере; комбинированный запрос требует оба разрешения и повторную проверку актуальности документа. Это реализация policy, **не приёмка реального звонка/камеры**.

**Windows/Linux: микрофон и камера остаются DENY.** На всех платформах browser notifications, device permissions, screen sharing/display capture и File System Access запрещены; diagnostic mode не даёт media-доступ. Usage descriptions/entitlements сами по себе ничего не разрешают.

Скачивание допускается только из trusted main frame с same-origin initiator и HTTPS URL, если вся redirect chain остаётся в trusted origin. Используются session приложения и native save dialog. **Blob/P2P/external-origin downloads запрещены**; это не обещание поддержки всех вложений. Uploads, drag-and-drop и системные file-picker сценарии требуют отдельной приёмки.

## Упаковка и тестовые CI artifacts

[Конфигурация упаковки](<electron-builder.yml>) сохраняет ASAR, Electron fuses, существующую identity и локальные иконки. Platform-команды выполняются на соответствующей ОС:

```sh
npm run package:win       # Windows: NSIS x64
npm run package:mac       # macOS: DMG arm64 и x64
npm run package:linux     # Linux: AppImage x64
npm run package:dir       # распакованное приложение текущей ОС
```

Результат появляется в `release`. Базовое имя: `chat-desktop-spike-0.1.1-preview.1-<os>-<arch>.<ext>` (Linux x64 расширяется packager-ом как `x86_64`). Для публичного распространения эти команды сами по себе недостаточны: нужны отдельные решения о signing, notarization и установленная OS-приёмка.

[Desktop CI](<.github/workflows/desktop.yml>) предназначен для тестовых native-сборок на стандартных hosted runners:

| Платформа | Hosted runner | Тестовый artifact |
| --- | --- | --- |
| Windows x64 | `windows-2025` | NSIS `.exe` |
| macOS Apple Silicon | `macos-15` | DMG `arm64` |
| macOS Intel | `macos-15` (тот же packaging job) | DMG `x64` |
| Linux x64 | `ubuntu-24.04` | AppImage |

CI выполняет locked install, последовательную инициализацию Electron (до трёх попыток штатного installer с timeout; после неудачи job завершается ошибкой), typecheck, tests, artifact-helper tests, build и packaging. Native Windows/Linux x64 packaging использует уже установленный Electron dist без повторной сетевой загрузки; macOS dual-arch собирается отдельно. Reuse dist может сохранить штатные дополнительные ресурсы Electron, например `default_app.asar`; основной код приложения остаётся в `app.asar`. [Artifact helper](<scripts/artifacts.mjs>) проверяет точный allowlist и создаёт `SHA256SUMS.txt`; его команда — `node scripts/artifacts.mjs windows` (либо `macos`/`linux`) после platform packaging. Он отказывает при существующем checksum manifest, а не перезаписывает его.

Проверка обеих macOS архитектур в packaging не заменяет запуск на обоих типах Mac. macOS CI использует **ad-hoc signing только для теста**, без Developer ID и notarization. CLI overrides `mac.identity=-`, `mac.hardenedRuntime=false`, `mac.notarize=false` относятся только к тестовому job; базовая конфигурация с `hardenedRuntime: true` не меняется. Это не обход Gatekeeper и не подтверждение допуска/показа уведомлений ОС.

Workflow создаёт Actions artifacts `desktop-test-<platform>-<run_id>-<run_attempt>` со сроком хранения **7 дней** для ручной проверки, **не GitHub Release**. Публичный preview публикуется отдельным ручным release-шагом только после проверки новой сборки и всех четырёх installers/checksums; сам workflow не создаёт Release. Автоматическая публикация отключена (`publish: null`, `--publish never`), updater не подключён. Download artifact из CI не означает, что приложение принято или безопасно для production. Не добавляйте signing keys, cookies, `.env`, локальные профили или credentials в artifacts.

## Android debug APK

Отдельный [manual Android workflow](<.github/workflows/android.yml>) собирает тестовый APK на Linux runner из проверенного frontend/mobile snapshot GitLab, без публикации backend, истории или raw source archive. Инструкции, доступ только из `main`, Secrets, точный artifact allowlist и ограничения debug-подписи — в [Android CI](<ANDROID_CI.md>). Этот job не меняет desktop-сборку и не публикует Release/Google Play. Успех локальных helper-тестов сам по себе не означает, что APK уже собран.

## Приёмка и известные риски

[ACCEPTANCE.md](<ACCEPTANCE.md>) разделяет исходные факты, команды автоматической проверки и ручную matrix. До заполнения evidence остаются непринятыми installed Windows/macOS/Linux, реальный IdP/system-browser flow, сайт с нужным frontend adapter и фактические OS notifications. Автоматические тесты не заменяют эти проверки.

Известная оговорка: отдельные audit от 2026-11-08 и 2026-11-09 сообщили moderate advisory [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) в build-time цепочке `minimatch` через packaging tools; high/critical не зафиксированы. Manifest и lock подтверждают devDependency-цепочку; это не утверждение об exploit в renderer. Подробности — в [ACCEPTANCE.md](<ACCEPTANCE.md>). Исправление/override зависимостей здесь не выполнялись. Audit нужно повторять отдельно; закреплённые версии и отсутствие production npm dependencies не означают «уязвимостей нет».

Документация подготовлена для исходного среза preview 2026-11-09. Исторические результаты `0.1.0` не являются результатами этой версии; актуальные проверки и ещё не выполненная release/installed-приёмка разделены в [ACCEPTANCE.md](<ACCEPTANCE.md>). Это не протокол production deployment.
