import { afterEach, describe, expect, it, vi } from "vitest";
import { contentGap, domainOf } from "../../../src/scenarios/gap.js";
import { directMinusLine, minusWords } from "../../../src/scenarios/minus.js";
import { contentPlan } from "../../../src/scenarios/plan.js";
import { textOperation } from "../../../src/scenarios/text.js";
import { CEILINGS_AND_WINDOWS } from "../text/fixtures.js";
import {
  cleanup,
  confirmed,
  done,
  fakeHandlers,
  json,
  makeSession,
  refusal,
  subscriptionMissing,
} from "./helpers.js";

afterEach(cleanup);

const KEYWORDS: Record<string, { keyword: string; position: number; region_wsn: number }[]> = {
  "my.ru": [
    { keyword: "натяжные потолки", position: 5, region_wsn: 50_000 },
    { keyword: "натяжной потолок цена", position: 9, region_wsn: 9_000 },
  ],
  "rival1.ru": [
    { keyword: "натяжные потолки цена", position: 2, region_wsn: 20_000 },
    { keyword: "матовый натяжной потолок", position: 4, region_wsn: 2_000 },
    { keyword: "натяжные потолки фото", position: 7, region_wsn: 8_000 },
  ],
  "rival2.ru": [
    { keyword: "Матовые натяжные потолки", position: 1, region_wsn: 2_500 },
    { keyword: "натяжные потолки в зал", position: 3, region_wsn: 300 },
  ],
};

function serp(body: Record<string, unknown>) {
  if (body.report === "report_domain_competitors") {
    return json([{ domain: "my.ru" }, { domain: "www.rival1.ru" }, { domain: "rival2.ru" }]);
  }
  const rows = KEYWORDS[body.domain as string] ?? [];
  return json(rows.map((row) => ({ ...row, page: `https://${body.domain}/page` })));
}

describe("contentGap", () => {
  it("finds competitor keywords the domain lacks", async () => {
    const handler = vi.fn(serp);
    const { session, count } = await makeSession(fakeHandlers({ serp: handler }));
    const dry = await contentGap(session, { domain: "https://www.My.ru/" }, { dryRun: true });
    expect(dry.estimate).toMatchObject({ quotaRequests: 7, totalRub: 0 });
    const result = done(await contentGap(session, { domain: "my.ru", minFrequency: 500 }));
    expect(result.table.rows).toEqual([
      expect.objectContaining({
        phrase: "натяжные потолки фото",
        frequency: 8_000,
        competitors: 1,
      }),
      {
        phrase: "матовый натяжной потолок",
        frequency: 2_500,
        competitors: 2,
        best_position: 1,
        best_competitor: "rival2.ru",
        page: "https://rival2.ru/page",
        domains: "rival1.ru, rival2.ru",
      },
    ]);
    expect(result.summary).toMatchObject({
      competitors: ["rival1.ru", "rival2.ru"],
      ownKeywords: 2,
      competitorKeywords: 5,
      gap: 2,
    });
    expect(count("serp.report")).toBe(4);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      report: "report_domain_competitors",
      domain: "my.ru",
      limit: 6,
    });
  });

  it("uses the given competitors and explains a missing subscription", async () => {
    const { session, count } = await makeSession(fakeHandlers({ serp }));
    const result = done(
      await contentGap(session, { domain: "my.ru", competitors: ["rival2.ru", "my.ru"] }),
    );
    expect(result.table.rows.map((row) => row.phrase)).toEqual([
      "Матовые натяжные потолки",
      "натяжные потолки в зал",
    ]);
    expect(count("serp.report")).toBe(2);

    const none = await makeSession(fakeHandlers({ serp: subscriptionMissing }));
    await expect(contentGap(none.session, { domain: "my.ru" })).rejects.toMatchObject({
      code: 111,
      hintRu: expect.stringContaining("только с подпиской"),
    });
    await expect(contentGap(session, { domain: "my.ru", competitors: [] })).rejects.toThrow(
      /competitors/,
    );
    expect(domainOf("HTTP://WWW.Site.RU/path")).toBe("site.ru");
  });

  it("warns when Mutagen finds no competitors", async () => {
    const { session } = await makeSession(
      fakeHandlers({
        serp: (body) => (body.report === "report_domain_competitors" ? json([]) : serp(body)),
      }),
    );
    const result = done(await contentGap(session, { domain: "my.ru", competitorsTop: 2 }));
    expect(result.table.rows).toEqual([]);
    expect(result.warnings.join("\n")).toMatch(/не нашел конкурентов/);
  });
});

