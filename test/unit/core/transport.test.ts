import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MutagenError } from "../../../src/core/errors.js";
import {
  DEFAULT_BASE_URL,
  extractApiError,
  type FetchLike,
  REDACTED,
  redactSecret,
  Transport,
  type TransportOptions,
} from "../../../src/core/transport.js";
import { API_KEY, hangingFetch, json, OUTAGE_HTML, stubFetch, text } from "./helpers.js";

function transport(fetch: FetchLike, extra: Omit<TransportOptions, "apiKey" | "fetch"> = {}) {
  return new Transport({ apiKey: API_KEY, fetch, ...extra });
}

async function failure(promise: Promise<unknown>): Promise<MutagenError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MutagenError);
    return error as MutagenError;
  }
  throw new Error("Expected the call to fail");
}

function expectNoKey(error: MutagenError) {
  const dumps = [
    error.message,
    String(error),
    error.stack ?? "",
    JSON.stringify(error),
    inspect(error, { depth: 10 }),
    inspect(error.cause, { depth: 10 }),
    String((error.cause as Error | undefined)?.stack ?? ""),
  ];
  for (const dump of dumps) expect(dump).not.toContain(API_KEY);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Transport requests", () => {
  it("builds the URL from the default base, key and method", async () => {
    const { fetch, calls } = stubFetch(json({ balance: 100 }));
    await transport(fetch).call("mutagen.balance");
    expect(calls[0]?.url).toBe(`${DEFAULT_BASE_URL}/${API_KEY}/mutagen.balance/`);
    expect(DEFAULT_BASE_URL).toBe("http://api.mutagen.ru/json");
  });

  it("uses GET without a body when there are no params", async () => {
    const { fetch, calls } = stubFetch(json({ balance: 100 }));
    await transport(fetch).call("mutagen.balance", {});
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.headers["content-type"]).toBeUndefined();
    expect(calls[0]?.headers["accept-encoding"]).toBe("gzip");
  });

  it("sends params as a JSON POST body", async () => {
    const { fetch, calls } = stubFetch(json({ task_id: "1", status: "created" }));
    await transport(fetch).call("mutagen.check_key.new", { key: "mp3", list: ["a", "b"] });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(calls[0]?.headers["accept-encoding"]).toBe("gzip");
    expect(calls[0]?.headers.accept).toBe("application/json");
    expect(calls[0]?.body).toEqual({ key: "mp3", list: ["a", "b"] });
  });

  it("accepts a custom base URL and strips trailing slashes", async () => {
    const { fetch, calls } = stubFetch(json({ balance: 1 }));
    const t = transport(fetch, { baseUrl: "https://mirror.mutagen.ru/json//" });
    await t.call("mutagen.balance");
    expect(calls[0]?.url).toBe(`https://mirror.mutagen.ru/json/${API_KEY}/mutagen.balance/`);
    expect(t.baseUrl).toBe("https://mirror.mutagen.ru/json");
  });

  it("URL-encodes the key in the path", async () => {
    const { fetch, calls } = stubFetch(json({ balance: 1 }));
    await new Transport({ apiKey: "a/b c", fetch }).call("mutagen.balance");
    expect(calls[0]?.url).toBe(`${DEFAULT_BASE_URL}/a%2Fb%20c/mutagen.balance/`);
  });

  it("falls back to the global fetch", async () => {
    const { fetch, calls } = stubFetch(json({ balance: 5 }));
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(new Transport({ apiKey: API_KEY }).call("mutagen.balance")).resolves.toEqual({
        balance: 5,
      });
      expect(calls).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects an empty key before any request", () => {
    expect(() => new Transport({ apiKey: "  " })).toThrow(MutagenError);
  });
});

