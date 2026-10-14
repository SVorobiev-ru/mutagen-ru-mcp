import { type Cell, prepareTable, SOURCE_NOTE, yesNo } from "./table.js";
import type { ExportTable } from "./types.js";

export interface CsvOptions {
  delimiter?: ";" | ",";
  bom?: boolean;
  includeSourceNote?: boolean;
  decimalSeparator?: "," | ".";
}

const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const NUMBER_TEXT = /^[+-]?\d+([.,]\d+)?$/;

function cellText(cell: Cell, decimalSeparator: string): string {
  if (cell === null) return "";
  if (typeof cell === "string") {
    if (NUMBER_TEXT.test(cell)) return cell.replace(/[.,]/, decimalSeparator);
    return FORMULA_PREFIX.test(cell) ? `'${cell}` : cell;
  }
  if (typeof cell === "boolean") return yesNo(cell);
  if (cell instanceof Date) return cell.toISOString();
  const text = String(cell);
  return decimalSeparator === "." ? text : text.replace(".", decimalSeparator);
}

function field(cell: Cell, delimiter: string, decimalSeparator: string): string {
  const text = cellText(cell, decimalSeparator);
  return text.includes(delimiter) || /["\r\n]/.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

export function toCsv(table: ExportTable, opts: CsvOptions = {}): string {
  const { delimiter = ";", bom = true, includeSourceNote = true } = opts;
  const decimalSeparator = opts.decimalSeparator ?? (delimiter === ";" ? "," : ".");
  const { headers, rows } = prepareTable(table);
  const line = (cells: readonly Cell[]): string =>
    cells.map((cell) => field(cell, delimiter, decimalSeparator)).join(delimiter);
  const lines = [line(headers), ...rows.map(line)];
  if (includeSourceNote) lines.push("", SOURCE_NOTE);
  return `${bom ? "\uFEFF" : ""}${lines.join("\r\n")}\r\n`;
}
