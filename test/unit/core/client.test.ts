import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MutagenClient } from "../../../src/core/client.js";
import { MutagenError } from "../../../src/core/errors.js";
import { RateLimiter } from "../../../src/core/rate-limit.js";
import { REDACTED } from "../../../src/core/transport.js";
import type { SerpReportParams } from "../../../src/core/types.js";
import { API_KEY, hangingFetch, json, methodOf, type Reply, stubFetch } from "./helpers.js";

const FAST = { concurrency: 10, perSecond: 1000 };

function client(...replies: Reply[]) {
  const stub = stubFetch(...replies);
  return {
    api: new MutagenClient({ apiKey: API_KEY, fetch: stub.fetch, rateLimit: FAST }),
    ...stub,
  };
}

async function failure(promise: Promise<unknown>): Promise<MutagenError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MutagenError);
    return error as MutagenError;
  }
  throw new Error("Expected the call to fail");
}

const CHECK_KEY_DONE = {
  status: "completed",
  key: "mp3",
  strong: 25,
  wordstat: 31460,
  tails: 5174841,
  direct: { spec: 129.3, first: 6.6, garant: 6.6 },
  vital: "",
  vital_site: "",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("simple methods", () => {
  it("balance parses the documented example", async () => {
    const { api, calls } = client(new Response('{"balance":100.00}'));
    await expect(api.balance()).resolves.toEqual({ balance: 100 });
    expect(methodOf(calls[0]?.url ?? "")).toBe("mutagen.balance");
    expect(calls[0]?.method).toBe("GET");
  });

  it("balance accepts a numeric string", async () => {
    const { api } = client(json({ balance: "250.4" }));
    await expect(api.balance()).resolves.toEqual({ balance: 250.4 });
  });

  it("balance rounds the float tail to kopecks", async () => {
    const { api } = client(new Response('{"balance":120.75999999999999}'));
    await expect(api.balance()).resolves.toEqual({ balance: 120.76 });
  });

  it("has no project list method: mutagen.progects does not exist", () => {
    const { api } = client(json({}));
    expect("projects" in api).toBe(false);
  });

  it("projectKeywords sends progect_id and normalizes clusters", async () => {
    const { api, calls } = client(
      json([
        { keyword: "натяжные потолки", claster_id: "потолки" },
        { keyword: "потолок", claster_id: null },
        { keyword: "цена", claster_id: 7 },
      ]),
    );
    await expect(api.projectKeywords(12)).resolves.toEqual([
      { keyword: "натяжные потолки", claster_id: "потолки" },
      { keyword: "потолок", claster_id: null },
      { keyword: "цена", claster_id: "7" },
    ]);
    expect(methodOf(calls[0]?.url ?? "")).toBe("mutagen.progect.keywords");
    expect(calls[0]?.body).toEqual({ progect_id: 12 });
  });

  it("checkKeyNew parses the documented example", async () => {
    const { api, calls } = client(json({ task_id: "9731540", status: "created" }));
    await expect(api.checkKeyNew("mp3")).resolves.toEqual({ task_id: 9731540, status: "created" });
    expect(methodOf(calls[0]?.url ?? "")).toBe("mutagen.check_key.new");
    expect(calls[0]?.body).toEqual({ key: "mp3" });
  });

  it("checkKeyGet parses the documented completed example", async () => {
    const { api, calls } = client(json(CHECK_KEY_DONE));
    const result = await api.checkKeyGet(9731540);
    expect(result).toEqual({ ...CHECK_KEY_DONE, vital: false });
    expect(calls[0]?.body).toEqual({ task_id: 9731540 });
  });

  it("checkKeyGet returns the task while not ready", async () => {
    const { api } = client(json({ task_id: "9731540", status: "processed" }));
    await expect(api.checkKeyGet(9731540)).resolves.toEqual({
      task_id: 9731540,
      status: "processed",
    });
  });

  it("checkKeyGet tolerates string numbers, true vital and empty direct", async () => {
    const { api } = client(
      json({
        status: "completed",
        key: "k",
        strong: "3",
        wordstat: "",
        direct: [],
        vital: "1",
        vital_site: null,
        extra: "kept",
      }),
    );
    await expect(api.checkKeyGet(1)).resolves.toEqual({
      status: "completed",
      key: "k",
      strong: 3,
      vital: true,
      vital_site: "",
      extra: "kept",
    });
  });

  it("reports an unexpected response shape", async () => {
    const { api } = client(json({ balance: "lots" }));
    const error = await failure(api.balance());
    expect(error.kind).toBe("invalid_response");
    expect(error.message).toContain("mutagen.balance");
    expect(error.message).toContain("balance");
  });
});

describe("parser", () => {
  it("parserGet sends key, parser and default region", async () => {
    const { api, calls } = client(json({ status: "finish", data: { frequency: "1520" } }));
    const result = await api.parserGet({ key: "!купить !квадроцикл", parser: "wordstat_n" });
    expect(result).toEqual({ status: "finish", data: { frequency: 1520 } });
    expect(methodOf(calls[0]?.url ?? "")).toBe("mutagen.parser.get");
    expect(calls[0]?.body).toEqual({
      key: "!купить !квадроцикл",
      parser: "wordstat_n",
      region_id: "0",
    });
  });

  it("parserGet keeps a region list", async () => {
    const { api, calls } = client(json({ status: "process" }));
    await expect(
      api.parserGet({ key: "k", parser: "wordstat_qs", region_id: "255,-17" }),
    ).resolves.toEqual({ status: "process" });
    expect(calls[0]?.body).toMatchObject({ region_id: "255,-17" });
  });

  it("parserGet parses wordstat_key without the right column and with PHP-style empty arrays", async () => {
    const { api } = client(
      json({
        status: "finish",
        data: {
          frequency: 100,
          count_keys: "2",
          array: { "купить квадроцикл": "50", квадроцикл: 100 },
          assotiations: [],
        },
      }),
    );
    const result = await api.parserGet({ key: "квадроцикл", parser: "wordstat_key_50" });
    expect(result.data).toEqual({
      frequency: 100,
      count_keys: 2,
      array: { "купить квадроцикл": 50, квадроцикл: 100 },
    });
    expect(result.data?.assotiations).toBeUndefined();
  });

  it("parserGet keeps a missing frequency as null, not 0", async () => {
    const wordstat = client(
      json({ status: "finish", data: { array: { окна: null, двери: "", рамы: "7" } } }),
    );
    const left = await wordstat.api.parserGet({ key: "окна", parser: "wordstat_key_50" });
    expect(left.data).toEqual({ array: { окна: null, двери: null, рамы: 7 } });
    for (const data of [{ frequency: null }, { frequency: "" }, {}]) {
      const { api } = client(json({ status: "finish", data }));
      const result = await api.parserGet({ key: "окна", parser: "wordstat_n" });
      expect(result.data).toEqual({ frequency: null });
    }
  });

  it("parserGet parses direct bids", async () => {
    const { api } = client(
      json({
        status: "finish",
        data: {
          shows: 1000,
          bid1: "12.5",
          bid2: 8,
          bid3: 3.1,
          all_positions: {
            first_premium: { shows: 1000, clicks: 80, bid: 12.5, budget: 1000, ctr: 8 },
            std: { shows: 50, clicks: 1, bid: 3, budget: 3, ctr: 2 },
          },
        },
      }),
    );
    const result = await api.parserGet({ key: "k", parser: "direct" });
    expect(result.data?.bid1).toBe(12.5);
    expect(result.data?.all_positions.first_premium?.clicks).toBe(80);
  });

  it("parserGet drops empty data while pending", async () => {
    const { api } = client(json({ status: "create", data: [] }));
    await expect(api.parserGet({ key: "k", parser: "wordstat_q" })).resolves.toEqual({
      status: "create",
    });
  });

  it("parserGetWait repeats the call until finish", async () => {
    vi.useFakeTimers();
    const { api, calls } = client(
      json({ status: "create" }),
      json({ status: "process" }),
      json({ status: "finish", data: { frequency: 7 } }),
    );
    const result = api.parserGetWait({ key: "k", parser: "wordstat_qso", region_id: "225" });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ status: "finish", data: { frequency: 7 } });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.body).toEqual({ key: "k", parser: "wordstat_qso", region_id: "225" });
    }
  });

  it("parserGetWait fails on status error", async () => {
    vi.useFakeTimers();
    const { api } = client(json({ status: "process" }), json({ status: "error" }));
    const assertion = expect(
      api.parserGetWait({ key: "k", parser: "wordstat_n" }),
    ).rejects.toMatchObject({
      kind: "task_failed",
    });
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("parserGetWait finishes with empty data on finish without data", async () => {
    const { api, calls } = client(json({ status: "finish" }));
    await expect(api.parserGetWait({ key: "k", parser: "wordstat_n" })).resolves.toEqual({
      status: "finish",
      data: null,
    });
    expect(calls).toHaveLength(1);
  });

  it("parserGetWait polls without an attempt limit until the timeout", async () => {
    vi.useFakeTimers();
    const { api, calls } = client(json({ status: "process" }));
    const assertion = expect(
      api.parserGetWait({ key: "k", parser: "wordstat_n" }, { timeoutMs: 60_000 }),
    ).rejects.toMatchObject({ kind: "poll_timeout" });
    await vi.runAllTimersAsync();
    await assertion;
    expect(calls.length).toBeGreaterThan(5);
  });

  it("parserGetWait times out", async () => {
    vi.useFakeTimers();
    const { api } = client(json({ status: "process" }));
    const assertion = expect(
      api.parserGetWait({ key: "k", parser: "wordstat_n" }, { timeoutMs: 5000 }),
    ).rejects.toMatchObject({ kind: "poll_timeout" });
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("parserMassNew sends keys_list as an array", async () => {
    const { api, calls } = client(json({ status: "process", id: "345" }));
    await expect(
      api.parserMassNew({
        keys_list: ["купить квадроцикл", " квадроцикл цена "],
        name: "test",
        parser: "wordstat_qs",
        region_id: "225",
      }),
    ).resolves.toEqual({ status: "process", id: 345 });
    expect(methodOf(calls[0]?.url ?? "")).toBe("mutagen.parser.mass.new");
    expect(calls[0]?.body).toEqual({
      keys_list: ["купить квадроцикл", "квадроцикл цена"],
      name: "test",
      parser: "wordstat_qs",
      region_id: "225",
    });
  });

  it("parserMassList turns the id map into a list", async () => {
    const { api, calls } = client(
      json({
        "101": {
          name: "a",
          parser: "wordstat_qs",
          region_id: "225",
          count: "2",
          time: "1758600000",
          status: "finish",
        },
        "102": {
          name: "b",
          parser: "direct",
          region_id: 0,
          count: 1,
          time: "1758600001",
          status: "process",
        },
      }),
    );
    await expect(api.parserMassList()).resolves.toEqual([
      {
        id: 101,
        name: "a",
        parser: "wordstat_qs",
        region_id: "225",
        count: 2,
        time: 1758600000,
        status: "finish",
      },
      {
        id: 102,
        name: "b",
        parser: "direct",
        region_id: "0",
        count: 1,
        time: 1758600001,
        status: "process",
      },
    ]);
    expect(methodOf(calls[0]?.url ?? "")).toBe("mutagen.parser.mass.list");
  });

  it("parserMassList accepts an empty PHP array", async () => {
    const { api } = client(json([]));
    await expect(api.parserMassList()).resolves.toEqual([]);
  });

  it("parserMassId sends mass_id and keeps data", async () => {
    const data = { "купить квадроцикл": { frequency: 50 } };
    const { api, calls } = client(
      json({
        name: "a",
        time: 1,
        parser: "wordstat_qs",
        region_id: "225",
        count: 1,
        status: "finish",
        data,
      }),
    );
    const result = await api.parserMassId(101);
    expect(result.data).toEqual(data);
    expect(calls[0]?.body).toEqual({ mass_id: 101 });
  });

  it("waitMass polls until finish", async () => {
    vi.useFakeTimers();
    const { api, calls } = client(
      json({ status: "process", data: [] }),
      json({ status: "finish", data: { a: 1 } }),
    );
    const result = api.waitMass(5);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ status: "finish", data: { a: 1 } });
    expect(calls).toHaveLength(2);
  });

  it("waitMass stops at once on stop and points to the account", async () => {
    const { api, calls } = client(json({ status: "stop" }));
    const error = await failure(api.waitMass(5));
    expect(error).toMatchObject({ kind: "task_stopped" });
    expect(error.message).toContain("parser.mass 5");
    expect(error.hintRu).toMatch(/остановлено на стороне Мутагена.*не хватило баланса.*кабинет/);
    expect(calls).toHaveLength(1);
  });

  it("waitMass fails at once on error", async () => {
    const { api, calls } = client(json({ status: "error" }));
    expect(await failure(api.waitMass(5))).toMatchObject({ kind: "task_failed" });
    expect(calls).toHaveLength(1);
  });

  it("waitMass validates the id", async () => {
    const { api, calls } = client(json({}));
    await expect(api.waitMass(0)).rejects.toMatchObject({ kind: "validation" });
    expect(calls).toHaveLength(0);
  });
});

