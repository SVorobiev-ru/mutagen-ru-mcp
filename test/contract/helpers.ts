import { readdirSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { MutagenClient } from "../../src/core/client.js";
import type { FetchLike } from "../../src/core/transport.js";

export const API_KEY = "contract-test-key";
export const FAST = { concurrency: 10, perSecond: 1000 };

/** A recorded live answer: request method and params, raw HTTP status, content type and body. */
export interface Fixture {
  method: string;
  params: Record<string, unknown> | null;
  status: number;
  contentType: string;
  body: string;
}

const DIR = new URL("../fixtures/live/", import.meta.url);

export const FIXTURE_NAMES: readonly string[] = readdirSync(DIR)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.slice(0, -".json".length))
  .sort();

export function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`${name}.json`, DIR), "utf8")) as Fixture;
}

function without(value: unknown, keys: readonly string[]): unknown {
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function methodOf(url: string): string {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * Answers the requests with the fixtures in order (the last one repeats) and checks that every
 * request asks for the recorded method with the recorded params, except the `ignore` ones.
 */
export function fixtureFetch(names: readonly string[], ignore: readonly string[] = []) {
  const queue = names.map(fixture);
  const requests: { method: string; body: unknown }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const item = queue.length > 1 ? queue.shift() : queue[0];
    if (!item) throw new Error("No fixture left");
    const method = methodOf(url);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, body });
    if (method !== item.method) {
      throw new Error(`Contract mismatch: asked ${method}, fixture is ${item.method}`);
    }
    const params = without(item.params ?? {}, ignore) as Record<string, unknown>;
    if (Object.keys(params).length > 0 && !isDeepStrictEqual(without(body, ignore), params)) {
      throw new Error(
        `Contract mismatch for ${method}: sent ${JSON.stringify(body)}, recorded ${JSON.stringify(params)}`,
      );
    }
    return new Response(item.body, {
      status: item.status,
      headers: { "Content-Type": item.contentType },
    });
  };
  return { fetch, requests };
}

export function fixtureClient(...names: string[]) {
  const stub = fixtureFetch(names);
  return {
    client: new MutagenClient({ apiKey: API_KEY, fetch: stub.fetch, rateLimit: FAST }),
    ...stub,
  };
}
