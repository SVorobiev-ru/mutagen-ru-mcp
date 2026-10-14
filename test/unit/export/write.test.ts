import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMutagenError } from "../../../src/core/errors.js";
import { writeTable } from "../../../src/export/write.js";
import { readZip } from "./zip.js";

const table = {
  columns: [{ key: "phrase", title: "Фраза" }, { key: "shows" }],
  rows: [
    { phrase: "купить окна", shows: 1200 },
    { phrase: "окна пвх", shows: 800 },
  ],
  meta: { generatedAt: "2026-10-14T09:00:00.000Z" },
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mutagen-export-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeTable", () => {
  it("writes CSV with a BOM and reports the result", async () => {
    const path = join(dir, "out.csv");
    const result = await writeTable(table, path);
    const bytes = await readFile(path);
    expect(result).toEqual({ path, format: "csv", rows: 2, bytes: bytes.byteLength });
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8")).toContain("Фраза;shows\r\nкупить окна;1200\r\n");
  });

  it("writes JSON and NDJSON by extension", async () => {
    const json = await writeTable(table, join(dir, "out.json"));
    expect(json.format).toBe("json");
    expect(JSON.parse(await readFile(json.path, "utf8")).rows).toEqual(table.rows);

    const ndjson = await writeTable(table, join(dir, "out.ndjson"));
    expect(ndjson.format).toBe("ndjson");
    expect((await readFile(ndjson.path, "utf8")).trimEnd().split("\n")).toHaveLength(3);
  });

  it("writes XLSX by extension, case-insensitively", async () => {
    const result = await writeTable(table, join(dir, "OUT.XLSX"));
    expect(result.format).toBe("xlsx");
    const bytes = await readFile(result.path);
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(readZip(bytes).has("xl/worksheets/sheet1.xml")).toBe(true);
    expect(result.bytes).toBe(bytes.byteLength);
  });

  it("lets opts.format override the extension and passes CSV options", async () => {
    const result = await writeTable(table, join(dir, "data.txt"), {
      format: "csv",
      delimiter: ",",
      bom: false,
      includeSourceNote: false,
    });
    expect(result.format).toBe("csv");
    expect(await readFile(result.path, "utf8")).toBe(
      "Фраза,shows\r\nкупить окна,1200\r\nокна пвх,800\r\n",
    );
  });

  it("treats json with the ndjson option as NDJSON", async () => {
    const result = await writeTable(table, join(dir, "out.json"), { ndjson: true });
    expect(result.format).toBe("ndjson");
  });

  it("creates missing directories and leaves no temporary files", async () => {
    const result = await writeTable(table, join(dir, "a", "b", "out.csv"));
    expect(await readdir(join(dir, "a", "b"))).toEqual(["out.csv"]);
    expect(result.path).toBe(join(dir, "a", "b", "out.csv"));
  });

  it("overwrites an existing file", async () => {
    const path = join(dir, "out.json");
    await writeTable({ rows: [{ a: 1 }] }, path);
    await writeTable({ rows: [{ a: 2 }] }, path);
    expect(JSON.parse(await readFile(path, "utf8")).rows).toEqual([{ a: 2 }]);
  });

  it("rejects an unknown extension without writing anything", async () => {
    const error = await writeTable(table, join(dir, "out.txt")).catch((e: unknown) => e);
    expect(isMutagenError(error) && error.kind).toBe("validation");
    expect(await readdir(dir)).toEqual([]);
  });
});
