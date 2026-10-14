import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetError } from "../../src/budget/guard.js";
import { requestHash } from "../../src/budget/hash.js";
import { loadConfig } from "../../src/config.js";
import { MutagenClient } from "../../src/core/client.js";
import { MutagenError, type TaskPendingError } from "../../src/core/errors.js";
import { RateLimiter } from "../../src/core/rate-limit.js";
import type { FetchLike } from "../../src/core/transport.js";
import {
  type DryRunResult,
  MutagenSession,
  type MutagenSessionOptions,
  type ParserRunResult,
} from "../../src/session.js";
import { API_KEY, json, methodOf, type RecordedCall } from "./core/helpers.js";
import { router as asyncRouter } from "./mcp/helpers.js";

const FAST = { concurrency: 10, perSecond: 1000 };
const dirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Handler = (call: RecordedCall) => Response | Error;

function router(handlers: Record<string, Handler | Handler[]>) {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: RecordedCall = {
      url,
      method: init.method ?? "GET",
      headers: {},
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    const method = methodOf(url).replace(/^mutagen\./, "");
    const entry = handlers[method];
    const handler = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
    if (!handler) throw new Error(`Unexpected call ${method}`);
    const reply = handler(call);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const count = (method: string) =>
    calls.filter((call) => methodOf(call.url) === `mutagen.${method}`).length;
  return { fetch, calls, count };
}

async function dirsFor() {
  const root = await mkdtemp(join(tmpdir(), "mutagen-session-"));
  dirs.push(root);
  return { root, stateDir: join(root, "state"), cacheDir: join(root, "cache") };
}

async function session(
  handlers: Record<string, Handler | Handler[]>,
  options: Partial<MutagenSessionOptions> = {},
) {
  const stub = router(handlers);
  const paths = await dirsFor();
  const client = new MutagenClient({ apiKey: API_KEY, fetch: stub.fetch, rateLimit: FAST });
  const api = new MutagenSession({ client, ...paths, frequencyStrategy: "mass", ...options });
  return { api, ...stub, ...paths };
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

async function refusal(promise: Promise<unknown>): Promise<BudgetError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BudgetError);
    return error as BudgetError;
  }
  throw new Error("Expected a BudgetError");
}

async function filesUnder(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir, { recursive: true, withFileTypes: true });
    return names.filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name));
  } catch {
    return [];
  }
}

const phrases = (n: number) => Array.from({ length: n }, (_, i) => `фраза ${i + 1}`);
const massNew = () => json({ id: 501, status: "process" });
const massDone = () => json({ status: "finish", count: 2, data: [{ key: "a", frequency: 5 }] });
const lowBalance = () => json({ error_id: 106, error_msg: "MUTAGEN.RU: Low balance" });
const checkDone = (call: RecordedCall) =>
  json({
    status: "completed",
    key: `task ${(call.body as { task_id: number }).task_id}`,
    strong: 12,
    wordstat: 100,
    vital: "",
    vital_site: "",
  });

function executed(result: ParserRunResult | DryRunResult): ParserRunResult {
  if (result.dryRun) throw new Error("Expected an executed call");
  return result;
}

describe("MutagenSession free calls", () => {
  it("never caches balance", async () => {
    const { api, count, cacheDir } = await session({ balance: () => json({ balance: "250.4" }) });
    await expect(api.balance()).resolves.toEqual({ source: "mutagen.ru", balance: 250.4 });
    await api.balance();
    expect(count("balance")).toBe(2);
    expect(await filesUnder(cacheDir)).toEqual([]);
  });

  it("returns live project keywords and mass lists", async () => {
    const { api, count } = await session({
      "progect.keywords": () => json([{ keyword: "k", claster_id: null }]),
      "parser.mass.list": () => json({ "5": { name: "n", status: "finish" } }),
    });
    expect("projects" in api).toBe(false);
    expect(await api.projectKeywords(1)).toMatchObject({ source: "mutagen.ru", progectId: 1 });
    await api.massTasks();
    await api.massTasks();
    expect(count("parser.mass.list")).toBe(2);
  });

  it("caches only finished mass results", async () => {
    const { api, count } = await session({
      "parser.mass.id": [() => json({ status: "process" }), massDone],
    });
    expect((await api.massResult(9)).result.status).toBe("process");
    expect((await api.massResult(9, { wait: true })).fromCache).toBe(false);
    const cached = await api.massResult(9);
    expect(cached).toMatchObject({ fromCache: true, massId: 9, source: "mutagen.ru" });
    expect(count("parser.mass.id")).toBe(2);
  });
});

describe("MutagenSession spend protection", () => {
  it("free-only refuses paid calls before any request", async () => {
    const { api, calls } = await session({}, { freeOnly: true });
    const error = await refusal(api.frequency(["окна"], ["wordstat_n"]));
    expect(error.kind).toBe("free_only");
    await refusal(api.competition(["окна"]));
    expect(calls).toHaveLength(0);
  });

  it("refuses plans over the session budget", async () => {
    const { api, calls } = await session({}, { budgetRub: 1, autoApproveRub: 5 });
    const error = await refusal(api.frequency(phrases(51), ["wordstat_n"]));
    expect(error.kind).toBe("over_budget");
    expect(calls).toHaveLength(0);
  });

  it("dry run returns the estimate without calling the API", async () => {
    const { api, calls } = await session({});
    const result = await api.frequency(
      phrases(1000),
      ["wordstat_n", "wordstat_q", "wordstat_qs"],
      "225",
      {
        dryRun: true,
      },
    );
    expect(result).toMatchObject({
      dryRun: true,
      source: "mutagen.ru",
      estimate: { totalRub: 60 },
    });
    expect(calls).toHaveLength(0);
  });

  it("asks for confirmation and runs with the token", async () => {
    const { api, count } = await session({
      "parser.mass.new": massNew,
      "parser.mass.id": massDone,
    });
    const list = phrases(100);
    const error = await refusal(api.frequency(list, ["wordstat_n"]));
    expect(error.kind).toBe("needs_confirmation");
    expect(error.estimate.totalRub).toBe(2);
    expect(count("parser.mass.new")).toBe(0);

    const result = executed(
      await api.frequency(list, ["wordstat_n"], undefined, {
        confirmToken: error.confirmToken ?? "",
      }),
    );
    expect(result.parts[0]).toMatchObject({ via: "parser.mass", massId: 501, fromCache: false });
    expect(api.spending()).toMatchObject({ spentRub: 2, reservedRub: 0, remainingRub: 48 });
    expect(count("parser.mass.new")).toBe(1);
  });

  it("rejects a token issued for another plan with the same price", async () => {
    const { api, calls } = await session({});
    const error = await refusal(api.frequency(phrases(100), ["wordstat_n"]));
    const otherList = phrases(100).map((phrase) => `${phrase} купить`);
    const other = await refusal(
      api.frequency(otherList, ["wordstat_n"], undefined, {
        confirmToken: error.confirmToken ?? "",
      }),
    );
    expect(other.estimate.totalRub).toBe(error.estimate.totalRub);
    expect(other.kind).toBe("needs_confirmation");
    expect(other.message).toMatch(/another plan/);
    expect(calls).toHaveLength(0);
  });

  it("releases the reserve when the API refuses with 106", async () => {
    const { api, count } = await session({ "parser.mass.new": lowBalance });
    const failure = api.frequency(["окна"], ["wordstat_n"]);
    await expect(failure).rejects.toMatchObject({ code: 106, kind: "balance" });
    expect(api.spending()).toMatchObject({ spentRub: 0, reservedRub: 0, remainingRub: 50 });
    expect(api.spending().calls[0]).toMatchObject({ status: "failed", spentRub: 0 });
    const statuses = (await api.ledger.entries()).map((entry) => entry.status);
    expect(statuses).toEqual(["requested", "failed"]);
    expect(count("parser.mass.new")).toBe(1);
  });

  it("checks the balance before plans above 5 RUB", async () => {
    const { api, calls } = await session(
      {
        balance: () => json({ balance: 2 }),
        "parser.mass.new": massNew,
      },
      { autoApproveRub: 100 },
    );
    const error = await refusal(api.frequency(phrases(300), ["wordstat_n"]));
    expect(error.kind).toBe("low_balance");
    expect(calls.map((call) => methodOf(call.url))).toEqual(["mutagen.balance"]);
  });

  it("does not check the balance for small plans", async () => {
    const { api, count } = await session({
      "parser.mass.new": massNew,
      "parser.mass.id": massDone,
    });
    await api.frequency(phrases(10), ["wordstat_n"]);
    expect(count("balance")).toBe(0);
  });
});

