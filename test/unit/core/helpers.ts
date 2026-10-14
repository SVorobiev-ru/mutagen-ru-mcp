import type { FetchLike } from "../../../src/core/transport.js";

export const API_KEY = "s3cr3t-KEY_0123456789abcdef";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

export type Reply = Response | Error | ((call: RecordedCall) => Response | Promise<Response>);

export function json(body: unknown, status = 200, contentType = "application/json"): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": contentType } });
}

export function text(body: string, status = 200, contentType = "text/html"): Response {
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

export const OUTAGE_HTML =
  "<!DOCTYPE html><html><head><title>Мутаген</title></head><body>У нас что-то сломалось</body></html>";

export function stubFetch(...replies: Reply[]) {
  const calls: RecordedCall[] = [];
  const queue = [...replies];
  const fetch: FetchLike = async (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const call: RecordedCall = {
      url,
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    if (reply === undefined) throw new Error("No stubbed reply left");
    if (reply instanceof Error) throw reply;
    if (typeof reply === "function") return reply(call);
    return reply.clone();
  };
  return { fetch, calls };
}

export function hangingFetch() {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = (url, init) =>
    new Promise<Response>((_resolve, reject) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        headers: {},
        body: undefined,
        signal: init.signal ?? undefined,
      });
      init.signal?.addEventListener("abort", () => {
        const error = new Error(`This operation was aborted: ${url}`);
        error.name = "AbortError";
        reject(error);
      });
    });
  return { fetch, calls };
}

export function methodOf(url: string): string {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}
