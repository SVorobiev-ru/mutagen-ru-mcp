import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCore, expandCore } from "../../../src/scenarios/core.js";
import type { MinusCategory } from "../../../src/text/minus.js";
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

afterEach(() => {
  vi.restoreAllMocks();
  return cleanup();
});

const CEILINGS: Record<string, number> = {
  "натяжные потолки": 120_000,
  "натяжные потолки цена": 45_000,
  "цена натяжного потолка": 9_000,
  "натяжные потолки фото": 20_000,
  "матовый натяжной потолок": 2_000,
  "натяжные потолки своими руками": 5_000,
  "натяжные потолки вакансии": 700,
  "натяжные потолки бесплатно": 300,
  "натяжные потолки отзывы": 2_200,
  "натяжные потолки икеа": 150,
  "как мыть натяжной потолок": 3_500,
  "Натяжные  потолки": 1,
};

const WINDOWS: Record<string, number> = {
  "пластиковые окна": 90_000,
  "ремонт пластиковых окон": 7_500,
  "пластиковые окна цена": 25_000,
  "окна пвх": 60_000,
  "натяжные потолки": 120_000,
};

const EXACT: Record<string, number> = {
  "натяжные потолки": 30_000,
  "натяжные потолки цена": 9_000,
  "натяжные потолки фото": 4_000,
  "матовый натяжной потолок": 600,
  "натяжные потолки отзывы": 400,
  "как мыть натяжной потолок": 900,
  "пластиковые окна": 20_000,
  "ремонт пластиковых окон": 2_000,
  "пластиковые окна цена": 5_000,
  "окна пвх": 15_000,
};

const api = () =>
  fakeHandlers({
    wordstat: { "натяжные потолки": CEILINGS, "пластиковые окна": WINDOWS },
    exact: EXACT,
    strong: { "натяжные потолки": 18, "пластиковые окна": 21 },
  });

const SEEDS = ["натяжные потолки", "пластиковые окна"];

