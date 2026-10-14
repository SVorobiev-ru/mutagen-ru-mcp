import { describe, expect, it } from "vitest";
import { MutagenError } from "../../src/core/errors.js";
import { Transport } from "../../src/core/transport.js";
import { FREQUENCY_PARSERS } from "../../src/core/types.js";
import { massResultTable } from "../../src/tables/lists.js";
import { wordstatKeywordsTable } from "../../src/tables/parser.js";
import { API_KEY, FIXTURE_NAMES, fixture, fixtureClient, fixtureFetch } from "./helpers.js";

async function failure(promise: Promise<unknown>): Promise<MutagenError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MutagenError);
    return error as MutagenError;
  }
  throw new Error("Expected a MutagenError");
}

describe("every live fixture", () => {
  it("covers the recorded set", () => {
    expect(FIXTURE_NAMES.length).toBeGreaterThanOrEqual(26);
  });

  it.each(FIXTURE_NAMES)("%s goes through the transport as JSON or an API error", async (name) => {
    const item = fixture(name);
    const { fetch, requests } = fixtureFetch([name]);
    const transport = new Transport({ apiKey: API_KEY, fetch });
    const params = item.params ?? undefined;
    try {
      const body = await transport.call(item.method, params);
      expect(body).toEqual(JSON.parse(item.body));
    } catch (error) {
      expect(error).toBeInstanceOf(MutagenError);
      expect((error as MutagenError).code).toBe(JSON.parse(item.body).error_id);
    }
    expect(requests).toHaveLength(1);
  });
});

describe("free methods", () => {
  it("balance: the float tail is rounded to kopecks", async () => {
    const { client } = fixtureClient("balance");
    await expect(client.balance()).resolves.toEqual({ balance: 100.6 });
  });

  it("parser.mass.list: the id dictionary becomes a list, count and time strings numbers", async () => {
    const { client } = fixtureClient("mass_list");
    await expect(client.parserMassList()).resolves.toEqual([
      {
        id: 465374,
        name: "mutagen-ru-mcp abcdef0123456789",
        parser: "wordstat_n",
        region_id: "225",
        count: 2,
        time: 1791975277,
        status: "finish",
      },
    ]);
  });

  it("parser.mass.id: string count, time and region become numbers and a frequency table", async () => {
    const { client } = fixtureClient("mass_id_fresh");
    const result = await client.parserMassId(465374);
    expect(result).toMatchObject({
      name: "mutagen-ru-mcp abcdef0123456789",
      parser: "wordstat_n",
      region_id: "225",
      count: 2,
      time: 1791975277,
      status: "finish",
    });
    const table = massResultTable(465374, result);
    expect(table.rows).toEqual([
      { phrase: "пластиковые окна", status: "finish", frequency: 1453087 },
      { phrase: "натяжной потолок цена", status: "finish", frequency: 62529 },
    ]);
  });

  it("parser.mass.id: a job without a region comes back with region_id null", async () => {
    const { client } = fixtureClient("mass_id_region_null_process");
    const result = await client.parserMassId(465382);
    expect(result).toMatchObject({
      parser: "wordstat_n",
      region_id: "0",
      count: 218,
      status: "process",
    });
    expect(result.data).toBeUndefined();
  });

  it("check_key.get: processed is a pending status with a numeric task_id", async () => {
    const { client } = fixtureClient("check_key_get");
    await expect(client.checkKeyGet(16209408)).resolves.toEqual({
      task_id: 16209408,
      status: "processed",
    });
  });
});