describe("minusWords", () => {
  it("finds candidates in given phrases for free", async () => {
    const { session, calls } = await makeSession({});
    const result = done(
      await minusWords(session, { phrases: CEILINGS_AND_WINDOWS, targetWords: ["фото"] }),
    );
    const words = result.table.rows.map((row) => row.word);
    expect(words).toEqual(expect.arrayContaining(["своими руками", "вакансии", "отзывы", "авито"]));
    expect(words).not.toContain("фото");
    expect(result.summary.direct).toContain("-своими -руками");
    expect(result.summary.direct).toContain("-вакансии");
    expect(result.summary.direct).not.toContain("-отзывы");
    expect(result.table.rows.find((row) => row.word === "отзывы")).toMatchObject({
      disputed: true,
      category: "Отзывы и обсуждения (спорно)",
    });
    const disputed = done(
      await minusWords(session, { phrases: CEILINGS_AND_WINDOWS, includeDisputed: true }),
    );
    expect(disputed.summary.direct).toContain("-отзывы");
    expect(calls).toHaveLength(0);
  });

  it("collects Wordstat columns for seeds within the budget", async () => {
    const { session, count } = await makeSession(
      fakeHandlers({
        wordstat: {
          "окна пвх": { "окна пвх": 100, "окна пвх бесплатно": 5, "окна пвх скачать": 3 },
        },
      }),
    );
    const result = done(
      await confirmed((options) =>
        minusWords(session, { seeds: ["окна пвх"], budgetRub: 1 }, options),
      ),
    );
    expect(result.summary).toMatchObject({ phrases: 3, direct: "-бесплатно -скачать" });
    expect(count("parser.mass.new")).toBe(1);
    const open = await minusWords(session, { seeds: ["окна"] }, { dryRun: true });
    expect(open.estimate.totalRub).toBe(0.02);
    await expect(minusWords(session, { seeds: ["окна"], budgetRub: 0.01 })).rejects.toMatchObject({
      kind: "over_budget",
    });
    await expect(minusWords(session, {})).rejects.toThrow(/seeds/);
  });

  it("formats the Direct line from multi-word markers", () => {
    expect(
      directMinusLine([{ word: "как сделать" }, { word: "своими руками" }, { word: "в" }] as never),
    ).toBe("-как -сделать -своими -руками -в");
  });
});

describe("contentPlan", () => {
  const QUESTIONS = [
    { phrase: "как мыть натяжной потолок", frequency: 3_500 },
    { phrase: "чем мыть натяжные потолки", frequency: 2_800 },
    { phrase: "как мыть натяжные потолки без разводов", frequency: 900 },
    { phrase: "сколько стоит натяжной потолок", frequency: 5_000 },
    { phrase: "можно ли клеить обои на натяжной потолок", frequency: 300 },
    { phrase: "натяжные потолки цена", frequency: 45_000 },
  ];

  it("turns question phrases into topics for free", async () => {
    const { session, calls } = await makeSession({});
    const result = done(await contentPlan(session, { phrases: QUESTIONS }));
    expect(result.table.rows[0]).toMatchObject({
      topic: "Как мыть натяжной потолок?",
      main_query: "как мыть натяжной потолок",
      frequency: 7_200,
      questions: 3,
      type: "how",
      marker: "как",
    });
    expect(result.table.rows.map((row) => row.topic)).toContain("Сколько стоит натяжной потолок?");
    expect(result.summary).toMatchObject({ source: "input", questions: 5 });
    expect(calls).toHaveLength(0);
    const empty = done(await contentPlan(session, { phrases: ["окна пвх"] }));
    expect(empty.warnings.join("\n")).toMatch(/Вопросов не найдено/);
  });

  it("asks the Mega-tool for question tails and falls back to Wordstat", async () => {
    const serp = vi.fn((_body: Record<string, unknown>) =>
      json(
        QUESTIONS.slice(0, 5).map((item) => ({
          keyword: item.phrase,
          region_wsn: item.frequency,
        })),
      ),
    );
    const subscribed = await makeSession(fakeHandlers({ serp }));
    const result = done(
      await confirmed((options) =>
        contentPlan(subscribed.session, { seeds: ["натяжной потолок"], budgetRub: 1 }, options),
      ),
    );
    expect(serp.mock.calls[0]?.[0]).toMatchObject({
      report: "report_keyword_tailings",
      filter: [{ column: "has_question", filter_type: "is", val: 1 }],
    });
    expect(result.summary).toMatchObject({ source: "serp", questions: 5 });

    const fallback = await makeSession(
      fakeHandlers({
        wordstat: {
          "натяжной потолок": Object.fromEntries(QUESTIONS.map((q) => [q.phrase, q.frequency])),
        },
      }),
    );
    const wordstat = done(
      await confirmed((options) =>
        contentPlan(
          fallback.session,
          { seeds: ["натяжной потолок"], budgetRub: 1, maxTopics: 1 },
          options,
        ),
      ),
    );
    expect(wordstat.summary).toMatchObject({ source: "wordstat", questions: 5, topics: 1 });
    expect(wordstat.warnings.join("\n")).toMatch(/111/);
    await expect(
      contentPlan(fallback.session, { seeds: ["окна"], budgetRub: 0.01 }),
    ).rejects.toMatchObject({ kind: "over_budget" });
    await expect(contentPlan(fallback.session, {})).rejects.toThrow(/seeds/);
  });

  it("refuses paid seeds in free-only mode", async () => {
    const { session, calls } = await makeSession(fakeHandlers({}), { freeOnly: true });
    const error = await refusal(
      contentPlan(session, { seeds: ["окна"], budgetRub: 1, source: "wordstat" }),
    );
    expect(error.kind).toBe("free_only");
    expect(calls).toHaveLength(0);
  });
});

