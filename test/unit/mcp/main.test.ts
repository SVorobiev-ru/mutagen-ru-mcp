import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  outputDirFrom,
  parseToolGroups,
  resolveSaveAs,
  VERSION,
  waitSecondsFrom,
} from "../../../src/mcp/context.js";
import { main, USAGE } from "../../../src/mcp/main.js";
import { serveMcpStdio } from "../../../src/mcp/stdio.js";
import { cleanup, json, makeDeps } from "./helpers.js";

afterEach(cleanup);

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { out: (text: string) => out.push(text), err: (text: string) => err.push(text) },
  };
}

describe("mutagen-ru-mcp main", () => {
  it("prints help and the package version", async () => {
    const help = io();
    expect(await main(["--help"], {}, help.io)).toEqual({ exitCode: 0 });
    expect(help.out[0]).toBe(USAGE);
    const version = io();
    expect(await main(["-v"], {}, version.io)).toEqual({ exitCode: 0 });
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version: string };
    expect(version.out).toEqual([pkg.version]);
    expect(VERSION).toBe(pkg.version);
  });

  it("rejects unknown options and bad values", async () => {
    for (const argv of [["--nope"], ["--port"], ["--port", "x"], ["--host", "--http"]]) {
      const run = io();
      expect(await main(argv, {}, run.io)).toEqual({ exitCode: 2 });
      expect(run.err[0]).toContain("Usage:");
    }
  });

  it("fails on invalid configuration", async () => {
    const run = io();
    expect(await main([], { MUTAGEN_BUDGET_RUB: "много" }, run.io)).toEqual({ exitCode: 1 });
    expect(run.err[0]).toContain("MUTAGEN_BUDGET_RUB");
  });

  it("starts and stops the HTTP server without leaking the key", async () => {
    const run = io();
    const env = { MUTAGEN_API_KEY: "secret-key-123", MUTAGEN_TOOLS: "basic,text,magic" };
    const result = await main(["--http", "--port", "0", "--host", "127.0.0.1"], env, run.io);
    expect(result.close).toBeDefined();
    await result.close?.();
    expect(run.err.join("\n")).toContain("unknown groups ignored: magic");
    expect(run.err.join("\n")).toMatch(/listening on http:\/\/127\.0\.0\.1:\d+\/mcp/);
    expect(run.err.join("\n")).not.toContain("secret-key-123");
  });

  it("reports a refused HTTP start and a missing key", async () => {
    const run = io();
    expect(await main(["--http", "--host", "0.0.0.0", "--port", "0"], {}, run.io)).toEqual({
      exitCode: 1,
    });
    expect(run.err.join("\n")).toContain("Set MUTAGEN_API_KEY");
    expect(run.err.join("\n")).toContain("MUTAGEN_MCP_HTTP_TOKEN");
  });
});

describe("stdio transport", () => {
  it("serves the factory over a given transport", async () => {
    const made = await makeDeps({ balance: () => json({ balance: "3" }) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveMcpStdio(made.deps(), { transport: serverTransport, onerror: () => {} });
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "mutagen_balance", arguments: {} });
    expect(result.structuredContent).toMatchObject({ rows: [{ balance: 3 }] });
    await client.close();
    await handle.close();
  });
});

describe("MCP context helpers", () => {
  it("reads MUTAGEN_MCP_WAIT_SECONDS with a 45 s default", async () => {
    expect(waitSecondsFrom({})).toBe(45);
    expect(waitSecondsFrom({ MUTAGEN_MCP_WAIT_SECONDS: " 10 " })).toBe(10);
    expect(() => waitSecondsFrom({ MUTAGEN_MCP_WAIT_SECONDS: "0" })).toThrow(/WAIT_SECONDS/);
    expect(() => waitSecondsFrom({ MUTAGEN_MCP_WAIT_SECONDS: "долго" })).toThrow(/WAIT_SECONDS/);
    const run = io();
    expect(await main([], { MUTAGEN_MCP_WAIT_SECONDS: "-1" }, run.io)).toEqual({ exitCode: 1 });
    expect(run.err.join("\n")).toContain("MUTAGEN_MCP_WAIT_SECONDS");
    expect(USAGE).toContain("MUTAGEN_MCP_WAIT_SECONDS");
  });

  it("parses tool groups", () => {
    expect([...parseToolGroups(undefined).groups]).toEqual([
      "basic",
      "parser",
      "serp",
      "scenarios",
      "text",
    ]);
    expect(parseToolGroups(" Serp , scenarios,x ")).toEqual({
      groups: new Set(["serp", "scenarios"]),
      unknown: ["x"],
    });
  });

  it("resolves the output directory and save_as paths", async () => {
    expect(outputDirFrom({ MUTAGEN_OUTPUT_DIR: "/tmp/out" })).toBe(resolve("/tmp/out"));
    expect(outputDirFrom({})).toBe(resolve("mutagen-results"));
    const made = await makeDeps({});
    const deps = made.deps();
    expect(await resolveSaveAs(deps, {})).toBeUndefined();
    expect(await resolveSaveAs(deps, { save_as: "a.XLSX" })).toEqual({
      path: join(made.outputDir, "a.XLSX"),
      overwrite: false,
    });
    expect(
      await resolveSaveAs({ ...deps, allowAnyOutputPath: true }, { save_as: "/tmp/abs.csv" }),
    ).toEqual({ path: resolve("/tmp/abs.csv"), overwrite: false });
    for (const save_as of ["/tmp/abs.csv", "../../x.csv", "sub/../../x.csv"]) {
      await expect(resolveSaveAs(deps, { save_as })).rejects.toThrow(
        /outside the output directory/,
      );
    }
    expect(await resolveSaveAs(deps, { save_as: "sub/../ok.csv", overwrite: true })).toEqual({
      path: join(made.outputDir, "ok.csv"),
      overwrite: true,
    });
  });
});