describe("buildCore", () => {
  it("collects, cleans, adds exact frequencies and clusters with one confirmation", async () => {
    const { session, count } = await makeSession(api());
    const first = await refusal(
      buildCore(session, { seeds: SEEDS, budgetRub: 20, source: "wordstat", stopWords: ["икеа"] }),
    );
    expect(first.kind).toBe("needs_confirmation");
    expect(count("parser.mass.new")).toBe(0);

    const result = done(
      await buildCore(
        session,
        { seeds: SEEDS, budgetRub: 20, source: "wordstat", stopWords: ["икеа"] },
        { confirmToken: first.confirmToken ?? "" },
      ),
    );
    expect(result.table.columns.map((column) => column.key)).toEqual([
      "phrase",
      "base",
      "wordstat_qs",
      "cluster",
      "seed",
    ]);
    const rows = new Map(result.table.rows.map((row) => [row.phrase, row]));
    expect(rows.get("натяжные потолки")).toMatchObject({
      base: 120_000,
      wordstat_qs: 30_000,
      cluster: "натяжные потолки",
      seed: "натяжные потолки",
    });
    expect(rows.get("матовый натяжной потолок")?.cluster).toBe("натяжные потолки");
    expect(rows.get("ремонт пластиковых окон")?.cluster).toBe("пластиковые окна");
    expect(rows.has("цена натяжного потолка")).toBe(false);
    expect(rows.has("натяжные потолки своими руками")).toBe(true);
    expect(rows.has("натяжные потолки вакансии")).toBe(false);
    expect(rows.has("натяжные потолки бесплатно")).toBe(true);
    expect(rows.has("натяжные потолки фото")).toBe(true);
    expect(rows.has("натяжные потолки отзывы")).toBe(true);
    expect(rows.has("натяжные потолки икеа")).toBe(false);
    expect(result.summary).toMatchObject({
      source: "wordstat",
      collected: 17,
      removed: {
        duplicates: 2,
        stopWords: 1,
        minus: 1,
        implicitDuplicates: 1,
        minFrequency: 0,
        overLimit: 0,
        minExact: 0,
      },
      phrases: 12,
      maxPhrases: 500,
      frequenciesRecognized: true,
    });
    expect(result.summary.minusWords).toEqual(["вакансии"]);
    expect(result.partial).toBe(false);
    expect(count("parser.mass.new")).toBe(3);
    expect(result.spentRub).toBe(0.28);
    expect(session.spending().calls).toEqual([
      expect.objectContaining({ label: "build_core", spentRub: 0.28, status: "ok" }),
    ]);
  });

  it("drops the chosen junk categories or keeps everything with excludeMinus false", async () => {
    const run = async (params: { excludeCategories?: MinusCategory[]; excludeMinus?: boolean }) => {
      const { session } = await makeSession(api());
      return done(
        await confirmed((options) =>
          buildCore(
            session,
            {
              seeds: ["натяжные потолки"],
              budgetRub: 20,
              source: "wordstat",
              exactTypes: [],
              ...params,
            },
            options,
          ),
        ),
      );
    };
    const phrases = (result: { table: { rows: Record<string, unknown>[] } }) =>
      result.table.rows.map((row) => row.phrase);

    const direct = await run({ excludeCategories: ["free", "diy", "media", "reviews"] });
    expect(direct.summary.removed.minus).toBe(4);
    expect(direct.summary.minusWords).toEqual(
      expect.arrayContaining(["бесплатно", "своими руками", "фото", "отзывы"]),
    );
    expect(phrases(direct)).toContain("натяжные потолки вакансии");
    expect(phrases(direct)).not.toContain("натяжные потолки отзывы");

    for (const params of [{ excludeMinus: false }, { excludeCategories: [] }]) {
      const all = await run(params);
      expect(all.summary.removed.minus).toBe(0);
      expect(all.summary.minusWords).toEqual([]);
      expect(phrases(all)).toContain("натяжные потолки вакансии");
    }

    const { session } = await makeSession(api());
    await expect(
      buildCore(session, {
        seeds: SEEDS,
        budgetRub: 5,
        excludeCategories: ["spam" as MinusCategory],
      }),
    ).rejects.toThrow(/excludeCategories/);
  });

  it("applies minimum frequencies and checks competition for the top phrases", async () => {
    const { session, count } = await makeSession(api());
    const result = done(
      await confirmed((options) =>
        buildCore(
          session,
          {
            seeds: SEEDS,
            budgetRub: 20,
            source: "wordstat",
            minFrequency: 5_000,
            minExact: 5_000,
            competitionTop: 2,
            maxPhrases: 6,
          },
          options,
        ),
      ),
    );
    expect(result.table.rows.map((row) => [row.phrase, row.competition])).toEqual([
      ["натяжные потолки", 18],
      ["натяжные потолки цена", null],
      ["пластиковые окна", 21],
      ["пластиковые окна цена", null],
      ["окна пвх", null],
    ]);
    expect(result.summary.removed).toMatchObject({ minFrequency: 5, overLimit: 2, minExact: 1 });
    expect(count("check_key.new")).toBe(2);
  });

  it("shrinks the plan to the budget and explains it", async () => {
    const { session, calls } = await makeSession(api());
    const dry = await buildCore(
      session,
      { seeds: SEEDS, budgetRub: 2, source: "wordstat", competitionTop: 10 },
      { dryRun: true },
    );
    expect(dry.dryRun).toBe(true);
    expect(dry.estimate.totalRub).toBeLessThanOrEqual(2);
    expect(dry.summary).toMatchObject({ maxPhrases: 98, competitionTop: 0 });
    expect(dry.warnings.join("\n")).toMatch(/max_phrases 500 → 98, competition_top 10 → 0/);
    expect(calls).toHaveLength(0);

    const wide = await buildCore(
      session,
      { seeds: SEEDS, budgetRub: 50, source: "wordstat", maxPhrases: 10, competitionTop: 5 },
      { dryRun: true },
    );
    expect(wide.estimate.totalRub).toBe(1.74);
    expect(wide.warnings).toEqual([]);
  });

  it("refuses when even the collection does not fit", async () => {
    const { session, calls } = await makeSession(api());
    const error = await refusal(buildCore(session, { seeds: SEEDS, budgetRub: 0.03 }));
    expect(error.kind).toBe("over_budget");
    expect(error.hintRu).toMatch(/подсбор/);
    expect(calls).toHaveLength(0);
  });

  it("caps the plan at the session budget", async () => {
    const { session } = await makeSession(api(), { budgetRub: 1 });
    const dry = await buildCore(
      session,
      { seeds: SEEDS, budgetRub: 30, source: "wordstat" },
      { dryRun: true },
    );
    expect(dry.estimate.totalRub).toBeLessThanOrEqual(1);
    expect(dry.warnings[0]).toMatch(/Остаток бюджета сессии/);
  });

  it("returns a partial result when a step does not fit into the approved plan", async () => {
    const { session, count } = await makeSession(api());
    const real = session.parserCall.bind(session);
    vi.spyOn(session, "parserCall").mockImplementation((phrases, parsers) =>
      real(parsers.includes("wordstat_qs") ? 1 : phrases, parsers),
    );
    const result = done(
      await confirmed((options) =>
        buildCore(session, { seeds: SEEDS, budgetRub: 20, source: "wordstat" }, options),
      ),
    );
    expect(result.partial).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/точные частоты.*частичный/s);
    expect(result.table.rows.length).toBeGreaterThan(0);
    expect(result.table.rows.every((row) => row.wordstat_qs === null)).toBe(true);
    expect(count("parser.mass.new")).toBe(2);
  });

  it("switches auto source to Wordstat on 111", async () => {
    const { session, count } = await makeSession(api());
    const result = done(
      await confirmed((options) => buildCore(session, { seeds: SEEDS, budgetRub: 20 }, options)),
    );
    expect(result.summary.source).toBe("wordstat");
    expect(result.warnings.join("\n")).toMatch(/111/);
    expect(count("serp.report")).toBe(1);
    expect(result.table.rows.length).toBe(13);
  });

  it("collects Mega-tool tails with a subscription", async () => {
    const serp = vi.fn((body: Record<string, unknown>) =>
      json(
        Object.entries(body.keyword === "натяжные потолки" ? CEILINGS : WINDOWS).map(
          ([keyword, value]) => ({ keyword, region_wsn: value, world_wsn: value * 3 }),
        ),
      ),
    );
    const { session, count } = await makeSession(fakeHandlers({ serp, exact: EXACT }));
    const result = done(
      await confirmed((options) =>
        buildCore(
          session,
          { seeds: SEEDS, budgetRub: 20, source: "auto", exactTypes: [] },
          options,
        ),
      ),
    );
    expect(result.summary.source).toBe("serp");
    expect(count("parser.mass.new")).toBe(0);
    expect(serp.mock.calls[0]?.[0]).toMatchObject({
      report: "report_keyword_tailings",
      region: "yandex_msk",
      limit: 200,
    });
    expect(result.table.rows[0]).toMatchObject({ phrase: "натяжные потолки", base: 120_000 });
    expect(result.table.columns.map((column) => column.key)).toEqual([
      "phrase",
      "base",
      "cluster",
      "seed",
    ]);
  });

  it("reports a missing subscription for the serp source", async () => {
    const { session } = await makeSession(fakeHandlers({ serp: subscriptionMissing }));
    await expect(
      confirmed((options) =>
        buildCore(session, { seeds: SEEDS, budgetRub: 5, source: "serp" }, options),
      ),
    ).rejects.toMatchObject({ code: 111 });
  });

  it("keeps phrases without frequencies when the data is not recognized", async () => {
    const { session } = await makeSession(
      fakeHandlers({
        wordstat: { "натяжные потолки": CEILINGS },
        exactData: { weird: [1, 2, 3] },
      }),
    );
    const result = done(
      await confirmed((options) =>
        buildCore(
          session,
          { seeds: ["натяжные потолки"], budgetRub: 5, source: "wordstat", minExact: 10 },
          options,
        ),
      ),
    );
    expect(result.summary.frequenciesRecognized).toBe(false);
    expect(result.warnings.join("\n")).toMatch(/не распознаны/);
    expect(result.table.rows.length).toBeGreaterThan(0);
    expect(result.table.rows.every((row) => row.wordstat_qs === null)).toBe(true);
  });

  it("warns about unrecognized Wordstat data and missing seeds", async () => {
    const { session } = await makeSession({
      ...fakeHandlers({}),
      "parser.mass.id": () => json({ status: "finish", data: "garbage" }),
    });
    const result = done(
      await confirmed((options) =>
        buildCore(session, { seeds: ["окна"], budgetRub: 5, source: "wordstat" }, options),
      ),
    );
    expect(result.table.rows).toEqual([]);
    expect(result.warnings.join("\n")).toMatch(/«окна»/);
  });

  it("refuses paid plans in free-only mode before any request", async () => {
    const { session, calls } = await makeSession(api(), { freeOnly: true });
    const error = await refusal(buildCore(session, { seeds: SEEDS, budgetRub: 5 }));
    expect(error.kind).toBe("free_only");
    expect(calls).toHaveLength(0);
  });

  it("repeats after processing for free: the same plan, no confirmation, no new mass task", async () => {
    const handlers = fakeHandlers({ wordstat: { "натяжные потолки": CEILINGS }, exact: EXACT });
    const frequencyTasks = new Set<number>();
    let ready = false;
    const create = handlers["parser.mass.new"];
    const read = handlers["parser.mass.id"];
    const { session, count } = await makeSession(
      {
        ...handlers,
        "parser.mass.new": async (call) => {
          const response = (await create?.(call)) as Response;
          const { id } = (await response.clone().json()) as { id: number };
          if ((call.body as { parser: string }).parser === "wordstat_qs") frequencyTasks.add(id);
          return response;
        },
        "parser.mass.id": (call) =>
          !ready && frequencyTasks.has((call.body as { mass_id: number }).mass_id)
            ? json({ status: "process" })
            : (read?.(call) as Response),
      },
      { budgetRub: 0.25, massTimeoutMs: 1 },
    );
    const params = { seeds: ["натяжные потолки"], budgetRub: 0.2, source: "wordstat" as const };
    const first = done(await confirmed((options) => buildCore(session, params, options)));
    expect(first).toMatchObject({ processing: true, partial: true });
    expect(count("parser.mass.new")).toBe(2);
    const spent = session.spending().spentRub;
    expect(spent).toBeGreaterThan(0.1);

    ready = true;
    const dry = await buildCore(session, params, { dryRun: true });
    expect(dry.estimate.totalRub).toBe(0);
    expect(dry.summary).toMatchObject({ maxPhrases: first.summary.maxPhrases });
    const again = done(await buildCore(session, params));
    expect(again).toMatchObject({ processing: false, partial: false });
    expect(again.estimate.totalRub).toBe(0);
    expect(count("parser.mass.new")).toBe(2);
    expect(session.spending().spentRub).toBe(spent);
    expect(again.table.rows.some((row) => row.wordstat_qs === 30_000)).toBe(true);
  });

  it("keeps phrases without a frequency and warns that the filters could not judge them", async () => {
    const { session } = await makeSession(
      fakeHandlers({
        wordstat: {
          "натяжные потолки": { ...CEILINGS, "потолок без частоты": null as unknown as number },
        },
        exactData: [],
      }),
    );
    const result = done(
      await confirmed((options) =>
        buildCore(
          session,
          {
            seeds: ["натяжные потолки"],
            budgetRub: 20,
            source: "wordstat",
            minFrequency: 1_000,
            minExact: 10,
          },
          options,
        ),
      ),
    );
    const rows = new Map(result.table.rows.map((row) => [row.phrase, row]));
    expect(rows.get("потолок без частоты")).toMatchObject({ base: null });
    expect(result.warnings.join("\n")).toContain(
      "Частота не получена для 1 фраз: фильтр min_frequency",
    );
    expect(result.warnings.join("\n")).toMatch(
      /Частота не получена для \d+ фраз: фильтр min_exact/,
    );
  });

  it("validates its parameters", async () => {
    const { session } = await makeSession(api());
    const base = { seeds: SEEDS, budgetRub: 5 };
    await expect(buildCore(session, { ...base, seeds: [] })).rejects.toThrow(/seeds/);
    await expect(
      buildCore(session, { ...base, seeds: Array.from({ length: 21 }, (_, i) => `s${i}`) }),
    ).rejects.toThrow(/seeds/);
    await expect(buildCore(session, { ...base, budgetRub: 0 })).rejects.toThrow(/budgetRub/);
    await expect(buildCore(session, { ...base, source: "x" as never })).rejects.toThrow(/source/);
    await expect(buildCore(session, { ...base, depth: 5 as never })).rejects.toThrow(/depth/);
    await expect(buildCore(session, { ...base, serpRegion: "mars" })).rejects.toThrow(/serpRegion/);
    await expect(buildCore(session, { ...base, exactTypes: ["direct"] as never })).rejects.toThrow(
      /exactTypes/,
    );
    await expect(buildCore(session, { ...base, maxPhrases: 0 })).rejects.toThrow(/maxPhrases/);
    await expect(buildCore(session, { ...base, minExact: -1 })).rejects.toThrow(/minExact/);
  });
});

