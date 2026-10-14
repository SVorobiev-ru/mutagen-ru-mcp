import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../../../src/config.js";
import type { FetchLike } from "../../../src/core/transport.js";
import { type McpDeps, sessionProvider, type ToolGroup } from "../../../src/mcp/context.js";
import { buildServer } from "../../../src/mcp/server.js";
import type { FrequencyStrategy } from "../../../src/session.js";
import { API_KEY, methodOf, type RecordedCall } from "../core/helpers.js";

export { API_KEY, json } from "../core/helpers.js";

export const FAST = { concurrency: 10, perSecond: 1000 };

export type Handler = (call: RecordedCall) => Response | Error | Promise<Response>;

export function router(handlers: Record<string, Handler | Handler[]>) {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: RecordedCall = {
      url,
      method: init.method ?? "GET",
      headers: {},
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    const method = methodOf(url).replace(/^mutagen\./, "");
    const entry = handlers[method];
    const handler = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
    if (!handler) throw new Error(`Unexpected call ${method}`);
    const reply = await handler(call);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const count = (method: string) =>
    calls.filter((call) => methodOf(call.url) === `mutagen.${method}`).length;
  return { fetch, calls, count };
}

const dirs: string[] = [];

export async function cleanup(): Promise<void> {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export interface SetupOptions {
  env?: Record<string, string>;
  key?: boolean;
  groups?: ToolGroup[];
  allowAnyOutputPath?: boolean;
  /** Most tests run on mass jobs; default "mass". */
  strategy?: FrequencyStrategy;
  waitMs?: number;
}

export async function makeDeps(
  handlers: Record<string, Handler | Handler[]>,
  options: SetupOptions = {},
) {
  const root = await mkdtemp(join(tmpdir(), "mutagen-mcp-"));
  dirs.push(root);
  const stub = router(handlers);
  const config = loadConfig({
    ...(options.key === false ? {} : { MUTAGEN_API_KEY: API_KEY }),
    MUTAGEN_CACHE_DIR: join(root, "cache"),
    MUTAGEN_STATE_DIR: join(root, "state"),
    ...options.env,
  });
  const outputDir = join(root, "out");
  const deps = (): McpDeps => ({
    config,
    session: sessionProvider(config, {
      fetch: stub.fetch,
      rateLimit: FAST,
      frequencyStrategy: options.strategy ?? "mass",
    }),
    outputDir,
    ...(options.groups ? { groups: new Set(options.groups) } : {}),
    ...(options.allowAnyOutputPath ? { allowAnyOutputPath: true } : {}),
    ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
  });
  return { ...stub, deps, root, outputDir };
}

export type ElicitAnswer =
  | { action: "accept"; content: { confirm: boolean } }
  | { action: "decline" | "cancel" };

export async function setup(
  handlers: Record<string, Handler | Handler[]>,
  options: SetupOptions & { elicit?: (message: string) => ElicitAnswer } = {},
) {
  const made = await makeDeps(handlers, options);
  const server = buildServer(made.deps());
  const client = new Client(
    { name: "test", version: "1.0.0" },
    options.elicit ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  const prompts: string[] = [];
  if (options.elicit) {
    const answer = options.elicit;
    client.setRequestHandler("elicitation/create", async (request) => {
      prompts.push(request.params.message);
      return answer(request.params.message);
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const responses: unknown[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    responses.push(result);
    return result as {
      content: { type: string; text: string }[];
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
  };
  return { ...made, server, client, call, responses, prompts };
}

export function textOf(result: { content: { text: string }[] }): string {
  return result.content.map((item) => item.text).join("\n");
}
