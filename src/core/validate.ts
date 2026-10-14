import { validationError } from "./errors.js";
import { isSerpRegion, isWordstatRegionId } from "./regions.js";
import { isReportName, REPORT_OBJECTS, REPORTS, type ReportObject } from "./reports.js";
import { FILTER_OPERATORS, isParserType, type ParserType, type SerpFilter } from "./types.js";

export const MAX_SERP_KEYWORDS = 1000;
export const MAX_MASS_KEYS = 50_000;
export const MAX_FILTER_LIST_VALUES = 1024;

export function requireText(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw validationError(
      `Parameter ${name} must be a non-empty string`,
      `Параметр ${name} должен быть непустой строкой.`,
      `Parameter ${name} must be a non-empty string.`,
    );
  }
  return value.trim();
}

export function requireId(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw validationError(
      `Parameter ${name} must be a positive integer`,
      `Параметр ${name} должен быть положительным целым числом.`,
      `Parameter ${name} must be a positive integer.`,
    );
  }
  return value;
}

export function requirePositive(name: string, value: unknown, integer = false): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    (integer && !Number.isInteger(value))
  ) {
    const expected = integer ? "a positive integer" : "a positive number";
    throw validationError(
      `Invalid option ${name}: ${String(value)}`,
      `Неверная настройка ${name}: ${String(value)}. Нужно положительное ${integer ? "целое " : ""}число.`,
      `Invalid option ${name}: ${String(value)}. Expected ${expected}.`,
    );
  }
  return value;
}

export function requireParser(value: unknown): ParserType {
  if (!isParserType(value)) {
    throw validationError(
      `Unknown parser type: ${String(value)}`,
      `Неизвестный тип парсера: ${String(value)}.`,
      `Unknown parser type: ${String(value)}.`,
    );
  }
  return value;
}

export function regionId(value: unknown): string {
  if (value === undefined) return "0";
  if (typeof value !== "string" || !isWordstatRegionId(value)) {
    throw validationError(
      `Invalid region_id: ${String(value)}`,
      `Неверный region_id: ${String(value)}. Укажите id регионов Яндекса через запятую без пробелов, исключения со знаком минус, например "225" или "255,-17"; "0" — без региона.`,
      `Invalid region_id: ${String(value)}. Use comma-separated Yandex region ids without spaces, exclusions with a minus, e.g. "225" or "255,-17"; "0" means no region.`,
    );
  }
  return value;
}

export function phraseList(name: string, value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw validationError(
      `Parameter ${name} must be a non-empty array of phrases`,
      `Параметр ${name} должен быть непустым списком фраз.`,
      `Parameter ${name} must be a non-empty array of phrases.`,
    );
  }
  if (value.length > max) {
    throw validationError(
      `Parameter ${name} has ${value.length} phrases, the limit is ${max}`,
      `В ${name} ${value.length} фраз, допустимо не больше ${max}. Разбейте список на части.`,
      `${name} has ${value.length} phrases, the limit is ${max}. Split the list.`,
    );
  }
  return value.map((phrase, index) => requireText(`${name}[${index}]`, phrase));
}

function invalidFilter(index: number, reason: string) {
  return validationError(
    `Invalid filter[${index}]: ${reason}`,
    `Неверное условие filter[${index}]: ${reason}.`,
    `Invalid filter[${index}]: ${reason}.`,
  );
}

function listSize(value: string | number): number {
  return String(value)
    .split(/[,\n]/)
    .filter((item) => item.trim() !== "").length;
}

