import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { InvalidArgumentError } from "commander";
import { FREQUENCY_PARSERS, type FrequencyParser } from "../core/types.js";
import { SOURCE_NOTE } from "../export/table.js";
import type { PhraseItem } from "../text/phrases.js";
import { usageError } from "./errors.js";
import { type CliIo, readAll } from "./io.js";

export const TYPE_ALIASES: Readonly<Record<string, FrequencyParser>> = Object.fromEntries(
  FREQUENCY_PARSERS.map((parser) => [parser.replace(/^wordstat_/, ""), parser]),
);

export function positiveInt(value: string): number {
  const number = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(number) || number < 1) {
    throw new InvalidArgumentError("Ожидается целое число больше 0 / Expected a positive integer.");
  }
  return number;
}

export function nonNegativeInt(value: string): number {
  const number = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(number)) {
    throw new InvalidArgumentError("Ожидается целое число от 0 / Expected a non-negative integer.");
  }
  return number;
}

export function depth(value: string): 200 | 2000 {
  if (value === "200" || value === "2000") return Number(value) as 200 | 2000;
  throw new InvalidArgumentError("Допустимо 200 или 2000 / Use 200 or 2000.");
}

export function rubles(value: string): number {
  const text = value.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new InvalidArgumentError(
      "Ожидается сумма в рублях, например 30 или 12,5 / Expected an amount in RUB.",
    );
  }
  return Number(text);
}

export function parseTypes(value: string): FrequencyParser[] {
  const names = value
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");
  const types: FrequencyParser[] = [];
  for (const name of names) {
    const parser = TYPE_ALIASES[name] ?? FREQUENCY_PARSERS.find((full) => full === name);
    if (!parser) {
      throw new InvalidArgumentError(
        `Неизвестный вид частотности «${name}». Допустимо: ${Object.keys(TYPE_ALIASES).join(", ")}. Unknown match type.`,
      );
    }
    if (!types.includes(parser)) types.push(parser);
  }
  if (types.length === 0) {
    throw new InvalidArgumentError("Укажите хотя бы один вид / Specify at least one match type.");
  }
  return types;
}

export function phraseLines(text: string): string[] {
  return text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

export async function readListFile(io: CliIo, file: string): Promise<string[]> {
  if (file === "-") return phraseLines(await readAll(io.stdin));
  try {
    return phraseLines(await readFile(resolve(io.cwd ?? process.cwd(), file), "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw usageError(
      `Не удалось прочитать файл ${file}: ${detail}`,
      `Cannot read the file ${file}.`,
    );
  }
}

export async function readPhrases(
  io: CliIo,
  args: readonly string[],
  file: string | undefined,
): Promise<string[]> {
  const phrases = args.map((phrase) => phrase.trim()).filter((phrase) => phrase !== "");
  if (file !== undefined) phrases.push(...(await readListFile(io, file)));
  else if (phrases.length === 0 && !io.stdinIsTTY) {
    phrases.push(...phraseLines(await readAll(io.stdin)));
  }
  if (phrases.length === 0) {
    throw usageError(
      "Нет фраз: передайте их аргументами, файлом -i phrases.txt (по фразе в строке) или через stdin.",
      "No phrases: pass them as arguments, with -i phrases.txt (one per line) or via stdin.",
    );
  }
  return phrases;
}

export function listOption(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

export function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

const PHRASE_HEADERS = ["phrase", "фраза", "keyword", "ключ", "запрос"];
const FREQUENCY_HEADERS = ["frequency", "частота", "частотность"];
const DELIMITERS = [";", "\t", ","] as const;

export function splitCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string;
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === "") {
      quoted = true;
    } else if (char === delimiter) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells.map((item) => item.trim());
}

function cellNumber(value: string | undefined): number | undefined {
  const text = (value ?? "").replace(/[\s\u00a0]/g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(text)) return undefined;
  return Number(text);
}

function unprotect(value: string): string {
  return /^'[=+\-@]/.test(value) ? value.slice(1) : value;
}

/**
 * Phrases from text: one per line, or CSV with a phrase/фраза column and an optional
 * frequency/частота column; the delimiter («;», tab or «,») is detected from the header.
 */
export function parsePhraseText(text: string, csv = false): PhraseItem[] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && line !== SOURCE_NOTE);
  const first = lines[0];
  if (first === undefined) return [];
  const delimiter = DELIMITERS.find((item) => first.includes(item));
  const header = delimiter ? splitCsvLine(first, delimiter).map((cell) => cell.toLowerCase()) : [];
  const named = header.findIndex((cell) => PHRASE_HEADERS.includes(cell));
  if (delimiter === undefined || (!csv && named === -1)) {
    return lines.map((phrase) => ({ phrase }));
  }
  const exact = header.findIndex((cell) => FREQUENCY_HEADERS.includes(cell));
  const frequencyColumn =
    exact !== -1
      ? exact
      : header.findIndex((cell) => cell.includes("частот") || cell.includes("frequency"));
  const hasHeader = named !== -1 || frequencyColumn !== -1 || cellNumber(header[1]) === undefined;
  const phraseColumn = named === -1 ? 0 : named;
  const items: PhraseItem[] = [];
  for (const line of hasHeader ? lines.slice(1) : lines) {
    const cells = splitCsvLine(line, delimiter);
    const phrase = unprotect(cells[phraseColumn] ?? "");
    if (phrase === "") continue;
    const frequency =
      frequencyColumn === -1 ? cellNumber(cells[1]) : cellNumber(cells[frequencyColumn]);
    items.push(frequency === undefined ? { phrase } : { phrase, frequency });
  }
  return items;
}

export async function readPhraseFile(io: CliIo, file: string): Promise<PhraseItem[]> {
  if (file === "-") return parsePhraseText(await readAll(io.stdin));
  try {
    const text = await readFile(resolve(io.cwd ?? process.cwd(), file), "utf8");
    return parsePhraseText(text, extname(file).toLowerCase() === ".csv");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw usageError(
      `Не удалось прочитать файл ${file}: ${detail}`,
      `Cannot read the file ${file}.`,
    );
  }
}

/** Phrases with optional frequencies from arguments, -i files or stdin. */
export async function readPhraseItems(
  io: CliIo,
  args: readonly string[],
  files: readonly string[] | undefined,
  required = true,
): Promise<PhraseItem[]> {
  const items: PhraseItem[] = args
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase !== "")
    .map((phrase) => ({ phrase }));
  for (const file of files ?? []) items.push(...(await readPhraseFile(io, file)));
  if (items.length === 0 && !files?.length && !io.stdinIsTTY && required) {
    items.push(...parsePhraseText(await readAll(io.stdin)));
  }
  if (items.length === 0 && required) {
    throw usageError(
      "Нет фраз: передайте их аргументами, файлом -i (txt по строке или csv с колонкой «фраза») или через stdin.",
      "No phrases: pass them as arguments, with -i (txt, one per line, or csv with a phrase column) or via stdin.",
    );
  }
  return items;
}
