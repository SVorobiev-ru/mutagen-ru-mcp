import type { ExportColumn, ExportMeta, ExportTable } from "../export/types.js";

export type TableMeta = Partial<ExportMeta> & { warnings?: string[] };

export interface ResultTable extends ExportTable {
  columns: readonly ExportColumn[];
  rows: Record<string, unknown>[];
  meta: TableMeta;
}

export function table(
  columns: readonly ExportColumn[],
  rows: Record<string, unknown>[],
  meta: TableMeta = {},
): ResultTable {
  const warnings = meta.warnings?.filter((warning) => warning !== "") ?? [];
  const { warnings: _, ...rest } = meta;
  return { columns, rows, meta: warnings.length > 0 ? { ...rest, warnings } : rest };
}

export function rawTable(value: unknown, warning: string, meta: TableMeta = {}): ResultTable {
  return table(
    [{ key: "raw", title: "Данные (JSON)", type: "string" }],
    [{ raw: JSON.stringify(value) ?? "" }],
    { ...meta, warnings: [...(meta.warnings ?? []), warning] },
  );
}
