import type {
  CallToolResult,
  InputRequiredResult,
  McpServer,
  ServerContext,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { SERP_REGION_IDS, WORDSTAT_REGIONS } from "../../core/regions.js";
import { FREQUENCY_PARSERS } from "../../core/types.js";
import { MAX_MASS_KEYS } from "../../core/validate.js";
import type { PhraseInput } from "../../text/phrases.js";
import type { McpDeps } from "../context.js";
import { errorResult, redactResult } from "../errors.js";
import type { ToolEnv } from "../paid.js";
import { MAX_LIMIT } from "../respond.js";

export const FREE_READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const FREE_LOCAL: ToolAnnotations = { ...FREE_READ, openWorldHint: false };

export const PAID: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

export const tableParams = {
  save_as: z.string().optional().describe(".csv/.json/.xlsx"),
  overwrite: z.boolean().optional(),
  fields: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
};

export const paidParams = {
  dry_run: z.boolean().optional().describe("Estimate only"),
  confirm_token: z.string().optional().describe("Only after user approval"),
  force_refresh: z.boolean().optional().describe("Skip cache"),
  ...tableParams,
};

export const newTaskParam = {
  new_task: z.boolean().optional().describe("New paid task instead of a stuck one"),
};

export const phrasesParam = z.array(z.string().trim().min(1)).min(1).max(MAX_MASS_KEYS);

export const phraseItemsParam = z.array(
  z.union([z.string(), z.object({ phrase: z.string(), frequency: z.number().optional() })]),
);

export function phraseInputs(
  list: readonly (string | { phrase: string; frequency?: number | undefined })[],
): PhraseInput[];
export function phraseInputs(
  list: readonly (string | { phrase: string; frequency?: number | undefined })[] | undefined,
): PhraseInput[] | undefined;
export function phraseInputs(
  list: readonly (string | { phrase: string; frequency?: number | undefined })[] | undefined,
): PhraseInput[] | undefined {
  return list?.map((item) =>
    typeof item === "string" || item.frequency !== undefined
      ? (item as PhraseInput)
      : { phrase: item.phrase },
  );
}

export const frequencyTypes = z.enum(FREQUENCY_PARSERS);

export const wordstatRegion = z
  .string()
  .regex(/^-?\d+(,-?\d+)*$/)
  .optional()
  .describe(
    `Region ids, comma-separated, -id excludes: ${WORDSTAT_REGIONS.map((region) => `${region.id} ${region.nameEn}`).join(", ")}`,
  );

export const serpRegion = z
  .enum(SERP_REGION_IDS as [string, ...string[]])
  .default("yandex_msk")
  .describe("yandex_ru: keyword reports only");

export type ToolHandler<A> = (
  args: A,
  env: ToolEnv,
) => Promise<CallToolResult | InputRequiredResult>;

export function handler<A>(deps: McpDeps, server: McpServer, tool: string, run: ToolHandler<A>) {
  return async (args: A, ctx: ServerContext): Promise<CallToolResult | InputRequiredResult> => {
    let result: CallToolResult | InputRequiredResult;
    try {
      result = await run(args, { deps, server, ctx, tool });
    } catch (error) {
      result = errorResult(error);
    }
    return redactResult(result, deps.config.apiKey);
  };
}
