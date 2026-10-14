import { abortedError, MutagenError } from "./errors.js";
import { sleep } from "./sleep.js";

export type PollStep<T> =
  | { state: "done"; value: T }
  | { state: "pending"; status?: string }
  | { state: "failed"; status: string; message?: string };

export interface PollOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  factor?: number;
  label?: string;
  onPending?: (status: string | undefined) => void;
}

export const DEFAULT_POLL_INTERVAL = Object.freeze({
  initialIntervalMs: 2_000,
  maxIntervalMs: 15_000,
  factor: 1.5,
});

export async function poll<T>(
  check: (attempt: number) => Promise<PollStep<T>>,
  options: PollOptions,
): Promise<T> {
  const { signal, timeoutMs } = options;
  const label = options.label ?? "task";
  const maxInterval = options.maxIntervalMs ?? DEFAULT_POLL_INTERVAL.maxIntervalMs;
  const factor = options.factor ?? DEFAULT_POLL_INTERVAL.factor;
  let interval = options.initialIntervalMs ?? DEFAULT_POLL_INTERVAL.initialIntervalMs;
  const deadline = Date.now() + timeoutMs;

  for (let attempt = 1; ; attempt += 1) {
    if (signal?.aborted) throw abortedError();
    const step = await check(attempt);
    if (step.state === "done") return step.value;
    if (step.state === "failed") {
      const detail = step.message ? `: ${step.message}` : "";
      throw new MutagenError({
        kind: "task_failed",
        retryable: false,
        message: `${label} finished with status "${step.status}"${detail}`,
        hintRu: `Мутаген завершил задание со статусом «${step.status}». Проверьте параметры запроса и при необходимости создайте задание заново.`,
        hintEn: `Mutagen finished the task with status "${step.status}". Check the request parameters and create the task again if needed.`,
      });
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const status = step.status ? ` (last status "${step.status}")` : "";
      throw new MutagenError({
        kind: "poll_timeout",
        retryable: false,
        message: `${label} is not ready after ${timeoutMs} ms${status}`,
        hintRu:
          "Задание еще выполняется у Мутагена. Запросите результат позже по номеру задания; создавать задание заново не нужно — это может стоить денег.",
        hintEn:
          "The task is still running at Mutagen. Fetch the result later by its id; do not create it again, that may cost money.",
      });
    }
    options.onPending?.(step.status);
    await sleep(Math.min(interval, remaining), signal);
    interval = Math.min(maxInterval, interval * factor);
  }
}