describe("MutagenSession task reuse and cache", () => {
  it("answers task_pending after the wait limit and reuses the mass_id for free", async () => {
    let ready = false;
    const { api, count } = await session(
      {
        "parser.mass.new": massNew,
        "parser.mass.id": () => (ready ? massDone() : json({ status: "process" })),
      },
      { massTimeoutMs: 1 },
    );
    await expect(api.frequency(["окна", "двери"], ["wordstat_qs"])).rejects.toMatchObject({
      kind: "task_pending",
      tasks: ["parser.mass 501"],
    });
    ready = true;
    expect(api.spending().spentRub).toBe(0.04);

    const estimate = await api.frequency(["окна", "двери"], ["wordstat_qs"], undefined, {
      dryRun: true,
    });
    expect(estimate.estimate.totalRub).toBe(0);

    const result = executed(await api.frequency(["окна", "двери"], ["wordstat_qs"]));
    expect(result.parts[0]).toMatchObject({ massId: 501, reusedTask: true });
    expect(count("parser.mass.new")).toBe(1);
    expect(api.spending().spentRub).toBe(0.04);
  });

  it("finds a mass task created before a lost response", async () => {
    let name = "";
    const { api, count } = await session({
      "parser.mass.new": [
        (call) => {
          name = (call.body as { name: string }).name;
          return new TypeError("fetch failed");
        },
        massNew,
      ],
      "parser.mass.list": () =>
        json({ "777": { name, status: "process", time: Math.floor(Date.now() / 1000) } }),
      "parser.mass.id": massDone,
    });
    await expect(api.frequency(["окна"], ["wordstat_n"])).rejects.toMatchObject({
      kind: "network",
    });
    expect(api.spending().spentRub).toBe(0.02);
    const result = executed(await api.frequency(["окна"], ["wordstat_n"]));
    expect(result.parts[0]).toMatchObject({ massId: 777, reusedTask: true });
    expect(count("parser.mass.new")).toBe(1);
  });

  it("creates a new task if the lost one is not in the list", async () => {
    const { api, count } = await session({
      "parser.mass.new": [() => new TypeError("fetch failed"), massNew],
      "parser.mass.list": () => json({}),
      "parser.mass.id": massDone,
    });
    await expect(api.frequency(["окна"], ["wordstat_n"])).rejects.toThrow(MutagenError);
    const result = executed(await api.frequency(["окна"], ["wordstat_n"]));
    expect(result.parts[0]).toMatchObject({ massId: 501, reusedTask: false });
    expect(count("parser.mass.new")).toBe(2);
  });

  it("does not reuse a failed task and serves repeats from cache", async () => {
    const { api, count } = await session({
      "parser.mass.new": massNew,
      "parser.mass.id": [() => json({ status: "error" }), massDone],
    });
    await expect(api.frequency(["окна"], ["wordstat_n"])).rejects.toMatchObject({
      kind: "task_failed",
    });
    executed(await api.frequency(["окна"], ["wordstat_n"]));
    expect(count("parser.mass.new")).toBe(2);
    const cached = executed(await api.frequency(["окна"], ["wordstat_n"]));
    expect(cached.parts[0]).toMatchObject({ fromCache: true, massId: 501 });
    expect(count("parser.mass.new")).toBe(2);
    expect(count("parser.mass.id")).toBe(2);
    const fresh = executed(
      await api.frequency(["окна"], ["wordstat_n"], undefined, { forceRefresh: true }),
    );
    expect(fresh.parts[0]?.fromCache).toBe(false);
    expect(count("parser.mass.new")).toBe(3);
  });

  it("expires cached results but reuses the task for 7 days", async () => {
    let now = Date.parse("2026-10-14T10:00:00Z");
    const { api, count } = await session(
      { "parser.mass.new": massNew, "parser.mass.id": massDone },
      { now: () => now, cacheTtlDays: { frequency: 1 } },
    );
    await api.frequency(["окна"], ["wordstat_n"]);
    await api.frequency(["окна"], ["wordstat_n"]);
    expect(count("parser.mass.id")).toBe(1);
    now += 2 * 24 * 60 * 60_000;
    const reused = executed(await api.frequency(["окна"], ["wordstat_n"]));
    expect(reused.parts[0]).toMatchObject({ fromCache: false, reusedTask: true, massId: 501 });
    expect(count("parser.mass.new")).toBe(1);
    expect(count("parser.mass.id")).toBe(2);
    now += 6 * 24 * 60 * 60_000;
    await api.frequency(["окна"], ["wordstat_n"]);
    expect(count("parser.mass.new")).toBe(2);
  });

  it("pays parser.get once per phrase and polls for free in single strategy", async () => {
    const { api, count } = await session(
      {
        "parser.get": [
          () => json({ status: "create" }),
          () => json({ status: "process" }),
          () => json({ status: "finish", data: { frequency: 42 } }),
        ],
      },
      { frequencyStrategy: "single" },
    );
    const dry = await api.frequency(["окна", "двери"], ["wordstat_n"], undefined, { dryRun: true });
    expect(dry.estimate.totalRub).toBe(0.04);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = executed(await settle(api.frequency(["окна", "двери"], ["wordstat_n"])));
    expect(result.strategy).toBe("single");
    expect(result.parts[0]).toMatchObject({
      via: "parser.get",
      data: { окна: { frequency: 42 }, двери: { frequency: 42 } },
    });
    expect(count("parser.get")).toBeGreaterThanOrEqual(3);
    expect(api.spending()).toMatchObject({ spentRub: 0.04, reservedRub: 0 });
    const again = executed(await api.frequency(["окна", "двери"], ["wordstat_n"]));
    expect(again.parts[0]?.fromCache).toBe(true);
  });

  it("uses single strategy by default for up to 10 phrases", async () => {
    const stub = router({ "parser.get": () => json({ status: "finish", data: { frequency: 7 } }) });
    const api = new MutagenSession({
      client: new MutagenClient({ apiKey: API_KEY, fetch: stub.fetch, rateLimit: FAST }),
      ...(await dirsFor()),
    });
    const { count } = stub;
    expect(api.frequencyStrategy).toBe("single");
    const result = executed(await api.frequency(["окна"], ["wordstat_n", "wordstat_qs"]));
    expect(result.strategy).toBe("single");
    expect(count("parser.get")).toBe(2);
    expect(api.spending().spentRub).toBe(0.04);
  });

  it("charges a first answer finish (Mutagen cache) conservatively", async () => {
    const { api } = await session(
      { "parser.get": () => json({ status: "finish", data: { frequency: 5 } }) },
      { frequencyStrategy: "single" },
    );
    executed(await api.frequency(["окна"], ["wordstat_n"]));
    expect(api.spending().spentRub).toBe(0.02);
    expect((await api.ledger.entries()).at(-1)).toMatchObject({
      status: "done",
      chargedRub: 0.02,
    });
  });

  it("answers task_pending after the wait limit and does not pay for the repeat", async () => {
    let ready = false;
    const { api, count } = await session(
      {
        "parser.get": [
          () => json({ status: "create" }),
          () =>
            ready
              ? json({ status: "finish", data: { frequency: 9 } })
              : json({ status: "process" }),
        ],
      },
      { frequencyStrategy: "single", taskTimeoutMs: 1 },
    );
    await expect(api.directBids(["окна"])).rejects.toMatchObject({
      kind: "task_pending",
      tasks: ["parser.get direct «окна»"],
    });
    expect(api.spending().spentRub).toBe(0.02);
    expect((await api.ledger.entries()).at(-1)).toMatchObject({
      status: "created",
      chargedRub: 0.02,
    });
    const dry = await api.directBids(["окна"], undefined, { dryRun: true });
    expect(dry.estimate.totalRub).toBe(0);
    ready = true;
    const result = executed(await api.directBids(["окна"]));
    expect(result.parts[0]).toMatchObject({ data: { окна: { frequency: 9 } } });
    expect(api.spending().spentRub).toBe(0.02);
    expect(count("parser.get")).toBeGreaterThanOrEqual(2);
  });

  it("charges a pending phrase again only when Mutagen answers create", async () => {
    let answer = "create";
    const { api } = await session(
      {
        "parser.get": () => {
          const status = answer;
          answer = "process";
          return json({ status });
        },
      },
      { frequencyStrategy: "single", taskTimeoutMs: 1 },
    );
    const run = () =>
      expect(api.frequency(["окна"], ["wordstat_n"])).rejects.toMatchObject({
        kind: "task_pending",
      });
    await run();
    await run();
    expect(api.spending().spentRub).toBe(0.02);
    answer = "create";
    await run();
    expect(api.spending().spentRub).toBe(0.04);
  });

  it("polls a paid pending parser.get in free-only mode, but refuses a new phrase", async () => {
    const first = await session(
      { "parser.get": () => json({ status: "create" }) },
      { frequencyStrategy: "single", taskTimeoutMs: 1 },
    );
    await expect(first.api.frequency(["окна"], ["wordstat_n"])).rejects.toMatchObject({
      kind: "task_pending",
    });
    const stub = router({ "parser.get": () => json({ status: "finish", data: { frequency: 7 } }) });
    const api = new MutagenSession({
      client: new MutagenClient({ apiKey: API_KEY, fetch: stub.fetch, rateLimit: FAST }),
      stateDir: first.stateDir,
      cacheDir: first.cacheDir,
      freeOnly: true,
    });
    const result = await api.frequency(["окна"], ["wordstat_n"]);
    expect(result).toMatchObject({ dryRun: false, parts: [{ data: { окна: { frequency: 7 } } }] });
    expect(api.spending().spentRub).toBe(0);
    expect((await refusal(api.frequency(["двери"], ["wordstat_n"]))).kind).toBe("free_only");
    expect(stub.calls).toHaveLength(1);
  });

  it("does not charge parser.get refused by the API", async () => {
    const { api } = await session({ "parser.get": lowBalance }, { frequencyStrategy: "single" });
    await expect(api.frequency(["окна"], ["wordstat_n"])).rejects.toMatchObject({ code: 106 });
    expect(api.spending().spentRub).toBe(0);
  });

  it("switches single strategy to mass above 10 phrases", async () => {
    const { api, count } = await session(
      { "parser.mass.new": massNew, "parser.mass.id": massDone },
      { frequencyStrategy: "single" },
    );
    const result = executed(await api.frequency(phrases(11), ["wordstat_n"]));
    expect(result.strategy).toBe("mass");
    expect(count("parser.mass.new")).toBe(1);
  });

  it("maps wordstat depth to parser types and prices", async () => {
    const { api, calls } = await session({
      "parser.mass.new": massNew,
      "parser.mass.id": massDone,
    });
    const dry = await api.wordstatKeywords("окна", 2000, "225", { dryRun: true });
    expect(dry.estimate).toMatchObject({ totalRub: 0.2, unconfirmedPrices: false });
    const result = executed(await api.wordstatKeywords("окна", 2000, "225"));
    expect(result.parts[0]?.parser).toBe("wordstat_key");
    expect(result.estimate.totalRub).toBe(0.2);
    const small = executed(await api.wordstatKeywords("окна"));
    expect(small.estimate.totalRub).toBe(0.02);
    expect(
      calls
        .filter((c) => methodOf(c.url) === "mutagen.parser.mass.new")
        .map((c) => (c.body as { parser: string }).parser),
    ).toEqual(["wordstat_key", "wordstat_key_50"]);
  });

  it("validates parser types", async () => {
    const { api } = await session({});
    await expect(api.frequency(["окна"], [])).rejects.toThrow(/parser type/);
  });
});

