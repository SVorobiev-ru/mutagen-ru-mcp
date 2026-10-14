import { afterEach, describe, expect, it } from "vitest";
import { cluster, serpUrls } from "../../../src/scenarios/cluster.js";
import { composeTitleH1, titleH1 } from "../../../src/scenarios/title.js";
import { CEILINGS_AND_WINDOWS } from "../text/fixtures.js";
import { cleanup, confirmed, done, fakeHandlers, json, makeSession } from "./helpers.js";

afterEach(cleanup);

const top = (...ids: number[]) =>
  ids.map((id, index) => ({
    position: index + 1,
    domain: `site${id}.ru`,
    page: `https://site${id}.ru/p`,
  }));

const SERPS: Record<string, ReturnType<typeof top>> = {
  "натяжные потолки": top(1, 2, 3, 4, 5, 6, 7, 8, 9, 10),
  "натяжной потолок": top(1, 2, 3, 4, 11, 12, 13, 14, 15, 16),
  "пластиковые окна": top(40, 41, 42, 43, 44, 45, 46, 47, 48, 49),
  "окна пвх": top(40, 41, 42, 50, 51, 52, 53, 54, 55, 56),
};

describe("cluster", () => {
  it("clusters lexically for free", async () => {
    const { session, calls } = await makeSession({});
    const result = done(await cluster(session, { phrases: CEILINGS_AND_WINDOWS }));
    expect(result.estimate.totalRub).toBe(0);
    expect(result.table.columns.map((column) => column.key)).toEqual([
      "cluster",
      "phrase",
      "frequency",
      "is_head",
    ]);
    expect(result.table.rows[0]).toEqual({
      cluster: "натяжные потолки",
      phrase: "натяжные потолки",
      frequency: 120_000,
      is_head: true,
    });
    const ceilings = result.table.rows.filter((row) => row.cluster === "натяжные потолки");
    expect(ceilings.map((row) => row.phrase)).toContain("матовый натяжной потолок");
    const windows = result.table.rows.filter((row) => row.cluster === "пластиковые окна");
    expect(windows.map((row) => row.phrase)).toContain("ремонт пластиковых окон");
    expect(result.summary).toMatchObject({ mode: "lexical", phrases: 42, clusters: 6 });
    const strict = done(
      await cluster(session, { phrases: CEILINGS_AND_WINDOWS, strictness: "strict" }),
    );
    expect(strict.summary.clusters).toBe(3);
    expect(calls).toHaveLength(0);
  });

  it("clusters by search results with one quota request per phrase", async () => {
    const { session, count } = await makeSession(
      fakeHandlers({
        serp: (body) =>
          body.keyword === "без выдачи"
            ? json({ error_id: 117, error_msg: "item missing in database" })
            : json(SERPS[body.keyword as string] ?? []),
      }),
    );
    const phrases = [
      { phrase: "натяжные потолки", frequency: 100 },
      { phrase: "натяжной потолок", frequency: 50 },
      { phrase: "пластиковые окна", frequency: 90 },
      { phrase: "окна пвх", frequency: 80 },
      { phrase: "без выдачи", frequency: 1 },
    ];
    const dry = await cluster(session, { phrases, mode: "serp" }, { dryRun: true });
    expect(dry.estimate).toMatchObject({ totalRub: 0, quotaRequests: 5 });
    expect(count("serp.report")).toBe(0);
    const result = done(await cluster(session, { phrases, mode: "serp", minCommon: 3 }));
    expect(result.table.rows.map((row) => [row.cluster, row.phrase])).toEqual([
      ["пластиковые окна", "пластиковые окна"],
      ["пластиковые окна", "окна пвх"],
      ["натяжные потолки", "натяжные потолки"],
      ["натяжные потолки", "натяжной потолок"],
      ["без выдачи", "без выдачи"],
    ]);
    expect(result.summary).toMatchObject({ mode: "serp", clusters: 3, withoutSerp: 1 });
    expect(result.warnings.join("\n")).toMatch(/Нет выдачи/);
    expect(count("serp.report")).toBe(5);
    expect(session.spending().quotaRequests).toBe(5);
  });

  it("fails clearly without a subscription and limits serp mode to 300 phrases", async () => {
    const { session } = await makeSession(fakeHandlers({}));
    await expect(cluster(session, { phrases: ["окна"], mode: "serp" })).rejects.toMatchObject({
      code: 111,
    });
    const many = Array.from({ length: 301 }, (_, i) => `фраза ${i}`);
    await expect(cluster(session, { phrases: many, mode: "serp" })).rejects.toThrow(/300/);
    await expect(
      cluster(session, { phrases: ["окна"], mode: "serp", strictness: "strict" }),
    ).rejects.toThrow(/strictness/);
    await expect(cluster(session, { phrases: ["окна"], mode: "x" as never })).rejects.toThrow(
      /mode/,
    );
  });

  it("reads clusters of a Favorites project", async () => {
    const { session, calls } = await makeSession(
      fakeHandlers({
        projectKeywords: [
          { keyword: "окна пвх", claster_id: "7" },
          { keyword: "пластиковые окна", claster_id: "7" },
          { keyword: "двери", claster_id: null },
          { keyword: "межкомнатные двери", claster_id: "" },
        ],
      }),
    );
    const result = done(
      await cluster(session, {
        mode: "project",
        projectId: 3,
        phrases: [{ phrase: "Пластиковые окна", frequency: 90 }],
      }),
    );
    expect(result.table.rows).toEqual([
      { cluster: "пластиковые окна", phrase: "пластиковые окна", frequency: 90, is_head: true },
      { cluster: "пластиковые окна", phrase: "окна пвх", frequency: null, is_head: false },
      { cluster: "двери", phrase: "двери", frequency: null, is_head: true },
      {
        cluster: "межкомнатные двери",
        phrase: "межкомнатные двери",
        frequency: null,
        is_head: true,
      },
    ]);
    expect(calls[0]?.body).toEqual({ progect_id: 3 });
    await expect(cluster(session, { mode: "project" })).rejects.toThrow(/projectId/);
  });

  it("orders SERP URLs by position", () => {
    expect(
      serpUrls([
        { position: 2, domain: "b.ru" },
        { position: "1", page: "https://a.ru/x" },
        { domain: 5 },
      ]),
    ).toEqual(["https://a.ru/x", "b.ru"]);
  });
});

