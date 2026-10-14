import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requestHash } from "../../../src/budget/hash.js";
import { REFERRAL_URL, SUBSCRIPTION_URL } from "../../../src/mcp/links.js";
import { OUTAGE_HTML, type RecordedCall, text } from "../core/helpers.js";
import { API_KEY, cleanup, type Handler, json, setup, textOf } from "./helpers.js";

afterEach(cleanup);

const PAID_TOOLS = [
  "mutagen_frequency",
  "mutagen_wordstat_keywords",
  "mutagen_direct_bids",
  "mutagen_competition",
  "mutagen_keyword_report",
  "mutagen_domain_report",
  "mutagen_page_report",
  "mutagen_serp_report",
  "mutagen_build_core",
  "mutagen_expand_core",
  "mutagen_cluster",
  "mutagen_title_h1",
  "mutagen_content_gap",
  "mutagen_minus_words",
  "mutagen_content_plan",
];
const FREE_TOOLS = [
  "mutagen_balance",
  "mutagen_spending",
  "mutagen_estimate",
  "mutagen_mass_tasks",
  "mutagen_mass_result",
  "mutagen_project_keywords",
  "mutagen_text",
];

const phrases = (n: number) => Array.from({ length: n }, (_, i) => `фраза ${i + 1}`);

function massApi(): Record<string, Handler> {
  let keys: string[] = [];
  let id = 500;
  return {
    "parser.mass.new": (call: RecordedCall) => {
      keys = (call.body as { keys_list: string[] }).keys_list;
      id += 1;
      return json({ id, status: "process" });
    },
    "parser.mass.id": () =>
      json({
        status: "finish",
        count: keys.length,
        data: keys.map((key, index) => ({ key, frequency: (index + 1) * 10 })),
      }),
  };
}

