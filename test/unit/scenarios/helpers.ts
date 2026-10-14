import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetError } from "../../../src/budget/guard.js";
import { MutagenClient } from "../../../src/core/client.js";
import type { ScenarioOptions } from "../../../src/scenarios/common.js";
import { MutagenSession, type MutagenSessionOptions } from "../../../src/session.js";
import { API_KEY, json, type RecordedCall } from "../core/helpers.js";
import { FAST, type Handler, router } from "../mcp/helpers.js";

export { json } from "../core/helpers.js";

const dirs: string[] = [];

export async function cleanup(): Promise<void> {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export type Columns = Record<string, Record<string, number>>;

export interface FakeApi {
  /** Left column per seed (phrase → base frequency). */
  wordstat?: Columns;
  /** Exact frequency per phrase; missing phrases get 1. */
  exact?: Record<string, number>;
  /** Mass result data for frequency parsers, overriding the generated one. */
  exactData?: unknown;
  strong?: Record<string, number>;
  serp?: (body: Record<string, unknown>) => Response;
  projectKeywords?: { keyword: string; claster_id: string | null }[];
}

export function subscriptionMissing(): Response {
  return json({ error_id: 111, error_msg: "subscription required" });
}

/** A fake Mutagen API: Wordstat columns, mass frequencies, competition, serp reports. */
export function fakeHandlers(api: FakeApi): Record<string, Handler> {
  const tasks = new Map<number, { keys: string[]; parser: string }>();
  let nextId = 700;
  let nextTask = 900;
  return {
    balance: () => json({ balance: 1000 }),
    "parser.mass.new": (call: RecordedCall) => {
      const body = call.body as { keys_list: string[]; parser: string };
      nextId += 1;
      tasks.set(nextId, { keys: body.keys_list, parser: body.parser });
      return json({ id: nextId, status: "process" });
    },
    "parser.mass.id": (call: RecordedCall) => {
      const task = tasks.get((call.body as { mass_id: number }).mass_id);
      if (!task) return json({ error_id: 107, error_msg: "task_id not found" });
      let data: unknown;
      if (task.parser.startsWith("wordstat_key")) {
        data = task.keys.map((key) => ({
          key,
          frequency: 1,
          array: api.wordstat?.[key] ?? {},
        }));
      } else {
        data = api.exactData ?? task.keys.map((key) => ({ key, frequency: api.exact?.[key] ?? 1 }));
      }
      return json({ status: "finish", parser: task.parser, count: task.keys.length, data });
    },
    "parser.get": (call: RecordedCall) => {
      const { key, parser } = call.body as { key: string; parser: string };
      if (parser.startsWith("wordstat_key")) {
        return json({
          status: "finish",
          data: { frequency: 1, array: api.wordstat?.[key] ?? {} },
        });
      }
      return json({ status: "finish", data: { frequency: api.exact?.[key] ?? 1 } });
    },
    "check_key.new": (call: RecordedCall) => {
      nextTask += 1;
      const key = (call.body as { key: string }).key;
      tasks.set(nextTask, { keys: [key], parser: "check" });
      return json({ task_id: nextTask, status: "created" });
    },
    "check_key.get": (call: RecordedCall) => {
      const task = tasks.get((call.body as { task_id: number }).task_id);
      const key = task?.keys[0] ?? "";
      return json({
        status: "completed",
        key,
        strong: api.strong?.[key] ?? 5,
        wordstat: 10,
        vital: "",
        vital_site: "",
      });
    },
    "serp.report": (call: RecordedCall) =>
      api.serp ? api.serp(call.body as Record<string, unknown>) : subscriptionMissing(),
    "progect.keywords": () => json(api.projectKeywords ?? []),
  };
}

/** Scenario tests run on mass jobs; the default parser.get path has its own tests. */
export async function makeSession(
  handlers: Record<string, Handler | Handler[]>,
  options: Partial<MutagenSessionOptions> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "mutagen-scenario-"));
  dirs.push(root);
  const stub = router(handlers);
  const client = new MutagenClient({ apiKey: API_KEY, fetch: stub.fetch, rateLimit: FAST });
  const session = new MutagenSession({
    client,
    stateDir: join(root, "state"),
    cacheDir: join(root, "cache"),
    frequencyStrategy: "mass",
    ...options,
  });
  return { session, ...stub };
}

/** Runs a paid scenario, confirming the plan once like a user would. */
export async function confirmed<T>(run: (options: ScenarioOptions) => Promise<T>): Promise<T> {
  try {
    return await run({});
  } catch (error) {
    if (!(error instanceof BudgetError) || error.kind !== "needs_confirmation") throw error;
    return run({ confirmToken: error.confirmToken ?? "" });
  }
}

export async function refusal(promise: Promise<unknown>): Promise<BudgetError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BudgetError) return error;
    throw error;
  }
  throw new Error("Expected a BudgetError");
}

export function done<T extends { dryRun: boolean }>(result: T): Extract<T, { dryRun: false }> {
  if (result.dryRun) throw new Error("Expected an executed scenario");
  return result as Extract<T, { dryRun: false }>;
}
