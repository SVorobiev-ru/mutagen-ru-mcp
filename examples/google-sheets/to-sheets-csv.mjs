#!/usr/bin/env node
// JSON-выгрузка mutagen-ru → CSV с запятыми для IMPORTDATA в Google Таблицах.
//
//   mutagen-ru core "натяжные потолки" --budget 20 --yes -o core.json
//   node to-sheets-csv.mjs core.json core.sheets.csv
//
// IMPORTDATA понимает только CSV с запятыми или TSV, а CSV из CLI сделан для русского Excel
// (разделитель «;», десятичная запятая). Скрипт без зависимостей.

import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("Usage: node to-sheets-csv.mjs <export.json> <out.csv>");
  process.exit(2);
}

const { columns, rows } = JSON.parse(readFileSync(input, "utf8"));

function cell(value) {
  if (value === null || value === undefined) return "";
  let text = typeof value === "boolean" ? (value ? "да" : "нет") : String(value);
  if (/^[=+\-@]/.test(text) && typeof value === "string") text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const lines = [
  columns.map((column) => cell(column.title ?? column.key)).join(","),
  ...rows.map((row) => columns.map((column) => cell(row[column.key])).join(",")),
  "",
  cell("Данные: Мутаген (mutagen.ru)"),
];
writeFileSync(output, `${lines.join("\n")}\n`);
console.log(`${rows.length} rows → ${output}`);
