# Desktop acceptance

Дата сверки исходников: **2026-11-08**. Объект: standalone `Chat Desktop Spike` `0.1.0`, app ID `ru.exz-vps.chat.desktop.spike`. Обзор и команды разработки — в [README.md](<README.md>).

## Статус и правила evidence

**Installed OS matrix и реальный IdP пока не приняты.** Этот документ задаёт проверяемые критерии, а не переносит результаты прежних запусков. Все незаполненные ячейки ниже означают **NOT RUN / нет evidence**, а не PASS. Даже полностью зелёный CI не переводит ручную matrix в PASS.

Для каждого запуска записывайте: commit исходников, CI run URL (если применимо), SHA-256 installer, ОС/version/architecture, установленный или unpacked режим, remote или diagnostic build, настройки notifications/Focus/DND, фактический результат, дату и обезличенное evidence. Для remote-сценариев отдельно фиксируйте версию развёрнутого сайта, если её можно определить. Не публикуйте cookies, auth codes, токены, переписку, личные пути или идентификаторы реальных аккаунтов.

Допустимые статусы:

- **PASS** — критерий выполнен на указанной ОС и подтверждён evidence.
- **FAIL** — наблюдаемое поведение не соответствует критерию.
- **BLOCKED** — указана внешняя причина и условие повторного запуска.
- **NOT RUN** — проверка ещё не проведена; отсутствие ошибки в логе не считается результатом.

## Что подтверждается чтением исходников, но не runtime-приёмкой

