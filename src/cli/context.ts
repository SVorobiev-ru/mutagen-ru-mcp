import { extname, resolve } from "node:path";
import { SpendGuard, type Spending } from "../budget/guard.js";
import { loadConfig, type MutagenConfig } from "../config.js";
import { SAVE_EXTENSIONS } from "../mcp/context.js";
import { MISSING_KEY_EN, MISSING_KEY_RU } from "../mcp/links.js";
import { MutagenSession, type PaidCallOptions, type WaitProgress } from "../session.js";
import { CliError, EXIT, usageError } from "./errors.js";
import type { CliIo } from "./io.js";

export type StdoutFormat = "table" | "csv" | "json";

export const DEFAULT_TABLE_LIMIT = 20;
export const PROGRESS_INTERVAL_MS = 30_000;

export interface GlobalOptions {
  output?: string;
  format?: StdoutFormat;
  json?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  cache?: boolean;
  refresh?: boolean;
  newTask?: boolean;
  budget?: number;
  freeOnly?: boolean;
  limit?: number;
  quiet?: boolean;
}

export class CliContext {
  readonly io: CliIo;
  readonly opts: GlobalOptions;
  readonly config: MutagenConfig;
  readonly outputPath: string | undefined;
  #session: MutagenSession | undefined;
  #startedAt: number | undefined;
  #reportedAt = 0;

  constructor(io: CliIo, opts: GlobalOptions) {
    this.io = io;
    this.opts = opts;
    this.config = loadConfig(io.env);
    this.outputPath = opts.output === undefined ? undefined : this.#outputPath(opts.output);
  }

  get signal(): AbortSignal | undefined {
    return this.io.signal;
  }

  out(text: string): void {
    this.io.stdout.write(text);
  }

  info(text: string): void {
    if (!this.opts.quiet) this.io.stderr.write(`${text}\n`);
  }

  /** `local`: the call never reaches the API, so it runs without MUTAGEN_API_KEY too. */
  session(local = false): MutagenSession {
    const options = {
      ...(this.opts.budget === undefined ? {} : { budgetRub: this.opts.budget }),
      ...(this.opts.freeOnly ? { freeOnly: true } : {}),
      ...(this.opts.cache === false ? { noCache: true } : {}),
    };
    if (!this.config.apiKey) {
      if (!local) throw new CliError(EXIT.usage, MISSING_KEY_RU, MISSING_KEY_EN);
      this.#session ??= MutagenSession.offline(this.config, options);
      return this.#session;
    }
    this.#session ??= MutagenSession.fromConfig(this.config, {
      ...(this.io.fetch ? { fetch: this.io.fetch } : {}),
      ...options,
    });
    return this.#session;
  }

  spending(): Spending {
    if (this.#session) return this.#session.spending();
    return new SpendGuard({
      budgetRub: Math.min(this.config.budgetRub, this.opts.budget ?? Number.POSITIVE_INFINITY),
      autoApproveRub: this.config.autoApproveRub,
      freeOnly: this.config.freeOnly || this.opts.freeOnly === true,
    }).spending();
  }

  paidOptions(): PaidCallOptions {
    return {
      ...this.waitOptions(),
      ...(this.opts.dryRun ? { dryRun: true } : {}),
      ...(this.opts.refresh ? { forceRefresh: true } : {}),
      ...(this.opts.newTask ? { newTask: true } : {}),
    };
  }

  liveOptions(): { signal?: AbortSignal } {
    return this.signal ? { signal: this.signal } : {};
  }

  /** Long waits report progress to stderr every 30 s. */
  waitOptions(): { signal?: AbortSignal; onWait: (progress: WaitProgress) => void } {
    return { ...this.liveOptions(), onWait: (progress) => this.#progress(progress) };
  }

  #progress({ label, status }: WaitProgress): void {
    const now = Date.now();
    this.#startedAt ??= now;
    if (now - this.#reportedAt < PROGRESS_INTERVAL_MS) return;
    if (this.#reportedAt === 0) {
      this.#reportedAt = now;
      return;
    }
    this.#reportedAt = now;
    const seconds = Math.round((now - this.#startedAt) / 1000);
    const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    this.info(
      `Мутаген еще считает (${label}${status ? `: ${status}` : ""}), ждем ${elapsed}. Ctrl+C прерывает, повтор команды бесплатно подхватит задачу. Still processing.`,
    );
  }

  #outputPath(file: string): string {
    const path = resolve(this.io.cwd ?? process.cwd(), file);
    if (!SAVE_EXTENSIONS.includes(extname(path).toLowerCase())) {
      throw usageError(
        "-o: укажите файл с расширением .csv, .json, .ndjson или .xlsx.",
        "-o: use a file name ending in .csv, .json, .ndjson or .xlsx.",
      );
    }
    return path;
  }
}
