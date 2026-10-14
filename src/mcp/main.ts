import { type Env, loadConfig, type MutagenConfig } from "../config.js";
import { MutagenError } from "../core/errors.js";
import {
  type McpDeps,
  outputDirFrom,
  parseToolGroups,
  sessionProvider,
  VERSION,
  waitSecondsFrom,
} from "./context.js";
import { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, startHttpServer } from "./http.js";
import { MISSING_KEY_EN } from "./links.js";
import { serveMcpStdio } from "./stdio.js";

export interface MainIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface MainResult {
  exitCode?: number;
  close?: () => Promise<void>;
}

const defaultIo: MainIo = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

export const USAGE = `mutagen-ru-mcp ${VERSION} — MCP server for the Mutagen (mutagen.ru) SEO API

Usage:
  mutagen-ru-mcp                      serve MCP over stdio
  mutagen-ru-mcp --http [--port N] [--host H]
                                      serve Streamable HTTP at http://H:N/mcp
                                      (default ${DEFAULT_HTTP_HOST}:${DEFAULT_HTTP_PORT})
  mutagen-ru-mcp --version | --help

Environment:
  MUTAGEN_API_KEY          API key (https://mutagen.ru/?api_config)
  MUTAGEN_BUDGET_RUB       budget of the server process (all sessions), default 50
  MUTAGEN_AUTO_APPROVE_RUB calls up to this sum run without confirmation, default 1
  MUTAGEN_FREE_ONLY=1      refuse every paid call
  MUTAGEN_TOOLS            tool groups: basic,parser,serp,scenarios,text (default all)
  MUTAGEN_OUTPUT_DIR       where results are saved, default ./mutagen-results;
                           save_as stays inside it
  MUTAGEN_ALLOW_ANY_OUTPUT_PATH=1
                           stdio only: save_as may be any absolute path
  MUTAGEN_MCP_WAIT_SECONDS how long a call waits for Mutagen tasks, default 45;
                           then it answers "processing" and a repeat is free
  MUTAGEN_MCP_HTTP_TOKEN   bearer token, required for --host other than localhost
  MUTAGEN_MCP_ALLOWED_ORIGINS
                           comma-separated browser origins allowed beyond
                           localhost; otherwise requests with Origin are refused`;

interface Args {
  http: boolean;
  port?: number;
  host?: string;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { http: false, help: false, version: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--http") args.http = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--version" || arg === "-v") args.version = true;
    else if (arg === "--host") args.host = value();
    else if (arg === "--port") {
      const port = Number(value());
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error("--port must be an integer from 0 to 65535");
      }
      args.port = port;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return args;
}

function listFrom(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function describe(error: unknown): string {
  if (error instanceof MutagenError) return `${error.hintEn}\n${error.hintRu}`;
  return error instanceof Error ? error.message : String(error);
}

export async function main(
  argv: readonly string[],
  env: Env = process.env,
  io: MainIo = defaultIo,
): Promise<MainResult> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.err(`${describe(error)}\n\n${USAGE}`);
    return { exitCode: 2 };
  }
  if (args.help) {
    io.out(USAGE);
    return { exitCode: 0 };
  }
  if (args.version) {
    io.out(VERSION);
    return { exitCode: 0 };
  }
  let config: MutagenConfig;
  let waitSeconds: number;
  try {
    config = loadConfig(env);
    waitSeconds = waitSecondsFrom(env);
  } catch (error) {
    io.err(describe(error));
    return { exitCode: 1 };
  }
  const { groups, unknown } = parseToolGroups(env.MUTAGEN_TOOLS);
  if (unknown.length > 0) {
    io.err(`MUTAGEN_TOOLS: unknown groups ignored: ${unknown.join(", ")}`);
  }
  const outputDir = outputDirFrom(env);
  const deps: McpDeps = {
    config,
    session: sessionProvider(config),
    outputDir,
    groups,
    waitMs: waitSeconds * 1000,
  };
  if (!config.apiKey) io.err(`mutagen-ru-mcp: ${MISSING_KEY_EN}`);
  const onerror = (error: Error) => io.err(`mutagen-ru-mcp: ${describe(error)}`);

  if (args.http) {
    try {
      const server = await startHttpServer({
        deps,
        token: env.MUTAGEN_MCP_HTTP_TOKEN,
        allowedOrigins: listFrom(env.MUTAGEN_MCP_ALLOWED_ORIGINS),
        onerror,
        ...(args.host === undefined ? {} : { host: args.host }),
        ...(args.port === undefined ? {} : { port: args.port }),
      });
      io.err(`mutagen-ru-mcp ${VERSION}: listening on ${server.url}`);
      return { close: () => server.close() };
    } catch (error) {
      io.err(describe(error));
      return { exitCode: 1 };
    }
  }
  const allowAnyOutputPath = env.MUTAGEN_ALLOW_ANY_OUTPUT_PATH?.trim() === "1";
  const handle = serveMcpStdio({ ...deps, allowAnyOutputPath }, { onerror });
  io.err(`mutagen-ru-mcp ${VERSION}: serving MCP on stdio`);
  return { close: () => handle.close() };
}
