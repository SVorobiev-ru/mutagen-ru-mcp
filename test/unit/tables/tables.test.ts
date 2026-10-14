import { describe, expect, it } from "vitest";
import { estimatePlan } from "../../../src/budget/estimate.js";
import { SpendGuard } from "../../../src/budget/guard.js";
import { DEFAULT_PRICES } from "../../../src/budget/pricing.js";
import { REPORTS } from "../../../src/core/reports.js";
import { toCsv } from "../../../src/export/csv.js";
import { toJson } from "../../../src/export/json.js";
import type { CompetitionResult, ParserPart, ParserRunResult } from "../../../src/session.js";
import {
  balanceTable,
  competitionTable,
  directBidsTable,
  estimateTable,
  frequencyTable,
  massResultTable,
  massTasksTable,
  projectKeywordsTable,
  serpReportTable,
  spendingTable,
  wordstatKeywordsTable,
} from "../../../src/tables/index.js";

const estimate = estimatePlan([]);

function run(parts: ParserPart[], warnings?: string[]): ParserRunResult {
  return {
    source: "mutagen.ru",
    dryRun: false,
    estimate,
    strategy: "mass",
    region: "213",
    parts,
    ...(warnings ? { warnings } : {}),
  };
}

function mass(parser: ParserPart["parser"], phrases: string[], data: unknown): ParserPart {
  return {
    via: "parser.mass",
    parser,
    phrases,
    massId: 7,
    result: { status: "finish", data },
    fromCache: false,
    reusedTask: false,
  };
}

const keys = (columns: readonly { key: string }[]) => columns.map((column) => column.key);

describe("frequencyTable", () => {
  it("joins match types per phrase from parser.get and mass parts", () => {
    const result = run(
      [
        {
          via: "parser.get",
          parser: "wordstat_qs",
          phrases: ["окна", "двери"],
          data: { окна: { frequency: 10 }, двери: null },
          fromCache: true,
        },
        mass(
          "wordstat_n",
          ["окна", "двери"],
          [
            { key: "Окна", frequency: 100 },
            { key: "двери", frequency: "40" },
            { key: "крыши", frequency: 3 },
          ],
        ),
      ],
      ["ledger warning"],
    );
    const table = frequencyTable(result);
    expect(keys(table.columns)).toEqual(["phrase", "wordstat_n", "wordstat_qs", "region"]);
    expect(table.columns.map((column) => column.title)).toEqual([
      "Фраза",
      "Базовая",
      '"!Точная"',
      "Регион",
    ]);
    expect(table.rows).toEqual([
      { phrase: "окна", wordstat_qs: 10, wordstat_n: 100, region: "213" },
      { phrase: "двери", wordstat_qs: null, wordstat_n: 40, region: "213" },
      { phrase: "крыши", wordstat_qs: null, wordstat_n: 3, region: "213" },
    ]);
    expect(table.meta).toEqual({ region: "213", warnings: ["ledger warning"] });
  });

  it("falls back to raw JSON when the mass data is not recognized", () => {
    const table = frequencyTable(run([mass("wordstat_n", ["окна"], [1, 2, 3])]));
    expect(keys(table.columns)).toEqual(["raw"]);
    expect(JSON.parse(table.rows[0]?.raw as string)).toEqual([
      { parser: "wordstat_n", mass_id: 7, data: [1, 2, 3] },
    ]);
    expect(table.meta.warnings?.[0]).toMatch(/не распознан/);
    expect(toJson(table)).toContain("не распознан");
  });
});

