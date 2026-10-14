import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestHash } from "../../src/budget/hash.js";
import { loadConfig, type MutagenConfig } from "../../src/config.js";
import { isMutagenError } from "../../src/core/errors.js";
import { Transport } from "../../src/core/transport.js";
import {
  type DryRunResult,
  MutagenSession,
  type ParserRunResult,
  type SerpCountResult,
} from "../../src/session.js";
import { frequencyTable, wordstatKeywordsTable } from "../../src/tables/parser.js";

const LIVE = process.env.MUTAGEN_LIVE === "1";
const RUN_BUDGET_RUB = 2;
const WAIT = { taskTimeoutMs: 120_000, massTimeoutMs: 170_000 };

function executed(result: ParserRunResult | DryRunResult): ParserRunResult {
  if (result.dryRun) throw new Error("Expected an executed call");
  return result;
}

describe.skipIf(!LIVE)("live Mutagen API", () => {
  let root: string;
  let config: MutagenConfig;
  let session: MutagenSession;
  let massSession: MutagenSession;
  let before: number;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "mutagen-live-"));
    config = loadConfig({
      ...process.env,
      MUTAGEN_BUDGET_RUB: String(RUN_BUDGET_RUB),
      MUTAGEN_CACHE_DIR: join(root, "cache"),
      MUTAGEN_STATE_DIR: join(root, "state"),
    });
    session = MutagenSession.fromConfig(config, { ...WAIT, budgetRub: RUN_BUDGET_RUB / 2 });
    massSession = MutagenSession.fromConfig(config, {
      ...WAIT,
      budgetRub: RUN_BUDGET_RUB / 2,
      frequencyStrategy: "mass",
    });
    before = (await session.balance()).balance;
  });

  afterAll(async () => {
    if (session === undefined) return;
    const after = (await session.balance()).balance;
    const spent = session.spending().spentRub + massSession.spending().spentRub;
    console.log(
      `Баланс до ${before.toFixed(2)} ₽, после ${after.toFixed(2)} ₽, разница ${(before - after).toFixed(2)} ₽, по смете сессий ${spent.toFixed(2)} ₽`,
    );
    await rm(root, { recursive: true, force: true });
    expect(before - after).toBeLessThanOrEqual(RUN_BUDGET_RUB);
  });

  it("mutagen.balance returns a number", () => {
    expect(Number.isFinite(before)).toBe(true);
    expect(before).toBeGreaterThan(RUN_BUDGET_RUB);
  });

  it("an unknown method fails with 108 and error_detail", async () => {
    const transport = new Transport({ apiKey: config.apiKey as string, baseUrl: config.baseUrl });
    const error = await transport.call("mutagen.nonexistent").catch((caught: unknown) => caught);
    expect(isMutagenError(error)).toBe(true);
    expect(error).toMatchObject({ code: 108 });
    expect((error as { detail?: string }).detail).toMatch(/mutagen\.nonexistent/);
  });

  it("serp.report answers 111 without a subscription or a count with one", async () => {
    const outcome = await session
      .serpReportCount({
        report: "report_keyword_info",
        region: "yandex_msk",
        keyword: "купить окна",
      })
      .then(
        (result) => ({ result: result as SerpCountResult }),
        (error: unknown) => ({ error }),
      );
    if ("error" in outcome) {
      expect(outcome.error).toMatchObject({ code: 111, kind: "subscription_required" });
    } else {
      expect(Number.isInteger(outcome.result.count)).toBe(true);
    }
  });

  it("parser.get wordstat_n on one phrase, with polling", async () => {
    const result = executed(await session.frequency(["окна пвх"], ["wordstat_n"], "225"));
    expect(result.strategy).toBe("single");
    const [row] = frequencyTable(result).rows;
    expect(row).toMatchObject({ phrase: "окна пвх", region: "225" });
    expect(row?.wordstat_n).toBeGreaterThan(0);
  }, 150_000);

  it("parser.mass.new on two phrases, waits and finds the task in mass.list", async () => {
    const phrases = ["натяжные потолки", "пластиковые окна"];
    const result = executed(await massSession.frequency(phrases, ["wordstat_n"], "225"));
    const [part] = result.parts;
    if (part?.via !== "parser.mass") throw new Error("Expected a mass task");
    expect(part.result.status).toBe("finish");
    const rows = frequencyTable(result).rows;
    expect(rows.map((row) => row.phrase).sort()).toEqual([...phrases].sort());
    expect(rows.every((row) => Number(row.wordstat_n) > 0)).toBe(true);

    const hash = requestHash("parser.mass.new", {
      keys_list: [...phrases].sort(),
      parser: "wordstat_n",
      region_id: "225",
    });
    const name = `mutagen-ru-mcp ${hash.slice(0, 16)}`;
    const { tasks } = await massSession.massTasks();
    expect(tasks.filter((item) => item.name === name).map((item) => item.id)).toContain(
      part.massId,
    );
  }, 180_000);

  it("Wordstat keywords, depth 200, on one phrase", async () => {
    const result = executed(await session.wordstatKeywords("натяжные потолки", 200, "225"));
    const rows = wordstatKeywordsTable(result).rows;
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.length).toBeLessThanOrEqual(200);
    expect(rows.every((row) => typeof row.frequency === "number")).toBe(true);
  }, 150_000);
});
