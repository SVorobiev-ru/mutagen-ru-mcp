import { CommanderError } from "commander";
import { BudgetError } from "../budget/guard.js";
import { MutagenError } from "../core/errors.js";
import { SUBSCRIPTION_URL } from "../mcp/links.js";
import { estimateLine } from "../mcp/respond.js";

export const EXIT = {
  ok: 0,
  api: 1,
  usage: 2,
  confirm: 3,
  budget: 4,
  interrupted: 130,
} as const;

export class CliError extends Error {
  override readonly name = "CliError";
  readonly exitCode: number;
  readonly hintRu: string;
  readonly hintEn: string;

  constructor(exitCode: number, hintRu: string, hintEn: string) {
    super(hintEn);
    this.exitCode = exitCode;
    this.hintRu = hintRu;
    this.hintEn = hintEn;
  }
}

export function usageError(hintRu: string, hintEn: string): CliError {
  return new CliError(EXIT.usage, hintRu, hintEn);
}

const BUDGET_NEXT: Readonly<Record<string, string>> = {
  free_only:
    "Бесплатно доступны: balance, spending, estimate, projects <id>, mass; --dry-run показывает смету. Free commands: balance, spending, estimate, projects <id>, mass.",
  over_budget:
    "Посмотрите смету через --dry-run и сократите запрос либо увеличьте MUTAGEN_BUDGET_RUB (флаг --budget может только уменьшить бюджет). Use --dry-run and shrink the request, or raise MUTAGEN_BUDGET_RUB (--budget can only lower it).",
  low_balance: "Пополните баланс и повторите. Top up and retry.",
};

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  if (error instanceof MutagenError) return error.kind === "aborted";
  return error instanceof Error && error.name === "AbortError";
}

export interface Failure {
  exitCode: number;
  text: string;
}

export function describeError(error: unknown, signal?: AbortSignal): Failure {
  if (error instanceof CommanderError) {
    return { exitCode: error.exitCode === 0 ? EXIT.ok : EXIT.usage, text: "" };
  }
  if (isAbort(error, signal)) {
    return {
      exitCode: EXIT.interrupted,
      text: "Прервано (Ctrl+C), ожидание задач остановлено. Повтор той же команды бесплатно подхватит созданные задачи. Interrupted; repeat the command to pick the tasks up for free.",
    };
  }
  if (error instanceof CliError) {
    return { exitCode: error.exitCode, text: `${error.hintRu}\n${error.hintEn}` };
  }
  if (error instanceof BudgetError) {
    const lines = [error.hintRu, error.hintEn, estimateLine(error.estimate)];
    const next = BUDGET_NEXT[error.kind];
    if (next) lines.push(next);
    const exitCode = error.kind === "needs_confirmation" ? EXIT.confirm : EXIT.budget;
    return { exitCode, text: lines.join("\n") };
  }
  if (error instanceof MutagenError) {
    const lines = [error.hintRu, error.hintEn];
    if (error.code === 111) {
      lines.push(
        `Нужна подписка на Мега-инструмент (${SUBSCRIPTION_URL}); без подписки: mutagen-ru keywords / freq. A Mega-tool subscription is required.`,
      );
    }
    if (error.code !== undefined) {
      lines.push(`Код ошибки API Мутагена / API error code: ${error.code}.`);
    } else if (error.kind !== "validation" && error.kind !== "auth") {
      lines.push(error.message);
    }
    const exitCode =
      error.kind === "validation" ? EXIT.usage : error.kind === "balance" ? EXIT.budget : EXIT.api;
    return { exitCode, text: lines.join("\n") };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { exitCode: EXIT.api, text: `Внутренняя ошибка / Internal error: ${message}` };
}

export function debugEnabled(value: string | undefined): boolean {
  return (value ?? "")
    .split(/[\s,]+/)
    .some((name) => name === "mutagen-ru" || name === "mutagen-ru*" || name === "*");
}
