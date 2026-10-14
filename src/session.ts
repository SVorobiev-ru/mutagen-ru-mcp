import { AsyncLocalStorage } from "node:async_hooks";
import { type Estimate, estimatePlan, type PlannedCall } from "./budget/estimate.js";
import { type Allowance, type Reservation, SpendGuard, type Spending } from "./budget/guard.js";
import { requestHash } from "./budget/hash.js";
import {
  Ledger,
  type LedgerEntry,
  type LedgerInput,
  LOCK_WAIT_MS,
  latestEntry,
  paidSince,
  reusableTask,
  TASK_REUSE_MS,
  taskCreatedAt,
} from "./budget/ledger.js";
import {
  DEFAULT_PRICES,
  type PriceOverrides,
  type PriceTable,
  parserPriceKey,
  resolvePrices,
  toKopecks,
} from "./budget/pricing.js";
import { type CacheCategory, FileCache } from "./cache/file-cache.js";
import type { MutagenConfig } from "./config.js";
import {
  DEFAULT_MASS_TIMEOUT_MS,
  DEFAULT_TASK_TIMEOUT_MS,
  MutagenClient,
  parserGetStep,
} from "./core/client.js";
import {
  combineFailures,
  isTaskPending,
  MutagenError,
  TaskPendingError,
  validationError,
} from "./core/errors.js";
import { poll } from "./core/polling.js";
import { RateLimiter, type RateLimitOptions } from "./core/rate-limit.js";
import type { ReportName } from "./core/reports.js";
import type { FetchLike } from "./core/transport.js";
import type {
  Balance,
  CheckKeyResult,
  MassListItem,
  MassResult,
  ParserData,
  ParserResult,
  ParserType,
  ProjectKeyword,
  SerpReportParams,
  SerpRow,
} from "./core/types.js";
import {
  MAX_MASS_KEYS,
  phraseList,
  regionId,
  requireId,
  requireParser,
  requirePositive,
  serpReportBody,
} from "./core/validate.js";
import { missingKeyError } from "./mcp/links.js";

export const DATA_SOURCE = "mutagen.ru";
export type DataSource = typeof DATA_SOURCE;

export type FrequencyStrategy = "single" | "mass";

/** Up to this many phrases per type go through parser.get: it answers in seconds, polling is free. */
export const SINGLE_MAX_PHRASES = 10;
export const LOST_TASK_SLACK_MS = 5 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

export interface MutagenSessionOptions {
  /** `undefined` for a session without an API key: any API call fails with a missing key error. */
  client: MutagenClient | undefined;
  stateDir: string;
  cacheDir: string;
  budgetRub?: number;
  autoApproveRub?: number;
  freeOnly?: boolean;
  balanceCheckAboveRub?: number;
  tokenTtlMs?: number;
  cacheTtlDays?: Partial<Record<CacheCategory, number>>;
  noCache?: boolean;
  prices?: PriceOverrides;
  frequencyStrategy?: FrequencyStrategy;
  taskTimeoutMs?: number;
  massTimeoutMs?: number;
  /** How long a call waits for another process creating the same mass task. */
  lockWaitMs?: number;
  now?: () => number;
}

export interface SessionFromConfigOptions
  extends Partial<Omit<MutagenSessionOptions, "client" | "stateDir" | "cacheDir">> {
  fetch?: FetchLike;
  rateLimit?: RateLimitOptions | RateLimiter;
  timeoutMs?: number;
}

export interface WaitProgress {
  label: string;
  status: string | undefined;
}

export interface LiveCallOptions {
  signal?: AbortSignal;
  /** Epoch ms: no wait of this call lasts longer; then it fails with TaskPendingError. */
  waitUntil?: number;
  onWait?: (progress: WaitProgress) => void;
}

export interface CachedCallOptions extends LiveCallOptions {
  noCache?: boolean;
  forceRefresh?: boolean;
}

export interface PaidCallOptions extends CachedCallOptions {
  confirmToken?: string;
  dryRun?: boolean;
  newTask?: boolean;
}

export interface DryRunResult {
  source: DataSource;
  dryRun: true;
  estimate: Estimate;
  warnings?: string[];
  /** Every part of the result is in the cache: the real call makes no API requests. */
  cached?: boolean;
}

export interface AllowancePlan {
  label: string;
  params: Record<string, unknown>;
  estimate: Estimate;
}

export interface AllowanceOptions {
  confirmToken?: string | undefined;
  dryRun?: boolean | undefined;
}

export interface AllowanceRun<T> {
  source: DataSource;
  dryRun: false;
  estimate: Estimate;
  value: T;
  spentRub: number;
  warnings: string[];
}

interface Executed {
  source: DataSource;
  dryRun: false;
  estimate: Estimate;
  warnings?: string[];
}

export type ParserPart =
  | {
      via: "parser.get";
      parser: ParserType;
      phrases: string[];
      data: Record<string, ParserData | null>;
      fromCache: boolean;
    }
  | {
      via: "parser.mass";
      parser: ParserType;
      phrases: string[];
      massId: number;
      result: MassResult;
      fromCache: boolean;
      reusedTask: boolean;
    };

export interface ParserRunResult extends Executed {
  strategy: FrequencyStrategy;
  region: string;
  parts: ParserPart[];
}

export interface CompetitionRow {
  phrase: string;
  result: CheckKeyResult;
  fromCache: boolean;
  reusedTask: boolean;
}

export interface CompetitionResult extends Executed {
  results: CompetitionRow[];
}