const CLUSTER = [
  { phrase: "натяжные потолки", frequency: 120_000 },
  { phrase: "натяжные потолки цена", frequency: 45_000 },
  { phrase: "натяжные потолки фото", frequency: 20_000 },
  { phrase: "натяжные потолки москва", frequency: 15_000 },
  { phrase: "установка натяжных потолков", frequency: 12_000 },
  { phrase: "натяжной потолок недорого", frequency: 4_000 },
];

const items = (rows: [string, number][]) =>
  rows.map(([phrase, frequency]) => ({ phrase, frequency }));

const WINDOWS = items([
  ["пластиковые окна", 90_000],
  ["окна пвх", 60_000],
  ["пластиковые окна цена", 25_000],
  ["пластиковые окна москва", 10_000],
  ["купить пластиковые окна", 9_000],
  ["ремонт пластиковых окон", 7_500],
  ["цены на пластиковые окна", 6_000],
  ["установка пластиковых окон", 5_000],
  ["пластиковые окна в москве от производителя", 2_000],
]);

const SEO = items([
  ["seo продвижение", 50_000],
  ["seo продвижение сайтов", 21_000],
  ["seo продвижение сайта", 12_000],
  ["seo продвижение цена", 8_000],
  ["seo продвижение москва", 6_000],
  ["seo продвижение сайта в москве", 3_000],
  ["стоимость seo продвижения", 2_000],
  ["seo продвижение что это", 1_500],
  ["заказать seo продвижение", 1_200],
  ["seo продвижение под ключ", 900],
]);

const PRICE = items([
  ["натяжной потолок цена", 55_926],
  ["потолок натяжной цена с установкой", 21_548],
  ["сколько стоит натяжной потолок", 18_667],
  ["стоимость натяжного потолка", 11_164],
  ["натяжной потолок цена за метр", 6_884],
  ["сколько стоит метр натяжного потолка", 5_169],
  ["натяжной потолок цена за м2", 4_421],
  ["натяжной потолок цена под ключ", 2_894],
]);