describe("MutagenSession competition", () => {
  it("charges new phrases and treats checks within 7 days as free", async () => {
    let task = 0;
    const { api, count } = await session(
      {
        "check_key.new": () => json({ task_id: ++task, status: "created" }),
        "check_key.get": checkDone,
      },
      { noCache: true },
    );
    const first = await api.competition(["окна", "окна", "двери"]);
    if (first.dryRun) throw new Error("unexpected dry run");
    expect(first.estimate.totalRub).toBe(0.6);
    expect(first.results.map((row) => row.phrase)).toEqual(["окна", "двери"]);
    expect(api.spending().spentRub).toBe(0.6);

    const dry = await api.competition(["окна", "крыши"], { dryRun: true });
    expect(dry.estimate.items[0]).toMatchObject({ units: 2, billableUnits: 1 });
    expect(dry.estimate.totalRub).toBe(0.3);
    const second = await api.competition(["окна", "крыши"]);
    if (second.dryRun) throw new Error("unexpected dry run");
    expect(second.results[0]).toMatchObject({ reusedTask: true });
    expect(count("check_key.new")).toBe(3);
    expect(api.spending().spentRub).toBe(0.9);
  });

  it("creates a free repeat when the old task is gone", async () => {
    const { api, count } = await session(
      {
        "check_key.new": () => json({ task_id: 5, status: "created" }),
        "check_key.get": [
          checkDone,
          () => json({ error_id: 107, error_msg: "task_id not found" }),
          checkDone,
        ],
      },
      { noCache: true },
    );
    await api.competition(["окна"]);
    await api.competition(["окна"]);
    expect(count("check_key.new")).toBe(2);
    expect(api.spending().spentRub).toBe(0.3);
  });

  it("serves cached competition and records rejected tasks", async () => {
    const { api, count } = await session({
      "check_key.new": [
        () => json({ task_id: 1, status: "created" }),
        () => json({ task_id: 2, status: "rejected" }),
        () => json({ error_id: 116, error_msg: "invalid item" }),
      ],
      "check_key.get": checkDone,
    });
    await api.competition(["окна"]);
    const cached = await api.competition(["окна"]);
    if (cached.dryRun) throw new Error("unexpected dry run");
    expect(cached.results[0]?.fromCache).toBe(true);
    expect(cached.estimate.totalRub).toBe(0);
    await expect(api.competition(["двери"])).rejects.toMatchObject({ kind: "task_failed" });
    await expect(api.competition(["крыши"])).rejects.toMatchObject({ code: 116 });
    expect(count("check_key.new")).toBe(3);
    expect(api.spending().spentRub).toBe(0.6);
  });
});

