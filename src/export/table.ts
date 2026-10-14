import type { ColumnType, ExportColumn, ExportMeta, ExportTable } from "./types.js";

export const SOURCE_NOTE = "Данные: Мутаген (mutagen.ru)";

export type Cell = string | number | boolean | Date | null;

export interface PreparedTable {
  columns: ExportColumn[];
  headers: string[];
  rows: Cell[][];
  meta: ExportMeta;
}

export function yesNo(value: boolean): string {
  return value ? "да" : "нет";
}

export function resolveColumns(table: ExportTable): ExportColumn[] {
  if (table.columns?.length) return [...table.columns];
  const keys = new Set<string>();
  for (const row of table.rows) for (const key of Object.keys(row)) keys.add(key);
  return [...keys].map((key) => ({ key }));
}

export function resolveMeta(table: ExportTable): ExportMeta {
  return Object.assign(
    { source: "mutagen.ru", generatedAt: new Date().toISOString() },
    table.meta,
    { source: "mutagen.ru" },
  );
}

function toCell(value: unknown, type: ColumnType | undefined): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (type === "number" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function prepareTable(table: ExportTable): PreparedTable {
  const columns = resolveColumns(table);
  return {
    columns,
    headers: columns.map((column) => column.title ?? column.key),
    rows: table.rows.map((row) =>
      columns.map((column) =>
        toCell(Object.hasOwn(row, column.key) ? row[column.key] : undefined, column.type),
      ),
    ),
    meta: resolveMeta(table),
  };
}
