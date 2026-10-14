# mutagen-ru-mcp

[![npm](https://img.shields.io/npm/v/mutagen-ru-mcp)](https://www.npmjs.com/package/mutagen-ru-mcp)
[![CI](https://github.com/SVorobiev-ru/mutagen-ru-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/SVorobiev-ru/mutagen-ru-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/mutagen-ru-mcp)](package.json)

> **Unofficial project, not affiliated with Mutagen. The data belongs to Mutagen (mutagen.ru).**

[Русский](README.md) · **English**

Mutagen for AI assistants. `mutagen-ru-mcp` is an MCP server for [Mutagen](https://mutagen.ru), a Russian SEO service built around Yandex data. Claude Code, Claude Desktop, Codex, Cursor, VS Code, Windsurf and other MCP clients get Yandex Wordstat frequencies, keyword tails, competition scores, Mega-tool reports and ready-made scenarios: "build a semantic core for 20 RUB", "group these phrases by page", "give me negative keywords for Yandex Direct". The agent sees a cost estimate before every paid call, and you set the hard spending limit.

Mutagen for code. The same package is the `mutagen-ru` CLI and a typed Node.js library. You can rebuild a semantic core on a schedule in GitHub Actions or cron, export it to CSV, XLSX and JSON, store it in a database and get a weekly pull request with new phrases. The cache, the task log and the budget limit work the same way in MCP, the CLI and the library.

The examples below use Russian search phrases: that is the data Mutagen works with.

## Contents

- [Quick start](#quick-start)
- [What you can do](#what-you-can-do)
- [Using it in your projects](#using-it-in-your-projects)
- [MCP tools and CLI commands](#mcp-tools-and-cli-commands)
- [How to save money](#how-to-save-money)
- [Settings](#settings)
- [Limitations and honest caveats](#limitations-and-honest-caveats)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)

## Quick start

You need Node.js 22.12 or newer.

### 1. API key

1. Sign up at [mutagen.ru](https://mutagen.ru/?r=94674) (the project author's referral link; plain sign-up is at https://mutagen.ru).
2. Get the key in your account: https://mutagen.ru/?api_config. On the same page turn on "Разрешить подключение только с ip" (allow connections only from listed IPs): the API works over plain HTTP only, see [limitations](#limitations-and-honest-caveats).
3. Top up the balance. The Wordstat parser and the competition check are paid from the balance (from 0.02 RUB per request). Mega-tool reports are available through the API only with a subscription: [plans](https://mutagen.ru/serp/?tarif).

### 2. Check

```bash
export MUTAGEN_API_KEY=your_key
npx -y -p mutagen-ru-mcp mutagen-ru balance
```

The balance call is free. If it answers, the key works.

The MCP server starts with `npx -y mutagen-ru-mcp`. Usually the client starts it for you; the configs below already contain this command.

### 3. Connect your AI assistant

In every example `MUTAGEN_BUDGET_RUB` is the spending limit in rubles for the whole MCP server process (until the client restarts it). Without it the limit is 50 RUB.

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add --env MUTAGEN_API_KEY=your_key --env MUTAGEN_BUDGET_RUB=50 \
  --transport stdio --scope user mutagen -- npx -y mutagen-ru-mcp
```

`--scope user` makes the server available in all projects. Check: `claude mcp get mutagen`.
</details>

<details>
<summary><b>Claude Desktop</b></summary>

File `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "mutagen": {
      "command": "npx",
      "args": ["-y", "mutagen-ru-mcp"],
      "env": {
        "MUTAGEN_API_KEY": "your_key",
        "MUTAGEN_BUDGET_RUB": "50"
      }
    }
  }
}
```

Restart Claude Desktop after editing.
</details>

<details>
<summary><b>Codex</b></summary>

`~/.codex/config.toml`:

```toml
[mcp_servers.mutagen]
command = "npx"
args = ["-y", "mutagen-ru-mcp"]
startup_timeout_sec = 30   # the first npx run downloads the package
tool_timeout_sec = 120

[mcp_servers.mutagen.env]
MUTAGEN_API_KEY = "your_key"
MUTAGEN_BUDGET_RUB = "50"
```

To keep the key out of the file, replace the `env` table with `env_vars = ["MUTAGEN_API_KEY"]`: Codex forwards the variable from your environment. The same server in one command: `codex mcp add mutagen --env MUTAGEN_API_KEY=your_key -- npx -y mutagen-ru-mcp`.
</details>

<details>
<summary><b>Cursor</b></summary>

`.cursor/mcp.json` in a project or `~/.cursor/mcp.json` for all projects:

```json
{
  "mcpServers": {
    "mutagen": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mutagen-ru-mcp"],
      "env": {
        "MUTAGEN_API_KEY": "${env:MUTAGEN_API_KEY}",
        "MUTAGEN_BUDGET_RUB": "50"
      }
    }
  }
}
```

`${env:MUTAGEN_API_KEY}` takes the key from the environment, so the file is safe to commit.
</details>

<details>
<summary><b>VS Code</b></summary>

`.vscode/mcp.json`. VS Code asks for the key on the first start and keeps it in secure storage:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "mutagen-key",
      "description": "Mutagen API key (https://mutagen.ru/?api_config)",
      "password": true
    }
  ],
  "servers": {
    "mutagen": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mutagen-ru-mcp"],
      "env": {
        "MUTAGEN_API_KEY": "${input:mutagen-key}",
        "MUTAGEN_BUDGET_RUB": "50"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Windsurf</b></summary>

Open `mcp_config.json` from the Cascade panel: `...` menu → MCPs → Open MCP config file. Today it lives at `~/.config/devin/mcp_config.json` (Windows: `%APPDATA%\devin\mcp_config.json`); older Windsurf versions use `~/.codeium/windsurf/mcp_config.json`.

```json
{
  "mcpServers": {
    "mutagen": {
      "command": "npx",
      "args": ["-y", "mutagen-ru-mcp"],
      "env": {
        "MUTAGEN_API_KEY": "${env:MUTAGEN_API_KEY}",
        "MUTAGEN_BUDGET_RUB": "50"
      }
    }
  }
}
```
</details>

The same configs as separate files are in [examples/clients](examples/clients).

**HTTP server.** For clients that connect by URL there is Streamable HTTP:

```bash
MUTAGEN_API_KEY=your_key npx -y mutagen-ru-mcp --http --port 3333
# client URL: http://127.0.0.1:3333/mcp
```

When listening on anything but localhost (`--host 0.0.0.0`), the token `MUTAGEN_MCP_HTTP_TOKEN` is required: the client sends it in the `Authorization: Bearer ...` header. Browser requests with an `Origin` header are accepted only from localhost; list other origins, comma-separated, in `MUTAGEN_MCP_ALLOWED_ORIGINS`. `MUTAGEN_BUDGET_RUB` is shared by all HTTP sessions of the process.

## What you can do

Below are requests as people type them in a chat, the tools the agent calls and what you get. The niche in the examples is stretch ceilings («натяжные потолки»), the Wordstat region is Russia (225). "Live answer" marks a real result of a request to Mutagen made on 14.10.2026, cut to the first rows. "Example" marks a table that shows the shape of the answer with made-up numbers.

Prices come from the live check of 14.10.2026: a frequency costs 0.02 RUB per phrase and match type, Wordstat keywords cost 0.02 RUB (200 phrases) or 0.20 RUB (2000 phrases), competition costs 0.30 RUB per phrase. Mega-tool reports do not charge money, but they need a subscription and use the daily request quota.

### 1. Build a semantic core for a new site or section

> Build a semantic core for the "stretch ceilings" section from the seeds «натяжные потолки» and «потолки под ключ». Budget 15 rubles, region Russia.

Agent: `mutagen_build_core` with `dry_run: true` → shows the estimate → after your "yes" the same call without `dry_run`. The scenario collects the seeds' tails, removes duplicates and obvious junk ("download", "jobs", "used" and so on), gets the exact frequency `"!phrase"` and groups phrases into clusters. The MCP prompt `build-core` walks the agent through these steps.

Estimate, live `--dry-run` answer for two seeds:

| Step | Method | Units | Sum |
|---|---|---|---|
| Seed tails (200 phrases) | `parser.get`, `wordstat_key_50` | 2 | 0.04 RUB |
| Exact frequency | `parser.mass.new`, `wordstat_qs` | 500 | 10.00 RUB |
| **Total** | | | **10.04 RUB** |

If the budget is below the estimate, the plan shrinks to fit: with 1.5 RUB the scenario says "plan reduced: max_phrases 500 → 73". The result is a table and a file (example):

| Phrase | Base frequency | "!Exact" | Cluster | Seed |
|---|---|---|---|---|
| натяжной потолок цена | 55 926 | 1 011 | натяжной потолок цена | натяжные потолки |
| сколько стоит натяжной потолок | 18 667 | 1 382 | сколько стоит натяжной потолок | натяжные потолки |
| … | | | | |

Price: by estimate, never above `budget_rub`. CLI: `mutagen-ru core "натяжные потолки" "потолки под ключ" --budget 15 -o core.xlsx`.

### 2. Expand the core with tails and suggestions

> Here is our core (core.csv). Find new phrases that are not in it yet, budget 5 rubles.

Agent: `mutagen_expand_core` (by default the seeds are the head phrases of the clusters) or `mutagen_wordstat_keywords` for one phrase. Live answer, Wordstat keywords, 200 phrases, 0.02 RUB:

| Phrase | Frequency |
|---|---|
| натяжной потолок | 1 073 667 |
| потолок под натяжной потолок | 56 753 |
| натяжной потолок цена | 55 926 |
| установка натяжных потолков | 52 489 |
| натяжные потолки фото | 40 119 |
| натяжной потолок своими руками | 32 939 |
| … 194 more rows | |

With a Mega-tool subscription `source: "serp"` takes tails from Mutagen's database (`report_keyword_tailings`); without one they come from Wordstat. `source: "auto"` picks for you. CLI: `mutagen-ru keywords "натяжные потолки" --depth 200 -o tails.csv`, `mutagen-ru expand -i core.csv --budget 5`.

### 3. Get base and exact frequencies, check competition

> Get the base and exact frequency for these four phrases. Then check competition for the two most frequent ones.

Agent: `mutagen_frequency` with `types: ["wordstat_n", "wordstat_qs"]`, then `mutagen_competition`. Live answer, 4 phrases × 2 types = 0.16 RUB:

| Phrase | Base | "!Exact" |
|---|---|---|
| натяжной потолок цена | 62 529 | 1 011 |
| установка натяжных потолков | 54 907 | 593 |
| натяжной потолок купить | 27 870 | 694 |
| сколько стоит натяжной потолок | 20 422 | 1 382 |

All Wordstat match types are available: base `n`, "phrase" `q`, "!exact" `qs`, [order] `no`, "[order]" `qo`, "[!exact order]" `qso`. Competition is Mutagen's 0–25 score (below 5 is low), plus the "quoted" frequency, the number of tails, Yandex Direct bids and the vital site (example):

| Phrase | Competition (0–25) | "Quoted" frequency | Tails |
|---|---|---|---|
| натяжной потолок цена | 12 | 4 800 | 950 |

Price: frequency 0.02 RUB × phrase × type, competition 0.30 RUB × phrase, a repeat of the same phrase within 7 days is free. Competition depends on Mutagen's link to Yandex Direct and can take a very long time, see [limitations](#limitations-and-honest-caveats). CLI: `mutagen-ru freq -t n,qs -i phrases.txt`, `mutagen-ru competition -i top.txt`.

### 4. Cluster phrases and map them to pages

> Group the phrases from tails.csv by page: which phrases should lead to the same page.

Agent: `mutagen_cluster`. Three modes:

- `lexical` — free and without API calls: grouping by shared words, word forms included (Snowball stemmer);
- `serp` — by shared URLs in the top results, like clustering on the Mutagen site; needs a subscription, 1 quota request per phrase, up to 300 phrases;
- `project` — take ready clusters of a Favorites («Избранное») project by its id (free).

Live answer, `lexical`, 40 phrases, free (shortened):

| Cluster | Phrase | Frequency |
|---|---|---|
| натяжной потолок цена | натяжной потолок цена | 55 926 |
| натяжной потолок цена | стоимость натяжного потолка | 11 164 |
| натяжной потолок цена | натяжной потолок цена за м2 | 4 421 |
| точечные светильники для натяжного потолка | точечные светильники для натяжного потолка | 5 767 |
| точечные светильники для натяжного потолка | встраиваемый светильник в натяжной потолок | 3 499 |
| натяжные потолки скрытый карниз | скрытый карниз в натяжном потолке | 3 650 |

Lexical grouping is rough: it merges phrases with the same words even when the intent differs (in the live run "lights" and "installation" ended up in the "price" cluster). For mapping phrases to pages the `serp` mode is more accurate. CLI: `mutagen-ru cluster -i tails.csv`, `mutagen-ru cluster --mode serp -i tails.csv`.

### 5. Pick Title, H1 and Description by frequency

> Suggest a Title, H1 and Description for the stretch ceiling prices page based on these phrases.

Agent: `mutagen_title_h1`. If the phrases already have frequencies, it is free. If not, the scenario gets the exact frequency: 0.02 RUB per phrase. Live answer for 15 phrases of the "price" cluster:

| Element | Text | Rationale |
|---|---|---|
| Title | Натяжной потолок цена — с установкой, за метр | head phrase «натяжной потолок цена» (55 926) + the tails of «потолок натяжной цена с установкой» (21 548) and «натяжной потолок цена за метр» (6 884) |
| H1 | Потолок натяжной цена с установкой | second most frequent wording (21 548) |
| Description | Натяжной потолок цена: с установкой, за метр. Узнайте подробнее на сайте! | head phrase + the same refinements + a call to action |

Words are never re-inflected: refinements are whole cluster phrases or their tails exactly as Wordstat returns them, so the draft never glues words from different phrases into one ungrammatical group. The city is appended after a comma. This is a draft with a frequency-based rationale, not finished copy: an editor polishes it. The `brand` and `city` parameters add a brand and a city. CLI: `mutagen-ru title -i price.csv --city Москва`.

### 6. Find phrases you have no page for

> Which queries do competitors from the top rank for that our site example.ru does not?

With a subscription the agent calls `mutagen_content_gap`: keywords of your domain and 5 competitors (Mutagen finds them, or set `competitors`); the difference is the phrases you have no page for. Price: 1 quota request per domain. Example:

| Phrase | Frequency | Competitors | Best position | Best competitor |
|---|---|---|---|---|
| натяжной потолок в ванной | 17 610 | 3 | 2 | a.ru |

Without a subscription: export the phrases you already have pages for (`pages.txt`) and compare them with the core using a free local operation:

```bash
mutagen-ru text compare -i pages.txt -i core.csv --implicit
```

Rows marked `only_b` are core phrases without a page. `--implicit` treats phrases that differ only in word forms or word order as equal.

### 7. Check rankings

> Where does example.ru rank for stretch ceiling queries?

Agent: `mutagen_domain_report` with `report_keywords_organic` (keywords and positions of a domain) or `mutagen_keyword_report` with `report_keyword_positions_organic` (top 50 for a phrase). Needs a subscription, 1 quota request. Example (Mutagen report columns):

| keyword | position | region_wsn | page |
|---|---|---|---|
| натяжные потолки под ключ | 7 | 3 100 | https://example.ru/catalog/ |

Honestly: these positions come from Mutagen's database, which it updates periodically; this is not a live check of search results. The API has no tool that checks a position right now, and Mutagen offers no free alternative. You can see your own site's positions in Yandex Webmaster.

### 8. Prepare a core for Yandex Direct: negative keywords

> Prepare negative keywords for a stretch ceiling campaign.

Agent: `mutagen_minus_words` (MCP prompt `direct-prep`). For a ready list of phrases it is free; for seeds it first collects Wordstat keywords (0.02 RUB per seed). Live answer for 200 phrases, free:

```text
-своими -руками -видео -фото -как -сделать -самостоятельно -авито
```

| Word | Category | Disputed | Phrases | Total frequency |
|---|---|---|---|---|
| своими руками | DIY | no | 9 | 65 594 |
| фото | Photo and video | no | 3 | 45 175 |
| работа | Jobs | yes | 1 | 9 173 |
| отзывы | Reviews and discussions | yes | 1 | 7 130 |

Disputed words stay out of the line: the decision is yours (`include_disputed` or `--disputed` adds them). Direct bids and forecasts are `mutagen_direct_bids`, 0.02 RUB per phrase, but right now this collection can take a very long time, see [limitations](#limitations-and-honest-caveats). CLI: `mutagen-ru minus -i tails.csv`, `mutagen-ru minus "натяжные потолки" --budget 1`.

### 9. Compare with competitors

> Who are example.ru's competitors in search, and for which queries do they beat us?

Agent: `mutagen_domain_report` with `report_domain_competitors` (competitors by keyword overlap), then `report_keywords_organic` for a competitor and `mutagen_content_gap`. All of these are Mega-tool reports: a subscription is needed, 1 quota request per report. Example (Mutagen report columns):

| domain | visibility | domain_organic_keywords |
|---|---|---|
| a.ru | 41.2 | 5 600 |

Without a subscription: build a core from the seeds the competitor targets (`mutagen_build_core`) and compare it with your list using `mutagen_text` with the `compare` operation.

### 10. Draft a content plan from the core

> Draft a content plan of informational articles from these phrases.

Agent: `mutagen_content_plan` (MCP prompt `content-plan`). For a ready list it is free: the scenario finds questions, groups them and sorts topics by total frequency. For seeds it first collects phrases (with a subscription, question tails from the Mega-tool; without one, Wordstat). Live answer for 200 phrases, free:

| Article topic | Head query | Total frequency | Questions |
|---|---|---|---|
| Как снять натяжной потолок? | как снять натяжной потолок | 154 372 | 26 |
| Натяжной потолок сколько? | натяжной потолок сколько | 55 783 | 3 |
| Чем отмыть натяжной потолок? | чем отмыть натяжной потолок | 10 198 | 2 |
| Можно ли делать натяжной потолок? | можно ли делать натяжной потолок | 2 376 | 1 |
| Что сначала обои или натяжной потолок? | что сначала обои или натяжной потолок | 2 282 | 1 |

The headlines are drafts worth rewriting. For chosen topics the agent can call `mutagen_title_h1`. CLI: `mutagen-ru plan -i tails.csv -o plan.xlsx`.

## Using it in your projects

All examples are in [examples/](examples). Two CLI flags matter in CI and cron: `--yes` approves the estimate without asking (without it a non-interactive run above 1 RUB exits with code 3), and `--budget N` caps the spending of one run.

### Scheduled collection: GitHub Actions

[examples/github-actions/weekly-core.yml](examples/github-actions/weekly-core.yml) builds the core once a week and keeps the XLSX and a spending report as a build artifact. The key lives in the repository secret `MUTAGEN_API_KEY`.

```yaml
- run: npm install --global mutagen-ru-mcp
- run: mutagen-ru core "натяжные потолки" --budget 20 --yes -o out/core.xlsx
  env:
    MUTAGEN_API_KEY: ${{ secrets.MUTAGEN_API_KEY }}
    MUTAGEN_BUDGET_RUB: "20"
```

### Scheduled collection: cron

[examples/cron/weekly-core.sh](examples/cron/weekly-core.sh) writes the core to a dated file; the line for `crontab -e` is in [examples/cron/crontab.txt](examples/cron/crontab.txt):

```cron
0 6 * * 1  /path/to/weekly-core.sh >> /var/log/mutagen-core.log 2>&1
```

### Export to CSV, XLSX, JSON

Every CLI command takes `-o file.csv|.xlsx|.json|.ndjson`, every MCP tool takes `save_as`. MCP writes files only inside `MUTAGEN_OUTPUT_DIR` (default `./mutagen-results`): a relative `save_as` is resolved against it, and a path leading out (`..`, symlinks) is refused. MCP does not overwrite an existing file: it saves the result next to it as "name (2).csv"; set `overwrite: true` to replace the file. For stdio only, `MUTAGEN_ALLOW_ANY_OUTPUT_PATH=1` allows any path. The CSV targets Russian Excel: «;» separator, decimal comma, BOM, protection against formulas in cells. Every file ends with the line «Данные: Мутаген (mutagen.ru)» ("Data: Mutagen"; in XLSX, the «Источник» sheet): Mutagen's API terms require it.

```bash
mutagen-ru freq -t n,qs -i phrases.txt -o freq.xlsx
mutagen-ru keywords "натяжные потолки" --format json > tails.json
```

### Google Sheets

There are two honest ways:

1. **Once.** File → Import → Upload → `core.csv`, separator type "Semicolon".
2. **Automatically.** `IMPORTDATA` reads only comma-separated CSV or TSV from a public URL. [examples/google-sheets/to-sheets-csv.mjs](examples/google-sheets/to-sheets-csv.mjs) turns the CLI's JSON export into comma-separated CSV. Put it in a public repository or at any public URL and enter in a cell:

   ```text
   =IMPORTDATA("https://raw.githubusercontent.com/SVorobiev-ru/REPO/main/semantic/core.sheets.csv")
   ```

   Google Sheets re-reads the file on its own, with a delay. A file from a private repository cannot be opened this way.

### Database

[examples/db/to-sqlite.mjs](examples/db/to-sqlite.mjs) stores the JSON export in SQLite through the built-in `node:sqlite` (Node 22.13+ or 24), with the collection date. The table makes the frequency history easy to query:

```bash
mutagen-ru core "натяжные потолки" --budget 20 --yes -o core.json
node examples/db/to-sqlite.mjs core.json semantic.db
```

### Node script

The library exports what the CLI and MCP run on: the API client (`MutagenClient`), the session with budget, cache and task log (`MutagenSession`), scenarios (`buildCore`, `expandCore`, clustering, negative keywords and others), local phrase processing and export (`writeTable`). Full example: [examples/node/build-core.mjs](examples/node/build-core.mjs):

```js
import { BudgetError, buildCore, loadConfig, MutagenSession, writeTable } from "mutagen-ru-mcp";

const session = MutagenSession.fromConfig(loadConfig()); // key and budget from environment variables
const params = { seeds: ["натяжные потолки"], budgetRub: 15 };

let result;
try {
  result = await buildCore(session, params);
} catch (error) {
  if (!(error instanceof BudgetError) || error.kind !== "needs_confirmation") throw error;
  // The estimate is above MUTAGEN_AUTO_APPROVE_RUB: approve it with the token from the error.
  result = await buildCore(session, params, { confirmToken: error.confirmToken });
}
await writeTable(result.table, "core.xlsx");
```

### An agent that updates the core weekly and opens a PR

[examples/github-actions/weekly-core-pr.yml](examples/github-actions/weekly-core-pr.yml): the CLI builds the core, the free local command `mutagen-ru text compare` compares it with the previous `semantic/core.csv`, new phrases go to `semantic/new-phrases.txt`, and [peter-evans/create-pull-request@v8](https://github.com/peter-evans/create-pull-request) opens a PR with the updated core. You review the diff and decide what to keep.

For this, enable Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests" in the repository.

## MCP tools and CLI commands

22 MCP tools and 18 CLI commands. Group is the value for `MUTAGEN_TOOLS`.

| MCP tool | CLI command | What it does | Price | Group |
|---|---|---|---|---|
| `mutagen_balance` | `balance` | Account balance | free | basic |
| `mutagen_spending` | `spending` | Spending and budget left, paid call log | free, local | basic |
| `mutagen_estimate` | `estimate` | Cost estimate of a call plan | free, local | basic |
| `mutagen_mass_tasks` | `mass list` | Mass parser jobs | free | basic |
| `mutagen_mass_result` | `mass get <id>` | Result of a mass job | free | basic |
| `mutagen_project_keywords` | `projects <id>` | Keywords and clusters of a Favorites project | free | basic |
| `mutagen_frequency` | `freq` | Wordstat frequency, 6 match types, region | 0.02 RUB × phrase × type | parser |
| `mutagen_wordstat_keywords` | `keywords` | Wordstat left column: 200 or 2000 phrases | 0.02 RUB (200), 0.20 RUB (2000) | parser |
| `mutagen_direct_bids` | `bids` | Yandex Direct bids and forecast | 0.02 RUB × phrase | parser |
| `mutagen_competition` | `competition` | Competition 0–25 and phrase statistics | 0.30 RUB × phrase, repeat within 7 days free | parser |
| `mutagen_keyword_report` | `report keyword <report> <phrase>` | Keyword reports: statistics, tails, questions, variations, LSI, top 50, ads | subscription, 1 quota request | serp |
| `mutagen_domain_report` | `report domain <report> <domain>` | Site reports: keywords, rising and falling, pages, competitors, ads | subscription, 1 quota request | serp |
| `mutagen_page_report` | `report page <report> <URL>` | Page reports: keywords, competitors, missed keywords | subscription, 1 quota request | serp |
| `mutagen_serp_report` | `report raw <report>` | Any `mutagen.serp.report` with filters | subscription, 1 quota request | serp |
| `mutagen_build_core` | `core` | Semantic core from seeds | by estimate, within the budget | scenarios |
| `mutagen_expand_core` | `expand` | New phrases for an existing core | by estimate, within the budget | scenarios |
| `mutagen_cluster` | `cluster` | Clusters: lexical, by SERP, from Favorites | free; by SERP — subscription, 1 quota request per phrase | scenarios |
| `mutagen_title_h1` | `title` | Title, H1, Description for a cluster | free with frequencies, else 0.02 RUB × phrase | scenarios |
| `mutagen_content_gap` | `gap` | Competitor phrases the site lacks | subscription, 1 quota request per domain | scenarios |
| `mutagen_minus_words` | `minus` | Negative keywords for Yandex Direct | free for phrases, by estimate for seeds | scenarios |
| `mutagen_content_plan` | `plan` | Content plan from questions | free for phrases, by estimate for seeds | scenarios |
| `mutagen_text` | `text <operation>` | Duplicates and implicit duplicates, dictionary, combinator, list comparison, filter, questions, counts | free, no API | text |

Paid MCP tools take `dry_run` (estimate only), `confirm_token` (approve the estimate), `force_refresh` (skip the cache), `save_as` and `overwrite` (save to a file in `MUTAGEN_OUTPUT_DIR`, replace an existing one), `fields` and `limit` (shorten the answer). Their CLI counterparts are `--dry-run`, `--yes`, `--refresh`, `-o`, `--limit`. Help for each command: `mutagen-ru <command> --help`.

The MCP server also provides:

- resources `mutagen://reference/reports` (Mega-tool reports and columns), `mutagen://reference/regions` (regions), `mutagen://reference/prices` (method prices and the date they were checked);
- prompts `build-core`, `expand-core`, `direct-prep`, `content-plan` — ready-made scenarios for the agent.

CLI exit codes: `0` success, `1` API error, `2` invalid arguments, `3` the estimate needs approval (`--yes`), `4` over budget or free-only mode is on, `130` interrupted.

## How to save money

- **Estimate before spending.** `--dry-run` in the CLI and `dry_run: true` in MCP show the plan and the price without calling the API. `mutagen_estimate` and `mutagen-ru estimate` price any plan: `mutagen-ru estimate --freq 500 -t n,qs --competition 50` → 35.00 RUB.
- **Budget limit.** `MUTAGEN_BUDGET_RUB` (50 RUB by default) is a hard spending limit per CLI run or per MCP server process: all its sessions, HTTP ones included, share one budget until a restart. A call that does not fit is refused before it reaches the API. `--budget N` in the CLI caps one run. Scenarios with a budget shrink their plan to fit.
- **Approval threshold.** Calls up to `MUTAGEN_AUTO_APPROVE_RUB` (1 RUB by default) run without questions. Above it, the CLI asks "Continue?" or expects `--yes`, and MCP returns the estimate and a `confirm_token`. If the client can ask a human through its own UI (elicitation), you are the one asked.
- **Free-only mode.** `MUTAGEN_FREE_ONLY=1` or `--free-only`: every paid call is refused; free ones (balance, mass jobs, local processing) keep working.
- **Cache.** Finished frequencies and competition are kept for 7 days, Mega-tool reports for 1 day (`MUTAGEN_CACHE_TTL_*_DAYS`). A repeat request served from the cache is free. Balance and task statuses are never cached. Skip the cache with `--refresh` or `force_refresh`, turn it off with `--no-cache` or `MUTAGEN_NO_CACHE=1`.
- **Task log and free repeats.** Every paid task goes to the log. If an answer got lost or the task is still running, repeating the same call picks up the task you already paid for and does not pay again. MCP waits for a result for about 45 seconds, then answers `processing`; repeat the call later, it is free. `--new-task` or `new_task: true` creates a new paid task instead of a stuck one.
- **Fewer tools, less context.** The descriptions and schemas of all 22 tools take about 34 thousand characters of the agent's context. `MUTAGEN_TOOLS` keeps only the groups you need: for example, `basic,parser,text` is about 14 thousand characters. Groups: `basic`, `parser`, `serp`, `scenarios`, `text`.
- **Big results go to a file.** MCP gives the agent a summary and the first rows, and the full result goes to the `save_as` file. `fields` and `limit` drop extra columns and rows, for example the 30 columns of a Direct forecast.
- **Local processing is free.** Duplicates, implicit duplicates, dictionary, word filters, lexical clustering, negative keywords and a content plan from a ready list run locally, with no key and no money.

## Settings

All settings are environment variables. Sample: [.env.example](.env.example).

| Variable | Default | What it sets |
|---|---|---|
| `MUTAGEN_API_KEY` | — | API key. Without it only local operations work |
| `MUTAGEN_BUDGET_RUB` | `50` | Spending limit, RUB: per CLI run or per MCP server process (shared by all sessions) |
| `MUTAGEN_AUTO_APPROVE_RUB` | `1` | Calls up to this sum run without approval, RUB |
| `MUTAGEN_FREE_ONLY` | `0` | `1` refuses every paid call |
| `MUTAGEN_TOOLS` | all groups | MCP tool groups: `basic,parser,serp,scenarios,text` |
| `MUTAGEN_OUTPUT_DIR` | `./mutagen-results` | Where MCP saves files; `save_as` stays inside it |
| `MUTAGEN_ALLOW_ANY_OUTPUT_PATH` | `0` | `1` lets `save_as` point anywhere; stdio only, ignored over HTTP |
| `MUTAGEN_MCP_WAIT_SECONDS` | `45` | How long an MCP call waits for a Mutagen task before answering `processing` |
| `MUTAGEN_MCP_HTTP_TOKEN` | — | Bearer token for `--http`; required when `--host` is not localhost |
| `MUTAGEN_MCP_ALLOWED_ORIGINS` | — | Comma-separated browser `Origin`s allowed for `--http` beyond localhost; without them requests with `Origin` are refused |
| `MUTAGEN_CACHE_DIR` | `~/.cache/mutagen-ru-mcp` | Cache directory (Windows: `%LOCALAPPDATA%\mutagen-ru-mcp\cache`) |
| `MUTAGEN_STATE_DIR` | `~/.local/state/mutagen-ru-mcp` | Task log directory (Windows: `%LOCALAPPDATA%\mutagen-ru-mcp\state`) |
| `MUTAGEN_CACHE_TTL_FREQUENCY_DAYS` | `7` | Frequency cache lifetime, days |
| `MUTAGEN_CACHE_TTL_COMPETITION_DAYS` | `7` | Competition cache lifetime, days |
| `MUTAGEN_CACHE_TTL_REPORT_DAYS` | `1` | Report cache lifetime, days |
| `MUTAGEN_NO_CACHE` | `0` | `1` disables reading and writing the cache |
| `MUTAGEN_PRICES_JSON` | — | Override method prices if Mutagen changes them |
| `MUTAGEN_CONCURRENCY` | `2` | Concurrent API requests |
| `MUTAGEN_RPS` | `3` | Requests per second |
| `MUTAGEN_BASE_URL` | `http://api.mutagen.ru/json` | API address |

## Limitations and honest caveats

- **The API is HTTP only.** `api.mutagen.ru` has no HTTPS; the key travels in plain text inside the request URL. Turn on the IP allow list in your account ("Разрешить подключение только с ip"): then a stolen key will not work from someone else's address. In our logs, errors and files the key is replaced with `***`.
- **Mega-tool reports need a subscription.** Database tails, questions, LSI, positions, site and page keywords, competitors, SERP clustering and gap search answer "subscription required" (error 111) without one. Along with the error the agent gets a hint on what to use instead without a subscription.
- **Subscription limits.** Reports use a daily request quota, and rows per report and exported rows per month are capped by the plan. According to the site on 14.10.2026: "Простой" (Basic) — 950 RUB per month, 300 requests per day, 20 000 rows per report; "Расширенный" (Extended) — 1 250 RUB, 1 500 requests; "Продвинутый" (Advanced) — 2 450 RUB, 6 000 requests. Current terms are on the [plans page](https://mutagen.ru/serp/?tarif). When the quota runs out, Mutagen answers with error 112.
- **No list of Favorites projects.** The API has no such method, although the documentation describes it. Project keywords are available by id, and the id comes from the project page URL in your account (Избранное → project). The API cannot create projects or add keywords to them.
- **No Wordstat right column.** Wordstat keywords return only the left column: 200 or 2000 phrases.
- **Competition and Direct bids can hang.** Both depend on Mutagen's link to Yandex Direct. In October 2026 they took more than 40 minutes. Money is charged when the task is created; polling again is free, and repeating the same call picks up the task you already paid for. If a task hangs for more than 2 hours, the answer says plainly that Mutagen or Direct has probably failed and suggests checking the account or writing to support. Competition ignores the region, the same as on the Mutagen site.
- **Wordstat frequencies are approximate and change.** They are Yandex's estimate and drift from month to month. Different collection methods give different numbers: in the live check «натяжной потолок цена» had 55 926 in the Wordstat left column and 62 529 as a separate base frequency request. Compare phrases collected the same way.
- **Positions come from Mutagen's database.** This is not a live check of search results: the database is updated periodically.
- **Approval through the agent protects against accidents, not malice.** If the MCP client cannot ask a human, the agent itself receives the `confirm_token` and can approve the estimate without you. The only hard limit is `MUTAGEN_BUDGET_RUB`. Set it to an amount you can afford to lose.
- **Site features missing from the API are missing here too.** We do not automate Mutagen's web interface: only the official API and local processing. Site ratings, project creation and clustering on Mutagen's side are not available.

## FAQ

**Is this an official Mutagen client?**
No. It is an independent open-source project, not affiliated with Mutagen. The data belongs to Mutagen; every answer and file carries the note «Данные: Мутаген (mutagen.ru)».

**Do I need a subscription?**
Not for frequencies, Wordstat keywords, competition, Direct bids and all local operations: the balance is enough. A subscription is needed for Mega-tool reports: database tails, positions, site keywords, competitors, SERP clustering.

**How much does a semantic core cost?**
Two seeds, 200 tails each, exact frequency for 500 phrases — 10.04 RUB. A competition check for the top 20 phrases adds 6 RUB. `--dry-run` shows the exact estimate for your parameters.

**What works without a key?**
`mutagen_text` and `mutagen-ru text`, lexical clustering, negative keywords and a content plan from a ready phrase list, Title and H1 for phrases with frequencies. They do not call the API.

**Can the agent spend all my money?**
No more than `MUTAGEN_BUDGET_RUB` per CLI run or per MCP server lifetime. Every call above `MUTAGEN_AUTO_APPROVE_RUB` needs approval. To be completely sure, set `MUTAGEN_FREE_ONLY=1`.

**Competition answered `processing`. Was I charged?**
Yes, when the task was created. Repeat the same call later: it finds the task in the log and does not pay again.

**Why do frequencies differ from what I see in Wordstat?**
Wordstat shows an estimate that changes, and different match types and collection methods give different numbers. See [limitations](#limitations-and-honest-caveats).

**How do I connect a client that is not listed?**
Any MCP client with stdio starts the server with `npx -y mutagen-ru-mcp` and the `MUTAGEN_API_KEY` variable. For clients that connect by URL use `npx -y mutagen-ru-mcp --http`.

## Contributing

Bugs, ideas and new API methods go to [issues](https://github.com/SVorobiev-ru/mutagen-ru-mcp/issues). How to run the project, the tests and the commit style are in [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities as described in [SECURITY.md](SECURITY.md), not in public issues. Please never post your API key in issues or logs.

## License

[MIT](LICENSE). The project is unofficial and not affiliated with Mutagen. "Мутаген" (Mutagen) and mutagen.ru belong to their owners. Data received through the API belongs to Mutagen; the terms of its use are in the [API documentation](https://mutagen.ru/?p=api) and the [user agreement](https://mutagen.ru/?p=pay_info).