describe("MutagenSession reuse windows", () => {
  it("counts the reuse and free-repeat windows from the paid task", async () => {
    let now = Date.parse("2026-10-01T10:00:00Z");
    let task = 0;
    const { api, count } = await session(
      {
        "parser.mass.new": massNew,
        "parser.mass.id": massDone,
        "check_key.new": () => json({ task_id: ++task, status: "created" }),
        "check_key.get": checkDone,
      },
      { now: () => now, noCache: true },
    );
    await api.frequency(["окна"], ["wordstat_n"]);
    await api.competition(["окна"]);
    now += 5 * 24 * 60 * 60_000;
    await api.frequency(["окна"], ["wordstat_n"]);
    await api.competition(["окна"]);
    expect(count("parser.mass.new")).toBe(1);
    expect(count("check_key.new")).toBe(1);
    now += 3 * 24 * 60 * 60_000;
    const dry = await api.competition(["окна"], { dryRun: true });
    expect(dry.estimate.totalRub).toBe(0.3);
    await api.frequency(["окна"], ["wordstat_n"]);
    await api.competition(["окна"]);
    expect(count("parser.mass.new")).toBe(2);
    expect(count("check_key.new")).toBe(2);
    expect(api.spending().spentRub).toBe(0.64);
  });
});

describe("MutagenSession serp reports", () => {
  it("counts subscription quota, caches reports and logs them", async () => {
    const { api, count } = await session({
      "serp.report": () => json([{ keyword: "окна", region_wsn: 10 }]),
    });
    const params = {
      region: "yandex_msk",
      report: "report_keyword_info",
      keyword: "окна",
    } as const;
    const dry = await api.serpReport(params, { dryRun: true });
    expect(dry.estimate).toMatchObject({
      totalRub: 0,
      quotaRequests: 1,
      requiresSubscription: true,
    });
    const first = await api.serpReport(params);
    const second = await api.serpReport(params);
    expect(first).toMatchObject({ fromCache: false, rows: [{ keyword: "окна" }] });
    expect(second).toMatchObject({ fromCache: true });
    expect(count("serp.report")).toBe(1);
    expect(api.spending().quotaRequests).toBe(1);
  });

  it("propagates subscription errors", async () => {
    const { api } = await session({
      "serp.report": () => json({ error_id: 111, error_msg: "subscription required" }),
    });
    await expect(
      api.serpReport({ region: "yandex_msk", report: "report_keyword_info", keyword: "окна" }),
    ).rejects.toMatchObject({ code: 111 });
    expect(api.spending().calls[0]).toMatchObject({ status: "failed" });
  });
});