describe("Transport response parsing", () => {
  it("parses JSON regardless of the Content-Type header", async () => {
    const { fetch } = stubFetch(text('{"balance":100.00}', 200, "text/html"));
    await expect(transport(fetch).call("mutagen.balance")).resolves.toEqual({ balance: 100 });
  });

  it("strips a UTF-8 BOM", async () => {
    const { fetch } = stubFetch(text('﻿{"balance":1}', 200, "application/json"));
    await expect(transport(fetch).call("mutagen.balance")).resolves.toEqual({ balance: 1 });
  });

  it("treats 503 with an HTML body as an auth or server problem", async () => {
    const { fetch } = stubFetch(text(OUTAGE_HTML, 503, "application/json"));
    const error = await failure(transport(fetch).call("mutagen.balance"));
    expect(error.kind).toBe("auth_or_server");
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(false);
    expect(error.hintRu).toContain("белый список IP");
    expect(error.hintEn).toContain("IP whitelist");
  });

  it("treats other 5xx non-JSON bodies as retryable HTTP errors", async () => {
    const { fetch } = stubFetch(text("Bad gateway", 502));
    const error = await failure(transport(fetch).call("mutagen.balance"));
    expect(error).toMatchObject({ kind: "http", status: 502, retryable: true });
  });

  it("treats a 200 HTML body as an invalid response", async () => {
    const { fetch } = stubFetch(text(OUTAGE_HTML, 200));
    const error = await failure(transport(fetch).call("mutagen.balance"));
    expect(error).toMatchObject({ kind: "invalid_response", status: 200, retryable: false });
    expect(error.hintRu).toContain("ключ");
  });

  it("treats an empty body as an invalid response", async () => {
    const { fetch } = stubFetch(text("", 200));
    const error = await failure(transport(fetch).call("mutagen.balance"));
    expect(error.kind).toBe("invalid_response");
  });

  it("reports a non-2xx JSON response without error fields as an HTTP error", async () => {
    const { fetch } = stubFetch(json({ ok: false }, 500), json({ ok: false }, 404));
    const t = transport(fetch);
    expect(await failure(t.call("mutagen.balance"))).toMatchObject({
      kind: "http",
      status: 500,
      retryable: true,
    });
    expect(await failure(t.call("mutagen.balance"))).toMatchObject({
      kind: "http",
      status: 404,
      retryable: false,
    });
  });

  it.each([
    [
      "error_id + error_msg",
      { error_id: 106, error_msg: "MUTAGEN.RU: Low balance" },
      106,
      "balance",
    ],
    [
      "string error_id",
      { error_id: "110", error_msg: "MUTAGEN.RU: need timeout" },
      110,
      "rate_limit",
    ],
    [
      "numeric error + error_msg",
      { error: 111, error_msg: "subscription required" },
      111,
      "subscription_required",
    ],
    ["numeric string error", { error: "109" }, 109, "ip_not_allowed"],
    ["error text only", { error: "MUTAGEN.RU: Key not valid" }, 105, "auth"],
    ["error_msg only", { error_msg: "MUTAGEN.RU: report in process" }, 114, "report_in_progress"],
    ["error text + error_code", { error: "something", error_code: 116 }, 116, "invalid_item"],
    ["error text + code", { error: "something", code: "117" }, 117, "no_data"],
    [
      "error object",
      { error: { code: 113, message: "another report in process" } },
      113,
      "report_busy",
    ],
    [
      "error object with id/msg",
      { error: { id: "107", msg: "task_id not found" } },
      107,
      "not_found",
    ],
    [
      "XML-RPC fault",
      { faultCode: 101, faultString: "MUTAGEN.RU: Authorization failed" },
      101,
      "auth",
    ],
    ["fault string only", { faultString: "MUTAGEN.RU: No action..." }, 104, "method"],
    [
      "error true + error_msg",
      { error: true, error_msg: "MUTAGEN.RU: Low balance" },
      106,
      "balance",
    ],
    [
      "options error with description",
      { error_id: 108, error_msg: "MUTAGEN.RU: options error", error: "keys_list is empty" },
      108,
      "validation",
    ],
  ])("recognizes a JSON error: %s", async (_name, body, code, kind) => {
    const { fetch } = stubFetch(json(body, 200));
    const error = await failure(transport(fetch).call("mutagen.parser.get", { key: "x" }));
    expect(error.code).toBe(code);
    expect(error.kind).toBe(kind);
    expect(error.message).toContain(String(code));
  });

  it("keeps error_detail of error 108 in the message, the hint and detail", async () => {
    const { fetch } = stubFetch(
      json({
        error_id: 108,
        error: "MUTAGEN.RU: options error",
        error_detail: "слишком короткий ключ, минимум 2 знака",
      }),
    );
    const error = await failure(transport(fetch).call("mutagen.parser.mass.new", { a: 1 }));
    expect(error).toMatchObject({ code: 108, detail: "слишком короткий ключ, минимум 2 знака" });
    expect(error.message).toContain("options error");
    expect(error.message).toContain("слишком короткий ключ");
    expect(error.hintRu).toContain("слишком короткий ключ");
  });

  it("takes the code from error_id even when the text has no MUTAGEN.RU prefix", async () => {
    const { fetch } = stubFetch(
      json({ error_id: 111, error: "Для работы по api требуется подписка на любой из тарифов" }),
    );
    const error = await failure(transport(fetch).call("mutagen.serp.report", { a: 1 }));
    expect(error).toMatchObject({ kind: "subscription_required", code: 111 });
    expect(error.message).toContain("требуется подписка");
  });

  it("reports an error without a recognizable code as kind api", async () => {
    const { fetch } = stubFetch(json({ error: "Something unexpected" }));
    const error = await failure(transport(fetch).call("mutagen.balance"));
    expect(error).toMatchObject({ kind: "api", code: undefined, retryable: false });
    expect(error.message).toContain("Something unexpected");
  });

  it("reports an unknown numeric code as kind api", async () => {
    const { fetch } = stubFetch(json({ error_id: 199, error_msg: "MUTAGEN.RU: new error" }));
    const error = await failure(transport(fetch).call("mutagen.balance"));
    expect(error).toMatchObject({ kind: "api", code: 199, retryable: false });
  });

  it("recognizes JSON errors even with an HTTP error status", async () => {
    const { fetch } = stubFetch(
      json({ error_id: 105, error_msg: "MUTAGEN.RU: Key not valid" }, 503),
    );
    const error = await failure(transport(fetch).call("mutagen.balance"));
    expect(error).toMatchObject({ kind: "auth", code: 105 });
  });

  it.each([
    ["status error is a task status", { status: "error" }],
    ["empty error", { error: "", data: 1 }],
    ["null error", { error: null }],
    ["zero error", { error: 0 }],
    ["zero string error", { error: "0", balance: 5 }],
    ["zero string error_id", { error_id: " 0 ", error: "0" }],
    ["false error", { error: false }],
    ["array", [{ error_msg: "row value" }]],
    ["primitive", 42],
  ])("does not treat %s as an API error", (_name, body) => {
    expect(extractApiError(body)).toBeUndefined();
  });
});

