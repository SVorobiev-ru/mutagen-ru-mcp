# Примеры

Неофициальный проект, не связан с Мутагеном. Данные принадлежат Мутагену (mutagen.ru).

| Папка | Что внутри |
|---|---|
| [clients](clients) | Готовые конфиги MCP: Claude Code, Claude Desktop, Codex, Cursor, VS Code, Windsurf |
| [node](node) | `build-core.mjs` — ядро по маркерам через библиотеку, выгрузка в XLSX |
| [github-actions](github-actions) | `weekly-core.yml` — сбор ядра раз в неделю в артефакт; `weekly-core-pr.yml` — сбор и PR с новыми фразами |
| [cron](cron) | `weekly-core.sh` и строка для `crontab` |
| [google-sheets](google-sheets) | `to-sheets-csv.mjs` — CSV с запятыми для `IMPORTDATA` |
| [db](db) | `to-sqlite.mjs` — история частот в SQLite через `node:sqlite` |

Платные примеры тратят деньги с баланса Мутагена. Сначала посмотрите смету: `--dry-run` в CLI или `DRY_RUN=1` для `node/build-core.mjs`. Предел трат задает `MUTAGEN_BUDGET_RUB`.

Ключ API передавайте только через переменную окружения или секрет CI. Не коммитьте его в репозиторий.
