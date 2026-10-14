import { afterEach, describe, expect, it } from "vitest";
import { MISSING_KEY_RU } from "../../../src/mcp/links.js";
import { fakeHandlers } from "../scenarios/helpers.js";
import { CEILINGS_AND_WINDOWS } from "../text/fixtures.js";
import { cleanup, setup, textOf } from "./helpers.js";

afterEach(cleanup);

const api = () =>
  fakeHandlers({
    wordstat: {
      "натяжные потолки": {
        "натяжные потолки": 120_000,
        "натяжные потолки цена": 45_000,
        "матовый натяжной потолок": 2_000,
        "натяжные потолки вакансии": 700,
      },
    },
    exact: { "натяжные потолки": 30_000 },
  });

describe("scenario tools", () => {
  it("shows the plan on dry_run and runs build_core with the confirm token", async () => {
    const { call, count } = await setup(api());
    const args = { seeds: ["натяжные потолки"], budget_rub: 2, source: "wordstat" };
    const dry = await call("mutagen_build_core", { ...args, dry_run: true });
    expect(dry.structuredContent).toMatchObject({ status: "dry_run" });
    expect(textOf(dry)).toContain("Смета: 2.00 ₽");
    expect(textOf(dry)).toContain("max_phrases 500 → 99");
    expect(count("parser.mass.new")).toBe(0);

    const ask = await call("mutagen_build_core", args);
    expect(ask.structuredContent).toMatchObject({ status: "needs_confirmation" });
    const token = ask.structuredContent?.confirm_token as string;
    expect(token).toBeTruthy();
    expect(count("parser.mass.new")).toBe(0);

    const result = await call("mutagen_build_core", { ...args, confirm_token: token });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      total: 3,
      summary: { source: "wordstat", phrases: 3 },
    });
    const rows = (result.structuredContent?.rows ?? []) as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ phrase: "натяжные потолки", wordstat_qs: 30_000 });
    expect(textOf(result)).toContain("Итоги / Summary");
    expect(textOf(result)).toContain("Данные: Мутаген (mutagen.ru)");
    expect(count("parser.mass.new")).toBe(2);
  });

  it("keeps every phrase with empty exclude_categories", async () => {
    const { call } = await setup(api());
    const result = await call("mutagen_build_core", {
      seeds: ["натяжные потолки"],
      budget_rub: 2,
      source: "wordstat",
      exclude_categories: [],
    });
    expect(result.structuredContent).toMatchObject({ status: "needs_confirmation" });
    const token = result.structuredContent?.confirm_token as string;
    const done = await call("mutagen_build_core", {
      seeds: ["натяжные потолки"],
      budget_rub: 2,
      source: "wordstat",
      exclude_categories: [],
      confirm_token: token,
    });
    expect(done.structuredContent).toMatchObject({
      status: "ok",
      total: 4,
      summary: { removed: { minus: 0 }, minusWords: [] },
    });
    const bad = await call("mutagen_build_core", {
      seeds: ["натяжные потолки"],
      budget_rub: 2,
      exclude_categories: ["spam"],
    });
    expect(bad.isError).toBe(true);
  });

  it("asks the user once for the whole plan through elicitation", async () => {
    const { call, count, prompts } = await setup(api(), {
      elicit: () => ({ action: "accept", content: { confirm: true } }),
    });
    const result = await call("mutagen_build_core", {
      seeds: ["натяжные потолки"],
      budget_rub: 2,
      source: "wordstat",
    });
    expect(result.structuredContent).toMatchObject({ status: "ok" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("mutagen_build_core");
    expect(count("parser.mass.new")).toBe(2);
  });

  it("runs free scenarios without confirmation", async () => {
    const { call, calls } = await setup({});
    const clusters = await call("mutagen_cluster", {
      phrases: CEILINGS_AND_WINDOWS,
      limit: 3,
    });
    expect(clusters.structuredContent).toMatchObject({ status: "ok", total: 42 });
    const minus = await call("mutagen_minus_words", {
      phrases: CEILINGS_AND_WINDOWS.map((item) => item.phrase),
    });
    expect(textOf(minus)).toMatch(/Минус-слова \/ Direct: .*-вакансии/);
    const title = await call("mutagen_title_h1", {
      phrases: [
        { phrase: "окна пвх", frequency: 100 },
        { phrase: "окна пвх цена", frequency: 50 },
        { phrase: "пластиковые окна", frequency: 40 },
      ],
      brand: "Окна-М",
    });
    expect(textOf(title)).toContain("Title: Окна пвх — цена, пластиковые окна | Окна-М");
    const plan = await call("mutagen_content_plan", {
      phrases: ["как мыть окна", "чем мыть окна", "окна пвх"],
    });
    expect(plan.structuredContent).toMatchObject({ status: "ok", total: 1 });
    expect(calls).toHaveLength(0);
  });

  it("explains a missing subscription for content_gap", async () => {
    const { call } = await setup(fakeHandlers({}));
    const result = await call("mutagen_content_gap", { domain: "my.ru" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("только с подпиской");
    expect(textOf(result)).toContain("API error code: 111");
  });

  it("returns validation errors of scenarios", async () => {
    const { call } = await setup({});
    const result = await call("mutagen_build_core", {
      seeds: ["окна"],
      budget_rub: 1,
      serp_region: "mars",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("serpRegion");
  });
});

describe("scenario tools without MUTAGEN_API_KEY", () => {
  it("run the free cases locally without any request", async () => {
    const { call, calls } = await setup({}, { key: false });
    const clusters = await call("mutagen_cluster", { phrases: CEILINGS_AND_WINDOWS });
    expect(clusters.isError).toBeUndefined();
    expect(clusters.structuredContent).toMatchObject({ status: "ok", total: 42 });
    const minus = await call("mutagen_minus_words", {
      phrases: CEILINGS_AND_WINDOWS.map((item) => item.phrase),
    });
    expect(textOf(minus)).toMatch(/Минус-слова \/ Direct: .*-вакансии/);
    const plan = await call("mutagen_content_plan", {
      phrases: ["как мыть окна", "чем мыть окна", "окна пвх"],
    });
    expect(plan.structuredContent).toMatchObject({ status: "ok", total: 1 });
    const title = await call("mutagen_title_h1", {
      phrases: [
        { phrase: "окна пвх", frequency: 100 },
        { phrase: "окна пвх цена", frequency: 50 },
      ],
    });
    expect(textOf(title)).toContain("Title: Окна пвх — цена");
    expect(calls).toHaveLength(0);
  });

  it("asks for the key when the case needs the API", async () => {
    const { call, calls } = await setup({}, { key: false });
    const cases: [string, Record<string, unknown>][] = [
      ["mutagen_title_h1", { phrases: [{ phrase: "окна пвх", frequency: 100 }, "окна пвх цена"] }],
      ["mutagen_cluster", { phrases: ["окна пвх"], mode: "serp" }],
      ["mutagen_minus_words", { seeds: ["окна"], budget_rub: 1 }],
      ["mutagen_content_plan", { seeds: ["окна"], budget_rub: 1 }],
      ["mutagen_expand_core", { phrases: ["окна пвх"], budget_rub: 1 }],
      ["mutagen_build_core", { seeds: ["окна"], budget_rub: 1, dry_run: true }],
    ];
    for (const [tool, args] of cases) {
      const result = await call(tool, args);
      expect(result.isError, tool).toBe(true);
      expect(textOf(result), tool).toContain(MISSING_KEY_RU);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("mutagen_text", () => {
  it("processes phrases locally", async () => {
    const { call, calls } = await setup({}, { key: false });
    const dedupe = await call("mutagen_text", {
      operation: "dedupe",
      phrases: ["окна пвх", "Окна ПВХ", { phrase: "двери", frequency: 5 }],
    });
    expect(dedupe.structuredContent).toMatchObject({
      status: "ok",
      total: 2,
      summary: { input: 3, output: 2, removed: 1 },
    });
    const compare = await call("mutagen_text", {
      operation: "compare",
      phrases: ["окна", "двери"],
      phrases_b: ["окно", "крыша"],
      implicit: true,
    });
    expect(compare.structuredContent?.rows).toEqual([
      { phrase: "окна", list: "both" },
      { phrase: "двери", list: "only_a" },
      { phrase: "крыша", list: "only_b" },
    ]);
    const bad = await call("mutagen_text", { operation: "combinator" });
    expect(bad.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("prompts", () => {
  it("lists and renders the four prompts", async () => {
    const { client } = await setup({});
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual([
      "build-core",
      "content-plan",
      "direct-prep",
      "expand-core",
    ]);
    const core = await client.getPrompt({
      name: "build-core",
      arguments: { niche: "натяжные потолки", budget_rub: "30", region: "213" },
    });
    const text = (core.messages[0]?.content as { text: string } | undefined)?.text;
    expect(text).toContain("натяжные потолки");
    expect(text).toContain("не больше 30 ₽");
    expect(text).toContain("Регион Вордстата: 213");
    expect(text).toContain("mutagen_build_core");
    expect(text).toContain("dry_run");
    for (const [name, args, tool] of [
      ["expand-core", {}, "mutagen_expand_core"],
      ["direct-prep", { niche: "окна" }, "mutagen_minus_words"],
      ["content-plan", { topic: "окна", budget_rub: "5" }, "mutagen_content_plan"],
    ] as const) {
      const result = await client.getPrompt({ name, arguments: args });
      const body = (result.messages[0]?.content as { text: string } | undefined)?.text;
      expect(body).toContain(tool);
      expect(body).toContain("dry_run");
    }
  });
});