describe("paid methods", () => {
  it("check_key.new: a repeat of the same phrase returns the same task_id", async () => {
    const { client } = fixtureClient("check_key_new", "check_key_new_repeat");
    const first = await client.checkKeyNew("натяжной потолок цена");
    const repeat = await client.checkKeyNew("натяжной потолок цена");
    expect(first).toEqual({ task_id: 16209408, status: "created" });
    expect(repeat).toEqual({ task_id: 16209408, status: "processed" });
  });

  it("parser.mass.new: the id is a number", async () => {
    const { client } = fixtureClient("mass_new");
    await expect(
      client.parserMassNew({
        keys_list: ["пластиковые окна", "натяжной потолок цена"],
        name: "mutagen-ru-mcp abcdef0123456789",
        parser: "wordstat_n",
        region_id: "225",
      }),
    ).resolves.toEqual({ status: "process", id: 465374 });
  });

  it("parser.get: create first, then finish with the frequency", async () => {
    const { client } = fixtureClient("parser_get_n_1", "parser_get_n_2", "parser_get_n_3");
    const params = { key: "окна пвх", parser: "wordstat_n", region_id: "225" } as const;
    await expect(client.parserGet(params)).resolves.toEqual({ status: "create" });
    await expect(client.parserGet(params)).resolves.toEqual({
      status: "finish",
      data: { frequency: 143865 },
    });
    await expect(client.parserGet(params)).resolves.toMatchObject({ status: "finish" });
  });

  it.each(FREQUENCY_PARSERS.filter((parser) => parser !== "wordstat_n"))(
    "parser.get %s: the frequency is a number",
    async (parser) => {
      const name = `parser_get_${parser}`;
      const { client } = fixtureClient(name);
      const result = await client.parserGet({ key: "окна пвх", parser, region_id: "225" });
      expect(result.status).toBe("finish");
      expect(result.data?.frequency).toBe(JSON.parse(fixture(name).body).data.frequency);
    },
  );

  it("parser.get direct: still processing", async () => {
    const { client } = fixtureClient("parser_get_direct");
    await expect(
      client.parserGet({ key: "окна пвх", parser: "direct", region_id: "225" }),
    ).resolves.toEqual({ status: "process" });
  });

  it.each([
    ["wordstat_key_50", 200],
    ["wordstat_key", 2000],
  ] as const)(
    "parser.get %s: string frequencies, no right column, %i rows",
    async (parser, rows) => {
      const { client } = fixtureClient(`parser_get_${parser}`);
      const result = await client.parserGet({ key: "натяжные потолки", parser, region_id: "225" });
      expect(result.data).toMatchObject({ frequency: 1179585, count_keys: rows });
      expect(result.data?.assotiations).toBeUndefined();
      expect(result.data?.array["натяжной потолок"]).toBe(1073667);
      expect(Object.values(result.data?.array ?? {}).every(Number.isFinite)).toBe(true);
      const table = wordstatKeywordsTable({
        source: "mutagen.ru",
        dryRun: false,
        estimate: {
          totalRub: 0,
          totalKopecks: 0,
          items: [],
          quotaRequests: 0,
          requiresSubscription: false,
          unconfirmedPrices: false,
          warnings: [],
        },
        strategy: "single",
        region: "225",
        parts: [
          {
            via: "parser.get",
            parser,
            phrases: ["натяжные потолки"],
            data: { "натяжные потолки": result.data ?? null },
            fromCache: false,
          },
        ],
      });
      expect(table.rows).toHaveLength(rows);
      expect(table.columns.map((column) => column.key)).toEqual(["phrase", "frequency"]);
      expect(table.rows[0]).toEqual({ phrase: "натяжной потолок", frequency: 1073667 });
    },
  );
});

describe("errors", () => {
  it("unknown method: 108 with the Russian detail in the message and the hint", async () => {
    const { fetch } = fixtureFetch(["err_no_method"]);
    const error = await failure(
      new Transport({ apiKey: API_KEY, fetch }).call("mutagen.nonexistent"),
    );
    expect(error).toMatchObject({
      kind: "validation",
      code: 108,
      detail: "Запрошенная функция (mutagen.nonexistent) отсутствует",
    });
    expect(error.message).toContain("options error");
    expect(error.message).toContain("отсутствует");
    expect(error.hintRu).toContain("Запрошенная функция (mutagen.nonexistent) отсутствует");
  });

  it("mutagen.progects does not exist: 108", async () => {
    const { fetch } = fixtureFetch(["progects"]);
    const error = await failure(new Transport({ apiKey: API_KEY, fetch }).call("mutagen.progects"));
    expect(error).toMatchObject({ code: 108 });
    expect(error.detail).toContain("mutagen.progects");
  });

  it("parser.get without a key: 108 «слишком короткий ключ»", async () => {
    const { fetch } = fixtureFetch(["err_not_enough_params"]);
    const error = await failure(
      new Transport({ apiKey: API_KEY, fetch }).call("mutagen.parser.get", {}),
    );
    expect(error).toMatchObject({ code: 108, detail: "слишком короткий ключ, минимум 2 знака" });
    expect(error.hintRu).toContain("слишком короткий ключ");
  });

  it("unknown task and mass job: 107 not_found", async () => {
    const task = fixtureClient("err_task_not_found");
    expect(await failure(task.client.checkKeyGet(1))).toMatchObject({
      kind: "not_found",
      code: 107,
    });
    const mass = fixtureClient("err_mass_not_found");
    expect(await failure(mass.client.parserMassId(999999999))).toMatchObject({
      kind: "not_found",
      code: 107,
    });
  });

  it("serp.report without a subscription: 111 recognized by error_id, not by the text", async () => {
    const { client } = fixtureClient("serp_no_subscription");
    const error = await failure(
      client.serpReportCount({
        region: "yandex_msk",
        keyword: "купить окна",
        report: "report_keyword_info",
      }),
    );
    expect(error).toMatchObject({ kind: "subscription_required", code: 111, retryable: false });
    expect(error.message).toContain("требуется подписка");
  });
});

describe("undocumented suggest", () => {
  it("suggest.new and suggest.get answer like check_key", async () => {
    const { fetch } = fixtureFetch(["suggest_new", "suggest_get"]);
    const transport = new Transport({ apiKey: API_KEY, fetch });
    await expect(
      transport.call("mutagen.suggest.new", { key: "натяжной потолок цена" }),
    ).resolves.toEqual({ task_id: 16209409, status: "created" });
    await expect(transport.call("mutagen.suggest.get", { task_id: 16209409 })).resolves.toEqual({
      task_id: 16209409,
      status: "processed",
    });
  });
});
