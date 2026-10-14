import { request } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { isLocalHost, type RunningHttpServer, startHttpServer } from "../../../src/mcp/http.js";
import { cleanup, json, makeDeps } from "./helpers.js";

const running: RunningHttpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(running.splice(0).map((server) => server.close()));
  await cleanup();
});

async function start(token?: string, options: { host?: string; allowedOrigins?: string[] } = {}) {
  const made = await makeDeps({
    balance: () => json({ balance: "10" }),
    "parser.mass.new": () => json({ id: 1, status: "process" }),
    "parser.mass.id": () => json({ status: "finish", data: { окна: 5 } }),
  });
  const server = await startHttpServer({
    deps: made.deps(),
    port: 0,
    ...(token ? { token } : {}),
    ...options,
  });
  running.push(server);
  return { server, made };
}

async function connect(
  url: string,
  options: { modern?: boolean; token?: string; elicit?: boolean } = {},
) {
  const client = new Client(
    { name: "http-test", version: "1.0.0" },
    {
      ...(options.modern ? { versionNegotiation: { mode: "auto" as const } } : {}),
      ...(options.elicit ? { capabilities: { elicitation: { form: {} } } } : {}),
    },
  );
  if (options.elicit) {
    client.setRequestHandler("elicitation/create", async () => ({
      action: "accept",
      content: { confirm: true },
    }));
  }
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    ...(options.token
      ? { requestInit: { headers: { Authorization: `Bearer ${options.token}` } } }
      : {}),
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

function statusWithHost(url: string, host: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end("{}");
  });
}

describe("Streamable HTTP server", () => {
  it("serves legacy sessions and modern requests on 127.0.0.1", async () => {
    const { server } = await start();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const legacy = await connect(server.url);
    expect(legacy.getProtocolEra()).toBe("legacy");
    expect((await legacy.listTools()).tools).toHaveLength(22);
    const balance = await legacy.callTool({ name: "mutagen_balance", arguments: {} });
    expect(balance.structuredContent).toMatchObject({ rows: [{ balance: 10 }] });

    const modern = await connect(server.url, { modern: true });
    expect(modern.getProtocolEra()).toBe("modern");
    expect((await modern.listTools()).tools).toHaveLength(22);
    const again = await modern.callTool({ name: "mutagen_balance", arguments: {} });
    expect(again.structuredContent).toMatchObject({ rows: [{ balance: 10 }] });
  });

  it("shares one budget between all sessions of both eras; closing a session keeps it", async () => {
    const { server, made } = await start(undefined);
    const first = await connect(server.url);
    const transport = new StreamableHTTPClientTransport(new URL(server.url));
    const second = new Client({ name: "second", version: "1.0.0" });
    await second.connect(transport);
    clients.push(second);
    const modern = await connect(server.url, { modern: true });
    const spent = async (client: Client) =>
      (
        (await client.callTool({ name: "mutagen_spending", arguments: {} })).content as {
          text: string;
        }[]
      )[0]?.text;
    await first.callTool({ name: "mutagen_frequency", arguments: { phrases: ["окна"] } });
    expect(await spent(second)).toContain("потрачено 0.02 ₽");
    await modern.callTool({ name: "mutagen_frequency", arguments: { phrases: ["двери"] } });
    expect(await spent(first)).toContain("потрачено 0.04 ₽");
    await transport.terminateSession();
    const third = await connect(server.url);
    expect(await spent(third)).toContain("потрачено 0.04 ₽");
    expect(made.count("parser.mass.new")).toBe(2);
  });

  it("asks for confirmation through elicitation over HTTP in both eras", async () => {
    const { server } = await start();
    for (const modern of [false, true]) {
      const client = await connect(server.url, { modern, elicit: true });
      const result = await client.callTool({
        name: "mutagen_direct_bids",
        arguments: { phrases: ["окна"] },
      });
      expect(result.structuredContent).toMatchObject({ status: "ok" });
    }
  });

  it("rejects foreign hosts, wrong paths and unknown sessions", async () => {
    const { server } = await start();
    const base = server.url.replace("/mcp", "");
    expect((await fetch(`${base}/other`)).status).toBe(404);
    expect(await statusWithHost(server.url, "evil.example")).toBe(403);
    const origin = await fetch(server.url, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(origin.status).toBe(403);
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const unknown = await fetch(server.url, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": "nope" },
      body: ping,
    });
    expect(unknown.status).toBe(404);
    const missing = await fetch(server.url, { method: "POST", headers, body: ping });
    expect(missing.status).toBe(400);
  });

  it("requires the bearer token when it is set", async () => {
    const { server } = await start("s3cret-token");
    const denied = await fetch(server.url, { method: "POST", body: "{}" });
    expect(denied.status).toBe(401);
    await expect(connect(server.url)).rejects.toThrow();
    const client = await connect(server.url, { token: "s3cret-token" });
    expect((await client.listTools()).tools).toHaveLength(22);
  });

  it("beyond localhost refuses browser origins unless they are allowed", async () => {
    const post = (url: string, headers: Record<string, string>) =>
      fetch(url.replace("0.0.0.0", "127.0.0.1"), {
        method: "POST",
        headers: { authorization: "Bearer s3cret-token", ...headers },
        body: "{}",
      });
    const closed = await start("s3cret-token", { host: "0.0.0.0" });
    expect((await post(closed.server.url, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(closed.server.url, {})).status).not.toBe(403);
    const open = await start("s3cret-token", {
      host: "0.0.0.0",
      allowedOrigins: ["https://app.example/"],
    });
    expect((await post(open.server.url, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(open.server.url, { origin: "https://APP.example" })).status).not.toBe(403);
    expect(
      (await post(open.server.url, { origin: "https://app.example", authorization: "" })).status,
    ).toBe(401);
  });

  it("refuses to listen beyond localhost without a token", async () => {
    const made = await makeDeps({});
    await expect(startHttpServer({ deps: made.deps(), host: "0.0.0.0", port: 0 })).rejects.toThrow(
      /MUTAGEN_MCP_HTTP_TOKEN/,
    );
    expect(isLocalHost("LOCALHOST")).toBe(true);
    expect(isLocalHost("::1")).toBe(true);
    expect(isLocalHost("192.168.1.2")).toBe(false);
  });

  it("closes idle legacy sessions", async () => {
    const made = await makeDeps({});
    const server = await startHttpServer({ deps: made.deps(), port: 0, idleMs: 20 });
    running.push(server);
    const client = await connect(server.url);
    await expect
      .poll(
        () =>
          client.listTools().then(
            () => "open",
            () => "closed",
          ),
        {
          timeout: 2_000,
          interval: 50,
        },
      )
      .toBe("closed");
  });
});