describe("titleH1", () => {
  it("builds grammatical Title, H1 and Description from source forms only", () => {
    expect(composeTitleH1(CLUSTER)).toMatchObject({
      title: "Натяжные потолки — цена, фото",
      h1: "Натяжные потолки цена",
      description: "Натяжные потолки: цена, фото. Узнайте подробнее на сайте!",
    });
    expect(composeTitleH1(WINDOWS)).toMatchObject({
      title: "Пластиковые окна — цена, в москве от производителя",
      h1: "Окна пвх",
      description: "Пластиковые окна: цена, в москве от производителя. Узнайте подробнее на сайте!",
    });
    const seo = composeTitleH1(SEO);
    expect(seo).toMatchObject({
      title: "Seo продвижение — цена, под ключ",
      h1: "Seo продвижение сайтов",
      description: "Seo продвижение: цена, под ключ. Узнайте подробнее на сайте!",
    });
    expect(seo.title).not.toMatch(/сайтов|сайта/);
    const price = composeTitleH1(PRICE);
    expect(price).toMatchObject({
      title: "Натяжной потолок цена — с установкой, за метр",
      h1: "Потолок натяжной цена с установкой",
      description: "Натяжной потолок цена: с установкой, за метр. Узнайте подробнее на сайте!",
    });
    expect(price.rationale.title).toContain(
      "«с установкой» из «потолок натяжной цена с установкой» (21548)",
    );
  });

  it("is deterministic for any input order", () => {
    for (const cluster of [CLUSTER, WINDOWS, SEO, PRICE]) {
      const texts = composeTitleH1(cluster, { brand: "ПотолокПро" });
      expect(composeTitleH1([...cluster].reverse(), { brand: "ПотолокПро" })).toEqual(texts);
      expect(composeTitleH1(cluster, { brand: "ПотолокПро" })).toEqual(texts);
    }
  });

  it("takes a whole phrase and skips phrases without a readable tail", () => {
    const texts = composeTitleH1(
      items([
        ["пластиковые окна", 90_000],
        ["окна пвх", 60_000],
        ["ремонт пластиковых окон", 7_500],
      ]),
    );
    expect(texts.title).toBe("Пластиковые окна — окна пвх");
    expect(texts.rationale.title).toContain("фраза «окна пвх» (60000)");
  });

  it("respects the length limits, the brand and the city", () => {
    const branded = composeTitleH1(CLUSTER, { brand: "ПотолокПро" });
    expect(branded.title).toBe("Натяжные потолки — цена, фото | ПотолокПро");
    expect(branded.description).toBe(
      "Натяжные потолки: цена, фото. Узнайте подробнее в ПотолокПро!",
    );
    const long = composeTitleH1(CLUSTER, {
      brand: "Очень длинное название компании по натяжным потолкам",
      city: "Москва",
    });
    expect(long.title).toBe("Натяжные потолки — цена, фото, Москва");
    const city = composeTitleH1(WINDOWS, { city: "Казань" });
    expect(city.title).toBe("Пластиковые окна — цена, окна пвх, Казань");
    expect(city.description.startsWith("Пластиковые окна, Казань: цена, окна пвх.")).toBe(true);
    const longTails = items([
      ["натяжные потолки", 100],
      ["натяжные потолки с фотопечатью и подсветкой для детской комнаты", 90],
      ["натяжные потолки под ключ с установкой за один день без пыли", 80],
    ]);
    expect(composeTitleH1(longTails).title).toBe(
      "Натяжные потолки — с фотопечатью и подсветкой для детской комнаты",
    );
    expect(composeTitleH1(longTails, { city: "Санкт-Петербург" }).title).toBe(
      "Натяжные потолки, Санкт-Петербург",
    );
    for (const cluster of [CLUSTER, WINDOWS, SEO, PRICE]) {
      const texts = composeTitleH1(cluster, { brand: "Длинный бренд компании", city: "Москва" });
      expect([...texts.title].length).toBeLessThanOrEqual(70);
      expect([...texts.description].length).toBeLessThanOrEqual(160);
      expect(texts.title).not.toContain(" в Москв");
    }
    const single = composeTitleH1(["окна"]);
    expect(single).toMatchObject({ title: "Окна", h1: "Окна" });
    expect(single.rationale.h1).toMatch(/Других формулировок нет/);
    expect(() => composeTitleH1(["!!!"])).toThrow(/phrases/);
  });

  it("is free with frequencies and asks Wordstat for the missing ones", async () => {
    const free = await makeSession({});
    const result = done(await titleH1(free.session, { phrases: CLUSTER }));
    expect(result.estimate.totalRub).toBe(0);
    expect(result.summary).toMatchObject({
      mainPhrase: "натяжные потолки",
      mainFrequency: 120_000,
      frequenciesFrom: "input",
    });
    expect(result.table.rows.map((row) => row.element)).toEqual(["Title", "H1", "Description"]);
    expect(free.calls).toHaveLength(0);

    const paid = await makeSession(
      fakeHandlers({ exact: { "окна пвх": 900, "пластиковые окна": 3_000, окна: 10 } }),
    );
    const phrases = ["окна пвх", "пластиковые окна", "окна"];
    const dry = await titleH1(paid.session, { phrases }, { dryRun: true });
    expect(dry.estimate.totalRub).toBe(0.06);
    const ran = done(await confirmed((options) => titleH1(paid.session, { phrases }, options)));
    expect(ran.summary).toMatchObject({
      title: "Пластиковые окна — окна пвх",
      h1: "Окна пвх",
      frequenciesFrom: "wordstat_qs",
    });
    expect(paid.count("parser.mass.new")).toBe(1);
    await expect(
      titleH1(paid.session, { phrases: ["двери"], budgetRub: 0.01 }),
    ).rejects.toMatchObject({ kind: "over_budget" });
  });
});