describe("expandCore", () => {
  const core = [
    { phrase: "натяжные потолки", frequency: 120_000 },
    { phrase: "натяжной потолок цена", frequency: 45_000 },
    { phrase: "пластиковые окна", frequency: 90_000 },
  ];

  it("returns only phrases missing from the core, with cluster heads as seeds", async () => {
    const { session, calls } = await makeSession(api());
    const result = done(
      await confirmed((options) =>
        expandCore(session, { phrases: core, budgetRub: 5, source: "wordstat" }, options),
      ),
    );
    const seeds = calls
      .filter((call) => call.url.includes("parser.mass.new"))
      .map((call) => (call.body as { keys_list: string[] }).keys_list[0]);
    expect(seeds.sort()).toEqual(["натяжные потолки", "пластиковые окна"]);
    const phrases = result.table.rows.map((row) => row.phrase);
    expect(phrases).not.toContain("натяжные потолки");
    expect(phrases).not.toContain("натяжные потолки цена");
    expect(phrases).not.toContain("цена натяжного потолка");
    expect(phrases).toContain("окна пвх");
    expect(
      result.table.rows.find((row) => row.phrase === "матовый натяжной потолок"),
    ).toMatchObject({ frequency: 2_000, cluster: "натяжные потолки", seed: "натяжные потолки" });
    expect(result.summary).toMatchObject({ source: "wordstat", known: 4 });
    expect(result.summary.newPhrases).toBe(phrases.length);
  });

  it("limits new phrases and seeds to the budget", async () => {
    const { session } = await makeSession(api());
    const dry = await expandCore(
      session,
      { phrases: core, budgetRub: 0.02, seeds: SEEDS, source: "wordstat" },
      { dryRun: true },
    );
    expect(dry.summary).toMatchObject({ seeds: ["натяжные потолки"] });
    expect(dry.warnings[0]).toMatch(/1 маркеров из 2/);
    await expect(
      expandCore(session, { phrases: core, budgetRub: 0.01, source: "wordstat" }),
    ).rejects.toMatchObject({ kind: "over_budget" });
    const result = done(
      await confirmed((options) =>
        expandCore(
          session,
          { phrases: core, budgetRub: 5, seeds: SEEDS, source: "wordstat", maxNew: 2 },
          options,
        ),
      ),
    );
    expect(result.table.rows.map((row) => row.phrase)).toEqual([
      "пластиковые окна цена",
      "окна пвх",
    ]);
  });
});