describe("Transport failures", () => {
  it("wraps network errors as retryable", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:80"), {
      code: "ECONNREFUSED",
    });
    const { fetch } = stubFetch(new TypeError("fetch failed", { cause }));
    const error = await failure(transport(fetch).call("mutagen.balance"));
    expect(error).toMatchObject({ kind: "network", retryable: true });
    expect(error.message).toContain("fetch failed");
    expect((error.cause as Error).message).toBe("fetch failed");
    expect(((error.cause as Error).cause as { code: string }).code).toBe("ECONNREFUSED");
  });

  it("wraps non-Error throws", async () => {
    const fetch = () => Promise.reject("boom");
    const error = await failure(transport(fetch).call("mutagen.balance"));
    expect(error.kind).toBe("network");
    expect(error.message).toContain("boom");
  });

  it("times out a hanging request", async () => {
    vi.useFakeTimers();
    const { fetch } = hangingFetch();
    const pending = failure(transport(fetch, { timeoutMs: 5_000 }).call("mutagen.balance"));
    await vi.advanceTimersByTimeAsync(5_000);
    const error = await pending;
    expect(error).toMatchObject({ kind: "timeout", retryable: true });
    expectNoKey(error);
  });

  it("allows a per-call timeout", async () => {
    vi.useFakeTimers();
    const { fetch } = hangingFetch();
    const pending = failure(
      transport(fetch).call("mutagen.balance", undefined, { timeoutMs: 100 }),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).kind).toBe("timeout");
  });

  it("aborts an in-flight request", async () => {
    const { fetch, calls } = hangingFetch();
    const controller = new AbortController();
    const pending = failure(
      transport(fetch).call("mutagen.balance", undefined, { signal: controller.signal }),
    );
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    controller.abort();
    const error = await pending;
    expect(error).toMatchObject({ kind: "aborted", retryable: false });
  });

  it("does not call fetch with an already aborted signal", async () => {
    const { fetch, calls } = stubFetch(json({ balance: 1 }));
    const controller = new AbortController();
    controller.abort();
    const error = await failure(
      transport(fetch).call("mutagen.balance", undefined, { signal: controller.signal }),
    );
    expect(error).toMatchObject({ kind: "aborted", beforeStart: true });
    expect(error.toJSON()).toMatchObject({ beforeStart: true });
    expect(calls).toHaveLength(0);
  });

  it("does not follow redirects", async () => {
    let init: RequestInit | undefined;
    const fetch: FetchLike = async (_url, given) => {
      init = given;
      return new Response(null, { status: 302, headers: { Location: "http://evil.test/" } });
    };
    const error = await failure(transport(fetch).call("mutagen.balance"));
    expect(init?.redirect).toBe("manual");
    expect(error).toMatchObject({ kind: "http", status: 302, retryable: false });
    expect(error.hintRu).toMatch(/перенаправлением/);
    expectNoKey(error);
    const opaque = { type: "opaqueredirect", status: 0 } as Response;
    const blocked = await failure(transport(async () => opaque).call("mutagen.balance"));
    expect(blocked).toMatchObject({ kind: "http", retryable: false });
  });

  it("validates the timeout", () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => transport(stubFetch(json({})).fetch, { timeoutMs })).toThrow(MutagenError);
    }
  });
});

