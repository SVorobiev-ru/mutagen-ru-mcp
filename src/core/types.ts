import { z } from "zod";
import type { SerpRegion } from "./regions.js";
import type { ReportName, ReportObject, ReportObjectsOf } from "./reports.js";

export const PARSER_TYPES = [
  "wordstat_key",
  "wordstat_key_50",
  "wordstat_n",
  "wordstat_q",
  "wordstat_qs",
  "wordstat_no",
  "wordstat_qo",
  "wordstat_qso",
  "direct",
] as const;

export type ParserType = (typeof PARSER_TYPES)[number];

export const FREQUENCY_PARSERS = [
  "wordstat_n",
  "wordstat_q",
  "wordstat_qs",
  "wordstat_no",
  "wordstat_qo",
  "wordstat_qso",
] as const satisfies readonly ParserType[];

export type FrequencyParser = (typeof FREQUENCY_PARSERS)[number];

export function isParserType(value: unknown): value is ParserType {
  return typeof value === "string" && (PARSER_TYPES as readonly string[]).includes(value);
}

export type CheckKeyStatus = "created" | "processed" | "rejected" | "completed" | (string & {});
export type ParserStatus = "create" | "process" | "finish" | "error" | (string & {});
export type MassStatus = "stop" | "process" | "finish" | (string & {});

export type FilterOperator =
  | "gr"
  | ">"
  | "gr_or_eq"
  | ">="
  | "less"
  | "<"
  | "less_or_eq"
  | "<="
  | "eq"
  | "="
  | "not_eq"
  | "!="
  | "like"
  | "not_like"
  | "like_any"
  | "not_like_any"
  | "in"
  | "not_in"
  | "like_start"
  | "like_finish";

export const FILTER_OPERATORS: readonly FilterOperator[] = [
  "gr",
  ">",
  "gr_or_eq",
  ">=",
  "less",
  "<",
  "less_or_eq",
  "<=",
  "eq",
  "=",
  "not_eq",
  "!=",
  "like",
  "not_like",
  "like_any",
  "not_like_any",
  "in",
  "not_in",
  "like_start",
  "like_finish",
];

export interface ValueFilter {
  column: string;
  filter_type: FilterOperator;
  val: string | number;
}

export interface RangeFilter {
  column: string;
  filter_type: "range";
  min: string | number;
  max: string | number;
}

export interface BooleanFilter {
  column: string;
  filter_type: "is";
  val: 0 | 1;
}

export interface OrSeparator {
  or: 1 | true;
}

export type FilterCondition = ValueFilter | RangeFilter | BooleanFilter;
export type SerpFilter = readonly (FilterCondition | OrSeparator)[];

interface ReportObjectValues {
  keyword: string;
  keywords: readonly string[];
  domain: string;
  domain_with_subdomains: string;
  page: string;
}

type ExactlyOneObject<K extends ReportObject> = K extends ReportObject
  ? { [P in K]: ReportObjectValues[P] } & { [P in Exclude<ReportObject, K>]?: never }
  : never;

export interface SerpReportBase<R extends ReportName> {
  region: SerpRegion;
  report: R;
  filter?: SerpFilter;
  sort?: string;
  limit?: number;
}

export type SerpReportParams<R extends ReportName = ReportName> = SerpReportBase<R> &
  ExactlyOneObject<ReportObjectsOf<R>>;

export interface ParserGetParams<P extends ParserType = ParserType> {
  key: string;
  parser: P;
  region_id?: string;
}

