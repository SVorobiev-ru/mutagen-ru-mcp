import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
  localhostHostValidation,
  localhostOriginValidation,
  type NodeIncomingMessageLike,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  isInitializeRequest,
  isLegacyRequest,
  type McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import type { McpDeps } from "./context.js";
import { buildServer } from "./server.js";

export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 3333;
export const DEFAULT_HTTP_PATH = "/mcp";
const LOCAL_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];
const MAX_SESSIONS = 100;
const IDLE_MS = 30 * 60_000;

export interface HttpServerOptions {
  /** One for the whole process: every session and request shares its session budget. */
  deps: McpDeps;
  host?: string;
  port?: number;
  path?: string;
  token?: string | undefined;
  /** Browser origins allowed beyond localhost; without them requests with Origin are refused. */
  allowedOrigins?: readonly string[] | undefined;
  maxSessions?: number;
  idleMs?: number;
  onerror?: (error: Error) => void;
}

export interface RunningHttpServer {
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

interface LegacySession {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  lastActive: number;
}

export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.includes(host.toLowerCase());
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function authorized(req: IncomingMessage, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  return match?.[1] !== undefined && timingSafeEqual(digest(match[1].trim()), digest(token));
}

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "").toLowerCase();
}

function rpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });
}

export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const host = options.host ?? DEFAULT_HTTP_HOST;
  const path = options.path ?? DEFAULT_HTTP_PATH;
  const token = options.token?.trim() || undefined;
  const local = isLocalHost(host);
  if (!local && !token) {
    throw new Error(
      `MUTAGEN_MCP_HTTP_TOKEN is required to listen on ${host}: without it anyone on the network could spend the Mutagen balance. Задайте MUTAGEN_MCP_HTTP_TOKEN или слушайте 127.0.0.1.`,
    );
  }
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  const idleMs = options.idleMs ?? IDLE_MS;
  const onerror = options.onerror ?? (() => {});
  const deps: McpDeps = { ...options.deps, allowAnyOutputPath: false };
  const origins = (options.allowedOrigins ?? []).map(normalizeOrigin);

  const modern = createMcpHandler(() => buildServer(deps), { legacy: "reject", onerror });
  const sessions = new Map<string, LegacySession>();

  async function openSession(request: Request): Promise<Response> {
    if (sessions.size >= maxSessions) return rpcError(503, -32000, "Too many open sessions");
    const server = buildServer(deps);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, lastActive: Date.now() });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    await server.connect(transport);
    server.server.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    return transport.handleRequest(request);
  }

  async function route(request: Request): Promise<Response> {
    if (!(await isLegacyRequest(request))) return modern.fetch(request);
    const id = request.headers.get("mcp-session-id");
    if (id) {
      const session = sessions.get(id);
      if (!session) return rpcError(404, -32001, "Session not found");
      session.lastActive = Date.now();
      return session.transport.handleRequest(request);
    }
    if (request.method === "POST") {
      const body: unknown = await request
        .clone()
        .json()
        .catch(() => undefined);
      if (isInitializeRequest(body)) return openSession(request);
    }
    return rpcError(400, -32000, "Bad Request: Mcp-Session-Id header is required");
  }

  const nodeHandler = toNodeHandler({ fetch: route }, { onerror });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const httpServer = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== path) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    if (local && (!validateHost(req, res) || !validateOrigin(req, res))) return;
    const origin = req.headers.origin;
    if (!local && origin !== undefined && !origins.includes(normalizeOrigin(origin))) {
      res.writeHead(403, { "content-type": "text/plain" }).end("Origin not allowed");
      return;
    }
    if (token && !authorized(req, token)) {
      res
        .writeHead(401, { "content-type": "text/plain", "www-authenticate": "Bearer" })
        .end("Unauthorized");
      return;
    }
    void nodeHandler(req as NodeIncomingMessageLike, res);
  });

  const sweep = setInterval(
    () => {
      const cutoff = Date.now() - idleMs;
      for (const [id, session] of sessions) {
        if (session.lastActive >= cutoff) continue;
        sessions.delete(id);
        session.transport.close().catch(onerror);
      }
    },
    Math.min(idleMs, 60_000),
  );
  sweep.unref();

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? DEFAULT_HTTP_PORT, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const { port } = httpServer.address() as AddressInfo;
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

  return {
    url: `http://${urlHost}:${port}${path}`,
    host,
    port,
    async close() {
      clearInterval(sweep);
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(open.map((session) => session.transport.close()));
      await modern.close();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
    },
  };
}
