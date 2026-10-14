import type { z } from "zod";
import { MutagenError } from "./errors.js";
import { type PollStep, poll } from "./polling.js";
import { RateLimiter, type RateLimitOptions } from "./rate-limit.js";
import type { ReportName } from "./reports.js";
import { type FetchLike, REDACTED, type RequestParams, Transport } from "./transport.js";
import {
  type Balance,
  balanceSchema,
  type CheckKeyGetResponse,
  type CheckKeyResult,
  type CheckKeyTask,
  checkKeyResultSchema,
  checkKeyTaskSchema,
  type MassListItem,
  type MassResult,
  type MassTask,
  massListSchema,
  massResultSchema,
  massTaskSchema,
  type ParserGetParams,
  type ParserGetResponse,
  type ParserMassNewParams,
  type ParserResult,
  type ParserType,
  type ProjectKeyword,
  parserGetSchema,
  projectKeywordsSchema,
  type SerpReportParams,
  type SerpRow,
  serpCountSchema,
  serpRowsSchema,
} from "./types.js";
import {
  MAX_MASS_KEYS,
  phraseList,
  regionId,
  requireId,
  requireParser,
  requireText,
  serpReportBody,
} from "./validate.js";

export interface MutagenClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  rateLimit?: RateLimitOptions | RateLimiter;
  timeoutMs?: number;
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onRetry?: (error: MutagenError) => void;
}

export interface WaitOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  requestTimeoutMs?: number;
}

/** check_key and parser.get direct may take more than 25 minutes at Mutagen. */
export const DEFAULT_TASK_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_MASS_TIMEOUT_MS = 30 * 60_000;

const onlyApiRetries = (error: MutagenError) => error.code !== undefined;

function requestOptions(options: CallOptions): CallOptions {
  const result: CallOptions = {};
  if (options.signal) result.signal = options.signal;
  if (options.timeoutMs !== undefined) result.timeoutMs = options.timeoutMs;
  if (options.onRetry) result.onRetry = options.onRetry;
  return result;
}

export function parserGetStep<P extends ParserType>(
  response: ParserGetResponse<P>,
): PollStep<ParserResult<P>> {
  if (response.status === "finish") {
    return { state: "done", value: { status: "finish", data: response.data ?? null } };
  }
  if (response.status === "error") return { state: "failed", status: response.status };
  return { state: "pending", status: response.status };
}

function waitRequestOptions(options: WaitOptions): CallOptions {
  const result: CallOptions = {};
  if (options.signal) result.signal = options.signal;
  if (options.requestTimeoutMs !== undefined) result.timeoutMs = options.requestTimeoutMs;
  return result;
}