| Область | Факт исходников | Что этим не доказано |
| --- | --- | --- |
| Normal target | [app-config.json](<app-config.json>) задаёт `https://chat.exz-vps.ru`; [build script](<scripts/build.mjs>) встраивает HTTPS origin | Доступность сайта, его версия и развёрнутый frontend adapter |
| Diagnostic mode | [src/config.ts](<src/config.ts>) выбирает явный `--spike` или diagnostic build marker | Реальные сообщения, auth и работа backend |
| D3 bridge | [src/contract.ts](<src/contract.ts>) и [src/preload.ts](<src/preload.ts>) содержат bridge v1, включая selective `dismissNotifications` | Deployment D3 frontend-кода на сайте и end-to-end read/call reconciliation |
| Renderer isolation | [src/main.ts](<src/main.ts>) задаёт sandbox/context isolation, отключает Node integration; [src/security.ts](<src/security.ts>) проверяет origin/frame и payload | Полная security-приёмка установленного приложения |
| Native notifications | [src/notifications.ts](<src/notifications.ts>) содержит account binding, dedup, grouping, TTL и activation validation | Реальный banner, звук, центр ОС и cold-start activation |
| Auth | [src/desktop-auth.ts](<src/desktop-auth.ts>) и [src/electron-auth.ts](<src/electron-auth.ts>) реализуют system-browser transaction/exchange/ack | Наличие server endpoints, реальный IdP, успешный вход |
| Media/files | [src/main.ts:194–219](<src/main.ts#L194-L219>) содержит deny permissions и ограничение downloads | Поддержка звонков, screen share, Blob/P2P/external attachments |
| Packaging | [electron-builder.yml](<electron-builder.yml>) задаёт NSIS x64, два DMG и AppImage x64 | Установка/запуск, trusted signing, notarization и popup acceptance ОС |

D3 здесь обозначает экспортированный исходный срез desktop-кода. Обычная оболочка не содержит frontend сайта и показывает текущий remote deployment. Сайт развёртывается отдельно; этот репозиторий и эта задача **не выполняют deployment сайта**.

## Автоматические проверки: команды и границы

Запускайте из корня чистого checkout с Node.js 24.x и locked dependencies:

```sh
node --version
npm ci
node -e "require('electron')"
npm run typecheck
npm test
node --test scripts/artifacts.test.mjs
npm run build
npm audit
```

Это команды для проверочного прогона, не утверждение, что они выполнены в рамках редактирования документации. Artifact-helper tests проверяют allowlist/checksums, а не GUI. В [package.json](<package.json>) нет отдельного `lint` script. Тесты приложения создают `dist-tests`, сборка — `dist`; устанавливать зависимости или создавать artifacts для одной лишь правки документации не требуется.

| Проверка | Необходимое evidence | Статус этого документа |
| --- | --- | --- |
| Locked install на Node 24 | Версии Node/npm, `npm ci` exit code, неизменный lockfile | Локально 2026-11-08: PASS, Node 24.19.0 / npm 11.17.0, exit 0; lockfile не изменён |
| Typecheck | `npm run typecheck` exit code | Локально 2026-11-08: PASS, exit 0 |
| Unit/contract tests | Полный test summary и exit code, не только последняя строка | Локально 2026-11-08: PASS, 83/83, exit 0 после последовательной инициализации Electron |
| Artifact helper tests | Полный `node --test scripts/artifacts.test.mjs` summary | Локально 2026-11-08: PASS, 14/14, exit 0; helper coverage 100% lines/branches/functions |
| Normal build | Exit code; embedded target соответствует approved HTTPS origin | Локально 2026-11-08: PASS, exit 0; ASAR config содержит approved HTTPS origin |
| Native package jobs | Run URL и точные files/checksums для каждой платформы | GitHub Actions: NOT RUN; локальный macOS arm64 unpacked package — см. ниже |
| Dependency audit | Актуальный отчёт, включая dev/build dependencies | См. известную оговорку ниже; не dependency-clean |

В тестах проверяются contract/payload validation, security/config, notification service/store, lifecycle, auth и Electron adapters с тестовыми port/mock-границами. Это не установленное приложение и не live IdP. Проверки build config также не доказывают доступность remote сайта.

### Локальный prepublication-прогон 2026-11-08

Результаты выше получены Lead на экспортированном рабочем дереве перед первым commit. Первый параллельный `npm test` завершился ошибкой конкурентного lazy download Electron; последовательный `node -e "require('electron')"` устранил причину, после чего полный suite повторно прошёл 83/83. CI содержит этот подготовительный шаг. Проверки artifact helper дополнительно прошли с `--experimental-test-coverage`; это покрытие только helper, не всего desktop runtime. YAML и security/matrix assertions прошли; отдельный `lint` не настроен, `actionlint` не установлен.

Локальная структурная упаковка macOS arm64 прошла с test-only ad-hoc overrides и `electronDist=node_modules/electron/dist`: повторная загрузка Electron packager-ом первоначально завершилась HTTP 504, поэтому использован уже установленный и проверенный Electron 45.2.3. `codesign --verify --deep --strict` завершился с exit 0. ASAR содержит только main/preload bundles, embedded config, три diagnostic-ресурса и package manifest; исходников backend/frontend, npm-зависимостей, ключей или профилей внутри ASAR нет. Это **не** DMG install, запуск приложения, Developer ID/notarization или OS notification acceptance.

Опциональный [cookie smoke harness](<scripts/auth-cookie-smoke.cjs>) в этот прогон не запускался. Ему нужны отдельно генерируемые тестовые модули и loopback TLS fixtures; обычный build их не создаёт. Локальные ключи, сертификаты и профили не публикуются.

### Известная оговорка dependency audit

На 2026-11-08 при отдельной проверке `npm audit --json` зафиксирован exit code **1**: шесть affected dependency nodes уровня **moderate**, без high/critical. Корневой advisory — [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) для `minimatch`; шесть nodes не означают шесть независимых уязвимостей.

[Manifest](<package.json>) содержит инструменты как devDependencies. В [lockfile](<package-lock.json>) подтверждены `electron-builder 26.18.0` → `app-builder-lib 26.18.0` → `minimatch ^10.2.5`, resolved `10.2.6`, и build-time ветка `@electron/universal`. Это оговорка для цепочки сборки, а не доказательство remote exploit в renderer или production npm dependency. Не следует называть зависимости «чистыми» или игнорировать риск CI. Обновление/override/`npm audit fix` в рамках этой документации не выполнялись; будущий audit нужно записать заново, не выдавая старый отчёт за текущий.

## CI: только тестовые artifacts

[Desktop workflow](<.github/workflows/desktop.yml>) настроен на стандартные native hosted runners `windows-2025`, `macos-15`, `ubuntu-24.04`, Node `24.19.0` и Actions, закреплённые commit SHA. Для macOS один packaging job создаёт два отдельных DMG: Apple Silicon и Intel. Это описание конфигурации, не утверждение об уже успешном GitHub Actions run.

Ожидаемые файлы для версии `0.1.0`:

```text
chat-desktop-spike-0.1.0-win-x64.exe
chat-desktop-spike-0.1.0-mac-arm64.dmg
chat-desktop-spike-0.1.0-mac-x64.dmg
chat-desktop-spike-0.1.0-linux-x64.AppImage
```

Actions artifact называется `desktop-test-<platform>-<run_id>-<run_attempt>` и хранится 7 дней. [Helper](<scripts/artifacts.mjs>) запускается как `node scripts/artifacts.mjs windows` (либо `macos`/`linux`) после packaging. Каждый platform artifact сопровождается `SHA256SUMS.txt`. Сверьте checksum до установки; не принимайте произвольный zip каталога `release` как допустимую поставку. В artifacts не должны попадать unpacked app, debug/cache, исходники профилей, credentials или signing material.

macOS CI ad-hoc signing используется только для теста: CLI overrides `mac.identity=-`, `mac.hardenedRuntime=false`, `mac.notarize=false` не меняют базовый hardened config. **Нет Developer ID и notarization; нет утверждения о Gatekeeper trust, OS notification popup или пригодности к production distribution.** Не отключайте системные защиты ради PASS. Windows test installer также не является обещанием trusted signing; Linux требует проверки фактического desktop environment и условий запуска AppImage.

Artifacts — не GitHub Release и не автообновление. `publish: null` и `--publish never` запрещают публикацию из packaging; updater не подключён. Сборка обеих архитектур на одном macOS runner не доказывает запуск ни на Intel, ни на Apple Silicon.

## Ручная installed matrix

Все четыре platform-колонки заполняются **на установленном приложении** соответствующей архитектуры. Запуск из source/unpacked фиксируется отдельно и не закрывает installed acceptance. Для macOS Intel и Apple Silicon нужны отдельные runtime evidence. Для Linux укажите desktop environment, наличие tray, notification daemon и условия запуска AppImage.

| Сценарий | Windows x64 NSIS | macOS arm64 DMG | macOS x64 DMG | Linux x64 AppImage |
| --- | --- | --- | --- | --- |
| Checksum, установка/монтирование, identity, первый запуск | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Normal build открывает approved remote origin; diagnostic build явно локальный | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Reload/error page при offline, восстановление сети, menu diagnostics | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| System-browser login с реальным IdP и явным подтверждением аккаунта | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Cancel/deny/expiry и повторный login без embedded IdP fallback | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Сессия после restart; logout/account switch не активирует старый account | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Фокус/blur/minimize/hide, крестик, tray/menu/Dock, second instance | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Реальное сообщение через адаптер сайта: одно OS notification вне активного чата | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Повтор event ID, замена группы chat/call, TTL и expired click | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Read/call end/selective dismiss, очистка, logout и account switch | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Warm click: окно восстанавливается, route только в текущий account | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Центр уведомлений после restart / best-effort cold activation | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Focus/DND, запрет notifications ОС, отключённый daemon: честная деградация | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Quit останавливает процесс и получение новых событий | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Sleep/resume, renderer failure и восстановление без бесконечного reload | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Same-origin download + save/cancel; Blob/P2P/external/redirect-chain deny | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Browser notification/media/device/display/File System Access deny | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| External HTTPS confirmation; опасные scheme/popup/iframe/IPC rejected | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Badge: macOS count/reset; Windows/Linux не обещан | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

### Порядок и критерии ручной проверки

1. **Установка и provenance.** Получите точный artifact нужной архитектуры, сверьте SHA-256, зафиксируйте app identity и фактические signing warnings. Не называйте ad-hoc сборку notarized. Если ОС отказывает в запуске, запишите FAIL/BLOCKED и причину, а не PASS на основании packaging.
2. **Локальная диагностика.** В отдельной diagnostic-сборке или через `npm run spike` проверьте capabilities, set account, message/call, delayed event, duplicate, clear/logout и TTL. Клик должен приносить только валидный route. Локальный таймер не доказывает background delivery реальных сообщений.
3. **Normal remote flow.** Вернитесь к обычной сборке. Подтвердите origin и работоспособность deployed frontend adapter. Если bridge не используется сайтом, отметьте зависимость deployment; не подменяйте проверку сообщений локальным spike. D3 selective dismissal должен проверяться реальным read/call state, не только наличием метода.
4. **Вход.** Запустите login на совместимом сервере, проверьте отдельный системный браузер, ввод кода, показ правильного аккаунта и явное подтверждение. Проверьте cancel/deny/expiry, сетевую ошибку и неподдерживаемый сервер. Вход завершается только после проверки session и ACK; переход к IdP в Electron запрещён. Реальный IdP не считается принятым по mock-тестам.
5. **Уведомления.** Проверьте banner и центр ОС отдельно при focus/blur/minimize/hide, Focus/DND и запрете ОС. `isSupported()`/`accepted: true` не равны показу. Проверьте warm click, expired click, restart, clear и смену account; старый toast не должен активировать чужой или истёкший route. Учитывайте best-effort history и ограничение снятия старых Windows toasts после restart.
6. **Lifecycle.** Крестик скрывает окно, либо сворачивает при отсутствии tray на Windows/Linux. Окно можно вернуть. Quit завершает процесс; новые события после Quit не получаются. Возможная активация уже доставленного toast — отдельный OS-зависимый сценарий, не фоновое получение. После renderer failure показывается безопасная диагностика без bridge; resume не обещает доставку пропущенных событий.
7. **Deny boundaries.** Камера/микрофон/display capture/device/browser notifications/File System Access отклоняются runtime policy. Same-origin HTTPS download допускается только при trusted frame/initiator и полностью same-origin redirect chain, с session и native save dialog. Blob, P2P и external downloads запрещены. Отдельно проверьте uploads/file picker/drag-and-drop; их успешность не заявлена. Entitlements и usage strings не являются media acceptance.
8. **Security и privacy.** Проверьте отсутствие прямого bridge у iframe/чужого origin и отказ невалидным IPC/payload, запрет произвольных схем и embedded IdP. Внешний HTTPS открывается только после подтверждения. Журнал не содержит title/body; идентификаторы и session cookies всё равно требуют защиты и не публикуются вместе с evidence.

## Что остаётся за пределами принятого результата

- Deployment frontend/backend сайта, перенос инфраструктуры или истории разработки.
- Реальный IdP и серверный system-browser protocol без отдельного live evidence.
- Production signing/notarization и массовое распространение.
- Автоматические Release, updater и background push после Quit.
- Media/calls/screen sharing, Blob/P2P/external downloads и непротестированные file flows.
- Гарантированный показ OS notifications и одинаковая история/activation на всех desktop environments.

Разрешение этих вопросов требует отдельной реализации/приёмки. Ни наличие исходников D3, ни временные CI artifacts не закрывают перечисленные ограничения.