describe("MutagenSession configuration and secrets", () => {
  it("requires an API key", () => {
    const config = loadConfig({}, { platform: "linux", homedir: "/home/u" });
    expect(() => MutagenSession.fromConfig(config)).toThrow(/MUTAGEN_API_KEY/);
  });

  it("builds an offline session that never reaches the API", async () => {
    const config = loadConfig(
      { MUTAGEN_BUDGET_RUB: "3" },
      { platform: "linux", homedir: "/home/u" },
    );
    const fetch = vi.fn<FetchLike>();
    const api = MutagenSession.offline(config, { fetch, freeOnly: true });
    expect(api.spending()).toMatchObject({ budgetRub: 3, freeOnly: true });
    expect(() => api.client).toThrow(expect.objectContaining({ kind: "auth" }));
    await expect(api.balance()).rejects.toMatchObject({ kind: "auth" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never writes the API key to the ledger, cache or config JSON", async () => {
    const paths = await dirsFor();
    const config = loadConfig(
      {
        MUTAGEN_API_KEY: API_KEY,
        MUTAGEN_STATE_DIR: paths.stateDir,
        MUTAGEN_CACHE_DIR: paths.cacheDir,
        MUTAGEN_PRICES_JSON: '{"parser.wordstat_n":0.03}',
      },
      { platform: "linux", homedir: "/home/u" },
    );
    let task = 0;
    const stub = router({
      "parser.mass.new": massNew,
      "parser.mass.id": massDone,
      "check_key.new": () => json({ task_id: ++task, status: "created" }),
      "check_key.get": checkDone,
      "serp.report": () => json([{ a: 1 }]),
    });
    const api = MutagenSession.fromConfig(config, {
      fetch: stub.fetch,
      rateLimit: FAST,
      frequencyStrategy: "mass",
    });
    expect(stub.calls).toHaveLength(0);
    const result = executed(await api.frequency(["окна"], ["wordstat_n"]));
    expect(result.estimate.totalRub).toBe(0.03);
    await api.competition(["окна"]);
    await api.serpReport({ region: "yandex_msk", report: "report_keyword_info", keyword: "окна" });
    expect(stub.calls[0]?.url).toContain(API_KEY);

    const files = [...(await filesUnder(paths.stateDir)), ...(await filesUnder(paths.cacheDir))];
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      expect(await readFile(file, "utf8")).not.toContain(API_KEY);
    }
    expect(JSON.stringify(config)).not.toContain(API_KEY);
    expect(JSON.stringify(api.spending())).not.toContain(API_KEY);
  });
});

const serpParams = {
  region: "yandex_msk",
  report: "report_keyword_info",
  keyword: "окна",
} as const;

describe("MutagenSession free-only by method", () => {
  it("refuses a free check_key repeat before any request", async () => {
    let task = 0;
    const first = await session(
      {
        "check_key.new": () => json({ task_id: ++task, status: "created" }),
        "check_key.get": checkDone,
      },
      { noCache: true },
    );
    await first.api.competition(["окна"]);
    const stub = router({
      "check_key.get": () => json({ error_id: 107, error_msg: "task_id not found" }),
      "check_key.new": () => json({ task_id: 9, status: "created" }),
    });
    const api = new MutagenSession({
      client: new MutagenClient({ apiKey: API_KEY, fetch: stub.fetch, rateLimit: FAST }),
      stateDir: first.stateDir,
      cacheDir: first.cacheDir,
      noCache: true,
      freeOnly: true,
    });
    const dry = await api.competition(["окна"], { dryRun: true });
    expect(dry.estimate.totalRub).toBe(0);
    const error = await refusal(api.competition(["окна"]));
    expect(error.kind).toBe("free_only");
    expect(stub.calls).toHaveLength(0);
  });

  it("refuses paid methods priced at zero in both strategies", async () => {
    const prices = { "parser.wordstat_n": 0 };
    const mass = await session({}, { freeOnly: true, prices });
    expect((await refusal(mass.api.frequency(["окна"], ["wordstat_n"]))).kind).toBe("free_only");
    const single = await session({}, { freeOnly: true, prices, frequencyStrategy: "single" });
    expect((await refusal(single.api.frequency(["окна"], ["wordstat_n"]))).kind).toBe("free_only");
    expect([...mass.calls, ...single.calls]).toHaveLength(0);
  });

  it("allows serp reports in free-only mode", async () => {
    const { api, count } = await session(
      { "serp.report": () => json([{ a: 1 }]) },
      { freeOnly: true },
    );
    await api.serpReport(serpParams);
    expect(count("serp.report")).toBe(1);
  });

  it("validates numeric options", async () => {
    const paths = await dirsFor();
    const client = new MutagenClient({ apiKey: API_KEY, fetch: router({}).fetch });
    const make = (options: Partial<MutagenSessionOptions>) => () =>
      new MutagenSession({ client, ...paths, ...options });
    expect(make({ taskTimeoutMs: 0 })).toThrow(/taskTimeoutMs/);
    expect(make({ massTimeoutMs: Number.POSITIVE_INFINITY })).toThrow(/massTimeoutMs/);
    expect(make({ tokenTtlMs: -1 })).toThrow(/tokenTtlMs/);
    expect(make({ budgetRub: -1 })).toThrow(MutagenError);
  });
});

describe("MutagenSession single strategy results", () => {
  it("finishes parser.get without data as an empty result and pays once", async () => {
    const { api, count } = await session(
      { "parser.get": () => json({ status: "finish", data: [] }) },
      { frequencyStrategy: "single" },
    );
    const result = executed(await api.frequency(["окна"], ["wordstat_n"]));
    expect(result.parts[0]).toMatchObject({ via: "parser.get", data: { окна: null } });
    expect(count("parser.get")).toBe(1);
    expect(api.spending().spentRub).toBe(0.02);
    const again = executed(await api.frequency(["окна"], ["wordstat_n"]));
    expect(again.parts[0]).toMatchObject({ fromCache: true, data: { окна: null } });
    expect(count("parser.get")).toBe(1);
  });

  it("keeps paid phrases when a later phrase fails", async () => {
    let failB = true;
    const { api, calls } = await session(
      {
        "parser.get": (call) =>
          (call.body as { key: string }).key === "b" && failB
            ? json({ error_id: 108, error_msg: "options error" })
            : json({ status: "finish", data: { frequency: 1 } }),
      },
      { frequencyStrategy: "single" },
    );
    await expect(api.frequency(["a", "b"], ["wordstat_n"])).rejects.toMatchObject({ code: 108 });
    failB = false;
    const dry = await api.frequency(["a", "b"], ["wordstat_n"], undefined, { dryRun: true });
    expect(dry.estimate.totalRub).toBe(0.02);
    const result = executed(await api.frequency(["b", "a"], ["wordstat_n"]));
    const part = result.parts[0];
    expect(part).toMatchObject({ phrases: ["b", "a"] });
    expect(part?.via === "parser.get" && Object.keys(part.data)).toEqual(["b", "a"]);
    const keys = calls.map((call) => (call.body as { key: string }).key);
    expect(keys.filter((key) => key === "a")).toHaveLength(1);
    expect(api.spending().spentRub).toBe(0.04);
  });
});

describe("MutagenSession identical requests", () => {
  it("runs identical parallel calls once", async () => {
    let id = 500;
    const { api, count } = await session({
      "parser.mass.new": () => json({ id: ++id, status: "process" }),
      "parser.mass.id": massDone,
      "check_key.new": () => json({ task_id: 1, status: "created" }),
      "check_key.get": checkDone,
      "serp.report": () => json([{ a: 1 }]),
    });
    const [a, b] = await Promise.all([
      api.frequency(["a"], ["wordstat_n"]),
      api.frequency(["a"], ["wordstat_n"]),
    ]);
    expect(count("parser.mass.new")).toBe(1);
    expect(api.spending()).toMatchObject({ spentRub: 0.02, reservedRub: 0 });
    expect(executed(a).parts[0]).toMatchObject({ massId: 501 });
    expect(executed(b).parts[0]).toMatchObject({ massId: 501 });

    await Promise.all([api.competition(["x"]), api.competition(["x"])]);
    expect(count("check_key.new")).toBe(1);
    expect(api.spending().spentRub).toBe(0.32);

    await Promise.all([api.serpReport(serpParams), api.serpReport(serpParams)]);
    expect(count("serp.report")).toBe(1);
  });

  it("ignores phrase order for the cache and keeps it in the result", async () => {
    const { api, count } = await session({
      "parser.mass.new": massNew,
      "parser.mass.id": massDone,
    });
    await api.frequency(["окна", "двери"], ["wordstat_n"]);
    const again = executed(await api.frequency(["двери", "окна"], ["wordstat_n"]));
    expect(again.parts[0]).toMatchObject({ fromCache: true, phrases: ["двери", "окна"] });
    expect(count("parser.mass.new")).toBe(1);
  });
});

describe("MutagenSession stopped and lost mass tasks", () => {
  it("keeps a stopped task and polls it again even with forceRefresh", async () => {
    const { api, count } = await session({
      "parser.mass.new": massNew,
      "parser.mass.id": [() => json({ status: "stop" }), massDone],
    });
    const error = await api.frequency(["окна"], ["wordstat_n"]).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "task_stopped" });
    expect((error as MutagenError).hintRu).toMatch(/остановлено на стороне Мутагена/);
    const statuses = (await api.ledger.entries()).map((entry) => entry.status);
    expect(statuses).toEqual(["requested", "created", "stopped"]);
    const result = executed(
      await api.frequency(["окна"], ["wordstat_n"], undefined, { forceRefresh: true }),
    );
    expect(result.parts[0]).toMatchObject({ massId: 501, reusedTask: true });
    expect(count("parser.mass.new")).toBe(1);
    expect(count("parser.mass.id")).toBe(2);
    expect(api.spending().spentRub).toBe(0.02);
  });

  it("does not take an old task with the same name for a lost one", async () => {
    let name = "";
    const { api, count } = await session({
      "parser.mass.new": [
        (call) => {
          name = (call.body as { name: string }).name;
          return new TypeError("fetch failed");
        },
        massNew,
      ],
      "parser.mass.list": () =>
        json({ "100": { name, status: "finish", time: Math.floor(Date.now() / 1000) - 3600 } }),
      "parser.mass.id": massDone,
    });
    await expect(api.frequency(["окна"], ["wordstat_n"])).rejects.toThrow(MutagenError);
    const result = executed(await api.frequency(["окна"], ["wordstat_n"]));
    expect(result.parts[0]).toMatchObject({ massId: 501, reusedTask: false });
    expect(count("parser.mass.new")).toBe(2);
  });

  it("finds a lost task by parser, region and count", async () => {
    const time = Math.floor(Date.now() / 1000);
    const { api, count } = await session({
      "parser.mass.new": () => new TypeError("fetch failed"),
      "parser.mass.list": () =>
        json({
          "300": {
            name: "x",
            parser: "wordstat_n",
            region_id: "0",
            count: 1,
            time,
            status: "process",
          },
          "301": {
            name: "y",
            parser: "wordstat_q",
            region_id: "0",
            count: 1,
            time,
            status: "process",
          },
          "302": {
            name: "z",
            parser: "wordstat_n",
            region_id: "0",
            count: 1,
            time: 1,
            status: "finish",
          },
        }),
      "parser.mass.id": massDone,
    });
    await expect(api.frequency(["окна"], ["wordstat_n"])).rejects.toThrow(MutagenError);
    const result = executed(await api.frequency(["окна"], ["wordstat_n"]));
    expect(result.parts[0]).toMatchObject({ massId: 300, reusedTask: true });
    expect(count("parser.mass.new")).toBe(1);
  });

  it("does not guess between several similar lost tasks", async () => {
    const time = Math.floor(Date.now() / 1000);
    const { api, count } = await session({
      "parser.mass.new": () => new TypeError("fetch failed"),
      "parser.mass.list": () =>
        json({
          "300": { parser: "wordstat_n", region_id: "0", count: 1, time, status: "process" },
          "301": { parser: "wordstat_n", count: 1, time, status: "process" },
        }),
    });
    await expect(api.frequency(["окна"], ["wordstat_n"])).rejects.toThrow(MutagenError);
    const error = await api.frequency(["окна"], ["wordstat_n"]).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "task_ambiguous" });
    expect((error as MutagenError).hintRu).toMatch(/mutagen_mass_tasks/);
    expect(count("parser.mass.new")).toBe(1);
  });

  it("abandons a stopped task and pays for a new one with newTask", async () => {
    const { api, count } = await session({
      "parser.mass.new": [massNew, () => json({ id: 502, status: "process" })],
      "parser.mass.id": [() => json({ status: "stop" }), massDone],
    });
    await expect(api.frequency(["окна"], ["wordstat_n"])).rejects.toMatchObject({
      kind: "task_stopped",
    });
    const dry = await api.frequency(["окна"], ["wordstat_n"], undefined, {
      dryRun: true,
      newTask: true,
    });
    expect(dry.estimate.totalRub).toBe(0.02);
    expect(
      (await api.frequency(["окна"], ["wordstat_n"], undefined, { dryRun: true })).estimate,
    ).toMatchObject({ totalRub: 0 });
    const result = executed(
      await api.frequency(["окна"], ["wordstat_n"], undefined, { newTask: true }),
    );
    expect(result.parts[0]).toMatchObject({ massId: 502, reusedTask: false });
    expect(count("parser.mass.new")).toBe(2);
    expect(api.spending().spentRub).toBe(0.04);
    const entries = await api.ledger.entries();
    expect(entries.map((entry) => entry.status)).toEqual([
      "requested",
      "created",
      "stopped",
      "abandoned",
      "requested",
      "created",
      "done",
    ]);
    expect(entries[3]).toMatchObject({ massId: 501, estimateRub: 0 });
  });

  it("creates a new task instead of guessing between lost ones with newTask", async () => {
    const time = Math.floor(Date.now() / 1000);
    const { api, count } = await session({
      "parser.mass.new": [() => new TypeError("fetch failed"), massNew],
      "parser.mass.list": () =>
        json({
          "300": { parser: "wordstat_n", region_id: "0", count: 1, time, status: "process" },
          "301": { parser: "wordstat_n", count: 1, time, status: "process" },
        }),
      "parser.mass.id": massDone,
    });
    await expect(api.frequency(["окна"], ["wordstat_n"])).rejects.toThrow(MutagenError);
    const result = executed(
      await api.frequency(["окна"], ["wordstat_n"], undefined, { newTask: true }),
    );
    expect(result.parts[0]).toMatchObject({ massId: 501, reusedTask: false });
    expect(count("parser.mass.new")).toBe(2);
    expect(count("parser.mass.list")).toBe(0);
    const statuses = (await api.ledger.entries()).map((entry) => entry.status);
    expect(statuses).toEqual(["requested", "abandoned", "requested", "created", "done"]);
  });

  it("keeps reusing a finished task with newTask", async () => {
    const { api, count } = await session(
      { "parser.mass.new": massNew, "parser.mass.id": massDone },
      { noCache: true },
    );
    executed(await api.frequency(["окна"], ["wordstat_n"]));
    const result = executed(
      await api.frequency(["окна"], ["wordstat_n"], undefined, { newTask: true }),
    );
    expect(result.parts[0]).toMatchObject({ massId: 501, reusedTask: true });
    expect(count("parser.mass.new")).toBe(1);
  });
});

