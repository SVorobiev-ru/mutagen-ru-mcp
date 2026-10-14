import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { estimatePlan, type PlannedCall } from "../../budget/estimate.js";
import { SpendGuard, type Spending } from "../../budget/guard.js";
import { resolvePrices } from "../../budget/pricing.js";
import type { ParserType } from "../../core/types.js";
import { SINGLE_MAX_PHRASES } from "../../session.js";
import {
  balanceTable,
  estimateTable,
  massResultTable,
  massTasksTable,
  projectKeywordsTable,
  spendingTable,
} from "../../tables/lists.js";
import { type McpDeps, resolveSaveAs, waitUntil } from "../context.js";
import { budgetLine, estimateLine, outputSchema, toolResult } from "../respond.js";
import { FREE_LOCAL, FREE_READ, frequencyTypes, handler, tableParams } from "./common.js";

const NEXT = "Next / Дальше";

const planCall = z.object({
  tool: z.enum(["frequency", "wordstat_keywords", "direct_bids", "competition", "serp_report"]),
  phrases: z.number().int().min(0).optional().describe("Phrases or seeds"),
  types: z.array(frequencyTypes).optional(),
  depth: z.literal([200, 2000]).optional(),
  requests: z.number().int().min(0).optional(),
});

/** Same strategy as the tools: up to 10 phrases per type by parser.get, more by a mass task. */
function parserCall(parsers: readonly ParserType[], phrases: number): PlannedCall {
  const method = phrases <= SINGLE_MAX_PHRASES ? "parser.get" : "parser.mass.new";
  return { method, parsers, phrases };
}

function plannedCall(call: z.infer<typeof planCall>): PlannedCall {
  const phrases = call.phrases ?? 0;
  switch (call.tool) {
    case "frequency":
      return parserCall(call.types ?? ["wordstat_n"], phrases);
    case "wordstat_keywords": {
      const parser: ParserType = call.depth === 2000 ? "wordstat_key" : "wordstat_key_50";
      return { method: "parser.get", parsers: [parser], phrases };
    }
    case "direct_bids":
      return parserCall(["direct"], phrases);
    case "competition":
      return { method: "check_key.new", phrases };
    case "serp_report":
      return { method: "serp.report", requests: call.requests ?? 1 };
  }
}

function localSpending(deps: McpDeps): Spending {
  if (deps.config.apiKey) return deps.session().spending();
  return new SpendGuard({
    budgetRub: deps.config.budgetRub,
    autoApproveRub: deps.config.autoApproveRub,
    freeOnly: deps.config.freeOnly,
  }).spending();
}

