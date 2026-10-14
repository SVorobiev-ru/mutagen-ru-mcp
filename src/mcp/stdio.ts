import type { Transport } from "@modelcontextprotocol/server";
import { type StdioServerHandle, serveStdio } from "@modelcontextprotocol/server/stdio";
import type { McpDeps } from "./context.js";
import { buildServer } from "./server.js";

export interface StdioOptions {
  transport?: Transport;
  onerror?: (error: Error) => void;
}

export function serveMcpStdio(deps: McpDeps, options: StdioOptions = {}): StdioServerHandle {
  return serveStdio(() => buildServer(deps), {
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.onerror ? { onerror: options.onerror } : {}),
  });
}
