import {
  acceptedContent,
  type CallToolResult,
  type InputRequiredResult,
  inputRequired,
  inputResponse,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Estimate } from "../budget/estimate.js";
import { BudgetError } from "../budget/guard.js";
import { isTaskPending, type TaskPendingError } from "../core/errors.js";
import type { DryRunResult, MutagenSession, PaidCallOptions } from "../session.js";
import { estimateTable } from "../tables/lists.js";
import { table } from "../tables/types.js";
import { type McpDeps, resolveSaveAs, waitUntil } from "./context.js";
import { estimateLine, type Outcome, rub, type TableArgs, toolResult } from "./respond.js";

export interface PaidArgs extends TableArgs {
  dry_run?: boolean | undefined;
  confirm_token?: string | undefined;
  force_refresh?: boolean | undefined;
  new_task?: boolean | undefined;
  save_as?: string | undefined;
  overwrite?: boolean | undefined;
}

export interface ToolEnv {
  deps: McpDeps;
  server: McpServer;
  ctx: ServerContext;
  tool: string;
}

interface Executed {
  dryRun: false;
  estimate: Estimate;
  warnings?: string[];
}

const confirmSchema = z.object({
  confirm: z.boolean().meta({ title: "Подтвердить трату / Confirm spending" }),
});

export function supportsElicitation(server: McpServer): boolean {
  return server.server.getClientCapabilities()?.elicitation?.form !== undefined;
}

function confirmKey(error: BudgetError): string {
  return `confirm_spend_${error.estimate.totalKopecks}`;
}

function elicitMessage(tool: string, error: BudgetError, session: MutagenSession): string {
  const spending = session.spending();
  const warnings =
    error.estimate.warnings.length > 0 ? `\n${error.estimate.warnings.join("\n")}` : "";
  return [
    `Мутаген: ${tool} будет стоить ${rub(error.estimate.totalRub)}. Остаток бюджета сессии: ${rub(spending.remainingRub)}. Подтвердить трату?`,
    `Mutagen: ${tool} will cost ${error.estimate.totalRub.toFixed(2)} RUB. Remaining session budget: ${spending.remainingRub.toFixed(2)} RUB. Confirm spending?${warnings}`,
  ].join("\n");
}

function preview(
  error: BudgetError,
  status: "needs_confirmation" | "cancelled",
  lines: string[],
): Outcome {
  return {
    table: estimateTable(error.estimate),
    status,
    estimate: error.estimate,
    lines,
    ...(status === "needs_confirmation" && error.confirmToken
      ? { confirmToken: error.confirmToken }
      : {}),
  };
}

function needsConfirmation(error: BudgetError): Outcome {
  return preview(error, "needs_confirmation", [
    `Нужно подтверждение траты. ${error.hintRu}`,
    estimateLine(error.estimate),
    `confirm_token: ${error.confirmToken ?? ""} (до / until ${error.tokenExpiresAt ?? ""})`,
    "Покажите смету пользователю и повторите вызов с теми же параметрами и confirm_token только после его согласия.",
    `Confirmation required. ${error.hintEn} Show the estimate to the user and repeat the same call with confirm_token only after they agree.`,
  ]);
}

function cancelled(error: BudgetError): Outcome {
  return preview(error, "cancelled", [
    `Отменено пользователем: трата ${rub(error.estimate.totalRub)} не подтверждена, запрос к API не отправлялся.`,
    "Cancelled by the user: spending was not confirmed, nothing was sent to the API.",
  ]);
}

function processing(error: TaskPendingError, spentRub: number): Outcome {
  return {
    table: table(
      [{ key: "task", title: "Задача / Task", type: "string" }],
      error.tasks.map((task) => ({ task })),
    ),
    status: "processing",
    lines: [error.hintRu, error.hintEn, `Списано / Charged: ${rub(spentRub)}.`],
    ...(error.warnings.length > 0 ? { warnings: error.warnings } : {}),
  };
}

export async function runPaid<T extends Executed>(
  env: ToolEnv,
  args: PaidArgs,
  call: (session: MutagenSession, options: PaidCallOptions) => Promise<T | DryRunResult>,
  render: (result: T) => Outcome,
  local = false,
): Promise<CallToolResult | InputRequiredResult> {
  const { deps, ctx, server, tool } = env;
  const saveAs = await resolveSaveAs(deps, args);
  const session = deps.session(local);
  const before = session.spending().spentRub;
  const options: PaidCallOptions = {
    signal: ctx.mcpReq.signal,
    waitUntil: waitUntil(deps),
    ...(args.dry_run ? { dryRun: true } : {}),
    ...(args.force_refresh ? { forceRefresh: true } : {}),
    ...(args.new_task ? { newTask: true } : {}),
    ...(args.confirm_token ? { confirmToken: args.confirm_token } : {}),
  };
  const spent = () => Math.round((session.spending().spentRub - before) * 100) / 100;
  const pending = (error: TaskPendingError) => {
    const outcome = processing(error, spent());
    return toolResult(deps, tool, { ...outcome, spending: session.spending() }, args, undefined);
  };
  let result: T | DryRunResult;
  try {
    result = await call(session, options);
  } catch (error) {
    if (isTaskPending(error)) return pending(error);
    if (!(error instanceof BudgetError) || error.kind !== "needs_confirmation") throw error;
    if (!supportsElicitation(server)) {
      return toolResult(deps, tool, needsConfirmation(error), args, undefined);
    }
    const ask = (refused: BudgetError) => {
      const key = confirmKey(refused);
      return inputRequired({
        inputRequests: {
          [key]: inputRequired.elicit({
            message: elicitMessage(tool, refused, session),
            requestedSchema: confirmSchema,
          }),
        },
        requestState: refused.confirmToken ?? "",
      });
    };
    // The answer counts only together with the confirm token the server put into requestState:
    // the guard checks its signature, plan, sum, expiry and single use.
    const key = confirmKey(error);
    const state = ctx.mcpReq.requestState();
    const answer = inputResponse(ctx.mcpReq.inputResponses, key);
    if (answer.kind === "missing" || typeof state !== "string" || state === "") return ask(error);
    const content = acceptedContent(ctx.mcpReq.inputResponses, key, confirmSchema);
    if (content?.confirm !== true) {
      return toolResult(deps, tool, cancelled(error), args, undefined);
    }
    try {
      result = await call(session, { ...options, confirmToken: state });
    } catch (retryError) {
      if (isTaskPending(retryError)) return pending(retryError);
      if (retryError instanceof BudgetError && retryError.kind === "needs_confirmation") {
        return ask(retryError);
      }
      throw retryError;
    }
  }
  if (result.dryRun) {
    return toolResult(
      deps,
      tool,
      {
        table: estimateTable(result.estimate),
        status: "dry_run",
        estimate: result.estimate,
        spending: session.spending(),
        ...(result.warnings ? { warnings: result.warnings } : {}),
        lines: [
          `${tool}: dry_run, API не вызывалось / nothing was called.`,
          estimateLine(result.estimate),
        ],
      },
      args,
      undefined,
    );
  }
  const outcome = render(result);
  const spending = session.spending();
  return toolResult(
    deps,
    tool,
    {
      ...outcome,
      estimate: result.estimate,
      spending,
      spentRub: spent(),
      warnings: [...(outcome.warnings ?? []), ...(result.warnings ?? [])],
    },
    args,
    saveAs,
  );
}