export interface ParserMassNewParams {
  keys_list: readonly string[];
  name: string;
  parser: ParserType;
  region_id?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const numeric = z.union([
  z.number(),
  z
    .string()
    .trim()
    .regex(/^-?\d+(\.\d+)?$/)
    .transform(Number),
]);

const optionalNumeric = z.preprocess(
  (value) => (value === null || value === "" ? undefined : value),
  numeric.optional(),
);

const text = z.union([z.string(), z.number()]).transform(String);

const flag = z
  .union([z.boolean(), z.number(), z.string(), z.null()])
  .optional()
  .transform(
    (value) =>
      value === true ||
      (typeof value === "number" && value !== 0) ||
      (typeof value === "string" && !["", "0", "false"].includes(value.trim().toLowerCase())),
  );

function phpRecord<T extends z.ZodType>(value: T) {
  return z.preprocess(
    (input) => (Array.isArray(input) ? Object.fromEntries(input.entries()) : input),
    z.record(z.string(), value),
  );
}

function phpList<T extends z.ZodType>(item: T) {
  return z.preprocess((input) => (isRecord(input) ? Object.values(input) : input), z.array(item));
}

const emptyToUndefined = (input: unknown) =>
  input === null || input === "" || (Array.isArray(input) && input.length === 0)
    ? undefined
    : input;

export interface Balance {
  balance: number;
}

/** The API answers a float with a tail (143.75999999999999); kept in whole kopecks. */
export const balanceSchema: z.ZodType<Balance> = z.looseObject({
  balance: numeric.transform((value) => Math.round(value * 100) / 100),
});

export interface ProjectKeyword {
  keyword: string;
  claster_id: string | null;
}

export const projectKeywordsSchema: z.ZodType<ProjectKeyword[]> = phpList(
  z.looseObject({
    keyword: text,
    claster_id: text
      .nullable()
      .optional()
      .transform((value) => value ?? null),
  }),
);

export interface CheckKeyTask {
  task_id: number;
  status: CheckKeyStatus;
}

export const checkKeyTaskSchema: z.ZodType<CheckKeyTask> = z.looseObject({
  task_id: numeric,
  status: z.string(),
});

export interface DirectBids {
  spec?: number | undefined;
  first?: number | undefined;
  garant?: number | undefined;
}

export interface CheckKeyResult {
  status: "completed";
  key: string;
  strong: number;
  wordstat?: number | undefined;
  tails?: number | undefined;
  direct?: DirectBids | undefined;
  vital: boolean;
  vital_site: string;
}

export const checkKeyResultSchema: z.ZodType<CheckKeyResult> = z.looseObject({
  status: z.literal("completed"),
  key: text,
  strong: numeric,
  wordstat: optionalNumeric,
  tails: optionalNumeric,
  direct: z.preprocess(
    emptyToUndefined,
    z
      .looseObject({ spec: optionalNumeric, first: optionalNumeric, garant: optionalNumeric })
      .optional(),
  ),
  vital: flag,
  vital_site: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? ""),
});

export type CheckKeyGetResponse = CheckKeyTask | CheckKeyResult;

export interface WordstatKeyData {
  frequency?: number | undefined;
  count_keys?: number | undefined;
  /** `null`: Mutagen sent no frequency for the phrase. */
  array: Record<string, number | null>;
  /** Not sent by the API now (no right column); parsed if it ever comes back. */
  assotiations?: Record<string, number | null> | undefined;
}

export interface FrequencyData {
  /** `null`: Mutagen sent no frequency. */
  frequency: number | null;
}

export interface DirectPositionForecast {
  shows?: number | undefined;
  clicks?: number | undefined;
  bid?: number | undefined;
  budget?: number | undefined;
  ctr?: number | undefined;
}

export type DirectPosition =
  | "first_premium"
  | "second_premium"
  | "premium"
  | "third_premium"
  | "fourth_premium"
  | "first_place"
  | "fourth_place"
  | "std"
  | (string & {});

export interface DirectData {
  shows?: number | undefined;
  bid1?: number | undefined;
  bid2?: number | undefined;
  bid3?: number | undefined;
  all_positions: Partial<Record<DirectPosition, DirectPositionForecast>>;
}

export interface ParserDataMap {
  wordstat_key: WordstatKeyData;
  wordstat_key_50: WordstatKeyData;
  wordstat_n: FrequencyData;
  wordstat_q: FrequencyData;
  wordstat_qs: FrequencyData;
  wordstat_no: FrequencyData;
  wordstat_qo: FrequencyData;
  wordstat_qso: FrequencyData;
  direct: DirectData;
}

export type ParserData<P extends ParserType = ParserType> = ParserDataMap[P];

