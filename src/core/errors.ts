export type MutagenErrorKind =
  | "validation"
  | "auth"
  | "method"
  | "balance"
  | "not_found"
  | "ip_not_allowed"
  | "rate_limit"
  | "subscription_required"
  | "subscription_limit"
  | "report_busy"
  | "report_in_progress"
  | "invalid_item"
  | "no_data"
  | "report_failed"
  | "api"
  | "auth_or_server"
  | "invalid_response"
  | "http"
  | "network"
  | "timeout"
  | "aborted"
  | "task_failed"
  | "task_stopped"
  | "task_ambiguous"
  | "task_pending"
  | "poll_timeout";

export interface MutagenErrorInit {
  kind: MutagenErrorKind;
  message: string;
  retryable?: boolean;
  code?: number;
  status?: number;
  hintRu: string;
  hintEn: string;
  cause?: unknown;
  beforeStart?: boolean;
  detail?: string;
}

export class MutagenError extends Error {
  override readonly name = "MutagenError";
  readonly kind: MutagenErrorKind;
  readonly retryable: boolean;
  readonly code: number | undefined;
  readonly status: number | undefined;
  readonly hintRu: string;
  readonly hintEn: string;
  readonly beforeStart: boolean;
  /** `error_detail` of the API answer, in Russian. */
  readonly detail: string | undefined;

  constructor(init: MutagenErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.kind = init.kind;
    this.retryable = init.retryable ?? false;
    this.code = init.code;
    this.status = init.status;
    this.hintRu = init.hintRu;
    this.hintEn = init.hintEn;
    this.beforeStart = init.beforeStart ?? false;
    this.detail = init.detail;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      code: this.code,
      status: this.status,
      retryable: this.retryable,
      message: this.message,
      hintRu: this.hintRu,
      hintEn: this.hintEn,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
      ...(this.beforeStart ? { beforeStart: true } : {}),
    };
  }
}

export function isMutagenError(value: unknown): value is MutagenError {
  return value instanceof MutagenError;
}

export interface ApiErrorInfo {
  code: number;
  apiMessage: string;
  kind: MutagenErrorKind;
  retryable: boolean;
  hintRu: string;
  hintEn: string;
}

const KEY_HINT_RU =
  "Проверьте ключ MUTAGEN_API_KEY в кабинете https://mutagen.ru/?api_config и при необходимости выпустите новый.";
const KEY_HINT_EN =
  "Check MUTAGEN_API_KEY at https://mutagen.ru/?api_config and reissue the key if needed.";