describe("wordstatKeywordsTable", () => {
  const data = {
    frequency: 500,
    array: { "купить окна": 300, "окна цена": "120", "окна даром": null },
  };

  it("lists the left column without a column field, as the API sends it", () => {
    const table = wordstatKeywordsTable(
      run([
        {
          via: "parser.get",
          parser: "wordstat_key_50",
          phrases: ["окна"],
          data: { окна: { frequency: 500, count_keys: 2, array: { "купить окна": 300 } } },
          fromCache: false,
        },
      ]),
    );
    expect(keys(table.columns)).toEqual(["phrase", "frequency"]);
    expect(table.rows).toEqual([{ phrase: "купить окна", frequency: 300 }]);
  });

  it("keeps a phrase without a frequency as null", () => {
    const table = wordstatKeywordsTable(
      run([
        {
          via: "parser.get",
          parser: "wordstat_key_50",
          phrases: ["окна"],
          data: { окна: data },
          fromCache: false,
        },
      ]),
    );
    expect(table.rows).toEqual([
      { phrase: "купить окна", frequency: 300 },
      { phrase: "окна цена", frequency: 120 },
      { phrase: "окна даром", frequency: null },
    ]);
    expect(table.meta).toMatchObject({ query: "окна", region: "213" });
  });

  it("reads a mass result and handles empty or unknown data", () => {
    expect(
      wordstatKeywordsTable(run([mass("wordstat_key", ["окна"], { x: data })])).rows,
    ).toHaveLength(3);
    expect(wordstatKeywordsTable(run([mass("wordstat_key", ["окна"], {})])).rows).toEqual([]);
    const odd = wordstatKeywordsTable(run([mass("wordstat_key", ["окна"], { окна: { foo: 1 } })]));
    expect(keys(odd.columns)).toEqual(["raw"]);
    expect(keys(wordstatKeywordsTable(run([mass("wordstat_key", ["окна"], 5)])).columns)).toEqual([
      "raw",
    ]);
    expect(wordstatKeywordsTable(run([])).rows).toEqual([]);
  });
});

describe("directBidsTable", () => {
  it("flattens positions with ordered titled columns", () => {
    const table = directBidsTable(
      run([
        {
          via: "parser.get",
          parser: "direct",
          phrases: ["окна"],
          data: {
            окна: {
              shows: 1000,
              bid1: 10,
              all_positions: {
                std: { bid: 3 },
                first_premium: { shows: 900, bid: 25 },
                custom: { clicks: 1 },
              },
            },
          },
          fromCache: false,
        },
      ]),
    );
    expect(keys(table.columns)).toEqual([
      "phrase",
      "shows",
      "bid1",
      "bid2",
      "bid3",
      "first_premium_shows",
      "first_premium_bid",
      "std_bid",
      "custom_clicks",
    ]);
    expect(table.columns.find((column) => column.key === "first_premium_bid")?.title).toBe(
      "1-е спецразмещение: ставка",
    );
    expect(table.columns.find((column) => column.key === "custom_clicks")?.title).toBe(
      "custom: клики",
    );
    expect(table.rows[0]).toMatchObject({ phrase: "окна", shows: 1000, first_premium_bid: 25 });
  });

  it("handles missing parts, raw data and odd keys", () => {
    expect(directBidsTable(run([])).rows).toEqual([]);
    expect(keys(directBidsTable(run([mass("direct", ["окна"], [1])])).columns)).toEqual(["raw"]);
    const table = directBidsTable(
      run([mass("direct", ["окна", "двери"], { окна: { all_positions: { odd: 5 } }, двери: 3 })]),
    );
    expect(table.rows).toEqual([{ phrase: "окна", odd: 5 }, { phrase: "двери" }]);
    expect(table.columns.at(-1)).toEqual({ key: "odd", title: "odd", type: "number" });
  });
});

