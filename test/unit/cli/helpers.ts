import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { run } from "../../../src/cli/program.js";
import { API_KEY, json } from "../core/helpers.js";
import { type Handler, router } from "../mcp/helpers.js";

export { API_KEY, json } from "../core/helpers.js";

const dirs: string[] = [];

export async function cleanup(): Promise<void> {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mutagen-cli-"));
  dirs.push(root);
  return root;
}

export interface CliOptions {
  env?: Record<string, string>;
  key?: boolean;
  stdin?: string;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  root?: string;
  signal?: AbortSignal;
}

export async function cli(
  argv: string[],
  handlers: Record<string, Handler | Handler[]> = {},
  options: CliOptions = {},
) {
  const root = options.root ?? (await tempDir());
  const stub = router(handlers);
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    stdin: Readable.from(options.stdin === undefined ? [] : [options.stdin]),
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    env: {
      ...(options.key === false ? {} : { MUTAGEN_API_KEY: API_KEY }),
      MUTAGEN_CACHE_DIR: join(root, "cache"),
      MUTAGEN_STATE_DIR: join(root, "state"),
      MUTAGEN_RPS: "1000",
      MUTAGEN_CONCURRENCY: "10",
      ...options.env,
    },
    stdinIsTTY: options.stdinIsTTY ?? false,
    stdoutIsTTY: options.stdoutIsTTY ?? false,
    cwd: root,
    fetch: stub.fetch,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { code, stdout, stderr, root, ...stub };
}

/** Frequencies by phrase order: parser.get for up to 10 phrases per type, mass jobs above. */
export function massApi(frequency = (index: number) => (index + 1) * 10): Record<string, Handler> {
  let keys: string[] = [];
  const seen: string[] = [];
  let id = 500;
  return {
    "parser.get": (call) => {
      const { key } = call.body as { key: string };
      if (!seen.includes(key)) seen.push(key);
      return json({ status: "finish", data: { frequency: frequency(seen.indexOf(key)) } });
    },
    "parser.mass.new": (call) => {
      keys = (call.body as { keys_list: string[] }).keys_list;
      id += 1;
      return json({ id, status: "process" });
    },
    "parser.mass.id": () =>
      json({
        status: "finish",
        count: keys.length,
        data: keys.map((key, index) => ({ key, frequency: frequency(index) })),
      }),
  };
}