function waitPollOptions(options: WaitOptions, defaultTimeoutMs: number, label: string) {
  return {
    timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
    label,
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

function stoppedError(massId: number): MutagenError {
  return new MutagenError({
    kind: "task_stopped",
    retryable: false,
    message: `parser.mass ${massId} is stopped`,
    hintRu: `Задание ${massId} остановлено на стороне Мутагена (возможно, не хватило баланса) — проверьте кабинет. Повторный вызов снова опросит это же задание, нового платного задания не будет.`,
    hintEn: `Task ${massId} is stopped at Mutagen (possibly the balance ran out); check your account. A repeated call polls the same task again and does not create a new paid one.`,
  });
}

export class MutagenClient {
  readonly #transport: Transport;
  readonly #limiter: RateLimiter;

  constructor(options: MutagenClientOptions) {
    const transportOptions: ConstructorParameters<typeof Transport>[0] = { apiKey: options.apiKey };
    if (options.baseUrl !== undefined) transportOptions.baseUrl = options.baseUrl;
    if (options.fetch !== undefined) transportOptions.fetch = options.fetch;
    if (options.timeoutMs !== undefined) transportOptions.timeoutMs = options.timeoutMs;
    this.#transport = new Transport(transportOptions);
    this.#limiter =
      options.rateLimit instanceof RateLimiter
        ? options.rateLimit
        : new RateLimiter(options.rateLimit ?? {});
  }

  get baseUrl(): string {
    return this.#transport.baseUrl;
  }

  async balance(options: CallOptions = {}): Promise<Balance> {
    return this.#request("mutagen.balance", undefined, balanceSchema, options);
  }

  async projectKeywords(progectId: number, options: CallOptions = {}): Promise<ProjectKeyword[]> {
    return this.#request(
      "mutagen.progect.keywords",
      { progect_id: requireId("progect_id", progectId) },
      projectKeywordsSchema,
      options,
    );
  }

  async checkKeyNew(key: string, options: CallOptions = {}): Promise<CheckKeyTask> {
    return this.#request(
      "mutagen.check_key.new",
      { key: requireText("key", key) },
      checkKeyTaskSchema,
      options,
      true,
    );
  }

  async checkKeyGet(taskId: number, options: CallOptions = {}): Promise<CheckKeyGetResponse> {
    const raw = await this.#call(
      "mutagen.check_key.get",
      { task_id: requireId("task_id", taskId) },
      options,
    );
    const isCompleted =
      typeof raw === "object" &&
      raw !== null &&
      (raw as { status?: unknown }).status === "completed";
    return isCompleted
      ? this.#parse("mutagen.check_key.get", checkKeyResultSchema, raw)
      : this.#parse("mutagen.check_key.get", checkKeyTaskSchema, raw);
  }

  async checkKey(key: string, options: WaitOptions = {}): Promise<CheckKeyResult> {
    const callOptions = waitRequestOptions(options);
    const task = await this.checkKeyNew(key, callOptions);
    const label = `check_key task ${task.task_id}`;
    return poll<CheckKeyResult>(
      async (attempt) => {
        if (attempt === 1 && task.status === "rejected") {
          return { state: "failed", status: task.status };
        }
        const response = await this.checkKeyGet(task.task_id, callOptions);
        if (response.status === "completed") {
          return { state: "done", value: response as CheckKeyResult };
        }
        if (response.status === "rejected" || response.status === "error") {
          return { state: "failed", status: response.status };
        }
        return { state: "pending", status: response.status };
      },
      waitPollOptions(options, DEFAULT_TASK_TIMEOUT_MS, label),
    );
  }

  async parserGet<P extends ParserType>(
    params: ParserGetParams<P>,
    options: CallOptions = {},
  ): Promise<ParserGetResponse<P>> {
    const parser = requireParser(params.parser) as P;
    return this.#request(
      "mutagen.parser.get",
      {
        key: requireText("key", params.key),
        parser,
        region_id: regionId(params.region_id),
      },
      parserGetSchema(parser),
      options,
      true,
    );
  }

  /** Only the first parser.get is paid (answer "create"); polling with the same request is free. */
  async parserGetWait<P extends ParserType>(
    params: ParserGetParams<P>,
    options: WaitOptions = {},
  ): Promise<ParserResult<P>> {
    const callOptions = waitRequestOptions(options);
    return poll<ParserResult<P>>(
      async () => parserGetStep(await this.parserGet(params, callOptions)),
      waitPollOptions(options, DEFAULT_TASK_TIMEOUT_MS, `parser.get ${params.parser}`),
    );
  }

  async parserMassNew(params: ParserMassNewParams, options: CallOptions = {}): Promise<MassTask> {
    return this.#request(
      "mutagen.parser.mass.new",
      {
        keys_list: phraseList("keys_list", params.keys_list, MAX_MASS_KEYS),
        name: requireText("name", params.name),
        parser: requireParser(params.parser),
        region_id: regionId(params.region_id),
      },
      massTaskSchema,
      options,
      true,
    );
  }

  async parserMassList(options: CallOptions = {}): Promise<MassListItem[]> {
    return this.#request("mutagen.parser.mass.list", undefined, massListSchema, options);
  }

  async parserMassId(massId: number, options: CallOptions = {}): Promise<MassResult> {
    return this.#request(
      "mutagen.parser.mass.id",
      { mass_id: requireId("mass_id", massId) },
      massResultSchema,
      options,
    );
  }

  async waitMass(massId: number, options: WaitOptions = {}): Promise<MassResult> {
    const id = requireId("mass_id", massId);
    const callOptions = waitRequestOptions(options);
    return poll<MassResult>(
      async () => {
        const result = await this.parserMassId(id, callOptions);
        if (result.status === "finish") return { state: "done", value: result };
        if (result.status === "stop") throw stoppedError(id);
        if (result.status === "error") return { state: "failed", status: result.status };
        return { state: "pending", status: result.status };
      },
      waitPollOptions(options, DEFAULT_MASS_TIMEOUT_MS, `parser.mass ${id}`),
    );
  }

  async serpReport<R extends ReportName>(
    params: SerpReportParams<R>,
    options: CallOptions = {},
  ): Promise<SerpRow[]> {
    return this.#request(
      "mutagen.serp.report",
      serpReportBody(params as unknown as Record<string, unknown>),
      serpRowsSchema,
      options,
      true,
    );
  }

  async serpReportCount<R extends ReportName>(
    params: SerpReportParams<R>,
    options: CallOptions = {},
  ): Promise<number> {
    const body = serpReportBody(params as unknown as Record<string, unknown>);
    return this.#request(
      "mutagen.serp.report",
      { ...body, count: 1 },
      serpCountSchema,
      options,
      true,
    );
  }

  toJSON(): Record<string, unknown> {
    return { baseUrl: this.baseUrl, apiKey: REDACTED };
  }

  toString(): string {
    return `MutagenClient(${this.baseUrl})`;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): Record<string, unknown> {
    return this.toJSON();
  }

  async #request<T>(
    method: string,
    params: RequestParams | undefined,
    schema: z.ZodType<T>,
    options: CallOptions,
    paid = false,
  ): Promise<T> {
    const raw = await this.#call(method, params, options, paid);
    return this.#parse(method, schema, raw);
  }

  #call(
    method: string,
    params: RequestParams | undefined,
    options: CallOptions,
    paid = false,
  ): Promise<unknown> {
    const callOptions = requestOptions(options);
    const { onRetry, ...transportOptions } = callOptions;
    return this.#limiter.run(() => this.#transport.call(method, params, transportOptions), {
      ...(callOptions.signal ? { signal: callOptions.signal } : {}),
      ...(paid ? { shouldRetry: onlyApiRetries } : {}),
      ...(onRetry ? { onRetry } : {}),
    });
  }

  #parse<T>(method: string, schema: z.ZodType<T>, raw: unknown): T {
    const result = schema.safeParse(raw);
    if (result.success) return result.data;
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw this.#invalidResponse(method, issues);
  }

  #invalidResponse(method: string, detail: string): MutagenError {
    return new MutagenError({
      kind: "invalid_response",
      retryable: false,
      message: this.#transport.redact(`Unexpected response from ${method}: ${detail}`),
      hintRu:
        "Ответ API Мутагена не совпал с ожидаемым форматом. Возможно, API изменилось — сообщите об ошибке в репозиторий mutagen-ru-mcp.",
      hintEn:
        "The Mutagen API response has an unexpected shape. The API may have changed; please report it to the mutagen-ru-mcp repository.",
    });
  }
}