describe("textOperation", () => {
  const phrases = [
    { phrase: "окна пвх", frequency: 10 },
    { phrase: "Окна  ПВХ", frequency: 5 },
    { phrase: "пвх окно", frequency: 3 },
    { phrase: "как выбрать окна", frequency: 2 },
  ];

  it("runs every operation", () => {
    expect(textOperation({ operation: "dedupe", phrases }).summary).toEqual({
      input: 4,
      output: 3,
      removed: 1,
    });
    expect(textOperation({ operation: "dedupe", phrases, mode: "implicit" }).summary.output).toBe(
      2,
    );
    const groups = textOperation({ operation: "implicit_duplicates", phrases });
    expect(groups.table.rows[0]).toMatchObject({ group: "окна пвх", is_representative: true });
    expect(groups.summary).toEqual({ groups: 1, duplicates: 2 });
    const dictionary = textOperation({ operation: "dictionary", phrases, examples: 1 });
    expect(dictionary.table.rows[0]).toMatchObject({ word: "окна", phrases: 4 });
    expect(
      textOperation({
        operation: "combinator",
        lists: [
          ["окна", "двери"],
          ["пвх", ""],
        ],
      }).summary,
    ).toEqual({ phrases: 4 });
    const compare = textOperation({
      operation: "compare",
      phrases,
      phrasesB: ["пвх окна", "двери"],
      implicit: true,
    });
    expect(compare.summary).toEqual({ both: 1, onlyA: 1, onlyB: 1 });
    expect(
      textOperation({ operation: "filter", phrases, include: ["пвх"], maxWords: 2 }).summary,
    ).toEqual({ input: 4, output: 3 });
    expect(
      textOperation({ operation: "filter", phrases, exclude: ["пвх"], regex: "^как", minWords: 1 })
        .table.rows,
    ).toEqual([{ phrase: "как выбрать окна", frequency: 2 }]);
    expect(textOperation({ operation: "questions", phrases }).table.rows).toEqual([
      { phrase: "как выбрать окна", frequency: 2, type: "how", marker: "как" },
    ]);
    expect(textOperation({ operation: "count", phrases: ["окна пвх"] }).table.rows).toEqual([
      { phrase: "окна пвх", words: 2, chars: 8, chars_no_spaces: 7 },
    ]);
  });

  it("validates its input", () => {
    expect(() => textOperation({ operation: "dedupe" })).toThrow(/phrases/);
    expect(() => textOperation({ operation: "compare", phrases })).toThrow(/phrasesB/);
    expect(() => textOperation({ operation: "combinator" })).toThrow(/lists/);
    expect(() => textOperation({ operation: "nope" as never, phrases })).toThrow(/operation/);
  });
});
