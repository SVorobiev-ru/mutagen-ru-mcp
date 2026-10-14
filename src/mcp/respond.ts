import { join } from "node:path";
import { type CallToolResult, fromJsonSchema } from "@modelcontextprotocol/server";
import type { Estimate } from "../budget/estimate.js";
import type { Spending } from "../budget/guard.js";
import { SOURCE_NOTE, yesNo } from "../export/table.js";
import type { ExportColumn } from "../export/types.js";
import { writeTable } from "../export/write.js";
import type { ResultTable } from "../tables/types.js";
import type { McpDeps, SaveTarget } from "./context.js";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 200;
const MAX_CELL = 200;

export type ResultStatus = "ok" | "dry_run" | "needs_confirmation" | "cancelled" | "processing";

export interface StructuredResult {
  status: ResultStatus;
  rows: Record<string, unknown>[];
  total: number;
  file?: string;
  estimate?: {
    totalRub: number;
    quotaRequests: number;
    requiresSubscription: boolean;
    unconfirmedPrices: boolean;
  };
  spending?: { budgetRub: number; spentRub: number; remainingRub: number };
  confirm_token?: string;
  warnings?: string[];
  summary?: Record<string, unknown>;
  partial?: boolean;
  source: "mutagen.ru";
}

export const outputSchema = fromJsonSchema<StructuredResult>({
  type: "object",
  properties: {
    status: { enum: ["ok", "dry_run", "needs_confirmation", "cancelled", "processing"] },
    rows: { type: "array" },
    total: { type: "integer" },
  },
  required: ["status", "rows", "total"],
});

export interface TableArgs {
  fields?: string[] | undefined;
  limit?: number | undefined;
}

export interface Outcome {
  table: ResultTable;
  status?: ResultStatus;
  estimate?: Estimate;
  spending?: Spending;
  spentRub?: number;
  fromCache?: boolean;
  lines?: string[];
  warnings?: string[];
  confirmToken?: string;
  summary?: Record<string, unknown>;
  partial?: boolean;
}

export function rub(value: number): string {
  return `${value.toFixed(2)} ₽`;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "boolean"
      ? yesNo(value)
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  const short = text.length > MAX_CELL ? `${text.slice(0, MAX_CELL - 1)}…` : text;
  return short.replace(/\r?\n/g, " ").replaceAll("|", "\\|");
}

export function markdownTable(
  columns: readonly ExportColumn[],
  rows: readonly Record<string, unknown>[],
): string {
  if (columns.length === 0) return "";
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [
    line(columns.map((column) => cellText(column.title ?? column.key))),
    line(columns.map(() => "---")),
    ...rows.map((row) => line(columns.map((column) => cellText(row[column.key])))),
  ].join("\n");
}

function pickColumns(
  columns: readonly ExportColumn[],
  fields: readonly string[] | undefined,
  warnings: string[],
): readonly ExportColumn[] {
  if (!fields?.length) return columns;
  const picked = columns.filter((column) => fields.includes(column.key));
  const unknown = fields.filter((field) => !columns.some((column) => column.key === field));
  if (unknown.length > 0) {
    warnings.push(
      `Нет таких колонок: ${unknown.join(", ")}. Доступны: ${columns.map((column) => column.key).join(", ")}. Unknown fields.`,
    );
  }
  return picked.length > 0 ? picked : columns;
}

function autoFileName(tool: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${tool}-${stamp}.csv`;
}

function spendingSummary(spending: Spending) {
  return {
    budgetRub: spending.budgetRub,
    spentRub: spending.spentRub,
    remainingRub: spending.remainingRub,
  };
}

function estimateSummary(estimate: Estimate) {
  return {
    totalRub: estimate.totalRub,
    quotaRequests: estimate.quotaRequests,
    requiresSubscription: estimate.requiresSubscription,
    unconfirmedPrices: estimate.unconfirmedPrices,
  };
}

export function estimateLine(estimate: Estimate): string {
  const quota = estimate.quotaRequests > 0 ? `, квота: ${estimate.quotaRequests} запр.` : "";
  return `Смета: ${rub(estimate.totalRub)}${quota} / Estimate: ${estimate.totalRub.toFixed(2)} RUB.`;
}

export function budgetLine(spending: Spending): string {
  const quota = spending.quotaRequests > 0 ? `, квота: ${spending.quotaRequests} запр.` : "";
  const mode = spending.freeOnly ? " Режим «только бесплатное»." : "";
  return `Бюджет сессии: потрачено ${rub(spending.spentRub)} из ${rub(spending.budgetRub)}, осталось ${rub(spending.remainingRub)}${quota}.${mode}`;
}

export async function toolResult(
  deps: McpDeps,
  tool: string,
  outcome: Outcome,
  args: TableArgs,
  saveAs: SaveTarget | undefined,
): Promise<CallToolResult> {
  const { table } = outcome;
  const status = outcome.status ?? "ok";
  const warnings = [...new Set([...(table.meta.warnings ?? []), ...(outcome.warnings ?? [])])];
  const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const total = table.rows.length;
  const columns =
    status === "ok" ? pickColumns(table.columns, args.fields, warnings) : table.columns;
  const shown = table.rows.slice(0, limit);

  let file: string | undefined;
  const target =
    saveAs ??
    (total > limit
      ? { path: join(deps.outputDir, autoFileName(tool)), overwrite: false }
      : undefined);
  if (target) {
    try {
      file = (await writeTable(table, target.path, { keepExisting: !target.overwrite })).path;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`Не удалось сохранить файл ${target.path}: ${detail}. File was not saved.`);
    }
  }

  const lines: string[] = [];
  if (status === "ok") {
    const more = total > shown.length ? `, показаны первые ${shown.length}` : "";
    lines.push(`${tool}: ${total} строк${more} / ${total} rows.`);
  }
  lines.push(...(outcome.lines ?? []));
  if (outcome.estimate && status === "ok") {
    const spent =
      outcome.spentRub === undefined ? "" : ` Списано: ${rub(outcome.spentRub)} / charged.`;
    lines.push(`${estimateLine(outcome.estimate)}${spent}`);
  }
  if (outcome.fromCache) lines.push("Из кэша, без затрат / From cache, free.");
  if (outcome.spending) lines.push(budgetLine(outcome.spending));
  if (warnings.length > 0) lines.push(`Предупреждения / Warnings:\n- ${warnings.join("\n- ")}`);
  if (status !== "cancelled" && columns.length > 0) {
    lines.push("", markdownTable(columns, shown), "");
  }
  if (file) lines.push(`Полный результат / Full result: ${file}`);
  if (file && saveAs && file !== saveAs.path) {
    lines.push(
      `Файл ${saveAs.path} уже есть, результат сохранен рядом; заменить — overwrite: true. The file exists, saved next to it.`,
    );
  }
  lines.push(SOURCE_NOTE);

  const keys = columns.map((column) => column.key);
  const structured: StructuredResult = {
    status,
    rows: shown.map((row) => Object.fromEntries(keys.map((key) => [key, row[key] ?? null]))),
    total,
    ...(file ? { file } : {}),
    ...(outcome.estimate ? { estimate: estimateSummary(outcome.estimate) } : {}),
    ...(outcome.spending ? { spending: spendingSummary(outcome.spending) } : {}),
    ...(outcome.confirmToken ? { confirm_token: outcome.confirmToken } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(outcome.summary ? { summary: outcome.summary } : {}),
    ...(outcome.partial ? { partial: true } : {}),
    source: "mutagen.ru",
  };
  return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: structured };
}