export const API_ERRORS: Readonly<Record<number, ApiErrorInfo>> = Object.freeze({
  100: {
    code: 100,
    apiMessage: "Not enough params",
    kind: "validation",
    retryable: false,
    hintRu: "Не хватает обязательных параметров запроса.",
    hintEn: "Required request parameters are missing.",
  },
  101: {
    code: 101,
    apiMessage: "Authorization failed",
    kind: "auth",
    retryable: false,
    hintRu: `Данные авторизации не подходят. ${KEY_HINT_RU}`,
    hintEn: `Authorization failed. ${KEY_HINT_EN}`,
  },
  102: {
    code: 102,
    apiMessage: "Authorization need",
    kind: "auth",
    retryable: false,
    hintRu: `Требуется авторизация. ${KEY_HINT_RU}`,
    hintEn: `Authorization required. ${KEY_HINT_EN}`,
  },
  103: {
    code: 103,
    apiMessage: "Session not valid",
    kind: "auth",
    retryable: false,
    hintRu: `Сессия истекла. ${KEY_HINT_RU}`,
    hintEn: `Session expired. ${KEY_HINT_EN}`,
  },
  104: {
    code: 104,
    apiMessage: "No action...",
    kind: "method",
    retryable: false,
    hintRu: "Такого метода в API нет. Обновите mutagen-ru-mcp или сообщите об ошибке.",
    hintEn: "The API has no such method. Update mutagen-ru-mcp or report a bug.",
  },
  105: {
    code: 105,
    apiMessage: "Key not valid",
    kind: "auth",
    retryable: false,
    hintRu: `Ключ API невалиден. ${KEY_HINT_RU}`,
    hintEn: `The API key is not valid. ${KEY_HINT_EN}`,
  },
  106: {
    code: 106,
    apiMessage: "Low balance",
    kind: "balance",
    retryable: false,
    hintRu:
      "На балансе Мутагена недостаточно средств. Пополните баланс: https://mutagen.ru/?bill=on",
    hintEn: "Not enough money on the Mutagen balance. Top up at https://mutagen.ru/?bill=on",
  },
  107: {
    code: 107,
    apiMessage: "task_id not found",
    kind: "not_found",
    retryable: false,
    hintRu: "Задание с таким id не найдено. Проверьте номер задания.",
    hintEn: "No task with this id. Check the task id.",
  },
  108: {
    code: 108,
    apiMessage: "options error",
    kind: "validation",
    retryable: false,
    hintRu: "Неверный формат параметров запроса. Подробности — в тексте ошибки.",
    hintEn: "Invalid request parameters. See the error message for details.",
  },
  109: {
    code: 109,
    apiMessage: "ip not allowed",
    kind: "ip_not_allowed",
    retryable: false,
    hintRu:
      "IP-адрес не разрешен для API. Добавьте его в белый список в кабинете https://mutagen.ru/?api_config",
    hintEn: "This IP is not allowed. Add it to the whitelist at https://mutagen.ru/?api_config",
  },
  110: {
    code: 110,
    apiMessage: "need timeout",
    kind: "rate_limit",
    retryable: true,
    hintRu: "Слишком частые запросы к API. Повторите позже или уменьшите частоту запросов.",
    hintEn: "Too many requests. Retry later or lower the request rate.",
  },
  111: {
    code: 111,
    apiMessage: "subscription required",
    kind: "subscription_required",
    retryable: false,
    hintRu:
      "Нужна подписка на Мега-инструмент с доступом по API (тариф от «Простого»): https://mutagen.ru/serp/?tarif",
    hintEn:
      "A Mega-tool subscription with API access is required (Simple plan or higher): https://mutagen.ru/serp/?tarif",
  },
  112: {
    code: 112,
    apiMessage: "subscription limit finish",
    kind: "subscription_limit",
    retryable: false,
    hintRu: "Лимит подписки исчерпан (запросы или строки экспорта). Дождитесь обновления лимита.",
    hintEn: "Subscription limit reached (requests or export rows). Wait for the limit to reset.",
  },
  113: {
    code: 113,
    apiMessage: "another report in process",
    kind: "report_busy",
    retryable: true,
    hintRu: "Отчет этого типа уже готовится; одновременно готовится только один. Повторите позже.",
    hintEn: "Another report of this type is being prepared; only one at a time. Retry later.",
  },
  114: {
    code: 114,
    apiMessage: "report in process",
    kind: "report_in_progress",
    retryable: true,
    hintRu: "Отчет готовится. Повторите запрос позже.",
    hintEn: "The report is being prepared. Retry later.",
  },
  115: {
    code: 115,
    apiMessage: "report_id not found",
    kind: "not_found",
    retryable: false,
    hintRu: "Отчет не найден.",
    hintEn: "Report not found.",
  },
  116: {
    code: 116,
    apiMessage: "invalid item",
    kind: "invalid_item",
    retryable: false,
    hintRu: "Невалидный домен, страница или фраза в запросе.",
    hintEn: "Invalid domain, page or phrase in the request.",
  },
  117: {
    code: 117,
    apiMessage: "item missing in database",
    kind: "no_data",
    retryable: false,
    hintRu: "В базе Мутагена нет данных по этому домену, странице или фразе.",
    hintEn: "Mutagen has no data for this domain, page or phrase.",
  },
  118: {
    code: 118,
    apiMessage: "report could not be generated",
    kind: "report_failed",
    retryable: false,
    hintRu: "Данные для отчета не могут быть рассчитаны.",
    hintEn: "The report data could not be calculated.",
  },
});

export function apiErrorInfo(code: number): ApiErrorInfo | undefined {
  return API_ERRORS[code];
}

export function codeFromApiMessage(message: string): number | undefined {
  const normalized = message
    .replace(/^\s*MUTAGEN\.RU:\s*/i, "")
    .trim()
    .toLowerCase();
  if (normalized === "") return undefined;
  for (const info of Object.values(API_ERRORS)) {
    if (normalized === info.apiMessage.toLowerCase()) return info.code;
  }
  for (const info of Object.values(API_ERRORS)) {
    if (normalized.startsWith(info.apiMessage.replace(/\.+$/, "").toLowerCase())) return info.code;
  }
  return undefined;
}

