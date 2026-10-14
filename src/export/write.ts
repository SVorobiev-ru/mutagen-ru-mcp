import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { validationError } from "../core/errors.js";
import { type CsvOptions, toCsv } from "./csv.js";
import { type JsonOptions, toJson } from "./json.js";
import type { ExportTable } from "./types.js";
import { toXlsx } from "./xlsx.js";

export type ExportFormat = "csv" | "json" | "ndjson" | "xlsx";

export interface ExportOptions extends CsvOptions, JsonOptions {
  format?: ExportFormat;
  /** Never replace an existing file: write to "name (2).csv", "name (3).csv" and so on. */
  keepExisting?: boolean;
}

export interface WriteResult {
  path: string;
  format: ExportFormat;
  rows: number;
  bytes: number;
}

const FORMAT_BY_EXTENSION: Readonly<Record<string, ExportFormat>> = {
  ".csv": "csv",
  ".json": "json",
  ".ndjson": "ndjson",
  ".xlsx": "xlsx",
};

function resolveFormat(path: string, opts: ExportOptions): ExportFormat {
  const format = opts.format ?? FORMAT_BY_EXTENSION[extname(path).toLowerCase()];
  if (format === undefined) {
    throw validationError(
      `Cannot infer the export format from "${path}"`,
      "Не удалось определить формат выгрузки. Используйте расширение .csv, .json, .ndjson или .xlsx либо укажите формат явно.",
      "Cannot determine the export format. Use a .csv, .json, .ndjson or .xlsx extension or set the format explicitly.",
    );
  }
  return format === "json" && opts.ndjson ? "ndjson" : format;
}

async function render(
  table: ExportTable,
  format: ExportFormat,
  opts: ExportOptions,
): Promise<Uint8Array> {
  switch (format) {
    case "csv":
      return Buffer.from(toCsv(table, opts), "utf8");
    case "json":
      return Buffer.from(toJson(table), "utf8");
    case "ndjson":
      return Buffer.from(toJson(table, { ndjson: true }), "utf8");
    case "xlsx":
      return toXlsx(table);
  }
}

const MAX_COPIES = 1000;

async function writeNew(path: string, data: Uint8Array): Promise<string> {
  const ext = extname(path);
  const stem = basename(path, ext);
  for (let copy = 1; copy <= MAX_COPIES; copy++) {
    const candidate = copy === 1 ? path : join(dirname(path), `${stem} (${copy})${ext}`);
    try {
      await writeFile(candidate, data, { flag: "wx" });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Too many copies of ${path}`);
}

export async function writeTable(
  table: ExportTable,
  filePath: string,
  opts: ExportOptions = {},
): Promise<WriteResult> {
  const path = resolve(filePath);
  const format = resolveFormat(path, opts);
  const data = await render(table, format, opts);
  await mkdir(dirname(path), { recursive: true });
  if (opts.keepExisting) {
    const written = await writeNew(path, data);
    return { path: written, format, rows: table.rows.length, bytes: data.byteLength };
  }
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, data);
    await rename(tmpPath, path);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
  return { path, format, rows: table.rows.length, bytes: data.byteLength };
}
