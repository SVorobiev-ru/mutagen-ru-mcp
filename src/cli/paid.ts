import { createInterface } from "node:readline/promises";
import type { Estimate } from "../budget/estimate.js";
import { BudgetError } from "../budget/guard.js";
import { estimateLine, rub } from "../mcp/respond.js";
import type { DryRunResult, MutagenSession, PaidCallOptions } from "../session.js";
import { estimateTable } from "../tables/lists.js";
import type { CliContext } from "./context.js";
import { CliError, EXIT } from "./errors.js";
import { type CliOutcome, emit, textTable } from "./output.js";

interface Executed {
  dryRun: false;
  estimate: Estimate;
  warnings?: string[];
}

const YES = ["y", "yes", "д", "да"];

async function ask(ctx: CliContext, question: string): Promise<string> {
  ctx.io.stderr.write(question);
  const rl = createInterface({ input: ctx.io.stdin, terminal: false });
  try {
    const closed = new Promise<string>((resolve) => rl.once("close", () => resolve("")));
    const answer = rl.question("", ctx.signal ? { signal: ctx.signal } : {});
    return await Promise.race([answer, closed]);
  } finally {
    rl.close();
  }
}

async function confirm(ctx: CliContext, label: string, error: BudgetError): Promise<boolean> {
  if (ctx.opts.yes) return true;
  if (!ctx.io.stdinIsTTY || !ctx.io.stdoutIsTTY) {
    throw new CliError(
      EXIT.confirm,
      `Нужно подтверждение траты: ${error.hintRu}\n${estimateLine(error.estimate)}\nДобавьте --yes, чтобы подтвердить смету, или --dry-run, чтобы только посмотреть ее. Запрос к API не отправлялся.`,
      `Confirmation required: ${error.hintEn} Add --yes to approve the estimate or --dry-run to only see it. Nothing was sent to the API.`,
    );
  }
  const { estimate } = error;
  const warnings = estimate.warnings.map((warning) => `${warning}\n`).join("");
  const spending = ctx.session().spending();
  const preview = estimateTable(estimate);
  const answer = await ask(
    ctx,
    [
      `${label}: смета ${rub(estimate.totalRub)}, остаток бюджета ${rub(spending.remainingRub)}.`,
      textTable(preview.columns, preview.rows),
      `${warnings}Продолжить? / Continue? [y/N] `,
    ].join("\n"),
  );
  return YES.includes(answer.trim().toLowerCase());
}

export async function runPaid<T extends Executed>(
  ctx: CliContext,
  label: string,
  call: (session: MutagenSession, options: PaidCallOptions) => Promise<T | DryRunResult>,
  render: (result: T) => CliOutcome,
  local = false,
): Promise<void> {
  const session = ctx.session(local);
  const options = ctx.paidOptions();
  let result: T | DryRunResult;
  try {
    result = await call(session, options);
  } catch (error) {
    if (!(error instanceof BudgetError) || error.kind !== "needs_confirmation") throw error;
    if (!(await confirm(ctx, label, error))) {
      throw new CliError(
        EXIT.confirm,
        `Отменено: трата ${rub(error.estimate.totalRub)} не подтверждена, запрос к API не отправлялся.`,
        "Cancelled: spending was not confirmed, nothing was sent to the API.",
      );
    }
    result = await call(session, { ...options, confirmToken: error.confirmToken ?? "" });
  }
  if (result.dryRun) {
    await emit(ctx, {
      table: estimateTable(result.estimate),
      status: "dry_run",
      estimate: result.estimate,
      spending: session.spending(),
      ...(result.warnings ? { warnings: result.warnings } : {}),
      lines: [
        `${label}: --dry-run, API не вызывалось / nothing was called.`,
        estimateLine(result.estimate),
      ],
    });
    return;
  }
  const outcome = render(result);
  const spending = session.spending();
  await emit(ctx, {
    ...outcome,
    estimate: result.estimate,
    spending,
    spentRub: spending.spentRub,
    warnings: [...(outcome.warnings ?? []), ...(result.warnings ?? [])],
  });
}