export function apiError(
  code: number | undefined,
  message: string | undefined,
  detail?: string,
): MutagenError {
  const info = code === undefined ? undefined : apiErrorInfo(code);
  const text = message?.trim() || info?.apiMessage || "Unknown API error";
  const prefix = code === undefined ? "Mutagen API error" : `Mutagen API error ${code}`;
  const extra = detail?.trim() || undefined;
  const fullText = extra ? `${text} — ${extra}` : text;
  const withDetail = (hint: string) => (extra ? `Мутаген: «${extra}». ${hint}` : hint);
  const base = {
    message: `${prefix}: ${fullText}`,
    ...(extra ? { detail: extra } : {}),
  };
  if (info) {
    return new MutagenError({
      ...base,
      kind: info.kind,
      code: info.code,
      retryable: info.retryable,
      hintRu: withDetail(info.hintRu),
      hintEn: info.hintEn,
    });
  }
  return new MutagenError({
    ...base,
    kind: "api",
    ...(code === undefined ? {} : { code }),
    retryable: false,
    hintRu: withDetail("API Мутагена вернуло ошибку. Подробности — в тексте ошибки."),
    hintEn: "The Mutagen API returned an error. See the message for details.",
  });
}

export function validationError(message: string, hintRu: string, hintEn: string): MutagenError {
  return new MutagenError({ kind: "validation", retryable: false, message, hintRu, hintEn });
}

export function abortedError(beforeStart = false): MutagenError {
  return new MutagenError({
    kind: "aborted",
    retryable: false,
    beforeStart,
    message: "The request was aborted",
    hintRu: "Запрос отменен.",
    hintEn: "The request was cancelled.",
  });
}

export const STALE_TASK_MS = 2 * 60 * 60_000;

export const STALE_TASK_RU =
  "Задача висит больше 2 часов. Вероятно, сбой на стороне Мутагена или Яндекс Директа (ставки и конкуренция зависят от Директа). Деньги уже списаны, повтор опроса бесплатный; проверьте кабинет или напишите в support@mutagen.ru.";
export const STALE_TASK_EN =
  "The task has been pending for over 2 hours. Most likely a failure at Mutagen or Yandex Direct (bids and competition depend on Direct). The money is already charged, polling again is free; check the account or write to support@mutagen.ru.";

/** A paid task is created but still running at Mutagen after the wait limit. */
export class TaskPendingError extends MutagenError {
  readonly tasks: readonly string[];
  /** Epoch ms of the oldest task creation, when known from the ledger. */
  readonly since: number | undefined;
  readonly stale: boolean;
  /** Notes for the answer, such as spending beyond the estimate before the wait ended. */
  readonly warnings: string[];

  constructor(
    tasks: readonly string[],
    age: { since?: number | undefined; now?: number; stale?: boolean; warnings?: string[] } = {},
  ) {
    const list = tasks.join(", ");
    const { since } = age;
    const stale =
      age.stale ?? (since !== undefined && (age.now ?? Date.now()) - since > STALE_TASK_MS);
    super({
      kind: "task_pending",
      retryable: true,
      message: `Mutagen is still processing: ${list}`,
      hintRu: `Мутаген ещё считает (это может занять до 30+ минут). Повторите тот же вызов позже — повтор бесплатный, задача подхватится. Задачи: ${list}.${stale ? ` ${STALE_TASK_RU}` : ""}`,
      hintEn: `Mutagen is still processing (this may take 30+ minutes). Repeat the same call later: the repeat is free and picks the task up. Tasks: ${list}.${stale ? ` ${STALE_TASK_EN}` : ""}`,
    });
    this.tasks = tasks;
    this.since = since;
    this.stale = stale;
    this.warnings = [...(age.warnings ?? [])];
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), tasks: this.tasks, ...(this.stale ? { stale: true } : {}) };
  }
}

export function isTaskPending(value: unknown): value is TaskPendingError {
  return value instanceof TaskPendingError;
}

/** One error for several parallel steps: the first real failure, else all pending tasks. */
export function combineFailures(errors: readonly unknown[]): unknown {
  const failure = errors.find((error) => !isTaskPending(error));
  if (failure !== undefined) return failure;
  const pending = errors as TaskPendingError[];
  const since = pending.flatMap((error) => (error.since === undefined ? [] : [error.since]));
  return new TaskPendingError(
    pending.flatMap((error) => error.tasks),
    {
      ...(since.length > 0 ? { since: Math.min(...since) } : {}),
      stale: pending.some((error) => error.stale),
      warnings: pending.flatMap((error) => error.warnings),
    },
  );
}