export interface SerpReportResult extends Executed {
  rows: SerpRow[];
  fromCache: boolean;
}

export interface SerpCountResult extends Executed {
  count: number;
  fromCache: boolean;
}

export interface MassResultOptions extends CachedCallOptions {
  /** Wait for the job until the wait limit; an unfinished job is returned as is. */
  wait?: boolean;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function notCharged(error: unknown): boolean {
  return (
    error instanceof MutagenError &&
    (error.code !== undefined || error.kind === "validation" || error.beforeStart)
  );
}

function refusedStatus(error: unknown): "failed" | "cancelled" {
  return error instanceof MutagenError && error.beforeStart ? "cancelled" : "failed";
}

function taskFailed(error: unknown): boolean {
  return error instanceof MutagenError && (error.kind === "task_failed" || error.code === 107);
}

function taskStopped(error: unknown): boolean {
  return error instanceof MutagenError && error.kind === "task_stopped";
}

function pollTimeout(error: unknown): boolean {
  return error instanceof MutagenError && error.kind === "poll_timeout";
}

async function settleAll(runs: readonly Promise<unknown>[]): Promise<void> {
  const settled = await Promise.allSettled(runs);
  const errors = settled.flatMap((item) => (item.status === "rejected" ? [item.reason] : []));
  if (errors.length > 0) throw combineFailures(errors);
}

function withWarnings<T extends object>(result: T, warnings: string[]): T {
  return warnings.length > 0 ? { ...result, warnings } : result;
}

function inRequestOrder(part: ParserPart, keys: string[]): ParserPart {
  if (part.via === "parser.mass") return { ...part, phrases: keys };
  const data = Object.fromEntries(
    keys.filter((key) => Object.hasOwn(part.data, key)).map((key) => [key, part.data[key] ?? null]),
  );
  return { ...part, phrases: keys, data };
}

function singleHash(key: string, parser: ParserType, region_id: string): string {
  return requestHash("parser.get", { key, parser, region_id });
}

function signalOf(options: LiveCallOptions): { signal?: AbortSignal } {
  return options.signal ? { signal: options.signal } : {};
}

function waitOf(options: LiveCallOptions, timeoutMs: number, label: string) {
  const until = Math.min(Date.now() + timeoutMs, options.waitUntil ?? Number.POSITIVE_INFINITY);
  const { onWait } = options;
  return {
    timeoutMs: Math.max(0, until - Date.now()),
    label,
    ...signalOf(options),
    ...(onWait ? { onPending: (status: string | undefined) => onWait({ label, status }) } : {}),
  };
}

function cacheOptions(options: CachedCallOptions) {
  return {
    ...(options.noCache ? { noCache: true } : {}),
    ...(options.forceRefresh ? { forceRefresh: true } : {}),
  };
}

type PartPlan =
  | { mode: "ready"; part: ParserPart }
  | {
      mode: "single";
      parser: ParserType;
      hash: string;
      kopecks: number;
      missing: string[];
      /** Phrases paid earlier and still processing, with the time of their creation. */
      paid: ReadonlyMap<string, number>;
      data: Record<string, ParserData | null>;
    }
  | {
      mode: "mass";
      parser: ParserType;
      hash: string;
      kopecks: number;
      reuse: LedgerEntry | undefined;
      createdAt: number | undefined;
      requested: LedgerEntry | undefined;
      abandon: LedgerEntry | undefined;
      /** Ledger entries read for the plan; later ones come from other calls or processes. */
      seen: number;
    };

type CompetitionPlan =
  | { mode: "ready"; row: CompetitionRow }
  | {
      mode: "check";
      phrase: string;
      hash: string;
      taskId: number | undefined;
      createdAt: number | undefined;
      pending: boolean;
      repeat: boolean;
    };

export class MutagenSession {
  readonly #client: MutagenClient | undefined;
  readonly guard: SpendGuard;
  readonly ledger: Ledger;
  readonly cache: FileCache;
  readonly prices: PriceTable;
  readonly frequencyStrategy: FrequencyStrategy;
  readonly #taskTimeoutMs: number;
  readonly #massTimeoutMs: number;
  readonly #lockWaitMs: number;
  readonly #now: () => number;
  readonly #inflight = new Map<string, Promise<unknown>>();
  readonly #allowance = new AsyncLocalStorage<Allowance>();

