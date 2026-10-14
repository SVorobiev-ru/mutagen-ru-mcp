export type ColumnType = "string" | "number" | "boolean" | "date";

export interface ExportColumn {
  key: string;
  title?: string;
  type?: ColumnType;
}

export interface ExportMeta {
  source: string;
  generatedAt: string;
  query?: string;
  region?: string;
}

export interface ExportTable {
  columns?: readonly ExportColumn[];
  rows: readonly Record<string, unknown>[];
  meta?: Partial<ExportMeta>;
}