describe("checkKey", () => {
  it("creates a task and polls until completed", async () => {
    vi.useFakeTimers();
    const { api, calls } = client(
      json({ task_id: "9731540", status: "created" }),
      json({ task_id: "9731540", status: "processed" }),
      json(CHECK_KEY_DONE),
    );
    const result = api.checkKey("mp3");
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ key: "mp3", strong: 25 });
    expect(calls.map((call) => methodOf(call.url))).toEqual([
      "mutagen.check_key.new",
      "mutagen.check_key.get",
      "mutagen.check_key.get",
    ]);
  });

  it("fails without polling when the task is rejected at once", async () => {
    const { api, calls } = client(json({ task_id: 1, status: "rejected" }));
    const error = await failure(api.checkKey("mp3"));
    expect(error.kind).toBe("task_failed");
    expect(calls).toHaveLength(1);
  });

  it("fails when the task is rejected later", async () => {
    vi.useFakeTimers();
    const { api } = client(
      json({ task_id: 1, status: "created" }),
      json({ task_id: 1, status: "processed" }),
      json({ task_id: 1, status: "rejected" }),
    );
    const assertion = expect(api.checkKey("mp3")).rejects.toMatchObject({
      kind: "task_failed",
      message: 'check_key task 1 finished with status "rejected"',
    });
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("times out with the task id in the message", async () => {
    vi.useFakeTimers();
    const { api } = client(json({ task_id: 77, status: "processed" }));
    const assertion = expect(api.checkKey("mp3", { timeoutMs: 10_000 })).rejects.toMatchObject({
      kind: "poll_timeout",
      message: expect.stringContaining("check_key task 77"),
    });
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("can be aborted while waiting", async () => {
    vi.useFakeTimers();
    const { api } = client(json({ task_id: 77, status: "processed" }));
    const controller = new AbortController();
    const assertion = expect(
      api.checkKey("mp3", { signal: controller.signal }),
    ).rejects.toMatchObject({
      kind: "aborted",
    });
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await assertion;
  });

  it("passes a per-request timeout", async () => {
    vi.useFakeTimers();
    const { fetch } = hangingFetch();
    const api = new MutagenClient({
      apiKey: API_KEY,
      fetch,
      rateLimit: { ...FAST, maxAttempts: 1 },
    });
    const assertion = expect(api.checkKey("mp3", { requestTimeoutMs: 1000 })).rejects.toMatchObject(
      {
        kind: "timeout",
      },
    );
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
});

describe("serp.report", () => {
  it("sends a keyword report with filter, sort and limit", async () => {
    const rows = [{ keyword: "купить квадроцикл бу", region_wsqso: 120 }];
    const { api, calls } = client(json(rows));
    const params: SerpReportParams<"report_keyword_tailings"> = {
      region: "yandex_msk",
      keyword: "квадроцикл купить",
      report: "report_keyword_tailings",
      filter: [
        { column: "region_wsqso", filter_type: "gr_or_eq", val: 100 },
        { or: 1 },
        { column: "words", filter_type: "range", min: 2, max: 7 },
        { column: "has_question", filter_type: "is", val: 1 },
      ],
      sort: "-world_wsn",
      limit: 1000,
    };
    await expect(api.serpReport(params)).resolves.toEqual(rows);
    expect(methodOf(calls[0]?.url ?? "")).toBe("mutagen.serp.report");
    expect(calls[0]?.body).toEqual(params);
  });

  it("joins keywords with commas", async () => {
    const { api, calls } = client(json({ "0": { keyword: "кошки" }, "1": { keyword: "собаки" } }));
    await expect(
      api.serpReport({
        region: "yandex_msk",
        keywords: ["кошки", "собаки", "хомяки"],
        report: "report_keyword_info",
      }),
    ).resolves.toEqual([{ keyword: "кошки" }, { keyword: "собаки" }]);
    expect(calls[0]?.body).toEqual({
      region: "yandex_msk",
      keywords: "кошки,собаки,хомяки",
      report: "report_keyword_info",
    });
  });

  it("rejects 1001 keywords before any request", async () => {
    const { api, calls } = client(json([]));
    const keywords = Array.from({ length: 1001 }, (_, index) => `фраза ${index}`);
    const error = await failure(
      api.serpReport({ region: "yandex_msk", keywords, report: "report_keyword_info" }),
    );
    expect(error.kind).toBe("validation");
    expect(error.message).toContain("1001");
    expect(calls).toHaveLength(0);
  });

  it("accepts exactly 1000 keywords", async () => {
    const { api, calls } = client(json([]));
    const keywords = Array.from({ length: 1000 }, (_, index) => `фраза ${index}`);
    await api.serpReport({ region: "yandex_msk", keywords, report: "report_keyword_variations" });
    expect(calls).toHaveLength(1);
  });

  it("counts rows with count=1", async () => {
    const { api, calls } = client(json(1532), json({ count: "17" }), json("5"));
    const params = {
      region: "yandex_msk",
      keyword: "купить квадроцикл",
      report: "report_keyword_tailings",
    } as const;
    await expect(api.serpReportCount(params)).resolves.toBe(1532);
    await expect(api.serpReportCount(params)).resolves.toBe(17);
    await expect(api.serpReportCount(params)).resolves.toBe(5);
    expect(calls[0]?.body).toEqual({ ...params, count: 1 });
  });

  it("checks report and object types at compile time", () => {
    const { api } = client(json([]));
    const typeOnly = () => {
      // @ts-expect-error domain reports do not accept a keyword
      void api.serpReport({ region: "yandex_msk", report: "report_domain_info", keyword: "x" });
      // @ts-expect-error two objects at once
      void api.serpReport({
        region: "yandex_msk",
        report: "report_keywords_organic",
        domain: "a.ru",
        page: "https://a.ru/",
      });
      // @ts-expect-error unknown region
      void api.serpReport({ region: "yandex_tver", report: "report_keyword_info", keyword: "x" });
    };
    expect(typeOnly).toBeTypeOf("function");
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      "unknown report",
      { region: "yandex_msk", report: "report_nope", keyword: "x" },
      "Unknown report",
    ],
    [
      "unknown region",
      { region: "yandex_tver", report: "report_keyword_info", keyword: "x" },
      "region",
    ],
    [
      "yandex_ru domain report",
      { region: "yandex_ru", report: "report_domain_info", domain: "a.ru" },
      "yandex_ru",
    ],
    ["no object", { region: "yandex_msk", report: "report_keyword_info" }, "Exactly one"],
    [
      "two objects",
      {
        region: "yandex_msk",
        report: "report_keywords_organic",
        domain: "a.ru",
        page: "https://a.ru/",
      },
      "Exactly one",
    ],
    [
      "wrong object",
      { region: "yandex_msk", report: "report_domain_info", keyword: "x" },
      "does not accept keyword",
    ],
    [
      "keywords for tailings",
      { region: "yandex_msk", report: "report_keyword_tailings", keywords: ["a"] },
      "does not accept keywords",
    ],
    [
      "comma in phrase",
      { region: "yandex_msk", report: "report_keyword_info", keywords: ["a,b"] },
      "commas",
    ],
    [
      "empty keywords",
      { region: "yandex_msk", report: "report_keyword_info", keywords: [] },
      "non-empty array",
    ],
    [
      "blank phrase",
      { region: "yandex_msk", report: "report_keyword_info", keywords: ["a", " "] },
      "keywords[1]",
    ],
    ["blank domain", { region: "yandex_msk", report: "report_domain_info", domain: "" }, "domain"],
    [
      "bad limit",
      { region: "yandex_msk", report: "report_keyword_info", keyword: "x", limit: 0 },
      "limit",
    ],
    [
      "bad sort",
      { region: "yandex_msk", report: "report_keyword_info", keyword: "x", sort: "" },
      "sort",
    ],
    [
      "filter not array",
      { region: "yandex_msk", report: "report_keyword_info", keyword: "x", filter: {} },
      "filter must be an array",
    ],
    [
      "filter item not object",
      { region: "yandex_msk", report: "report_keyword_info", keyword: "x", filter: [1] },
      "not an object",
    ],
    [
      "bad or",
      { region: "yandex_msk", report: "report_keyword_info", keyword: "x", filter: [{ or: 2 }] },
      "or must be 1",
    ],
    [
      "no column",
      {
        region: "yandex_msk",
        report: "report_keyword_info",
        keyword: "x",
        filter: [{ filter_type: "gr", val: 1 }],
      },
      "column",
    ],
    [
      "unknown op",
      {
        region: "yandex_msk",
        report: "report_keyword_info",
        keyword: "x",
        filter: [{ column: "a", filter_type: "between", val: 1 }],
      },
      "unknown filter_type",
    ],
    [
      "range without max",
      {
        region: "yandex_msk",
        report: "report_keyword_info",
        keyword: "x",
        filter: [{ column: "a", filter_type: "range", min: 1 }],
      },
      "min and max",
    ],
    [
      "is with 2",
      {
        region: "yandex_msk",
        report: "report_keyword_info",
        keyword: "x",
        filter: [{ column: "a", filter_type: "is", val: 2 }],
      },
      "0 or 1",
    ],
    [
      "gr without val",
      {
        region: "yandex_msk",
        report: "report_keyword_info",
        keyword: "x",
        filter: [{ column: "a", filter_type: "gr" }],
      },
      "gr needs val",
    ],
    [
      "in with 1025 values",
      {
        region: "yandex_msk",
        report: "report_keyword_info",
        keyword: "x",
        filter: [
          {
            column: "a",
            filter_type: "in",
            val: Array.from({ length: 1025 }, (_, i) => i).join(","),
          },
        ],
      },
      "1024",
    ],
  ])("rejects %s before any request", async (_name, params, message) => {
    const { api, calls } = client(json([]));
    const error = await failure(api.serpReport(params as unknown as SerpReportParams));
    expect(error.kind).toBe("validation");
    expect(error.message).toContain(message);
    expect(error.hintRu).toMatch(/[а-яё]/i);
    expect(calls).toHaveLength(0);
  });

  it("allows report_keyword_questions in yandex_ru", async () => {
    const { api, calls } = client(json([]));
    await api.serpReport({ region: "yandex_ru", report: "report_keyword_questions", keyword: "x" });
    expect(calls).toHaveLength(1);
  });
});

describe("input validation", () => {
  it.each<[string, (api: MutagenClient) => Promise<unknown>, string]>([
    ["empty check key", (api) => api.checkKeyNew(" "), "key"],
    ["bad task id", (api) => api.checkKeyGet(1.5), "task_id"],
    ["bad project id", (api) => api.projectKeywords(-1), "progect_id"],
    ["bad mass id", (api) => api.parserMassId(Number.NaN), "mass_id"],
    [
      "unknown parser",
      (api) => api.parserGet({ key: "k", parser: "wordstat_x" as "wordstat_n" }),
      "parser",
    ],
    [
      "bad region",
      (api) => api.parserGet({ key: "k", parser: "wordstat_n", region_id: "225, 213" }),
      "region_id",
    ],
    [
      "numeric region",
      (api) =>
        api.parserGet({ key: "k", parser: "wordstat_n", region_id: 225 as unknown as string }),
      "region_id",
    ],
    [
      "empty mass list",
      (api) => api.parserMassNew({ keys_list: [], name: "n", parser: "wordstat_n" }),
      "keys_list",
    ],
    [
      "empty mass name",
      (api) => api.parserMassNew({ keys_list: ["a"], name: "", parser: "wordstat_n" }),
      "name",
    ],
    [
      "too many mass keys",
      (api) =>
        api.parserMassNew({
          keys_list: Array.from({ length: 50_001 }, () => "a"),
          name: "n",
          parser: "wordstat_n",
        }),
      "50000",
    ],
  ])("rejects %s before any request", async (_name, call, message) => {
    const { api, calls } = client(json({}));
    const error = await failure(call(api));
    expect(error.kind).toBe("validation");
    expect(error.message).toContain(message);
    expect(calls).toHaveLength(0);
  });
});

describe("retries through the client", () => {
  it("retries free methods on network errors", async () => {
    vi.useFakeTimers();
    const { api, calls } = client(new TypeError("fetch failed"), json({ balance: 1 }));
    const result = api.balance();
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ balance: 1 });
    expect(calls).toHaveLength(2);
  });

  it("retries paid methods on error 110", async () => {
    vi.useFakeTimers();
    const { api, calls } = client(
      json({ error_id: 110, error_msg: "MUTAGEN.RU: need timeout" }),
      json({ task_id: 1, status: "created" }),
    );
    const result = api.checkKeyNew("mp3");
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ task_id: 1, status: "created" });
    expect(calls).toHaveLength(2);
  });

  it.each<[string, (api: MutagenClient) => Promise<unknown>]>([
    ["check_key.new", (api) => api.checkKeyNew("mp3")],
    ["parser.get", (api) => api.parserGet({ key: "k", parser: "wordstat_n" })],
    [
      "parser.mass.new",
      (api) => api.parserMassNew({ keys_list: ["a"], name: "n", parser: "wordstat_n" }),
    ],
    [
      "serp.report",
      (api) =>
        api.serpReport({ region: "yandex_msk", report: "report_keyword_info", keyword: "x" }),
    ],
  ])("does not blindly repeat paid %s after a network error", async (_name, call) => {
    const { api, calls } = client(new TypeError("fetch failed"), json({}));
    const error = await failure(call(api));
    expect(error.kind).toBe("network");
    expect(calls).toHaveLength(1);
  });

  it("does not retry on 503 HTML", async () => {
    const { api, calls } = client(new Response("<html>сломалось</html>", { status: 503 }));
    const error = await failure(api.balance());
    expect(error.kind).toBe("auth_or_server");
    expect(calls).toHaveLength(1);
  });

  it("accepts a shared RateLimiter", async () => {
    const limiter = new RateLimiter({ concurrency: 1 });
    const { fetch } = stubFetch(json({ balance: 1 }));
    const api = new MutagenClient({ apiKey: API_KEY, fetch, rateLimit: limiter });
    await expect(api.balance()).resolves.toEqual({ balance: 1 });
  });
});

