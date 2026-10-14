import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MISSING_KEY_RU } from "../../../src/mcp/links.js";
import { API_KEY, cleanup, cli, json, massApi, tempDir } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
  return cleanup();
});

const phrases = (n: number) => Array.from({ length: n }, (_, i) => `фраза ${i + 1}`);

const checkKeyApi = {
  "check_key.new": () => json({ task_id: 9, status: "created" }),
  "check_key.get": () =>
    json({ status: "completed", key: "окна", strong: 12, vital: "", vital_site: "" }),
};

function parsersOf(calls: { url: string; body: unknown }[]): string[] {
  const parsers = calls
    .filter((call) => call.url.includes("parser.mass.new") || call.url.includes("parser.get"))
    .map((call) => (call.body as { parser: string }).parser);
  return [...new Set(parsers)];
}

function keysOf(calls: { url: string; body: unknown }[]): string[] {
  return calls
    .filter((call) => call.url.includes("parser.get"))
    .map((call) => (call.body as { key: string }).key);
}

describe("basics", () => {
  it("prints help and version with exit code 0", async () => {
    const help = await cli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("freq");
    expect(help.stdout).toContain("Частотность");
    const version = await cli(["--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("exits with 2 on usage errors", async () => {
    expect((await cli(["nope"])).code).toBe(2);
    expect((await cli(["freq", "-t", "zz", "окна"])).code).toBe(2);
    expect((await cli(["freq", "окна", "--limit", "0"])).code).toBe(2);
    expect((await cli(["balance", "--budget", "x"])).code).toBe(2);
    const output = await cli(["balance", "-o", "out.txt"]);
    expect(output.code).toBe(2);
    expect(output.stderr).toContain(".xlsx");
  });

  it("reports a missing key with the MCP text and exit code 2", async () => {
    const result = await cli(["freq", "окна пвх", "--dry-run"], {}, { key: false });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(MISSING_KEY_RU);
    expect(result.calls).toHaveLength(0);
  });

  it("reports invalid environment settings as a usage error", async () => {
    const result = await cli(["balance"], {}, { env: { MUTAGEN_BUDGET_RUB: "много" } });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("MUTAGEN_BUDGET_RUB");
  });
});

describe("balance", () => {
  it("prints CSV with the source note when stdout is not a TTY", async () => {
    const { code, stdout, stderr, count } = await cli(["balance"], {
      balance: () => json({ balance: "250.4" }),
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Баланс, ₽");
    expect(stdout).toContain("250,4");
    expect(stdout).toContain("Данные: Мутаген (mutagen.ru)");
    expect(stdout.startsWith("﻿")).toBe(false);
    expect(stderr).toContain("250.40 ₽");
    expect(count("balance")).toBe(1);
  });

  it("prints a text table in a TTY with the source note on stderr", async () => {
    const { code, stdout, stderr } = await cli(
      ["balance"],
      { balance: () => json({ balance: "5" }) },
      { stdoutIsTTY: true },
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/Баланс, ₽\n-+\n\s*5\n/);
    expect(stdout).toContain("1 строк / 1 rows.");
    expect(stdout).not.toContain("mutagen.ru");
    expect(stderr).toContain("Данные: Мутаген (mutagen.ru)");
  });

  it("keeps stderr quiet with --quiet", async () => {
    const { stderr } = await cli(["balance", "--quiet"], {
      balance: () => json({ balance: "5" }),
    });
    expect(stderr).toBe("");
  });

  it("maps API errors to exit code 1 and auth errors without leaking the key", async () => {
    const result = await cli(["balance"], {
      balance: () => json({ error_id: 101, error_msg: `Authorization failed ${API_KEY}` }),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("101");
    expect(result.stderr).not.toContain(API_KEY);
  });

  it("maps a low balance error to exit code 4", async () => {
    const result = await cli(["balance"], {
      balance: () => json({ error_id: 106, error_msg: "Not enough money" }),
    });
    expect(result.code).toBe(4);
  });
});

describe("freq", () => {
  it("takes phrases from arguments", async () => {
    const { code, stdout, calls } = await cli(["freq", "окна", "двери"], massApi());
    expect(code).toBe(0);
    expect(stdout).toContain("Фраза;Базовая;Регион");
    expect(stdout).toContain("окна;10;0");
    expect(stdout).toContain("двери;20;0");
    expect(parsersOf(calls)).toEqual(["wordstat_n"]);
  });

  it("reads a file, skipping blank lines and # comments", async () => {
    const root = await tempDir();
    await writeFile(join(root, "list.txt"), "﻿# маркеры\nокна\n\n  двери  \r\n#x\n");
    const { code, calls } = await cli(["freq", "-i", "list.txt"], massApi(), { root });
    expect(code).toBe(0);
    expect(keysOf(calls)).toEqual(["окна", "двери"]);
  });

  it("reads stdin when it is not a TTY and no phrases are given", async () => {
    const { code, stdout } = await cli(["freq"], massApi(), { stdin: "окна\nдвери\n" });
    expect(code).toBe(0);
    expect(stdout).toContain("двери;20");
  });

  it("reads -i - from stdin", async () => {
    const { code, stdout } = await cli(["freq", "-i", "-"], massApi(), { stdin: "окна\n" });
    expect(code).toBe(0);
    expect(stdout).toContain("окна;10");
  });

  it("fails with 2 without phrases or with a missing file", async () => {
    const empty = await cli(["freq"], massApi(), { stdinIsTTY: true });
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain("Нет фраз");
    const missing = await cli(["freq", "-i", "nope.txt"], massApi());
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("nope.txt");
  });

  it("maps short type aliases and full names", async () => {
    const { code, stdout, calls } = await cli(
      ["freq", "окна", "-t", "n,qs,wordstat_qso,n"],
      massApi(),
    );
    expect(code).toBe(0);
    expect(parsersOf(calls)).toEqual(["wordstat_n", "wordstat_qs", "wordstat_qso"]);
    expect(stdout).toContain('Фраза;Базовая;"""!Точная""";"""[!Точная с порядком]""";Регион');
  });

  it("shows the estimate with --dry-run without touching the network", async () => {
    const { code, stdout, stderr, calls } = await cli(
      ["freq", ...phrases(3), "-t", "n,q", "--dry-run"],
      massApi(),
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(stdout).toContain("parser.get;wordstat_q;3;3;0,02;0,06");
    expect(stderr).toContain("Смета: 0.12 ₽");
    expect(stderr).toContain("API не вызывалось");
  });

  it("prints the --json structure", async () => {
    const { code, stdout, stderr } = await cli(["freq", "окна", "двери", "--json"], massApi());
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result).toEqual({
      status: "ok",
      rows: [
        { phrase: "окна", wordstat_n: 10, region: "0" },
        { phrase: "двери", wordstat_n: 20, region: "0" },
      ],
      total: 2,
      estimate: {
        totalRub: 0.04,
        quotaRequests: 0,
        requiresSubscription: false,
        unconfirmedPrices: false,
      },
      spending: { budgetRub: 50, spentRub: 0.04, remainingRub: 49.96 },
      source: "mutagen.ru",
    });
    expect(stderr).toContain("Списано: 0.04 ₽");
  });

  it("uses the cache on the second run and --refresh skips the ledger reuse", async () => {
    const root = await tempDir();
    const api = massApi();
    const first = await cli(["freq", "окна"], api, { root });
    expect(first.count("parser.get")).toBe(1);
    const second = await cli(["freq", "окна"], api, { root });
    expect(second.code).toBe(0);
    expect(second.calls).toHaveLength(0);
    expect(second.stderr).toContain("Из кэша");
    const fresh = await cli(["freq", "окна", "--refresh"], api, { root });
    expect(fresh.count("parser.get")).toBe(1);
    expect(fresh.stderr).toContain("Списано: 0.02 ₽");
    const mass = await cli(["freq", ...phrases(11)], api, { root });
    expect(mass.count("parser.mass.new")).toBe(1);
    const again = await cli(["freq", ...phrases(11), "--no-cache"], api, { root });
    expect(again.count("parser.mass.new")).toBe(0);
    expect(again.count("parser.mass.id")).toBe(1);
    const newTask = await cli(["freq", ...phrases(11), "--refresh", "--new-task"], api, { root });
    expect(newTask.count("parser.mass.new")).toBe(1);
  });

  it("limits printed rows with --limit and --format", async () => {
    const shown = await cli(["freq", ...phrases(25)], massApi(), { stdoutIsTTY: true });
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("25 строк, показано 20 / 25 rows.");
    const csv = await cli(
      ["freq", ...phrases(25), "--yes", "--limit", "3", "--format", "csv"],
      massApi(),
      {
        stdoutIsTTY: true,
      },
    );
    expect(csv.stdout.trim().split("\r\n").slice(0, 4)).toHaveLength(4);
    expect(csv.stdout).not.toContain("фраза 4;");
    const json = await cli(["freq", "окна", "--format", "json"], massApi());
    expect(JSON.parse(json.stdout).meta.source).toBe("mutagen.ru");
  });
});

describe("confirmation", () => {
  it("exits with 3 without a TTY and without --yes, before any paid call", async () => {
    const { code, stderr, count } = await cli(["competition", ...phrases(4)], checkKeyApi);
    expect(code).toBe(3);
    expect(stderr).toContain("--yes");
    expect(stderr).toContain("--dry-run");
    expect(stderr).toContain("Смета: 1.20 ₽");
    expect(count("check_key.new")).toBe(0);
  });

  it("runs with --yes", async () => {
    const { code, stdout, count } = await cli(["competition", ...phrases(4), "--yes"], checkKeyApi);
    expect(code).toBe(0);
    expect(count("check_key.new")).toBe(4);
    expect(stdout).toContain("фраза 1;12");
  });

  it("asks in a TTY and runs on «y»", async () => {
    const { code, stderr, count } = await cli(["competition", ...phrases(4)], checkKeyApi, {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      stdin: "y\n",
    });
    expect(code).toBe(0);
    expect(stderr).toContain("Продолжить? / Continue? [y/N]");
    expect(stderr).toContain("check_key.new");
    expect(count("check_key.new")).toBe(4);
  });

  it("cancels in a TTY on «n» or on end of input", async () => {
    for (const stdin of ["n\n", ""]) {
      const { code, stderr, count } = await cli(["competition", ...phrases(4)], checkKeyApi, {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        stdin,
      });
      expect(code).toBe(3);
      expect(stderr).toContain("Отменено");
      expect(count("check_key.new")).toBe(0);
    }
  });

  it("always asks for unconfirmed prices", async () => {
    const result = await cli(
      ["keywords", "окна"],
      {},
      {
        env: { MUTAGEN_PRICES_JSON: '{"parser.wordstat_key_50":{"rub":0.02,"confirmed":false}}' },
      },
    );
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("Цена не подтверждена");
  });
});

describe("budget guards", () => {
  it("refuses paid calls with --free-only and MUTAGEN_FREE_ONLY", async () => {
    const flag = await cli(["freq", "окна", "--free-only"], massApi());
    expect(flag.code).toBe(4);
    expect(flag.stderr).toContain("только бесплатное");
    expect(flag.calls).toHaveLength(0);
    const env = await cli(["competition", "окна", "--yes"], checkKeyApi, {
      env: { MUTAGEN_FREE_ONLY: "1" },
    });
    expect(env.code).toBe(4);
  });

  it("takes the smaller budget from the flag and refuses over it", async () => {
    const result = await cli(["competition", ...phrases(4), "--yes", "--budget", "1"], checkKeyApi);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("больше остатка бюджета");
    expect(result.stderr).toContain("увеличьте MUTAGEN_BUDGET_RUB");
    expect(result.stderr).toContain("--budget может только уменьшить");
    expect(result.stderr).not.toContain("поднимите --budget");
    const larger = await cli(
      ["competition", ...phrases(4), "--budget", "500", "--dry-run", "--json"],
      {},
    );
    expect(JSON.parse(larger.stdout).spending.budgetRub).toBe(50);
  });
});

describe("files", () => {
  it("writes .xlsx and .csv with -o and keeps stdout empty in a pipe", async () => {
    const root = await tempDir();
    const xlsx = await cli(["freq", "окна", "-o", "out/result.xlsx"], massApi(), { root });
    expect(xlsx.code).toBe(0);
    expect(xlsx.stdout).toBe("");
    expect(xlsx.stderr).toContain(join(root, "out", "result.xlsx"));
    const bytes = await readFile(join(root, "out", "result.xlsx"));
    expect(bytes.subarray(0, 2).toString()).toBe("PK");

    const csv = await cli(["freq", "окна", "-o", "result.csv", "--json"], massApi(), { root });
    expect(JSON.parse(csv.stdout).file).toBe(join(root, "result.csv"));
    const text = await readFile(join(root, "result.csv"), "utf8");
    expect(text.startsWith("﻿")).toBe(true);
    expect(text).toContain("Данные: Мутаген (mutagen.ru)");
  });

  it("reports a failed save with exit code 1 but still prints the data", async () => {
    const root = await tempDir();
    await writeFile(join(root, "blocker"), "");
    const result = await cli(["freq", "окна", "-o", "blocker/x.csv"], massApi(), { root });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("окна;10");
    expect(result.stderr).toContain("Не удалось сохранить файл");
  });
});

describe("other commands", () => {
  it("keywords, bids and competition render their tables", async () => {
    const keywords = await cli(["keywords", "окна", "--depth", "2000", "--yes"], {
      "parser.get": () =>
        json({
          status: "finish",
          data: { frequency: 120, count_keys: 2000, array: { "окна пвх": "100" } },
        }),
    });
    expect(keywords.code).toBe(0);
    expect(parsersOf(keywords.calls)).toEqual(["wordstat_key"]);
    expect(keywords.stdout).toContain("Фраза;Частотность\r\n");
    expect(keywords.stdout).toContain("окна пвх;100");
    expect(keywords.stderr).toContain("Списано: 0.20 ₽");
    expect((await cli(["keywords", "x", "--depth", "300"])).code).toBe(2);

    const bids = await cli(["bids", "окна", "-r", "213", "--yes"], {
      "parser.get": () => json({ status: "finish", data: { shows: 40, bid1: 7 } }),
    });
    expect(bids.code).toBe(0);
    expect(bids.calls[0]?.body).toMatchObject({ region_id: "213" });
    expect(bids.stdout).toContain("окна;40;7");
  });

  it("mass list and mass get", async () => {
    const handlers = {
      "parser.mass.list": () =>
        json({ "7": { name: "x", parser: "wordstat_n", count: 2, time: 1, status: "finish" } }),
      "parser.mass.id": () =>
        json({ status: "finish", parser: "wordstat_n", data: { окна: 5, двери: 7 } }),
    };
    const list = await cli(["mass", "list"], handlers);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("7;x;wordstat_n");
    const get = await cli(["mass", "get", "7", "--wait"], handlers);
    expect(get.code).toBe(0);
    expect(get.stdout).toContain("двери;7");
    expect(get.stderr).toContain("Задание / Job 7: finish");
    expect((await cli(["mass", "get", "abc"], handlers)).code).toBe(2);
  });

  it("projects needs an id and prints the project keywords", async () => {
    const handlers = {
      "progect.keywords": () => json([{ keyword: "потолок", claster_id: "1" }]),
    };
    const missing = await cli(["projects"], handlers);
    expect(missing.code).toBe(2);
    expect(missing.calls).toHaveLength(0);
    expect((await cli(["projects", "3"], handlers)).stdout).toContain("потолок;1");
  });

  it("estimate works without a key", async () => {
    const result = await cli(
      [
        "estimate",
        "--freq",
        "100",
        "-t",
        "n,qs",
        "--competition",
        "10",
        "--wordstat-keys",
        "1",
        "--depth",
        "2000",
        "--bids",
        "2",
        "--reports",
        "3",
      ],
      {},
      { key: false },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Смета: 7.24 ₽, квота: 3 запр.");
    expect(result.stderr).toContain("Укладывается в бюджет");
    const over = await cli(["estimate", "--competition", "1000"], {}, { key: false });
    expect(over.stderr).toContain("Больше бюджета");
    expect((await cli(["estimate"], {}, { key: false })).code).toBe(2);
  });

  it("spending sums the ledger for the last 24 hours", async () => {
    const root = await tempDir();
    await cli(["freq", "окна", "двери"], massApi(), { root });
    const result = await cli(
      ["spending", "--budget", "10", "--free-only"],
      {},
      { root, key: false },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("списано 0.04 ₽ (2 платных вызовов)");
    expect(result.stderr).toContain("Бюджет на запуск: 10.00 ₽");
    expect(result.stderr).toContain("только бесплатное");
    expect(result.stdout).toContain("parser.get;done;0,02;");
  });
});

describe("report", () => {
  const rows = () => json([{ keyword: "купить квадроцикл", region_wsn: 100, extra: 1 }]);

  it("resolves short report names", async () => {
    const result = await cli(["report", "keyword", "tailings", "квадроцикл"], {
      "serp.report": rows,
    });
    expect(result.code).toBe(0);
    expect(result.calls[0]?.body).toMatchObject({
      report: "report_keyword_tailings",
      region: "yandex_msk",
      keyword: "квадроцикл",
    });
    expect(result.stdout).toContain("купить квадроцикл;100;1");

    const domain = await cli(
      [
        "report",
        "domain",
        "keywords_organic",
        "example.ru",
        "--subdomains",
        "-r",
        "yandex_spb",
        "--sort",
        "region_wsn desc",
        "--limit",
        "5",
        "--filter",
        '[{"column":"position","filter_type":"<=","val":10}]',
      ],
      { "serp.report": rows },
    );
    expect(domain.code).toBe(0);
    expect(domain.calls[0]?.body).toMatchObject({
      report: "report_keywords_organic",
      domain_with_subdomains: "example.ru",
      region: "yandex_spb",
      sort: "region_wsn desc",
      limit: 5,
    });

    const page = await cli(["report", "page", "info", "https://example.ru/a"], {
      "serp.report": rows,
    });
    expect(page.calls[0]?.body).toMatchObject({
      report: "report_page_info",
      page: "https://example.ru/a",
    });
  });

  it("rejects unknown names with the list of reports", async () => {
    const result = await cli(["report", "keyword", "tailngs", "x"], {});
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("keyword_tailings");
    expect(result.stderr).toContain("keyword_info");
    expect(result.calls).toHaveLength(0);
    expect((await cli(["report", "site", "info", "x"], {})).code).toBe(2);
  });

  it("takes a keyword list from a file and supports raw reports", async () => {
    const root = await tempDir();
    await writeFile(join(root, "keys.txt"), "окна\nдвери\n");
    const list = await cli(
      ["report", "keyword", "keyword_info", "-i", "keys.txt"],
      { "serp.report": rows },
      { root },
    );
    expect(list.code).toBe(0);
    expect(list.calls[0]?.body).toMatchObject({ keywords: "окна,двери" });
    expect(
      (await cli(["report", "keyword", "info", "x", "-i", "keys.txt"], {}, { root })).code,
    ).toBe(2);

    const raw = await cli(["report", "raw", "report_domain_info", "example.ru"], {
      "serp.report": rows,
    });
    expect(raw.calls[0]?.body).toMatchObject({
      report: "report_domain_info",
      domain: "example.ru",
    });
    const rawKeywords = await cli(
      ["report", "raw", "keyword_variations", "a,b", "--object", "keywords"],
      { "serp.report": rows },
    );
    expect(rawKeywords.calls[0]?.body).toMatchObject({ keywords: "a,b" });
    expect((await cli(["report", "raw", "keyword_info", "a", "--object", "site"], {})).code).toBe(
      2,
    );
  });

  it("validates the target, the filter and the region", async () => {
    expect((await cli(["report", "domain", "info"], {})).code).toBe(2);
    const filter = await cli(["report", "domain", "info", "x.ru", "--filter", "{oops"], {});
    expect(filter.code).toBe(2);
    expect(filter.stderr).toContain("--filter");
    expect((await cli(["report", "domain", "info", "x.ru", "-r", "mars"], {})).code).toBe(2);
  });

  it("counts rows with --count and estimates the quota with --dry-run", async () => {
    const count = await cli(["report", "keyword", "tailings", "x", "--count"], {
      "serp.report": () => json({ count: 42 }),
    });
    expect(count.code).toBe(0);
    expect(count.calls[0]?.body).toMatchObject({ count: 1 });
    expect(count.stdout).toContain("42");
    const dry = await cli(["report", "keyword", "tailings", "x", "--count", "--dry-run"], {});
    expect(dry.calls).toHaveLength(0);
    expect(dry.stderr).toContain("квота: 1 запр.");
  });

  it("explains the missing subscription", async () => {
    const result = await cli(["report", "keyword", "tailings", "x"], {
      "serp.report": () => json({ error_id: 111, error_msg: "subscription required" }),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Нужна подписка");
  });
});

describe("secrets and interrupts", () => {
  it("never prints the key, even with DEBUG", async () => {
    const outputs: string[] = [];
    const handlers = {
      "progect.keywords": () => json([{ keyword: `leak ${API_KEY}`, claster_id: null }]),
      balance: () => json({ error_id: 101, error_msg: `bad key ${API_KEY}` }),
    };
    for (const argv of [
      ["projects", "1"],
      ["projects", "1", "--json"],
      ["projects", "1", "--format", "table"],
      ["balance"],
      ["freq", "окна", "--dry-run", "--json"],
    ]) {
      const result = await cli(argv, handlers, { env: { DEBUG: "mutagen-ru" } });
      outputs.push(result.stdout, result.stderr);
    }
    expect(outputs.join("\n")).toContain("leak ***");
    for (const output of outputs) expect(output).not.toContain(API_KEY);
  });

  it("returns 130 when aborted", async () => {
    const controller = new AbortController();
    const result = await cli(
      ["balance"],
      {
        balance: (call) =>
          new Promise<Response>((_resolve, reject) => {
            call.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            controller.abort();
          }),
      },
      { signal: controller.signal },
    );
    expect(result.code).toBe(130);
    expect(result.stderr).toContain("Прервано");
  });

  it("waits up to 30 minutes with progress every 30 s, then explains the free repeat", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const running = cli(["bids", "окна"], { "parser.get": () => json({ status: "process" }) });
    let done = false;
    void running.finally(() => {
      done = true;
    });
    while (!done) {
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(5_000);
    }
    const result = await running;
    expect(result.code).toBe(1);
    const progress = result.stderr.match(/Мутаген еще считает/g) ?? [];
    expect(progress.length).toBeGreaterThan(50);
    expect(progress.length).toBeLessThanOrEqual(60);
    expect(result.stderr).toContain("Ctrl+C прерывает, повтор команды бесплатно подхватит задачу");
    expect(result.stderr).toContain("Повторите тот же вызов позже — повтор бесплатный");
    expect(result.stderr).toContain("parser.get direct «окна»");
  });

  it("explains on Ctrl+C that a repeat picks the tasks up for free", async () => {
    const controller = new AbortController();
    const result = await cli(
      ["bids", "окна"],
      {
        "parser.get": () => {
          setImmediate(() => controller.abort());
          return json({ status: "create" });
        },
      },
      { signal: controller.signal },
    );
    expect(result.code).toBe(130);
    expect(result.stderr).toContain("бесплатно подхватит");
  });

  it("reports an invalid API response with exit code 1", async () => {
    const result = await cli(["balance"], { balance: () => json({ unexpected: true }) });
    expect(result.code).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
