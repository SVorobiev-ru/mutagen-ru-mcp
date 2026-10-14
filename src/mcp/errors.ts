import type { CallToolResult } from "@modelcontextprotocol/server";
import { BudgetError } from "../budget/guard.js";
import { MutagenError } from "../core/errors.js";
import { redactSecret } from "../core/transport.js";
import { SOURCE_NOTE } from "../export/table.js";
import { SUBSCRIPTION_URL } from "./links.js";
import { estimateLine } from "./respond.js";

const FREE_TOOLS =
  "mutagen_balance, mutagen_spending, mutagen_estimate, mutagen_project_keywords, mutagen_mass_tasks, mutagen_mass_result";

const NEXT_STEP: Readonly<Record<string, string>> = {
  free_only: `Бесплатно доступны: ${FREE_TOOLS}; dry_run показывает смету без вызова. Free tools: ${FREE_TOOLS}.`,
  over_budget:
    "Посмотрите смету через dry_run и сократите запрос либо попросите пользователя поднять MUTAGEN_BUDGET_RUB. Use dry_run and shrink the request, or ask the user to raise the budget.",
  low_balance:
    "Попросите пользователя пополнить баланс и повторите вызов. Ask the user to top up and retry.",
};

function errorText(error: unknown): string {
  if (error instanceof BudgetError) {
    return [error.hintRu, error.hintEn, estimateLine(error.estimate), NEXT_STEP[error.kind] ?? ""]
      .filter((line) => line !== "")
      .join("\n");
  }
  if (error instanceof MutagenError) {
    const lines = [error.hintRu, error.hintEn];
    if (error.code === 111) {
      lines.push(
        `Нужна подписка на Мега-инструмент (${SUBSCRIPTION_URL}); бесплатная альтернатива без подписки: mutagen_wordstat_keywords / mutagen_frequency. A Mega-tool subscription is required; alternatives without it: mutagen_wordstat_keywords / mutagen_frequency.`,
      );
    }
    if (error.code !== undefined)
      lines.push(`Код ошибки API Мутагена / API error code: ${error.code}.`);
    else if (error.kind !== "validation" && error.kind !== "auth") lines.push(error.message);
    return lines.join("\n");
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Внутренняя ошибка / Internal error: ${message}`;
}

export function errorResult(error: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: `${errorText(error)}\n${SOURCE_NOTE}` }],
    isError: true,
  };
}

export function redactResult<T>(result: T, secret: string | undefined): T {
  if (!secret) return result;
  const json = JSON.stringify(result);
  const clean = redactSecret(json, secret);
  return clean === json ? result : (JSON.parse(clean) as T);
}
