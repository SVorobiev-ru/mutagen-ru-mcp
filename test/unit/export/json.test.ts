import { describe, expect, it } from "vitest";
import { toJson } from "../../../src/export/json.js";

const table = {
  columns: [
    { key: "phrase", title: "Фраза", type: "string" as const },
    { key: "shows", type: "number" as const },
  ],
  rows: [
    { phrase: "купить окна", shows: 1200 },
    { phrase: "окна пвх", shows: 800 },
  ],
  meta: { generatedAt: "2026-10-14T09:00:00.000Z", query: "окна", region: "Москва" },
};

describe("toJson", () => {
  it("writes meta, columns and rows indented by 2 spaces", () => {
    const json = toJson(table);
    expect(json.startsWith('{\n  "meta": {\n    "source": "mutagen.ru",')).toBe(true);
    expect(json.endsWith("}\n")).toBe(true);
    expect(JSON.parse(json)).toEqual({
      meta: { source: "mutagen.ru", ...table.meta },
      columns: table.columns,
      rows: table.rows,
    });
  });

  it("fills the default source and generation time", () => {
    const { meta } = JSON.parse(toJson({ rows: [] })) as { meta: Record<string, string> };
    expect(meta.source).toBe("mutagen.ru");
    expect(new Date(meta.generatedAt ?? "").toISOString()).toBe(meta.generatedAt);
    expect(meta).not.toHaveProperty("query");
  });

  it("always names mutagen.ru as the source", () => {
    const { meta } = JSON.parse(toJson({ rows: [], meta: { source: "other" } })) as {
      meta: Record<string, string>;
    };
    expect(meta.source).toBe("mutagen.ru");
    expect(Object.keys(meta)[0]).toBe("source");
  });

  it("infers columns from the rows", () => {
    const { columns } = JSON.parse(toJson({ rows: [{ b: 1 }, { a: 2, b: 3 }] })) as {
      columns: unknown;
    };
    expect(columns).toEqual([{ key: "b" }, { key: "a" }]);
  });

  it("writes NDJSON with meta on the first line", () => {
    const ndjson = toJson(table, { ndjson: true });
    expect(ndjson.endsWith("}\n")).toBe(true);
    const lines = ndjson.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { source: "mutagen.ru", ...table.meta },
      ...table.rows,
    ]);
  });
});