describe("client configuration and secrecy", () => {
  it("uses the default base URL and allows a custom one", async () => {
    const defaults = new MutagenClient({ apiKey: API_KEY });
    expect(defaults.baseUrl).toBe("http://api.mutagen.ru/json");
    const { fetch, calls } = stubFetch(json({ balance: 1 }));
    const custom = new MutagenClient({
      apiKey: API_KEY,
      fetch,
      baseUrl: "https://example.test/json/",
      timeoutMs: 1000,
    });
    await custom.balance();
    expect(calls[0]?.url).toBe(`https://example.test/json/${API_KEY}/mutagen.balance/`);
  });

  it("requires a key", () => {
    expect(() => new MutagenClient({ apiKey: "" })).toThrow(MutagenError);
  });

  it("never shows the key when serialized or inspected", () => {
    const api = new MutagenClient({ apiKey: API_KEY });
    expect(JSON.stringify(api)).not.toContain(API_KEY);
    expect(JSON.stringify(api)).toContain(REDACTED);
    expect(String(api)).not.toContain(API_KEY);
    expect(`${api}`).toBe("MutagenClient(http://api.mutagen.ru/json)");
    expect(inspect(api, { depth: 10, showHidden: true })).not.toContain(API_KEY);
    expect(Object.values(api).join(" ")).not.toContain(API_KEY);
  });

  it("never shows the key in errors that pass through the client", async () => {
    const url = `http://api.mutagen.ru/json/${API_KEY}/mutagen.balance/`;
    const { api } = client(
      new TypeError(`fetch failed ${url}`, { cause: new Error(`connect ${url}`) }),
    );
    vi.useFakeTimers();
    const assertion = failure(api.balance());
    await vi.runAllTimersAsync();
    const error = await assertion;
    for (const dump of [
      error.message,
      String(error),
      error.stack ?? "",
      JSON.stringify(error),
      inspect(error, { depth: 10 }),
    ]) {
      expect(dump).not.toContain(API_KEY);
    }
  });

  it("redacts the key in invalid response messages", async () => {
    const { api } = client(json({ wrong: API_KEY }));
    const error = await failure(api.balance());
    expect(error.message).not.toContain(API_KEY);
  });
});