describe("API key redaction", () => {
  it("redacts raw and URL-encoded secrets", () => {
    expect(redactSecret("a KEY b KEY", "KEY")).toBe(`a ${REDACTED} b ${REDACTED}`);
    expect(redactSecret("x/a%2Fb/y and a/b", "a/b")).toBe(`x/${REDACTED}/y and ${REDACTED}`);
    expect(redactSecret("text", "")).toBe("text");
  });

  it("removes the key from network errors that carry the URL", async () => {
    const url = `${DEFAULT_BASE_URL}/${API_KEY}/mutagen.balance/`;
    const inner = new Error(`getaddrinfo ENOTFOUND for ${url}`);
    const outer = new TypeError(`fetch failed: ${url}`, { cause: inner });
    const { fetch } = stubFetch(outer);
    const error = await failure(transport(fetch).call("mutagen.balance"));
    expect(error.message).toContain(REDACTED);
    expect(String((error.cause as Error).message)).toContain(REDACTED);
    expectNoKey(error);
  });

  it("removes the key from string causes", async () => {
    const fetch = () => Promise.reject(`failed ${API_KEY}`);
    const error = await failure(transport(fetch).call("mutagen.balance"));
    expectNoKey(error);
  });

  it("drops non-error causes and deep cause chains safely", async () => {
    let deep: Error = new Error(`level ${API_KEY}`);
    for (let i = 0; i < 10; i += 1) deep = new Error(`wrap ${API_KEY}`, { cause: deep });
    const { fetch } = stubFetch(deep);
    expectNoKey(await failure(transport(fetch).call("mutagen.balance")));

    const objectCause = new Error("outer", { cause: { url: API_KEY } });
    const second = stubFetch(objectCause);
    const error = await failure(transport(second.fetch).call("mutagen.balance"));
    expect((error.cause as Error).cause).toBeUndefined();
    expectNoKey(error);
  });

  it("removes the key from aborted fetch errors and timeouts", async () => {
    const { fetch } = hangingFetch();
    const controller = new AbortController();
    const pending = failure(
      transport(fetch).call("mutagen.balance", undefined, { signal: controller.signal }),
    );
    controller.abort();
    expectNoKey(await pending);
  });

  it("removes the key from API error messages", async () => {
    const { fetch } = stubFetch(json({ error: `MUTAGEN.RU: Key not valid ${API_KEY}` }));
    const error = await failure(transport(fetch).call("mutagen.balance"));
    expect(error.message).toContain(REDACTED);
    expectNoKey(error);
  });

  it.each([
    ["HTML 503", text(OUTAGE_HTML, 503)],
    ["HTML 200", text(`<a href="/json/${API_KEY}/">x</a>`, 200)],
    ["HTTP 500", json({}, 500)],
  ])("does not leak the key in %s errors", async (_name, response) => {
    const { fetch } = stubFetch(response);
    expectNoKey(await failure(transport(fetch).call("mutagen.balance")));
  });

  it("hides the key when serializing or inspecting the transport", () => {
    const t = new Transport({ apiKey: API_KEY });
    expect(JSON.stringify(t)).not.toContain(API_KEY);
    expect(String(t)).not.toContain(API_KEY);
    expect(inspect(t, { depth: 10, showHidden: true })).not.toContain(API_KEY);
    expect(t.toJSON().apiKey).toBe(REDACTED);
  });
});
