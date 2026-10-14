import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestHash } from "../../src/budget/hash.js";
import { MutagenClient } from "../../src/core/client.js";
import type { FetchLike } from "../../src/core/transport.js";
import {
  type DryRunResult,
  MutagenSession,
  type MutagenSessionOptions,
  type ParserRunResult,
} from "../../src/session.js";
import { frequencyTable, wordstatKeywordsTable } from "../../src/tables/parser.js";
import { API_KEY, FAST, fixtureFetch } from "./helpers.js";

const dirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function session(
  names: string[],
  options: Partial<MutagenSessionOptions> = {},
  ignore: string[] = [],
) {
  const root = await mkdtemp(join(tmpdir(), "mutagen-contract-"));
  dirs.push(root);
  const stub = fixtureFetch(names, ignore);
  const paths = { stateDir: join(root, "state"), cacheDir: join(root, "cache") };
  const client = new MutagenClient({ apiKey: API_KEY, fetch: stub.fetch, rateLimit: FAST });
  return { api: new MutagenSession({ client, ...paths, ...options }), paths, ...stub };
}

function executed(result: ParserRunResult | DryRunResult): ParserRunResult {
  if (result.dryRun) throw new Error("Expected an executed call");
  return result;
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  const tracked = promise.finally(() => {
    done = true;
  });
  while (!done) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(1_000);
  }
  return tracked;
}

describe("session over the live answers", () => {
  it("parser.get: pays once for create, polls finish for free", async () => {
    const { api, requests } = await session(["parser_get_n_1", "parser_get_n_2"]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = executed(await settle(api.frequency(["окна пвх"], ["wordstat_n"], "225")));
    expect(result.strategy).toBe("single");
    expect(frequencyTable(result).rows).toEqual([
      { phrase: "окна пвх", wordstat_n: 143865, region: "225" },
    ]);
    expect(requests).toHaveLength(2);
    expect(api.spending().spentRub).toBe(0.02);
  });

  it("wordstat_key: 2000 rows of the left column for 0.20 RUB", async () => {
    const { api } = await session(["parser_get_wordstat_key"]);
    const result = executed(await api.wordstatKeywords("натяжные потолки", 2000, "225"));
    const table = wordstatKeywordsTable(result);
    expect(table.rows).toHaveLength(2000);
    expect(table.rows.every((row) => typeof row.frequency === "number")).toBe(true);
    expect(result.estimate.totalRub).toBe(0.2);
    expect(api.spending().spentRub).toBe(0.2);
  });

  it("mass: parser.mass.new and parser.mass.id give a frequency table", async () => {
    const { api } = await session(["mass_new", "mass_id_fresh"], { frequencyStrategy: "mass" }, [
      "name",
    ]);
    const result = executed(
      await api.frequency(["пластиковые окна", "натяжной потолок цена"], ["wordstat_n"], "225"),
    );
    expect(result.parts[0]).toMatchObject({ via: "parser.mass", massId: 465374 });
    expect(frequencyTable(result).rows).toEqual([
      { phrase: "пластиковые окна", wordstat_n: 1453087, region: "225" },
      { phrase: "натяжной потолок цена", wordstat_n: 62529, region: "225" },
    ]);
    expect(api.spending().spentRub).toBe(0.04);
  });

  it("check_key: processing ends in task_pending, the repeat only polls and pays nothing", async () => {
    const first = await session(["check_key_new", "check_key_get"], { taskTimeoutMs: 1 });
    await expect(first.api.competition(["натяжной потолок цена"])).rejects.toMatchObject({
      kind: "task_pending",
      tasks: ["check_key 16209408"],
    });
    expect(first.api.spending().spentRub).toBe(0.3);

    const repeat = fixtureFetch(["check_key_get"]);
    const api = new MutagenSession({
      client: new MutagenClient({ apiKey: API_KEY, fetch: repeat.fetch, rateLimit: FAST }),
      ...first.paths,
      taskTimeoutMs: 1,
    });
    const dry = await api.competition(["натяжной потолок цена"], { dryRun: true });
    expect(dry.estimate.items).toEqual([]);
    await expect(api.competition(["натяжной потолок цена"])).rejects.toMatchObject({
      kind: "task_pending",
    });
    expect(repeat.requests.every((request) => request.method === "mutagen.check_key.get")).toBe(
      true,
    );
    expect(api.spending().spentRub).toBe(0);
  });

  it("direct: a long task ends in task_pending after the first paid call", async () => {
    const { api } = await session(["parser_get_direct"], { taskTimeoutMs: 1 });
    await expect(api.directBids(["окна пвх"], "225")).rejects.toMatchObject({
      kind: "task_pending",
      tasks: ["parser.get direct «окна пвх»"],
    });
    expect(api.spending().spentRub).toBe(0.02);
  });

  it("mass: a lost parser.mass.new answer is found in parser.mass.list by the task name", async () => {
    const keys = ["пластиковые окна", "натяжной потолок цена"];
    const hash = requestHash("parser.mass.new", {
      keys_list: [...keys].sort(),
      parser: "wordstat_n",
      region_id: "225",
    });
    const stub = fixtureFetch(["mass_list", "mass_id_fresh"]);
    let created = 0;
    const fetch: FetchLike = async (url, init) => {
      if (url.includes("parser.mass.new")) {
        created += 1;
        throw new TypeError("fetch failed");
      }
      const response = await stub.fetch(url, init);
      const body = (await response.text()).replaceAll("abcdef0123456789", hash.slice(0, 16));
      return new Response(body, { status: response.status, headers: response.headers });
    };
    const root = await mkdtemp(join(tmpdir(), "mutagen-contract-"));
    dirs.push(root);
    const api = new MutagenSession({
      client: new MutagenClient({ apiKey: API_KEY, fetch, rateLimit: FAST }),
      stateDir: join(root, "state"),
      cacheDir: join(root, "cache"),
      frequencyStrategy: "mass",
      now: () => 1791975277 * 1000,
    });
    await expect(api.frequency(keys, ["wordstat_n"], "225")).rejects.toMatchObject({
      kind: "network",
    });
    const result = executed(await api.frequency(keys, ["wordstat_n"], "225"));
    expect(created).toBe(1);
    expect(result.parts[0]).toMatchObject({ massId: 465374, reusedTask: true });
    expect(frequencyTable(result).rows).toHaveLength(2);
    expect(stub.requests.map((request) => request.method)).toEqual([
      "mutagen.parser.mass.list",
      "mutagen.parser.mass.id",
    ]);
    expect(api.spending().spentRub).toBe(0.04);
  });
});