  constructor(options: MutagenSessionOptions) {
    const now = options.now ?? Date.now;
    this.#client = options.client;
    this.prices = options.prices ? resolvePrices(options.prices) : DEFAULT_PRICES;
    this.frequencyStrategy = options.frequencyStrategy ?? "single";
    this.#taskTimeoutMs = requirePositive(
      "taskTimeoutMs",
      options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
    );
    this.#massTimeoutMs = requirePositive(
      "massTimeoutMs",
      options.massTimeoutMs ?? DEFAULT_MASS_TIMEOUT_MS,
    );
    this.#lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
    this.#now = now;
    this.guard = new SpendGuard({
      ...(options.budgetRub === undefined ? {} : { budgetRub: options.budgetRub }),
      ...(options.autoApproveRub === undefined ? {} : { autoApproveRub: options.autoApproveRub }),
      ...(options.freeOnly === undefined ? {} : { freeOnly: options.freeOnly }),
      ...(options.balanceCheckAboveRub === undefined
        ? {}
        : { balanceCheckAboveRub: options.balanceCheckAboveRub }),
      ...(options.tokenTtlMs === undefined ? {} : { tokenTtlMs: options.tokenTtlMs }),
      balance: async () => (await this.client.balance()).balance,
      now,
    });
    this.ledger = new Ledger({ dir: options.stateDir, now });
    this.cache = new FileCache({
      dir: options.cacheDir,
      ...(options.cacheTtlDays ? { ttlDays: options.cacheTtlDays } : {}),
      disabled: options.noCache ?? false,
      now,
    });
  }

  static fromConfig(config: MutagenConfig, options: SessionFromConfigOptions = {}): MutagenSession {
    if (!config.apiKey) {
      throw validationError(
        "MUTAGEN_API_KEY is not set",
        "Не задан ключ API: укажите MUTAGEN_API_KEY. Ключ выдается в кабинете https://mutagen.ru/?api_config",
        "The API key is missing: set MUTAGEN_API_KEY. Get the key at https://mutagen.ru/?api_config",
      );
    }
    const { fetch, rateLimit, timeoutMs } = options;
    const client = new MutagenClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      ...(fetch ? { fetch } : {}),
      rateLimit:
        rateLimit instanceof RateLimiter
          ? rateLimit
          : { concurrency: config.concurrency, perSecond: config.rps, ...rateLimit },
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return MutagenSession.#create(config, client, options);
  }

  /** A session for scenarios that run locally without MUTAGEN_API_KEY; it never reaches the API. */
  static offline(config: MutagenConfig, options: SessionFromConfigOptions = {}): MutagenSession {
    return MutagenSession.#create(config, undefined, options);
  }

  static #create(
    config: MutagenConfig,
    client: MutagenClient | undefined,
    options: SessionFromConfigOptions,
  ): MutagenSession {
    const { fetch, rateLimit, timeoutMs, freeOnly, budgetRub, autoApproveRub, ...rest } = options;
    return new MutagenSession({
      client,
      stateDir: config.stateDir,
      cacheDir: config.cacheDir,
      cacheTtlDays: config.cacheTtlDays,
      noCache: config.noCache,
      prices: config.prices,
      ...rest,
      freeOnly: config.freeOnly || (freeOnly ?? false),
      budgetRub: Math.min(config.budgetRub, budgetRub ?? Number.POSITIVE_INFINITY),
      autoApproveRub: Math.min(config.autoApproveRub, autoApproveRub ?? Number.POSITIVE_INFINITY),
    });
  }

  get client(): MutagenClient {
    if (this.#client === undefined) throw missingKeyError();
    return this.#client;
  }

  estimate(calls: readonly PlannedCall[]): Estimate {
    return estimatePlan(calls, this.prices);
  }

  spending(): Spending {
    return this.guard.spending();
  }

  /** The planned call `frequency` or `wordstatKeywords` makes for this many phrases. */
  parserCall(phrases: number, parsers: readonly ParserType[]): PlannedCall {
    return this.frequencyStrategy === "single" && phrases <= SINGLE_MAX_PHRASES
      ? { method: "parser.get", parsers, phrases }
      : { method: "parser.mass.new", parsers, phrases };
  }

  /**
   * Approves the whole plan once (budget, free-only, confirmation) and runs `fn`; paid calls
   * of this session inside `fn` spend the approved estimate without their own confirmation,
   * and a call that does not fit into what is left fails with `over_allowance`.
   */
  async runWithAllowance<T>(
    plan: AllowancePlan,
    options: AllowanceOptions,
    fn: (allowance: Allowance) => Promise<T>,
  ): Promise<AllowanceRun<T> | DryRunResult> {
    const { estimate } = plan;
    if (options.dryRun) return { source: DATA_SOURCE, dryRun: true, estimate };
    const outer = this.#allowance.getStore();
    if (outer) {
      const before = outer.spentKopecks;
      const value = await fn(outer);
      return this.#allowanceRun(estimate, value, outer.spentKopecks - before, []);
    }
    const allowance = await this.guard.allow({
      label: plan.label,
      planHash: requestHash(`plan.${plan.label}`, plan.params),
      estimate,
      confirmToken: options.confirmToken,
    });
    try {
      const value = await this.#allowance.run(allowance, () => fn(allowance));
      allowance.close("ok");
      const overrun = allowance.overrunWarning();
      return this.#allowanceRun(estimate, value, allowance.spentKopecks, overrun ? [overrun] : []);
    } catch (error) {
      allowance.close("failed");
      throw error;
    }
  }

  #allowanceRun<T>(
    estimate: Estimate,
    value: T,
    spentKopecks: number,
    warnings: string[],
  ): AllowanceRun<T> {
    return {
      source: DATA_SOURCE,
      dryRun: false,
      estimate,
      value,
      spentRub: spentKopecks / 100,
      warnings,
    };
  }

  async balance(options: LiveCallOptions = {}): Promise<Balance & { source: DataSource }> {
    const result = await this.client.balance(signalOf(options));
    return { source: DATA_SOURCE, ...result };
  }

  async projectKeywords(
    progectId: number,
    options: LiveCallOptions = {},
  ): Promise<{ source: DataSource; progectId: number; keywords: ProjectKeyword[] }> {
    const keywords = await this.client.projectKeywords(progectId, signalOf(options));
    return { source: DATA_SOURCE, progectId, keywords };
  }

  async massTasks(
    options: LiveCallOptions = {},
  ): Promise<{ source: DataSource; tasks: MassListItem[] }> {
    return { source: DATA_SOURCE, tasks: await this.client.parserMassList(signalOf(options)) };
  }

  async massResult(
    massId: number,
    options: MassResultOptions = {},
  ): Promise<{ source: DataSource; massId: number; result: MassResult; fromCache: boolean }> {
    const id = requireId("mass_id", massId);
    const hash = requestHash("parser.mass.id", { mass_id: id });
    const cached = await this.cache.get<MassResult>(hash, cacheOptions(options));
    if (cached) return { source: DATA_SOURCE, massId: id, result: cached, fromCache: true };
    const result = options.wait
      ? await this.#pollMass(id, options)
      : await this.client.parserMassId(id, signalOf(options));
    if (result.status === "finish") {
      await this.cache.set(hash, "frequency", result, cacheOptions(options));
    }
    return { source: DATA_SOURCE, massId: id, result, fromCache: false };
  }

  frequency(
    phrases: readonly string[],
    types: readonly ParserType[],
    region?: string,
    options: PaidCallOptions = {},
  ): Promise<ParserRunResult | DryRunResult> {
    return this.#runParser("frequency", phrases, types, region, options);
  }

  wordstatKeywords(
    phrase: string,
    depth: 200 | 2000 = 200,
    region?: string,
    options: PaidCallOptions = {},
  ): Promise<ParserRunResult | DryRunResult> {
    const parser: ParserType = depth === 2000 ? "wordstat_key" : "wordstat_key_50";
    return this.#runParser("wordstat_keywords", [phrase], [parser], region, options);
  }

  directBids(
    phrases: readonly string[],
    region?: string,
    options: PaidCallOptions = {},
  ): Promise<ParserRunResult | DryRunResult> {
    return this.#runParser("direct_bids", phrases, ["direct"], region, options);
  }

  async competition(
    phrases: readonly string[],
    options: PaidCallOptions = {},
  ): Promise<CompetitionResult | DryRunResult> {
    const keys = unique(phraseList("phrases", phrases, MAX_MASS_KEYS));
    const price = this.prices["check_key.new"];
    const unitKopecks = toKopecks(price.rub, "check_key.new");
    const now = this.#now();
    const freeSince = now - (price.freeRepeatDays ?? 0) * DAY_MS;
    const reuseSince = now - TASK_REUSE_MS;
    const entries = await this.ledger.entries();
    const plans: CompetitionPlan[] = [];
    for (const phrase of keys) {
      const hash = requestHash("check_key.new", { key: phrase });
      const cached = await this.cache.get<CheckKeyResult>(hash, cacheOptions(options));
      if (cached) {
        plans.push({
          mode: "ready",
          row: { phrase, result: cached, fromCache: true, reusedTask: false },
        });
        continue;
      }
      const reuse = reusableTask(entries, hash, reuseSince, !options.forceRefresh);
      const repeat = paidSince(entries, hash, freeSince);
      const pending = reuse?.status === "created";
      plans.push({
        mode: "check",
        phrase,
        hash,
        taskId: reuse?.taskId,
        createdAt: reuse && taskCreatedAt(entries, reuse),
        pending,
        repeat,
      });
    }
    const checks = plans.filter((plan) => plan.mode === "check");
    const created = checks.filter((plan) => !plan.pending);
    const estimate = this.estimate(
      created.length > 0
        ? [
            {
              method: "check_key.new",
              phrases: created.length,
              repeatPhrases: created.filter((plan) => plan.repeat).length,
            },
          ]
        : [],
    );
    if (options.dryRun) return { source: DATA_SOURCE, dryRun: true, estimate };
    const planHash = requestHash("plan.competition", {
      checks: created.map((plan) => [plan.hash, plan.repeat]),
    });
    const warnings: string[] = [];
    const wait = { ...options, waitUntil: this.#waitUntil(options, this.#taskTimeoutMs) };
    await this.#reserved("competition", planHash, estimate, options, warnings, (reservation) =>
      settleAll(
        plans.map(async (plan, index) => {
          if (plan.mode === "ready") return;
          const kopecks = plan.repeat ? 0 : unitKopecks;
          const row = await this.#once(plan.hash, () =>
            this.#checkKey(plan, kopecks, reservation, wait, warnings),
          );
          plans[index] = { mode: "ready", row };
        }),
      ),
    );
    return withWarnings(
      {
        source: DATA_SOURCE,
        dryRun: false as const,
        estimate,
        results: plans.map((plan) => (plan as { row: CompetitionRow }).row),
      },
      warnings,
    );
  }

  async serpReport<R extends ReportName>(
    params: SerpReportParams<R>,
    options: PaidCallOptions = {},
  ): Promise<SerpReportResult | DryRunResult> {
    const body = serpReportBody(params as unknown as Record<string, unknown>);
    const hash = requestHash("serp.report", body);
    const cached = await this.cache.get<SerpRow[]>(hash, cacheOptions(options));
    if (cached) {
      return {
        source: DATA_SOURCE,
        dryRun: false,
        estimate: this.estimate([]),
        rows: cached,
        fromCache: true,
      };
    }
    const estimate = this.estimate([{ method: "serp.report", requests: 1 }]);
    if (options.dryRun) return { source: DATA_SOURCE, dryRun: true, estimate };
    const warnings: string[] = [];
    const rows = await this.#reserved(
      "serp_report",
      hash,
      estimate,
      options,
      warnings,
      (reservation) =>
        this.#once(hash, async () => {
          const result = await this.client.serpReport(params, {
            ...signalOf(options),
            onRetry: () => reservation?.addQuota(1),
          });
          await this.#journal(
            {
              method: "serp.report",
              requestHash: hash,
              estimateRub: 0,
              status: "done",
              chargedRub: 0,
            },
            warnings,
          );
          await this.cache.set(hash, "report", result, cacheOptions(options));
          return result;
        }),
    );
    return withWarnings(
      { source: DATA_SOURCE, dryRun: false as const, estimate, rows, fromCache: false },
      warnings,
    );
  }

  async serpReportCount<R extends ReportName>(
    params: SerpReportParams<R>,
    options: PaidCallOptions = {},
  ): Promise<SerpCountResult | DryRunResult> {
    const body = { ...serpReportBody(params as unknown as Record<string, unknown>), count: 1 };
    const hash = requestHash("serp.report", body);
    const cached = await this.cache.get<number>(hash, cacheOptions(options));
    if (cached !== undefined) {
      return {
        source: DATA_SOURCE,
        dryRun: false,
        estimate: this.estimate([]),
        count: cached,
        fromCache: true,
      };
    }
    const estimate = this.estimate([{ method: "serp.report", requests: 1 }]);
    if (options.dryRun) return { source: DATA_SOURCE, dryRun: true, estimate };
    const warnings: string[] = [];
    const count = await this.#reserved(
      "serp_report_count",
      hash,
      estimate,
      options,
      warnings,
      (reservation) =>
        this.#once(hash, async () => {
          const result = await this.client.serpReportCount(params, {
            ...signalOf(options),
            onRetry: () => reservation?.addQuota(1),
          });
          await this.#journal(
            {
              method: "serp.report",
              requestHash: hash,
              estimateRub: 0,
              status: "done",
              chargedRub: 0,
            },
            warnings,
          );
          await this.cache.set(hash, "report", result, cacheOptions(options));
          return result;
        }),
    );
    return withWarnings(
      { source: DATA_SOURCE, dryRun: false as const, estimate, count, fromCache: false },
      warnings,
    );
  }

  async #runParser(
    label: string,
    phrases: readonly string[],
    types: readonly ParserType[],
    region: string | undefined,
    options: PaidCallOptions,
  ): Promise<ParserRunResult | DryRunResult> {
    const keys = unique(phraseList("phrases", phrases, MAX_MASS_KEYS));
    const sortedKeys = [...keys].sort();
    const parsers = [...new Set(types.map((type) => requireParser(type)))];
    if (parsers.length === 0) {
      throw validationError(
        "At least one parser type is required",
        "Укажите хотя бы один вид частотности.",
        "Specify at least one match type.",
      );
    }
    const region_id = regionId(region);
    const strategy: FrequencyStrategy =
      this.frequencyStrategy === "single" && keys.length <= SINGLE_MAX_PHRASES ? "single" : "mass";
    const reuseSince = this.#now() - TASK_REUSE_MS;
    const entries = await this.ledger.entries();
    const plans: PartPlan[] = [];
    const calls: PlannedCall[] = [];
    for (const parser of parsers) {
      const unit = toKopecks(this.prices[parserPriceKey(parser)].rub, parserPriceKey(parser));
      if (strategy === "single") {
        const data: Record<string, ParserData | null> = {};
        const missing: string[] = [];
        for (const key of keys) {
          const cached = await this.cache.get<ParserData | null>(
            singleHash(key, parser, region_id),
            cacheOptions(options),
          );
          if (cached === undefined) missing.push(key);
          else data[key] = cached;
        }
        if (missing.length === 0) {
          plans.push({
            mode: "ready",
            part: { via: "parser.get", parser, phrases: keys, data, fromCache: true },
          });
          continue;
        }
        const paid = new Map<string, number>();
        for (const key of options.newTask ? [] : missing) {
          const latest = latestEntry(entries, singleHash(key, parser, region_id), reuseSince);
          if (latest?.status === "created") paid.set(key, Date.parse(latest.ts));
        }
        const billable = missing.length - paid.size;
        calls.push({
          method: "parser.get",
          parsers: [parser],
          phrases: missing.length,
          pendingPhrases: paid.size,
        });
        plans.push({
          mode: "single",
          parser,
          hash: requestHash("parser.get", { keys: [...missing].sort(), parser, region_id }),
          kopecks: unit * billable,
          missing,
          paid,
          data,
        });
        continue;
      }
      const hash = requestHash("parser.mass.new", { keys_list: sortedKeys, parser, region_id });
      const result = await this.cache.get<MassResult & { massId: number }>(
        hash,
        cacheOptions(options),
      );
      if (result) {
        plans.push({
          mode: "ready",
          part: {
            via: "parser.mass",
            parser,
            phrases: keys,
            massId: result.massId,
            result,
            fromCache: true,
            reusedTask: false,
          },
        });
        continue;
      }
      let reuse = reusableTask(entries, hash, reuseSince, !options.forceRefresh);
      const latest = latestEntry(entries, hash, reuseSince);
      let requested = latest?.status === "requested" ? latest : undefined;
      let abandon: LedgerEntry | undefined;
      if (options.newTask && (requested || (reuse && reuse.status !== "done"))) {
        abandon = requested ?? reuse;
        reuse = undefined;
        requested = undefined;
      }
      if (!reuse)
        calls.push({ method: "parser.mass.new", parsers: [parser], phrases: keys.length });
      plans.push({
        mode: "mass",
        parser,
        hash,
        kopecks: reuse ? 0 : unit * keys.length,
        reuse,
        createdAt: reuse && taskCreatedAt(entries, reuse),
        requested,
        abandon,
        seen: entries.length,
      });
    }
    const estimate = this.estimate(calls);
    if (options.dryRun) {
      const cached = plans.every((plan) => plan.mode === "ready");
      return { source: DATA_SOURCE, dryRun: true, estimate, ...(cached ? { cached } : {}) };
    }
    const planHash = requestHash(`plan.${label}`, {
      strategy,
      parts: plans.flatMap((plan) => (plan.mode === "ready" ? [] : [[plan.hash, plan.kopecks]])),
    });
    const warnings: string[] = [];
    const wait = {
      ...options,
      waitUntil: this.#waitUntil(
        options,
        strategy === "single" ? this.#taskTimeoutMs : this.#massTimeoutMs,
      ),
    };
    await this.#reserved(label, planHash, estimate, options, warnings, (reservation) =>
      settleAll(
        plans.map(async (plan, index) => {
          if (plan.mode === "ready") return;
          const part = await this.#once(plan.hash, () =>
            plan.mode === "single"
              ? this.#runSingle(plan, keys, region_id, reservation, wait, warnings)
              : this.#runMass(plan, keys, region_id, reservation, wait, warnings),
          );
          plans[index] = { mode: "ready", part: inRequestOrder(part, keys) };
        }),
      ),
    );
    return withWarnings(
      {
        source: DATA_SOURCE,
        dryRun: false as const,
        estimate,
        strategy,
        region: region_id,
        parts: plans.map((plan) => (plan as { part: ParserPart }).part),
      },
      warnings,
    );
  }

  async #runSingle(
    plan: Extract<PartPlan, { mode: "single" }>,
    keys: string[],
    region_id: string,
    reservation: Reservation | undefined,
    options: PaidCallOptions,
    warnings: string[],
  ): Promise<ParserPart> {
    const { parser } = plan;
    const data = { ...plan.data };
    const found = await Promise.allSettled(
      plan.missing.map((key) =>
        this.#singleKey(key, parser, region_id, plan.paid.get(key), reservation, options, warnings),
      ),
    );
    const errors: unknown[] = [];
    for (const [index, item] of found.entries()) {
      if (item.status === "rejected") errors.push(item.reason);
      else data[plan.missing[index] as string] = item.value;
    }
    if (errors.length > 0) throw combineFailures(errors);
    return { via: "parser.get", parser, phrases: keys, data, fromCache: false };
  }

  /**
   * Only the first parser.get of a phrase is paid (answer "create"), polling is free. The first
   * answer of an unpaid phrase is charged even when it is "finish"; any later "create" means
   * Mutagen made a new task and is charged again.
   */
  async #singleKey(
    key: string,
    parser: ParserType,
    region_id: string,
    paidAt: number | undefined,
    reservation: Reservation | undefined,
    options: PaidCallOptions,
    warnings: string[],
  ): Promise<ParserData | null> {
    const paid = paidAt !== undefined;
    const unit = toKopecks(this.prices[parserPriceKey(parser)].rub, parserPriceKey(parser));
    const hash = singleHash(key, parser, region_id);
    const entry = { method: "parser.get", requestHash: hash, estimateRub: paid ? 0 : unit / 100 };
    const label = `parser.get ${parser} «${key}»`;
    const recreated = `Мутаген создал задачу ${label} заново (ответ create) / Mutagen created the task again`;
    let first = true;
    let pending = paid;
    let createdAt = paidAt;
    let charged = 0;
    const charge = (reason?: string) => {
      charged += unit;
      reservation?.charge(unit, reason);
    };
    try {
      const result = await poll<ParserResult>(
        async () => {
          let response: Awaited<ReturnType<MutagenClient["parserGet"]>>;
          try {
            response = await this.client.parserGet({ key, parser, region_id }, signalOf(options));
          } catch (error) {
            if (first && !paid && !notCharged(error)) charge();
            throw error;
          }
          if (first) {
            first = false;
            if (!paid) charge();
            else if (response.status === "create") charge(recreated);
            if (charged > 0 && response.status !== "finish") {
              await this.#journal(
                { ...entry, status: "created", chargedRub: charged / 100 },
                warnings,
              );
              pending = true;
              createdAt = this.#now();
            }
          } else if (response.status === "create") {
            charge(recreated);
            await this.#journal(
              { ...entry, estimateRub: 0, status: "created", chargedRub: unit / 100 },
              warnings,
            );
            pending = true;
            createdAt = this.#now();
          }
          return parserGetStep(response);
        },
        waitOf(options, this.#taskTimeoutMs, label),
      );
      await this.#journal(
        {
          ...entry,
          status: "done",
          ...(charged > 0 && !pending ? { chargedRub: charged / 100 } : {}),
        },
        warnings,
      );
      await this.cache.set(hash, "frequency", result.data, cacheOptions(options));
      return result.data;
    } catch (error) {
      if (pollTimeout(error) && pending) {
        throw new TaskPendingError([label], { since: createdAt, now: this.#now() });
      }
      if (taskFailed(error) || (charged > 0 && !pending)) {
        await this.#journal(
          { ...entry, status: "failed", ...(pending ? {} : { chargedRub: charged / 100 }) },
          [],
        );
      }
      throw error;
    }
  }

  async #runMass(
    plan: Extract<PartPlan, { mode: "mass" }>,
    keys: string[],
    region_id: string,
    reservation: Reservation | undefined,
    options: PaidCallOptions,
    warnings: string[],
  ): Promise<ParserPart> {
    const { parser, hash } = plan;
    const name = `mutagen-ru-mcp ${hash.slice(0, 16)}`;
    const entry = {
      method: "parser.mass.new",
      requestHash: hash,
      estimateRub: plan.kopecks / 100,
    };
    let massId = plan.reuse?.massId;
    let createdAt = plan.createdAt;
    if (massId === undefined && plan.requested) {
      massId = await this.#findLostTask(plan.requested, name, parser, region_id, keys, options);
      if (massId !== undefined) {
        await this.#journal({ ...entry, estimateRub: 0, massId, status: "created" }, warnings);
      }
    }
    let reusedTask = massId !== undefined;
    if (massId === undefined) {
      const release = await this.ledger.lock(hash, this.#lockWaitMs, options.signal);
      try {
        const fresh = latestEntry((await this.ledger.entries()).slice(plan.seen), hash);
        if (fresh?.status === "requested" && release) {
          massId = await this.#findLostTask(fresh, name, parser, region_id, keys, options);
          if (massId !== undefined) {
            await this.#journal({ ...entry, estimateRub: 0, massId, status: "created" }, warnings);
          }
        } else if (fresh?.massId !== undefined && ["created", "done"].includes(fresh.status)) {
          massId = fresh.massId;
          createdAt = Date.parse(fresh.ts);
        }
        if (massId === undefined && !release) {
          throw new TaskPendingError([`parser.mass.new ${name}`]);
        }
        reusedTask = massId !== undefined;
        if (massId === undefined) {
          massId = await this.#createMass(
            plan,
            keys,
            region_id,
            name,
            reservation,
            options,
            warnings,
          );
          createdAt = this.#now();
        }
      } finally {
        await release?.();
      }
    }
    let result: MassResult;
    try {
      result = await this.client.waitMass(
        massId,
        waitOf(options, this.#massTimeoutMs, `parser.mass ${massId}`),
      );
    } catch (error) {
      if (pollTimeout(error)) {
        throw new TaskPendingError([`parser.mass ${massId}`], {
          since: createdAt,
          now: this.#now(),
        });
      }
      if (taskStopped(error)) await this.#journal({ ...entry, massId, status: "stopped" }, []);
      else if (taskFailed(error)) await this.#journal({ ...entry, massId, status: "failed" }, []);
      throw error;
    }
    await this.#journal({ ...entry, massId, status: "done" }, warnings);
    await this.cache.set(hash, "frequency", { ...result, massId }, cacheOptions(options));
    return {
      via: "parser.mass",
      parser,
      phrases: keys,
      massId,
      result,
      fromCache: false,
      reusedTask,
    };
  }

  /** Creates the paid mass task; the caller holds the lock on its request hash. */
  async #createMass(
    plan: Extract<PartPlan, { mode: "mass" }>,
    keys: string[],
    region_id: string,
    name: string,
    reservation: Reservation | undefined,
    options: PaidCallOptions,
    warnings: string[],
  ): Promise<number> {
    const { parser, hash } = plan;
    const entry = { method: "parser.mass.new", requestHash: hash, estimateRub: plan.kopecks / 100 };
    if (plan.abandon) {
      const { massId: oldId } = plan.abandon;
      await this.#journal(
        {
          ...entry,
          estimateRub: 0,
          ...(oldId === undefined ? {} : { massId: oldId }),
          status: "abandoned",
        },
        warnings,
      );
    }
    await this.ledger.append({ ...entry, status: "requested" });
    let massId: number;
    try {
      const task = await this.client.parserMassNew(
        { keys_list: keys, name, parser, region_id },
        signalOf(options),
      );
      massId = task.id;
    } catch (error) {
      if (notCharged(error)) {
        await this.#journal({ ...entry, status: refusedStatus(error) }, []);
      } else {
        reservation?.charge(plan.kopecks);
      }
      throw error;
    }
    reservation?.charge(plan.kopecks);
    await this.#journal(
      { ...entry, massId, status: "created", chargedRub: entry.estimateRub },
      warnings,
    );
    return massId;
  }

  async #findLostTask(
    requested: LedgerEntry,
    name: string,
    parser: ParserType,
    region_id: string,
    keys: readonly string[],
    options: PaidCallOptions,
  ): Promise<number | undefined> {
    const since = Date.parse(requested.ts) - LOST_TASK_SLACK_MS;
    const tasks = (await this.client.parserMassList(signalOf(options))).filter(
      (task) => task.time !== undefined && task.time * 1000 >= since,
    );
    const named = tasks.filter((task) => task.name === name);
    if (named.length > 0) return Math.max(...named.map((task) => task.id));
    const similar = tasks.filter((task) => {
      const checks = [
        task.parser === undefined ? undefined : task.parser === parser,
        task.region_id === undefined ? undefined : task.region_id === region_id,
        task.count === undefined ? undefined : task.count === keys.length,
      ].filter((check) => check !== undefined);
      return checks.length > 0 && checks.every(Boolean);
    });
    if (similar.length === 1) return similar[0]?.id;
    if (similar.length > 1) {
      const ids = similar.map((task) => task.id).join(", ");
      throw new MutagenError({
        kind: "task_ambiguous",
        retryable: false,
        message: `The response to parser.mass.new was lost and several tasks may match it: ${ids}`,
        hintRu: `Ответ на создание массового задания потерялся, а похожих заданий несколько (${ids}). Новое платное задание не создавалось. Проверьте список заданий (mutagen_mass_tasks) и заберите результат нужного по номеру.`,
        hintEn: `The response to the mass task creation was lost and several tasks look similar (${ids}). No new paid task was created. Check the task list (mutagen_mass_tasks) and fetch the right one by its id.`,
      });
    }
    return undefined;
  }

  async #checkKey(
    plan: Extract<CompetitionPlan, { mode: "check" }>,
    kopecks: number,
    reservation: Reservation | undefined,
    options: PaidCallOptions,
    warnings: string[],
  ): Promise<CompetitionRow> {
    const { phrase, hash } = plan;
    const entry = { method: "check_key.new", requestHash: hash, estimateRub: kopecks / 100 };
    let result: CheckKeyResult | undefined;
    let taskId = plan.taskId;
    let reusedTask = false;
    if (taskId !== undefined) {
      try {
        result = await this.#waitCheckKey(taskId, undefined, options);
        reusedTask = true;
      } catch (error) {
        if (pollTimeout(error)) {
          throw new TaskPendingError([`check_key ${taskId}`], {
            since: plan.createdAt,
            now: this.#now(),
          });
        }
        if (!taskFailed(error)) throw error;
        if (plan.pending) {
          await this.#journal({ ...entry, estimateRub: 0, taskId, status: "failed" }, []);
          throw error;
        }
      }
    }
    if (!result) {
      await this.ledger.append({ ...entry, status: "requested" });
      let task: Awaited<ReturnType<MutagenClient["checkKeyNew"]>>;
      try {
        task = await this.client.checkKeyNew(phrase, signalOf(options));
      } catch (error) {
        if (notCharged(error)) await this.#journal({ ...entry, status: refusedStatus(error) }, []);
        else reservation?.charge(kopecks);
        throw error;
      }
      reservation?.charge(kopecks);
      taskId = task.task_id;
      const created = { ...entry, taskId };
      await this.#journal({ ...created, status: "created", chargedRub: kopecks / 100 }, warnings);
      try {
        result = await this.#waitCheckKey(taskId, task.status, options);
      } catch (error) {
        if (pollTimeout(error)) {
          throw new TaskPendingError([`check_key ${taskId}`], {
            since: this.#now(),
            now: this.#now(),
          });
        }
        if (taskFailed(error)) await this.#journal({ ...created, status: "failed" }, []);
        throw error;
      }
    }
    await this.#journal(
      { ...entry, ...(taskId === undefined ? {} : { taskId }), status: "done" },
      warnings,
    );
    await this.cache.set(hash, "competition", result, cacheOptions(options));
    return { phrase, result, fromCache: false, reusedTask };
  }

  #waitCheckKey(
    taskId: number,
    initialStatus: string | undefined,
    options: PaidCallOptions,
  ): Promise<CheckKeyResult> {
    const signal = signalOf(options);
    const label = `check_key ${taskId}`;
    return poll<CheckKeyResult>(
      async (attempt) => {
        if (attempt === 1 && initialStatus === "rejected") {
          return { state: "failed", status: initialStatus };
        }
        const response = await this.client.checkKeyGet(taskId, signal);
        if (response.status === "completed") {
          return { state: "done", value: response as CheckKeyResult };
        }
        if (response.status === "rejected" || response.status === "error") {
          return { state: "failed", status: response.status };
        }
        return { state: "pending", status: response.status };
      },
      waitOf(options, this.#taskTimeoutMs, label),
    );
  }

  /** Polls a mass job until it finishes or the wait limit ends; then returns its last state. */
  async #pollMass(massId: number, options: LiveCallOptions): Promise<MassResult> {
    let last: MassResult | undefined;
    try {
      return await poll<MassResult>(
        async () => {
          last = await this.client.parserMassId(massId, signalOf(options));
          if (last.status === "finish") return { state: "done", value: last };
          if (last.status === "error") return { state: "failed", status: last.status };
          return { state: "pending", status: last.status };
        },
        waitOf(options, this.#massTimeoutMs, `parser.mass ${massId}`),
      );
    } catch (error) {
      if (pollTimeout(error) && last) return last;
      throw error;
    }
  }

  #waitUntil(options: LiveCallOptions, timeoutMs: number): number {
    return Math.min(Date.now() + timeoutMs, options.waitUntil ?? Number.POSITIVE_INFINITY);
  }

  #once<T>(key: string, run: () => Promise<T>): Promise<T> {
    const running = this.#inflight.get(key);
    if (running) return running as Promise<T>;
    const promise = run().finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, promise);
    return promise;
  }

  async #journal(entry: LedgerInput, warnings: string[]): Promise<void> {
    try {
      await this.ledger.append(entry);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(
        `Не удалось записать журнал задач ${this.ledger.path}: ${detail}. Результат получен, но повтор запроса может не найти задание. Ledger write failed.`,
      );
    }
  }

  async #reserved<T>(
    label: string,
    planHash: string,
    estimate: Estimate,
    options: PaidCallOptions,
    warnings: string[],
    run: (reservation: Reservation | undefined) => Promise<T>,
  ): Promise<T> {
    if (estimate.items.length === 0) return run(undefined);
    const allowance = this.#allowance.getStore();
    const reservation = allowance
      ? allowance.reserve(label, estimate)
      : await this.guard.authorize({
          label,
          planHash,
          estimate,
          confirmToken: options.confirmToken,
        });
    try {
      const result = await run(reservation);
      reservation.close("ok");
      const overrun = reservation.overrunWarning();
      if (overrun) warnings.push(overrun);
      return result;
    } catch (error) {
      reservation.close("failed");
      const overrun = reservation.overrunWarning();
      if (overrun && isTaskPending(error)) error.warnings.push(overrun);
      throw error;
    }
  }
}