export function registerBasicTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "mutagen_balance",
    {
      title: "Mutagen balance",
      description: `Mutagen account balance in RUB. Free.\nБаланс аккаунта Мутагена в рублях. Бесплатно.\n${NEXT}: mutagen_estimate before paid calls.`,
      inputSchema: z.object({}),
      outputSchema,
      annotations: FREE_READ,
    },
    handler(deps, server, "mutagen_balance", async (_args, { ctx, tool }) => {
      const session = deps.session();
      const balance = await session.balance({ signal: ctx.mcpReq.signal });
      return toolResult(
        deps,
        tool,
        {
          table: balanceTable(balance),
          lines: [`Баланс / Balance: ${balance.balance.toFixed(2)} ₽`],
          spending: session.spending(),
        },
        {},
        undefined,
      );
    }),
  );

  server.registerTool(
    "mutagen_spending",
    {
      title: "Session spending",
      description:
        "Money spent and budget left in this session, plus the log of paid calls. Free, local.\nТраты и остаток бюджета сессии, журнал платных вызовов. Бесплатно, локально.",
      inputSchema: z.object(tableParams),
      outputSchema,
      annotations: FREE_LOCAL,
    },
    handler(deps, server, "mutagen_spending", async (args, { tool }) => {
      const saveAs = await resolveSaveAs(deps, args);
      const spending = localSpending(deps);
      return toolResult(
        deps,
        tool,
        { table: spendingTable(spending), lines: [budgetLine(spending)] },
        args,
        saveAs,
      );
    }),
  );

  server.registerTool(
    "mutagen_estimate",
    {
      title: "Cost estimate",
      description:
        "Cost of a plan: phrases × match types, competition checks, Mega-tool reports. Free, local; ignores cache and free repeats, so a tool's own dry_run is exact.\nСмета плана вызовов. Бесплатно, локально; точная смета — dry_run самого инструмента.",
      inputSchema: z.object({ calls: z.array(planCall).min(1).describe("Planned calls") }),
      outputSchema,
      annotations: FREE_LOCAL,
    },
    handler(deps, server, "mutagen_estimate", async (args, { tool }) => {
      const estimate = estimatePlan(args.calls.map(plannedCall), resolvePrices(deps.config.prices));
      const spending = localSpending(deps);
      const fits =
        estimate.totalRub <= spending.remainingRub
          ? "Укладывается в остаток бюджета / Fits the budget."
          : "Больше остатка бюджета сессии / Exceeds the remaining budget.";
      return toolResult(
        deps,
        tool,
        {
          table: estimateTable(estimate),
          lines: [estimateLine(estimate), fits, budgetLine(spending)],
        },
        {},
        undefined,
      );
    }),
  );

  server.registerTool(
    "mutagen_mass_tasks",
    {
      title: "Mass parser jobs",
      description:
        "List of Mutagen mass parser jobs with status. Free.\nСписок массовых заданий парсера. Бесплатно.\nNext / Дальше: mutagen_mass_result with an id.",
      inputSchema: z.object(tableParams),
      outputSchema,
      annotations: FREE_READ,
    },
    handler(deps, server, "mutagen_mass_tasks", async (args, { ctx, tool }) => {
      const saveAs = await resolveSaveAs(deps, args);
      const { tasks } = await deps.session().massTasks({ signal: ctx.mcpReq.signal });
      return toolResult(deps, tool, { table: massTasksTable(tasks) }, args, saveAs);
    }),
  );

  server.registerTool(
    "mutagen_mass_result",
    {
      title: "Mass job result",
      description:
        "Result of a mass parser job by id. Free.\nРезультат массового задания по id. Бесплатно.",
      inputSchema: z.object({
        mass_id: z.number().int().positive().describe("Job id from mutagen_mass_tasks"),
        wait: z.boolean().optional().describe("Wait a little for the job"),
        force_refresh: z.boolean().optional().describe("Ignore the cache"),
        ...tableParams,
      }),
      outputSchema,
      annotations: FREE_READ,
    },
    handler(deps, server, "mutagen_mass_result", async (args, { ctx, tool }) => {
      const saveAs = await resolveSaveAs(deps, args);
      const { massId, result, fromCache } = await deps.session().massResult(args.mass_id, {
        signal: ctx.mcpReq.signal,
        ...(args.wait ? { wait: true, waitUntil: waitUntil(deps) } : {}),
        ...(args.force_refresh ? { forceRefresh: true } : {}),
      });
      return toolResult(
        deps,
        tool,
        {
          table: massResultTable(massId, result),
          fromCache,
          lines: [`Задание / Job ${massId}: ${result.status}`],
        },
        args,
        saveAs,
      );
    }),
  );

  server.registerTool(
    "mutagen_project_keywords",
    {
      title: "Project keywords",
      description:
        "Keywords and clusters of a Favorites project. Free. Id: project page URL (Избранное → project).\nКлючи проекта «Избранного». Бесплатно.",
      inputSchema: z.object({
        project_id: z.number().int().positive(),
        ...tableParams,
      }),
      outputSchema,
      annotations: FREE_READ,
    },
    handler(deps, server, "mutagen_project_keywords", async (args, { ctx, tool }) => {
      const saveAs = await resolveSaveAs(deps, args);
      const { keywords } = await deps
        .session()
        .projectKeywords(args.project_id, { signal: ctx.mcpReq.signal });
      return toolResult(
        deps,
        tool,
        { table: projectKeywordsTable(args.project_id, keywords) },
        args,
        saveAs,
      );
    }),
  );
}
