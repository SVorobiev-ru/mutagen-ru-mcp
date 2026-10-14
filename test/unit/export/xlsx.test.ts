import { describe, expect, it } from "vitest";
import { toXlsx } from "../../../src/export/xlsx.js";
import { readZip } from "./zip.js";

const table = {
  columns: [
    { key: "phrase", title: "Фраза" },
    { key: "shows", title: "Показы", type: "number" as const },
    { key: "active", title: "Активна", type: "boolean" as const },
    { key: "day", title: "Дата", type: "date" as const },
  ],
  rows: [
    { phrase: "купить окна", shows: "1234", active: true, day: "2026-10-14" },
    { phrase: "=1+1", shows: 5.5, active: false, day: "2026-10-14T10:30:00Z" },
    { phrase: null, shows: null, active: null, day: null },
  ],
  meta: { generatedAt: "2026-10-14T09:00:00.000Z", query: "окна", region: "Москва" },
};

describe("toXlsx", () => {
  it("produces a zip with the data and source sheets", async () => {
    const buffer = await toXlsx(table);
    expect(buffer.byteLength).toBeGreaterThan(0);
    expect(buffer.subarray(0, 2).toString("latin1")).toBe("PK");
    const files = readZip(buffer);
    expect(files.has("xl/worksheets/sheet1.xml")).toBe(true);
    expect(files.has("xl/worksheets/sheet2.xml")).toBe(true);
    const workbook = files.get("xl/workbook.xml") ?? "";
    expect(workbook).toContain('name="Данные"');
    expect(workbook).toContain('name="Источник"');
  });

  it("writes numbers as numbers, booleans as да/нет and dates as serials", async () => {
    const files = readZip(await toXlsx(table));
    const sheet = files.get("xl/worksheets/sheet1.xml") ?? "";
    expect(sheet).toContain('<c r="B2"><v>1234</v></c>');
    expect(sheet).toContain('<c r="B3"><v>5.5</v></c>');
    expect(sheet).toContain('<c r="D2" s="2"><v>46309</v></c>');
    expect(sheet).toContain('<c r="D3" s="3"><v>46309.4375</v></c>');
    const strings = files.get("xl/sharedStrings.xml") ?? "";
    for (const text of ["Фраза", "купить окна", "=1+1", "да", "нет"]) {
      expect(strings).toContain(`<t>${text}</t>`);
    }
  });

  it("freezes the header row, makes it bold and sizes the columns", async () => {
    const files = readZip(await toXlsx(table));
    const sheet = files.get("xl/worksheets/sheet1.xml") ?? "";
    expect(sheet).toContain('<pane ySplit="1"');
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<c r="A1" s="1" t="s">');
    expect(files.get("xl/styles.xml")).toContain("<b/>");
    expect(sheet).toContain('<col min="1" max="1" width="13" customWidth="1"/>');
  });

  it("caps the column width at 60", async () => {
    const files = readZip(await toXlsx({ rows: [{ text: "я".repeat(500) }] }));
    expect(files.get("xl/worksheets/sheet1.xml")).toContain('width="60"');
  });

  it("describes the source on the second sheet", async () => {
    const files = readZip(await toXlsx(table));
    const strings = files.get("xl/sharedStrings.xml") ?? "";
    for (const text of [
      "Источник",
      "mutagen.ru",
      "окна",
      "Москва",
      "Данные: Мутаген (mutagen.ru)",
    ]) {
      expect(strings).toContain(`<t>${text}</t>`);
    }
    expect(files.get("xl/worksheets/sheet2.xml")).not.toContain("<pane");
  });

  it("handles an empty table", async () => {
    const buffer = await toXlsx({ rows: [] });
    expect(buffer.subarray(0, 2).toString("latin1")).toBe("PK");
  });
});