describe("tools/list", () => {
  it("lists every tool with prices and honest annotations", async () => {
    const { client } = await setup({});
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...PAID_TOOLS, ...FREE_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.description).toMatch(/Cost:|Free|subscription/);
      expect(tool.description).toMatch(/Цена|Бесплатно|подписка/);
      expect(tool.outputSchema).toBeDefined();
    }
    for (const name of PAID_TOOLS) {
      const tool = tools.find((item) => item.name === name);
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(tool?.inputSchema.properties).toHaveProperty("dry_run");
    }
    for (const name of FREE_TOOLS) {
      expect(tools.find((item) => item.name === name)?.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("keeps tool descriptions and schemas within the size limits of the enabled groups", async () => {
    const all = await setup({});
    expect(JSON.stringify((await all.client.listTools()).tools).length).toBeLessThanOrEqual(34_000);
    const base = await setup({}, { groups: ["basic", "parser", "serp"] });
    const { tools } = await base.client.listTools();
    expect(tools).toHaveLength(14);
    expect(JSON.stringify(tools).length).toBeLessThanOrEqual(24_000);
  });

  it("registers only the groups from MUTAGEN_TOOLS", async () => {
    const { client } = await setup({}, { groups: ["basic"] });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      FREE_TOOLS.filter((name) => name !== "mutagen_text").sort(),
    );
    const text = await setup({}, { groups: ["text", "scenarios"] });
    expect((await text.client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(
      [
        "mutagen_build_core",
        "mutagen_cluster",
        "mutagen_content_gap",
        "mutagen_content_plan",
        "mutagen_expand_core",
        "mutagen_minus_words",
        "mutagen_text",
        "mutagen_title_h1",
      ].sort(),
    );
  });
});

describe("free tools", () => {
  it("returns the balance with the data source note", async () => {
    const { call, count } = await setup({ balance: () => json({ balance: "250.4" }) });
    const result = await call("mutagen_balance");
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("250.40 ₽");
    expect(textOf(result)).toContain("Данные: Мутаген (mutagen.ru)");
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      rows: [{ balance: 250.4 }],
      total: 1,
      source: "mutagen.ru",
    });
    expect(count("balance")).toBe(1);
  });

  it("reports spending and estimates locally", async () => {
    const { call, calls } = await setup({});
    const spending = await call("mutagen_spending");
    expect(textOf(spending)).toContain("из 50.00 ₽");
    const estimate = await call("mutagen_estimate", {
      calls: [
        { tool: "frequency", phrases: 100, types: ["wordstat_n", "wordstat_qs"] },
        { tool: "wordstat_keywords", phrases: 1, depth: 2000 },
        { tool: "direct_bids", phrases: 2 },
        { tool: "competition", phrases: 10 },
        { tool: "serp_report", requests: 3 },
        { tool: "frequency" },
      ],
    });
    expect(estimate.isError).toBeUndefined();
    expect(textOf(estimate)).toContain("Смета: 7.24 ₽");
    expect(textOf(estimate)).toContain("Укладывается");
    expect(estimate.structuredContent?.total).toBe(7);
    const big = await call("mutagen_estimate", { calls: [{ tool: "competition", phrases: 1000 }] });
    expect(textOf(big)).toContain("Больше остатка");
    expect(calls).toHaveLength(0);
  });

  it("lists mass tasks and reads a mass result", async () => {
    const { call } = await setup({
      "parser.mass.list": () =>
        json({ "7": { name: "x", parser: "wordstat_n", count: 2, time: 1, status: "finish" } }),
      "parser.mass.id": () =>
        json({ status: "finish", parser: "wordstat_n", data: { окна: 5, двери: 7 } }),
    });
    const tasks = await call("mutagen_mass_tasks");
    expect(tasks.structuredContent?.rows).toEqual([
      {
        id: 7,
        name: "x",
        parser: "wordstat_n",
        region_id: null,
        count: 2,
        time: "1970-01-01T00:00:01.000Z",
        status: "finish",
      },
    ]);
    const result = await call("mutagen_mass_result", { mass_id: 7, wait: true });
    expect(result.structuredContent?.rows).toEqual([
      { phrase: "окна", wordstat_n: 5 },
      { phrase: "двери", wordstat_n: 7 },
    ]);
    const cached = await call("mutagen_mass_result", { mass_id: 7 });
    expect(textOf(cached)).toContain("Из кэша");
    const fresh = await call("mutagen_mass_result", { mass_id: 7, force_refresh: true });
    expect(textOf(fresh)).not.toContain("Из кэша");
  });

  it("reads project keywords by a required project_id", async () => {
    const { call, calls } = await setup({
      "progect.keywords": () => json([{ keyword: "потолок", claster_id: "1" }]),
    });
    const keywords = await call("mutagen_project_keywords", { project_id: 3 });
    expect(keywords.structuredContent?.rows).toEqual([{ keyword: "потолок", claster_id: "1" }]);
    expect(calls[0]?.body).toEqual({ progect_id: 3 });
    const missing = await call("mutagen_project_keywords", {});
    expect(missing.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("explains error 107 for an unknown project with the API detail", async () => {
    const { call } = await setup({
      "progect.keywords": () =>
        json({
          error_id: 107,
          error: "MUTAGEN.RU: task_id not found",
          error_detail: "Нет проекта с таким id",
        }),
    });
    const result = await call("mutagen_project_keywords", { project_id: 999 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Нет проекта с таким id");
  });
});

describe("paid tools", () => {
  it("returns a dry run estimate without calling the API", async () => {
    const { call, calls } = await setup(massApi());
    const result = await call("mutagen_frequency", {
      phrases: phrases(3),
      types: ["wordstat_n", "wordstat_q"],
      dry_run: true,
    });
    expect(calls).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({
      status: "dry_run",
      estimate: { totalRub: 0.12, quotaRequests: 0 },
    });
    expect(textOf(result)).toContain("Смета: 0.12 ₽");
  });

  it("runs frequency and renders a markdown table", async () => {
    const { call, count } = await setup(massApi());
    const result = await call("mutagen_frequency", { phrases: ["окна", "двери"], region: "213" });
    const text = textOf(result);
    expect(text).toContain("mutagen_frequency: 2 строк");
    expect(text).toContain("| Фраза | Базовая | Регион |");
    expect(text).toContain("| окна | 10 | 213 |");
    expect(text).toContain("Списано: 0.04 ₽");
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      total: 2,
      rows: [
        { phrase: "окна", wordstat_n: 10, region: "213" },
        { phrase: "двери", wordstat_n: 20, region: "213" },
      ],
      spending: { spentRub: 0.04 },
    });
    expect(result.structuredContent?.file).toBeUndefined();
    expect(count("parser.mass.new")).toBe(1);
    const again = await call("mutagen_frequency", { phrases: ["окна", "двери"], region: "213" });
    expect(textOf(again)).toContain("Из кэша");
    expect(count("parser.mass.new")).toBe(1);
  });

  it("saves a long result to CSV automatically", async () => {
    const { call, outputDir } = await setup(massApi());
    const result = await call("mutagen_frequency", { phrases: phrases(25) });
    const structured = result.structuredContent as { rows: unknown[]; total: number; file: string };
    expect(structured.total).toBe(25);
    expect(structured.rows).toHaveLength(20);
    expect(structured.file.startsWith(outputDir)).toBe(true);
    expect(structured.file).toMatch(/mutagen_frequency-.*\.csv$/);
    expect(textOf(result)).toContain(`Полный результат / Full result: ${structured.file}`);
    const csv = await readFile(structured.file, "utf8");
    expect(csv).toContain("фраза 25");
  });

  it("saves to save_as, picks fields and warns about unknown ones", async () => {
    const { call, outputDir } = await setup(massApi());
    const result = await call("mutagen_frequency", {
      phrases: ["окна"],
      save_as: "sub/freq.json",
      fields: ["phrase", "nope"],
      limit: 5,
    });
    expect(result.structuredContent?.file).toBe(join(outputDir, "sub", "freq.json"));
    expect(result.structuredContent?.rows).toEqual([{ phrase: "окна" }]);
    expect(textOf(result)).toContain("Нет таких колонок: nope");
    const saved = JSON.parse(await readFile(join(outputDir, "sub", "freq.json"), "utf8"));
    expect(saved.rows).toEqual([{ phrase: "окна", wordstat_n: 10, region: "0" }]);
  });

  it("reports a file write failure as a warning and keeps the paid result", async () => {
    const { call, root } = await setup(massApi(), { allowAnyOutputPath: true });
    const result = await call("mutagen_frequency", {
      phrases: ["окна"],
      save_as: join(root, "state", "ledger.jsonl", "x.csv"),
    });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("Не удалось сохранить файл");
    expect(result.structuredContent?.rows).toHaveLength(1);
  });

  it("rejects a bad save_as before any API call", async () => {
    const { call, calls } = await setup(massApi());
    const extension = await call("mutagen_frequency", { phrases: ["окна"], save_as: "x.txt" });
    expect(extension.isError).toBe(true);
    expect(textOf(extension)).toContain(".csv");
    const outside = await call("mutagen_frequency", { phrases: ["окна"], save_as: "../x.csv" });
    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toContain("внутри каталога вывода");
    expect(calls).toHaveLength(0);
  });

  it("returns a confirm_token without elicitation and runs with it", async () => {
    const { call, count } = await setup(massApi());
    const first = await call("mutagen_frequency", { phrases: phrases(60) });
    expect(first.isError).toBeUndefined();
    const token = first.structuredContent?.confirm_token as string;
    expect(first.structuredContent).toMatchObject({
      status: "needs_confirmation",
      estimate: { totalRub: 1.2 },
    });
    expect(token).toEqual(expect.any(String));
    expect(textOf(first)).toContain(`confirm_token: ${token}`);
    expect(textOf(first)).toContain("Покажите смету пользователю");
    expect(count("parser.mass.new")).toBe(0);
    const second = await call("mutagen_frequency", { phrases: phrases(60), confirm_token: token });
    expect(second.structuredContent).toMatchObject({ status: "ok", total: 60 });
    expect(count("parser.mass.new")).toBe(1);
    const reused = await call("mutagen_frequency", {
      phrases: phrases(60),
      confirm_token: token,
      force_refresh: true,
    });
    expect(reused.structuredContent?.status).toBe("needs_confirmation");
    expect(reused.structuredContent?.confirm_token).not.toBe(token);
    expect(count("parser.mass.new")).toBe(1);
  });

  it("asks the user through elicitation and runs after consent", async () => {
    const { call, count, prompts } = await setup(massApi(), {
      elicit: () => ({ action: "accept", content: { confirm: true } }),
    });
    const result = await call("mutagen_frequency", { phrases: phrases(60) });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("1.20 ₽");
    expect(prompts[0]).toContain("Confirm spending?");
    expect(result.structuredContent).toMatchObject({ status: "ok", total: 60 });
    expect(result.structuredContent?.confirm_token).toBeUndefined();
    expect(count("parser.mass.new")).toBe(1);
  });

  it.each([
    ["decline", { action: "decline" as const }],
    ["cancel", { action: "cancel" as const }],
    ["unchecked box", { action: "accept" as const, content: { confirm: false } }],
  ])("cancels the call on %s", async (_label, answer) => {
    const { call, count } = await setup(massApi(), { elicit: () => answer });
    const result = await call("mutagen_frequency", { phrases: phrases(60) });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      status: "cancelled",
      estimate: { totalRub: 1.2 },
    });
    expect(result.structuredContent?.confirm_token).toBeUndefined();
    expect(textOf(result)).toContain("Отменено пользователем");
    expect(count("parser.mass.new")).toBe(0);
  });

  it("refuses paid calls in free-only mode and over the budget", async () => {
    const free = await setup(massApi(), { env: { MUTAGEN_FREE_ONLY: "1" } });
    const refused = await free.call("mutagen_frequency", { phrases: ["окна"] });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("MUTAGEN_FREE_ONLY=1");
    expect(textOf(refused)).toContain("mutagen_balance");
    expect(free.calls).toHaveLength(0);

    const poor = await setup(massApi(), { env: { MUTAGEN_BUDGET_RUB: "0.5" } });
    const over = await poor.call("mutagen_frequency", { phrases: phrases(60) });
    expect(over.isError).toBe(true);
    expect(textOf(over)).toContain("больше остатка бюджета");
    expect(textOf(over)).toContain("dry_run");
  });

  it("reports a low balance before running an expensive plan", async () => {
    const { call, count } = await setup(
      { balance: () => json({ balance: "1" }), ...massApi() },
      { env: { MUTAGEN_AUTO_APPROVE_RUB: "10" } },
    );
    const result = await call("mutagen_frequency", { phrases: phrases(300) });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Пополните баланс");
    expect(count("parser.mass.new")).toBe(0);
  });

  it("runs competition, direct bids and wordstat keywords", async () => {
    const { call } = await setup(
      {
        "check_key.new": () => json({ task_id: 9, status: "created" }),
        "check_key.get": () =>
          json({ status: "completed", key: "окна", strong: 12, vital: "", vital_site: "" }),
        "parser.mass.new": () => json({ id: 77, status: "process" }),
        "parser.mass.id": [
          () =>
            json({
              status: "finish",
              data: [{ key: "окна", shows: 100, bid1: 5, all_positions: { std: { bid: 2 } } }],
            }),
          () =>
            json({
              status: "finish",
              data: { окна: { array: { "купить окна": 30 } } },
            }),
        ],
      },
      { elicit: () => ({ action: "accept", content: { confirm: true } }) },
    );
    const competition = await call("mutagen_competition", { phrases: ["окна"] });
    expect(competition.structuredContent?.rows).toEqual([
      expect.objectContaining({ phrase: "окна", strong: 12 }),
    ]);
    const bids = await call("mutagen_direct_bids", {
      phrases: ["окна"],
      fields: ["phrase", "std_bid"],
    });
    expect(bids.structuredContent?.rows).toEqual([{ phrase: "окна", std_bid: 2 }]);
    const keywords = await call("mutagen_wordstat_keywords", { phrase: "окна" });
    expect(keywords.structuredContent?.rows).toEqual([{ phrase: "купить окна", frequency: 30 }]);
  });

  it("creates a new mass task with new_task after a stopped one", async () => {
    const { call, count } = await setup({
      "parser.mass.new": [
        () => json({ id: 1, status: "process" }),
        () => json({ id: 2, status: "process" }),
      ],
      "parser.mass.id": [
        () => json({ status: "stop" }),
        () => json({ status: "finish", data: { окна: 3 } }),
      ],
    });
    const stopped = await call("mutagen_frequency", { phrases: ["окна"] });
    expect(stopped.isError).toBe(true);
    expect(textOf(stopped)).toContain("остановлено");
    const fresh = await call("mutagen_frequency", { phrases: ["окна"], new_task: true });
    expect(fresh.structuredContent?.rows).toEqual([{ phrase: "окна", wordstat_n: 3, region: "0" }]);
    expect(count("parser.mass.new")).toBe(2);
  });
});

describe("Mega-tool reports", () => {
  it("explains a missing subscription with free alternatives", async () => {
    const { call } = await setup({
      "serp.report": () => json({ error_id: 111, error_msg: "subscription required" }),
    });
    const result = await call("mutagen_keyword_report", {
      report: "report_keyword_tailings",
      keyword: "окна",
    });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain(SUBSCRIPTION_URL);
    expect(text).toContain("mutagen_wordstat_keywords / mutagen_frequency");
    expect(text).toContain("111");
  });

  it("builds report bodies for domain, page and raw reports", async () => {
    const { call, calls } = await setup({
      "serp.report": () => json([{ keyword: "окна", position: 3, extra: 1 }]),
    });
    const domain = await call("mutagen_domain_report", {
      report: "report_keywords_organic",
      domain: "okna.ru",
      subdomains: true,
      sort: "position",
      max_rows: 10,
    });
    expect(domain.structuredContent?.rows).toEqual([
      expect.objectContaining({ keyword: "окна", position: 3, extra: 1 }),
    ]);
    expect(calls[0]?.body).toEqual({
      report: "report_keywords_organic",
      region: "yandex_msk",
      domain_with_subdomains: "okna.ru",
      sort: "position",
      limit: 10,
    });
    await call("mutagen_page_report", { report: "report_page_info", page: "https://okna.ru/a" });
    expect(calls[1]?.body).toMatchObject({ page: "https://okna.ru/a" });
    await call("mutagen_serp_report", {
      report: "report_keyword_info",
      keywords: ["окна", "двери"],
      region: "yandex_ru",
      filter: [{ column: "words", filter_type: "gr", val: 1 }],
    });
    expect(calls[2]?.body).toMatchObject({
      keywords: "окна,двери",
      filter: [{ column: "words", filter_type: "gr", val: 1 }],
    });
    const invalid = await call("mutagen_serp_report", { report: "report_page_info" });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toContain("ровно один объект");
    expect(calls).toHaveLength(3);
  });
});

describe("errors and secrets", () => {
  it("starts without a key and explains how to get one", async () => {
    const { client, call } = await setup({}, { key: false });
    expect((await client.listTools()).tools).toHaveLength(22);
    const result = await call("mutagen_balance");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("MUTAGEN_API_KEY");
    expect(textOf(result)).toContain(REFERRAL_URL);
    expect(textOf(result)).toContain("партнёрская ссылка автора проекта");
    expect((await call("mutagen_spending")).isError).toBeUndefined();
    expect(
      (await call("mutagen_estimate", { calls: [{ tool: "frequency", phrases: 1 }] })).isError,
    ).toBeUndefined();
  });

  it("returns API errors with hints and code", async () => {
    const { call } = await setup({
      balance: () => json({ error_id: 101, error_msg: "Authorization failed" }),
      "parser.mass.list": () => text(OUTAGE_HTML, 503),
    });
    const result = await call("mutagen_balance");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Данные авторизации не подходят");
    expect(textOf(result)).toContain("Authorization failed");
    expect(textOf(result)).toContain("API error code: 101");
    const outage = await call("mutagen_mass_tasks");
    expect(outage.isError).toBe(true);
    expect(textOf(outage)).toContain("503");
  });

  it("passes the request signal to the session", async () => {
    let seen: AbortSignal | undefined;
    const { client } = await setup({
      balance: (call) =>
        new Promise<Response>((_resolve, reject) => {
          seen = call.signal;
          call.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const controller = new AbortController();
    const pending = client.callTool(
      { name: "mutagen_balance", arguments: {} },
      { signal: controller.signal },
    );
    await expect.poll(() => seen).toBeDefined();
    controller.abort("stop");
    await expect(pending).rejects.toThrow();
    await expect.poll(() => seen?.aborted).toBe(true);
  });

  it("never returns the API key", async () => {
    const { call, responses } = await setup({
      "progect.keywords": () => json([{ keyword: `leak ${API_KEY}`, claster_id: null }]),
      balance: () => json({ error_id: 101, error_msg: "Authorization failed" }),
      ...massApi(),
    });
    const projects = await call("mutagen_project_keywords", { project_id: 1 });
    expect(textOf(projects)).toContain("leak ***");
    await call("mutagen_balance");
    await call("mutagen_frequency", { phrases: phrases(60) });
    await call("mutagen_frequency", { phrases: ["окна"] });
    await call("mutagen_spending");
    expect(JSON.stringify(responses)).not.toContain(API_KEY);
  });
});

describe("resources", () => {
  it("lists and reads the reference resources", async () => {
    const { client } = await setup({});
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri).sort()).toEqual([
      "mutagen://reference/prices",
      "mutagen://reference/regions",
      "mutagen://reference/reports",
    ]);
    const reports = await client.readResource({ uri: "mutagen://reference/reports" });
    const text = (reports.contents[0] as { text: string }).text;
    expect(text).toContain("## report_keyword_info");
    expect(text).toContain("Данные: Мутаген (mutagen.ru)");
    const prices = await client.readResource({ uri: "mutagen://reference/prices" });
    expect((prices.contents[0] as { text: string }).text).toContain("| parser.direct | 0.02 |");
    const regions = await client.readResource({ uri: "mutagen://reference/regions" });
    expect((regions.contents[0] as { text: string }).text).toContain("yandex_msk");
  });
});

describe("long tasks", () => {
  it("answers processing instead of an error and the repeat pays nothing", async () => {
    let ready = false;
    const { call, count } = await setup(
      {
        "parser.get": () =>
          ready
            ? json({ status: "finish", data: { shows: 40, bid1: 7 } })
            : json({ status: "process" }),
      },
      { strategy: "single", waitMs: 1 },
    );
    const first = await call("mutagen_direct_bids", { phrases: ["окна"] });
    expect(first.isError).toBeUndefined();
    expect(first.structuredContent).toMatchObject({
      status: "processing",
      rows: [{ task: "parser.get direct «окна»" }],
      spending: { spentRub: 0.02 },
    });
    expect(textOf(first)).toContain("Повторите тот же вызов позже — повтор бесплатный");
    ready = true;
    const second = await call("mutagen_direct_bids", { phrases: ["окна"] });
    expect(second.structuredContent).toMatchObject({
      status: "ok",
      rows: [expect.objectContaining({ phrase: "окна", shows: 40 })],
      spending: { spentRub: 0.02 },
    });
    expect(second.structuredContent?.estimate).toMatchObject({ totalRub: 0 });
    expect(count("parser.get")).toBeGreaterThanOrEqual(2);
  });

  it("finds a pending competition task through the ledger and does not create it again", async () => {
    let ready = false;
    const { call, count } = await setup(
      {
        "check_key.new": () => json({ task_id: 16209408, status: "created" }),
        "check_key.get": () =>
          ready
            ? json({ status: "completed", key: "окна", strong: 7, vital: "", vital_site: "" })
            : json({ task_id: 16209408, status: "processed" }),
      },
      { waitMs: 1 },
    );
    const first = await call("mutagen_competition", { phrases: ["окна"] });
    expect(first.structuredContent).toMatchObject({
      status: "processing",
      rows: [{ task: "check_key 16209408" }],
    });
    const again = await call("mutagen_competition", { phrases: ["окна"] });
    expect(again.structuredContent).toMatchObject({ status: "processing" });
    ready = true;
    const done = await call("mutagen_competition", { phrases: ["окна"] });
    expect(done.structuredContent).toMatchObject({
      status: "ok",
      rows: [expect.objectContaining({ phrase: "окна", strong: 7 })],
      spending: { spentRub: 0.3 },
    });
    expect(count("check_key.new")).toBe(1);
  });

  it("returns an unfinished mass job as is after the wait limit", async () => {
    const { call } = await setup(
      { "parser.mass.id": () => json({ status: "process", data: [] }) },
      { waitMs: 1 },
    );
    const result = await call("mutagen_mass_result", { mass_id: 5, wait: true });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("Задание / Job 5: process");
  });

  it("returns a partial scenario with status processing", async () => {
    const { call } = await setup(
      {
        "parser.get": (request: RecordedCall) => {
          const { parser } = request.body as { parser: string };
          return parser === "wordstat_key_50"
            ? json({ status: "finish", data: { array: { "окна пвх": 10, "окна цена": 5 } } })
            : json({ status: "process" });
        },
      },
      { strategy: "single", waitMs: 1 },
    );
    const result = await call("mutagen_build_core", {
      seeds: ["окна"],
      budget_rub: 1,
      source: "wordstat",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ status: "processing", partial: true });
    expect(textOf(result)).toContain("Повторите тот же вызов позже");
  });
});

describe("review fixes", () => {
  it("picks the parser.get or mass method in mutagen_estimate like the tools do", async () => {
    const { call } = await setup({});
    const methods = async (phrases: number) => {
      const result = await call("mutagen_estimate", { calls: [{ tool: "frequency", phrases }] });
      const rows = (result.structuredContent?.rows ?? []) as { method: string }[];
      return rows.map((row) => row.method);
    };
    expect(await methods(10)).toEqual(["parser.get"]);
    expect(await methods(11)).toEqual(["parser.mass.new"]);
    const seeds = await call("mutagen_estimate", {
      calls: [{ tool: "wordstat_keywords", phrases: 30 }],
    });
    expect(seeds.structuredContent?.rows).toMatchObject([{ method: "parser.get", units: 30 }]);
  });

  it("ignores an elicitation answer sent without the server's requestState", async () => {
    const { client, count, prompts } = await setup(massApi(), {
      elicit: () => ({ action: "decline" }),
    });
    const forged = { action: "accept", content: { confirm: true } };
    for (const requestState of [undefined, "forged.state.value"]) {
      const result = (await client.request({
        method: "tools/call",
        params: {
          name: "mutagen_frequency",
          arguments: { phrases: phrases(60) },
          inputResponses: { confirm_spend_120: forged },
          ...(requestState ? { requestState } : {}),
        },
      } as never)) as { structuredContent?: { status: string } };
      expect(result.structuredContent?.status).toBe("cancelled");
    }
    expect(prompts).toHaveLength(2);
    expect(count("parser.mass.new")).toBe(0);
  });

  it("keeps save_as inside the output directory and never replaces a file silently", async () => {
    const { call, outputDir, root, calls } = await setup(massApi());
    for (const save_as of ["../../x.csv", join(root, "abs.csv")]) {
      const refused = await call("mutagen_frequency", { phrases: ["окна"], save_as });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain("внутри каталога вывода");
    }
    await mkdir(outputDir, { recursive: true });
    await mkdir(join(root, "outside"));
    await symlink(join(root, "outside"), join(outputDir, "link"));
    const linked = await call("mutagen_frequency", { phrases: ["окна"], save_as: "link/x.csv" });
    expect(linked.isError).toBe(true);
    await symlink(join(root, "outside", "f.csv"), join(outputDir, "f.csv"));
    expect((await call("mutagen_frequency", { phrases: ["окна"], save_as: "f.csv" })).isError).toBe(
      true,
    );
    await symlink(join(root, "missing"), join(outputDir, "gone"));
    expect(
      (await call("mutagen_frequency", { phrases: ["окна"], save_as: "gone/x.csv" })).isError,
    ).toBe(true);
    expect(calls).toHaveLength(0);

    await writeFile(join(outputDir, "freq.csv"), "old");
    const copy = await call("mutagen_frequency", { phrases: ["окна"], save_as: "freq.csv" });
    expect(copy.structuredContent?.file).toBe(join(outputDir, "freq (2).csv"));
    expect(textOf(copy)).toContain("overwrite: true");
    expect(await readFile(join(outputDir, "freq.csv"), "utf8")).toBe("old");
    const third = await call("mutagen_frequency", { phrases: ["окна"], save_as: "freq.csv" });
    expect(third.structuredContent?.file).toBe(join(outputDir, "freq (3).csv"));
    const replaced = await call("mutagen_frequency", {
      phrases: ["окна"],
      save_as: "freq.csv",
      overwrite: true,
    });
    expect(replaced.structuredContent?.file).toBe(join(outputDir, "freq.csv"));
    expect(await readFile(join(outputDir, "freq.csv"), "utf8")).toContain("окна");
  });

  it("warns about a task pending for over 2 hours and says that Direct tools may be slow", async () => {
    const { call, root, client } = await setup(
      { "parser.get": () => json({ status: "process" }) },
      { strategy: "single", waitMs: 1 },
    );
    const entry = {
      ts: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
      method: "parser.get",
      requestHash: requestHash("parser.get", { key: "окна", parser: "direct", region_id: "0" }),
      estimateRub: 0.02,
      status: "created",
      chargedRub: 0.02,
    };
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(join(root, "state", "ledger.jsonl"), `${JSON.stringify(entry)}\n`);
    const result = await call("mutagen_direct_bids", { phrases: ["окна"] });
    expect(result.structuredContent?.status).toBe("processing");
    expect(textOf(result)).toContain("Задача висит больше 2 часов");
    expect(textOf(result)).toContain("pending for over 2 hours");
    const { tools } = await client.listTools();
    for (const name of ["mutagen_direct_bids", "mutagen_competition"]) {
      expect(tools.find((tool) => tool.name === name)?.description).toContain(
        "Зависит от Яндекс Директа",
      );
    }
  });
});
