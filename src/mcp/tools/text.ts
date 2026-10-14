import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { TEXT_OPERATIONS, textOperation } from "../../scenarios/text.js";
import { type McpDeps, resolveSaveAs } from "../context.js";
import { outputSchema, toolResult } from "../respond.js";
import { FREE_LOCAL, handler, phraseInputs, phraseItemsParam, tableParams } from "./common.js";

const words = z.array(z.string()).optional();

export function registerTextTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "mutagen_text",
    {
      title: "Phrase tools",
      description:
        "Local phrase processing: compare uses phrases_b, combinator lists. Free, local.\nЛокальная обработка фраз. Бесплатно.",
      inputSchema: z.object({
        operation: z.enum(TEXT_OPERATIONS),
        phrases: phraseItemsParam.optional(),
        phrases_b: z.array(z.string()).optional(),
        lists: z
          .array(z.array(z.string()))
          .optional()
          .describe('combinator: word lists, "" = optional'),
        mode: z.enum(["explicit", "implicit"]).optional(),
        implicit: z.boolean().optional(),
        include: words.describe("filter: keep if all words of any entry"),
        exclude: words.describe("filter: drop if all words of any entry"),
        regex: z.string().optional(),
        min_words: z.number().int().min(0).max(100).optional(),
        max_words: z.number().int().min(0).max(100).optional(),
        ...tableParams,
      }),
      outputSchema,
      annotations: FREE_LOCAL,
    },
    handler(deps, server, "mutagen_text", async (args, { tool }) => {
      const saveAs = await resolveSaveAs(deps, args);
      const { table, summary } = textOperation({
        operation: args.operation,
        phrases: phraseInputs(args.phrases),
        phrasesB: args.phrases_b,
        lists: args.lists,
        mode: args.mode,
        implicit: args.implicit,
        include: args.include,
        exclude: args.exclude,
        regex: args.regex,
        minWords: args.min_words,
        maxWords: args.max_words,
      });
      return toolResult(
        deps,
        tool,
        { table, summary, lines: [`${args.operation}: ${JSON.stringify(summary)}`] },
        args,
        saveAs,
      );
    }),
  );
}