const nullableNumeric = z.preprocess(
  (value) => (value === undefined || value === "" ? null : value),
  numeric.nullable(),
);

const frequencyRecord = phpRecord(nullableNumeric);

const wordstatKeyDataSchema: z.ZodType<WordstatKeyData> = z.looseObject({
  frequency: optionalNumeric,
  count_keys: optionalNumeric,
  array: z.preprocess((input) => input ?? {}, frequencyRecord),
  assotiations: z.preprocess(emptyToUndefined, frequencyRecord.optional()),
});

const frequencyDataSchema: z.ZodType<FrequencyData> = z.looseObject({
  frequency: nullableNumeric,
});

const directPositionSchema = z.looseObject({
  shows: optionalNumeric,
  clicks: optionalNumeric,
  bid: optionalNumeric,
  budget: optionalNumeric,
  ctr: optionalNumeric,
});

const directDataSchema: z.ZodType<DirectData> = z.looseObject({
  shows: optionalNumeric,
  bid1: optionalNumeric,
  bid2: optionalNumeric,
  bid3: optionalNumeric,
  all_positions: z.preprocess((input) => input ?? {}, phpRecord(directPositionSchema)),
});

export const PARSER_DATA_SCHEMAS: { readonly [P in ParserType]: z.ZodType<ParserDataMap[P]> } = {
  wordstat_key: wordstatKeyDataSchema,
  wordstat_key_50: wordstatKeyDataSchema,
  wordstat_n: frequencyDataSchema,
  wordstat_q: frequencyDataSchema,
  wordstat_qs: frequencyDataSchema,
  wordstat_no: frequencyDataSchema,
  wordstat_qo: frequencyDataSchema,
  wordstat_qso: frequencyDataSchema,
  direct: directDataSchema,
};

export interface ParserGetResponse<P extends ParserType = ParserType> {
  status: ParserStatus;
  data?: ParserData<P> | undefined;
}

export interface ParserResult<P extends ParserType = ParserType> {
  status: "finish";
  data: ParserData<P> | null;
}

export function parserGetSchema<P extends ParserType>(parser: P): z.ZodType<ParserGetResponse<P>> {
  const data: z.ZodType<ParserData<P>> = PARSER_DATA_SCHEMAS[parser];
  return z.looseObject({
    status: z.string(),
    data: z.preprocess(emptyToUndefined, data.optional()),
  });
}

export interface MassTask {
  id: number;
  status: MassStatus;
}

export const massTaskSchema: z.ZodType<MassTask> = z.looseObject({
  id: numeric,
  status: z.string(),
});

export interface MassInfo {
  name?: string | undefined;
  parser?: string | undefined;
  region_id?: string | undefined;
  count?: number | undefined;
  time?: number | undefined;
  status: MassStatus;
}

const optionalText = z.preprocess((value) => (value === null ? undefined : value), text.optional());

const massInfoShape = {
  name: optionalText,
  parser: optionalText,
  region_id: z.preprocess(
    (value) => (value === null || value === "" ? "0" : value),
    text.optional(),
  ),
  count: optionalNumeric,
  time: optionalNumeric,
  status: z.string(),
};

export interface MassListItem extends MassInfo {
  id: number;
}

export const massListSchema: z.ZodType<MassListItem[]> = z.preprocess(
  (input) =>
    isRecord(input)
      ? Object.entries(input).map(([id, item]) => (isRecord(item) ? { id, ...item } : item))
      : input,
  z.array(z.looseObject({ id: numeric, ...massInfoShape })),
);

export interface MassResult extends MassInfo {
  data?: unknown;
}

export const massResultSchema: z.ZodType<MassResult> = z.looseObject({
  ...massInfoShape,
  data: z.preprocess(emptyToUndefined, z.unknown()),
});

export type SerpRow = Record<string, unknown>;

export const serpRowsSchema: z.ZodType<SerpRow[]> = phpList(z.record(z.string(), z.unknown()));

export const serpCountSchema: z.ZodType<number> = z.preprocess(
  (input) => (isRecord(input) ? (input.count ?? input.total) : input),
  numeric,
);
