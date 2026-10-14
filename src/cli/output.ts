import type { Estimate } from "../budget/estimate.js";
import type { Spending } from "../budget/guard.js";
import { toCsv } from "../export/csv.js";
import { toJson } from "../export/json.js";
import { SOURCE_NOTE, yesNo } from "../export/table.js";
import type { ExportColumn } from "../export/types.js";
import { writeTable } from "../export/write.js";
import { budgetLine, estimateLine, rub, type StructuredResult } from "../mcp/respond.js";
import type { ResultTable } from "../tables/types.js";
import { type CliContext, DEFAULT_TABLE_LIMIT, type StdoutFormat } from "./context.js";
import { CliError, EXIT } from "./errors.js";

const MAX_CELL = 60;

export interface CliOutcome {
  table: ResultTable;
  status?: "ok" | "dry_run";
  estimate?: Estimate;
  spending?: Spending;
  spentRub?: number;
  fromCache?: boolean;
  lines?: string[];
  warnings?: string[];
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "boolean"
      ? yesNo(value)
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  const flat = text.replace(/\s*\r?\n\s*/g, " ");
  const chars = [...flat];
  return chars.length > MAX_CELL ? `${chars.slice(0, MAX_CELL - 1).join("")}…` : flat;
}

export function textTable(
  columns: readonly ExportColumn[],
  rows: readonly Record<string, unknown>[],
): string {
  if (columns.length === 0) return "";
  const header = columns.map((column) => column.title ?? column.key);
  const body = rows.map((row) => columns.map((column) => cellText(row[column.key])));
  const widths = header.map((title, index) =>
    Math.max([...title].length, ...body.map((cells) => [...(cells[index] ?? "")].length)),
  );
  const numeric = columns.map((column) => {
    if (column.type === "number") return true;
    const values = rows.map((row) => row[column.key]).filter((value) => value != null);
    return values.length > 0 && values.every((value) => typeof value === "number");
  });
  const pad = (text: string, index: number) => {
    const fill = " ".repeat(Math.max(0, (widths[index] ?? 0) - [...text].length));
    return numeric[index] ? fill + text : text + fill;
  };
  const line = (cells: string[]) => cells.map(pad).join("  ").replace(/\s+$/, "");
  return [
    line(header),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...body.map(line),
  ].join("\n");
}

function stdoutFormat(ctx: CliContext): StdoutFormat | "structured" | "none" {
  if (ctx.opts.json) return "structured";
  if (ctx.opts.format) return ctx.opts.format;
  if (ctx.io.stdoutIsTTY) return "table";
  return ctx.outputPath ? "none" : "csv";
}

function structured(
  outcome: CliOutcome,
  rows: Record<string, unknown>[],
  file: string | undefined,
  warnings: string[],
): StructuredResult {
  const { estimate, spending } = outcome;
  return {
    status: outcome.status ?? "ok",
    rows,
    total: outcome.table.rows.length,
    ...(file ? { file } : {}),
    ...(estimate
      ? {
          estimate: {
            totalRub: estimate.totalRub,
            quotaRequests: estimate.quotaRequests,
            requiresSubscription: estimate.requiresSubscription,
            unconfirmedPrices: estimate.unconfirmedPrices,
          },
        }
      : {}),
    ...(spending
      ? {
          spending: {
            budgetRub: spending.budgetRub,
            spentRub: spending.spentRub,
            remainingRub: spending.remainingRub,
          },
        }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    source: "mutagen.ru",
  };
}

export async function emit(ctx: CliContext, outcome: CliOutcome): Promise<void> {
  const { table } = outcome;
  const status = outcome.status ?? "ok";
  const warnings = [...new Set([...(table.meta.warnings ?? []), ...(outcome.warnings ?? [])])];
  const total = table.rows.length;

  let file: string | undefined;
  let saveError: CliError | undefined;
  if (ctx.outputPath && status === "ok") {
    try {
      file = (await writeTable(table, ctx.outputPath)).path;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      saveError = new CliError(
        EXIT.api,
        `Не удалось сохранить файл ${ctx.outputPath}: ${detail}. Результат выведен в stdout.`,
        "The file was not saved; the result was printed to stdout.",
      );
    }
  }

  let format = stdoutFormat(ctx);
  if (format === "none" && saveError) format = "csv";
  const limit = ctx.opts.limit ?? (format === "table" ? DEFAULT_TABLE_LIMIT : total);
  const rows = table.rows.slice(0, limit);

  for (const line of outcome.lines ?? []) ctx.info(line);
  if (outcome.estimate && status === "ok") {
    const spent =
      outcome.spentRub === undefined ? "" : ` Списано: ${rub(outcome.spentRub)} / charged.`;
    ctx.info(`${estimateLine(outcome.estimate)}${spent}`);
  }
  if (outcome.fromCache) ctx.info("Из кэша, без затрат / From cache, free.");
  if (outcome.spending) ctx.info(budgetLine(outcome.spending));
  for (const warning of warnings) ctx.info(`Предупреждение / Warning: ${warning}`);

  const shown = { ...table, rows };
  switch (format) {
    case "structured": {
      const keys = table.columns.map((column) => column.key);
      const picked = rows.map((row) =>
        Object.fromEntries(keys.map((key) => [key, row[key] ?? null])),
      );
      ctx.out(`${JSON.stringify(structured(outcome, picked, file, warnings), null, 2)}\n`);
      break;
    }
    case "json":
      ctx.out(toJson(shown));
      break;
    case "csv":
      ctx.out(toCsv(shown, { bom: false }));
      break;
    case "table": {
      if (table.columns.length > 0) ctx.out(`${textTable(table.columns, rows)}\n`);
      const more = total > rows.length ? `, показано ${rows.length}` : "";
      ctx.out(`${total} строк${more} / ${total} rows.\n`);
      break;
    }
    case "none":
      break;
  }
  if (file) ctx.info(`Сохранено / Saved: ${file} (${total} строк)`);
  if (format === "table" || (format === "none" && !ctx.opts.quiet)) {
    ctx.io.stderr.write(`${SOURCE_NOTE}\n`);
  }
  if (saveError) throw saveError;
}
