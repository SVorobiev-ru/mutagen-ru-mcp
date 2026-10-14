import { readFileSync } from "node:fs";
import { readlink, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { MutagenConfig } from "../config.js";
import { validationError } from "../core/errors.js";
import { MutagenSession, type SessionFromConfigOptions } from "../session.js";
import { missingKeyError } from "./links.js";

export const TOOL_GROUPS = ["basic", "parser", "serp", "scenarios", "text"] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

export const DEFAULT_OUTPUT_DIR_NAME = "mutagen-results";
export const DEFAULT_MCP_WAIT_SECONDS = 45;
export const SAVE_EXTENSIONS = [".csv", ".json", ".ndjson", ".xlsx"];

export interface McpDeps {
  config: MutagenConfig;
  /** `local`: the call never reaches the API, so it runs without MUTAGEN_API_KEY too. */
  session: (local?: boolean) => MutagenSession;
  outputDir: string;
  groups?: ReadonlySet<ToolGroup>;
  /** stdio with MUTAGEN_ALLOW_ANY_OUTPUT_PATH=1: save_as may point anywhere. */
  allowAnyOutputPath?: boolean;
  /** How long one tool call waits for Mutagen tasks before answering "processing". */
  waitMs?: number;
}

export const VERSION: string = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

export function sessionProvider(
  config: MutagenConfig,
  options: SessionFromConfigOptions = {},
): (local?: boolean) => MutagenSession {
  let session: MutagenSession | undefined;
  let offline: MutagenSession | undefined;
  return (local = false) => {
    if (!config.apiKey) {
      if (!local) throw missingKeyError();
      offline ??= MutagenSession.offline(config, options);
      return offline;
    }
    session ??= MutagenSession.fromConfig(config, options);
    return session;
  };
}

export function parseToolGroups(value: string | undefined): {
  groups: Set<ToolGroup>;
  unknown: string[];
} {
  const names = (value ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");
  if (names.length === 0) return { groups: new Set(TOOL_GROUPS), unknown: [] };
  const groups = new Set<ToolGroup>();
  const unknown: string[] = [];
  for (const name of names) {
    if ((TOOL_GROUPS as readonly string[]).includes(name)) groups.add(name as ToolGroup);
    else unknown.push(name);
  }
  return { groups, unknown };
}

export function outputDirFrom(env: Readonly<Record<string, string | undefined>>): string {
  const dir = env.MUTAGEN_OUTPUT_DIR?.trim();
  return resolve(dir || resolve(process.cwd(), DEFAULT_OUTPUT_DIR_NAME));
}

export function waitSecondsFrom(env: Readonly<Record<string, string | undefined>>): number {
  const value = env.MUTAGEN_MCP_WAIT_SECONDS?.trim();
  if (!value) return DEFAULT_MCP_WAIT_SECONDS;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw validationError(
      `Invalid MUTAGEN_MCP_WAIT_SECONDS: ${value}`,
      "MUTAGEN_MCP_WAIT_SECONDS: укажите число секунд больше 0.",
      "MUTAGEN_MCP_WAIT_SECONDS: expected a number of seconds above 0.",
    );
  }
  return seconds;
}

/** The moment a tool call stops waiting for Mutagen tasks. */
export function waitUntil(deps: McpDeps): number {
  return Date.now() + (deps.waitMs ?? DEFAULT_MCP_WAIT_SECONDS * 1000);
}

export interface SaveTarget {
  path: string;
  /** Replace an existing file; otherwise the result goes to "name (2).csv" and so on. */
  overwrite: boolean;
}

function within(dir: string, path: string): boolean {
  const inside = relative(dir, path);
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}

/** The real path of `path`: symlinks resolved, even dangling ones; a missing tail is kept. */
async function realPathOf(path: string, depth = 0): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const link = depth < 40 ? await readlink(path).catch(() => undefined) : undefined;
    if (link !== undefined) return realPathOf(resolve(dirname(path), link), depth + 1);
    const parent = dirname(path);
    return parent === path ? path : join(await realPathOf(parent, depth + 1), basename(path));
  }
}

function outsideError(deps: McpDeps, saveAs: string) {
  return validationError(
    `save_as is outside the output directory: ${saveAs}`,
    `save_as: путь должен быть внутри каталога вывода ${deps.outputDir} (MUTAGEN_OUTPUT_DIR), без «..» и ссылок наружу.`,
    `save_as: the path must be inside the output directory ${deps.outputDir} (MUTAGEN_OUTPUT_DIR), with no ".." or symlinks leading out.`,
  );
}

export async function resolveSaveAs(
  deps: McpDeps,
  args: { save_as?: string | undefined; overwrite?: boolean | undefined },
): Promise<SaveTarget | undefined> {
  const saveAs = args.save_as;
  if (saveAs === undefined) return undefined;
  const path = resolve(deps.outputDir, saveAs.trim());
  if (!SAVE_EXTENSIONS.includes(extname(path).toLowerCase())) {
    throw validationError(
      `Unsupported save_as extension: ${saveAs}`,
      "save_as: укажите файл с расширением .csv, .json, .ndjson или .xlsx.",
      "save_as: use a file name ending in .csv, .json, .ndjson or .xlsx.",
    );
  }
  if (!deps.allowAnyOutputPath) {
    if (path === deps.outputDir || !within(deps.outputDir, path)) throw outsideError(deps, saveAs);
    const root = await realPathOf(deps.outputDir);
    if (!within(root, await realPathOf(path))) throw outsideError(deps, saveAs);
  }
  return { path, overwrite: args.overwrite === true };
}
