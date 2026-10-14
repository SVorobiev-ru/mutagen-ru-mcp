import { type Command, Option } from "commander";
import { estimatePlan, type PlannedCall } from "../../budget/estimate.js";
import { Ledger } from "../../budget/ledger.js";
import { resolvePrices } from "../../budget/pricing.js";
import type { FrequencyParser } from "../../core/types.js";
import { budgetLine, estimateLine, rub } from "../../mcp/respond.js";
import {
  balanceTable,
  estimateTable,
  massResultTable,
  massTasksTable,
  projectKeywordsTable,
} from "../../tables/lists.js";
import { table } from "../../tables/types.js";
import { usageError } from "../errors.js";
import { depth, nonNegativeInt, parseTypes, positiveInt } from "../input.js";
import { emit } from "../output.js";
import type { Register } from "./shared.js";

const DAY_MS = 24 * 60 * 60_000;

interface EstimateOptions {
  freq?: number;
  types?: FrequencyParser[];
  wordstatKeys?: number;
  depth?: 200 | 2000;
  bids?: number;
  competition?: number;
  reports?: number;
}

function plannedCalls(options: EstimateOptions): PlannedCall[] {
  const calls: PlannedCall[] = [];
  if (options.freq) {
    calls.push({
      method: "parser.mass.new",
      parsers: options.types ?? ["wordstat_n"],
      phrases: options.freq,
    });
  }
  if (options.wordstatKeys) {
    const parser = options.depth === 2000 ? "wordstat_key" : "wordstat_key_50";
    calls.push({ method: "parser.mass.new", parsers: [parser], phrases: options.wordstatKeys });
  }
  if (options.bids) {
    calls.push({ method: "parser.mass.new", parsers: ["direct"], phrases: options.bids });
  }
  if (options.competition) calls.push({ method: "check_key.new", phrases: options.competition });
  if (options.reports) calls.push({ method: "serp.report", requests: options.reports });
  return calls;
}

export const registerFree: Register = (program, context) => {
  program
    .command("balance")
    .description("Mutagen account balance, RUB. Free. — Баланс аккаунта в рублях, бесплатно.")
    .action(async (_options: object, cmd: Command) => {
      const ctx = context(cmd);
      const session = ctx.session();
      const balance = await session.balance(ctx.liveOptions());
      await emit(ctx, {
        table: balanceTable(balance),
        lines: [`Баланс / Balance: ${rub(balance.balance)}`],
      });
    });

  program
    .command("spending")
    .description(
      "Budget settings and paid calls from the local log for the last 24 h. — Бюджет и платные вызовы из журнала за 24 ч.",
    )
    .action(async (_options: object, cmd: Command) => {
      const ctx = context(cmd);
      const since = Date.now() - DAY_MS;
      const entries = (await new Ledger({ dir: ctx.config.stateDir }).entries()).filter(
        (entry) => (entry.chargedRub ?? 0) > 0 && Date.parse(entry.ts) >= since,
      );
      const charged = entries.reduce(
        (sum, entry) => sum + Math.round((entry.chargedRub ?? 0) * 100),
        0,
      );
      const spending = ctx.spending();
      await emit(ctx, {
        table: table(
          [
            { key: "ts", title: "Время", type: "date" },
            { key: "method", title: "Метод", type: "string" },
            { key: "status", title: "Статус", type: "string" },
            { key: "charged_rub", title: "Списано, ₽", type: "number" },
            { key: "task", title: "Задание", type: "number" },
          ],
          entries.map((entry) => ({
            ts: entry.ts,
            method: entry.method,
            status: entry.status,
            charged_rub: entry.chargedRub ?? 0,
            task: entry.massId ?? entry.taskId ?? null,
          })),
        ),
        lines: [
          `По журналу за 24 ч списано ${rub(charged / 100)} (${entries.length} платных вызовов) / Charged in the last 24 h by the local log.`,
          `Бюджет на запуск: ${rub(spending.budgetRub)}, автоподтверждение до ${rub(ctx.config.autoApproveRub)}.${spending.freeOnly ? " Режим «только бесплатное»." : ""} / Budget per run.`,
          `Журнал / Log: ${ctx.config.stateDir}`,
        ],
      });
    });

  program
    .command("estimate")
    .description(
      "Cost of a plan of calls, local and free. — Смета плана вызовов, локально и бесплатно.",
    )
    .option("--freq <n>", "phrases for frequency / фраз для частотности", nonNegativeInt)
    .option("-t, --types <list>", "match types for --freq: n,q,qs,no,qo,qso", parseTypes)
    .option("--wordstat-keys <n>", "seeds for keywords / фраз-маркеров", nonNegativeInt)
    .addOption(new Option("--depth <n>", "keywords depth 200|2000 / глубина").argParser(depth))
    .option("--bids <n>", "phrases for Direct bids / фраз для ставок", nonNegativeInt)
    .option("--competition <n>", "phrases for competition / фраз для конкуренции", nonNegativeInt)
    .option("--reports <n>", "Mega-tool reports / отчетов Мега-инструмента", nonNegativeInt)
    .action(async (options: EstimateOptions, cmd: Command) => {
      const ctx = context(cmd);
      const calls = plannedCalls(options);
      if (calls.length === 0) {
        throw usageError(
          "Укажите, что считать: --freq, --wordstat-keys, --bids, --competition или --reports.",
          "Nothing to estimate: use --freq, --wordstat-keys, --bids, --competition or --reports.",
        );
      }
      const estimate = estimatePlan(calls, resolvePrices(ctx.config.prices));
      const spending = ctx.spending();
      await emit(ctx, {
        table: estimateTable(estimate),
        lines: [
          estimateLine(estimate),
          estimate.totalRub <= spending.remainingRub
            ? "Укладывается в бюджет / Fits the budget."
            : "Больше бюджета запуска / Exceeds the budget.",
          budgetLine(spending),
        ],
      });
    });

  const mass = program
    .command("mass")
    .description("Mass parser jobs, free. — Массовые задания парсера, бесплатно.");
  mass
    .command("list")
    .description("List of mass jobs. — Список массовых заданий.")
    .action(async (_options: object, cmd: Command) => {
      const ctx = context(cmd);
      const { tasks } = await ctx.session().massTasks(ctx.liveOptions());
      await emit(ctx, { table: massTasksTable(tasks) });
    });
  mass
    .command("get")
    .description("Mass job result by id. — Результат массового задания по id.")
    .argument("<id>", "job id / номер задания", positiveInt)
    .option("--wait", "wait until the job finishes / ждать завершения")
    .action(async (id: number, options: { wait?: boolean }, cmd: Command) => {
      const ctx = context(cmd);
      const { massId, result, fromCache } = await ctx.session().massResult(id, {
        ...ctx.waitOptions(),
        ...(options.wait ? { wait: true } : {}),
        ...(ctx.opts.refresh ? { forceRefresh: true } : {}),
      });
      await emit(ctx, {
        table: massResultTable(massId, result),
        fromCache,
        lines: [`Задание / Job ${massId}: ${result.status}`],
      });
    });

  program
    .command("projects")
    .description(
      "Keywords and clusters of a Favorites project by id (the id is in the project page URL: Избранное → проект). Free. — Ключи проекта «Избранного».",
    )
    .argument("<id>", "project id / номер проекта", positiveInt)
    .action(async (id: number, _options: object, cmd: Command) => {
      const ctx = context(cmd);
      const { keywords } = await ctx.session().projectKeywords(id, ctx.liveOptions());
      await emit(ctx, { table: projectKeywordsTable(id, keywords) });
    });
};
