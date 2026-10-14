import type { Row, Cell as SheetCell } from "write-excel-file/node";
import { type Cell, prepareTable, SOURCE_NOTE, yesNo } from "./table.js";
import type { ColumnType, ExportTable } from "./types.js";

const DATE_FORMAT = "dd.mm.yyyy";
const DATE_TIME_FORMAT = "dd.mm.yyyy hh:mm";
const MIN_WIDTH = 8;
const MAX_WIDTH = 60;

function fitWidth(length: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, length + 2));
}

function displayLength(cell: Cell): number {
  if (cell === null) return 0;
  if (cell instanceof Date) return DATE_TIME_FORMAT.length;
  if (typeof cell === "boolean") return yesNo(cell).length;
  return String(cell).length;
}

function sheetCell(cell: Cell, type: ColumnType | undefined): SheetCell {
  let value = cell;
  if (type === "date" && typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) value = parsed;
  }
  if (typeof value === "boolean") return yesNo(value);
  if (value instanceof Date) {
    const midnight = value.getTime() % 86_400_000 === 0;
    return { value, type: Date, format: midnight ? DATE_FORMAT : DATE_TIME_FORMAT };
  }
  return value;
}

export async function toXlsx(table: ExportTable): Promise<Buffer> {
  const { default: writeExcelFile } = await import("write-excel-file/node");
  const { columns, headers, rows, meta } = prepareTable(table);

  const lengths = headers.map((header) => header.length);
  for (const row of rows) {
    for (const [index, cell] of row.entries()) {
      lengths[index] = Math.max(lengths[index] ?? 0, displayLength(cell));
    }
  }
  const data: Row[] = [
    headers.map((header) => ({ value: header, fontWeight: "bold" as const })),
    ...rows.map((row) => row.map((cell, index) => sheetCell(cell, columns[index]?.type))),
  ];

  const details: [string, string][] = [
    ["Источник", meta.source],
    ["Сформировано", meta.generatedAt],
  ];
  if (meta.query !== undefined) details.push(["Запрос", meta.query]);
  if (meta.region !== undefined) details.push(["Регион", meta.region]);
  const sourceData: Row[] = [
    ...details.map(([label, value]): Row => [{ value: label, fontWeight: "bold" }, value]),
    [null],
    [SOURCE_NOTE],
  ];

  return writeExcelFile([
    {
      data,
      sheet: "Данные",
      columns: lengths.map((length) => ({ width: fitWidth(length) })),
      stickyRowsCount: 1,
    },
    {
      data: sourceData,
      sheet: "Источник",
      columns: [
        { width: fitWidth(Math.max(...details.map(([label]) => label.length))) },
        { width: fitWidth(Math.max(...details.map(([, value]) => value.length))) },
      ],
    },
  ]).toBuffer();
}
