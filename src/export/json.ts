import { resolveColumns, resolveMeta } from "./table.js";
import type { ExportTable } from "./types.js";

export interface JsonOptions {
  ndjson?: boolean;
}

export function toJson(table: ExportTable, opts: JsonOptions = {}): string {
  const meta = resolveMeta(table);
  if (opts.ndjson) {
    return `${[meta, ...table.rows].map((item) => JSON.stringify(item)).join("\n")}\n`;
  }
  return `${JSON.stringify({ meta, columns: resolveColumns(table), rows: table.rows }, null, 2)}\n`;
}
