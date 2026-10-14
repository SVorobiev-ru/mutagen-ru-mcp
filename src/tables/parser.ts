import { FREQUENCY_PARSERS, type FrequencyParser, type ParserType } from "../core/types.js";
import type { ExportColumn } from "../export/types.js";
import type { ParserPart, ParserRunResult } from "../session.js";
import {
  flatten,
  frequencyOf,
  isRecord,
  normalizeMassData,
  phraseKey,
  toNumber,
  UNRECOGNIZED_WARNING,
} from "./mass.js";
import { type ResultTable, rawTable, table } from "./types.js";

export const FREQUENCY_TITLES: Readonly<Record<FrequencyParser, string>> = {
  wordstat_n: "Базовая",
  wordstat_q: '"Фразовая"',
  wordstat_qs: '"!Точная"',
  wordstat_no: "[Порядок]",
  wordstat_qo: '"[Фразовая с порядком]"',
  wordstat_qso: '"[!Точная с порядком]"',
};

const PHRASE_COLUMN: ExportColumn = { key: "phrase", title: "Фраза", type: "string" };
const REGION_COLUMN: ExportColumn = { key: "region", title: "Регион", type: "string" };

function isFrequencyParser(parser: ParserType): parser is FrequencyParser {
  return (FREQUENCY_PARSERS as readonly string[]).includes(parser);
}

function partValues(part: ParserPart): Map<string, { phrase: string; value: unknown }> | undefined {
  const values = new Map<string, { phrase: string; value: unknown }>();
  if (part.via === "parser.get") {
    for (const phrase of part.phrases) {
      values.set(phraseKey(phrase), { phrase, value: part.data[phrase] ?? null });
    }
    return values;
  }
  const data = normalizeMassData(part.result.data);
  if (!data.recognized) return undefined;
  for (const entry of data.entries) values.set(phraseKey(entry.phrase), entry);
  return values;
}

function rawParts(result: ParserRunResult): ResultTable {
  return rawTable(
    result.parts.map((part) => ({
      parser: part.parser,
      ...(part.via === "parser.mass" ? { mass_id: part.massId, data: part.result.data } : {}),
    })),
    UNRECOGNIZED_WARNING,
    { region: result.region },
  );
}

function orderedRows(
  phrases: readonly string[],
  found: Iterable<{ phrase: string }>,
): Map<string, Record<string, unknown>> {
  const rows = new Map<string, Record<string, unknown>>();
  for (const phrase of phrases) rows.set(phraseKey(phrase), { phrase });
  for (const { phrase } of found) {
    if (!rows.has(phraseKey(phrase))) rows.set(phraseKey(phrase), { phrase });
  }
  return rows;
}

export function frequencyTable(result: ParserRunResult): ResultTable {
  const parts = result.parts.filter((part) => isFrequencyParser(part.parser));
  const values = parts.map(partValues);
  if (values.some((value) => value === undefined)) return rawParts(result);
  const maps = values as Map<string, { phrase: string; value: unknown }>[];
  const phrases = parts[0]?.phrases ?? [];
  const rows = orderedRows(
    phrases,
    maps.flatMap((map) => [...map.values()]),
  );
  for (const [index, part] of parts.entries()) {
    const map = maps[index] as Map<string, { phrase: string; value: unknown }>;
    for (const [key, row] of rows) {
      const entry = map.get(key);
      row[part.parser] = entry ? frequencyOf(entry.value, part.parser) : null;
    }
  }
  for (const row of rows.values()) row.region = result.region;
  const used = FREQUENCY_PARSERS.filter((parser) => parts.some((part) => part.parser === parser));
  return table(
    [
      PHRASE_COLUMN,
      ...used.map((parser) => ({
        key: parser,
        title: FREQUENCY_TITLES[parser],
        type: "number" as const,
      })),
      REGION_COLUMN,
    ],
    [...rows.values()],
    { region: result.region, ...(result.warnings ? { warnings: result.warnings } : {}) },
  );
}

