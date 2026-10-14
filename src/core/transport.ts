import {
  abortedError,
  apiError,
  codeFromApiMessage,
  MutagenError,
  validationError,
} from "./errors.js";
import { requirePositive } from "./validate.js";

export const DEFAULT_BASE_URL = "http://api.mutagen.ru/json";
export const DEFAULT_TIMEOUT_MS = 60_000;
export const REDACTED = "***";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface TransportOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type RequestParams = Record<string, unknown>;

const KEY_OR_IP_HINT_RU =
  "Мутаген отвечает так при неверном ключе API или при сбое сервера. Проверьте MUTAGEN_API_KEY и белый список IP в кабинете https://mutagen.ru/?api_config, затем повторите позже.";
const KEY_OR_IP_HINT_EN =
  "Mutagen answers like this to an invalid API key or a server failure. Check MUTAGEN_API_KEY and the IP whitelist at https://mutagen.ru/?api_config, then retry later.";

export function redactSecret(text: string, secret: string): string {
  if (secret === "") return text;
  let result = text.split(secret).join(REDACTED);
  const encoded = encodeURIComponent(secret);
  if (encoded !== secret) result = result.split(encoded).join(REDACTED);
  return result;
}

function sanitizeCause(value: unknown, secret: string, depth = 0): unknown {
  if (typeof value === "string") return redactSecret(value, secret);
  if (!(value instanceof Error) || depth > 4) return undefined;
  const copy = new Error(redactSecret(value.message, secret));
  copy.name = value.name;
  if (value.stack !== undefined) copy.stack = redactSecret(value.stack, secret);
  const code = (value as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") {
    Object.defineProperty(copy, "code", { value: code, enumerable: true });
  }
  if (value.cause !== undefined) {
    const cause = sanitizeCause(value.cause, secret, depth + 1);
    if (cause !== undefined) copy.cause = cause;
  }
  return copy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NUMERIC_TEXT = /^\s*\d+\s*$/;

function isPresent(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "" && value.trim() !== "0";
  return value !== undefined && value !== null && value !== false && value !== 0;
}

function toCode(value: unknown): number | undefined {
  const code = typeof value === "string" && NUMERIC_TEXT.test(value) ? Number(value) : value;
  return typeof code === "number" && Number.isSafeInteger(code) && code > 0 ? code : undefined;
}

function buildApiError(codes: unknown[], messages: unknown[]): { code?: number; message: string } {
  const texts = [
    ...new Set(messages.filter((m): m is string => typeof m === "string" && !NUMERIC_TEXT.test(m))),
  ]
    .map((m) => m.trim())
    .filter((m) => m !== "");
  const message = texts.join(" — ");
  let code: number | undefined;
  for (const candidate of codes) {
    code = toCode(candidate);
    if (code !== undefined) break;
  }
  if (code === undefined) {
    for (const text of texts) {
      code = codeFromApiMessage(text);
      if (code !== undefined) break;
    }
  }
  return code === undefined ? { message } : { code, message };
}

export interface ApiErrorBody {
  code?: number;
  message: string;
  detail?: string;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** `{"error_id": N, "error": "...", "error_detail": "..."}` at HTTP 200; other shapes are fallbacks. */
export function extractApiError(body: unknown): ApiErrorBody | undefined {
  if (!isRecord(body)) return undefined;
  const errorId = toCode(body.error_id);
  if (errorId !== undefined) {
    const detail = textOf(body.error_detail);
    const message = textOf(body.error) ?? textOf(body.error_msg) ?? "";
    return {
      code: errorId,
      message: NUMERIC_TEXT.test(message) ? "" : message,
      ...(detail ? { detail } : {}),
    };
  }
  if (isPresent(body.faultCode) || isPresent(body.faultString)) {
    return buildApiError([body.faultCode], [body.faultString]);
  }
  const error = body.error;
  if (isRecord(error)) {
    return buildApiError(
      [error.code, error.id, error.error_id, error.faultCode, body.error_code],
      [error.message, error.msg, error.error_msg, error.text, error.faultString, body.error_msg],
    );
  }
  if (
    isPresent(body.error_id) ||
    isPresent(body.error_code) ||
    isPresent(body.error_msg) ||
    isPresent(error)
  ) {
    return buildApiError(
      [body.error_code, error === true ? undefined : error, body.code],
      [body.error_msg, error, body.message],
    );
  }
  return undefined;
}

export class Transport {
  readonly #apiKey: string;
  readonly #fetch: FetchLike | undefined;
  readonly baseUrl: string;
  readonly timeoutMs: number;

  constructor(options: TransportOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.trim() === "") {
      throw validationError(
        "Mutagen API key is empty",
        "Не задан ключ API Мутагена. Укажите MUTAGEN_API_KEY (ключ: https://mutagen.ru/?api_config).",
        "The Mutagen API key is missing. Set MUTAGEN_API_KEY (get it at https://mutagen.ru/?api_config).",
      );
    }
    this.#apiKey = options.apiKey.trim();
    this.#fetch = options.fetch;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = requirePositive("timeoutMs", options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  redact(text: string): string {
    return redactSecret(text, this.#apiKey);
  }

  async call(
    method: string,
    params?: RequestParams,
    options: RequestOptions = {},
  ): Promise<unknown> {
    const { signal } = options;
    if (signal?.aborted) throw abortedError(true);

    const hasParams = params !== undefined && Object.keys(params).length > 0;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
    };
    if (hasParams) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs ?? this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    let status: number;
    let text = "";
    let redirected: boolean;
    try {
      const fetchImpl = this.#fetch ?? globalThis.fetch;
      const init: RequestInit = {
        method: hasParams ? "POST" : "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      };
      if (hasParams) init.body = JSON.stringify(params);
      const response = await fetchImpl(this.#url(method), init);
      status = response.status;
      redirected = response.type === "opaqueredirect" || (status >= 300 && status < 400);
      if (!redirected) text = await response.text();
    } catch (error) {
      throw this.#requestError(method, error, signal, timedOut);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    if (redirected) throw this.#redirectError(method, status);
    return this.#parse(method, status, text);
  }

  toJSON(): Record<string, unknown> {
    return { baseUrl: this.baseUrl, timeoutMs: this.timeoutMs, apiKey: REDACTED };
  }

  toString(): string {
    return `Transport(${this.baseUrl})`;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): Record<string, unknown> {
    return this.toJSON();
  }

  #url(method: string): string {
    return `${this.baseUrl}/${encodeURIComponent(this.#apiKey)}/${method}/`;
  }

  #requestError(
    method: string,
    error: unknown,
    signal: AbortSignal | undefined,
    timedOut: boolean,
  ): MutagenError {
    const cause = sanitizeCause(error, this.#apiKey);
    if (signal?.aborted) return abortedError();
    if (timedOut) {
      return new MutagenError({
        kind: "timeout",
        retryable: true,
        message: `Request to ${method} timed out`,
        hintRu: "API Мутагена не ответило вовремя. Повторите позже или увеличьте тайм-аут.",
        hintEn: "The Mutagen API did not respond in time. Retry later or increase the timeout.",
        cause,
      });
    }
    const detail = error instanceof Error ? error.message : String(error);
    return new MutagenError({
      kind: "network",
      retryable: true,
      message: this.redact(`Network error while calling ${method}: ${detail}`),
      hintRu: "Сетевая ошибка при обращении к API Мутагена. Проверьте подключение и повторите.",
      hintEn: "Network error while calling the Mutagen API. Check the connection and retry.",
      cause,
    });
  }

  #redirectError(method: string, status: number): MutagenError {
    return new MutagenError({
      kind: "http",
      status,
      retryable: false,
      message: `Mutagen API answered ${method} with a redirect (HTTP ${status}); redirects are not followed`,
      hintRu:
        "API Мутагена ответило перенаправлением. Переход не выполнялся: ключ API передается в адресе запроса и не должен уходить на другой адрес. Проверьте MUTAGEN_BASE_URL.",
      hintEn:
        "The Mutagen API answered with a redirect. It was not followed: the API key is part of the request URL and must not be sent elsewhere. Check MUTAGEN_BASE_URL.",
    });
  }

  #parse(method: string, status: number, text: string): unknown {
    let body: unknown;
    try {
      body = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
      if (status === 503) {
        throw new MutagenError({
          kind: "auth_or_server",
          status,
          retryable: false,
          message: `Mutagen API returned HTTP 503 with a non-JSON body for ${method}`,
          hintRu: KEY_OR_IP_HINT_RU,
          hintEn: KEY_OR_IP_HINT_EN,
        });
      }
      if (status >= 500) {
        throw new MutagenError({
          kind: "http",
          status,
          retryable: true,
          message: `Mutagen API returned HTTP ${status} with a non-JSON body for ${method}`,
          hintRu: "Сбой сервера Мутагена. Повторите позже.",
          hintEn: "Mutagen server failure. Retry later.",
        });
      }
      throw new MutagenError({
        kind: "invalid_response",
        status,
        retryable: false,
        message: `Mutagen API returned a non-JSON response (HTTP ${status}) for ${method}`,
        hintRu: `API вернуло не JSON. ${KEY_OR_IP_HINT_RU}`,
        hintEn: `The API returned non-JSON. ${KEY_OR_IP_HINT_EN}`,
      });
    }

    const apiErr = extractApiError(body);
    if (apiErr) {
      const detail = apiErr.detail === undefined ? undefined : this.redact(apiErr.detail);
      throw apiError(apiErr.code, this.redact(apiErr.message), detail);
    }

    if (status < 200 || status >= 300) {
      throw new MutagenError({
        kind: "http",
        status,
        retryable: status >= 500,
        message: `Mutagen API returned HTTP ${status} for ${method}`,
        hintRu:
          status >= 500
            ? "Сбой сервера Мутагена. Повторите позже."
            : "API Мутагена отклонило запрос.",
        hintEn:
          status >= 500
            ? "Mutagen server failure. Retry later."
            : "The Mutagen API rejected the request.",
      });
    }
    return body;
  }
}