describe("MutagenSession best-effort storage", () => {
  it.skipIf(process.platform === "win32")(
    "returns paid results when the cache directory is read-only",
    async () => {
      const { api, cacheDir, count } = await session({
        "parser.mass.new": massNew,
        "parser.mass.id": massDone,
        "serp.report": () => json([{ a: 1 }]),
      });
      await mkdir(cacheDir, { recursive: true });
      await chmod(cacheDir, 0o500);
      try {
        const result = executed(await api.frequency(["окна"], ["wordstat_n"]));
        expect(result.parts[0]).toMatchObject({ massId: 501, fromCache: false });
        expect(api.spending().spentRub).toBe(0.02);
        await expect(api.serpReport(serpParams)).resolves.toMatchObject({ rows: [{ a: 1 }] });
        expect(count("serp.report")).toBe(1);
      } finally {
        await chmod(cacheDir, 0o700);
      }
    },
  );

  it("returns the result with a warning when the final ledger write fails", async () => {
    const { api } = await session({ "parser.mass.new": massNew, "parser.mass.id": massDone });
    const append = api.ledger.append.bind(api.ledger);
    vi.spyOn(api.ledger, "append").mockImplementation(async (entry) => {
      if (entry.status === "done") throw new Error("ENOSPC: no space left on device");
      return append(entry);
    });
    const result = executed(await api.frequency(["окна"], ["wordstat_n"]));
    expect(result.parts[0]).toMatchObject({ massId: 501 });
    expect(result.warnings?.[0]).toMatch(/ENOSPC/);
  });
});

