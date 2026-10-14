import { McpServer } from "@modelcontextprotocol/server";
import { type McpDeps, TOOL_GROUPS, VERSION } from "./context.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { registerBasicTools } from "./tools/basic.js";
import { registerParserTools } from "./tools/parser.js";
import { registerScenarioTools } from "./tools/scenarios.js";
import { registerSerpTools } from "./tools/serp.js";
import { registerTextTools } from "./tools/text.js";

export const SERVER_NAME = "mutagen-ru-mcp";

export function buildServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    {
      instructions:
        'Unofficial Mutagen (mutagen.ru) SEO API. Paid tools show their price in the description; run dry_run or mutagen_estimate first. Status "processing": Mutagen is still computing (competition and Direct bids may take 30+ min); repeat the same call later, the repeat is free. Неофициальный клиент API Мутагена: перед платными вызовами смотрите смету; при статусе processing повторите тот же вызов позже, повтор бесплатный.',
    },
  );
  const groups = deps.groups ?? new Set(TOOL_GROUPS);
  if (groups.has("basic")) registerBasicTools(server, deps);
  if (groups.has("parser")) registerParserTools(server, deps);
  if (groups.has("serp")) registerSerpTools(server, deps);
  if (groups.has("scenarios")) registerScenarioTools(server, deps);
  if (groups.has("text")) registerTextTools(server, deps);
  registerResources(server, deps);
  registerPrompts(server);
  return server;
}

export * from "./context.js";