function wordstatEntry(part: ParserPart): unknown {
  const values = partValues(part);
  if (!values) return undefined;
  const seed = part.phrases[0] ?? "";
  return (
    values.get(phraseKey(seed))?.value ??
    (values.size === 1 ? [...values.values()][0]?.value : null)
  );
}

export function wordstatKeywordsTable(result: ParserRunResult): ResultTable {
  const part = result.parts[0];
  const seed = part?.phrases[0] ?? "";
  const meta = {
    query: seed,
    region: result.region,
    ...(result.warnings ? { warnings: result.warnings } : {}),
  };
  const value = part ? wordstatEntry(part) : null;
  if (value === undefined) return rawParts(result);
  const columns: ExportColumn[] = [
    PHRASE_COLUMN,
    { key: "frequency", title: "Частотность", type: "number" },
  ];
  if (value === null) return table(columns, [], meta);
  if (!isRecord(value) || !isRecord(value.array)) {
    return rawTable(value, UNRECOGNIZED_WARNING, meta);
  }
  const rows = Object.entries(value.array).map(([phrase, frequency]) => ({
    phrase,
    frequency: toNumber(frequency),
  }));
  return table(columns, rows, meta);
}

const POSITION_TITLES: Readonly<Record<string, string>> = {
  first_premium: "1-е спецразмещение",
  second_premium: "2-е спецразмещение",
  third_premium: "3-е спецразмещение",
  fourth_premium: "4-е спецразмещение",
  premium: "Спецразмещение",
  first_place: "1-е место",
  fourth_place: "4-е место",
  std: "Гарантия",
};

const METRIC_TITLES: Readonly<Record<string, string>> = {
  shows: "показы",
  clicks: "клики",
  bid: "ставка",
  budget: "бюджет",
  ctr: "CTR",
};

const DIRECT_BASE: readonly ExportColumn[] = [
  PHRASE_COLUMN,
  { key: "shows", title: "Показы", type: "number" },
  { key: "bid1", title: "Ставка 1", type: "number" },
  { key: "bid2", title: "Ставка 2", type: "number" },
  { key: "bid3", title: "Ставка 3", type: "number" },
];

function rank(list: readonly string[], value: string): number {
  const index = list.indexOf(value);
  return index === -1 ? list.length : index;
}

function positionColumns(keys: Iterable<string>): ExportColumn[] {
  const positions = Object.keys(POSITION_TITLES);
  const metrics = Object.keys(METRIC_TITLES);
  const parsed = [...keys].map((key) => {
    const metric = metrics.find((name) => key.endsWith(`_${name}`));
    const position = metric ? key.slice(0, -metric.length - 1) : key;
    return { key, position, metric: metric ?? "" };
  });
  parsed.sort(
    (a, b) =>
      rank(positions, a.position) - rank(positions, b.position) ||
      a.position.localeCompare(b.position) ||
      rank(metrics, a.metric) - rank(metrics, b.metric),
  );
  return parsed.map(({ key, position, metric }) => ({
    key,
    title: metric
      ? `${POSITION_TITLES[position] ?? position}: ${METRIC_TITLES[metric]}`
      : (POSITION_TITLES[position] ?? position),
    type: "number",
  }));
}

export function directBidsTable(result: ParserRunResult): ResultTable {
  const part = result.parts.find((item) => item.parser === "direct");
  const meta = { region: result.region, ...(result.warnings ? { warnings: result.warnings } : {}) };
  if (!part) return table(DIRECT_BASE, [], meta);
  const values = partValues(part);
  if (!values) return rawParts(result);
  const rows = orderedRows(part.phrases, values.values());
  const extra = new Set<string>();
  const base = new Set(DIRECT_BASE.map((column) => column.key));
  for (const [key, row] of rows) {
    const value = values.get(key)?.value;
    if (!isRecord(value)) continue;
    const { all_positions: positions, ...rest } = value;
    const flat = { ...flatten(rest), ...(isRecord(positions) ? flatten(positions) : {}) };
    for (const [name, item] of Object.entries(flat)) {
      row[name] = toNumber(item) ?? item;
      if (!base.has(name)) extra.add(name);
    }
  }
  return table([...DIRECT_BASE, ...positionColumns(extra)], [...rows.values()], meta);
}