describe("MutagenSession cancellation and quota", () => {
  it("does not count a call cancelled while queued", async () => {
    const paths = await dirsFor();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const methods: string[] = [];
    const fetch: FetchLike = async (url) => {
      methods.push(methodOf(url));
      if (methodOf(url) === "mutagen.parser.mass.new") {
        await gate;
        return massNew();
      }
      return massDone();
    };
    const limiter = new RateLimiter({ concurrency: 1, perSecond: 1000 });
    const client = new MutagenClient({ apiKey: API_KEY, fetch, rateLimit: limiter });
    const api = new MutagenSession({ client, ...paths, frequencyStrategy: "mass" });
    const first = api.frequency(["окна"], ["wordstat_n"]);
    await vi.waitFor(() => expect(methods).toEqual(["mutagen.parser.mass.new"]));
    const controller = new AbortController();
    const second = api.frequency(["двери"], ["wordstat_n"], undefined, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(limiter.pending).toBe(1));
    controller.abort();
    await expect(second).rejects.toMatchObject({ kind: "aborted", beforeStart: true });
    expect(api.spending()).toMatchObject({ spentRub: 0, reservedRub: 0.02 });
    release();
    await first;
    expect(api.spending()).toMatchObject({ spentRub: 0.02, reservedRub: 0 });
    const statuses = (await api.ledger.entries()).map((entry) => entry.status);
    expect(statuses).toContain("cancelled");
    expect(statuses).not.toContain("failed");
    expect(methods.filter((method) => method === "mutagen.parser.mass.new")).toHaveLength(1);
  });

  it("counts every serp.report retry as quota", async () => {
    const stub = router({
      "serp.report": [
        () => json({ error_id: 113, error_msg: "another report in process" }),
        () => json([{ a: 1 }]),
      ],
    });
    const client = new MutagenClient({
      apiKey: API_KEY,
      fetch: stub.fetch,
      rateLimit: { ...FAST, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const api = new MutagenSession({ client, ...(await dirsFor()) });
    await api.serpReport(serpParams);
    expect(stub.count("serp.report")).toBe(2);
    expect(api.spending().quotaRequests).toBe(2);
  });

  it("validates serp parameters before the guard and hashes normalized ones", async () => {
    const { api, count } = await session({ "serp.report": () => json([{ a: 1 }]) });
    await expect(
      api.serpReport({ region: "yandex_msk", report: "nope" } as never),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(api.spending().calls).toEqual([]);
    const base = { region: "yandex_msk", report: "report_keyword_info" } as const;
    await api.serpReport({ ...base, keywords: [" окна ", "двери"] });
    const again = await api.serpReport({ ...base, keywords: ["окна", "двери"] });
    expect(again).toMatchObject({ fromCache: true });
    expect(count("serp.report")).toBe(1);
  });
});

describe("MutagenSession.fromConfig merging", () => {
  it("keeps the stricter of config and options", async () => {
    const paths = await dirsFor();
    const env = {
      MUTAGEN_API_KEY: API_KEY,
      MUTAGEN_STATE_DIR: paths.stateDir,
      MUTAGEN_CACHE_DIR: paths.cacheDir,
    };
    const linux = { platform: "linux" as const, homedir: "/home/u" };
    const strict = loadConfig(
      { ...env, MUTAGEN_FREE_ONLY: "1", MUTAGEN_BUDGET_RUB: "10", MUTAGEN_AUTO_APPROVE_RUB: "2" },
      linux,
    );
    const api = MutagenSession.fromConfig(strict, {
      freeOnly: false,
      budgetRub: 100,
      autoApproveRub: 0.5,
    });
    expect(api.spending()).toMatchObject({ freeOnly: true, budgetRub: 10 });
    expect(api.guard.autoApproveKopecks).toBe(50);
    const loose = MutagenSession.fromConfig(loadConfig(env, linux), {
      freeOnly: true,
      budgetRub: 5,
    });
    expect(loose.spending()).toMatchObject({ freeOnly: true, budgetRub: 5 });
    expect(loose.guard.autoApproveKopecks).toBe(100);
  });

  it("applies MUTAGEN_CONCURRENCY to the client", async () => {
    const linux = { platform: "linux" as const, homedir: "/home/u" };
    const config = loadConfig(
      { MUTAGEN_API_KEY: API_KEY, MUTAGEN_CONCURRENCY: "1", MUTAGEN_RPS: "100" },
      linux,
    );
    let active = 0;
    let peak = 0;
    const fetch: FetchLike = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return json({ balance: 1 });
    };
    const api = MutagenSession.fromConfig(config, { fetch });
    await Promise.all([api.balance(), api.balance(), api.balance()]);
    expect(peak).toBe(1);
  });
});

describe("MutagenSession review fixes", () => {
  const massHash = (keys: string[], parser = "wordstat_n") =>
    requestHash("parser.mass.new", { keys_list: [...keys].sort(), parser, region_id: "0" });

  async function lockFile(stateDir: string, hash: string, ageMs = 0) {
    const dir = join(stateDir, "locks");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${hash}.lock`);
    await writeFile(path, "");
    const time = new Date(Date.now() - ageMs);
    await utimes(path, time, time);
    return path;
  }

  it("creates one mass task for two processes sharing the state directory", async () => {
    const paths = await dirsFor();
    let created = 0;
    const stub = asyncRouter({
      "parser.mass.new": async () => {
        created += 1;
        await new Promise((resolve) => setTimeout(resolve, 150));
        return json({ id: 600 + created, status: "process" });
      },
      "parser.mass.id": () => massDone(),
    });
    const make = () =>
      new MutagenSession({
        client: new MutagenClient({ apiKey: API_KEY, fetch: stub.fetch, rateLimit: FAST }),
        ...paths,
        frequencyStrategy: "mass",
        noCache: true,
      });
    const [a, b] = [make(), make()];
    const results = await Promise.all([
      a.frequency(["окна", "двери"], ["wordstat_n"]),
      b.frequency(["окна", "двери"], ["wordstat_n"]),
    ]);
    expect(created).toBe(1);
    expect(results.map((result) => executed(result).parts[0])).toMatchObject([
      { massId: 601 },
      { massId: 601 },
    ]);
    expect(a.spending().spentRub + b.spending().spentRub).toBe(0.04);
    expect(await readdir(join(paths.stateDir, "locks"))).toEqual([]);
  });

  it("takes over a stale lock and answers task_pending while a fresh one stays busy", async () => {
    const { api, stateDir, count } = await session(
      { "parser.mass.new": massNew, "parser.mass.id": massDone },
      { lockWaitMs: 50 },
    );
    const busy = await lockFile(stateDir, massHash(["окна"]));
    await expect(api.frequency(["окна"], ["wordstat_n"])).rejects.toMatchObject({
      kind: "task_pending",
    });
    expect(count("parser.mass.new")).toBe(0);
    await rm(busy);
    await lockFile(stateDir, massHash(["двери"]), 11 * 60_000);
    executed(await api.frequency(["двери"], ["wordstat_n"]));
    expect(count("parser.mass.new")).toBe(1);
  });

  it("charges every later create of parser.get and warns about the overrun", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { api, count } = await session(
      {
        "parser.get": [
          () => json({ status: "create" }),
          () => json({ status: "create" }),
          () => json({ status: "finish", data: { frequency: 3 } }),
        ],
      },
      { frequencyStrategy: "single" },
    );
    const result = executed(await settle(api.frequency(["окна"], ["wordstat_n"])));
    expect(count("parser.get")).toBe(3);
    expect(api.spending().spentRub).toBe(0.04);
    expect(result.warnings?.join("\n")).toContain("фактическая трата превысила смету на 0.02 ₽");
    const created = (await api.ledger.entries()).filter((entry) => entry.status === "created");
    expect(created).toHaveLength(2);
  });

  it("reports the overrun in task_pending when a paid phrase is created again", async () => {
    const first = await session(
      { "parser.get": () => json({ status: "create" }) },
      { frequencyStrategy: "single", taskTimeoutMs: 1 },
    );
    await expect(first.api.frequency(["окна"], ["wordstat_n"])).rejects.toMatchObject({
      kind: "task_pending",
    });
    const stub = router({
      "parser.get": [() => json({ status: "create" }), () => json({ status: "process" })],
    });
    const api = new MutagenSession({
      client: new MutagenClient({ apiKey: API_KEY, fetch: stub.fetch, rateLimit: FAST }),
      stateDir: first.stateDir,
      cacheDir: first.cacheDir,
      frequencyStrategy: "single",
      taskTimeoutMs: 1,
    });
    const error = (await api
      .frequency(["окна"], ["wordstat_n"])
      .catch((e) => e)) as TaskPendingError;
    expect(error.kind).toBe("task_pending");
    expect(error.warnings.join("\n")).toContain("превысила смету на 0.02 ₽");
    expect(api.spending().spentRub).toBe(0.02);
  });

  it("tells about a probable failure when a task is pending for over 2 hours", async () => {
    const past = () => Date.now() - 3 * 60 * 60_000;
    const first = await session(
      { "parser.get": () => json({ status: "create" }) },
      { frequencyStrategy: "single", taskTimeoutMs: 1, now: past },
    );
    const fresh = (await first.api.directBids(["окна"]).catch((e) => e)) as TaskPendingError;
    expect(fresh.stale).toBe(false);
    const stub = router({ "parser.get": () => json({ status: "process" }) });
    const api = new MutagenSession({
      client: new MutagenClient({ apiKey: API_KEY, fetch: stub.fetch, rateLimit: FAST }),
      stateDir: first.stateDir,
      cacheDir: first.cacheDir,
      frequencyStrategy: "single",
      taskTimeoutMs: 1,
    });
    const error = (await api.directBids(["окна"]).catch((e) => e)) as TaskPendingError;
    expect(error).toMatchObject({ kind: "task_pending", stale: true });
    expect(error.hintRu).toContain("Задача висит больше 2 часов");
    expect(error.hintRu).toContain("support@mutagen.ru");
    expect(error.hintEn).toContain("pending for over 2 hours");
    expect(api.spending().spentRub).toBe(0);
  });

  it("marks a pending mass task and a pending competition check older than 2 hours", async () => {
    const past = () => Date.now() - 3 * 60 * 60_000;
    const first = await session(
      {
        "parser.mass.new": massNew,
        "parser.mass.id": () => json({ status: "process" }),
        "check_key.new": () => json({ task_id: 77, status: "created" }),
        "check_key.get": () => json({ task_id: 77, status: "processed" }),
      },
      { massTimeoutMs: 1, taskTimeoutMs: 1, now: past },
    );
    await expect(first.api.frequency(["окна"], ["wordstat_n"])).rejects.toMatchObject({
      stale: false,
    });
    await expect(first.api.competition(["окна"])).rejects.toMatchObject({ stale: false });
    const stub = router({
      "parser.mass.id": () => json({ status: "process" }),
      "check_key.get": () => json({ task_id: 77, status: "processed" }),
    });
    const api = new MutagenSession({
      client: new MutagenClient({ apiKey: API_KEY, fetch: stub.fetch, rateLimit: FAST }),
      stateDir: first.stateDir,
      cacheDir: first.cacheDir,
      frequencyStrategy: "mass",
      massTimeoutMs: 1,
      taskTimeoutMs: 1,
    });
    await expect(api.frequency(["окна"], ["wordstat_n"])).rejects.toMatchObject({
      kind: "task_pending",
      stale: true,
    });
    await expect(api.competition(["окна"])).rejects.toMatchObject({ stale: true });
  });
});
