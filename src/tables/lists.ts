import type { Estimate } from "../budget/estimate.js";
import type { Spending } from "../budget/guard.js";
import { REPORTS, type ReportName } from "../core/reports.js";
import type { Balance, MassListItem, MassResult, ProjectKeyword, SerpRow } from "../core/types.js";
import type { ExportColumn } from "../export/types.js";
import type { CompetitionResult } from "../session.js";
import { flatten, isRecord, normalizeMassData, UNRECOGNIZED_WARNING } from "./mass.js";
import { type ResultTable, rawTable, table } from "./types.js";

const num = (key: string, title: string): ExportColumn => ({ key, title, type: "number" });
const str = (key: string, title: string): ExportColumn => ({ key, title, type: "string" });

function isoTime(seconds: number | undefined): string | null {
  return seconds === undefined ? null : new Date(seconds * 1000).toISOString();
}

export function balanceTable(balance: Balance): ResultTable {
  return table([num("balance", "Баланс, ₽")], [{ balance: balance.balance }]);
}

export function competitionTable(result: CompetitionResult): ResultTable {
  return table(
    [
      str("phrase", "Фраза"),
      num("strong", "Конкуренция (0–25)"),
      num("wordstat", 'Частота "в кавычках"'),
      num("tails", "Хвосты"),
      num("direct_spec", "Директ: спецразмещение"),
      num("direct_first", "Директ: 1-е место"),
      num("direct_garant", "Директ: гарантия"),
      { key: "vital", title: "Витальный запрос", type: "boolean" },
      str("vital_site", "Витальный сайт"),
    ],
    result.results.map(({ phrase, result: item }) => ({
      phrase,
      strong: item.strong,
      wordstat: item.wordstat ?? null,
      tails: item.tails ?? null,
      direct_spec: item.direct?.spec ?? null,
      direct_first: item.direct?.first ?? null,
      direct_garant: item.direct?.garant ?? null,
      vital: item.vital,
      vital_site: item.vital_site,
    })),
    result.warnings ? { warnings: result.warnings } : {},
  );
}

export function massTasksTable(tasks: readonly MassListItem[]): ResultTable {
  return table(
    [
      num("id", "ID задания"),
      str("name", "Название"),
      str("parser", "Парсер"),
      str("region_id", "Регион"),
      num("count", "Фраз"),
      { key: "time", title: "Создано", type: "date" },
      str("status", "Статус"),
    ],
    tasks.map((task) => ({
      id: task.id,
      name: task.name ?? null,
      parser: task.parser ?? null,
      region_id: task.region_id ?? null,
      count: task.count ?? null,
      time: isoTime(task.time),
      status: task.status,
    })),
  );
}

export function massResultTable(massId: number, result: MassResult): ResultTable {
  const meta = {
    query: `parser.mass ${massId}`,
    ...(result.region_id === undefined ? {} : { region: result.region_id }),
  };
  const data = normalizeMassData(result.data);
  if (!data.recognized) return rawTable(result.data, UNRECOGNIZED_WARNING, meta);
  const keys = new Set<string>();
  const rows = data.entries.map(({ phrase, value }) => {
    const flat = isRecord(value) ? flatten(value) : flatten(value, result.parser ?? "value");
    for (const key of Object.keys(flat)) keys.add(key);
    return { phrase, ...flat };
  });
  const warnings =
    result.status === "finish"
      ? []
      : [
          `Задание ${massId} в статусе «${result.status}», данные могут быть неполными. Task is not finished yet.`,
        ];
  return table([str("phrase", "Фраза"), ...[...keys].map((key) => ({ key }))], rows, {
    ...meta,
    warnings,
  });
}

export function projectKeywordsTable(
  progectId: number,
  keywords: readonly ProjectKeyword[],
): ResultTable {
  return table(
    [str("keyword", "Фраза"), str("claster_id", "Кластер")],
    keywords.map((keyword) => ({ keyword: keyword.keyword, claster_id: keyword.claster_id })),
    { query: `progect ${progectId}` },
  );
}

const SERP_TITLES: Readonly<Record<string, string>> = {
  keyword: "Фраза",
  position: "Позиция",
  domain: "Домен",
  page: "Страница",
  words: "Слов",
  world_wsn: "Базовая (мир)",
  world_wsqso: '"[!Точная]" (мир)',
  region_wsn: "Базовая (регион)",
  region_wsq: '"Фразовая" (регион)',
  region_wsqso: '"[!Точная]" (регион)',
  min_bid: "Мин. ставка",
  similarity: "Схожесть",
};

export function serpReportTable(
  report: ReportName,
  rows: readonly SerpRow[],
  meta: { query?: string; region?: string; warnings?: string[] } = {},
): ResultTable {
  const known = REPORTS[report].columns as readonly string[];
  const seen = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  const keys = [
    ...known.filter((key) => seen.has(key) || rows.length === 0),
    ...[...seen].filter((key) => !known.includes(key)),
  ];
  return table(
    keys.map((key) => ({ key, ...(SERP_TITLES[key] ? { title: SERP_TITLES[key] } : {}) })),
    rows.map((row) => ({ ...row })),
    meta,
  );
}

export function estimateTable(estimate: Estimate): ResultTable {
  return table(
    [
      str("method", "Метод"),
      str("parser", "Парсер"),
      num("units", "Единиц"),
      num("billable_units", "Платных единиц"),
      num("unit_rub", "Цена за единицу, ₽"),
      num("rub", "Сумма, ₽"),
      { key: "confirmed", title: "Цена подтверждена", type: "boolean" },
      num("quota_requests", "Запросов квоты"),
    ],
    estimate.items.map((item) => ({
      method: item.method,
      parser: item.parser ?? null,
      units: item.units,
      billable_units: item.billableUnits,
      unit_rub: item.unitRub,
      rub: item.rub,
      confirmed: item.confirmed,
      quota_requests: item.quotaRequests,
    })),
    { warnings: estimate.warnings },
  );
}

export function spendingTable(spending: Spending): ResultTable {
  return table(
    [
      { key: "ts", title: "Время", type: "date" },
      str("label", "Вызов"),
      num("estimate_rub", "Смета, ₽"),
      num("spent_rub", "Списано, ₽"),
      num("quota_requests", "Запросов квоты"),
      str("status", "Статус"),
    ],
    spending.calls.map((call) => ({
      ts: call.ts,
      label: call.label,
      estimate_rub: call.estimateRub,
      spent_rub: call.spentRub,
      quota_requests: call.quotaRequests,
      status: call.status,
    })),
  );
}
