import { abortedError, isMutagenError, type MutagenError } from "./errors.js";
import { sleep } from "./sleep.js";
import { requirePositive } from "./validate.js";

export interface RateLimitOptions {
  concurrency?: number;
  perSecond?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
}

export interface RunOptions {
  signal?: AbortSignal;
  shouldRetry?: (error: MutagenError) => boolean;
  onRetry?: (error: MutagenError) => void;
}

export const DEFAULT_RATE_LIMIT = Object.freeze({
  concurrency: 2,
  perSecond: 3,
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
});

const WINDOW_MS = 1_000;

type Waiter = () => void;

export class RateLimiter {
  readonly concurrency: number;
  readonly perSecond: number;
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly #random: () => number;
  #active = 0;
  #queue: Waiter[] = [];
  #starts: number[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: RateLimitOptions = {}) {
    this.concurrency = requirePositive(
      "concurrency",
      options.concurrency ?? DEFAULT_RATE_LIMIT.concurrency,
      true,
    );
    this.perSecond = requirePositive(
      "perSecond",
      options.perSecond ?? DEFAULT_RATE_LIMIT.perSecond,
      true,
    );
    this.maxAttempts = requirePositive(
      "maxAttempts",
      options.maxAttempts ?? DEFAULT_RATE_LIMIT.maxAttempts,
      true,
    );
    this.baseDelayMs = requirePositive(
      "baseDelayMs",
      options.baseDelayMs ?? DEFAULT_RATE_LIMIT.baseDelayMs,
    );
    this.maxDelayMs = requirePositive(
      "maxDelayMs",
      options.maxDelayMs ?? DEFAULT_RATE_LIMIT.maxDelayMs,
    );
    this.#random = options.random ?? Math.random;
  }

  get active(): number {
    return this.#active;
  }

  get pending(): number {
    return this.#queue.length;
  }

  schedule<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortedError(true));
        return;
      }
      const onAbort = () => {
        const index = this.#queue.indexOf(waiter);
        if (index !== -1) {
          this.#queue.splice(index, 1);
          reject(abortedError(true));
        }
      };
      const waiter: Waiter = () => {
        signal?.removeEventListener("abort", onAbort);
        this.#active += 1;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            this.#active -= 1;
            this.#pump();
          });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(waiter);
      this.#pump();
    });
  }

  async run<T>(task: () => Promise<T>, options: RunOptions = {}): Promise<T> {
    const { signal, shouldRetry, onRetry } = options;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.schedule(task, signal);
      } catch (error) {
        const retry =
          attempt < this.maxAttempts &&
          isMutagenError(error) &&
          error.retryable &&
          !signal?.aborted &&
          (shouldRetry?.(error) ?? true);
        if (!retry) throw error;
        await sleep(this.retryDelay(attempt), signal);
        onRetry?.(error);
      }
    }
  }

  retryDelay(attempt: number): number {
    const ceiling = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
    return Math.round(ceiling / 2 + this.#random() * (ceiling / 2));
  }

  #pump(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    while (this.#active < this.concurrency && this.#queue.length > 0) {
      const now = Date.now();
      this.#starts = this.#starts.filter((time) => now - time < WINDOW_MS);
      const oldest = this.#starts[0];
      if (oldest !== undefined && this.#starts.length >= this.perSecond) {
        this.#timer = setTimeout(() => this.#pump(), oldest + WINDOW_MS - now);
        return;
      }
      const waiter = this.#queue.shift();
      if (waiter === undefined) return;
      this.#starts.push(now);
      waiter();
    }
  }
}
