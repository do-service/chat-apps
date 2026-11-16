# Desktop acceptance

Дата подготовки preview.4: **2026-11-16**. Объект: standalone `Chat Desktop Spike` `0.1.1-preview.4`, app ID `ru.exz-vps.chat.desktop.spike`, все четыре desktop installers; Android исключён. Обзор, ограничения signing и ожидаемые ссылки загрузок — в [README.md](<README.md>). Новые CI/installers и публикация preview.4 **ещё не подтверждены**; Lead заполнит фактическое evidence после отдельных проверок. Предыдущий [публичный prerelease `v0.1.1-preview.3`](https://github.com/do-service/chat-apps/releases/tag/v0.1.1-preview.3) опубликован 2026-11-15. История preview.3/preview.2/preview.1/`0.1.0` ниже **не является результатами preview.4**.

## Подготовка preview.4 — 2026-11-16

Версия manifest и двух корневых version-полей lockfile — `0.1.1-preview.4`; pinned зависимости и прежняя identity сохраняются. В поставку включаются Windows taskbar overlay, явная пользовательская интеграция AppImage/Linux, native reload с cancel-default подтверждением, прежние цветные иконки всех ОС, updater и host picker с default `https://chat.krista.ru`; сохранённый выбор сервера не должен сбрасываться. Это состав подготовки, не evidence установленного приложения.

[Desktop workflow](<.github/workflows/desktop.yml>) использует [отдельные desktop policy tests](<scripts/desktop-release-workflow.test.mjs>) без Android release inputs. `--preview` в [artifact helper](<scripts/artifacts.mjs>) разрешает только следующие outputs (в каждом platform artifact свой manifest):

```text
release/chat-desktop-spike-0.1.1-preview.4-win-x64.exe
release/chat-desktop-spike-0.1.1-preview.4-win-x64.exe.blockmap
release/preview.yml
release/chat-desktop-spike-0.1.1-preview.4-mac-arm64.dmg
release/chat-desktop-spike-0.1.1-preview.4-mac-x64.dmg
release/chat-desktop-spike-0.1.1-preview.4-linux-x86_64.AppImage
release/preview-linux.yml
release/SHA256SUMS.txt
```

Единый manifest будущего Release должен содержать SHA-256 семи payload files: четыре installers, NSIS blockmap и два YAML. Сам manifest не хеширует себя. YAML проверяются по exact version/asset/size/SHA-512 и содержимому blockmap chunks, а не только по расширению; посторонние файлы не публикуются. macOS остаётся DMG-only без ZIP/YAML.

Linux writable packaged AppImage N→N+1 — NOT RUN. Unsigned Windows — external/manual fallback, не trusted signature-verified install; нельзя отключать signature verification. macOS — external DMG, ad-hoc, без Developer ID/notarization. CI, новая упаковка, публикация, host-picker installed checks, реальный IdP, notifications и OS matrix preview.4 — NOT RUN до отдельного evidence. Старым бинарникам нужен ручной bootstrap. Android signing/release и его документация исключены.

Историческая проверка metadata/CI preview.3 от 2026-11-15: RED новой desktop policy выявил импорт смешанного Android policy suite; после замены импорта GREEN — 51/51 tests PASS, 0 skipped (`artifacts.test.mjs`, `artifacts-preview.test.mjs`, `desktop-release-workflow.test.mjs`), exit 0. Это не прогон preview.4. Fixtures используют отдельные temp directories, не shared dist. Свежие typecheck/app/helper tests/build preview.4 и artifact gates выполняются отдельно; отдельного lint script нет.

Проверка private-source exposure: builder включает desktop bundles/manifest и необходимые runtime dependencies, build отключает source maps; repository source payload, frontend/backend snapshot, ключи и профили не добавляются. Реальные ASAR/installer contents новой версии должны быть отдельно проверены после packaging; static config не доказывает их состав.

### Локальная проверка кандидата preview.4 — 2026-11-16

- Lead: **730/730 desktop tests**, **51/51 desktop artifact/policy tests**, 0 skipped/cancelled, strict TypeScript, production/native build с `DESKTOP_UPDATE_DISTRIBUTION=github-preview` и `git diff --check` — PASS. Это локальный кандидат, не hosted CI/installer/OS evidence.
- Синхронизированы reload и badge/Linux consent; 10 implementation-файлов побайтово совпадают с reviewed source, в main/main-test сохранены выпущенные public-only all-OS иконки. Остальные standalone Windows path/POSIX/CRLF adapters сохранены. Source monorepo и восемь Android signing/release dirty files не изменялись.
- Новый Windows overlay, Linux consent/foreign-file/atomic-write failure/retry и delayed latest replay покрыты тестами; не заявлены реальный показ счётчика, Explorer restart, KDE X11/Wayland или first native prompt.
- Свежий `npm audit --json`: exit 1, **6 moderate / 0 high / 0 critical**, прежняя build-time minimatch advisory; зависимости не обновлялись и «чистыми» не объявляются. Отдельного lint script нет.
- Публичный tag/release создаётся только после проверки fresh single CI run, всех четырёх installers, updater metadata/blockmaps, реальных ASAR/signatures/icons и независимого ревью. Android/сайт/ключи/production signing не входят в scope.

## Статус и правила evidence

**Installed OS matrix и реальный IdP пока не приняты.** Этот документ задаёт проверяемые критерии, а не переносит результаты прежних запусков. Все незаполненные ячейки ниже означают **NOT RUN / нет evidence**, а не PASS. Даже полностью зелёный CI не переводит ручную matrix в PASS.

Для каждого запуска записывайте: commit исходников, CI run URL (если применимо), SHA-256 installer, ОС/version/architecture, установленный или unpacked режим, remote или diagnostic build, настройки notifications/Focus/DND, фактический результат, дату и обезличенное evidence. Для remote-сценариев отдельно фиксируйте версию развёрнутого сайта, если её можно определить. Не публикуйте cookies, auth codes, токены, переписку, личные пути или идентификаторы реальных аккаунтов.

Допустимые статусы:

- **PASS** — критерий выполнен на указанной ОС и подтверждён evidence.
- **FAIL** — наблюдаемое поведение не соответствует критерию.
- **BLOCKED** — указана внешняя причина и условие повторного запуска.
- **NOT RUN** — проверка ещё не проведена; отсутствие ошибки в логе не считается результатом.

## Локальная подготовка native updates — 2026-11-12

Это отдельный локальный pre-release этап без нового version bump, installer build, CI run или публикации. Ранее опубликованные binaries не получают updater задним числом. После независимого code/security review runtime source/dependencies/builder config синхронизированы, а Lead повторно проверил standalone typecheck, normal/native build и 452/452 desktop tests. 21 runtime/test файл побайтово совпадает с reviewed source; build fixture и icon paths адаптированы для standalone. Версия `0.1.1-preview.2`, app identity, профиль и прежний Windows `path.join` regression сохранены. [Debug workflow](<.github/workflows/android.yml>) и прежние debug scanner tests не изменены. Это не новая проверка прежней публикации preview.2 и не установленная updater-сборка.

| Проверка | Статус / граница evidence |
| --- | --- |
| Desktop metadata/blockmap RED/GREEN | RED: 16 новых behavior tests ожидаемо FAIL без preview mode; GREEN: новые 16 + прежние 18 tests PASS. SHA-512 проверяется по exact installer bytes; gzip NSIS / embedded AppImage blockmap chunks сверяются с installer. Не подтверждает настоящие installers |
| Историческая desktop helper coverage | Desktop helper + preview validator: 38 tests, 100% lines/branches/functions (Node test coverage); real pinned-builder multi-chunk blockmaps/YAML fixtures и macOS no-ZIP. Reports на диск не создавались. Это прежний результат, не прогон preview.4 |
| Syntax и исходный pre-sync typecheck | JavaScript `node --check`, Python AST parse, YAML parse и `bash -n` изменённых workflow run snippets — PASS; исходный pre-sync typecheck также PASS. Этот промежуточный результат не подменяет следующий полный прогон |
| Full standalone typecheck/app tests/build после final sync | PASS, независимо повторено Lead: `npm run build` (strict TypeScript + native addon), отдельный typecheck, 452/452 desktop tests, 88/88 Node helpers, 64/64 Python tests, `git diff --check`. Без skips, app launch, installer packaging и CI. Отдельного lint script нет; реальные OS/signing сценарии этим не проверены |
| Windows NSIS updater | Текущий unsigned preview: external/manual fallback, **не** signature-verified install. Install требует future expected publisherName + valid Authenticode и отдельный N→N+1 тест. Запрещено отключать signature verification |
| Linux AppImage updater / macOS | Installed AppImage N→N+1 NOT RUN; writable packaged AppImage gate обязателен. macOS только external DMG по архитектуре, без ZIP/YAML/updater install/Developer ID/notarization |
| CI artifacts / GitHub Release / deploy | NOT RUN / NOT CREATED; `--publish never` и `contents: read` сохранены. Ни commit, ни push, ни environment/secret configuration не выполнялись |

Desktop implementation и regression tests: [desktop helper](<scripts/artifacts.mjs>), [metadata validator](<scripts/preview-metadata.mjs>), [preview tests](<scripts/artifacts-preview.test.mjs>), [desktop workflow policy tests](<scripts/desktop-release-workflow.test.mjs>). HTTPS/checksums одного сервера не являются независимой publisher signature. Android release/signing preparation не входит в эту desktop-публикацию.

## Что подтверждается чтением исходников, но не runtime-приёмкой

| Область | Факт исходников | Что этим не доказано |
| --- | --- | --- |
| Normal target / host picker | [app-config.json](<app-config.json>) задаёт default `https://chat.krista.ru`; [build script](<scripts/build.mjs>) встраивает HTTPS origin, локальный выбор сервера сохраняется | Installed выбор/смена/сохранение сервера, доступность сайта, его версия и развёрнутый frontend adapter |
| Diagnostic mode | [src/config.ts](<src/config.ts>) выбирает явный `--spike` или diagnostic build marker | Реальные сообщения, auth и работа backend |
| Desktop bridge | [src/contract.ts](<src/contract.ts>) и [src/preload.ts](<src/preload.ts>) содержат bridge v1, selective `dismissNotifications` и optional native permission methods | Совместимый развёрнутый frontend и end-to-end read/call/consent reconciliation |
| macOS notification consent | [Controller](<src/notification-permission.ts>) и [native addon](<native/notification-permission.mm>) читают/запрашивают OS consent в main process; запрос требует явного действия через compatible frontend и текущий trusted foreground context | Первый системный диалог, разрешение, banner или повторное предложение в прежнем профиле |
| macOS hotkeys | [src/main.ts](<src/main.ts>) использует menu roles `minimize`/`hide` для `Cmd+M`/`Cmd+H` только macOS, сохраняет `Cmd+W` close-to-hide и `Cmd+Q` Quit | Реальное поведение клавиатуры и menu/Dock на установленном Mac |
| External HTTPS confirmation | [Диалог](<src/external-link-dialog.ts>), [локальный документ](<src/external-link-document.ts>) и [preload](<src/external-link-preload.ts>) задают expressive modal, темы ОС, host/URL, начальный фокус «Отмена» и fail-closed ответ; main повторно проверяет документ/account/окно | Реальный внешний браузер, OS light/dark, keyboard/scroll/focus и safe cancel установленного приложения |
| Native icon / badge | Canonical [PNG](<build/icons/icon.png>) используется на всех ОС; Windows `setOverlayIcon` показывает `1…99`/`99+`, macOS сохраняет Dock API, Linux — best-effort LauncherEntry; AppImage registration только после native consent, без чужих overwrite | Реальный счётчик Windows/KDE, настройки панели/DND, старые pins/cache, Linux X11/Wayland и фактическая привязка к зарегистрированному desktop entry |
| Renderer isolation | [src/main.ts](<src/main.ts>) задаёт sandbox/context isolation, отключает Node integration; [src/security.ts](<src/security.ts>) проверяет origin/frame и payload | Полная security-приёмка установленного приложения |
| Native notifications | [src/notifications.ts](<src/notifications.ts>) содержит account binding, dedup, grouping, TTL и activation validation | Реальный banner, звук, центр ОС и cold-start activation |
| Auth | [src/desktop-auth.ts](<src/desktop-auth.ts>) и [src/electron-auth.ts](<src/electron-auth.ts>) реализуют system-browser transaction/exchange/ack | Наличие server endpoints, реальный IdP, успешный вход |
| Media/files | [Main policy](<src/main.ts>) и [media policy](<src/media-permissions.ts>) допускают macOS mic/camera по отдельному OS consent для live trusted main frame; на Windows/Linux mic/camera DENY. Browser notifications/device/display/File System Access DENY везде; downloads ограничены | Реальные voice/video calls, screen share, Blob/P2P/external attachments |
| Packaging | [electron-builder.yml](<electron-builder.yml>) задаёт NSIS x64, два DMG и AppImage x64 | Установка/запуск, trusted signing, notarization и popup acceptance ОС |

Обычная оболочка не содержит frontend сайта и показывает текущий remote deployment. Новый macOS consent flow требует одновременно новой оболочки с packaged native addon и совместимого frontend-адаптера сайта. Сайт развёртывается отдельно; этот репозиторий и эта задача **не выполняют deployment сайта**.

App identity, профиль/session partition и сохранённые preferences не сбрасываются. Сохранённое «включено»/«выключено»/закрытое предложение может подавлять startup offer: обновление **не гарантирует** ни новый banner, ни первый OS prompt. Query permission при запуске не вызывает новый запрос; `denied`/`unknown` не считаются `granted`, а отсутствие addon должно честно давать `unknown`. Выпущенный в preview.1 coordinator сохраняет совместное passive-чтение и отдельный explicit request с проверками актуальности каждого consumer; это не новое согласие и не доказательство показа ОС.

## Автоматические проверки: команды и границы

Запускайте из корня чистого checkout с Node.js 24.x и locked dependencies:

```sh
node --version
npm ci
node -e "require('electron')"
npm run typecheck
npm test
node --test scripts/artifacts.test.mjs scripts/artifacts-preview.test.mjs scripts/desktop-release-workflow.test.mjs
npm run build
npm audit
```

Это команды для проверочного прогона, не утверждение, что они выполнены в рамках редактирования документации. Artifact-helper tests проверяют allowlist/checksums, а не GUI. В [package.json](<package.json>) нет отдельного `lint` script. Тесты приложения создают `dist-tests`, сборка — `dist`; устанавливать зависимости или создавать artifacts для одной лишь правки документации не требуется.

### История опубликованного preview.2: отдельное evidence

| Проверка `0.1.1-preview.2` | Статус на этапе подготовки |
| --- | --- |
| Version/lock/Linux metadata | Изменены manifest version/desktopName, только два корневых version-поля lockfile и `linux.syncDesktopName`; это не build или runtime evidence |
| Полный standalone typecheck/tests/artifact-helper/build | Lead, локально 2026-11-12: Node 24.19.0 / npm 11.17.0; `npm run build`, отдельный `npm run typecheck`, desktop 412/412 (0 skipped), artifact-helper 18/18 (0 skipped) — PASS, всё exit 0. Helper coverage: 100% lines/branches/functions; normal build с approved remote origin, универсальный native addon arm64 + x86_64. Это не CI/installer/installed/OS-consent acceptance; отдельного lint script нет |
| GitHub Actions, четыре installers и SHA-256 | История preview.2: [run 43214770881](https://github.com/do-service/chat-apps/actions/runs/43214770881); не проверка preview.4 |
| Tag и публичный prerelease | [v0.1.1-preview.2](https://github.com/do-service/chat-apps/releases/tag/v0.1.1-preview.2) опубликован 2026-11-12; прежние четыре installers и manifest, без updater |
| External dialog: OS light/dark, keyboard, длинный URL, safe cancel | NOT RUN на установленном приложении |
| Linux canonical icon, matching desktop entry и LauncherEntry badge | NOT RUN на установленном приложении; видимый badge не гарантирован |
| Installed OS matrix / реальный IdP / first OS consent | NOT RUN |
| Dependency audit preview.2 | Lead, 2026-11-12: `npm audit --json`, exit 1; moderate: 6, high: 0, critical: 0. Тот же build-time `minimatch` advisory GHSA-g3hv-75wg-m249; не dependency-clean. Зависимости не изменялись |

### История опубликованного `0.1.1-preview.1` — не preview.2

Публичный [prerelease `v0.1.1-preview.1`](https://github.com/do-service/chat-apps/releases/tag/v0.1.1-preview.1) опубликован и проверен **2026-11-09**. Tag указывает на commit `ff98d5a452d288e4f1fed173d47e9f453fc4302d`; [CI run 42636354580](https://github.com/do-service/chat-apps/actions/runs/42636354580) завершился успешно для трёх platform jobs. Проверены четыре installers и единый SHA-256 manifest; повторная анонимная проверка загрузок выполнена 2026-11-10. Это подтверждение доступности и provenance **старой версии**, не installed/IdP/OS-consent acceptance и не evidence preview.2.

Следующая таблица сохраняет отдельные результаты preview.1 с их исходными counts. Они не переносятся в новую версию.

| Проверка `0.1.1-preview.1` | Исторический результат |
| --- | --- |
| Version/lock metadata | Версия изменена только в manifest и двух корневых version-полях lockfile; dependency graph должен оставаться прежним |
| Artifact helper regressions | Локально 2026-11-09: RED 14/18 (prerelease fixtures Windows/macOS/Linux и real Linux config); GREEN 18/18, exit 0. `artifacts.mjs`: 100% lines/branches/functions. Старые stable-version и fail-closed gates сохранены |
| Полный standalone typecheck/tests/build после source sync | Первичный standalone-прогон 2026-11-09: Node 24.19.0 / npm 11.17.0; typecheck PASS, desktop 303/303 (0 skipped) PASS, normal build PASS, всё exit 0; addon arm64 + x86_64, approved remote origin. После этого исправлена потеря параллельных macOS notification checks: shared passive read и exclusive explicit request без ослабления stale/revocation guards; дополнительный source suite 332/332 PASS. Lead независимо повторил финальный standalone-прогон после синхронизации: typecheck PASS, desktop 332/332 (0 skipped), helper 18/18 и normal/native build PASS, всё exit 0; helper coverage 100% lines/branches/functions. Это не packaging/installed/OS-consent acceptance |
| GitHub Actions, четыре installers, hashes и публикация | Исторически проверены 2026-11-09 для preview.1: CI run 42636354580, четыре installers + `SHA256SUMS.txt`, публичный prerelease по ссылке выше; не installed acceptance |
| Installed OS matrix / реальный IdP / first OS consent | NOT RUN |
| Dependency audit 2026-11-09 | Lead: exit 1, шесть moderate, 0 high/critical; build-time `minimatch` advisory, не dependency-clean. Подробности ниже |

### История `0.1.0` — не текущий preview

Следующая таблица относится только к prepublication-прогону **2026-11-08 версии `0.1.0`**. Она намеренно сохраняет тогдашние counts и failures; не трактуйте её как проверку нового addon, consent flow или hotkey fix.

| Проверка | Необходимое evidence | Исторический результат `0.1.0` |
| --- | --- | --- |
| Locked install на Node 24 | Версии Node/npm, `npm ci` exit code, неизменный lockfile | Локально 2026-11-08: PASS, Node 24.19.0 / npm 11.17.0, exit 0; lockfile не изменён |
| Typecheck | `npm run typecheck` exit code | Локально 2026-11-08: PASS, exit 0 |
| Unit/contract tests | Полный test summary и exit code, не только последняя строка | Локально 2026-11-08: PASS, 83/83, exit 0 после последовательной инициализации Electron |
| Artifact helper tests | Полный `node --test scripts/artifacts.test.mjs` summary | Локально 2026-11-08: PASS, 14/14, exit 0; helper coverage 100% lines/branches/functions |
| Normal build | Exit code; embedded target соответствует approved HTTPS origin | Локально 2026-11-08: PASS, exit 0; ASAR config содержит approved HTTPS origin |
| Native package jobs | Run URL и точные files/checksums для каждой платформы | Первый GitHub run: macOS PASS; Windows/Linux download HTTP 504, включая повтор failed jobs. Подробности ниже; это не installed acceptance |
| Dependency audit | Актуальный отчёт, включая dev/build dependencies | См. известную оговорку ниже; не dependency-clean |

В тестах проверяются contract/payload validation, security/config, notification service/store, lifecycle, auth и Electron adapters с тестовыми port/mock-границами. Это не установленное приложение и не live IdP. Проверки build config также не доказывают доступность remote сайта.

### Локальный prepublication-прогон 2026-11-08

Результаты выше получены Lead на экспортированном рабочем дереве перед первым commit. Первый параллельный `npm test` завершился ошибкой конкурентного lazy download Electron; последовательный `node -e "require('electron')"` устранил причину, после чего полный suite повторно прошёл 83/83. CI содержит этот подготовительный шаг. Проверки artifact helper дополнительно прошли с `--experimental-test-coverage`; это покрытие только helper, не всего desktop runtime. YAML и security/matrix assertions прошли; отдельный `lint` не настроен, `actionlint` не установлен.

Локальная структурная упаковка macOS arm64 прошла с test-only ad-hoc overrides и `electronDist=node_modules/electron/dist`: повторная загрузка Electron packager-ом первоначально завершилась HTTP 504, поэтому использован уже установленный и проверенный Electron 45.2.3. `codesign --verify --deep --strict` завершился с exit 0. ASAR содержит только main/preload bundles, embedded config, три diagnostic-ресурса и package manifest; исходников backend/frontend, npm-зависимостей, ключей или профилей внутри ASAR нет. Это **не** DMG install, запуск приложения, Developer ID/notarization или OS notification acceptance.

Опциональный [cookie smoke harness](<scripts/auth-cookie-smoke.cjs>) в этот прогон не запускался. Ему нужны отдельно генерируемые тестовые модули и loopback TLS fixtures; обычный build их не создаёт. Локальные ключи, сертификаты и профили не публикуются.

### Первый GitHub Actions run

[Run 42466532380](https://github.com/do-service/chat-apps/actions/runs/42466532380) для commit `3d4c7ed1ac8d7f627afd9e0cdce0932c023b944f`: macOS job прошёл tests/build/packaging и загрузил оба DMG. Lead отдельно скачал artifact `desktop-test-macos-42466532380-1` (ID `13611622638`), проверил точный набор из двух DMG и `SHA256SUMS.txt`, повторно вычислил hashes; оба образа прошли `hdiutil verify` без монтирования/запуска приложения:

| DMG | SHA-256 |
| --- | --- |
| Apple Silicon | `03325225ce8e3db07b4d6ad60be27d4f29ec7cb2b33e8c37c6afdc8b9bd9646c` |
| Intel | `cbc232156f4b0c3b184f86b6a9dd734310bd04f1c78858c7e711f4e4c9239ebd` |

Windows остановился на загрузке native Electron с HTTP 504. Linux в первой попытке прошёл 83 desktop-теста, 14 helper-тестов и build, но повторный download-этап packager завершился HTTP 504; точный failing URL в этом логе отсутствует. Повтор только failed jobs также получил HTTP 504 при инициализации native Electron на Windows/Linux. Это **FAIL сетевых build prerequisites**, не PASS установщиков этих платформ. Installed matrix остаётся NOT RUN.

### Известная оговорка dependency audit

Исторический audit `0.1.0` от 2026-11-08: `npm audit --json`, exit code **1**, шесть affected dependency entries уровня **moderate**, без high/critical. Отдельный повтор Lead от **2026-11-09** также завершился с exit **1**: `moderate: 6`, `high: 0`, `critical: 0`, `total: 6`. Это отдельная историческая проверка preview.1, не новый audit preview.2 и не перенос старого PASS. Корневой advisory — [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) для `minimatch`; шесть nodes не означают шесть независимых уязвимостей.

[Manifest](<package.json>) содержит инструменты как devDependencies. В [lockfile](<package-lock.json>) подтверждены `electron-builder 26.18.0` → `app-builder-lib 26.18.0` → `minimatch ^10.2.5`, resolved `10.2.6`, и build-time ветка `@electron/universal`. Это оговорка для цепочки сборки, а не доказательство remote exploit в renderer или production npm dependency. Не следует называть зависимости «чистыми» или игнорировать риск CI. Обновление/override/`npm audit fix` в рамках этой документации не выполнялись; будущий audit нужно записать заново, не выдавая старый отчёт за текущий.

## Историческая CI-подготовка preview.2 без updater

**Этот раздел сохраняет прежний installer-only профиль `0.1.1-preview.2`, до новой подготовки updater transport.** Требования «четыре installers», `publish: null` и «updater не подключён» ниже относятся только к тому профилю, не являются инструкцией будущего updater-релиза. Текущие preview.4 metadata/blockmap allowlists, build marker и запрет автоматической публикации описаны в начале документа. Никакие прежние CI результаты не переносятся на новую сборку.

[Desktop workflow](<.github/workflows/desktop.yml>) в прежнем профиле был настроен на стандартные native hosted runners `windows-2025`, `macos-15`, `ubuntu-24.04`, Node `24.19.0` и Actions, закреплённые commit SHA. Для macOS один packaging job создаёт два отдельных DMG: Apple Silicon и Intel. Это описание конфигурации, не утверждение об уже успешном GitHub Actions run.

Ожидавшиеся файлы **исторического installer-only** `0.1.1-preview.2` (не future updater allowlist и не artifacts/installers `0.1.0` или `0.1.1-preview.1`):

```text
chat-desktop-spike-0.1.1-preview.2-win-x64.exe
chat-desktop-spike-0.1.1-preview.2-mac-arm64.dmg
chat-desktop-spike-0.1.1-preview.2-mac-x64.dmg
chat-desktop-spike-0.1.1-preview.2-linux-x86_64.AppImage
SHA256SUMS.txt
```

Actions artifact называется `desktop-test-<platform>-<run_id>-<run_attempt>` и хранится 7 дней. [Helper](<scripts/artifacts.mjs>) запускается как `node scripts/artifacts.mjs windows` (либо `macos`/`linux`) после packaging. Каждый platform artifact сопровождается `SHA256SUMS.txt`. Сверьте checksum до установки; не принимайте произвольный zip каталога `release` как допустимую поставку. В artifacts не должны попадать unpacked app, debug/cache, исходники профилей, credentials или signing material.

macOS CI ad-hoc signing используется только для теста: CLI overrides `mac.identity=-`, `mac.hardenedRuntime=false`, `mac.notarize=false` не меняют базовый hardened config. **Нет Developer ID и notarization; нет утверждения о Gatekeeper trust, OS notification popup или пригодности к production distribution.** Не отключайте системные защиты ради PASS. Windows test installer остаётся unsigned, без trusted signing; Linux требует проверки фактического desktop environment и условий запуска AppImage.

Actions artifacts — не GitHub Release и не автообновление. `publish: null` и `--publish never` запрещают публикацию из packaging; updater не подключён. Публичный prerelease — отдельный ручной шаг после проверки exact commit/run, ZIP contents/digests и SHA-256 всех четырёх installers. Он должен содержать только четыре installers и единый четырёхстрочный `SHA256SUMS.txt`, с `prerelease: true`, без статуса latest. [Страница опубликованного preview.2](https://github.com/do-service/chat-apps/releases/tag/v0.1.1-preview.2) относится только к прежней поставке от 2026-11-12, не к новым файлам preview.4. Публикация preview.1 подтверждена отдельно в историческом разделе. Сборка обеих архитектур на одном macOS runner не доказывает запуск ни на Intel, ни на Apple Silicon.

Перед macOS packaging проверьте [build-native prerequisites](<scripts/build-native.mjs>) и наличие universal `arm64`/`x86_64` addon. [Packaging config](<electron-builder.yml>) должен выносить `dist/notification-permission.node` в ASAR-unpacked; отдельно проверяйте подпись addon и приложения, ASAR allowlist и fuses. Packaging/подпись не подтверждают первый OS prompt.

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
| Cmd+M minimize, Cmd+H hide, Cmd+W close-to-hide, Cmd+Q Quit | N/A (macOS roles отсутствуют) | NOT RUN | NOT RUN | N/A (macOS roles отсутствуют) |
| Явный native OS-consent: not-determined/granted/denied/unknown; настройки ОС | N/A (macOS consent flow) | NOT RUN | NOT RUN | N/A (macOS consent flow) |
| Сохранённые preferences: обновление не сбрасывает выбор и не обещает startup offer | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Реальное сообщение через адаптер сайта: одно OS notification вне активного чата | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Повтор event ID, замена группы chat/call, TTL и expired click | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Read/call end/selective dismiss, очистка, logout и account switch | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Warm click: окно восстанавливается, route только в текущий account | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Центр уведомлений после restart / best-effort cold activation | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Focus/DND, запрет notifications ОС, отключённый daemon: честная деградация | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Quit останавливает процесс и получение новых событий | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Sleep/resume, renderer failure и восстановление без бесконечного reload | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Same-origin download + save/cancel; Blob/P2P/external/redirect-chain deny | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| macOS mic/camera: раздельное OS consent, all-of для mixed request; Win/Linux DENY | NOT RUN (DENY) | NOT RUN | NOT RUN | NOT RUN (DENY) |
| Browser notification/device/display/File System Access deny | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| External HTTPS dialog: OS light/dark, host/full URL, keyboard/scroll, cancel default | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| External dialog safe cancel: Escape/close/hide/minimize/navigation/account/Quit/crash | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Опасные scheme/popup/iframe/IPC rejected; браузер только после актуального confirm | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Badge `0 → 1 → 12 → 100 → 0`, account/logout/reset/show/recreation | NOT RUN (native overlay) | NOT RUN | NOT RUN | NOT RUN (LauncherEntry best effort) |
| Native reload: cancel/default/confirm/stale/account/Quit/recovery | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| AppImage direct launch: consent/decline/menu retry/move/foreign entry/latest replay | N/A | N/A | N/A | NOT RUN (KDE X11/Wayland) |
| Linux canonical icon, installed matching `.desktop`, старые pins/cache | N/A | N/A | N/A | NOT RUN |

### Порядок и критерии ручной проверки

1. **Установка и provenance.** Получите точный artifact нужной архитектуры, сверьте SHA-256, зафиксируйте app identity и фактические signing warnings. Не называйте ad-hoc сборку notarized. Если ОС отказывает в запуске, запишите FAIL/BLOCKED и причину, а не PASS на основании packaging.
2. **Локальная диагностика.** В отдельной diagnostic-сборке или через `npm run spike` проверьте capabilities, set account, message/call, delayed event, duplicate, clear/logout и TTL. Клик должен приносить только валидный route. Локальный таймер не доказывает background delivery реальных сообщений.
3. **Normal remote flow.** Вернитесь к обычной сборке. Подтвердите origin и работоспособность deployed frontend adapter. Если bridge не используется сайтом, отметьте зависимость deployment; не подменяйте проверку сообщений локальным spike. D3 selective dismissal должен проверяться реальным read/call state, не только наличием метода.
4. **Вход.** Запустите login на совместимом сервере, проверьте отдельный системный браузер, ввод кода, показ правильного аккаунта и явное подтверждение. Проверьте cancel/deny/expiry, сетевую ошибку и неподдерживаемый сервер. Вход завершается только после проверки session и ACK; переход к IdP в Electron запрещён. Реальный IdP не считается принятым по mock-тестам.
5. **Уведомления.** Для macOS зафиксируйте OS status до/после явного opt-in, наличие addon и compatible frontend. Query на старте не должен вызывать новый OS prompt; при `not-determined` запрос инициируется явным действием, при `denied` не выдаёт фиктивное согласие, при `unknown` не записывает новый opt-in. Сохранённое решение/закрытое предложение не сбрасывается при обновлении; отсутствие нового startup offer в таком профиле само по себе не FAIL. Не сбрасывайте TCC или пользовательский профиль ради результата. Проверьте banner и центр ОС отдельно при focus/blur/minimize/hide, Focus/DND и запрете ОС. `isSupported()`/`accepted: true` не равны показу. Проверьте warm click, expired click, restart, clear и смену account; старый toast не должен активировать чужой или истёкший route. Учитывайте best-effort history и ограничение снятия старых Windows toasts после restart.
6. **Lifecycle и hotkeys.** На macOS проверьте отдельно `Cmd+M` (minimize), `Cmd+H` (hide), `Cmd+W` (close-to-hide) и `Cmd+Q` (Quit), восстановление через Dock/menu. macOS roles не должны менять Windows/Linux. Крестик скрывает окно, либо сворачивает при отсутствии tray на Windows/Linux. Окно можно вернуть. Quit завершает процесс; новые события после Quit не получаются. Возможная активация уже доставленного toast — отдельный OS-зависимый сценарий, не фоновое получение. После renderer failure показывается безопасная диагностика без bridge; resume не обещает доставку пропущенных событий.
7. **Media и deny boundaries.** На macOS в normal remote mode проверьте раздельный OS consent mic/camera, отказ одного устройства при mixed request и повторную проверку текущего main frame после ожидания. Согласие mic не даёт camera. На Windows/Linux mic/camera должны оставаться DENY. На всех ОС display capture/device/browser notifications/File System Access отклоняются; diagnostic mode не разрешает media. Same-origin HTTPS download допускается только при trusted frame/initiator и полностью same-origin redirect chain, с session и native save dialog. Blob, P2P и external downloads запрещены. Отдельно проверьте uploads/file picker/drag-and-drop; их успешность не заявлена. Entitlements и usage strings не являются media acceptance.
8. **Внешний HTTPS и safe cancel.** Проверьте expressive modal в светлой и тёмной теме ОС: host и полный URL не становятся HTML/ссылкой, длинный адрес прокручивается с клавиатуры, Tab/Shift+Tab остаются в диалоге, фокус виден и начинает с «Отмена». Enter на области URL не открывает браузер; открытие допускается только кнопкой «Открыть в браузере». «Отмена», крестик, Escape и `Cmd/Ctrl+W` не открывают URL. Отдельно проверьте hide/minimize/close parent, navigation/reload, смену account, Quit, crash и ошибку загрузки: старый положительный ответ не должен оживить запрос. После явного confirm открывается только исходный валидированный HTTPS URL, пока текущие document/account/видимое окно не изменились. Это не замена отдельному system-browser auth flow.
9. **Windows/Linux icon и badge.** Проверьте `0 → 1 → 12 → 100 → 0`, прочтение, account switch/logout, восстановление окна и Quit. На Windows overlay показывает `99+` с полным accessibility description; отдельно нужны high-DPI, настройки панели и Explorer restart. На Linux зафиксируйте KDE/другой desktop environment, X11/Wayland и dock/taskbar: прямой запуск скачанного AppImage без установки → отказ (нет ярлыка) → повтор через меню → согласие (пользовательский `ru.exz-vps.chat.desktop.spike.desktop` и стабильная иконка). Проверьте idempotency, перемещение AppImage с новым явным согласием, чужой ярлык без overwrite, latest replay после смены аккаунта. Старые pins/cache могут требовать перепривязки; успешный LauncherEntry API не доказывает видимый badge. DND и пользовательский запрет badges не обходятся.
10. **Security и privacy.** Проверьте отсутствие прямого bridge у iframe/чужого origin и отказ невалидным IPC/payload, запрет произвольных схем и embedded IdP. Локальный диалог не загружает внешний сайт и не получает bridge сайта; cookies приложения не передаются системному браузеру. Журнал не содержит title/body; идентификаторы и session cookies всё равно требуют защиты и не публикуются вместе с evidence.

11. **Перезагрузка клиента.** Меню/tray и `Ctrl/Cmd+Shift+R` должны открывать одно cancel-default подтверждение. Отмена не перезагружает; согласие перезагружает текущий доверенный документ без cache. Звонок/передача файлов могут оборваться — предупреждение обязательно. Переход, новый account, исчезновение root/contents, loading и Quit обнуляют старое согласие. Восстановление из error/blank/missing root идёт только на fixed configured origin; arbitrary navigation/renderer input не получает reload privilege.

## Что остаётся за пределами принятого результата

- Deployment frontend/backend сайта, перенос инфраструктуры или истории разработки.
- Реальный IdP и серверный system-browser protocol без отдельного live evidence.
- Production signing/notarization и массовое распространение.
- Автоматические Release/production rollout, установленная updater-приёмка и background push после Quit. Локальная подготовка native updater transport не закрывает эти gates.
- Media/calls/screen sharing, Blob/P2P/external downloads и непротестированные file flows.
- Гарантированный показ OS notifications и одинаковая история/activation на всех desktop environments.

Разрешение этих вопросов требует отдельной реализации/приёмки. Ни наличие исходников D3, ни временные CI artifacts не закрывают перечисленные ограничения.