describe("list tables", () => {
  it("builds competition rows", () => {
    const result: CompetitionResult = {
      source: "mutagen.ru",
      dryRun: false,
      estimate,
      results: [
        {
          phrase: "окна",
          result: {
            status: "completed",
            key: "окна",
            strong: 12,
            wordstat: 100,
            direct: { spec: 5 },
            vital: true,
            vital_site: "okna.ru",
          },
          fromCache: false,
          reusedTask: false,
        },
      ],
      warnings: ["w"],
    };
    const table = competitionTable(result);
    expect(table.rows[0]).toEqual({
      phrase: "окна",
      strong: 12,
      wordstat: 100,
      tails: null,
      direct_spec: 5,
      direct_first: null,
      direct_garant: null,
      vital: true,
      vital_site: "okna.ru",
    });
    expect(table.meta.warnings).toEqual(["w"]);
    expect(toCsv(table)).toContain("да");
  });

  it("builds balance, task and project keyword tables", () => {
    expect(balanceTable({ balance: 12.5 }).rows).toEqual([{ balance: 12.5 }]);
    const tasks = massTasksTable([
      { id: 1, status: "finish", time: 1_700_000_000, name: "n", count: 2 },
      { id: 2, status: "process" },
    ]);
    expect(tasks.rows[0]).toMatchObject({ id: 1, time: "2023-11-14T22:13:20.000Z", count: 2 });
    expect(tasks.rows[1]).toMatchObject({ id: 2, time: null, name: null });
    const keywords = projectKeywordsTable(3, [{ keyword: "окна", claster_id: "1" }]);
    expect(keywords.rows).toEqual([{ keyword: "окна", claster_id: "1" }]);
    expect(keywords.meta.query).toBe("progect 3");
  });

  it("builds mass result tables with a raw fallback", () => {
    const done = massResultTable(5, {
      status: "finish",
      parser: "wordstat_n",
      region_id: "225",
      data: { окна: 10, двери: { frequency: 2, extra: { a: 1 } } },
    });
    expect(done.rows).toEqual([
      { phrase: "окна", wordstat_n: 10 },
      { phrase: "двери", frequency: 2, extra_a: 1 },
    ]);
    expect(keys(done.columns)).toEqual(["phrase", "wordstat_n", "frequency", "extra_a"]);
    expect(done.meta).toEqual({ query: "parser.mass 5", region: "225" });
    const pending = massResultTable(5, { status: "process" });
    expect(pending.rows).toEqual([]);
    expect(pending.meta.warnings?.[0]).toMatch(/process/);
    const raw = massResultTable(5, { status: "finish", data: "oops" });
    expect(raw.rows).toEqual([{ raw: '"oops"' }]);
    expect(raw.meta.warnings).toHaveLength(1);
  });

  it("orders serp columns by the report reference with unknown ones last", () => {
    const table = serpReportTable(
      "report_keyword_questions",
      [{ zz: 1, world_wsn: 5, keyword: "как" }],
      { query: "окна", region: "yandex_ru" },
    );
    expect(keys(table.columns)).toEqual(["keyword", "world_wsn", "zz"]);
    expect(table.columns[0]?.title).toBe("Фраза");
    expect(keys(serpReportTable("report_keyword_questions", []).columns)).toEqual(
      REPORTS.report_keyword_questions.columns,
    );
  });

  it("builds estimate and spending tables", () => {
    const plan = estimatePlan([{ method: "parser.mass.new", parsers: ["direct"], phrases: 2 }]);
    const table = estimateTable(plan);
    expect(table.rows[0]).toMatchObject({ method: "parser.mass.new", parser: "direct", rub: 0.04 });
    expect(table.meta.warnings ?? []).toEqual([]);
    const unconfirmed = estimateTable(
      estimatePlan([{ method: "check_key.new", phrases: 1 }], {
        ...DEFAULT_PRICES,
        "check_key.new": { ...DEFAULT_PRICES["check_key.new"], confirmed: false },
      }),
    );
    expect(unconfirmed.meta.warnings?.[0]).toMatch(/не подтверждена/);
    expect(estimateTable(estimatePlan([])).meta).toEqual({});
    const guard = new SpendGuard({ budgetRub: 10 });
    expect(spendingTable(guard.spending()).rows).toEqual([]);
  });
});