export function validateFilter(filter: unknown): SerpFilter {
  if (!Array.isArray(filter)) {
    throw validationError(
      "Parameter filter must be an array",
      "Параметр filter должен быть массивом условий.",
      "Parameter filter must be an array of conditions.",
    );
  }
  filter.forEach((item: unknown, index) => {
    if (typeof item !== "object" || item === null) throw invalidFilter(index, "not an object");
    const condition = item as Record<string, unknown>;
    if ("or" in condition) {
      if (condition.or !== 1 && condition.or !== true) throw invalidFilter(index, "or must be 1");
      return;
    }
    requireText(`filter[${index}].column`, condition.column);
    const type = condition.filter_type;
    const isScalar = (value: unknown) => typeof value === "string" || typeof value === "number";
    if (type === "range") {
      if (!isScalar(condition.min) || !isScalar(condition.max)) {
        throw invalidFilter(index, "range needs min and max");
      }
    } else if (type === "is") {
      if (condition.val !== 0 && condition.val !== 1)
        throw invalidFilter(index, "is needs val 0 or 1");
    } else if ((FILTER_OPERATORS as readonly unknown[]).includes(type)) {
      if (!isScalar(condition.val)) throw invalidFilter(index, `${String(type)} needs val`);
      if (
        ["like_any", "not_like_any", "in", "not_in"].includes(type as string) &&
        listSize(condition.val as string | number) > MAX_FILTER_LIST_VALUES
      ) {
        throw invalidFilter(index, `more than ${MAX_FILTER_LIST_VALUES} values`);
      }
    } else {
      throw invalidFilter(index, `unknown filter_type ${String(type)}`);
    }
  });
  return filter as SerpFilter;
}

export function serpReportBody(params: Record<string, unknown>): Record<string, unknown> {
  const report = params.report;
  if (!isReportName(report)) {
    throw validationError(
      `Unknown report: ${String(report)}`,
      `Неизвестный отчет: ${String(report)}.`,
      `Unknown report: ${String(report)}.`,
    );
  }
  const region = params.region;
  if (!isSerpRegion(region)) {
    throw validationError(
      `Unknown Mega-tool region: ${String(region)}`,
      `Неизвестный регион Мега-инструмента: ${String(region)}.`,
      `Unknown Mega-tool region: ${String(region)}.`,
    );
  }
  const info = REPORTS[report];
  if (region === "yandex_ru" && !info.yandexRu) {
    throw validationError(
      `Report ${report} is not available for region yandex_ru`,
      `Для региона yandex_ru доступны только отчеты report_keyword_info, report_keyword_tailings, report_keyword_variations и report_keyword_questions.`,
      `Region yandex_ru supports only report_keyword_info, report_keyword_tailings, report_keyword_variations and report_keyword_questions.`,
    );
  }

  const given = REPORT_OBJECTS.filter((object) => params[object] !== undefined);
  const object = given[0];
  if (object === undefined || given.length > 1) {
    throw validationError(
      "Exactly one report object is required",
      `Укажите ровно один объект отчета: ${(info.objects as readonly string[]).join(", ")}.`,
      `Specify exactly one report object: ${(info.objects as readonly string[]).join(", ")}.`,
    );
  }
  if (!(info.objects as readonly ReportObject[]).includes(object)) {
    throw validationError(
      `Report ${report} does not accept ${object}`,
      `Отчет ${report} строится только по: ${(info.objects as readonly string[]).join(", ")}.`,
      `Report ${report} accepts only: ${(info.objects as readonly string[]).join(", ")}.`,
    );
  }

  const body: Record<string, unknown> = { region, report };
  if (object === "keywords") {
    const keywords = phraseList("keywords", params.keywords, MAX_SERP_KEYWORDS);
    if (keywords.some((phrase) => phrase.includes(","))) {
      throw validationError(
        "Phrases in keywords must not contain commas",
        "Фразы в keywords не должны содержать запятых: запятая разделяет фразы.",
        "Phrases in keywords must not contain commas: a comma separates phrases.",
      );
    }
    body.keywords = keywords.join(",");
  } else {
    body[object] = requireText(object, params[object]);
  }

  if (params.filter !== undefined) body.filter = validateFilter(params.filter);
  if (params.sort !== undefined) body.sort = requireText("sort", params.sort);
  if (params.limit !== undefined) body.limit = requireId("limit", params.limit);
  return body;
}
