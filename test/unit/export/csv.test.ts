import { describe, expect, it } from "vitest";
import { toCsv } from "../../../src/export/csv.js";

const NOTE = "Данные: Мутаген (mutagen.ru)";
const plain = { includeSourceNote: false, bom: false };

describe("toCsv", () => {
  it("writes BOM, semicolons, CRLF and the source note by default", () => {
    const csv = toCsv({
      columns: [
        { key: "phrase", title: "Фраза" },
        { key: "shows", title: "Показы" },
      ],
      rows: [{ phrase: "купить окна", shows: 1200 }],
    });
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toBe(`\uFEFFФраза;Показы\r\nкупить окна;1200\r\n\r\n${NOTE}\r\n`);
  });

  it("uses a decimal comma with semicolons and a decimal point with commas", () => {
    const rows = [{ bid: 12.5, ctr: 0.07 }];
    expect(toCsv({ rows }, plain)).toBe("bid;ctr\r\n12,5;0,07\r\n");
    expect(toCsv({ rows }, { ...plain, delimiter: "," })).toBe("bid,ctr\r\n12.5,0.07\r\n");
    expect(toCsv({ rows }, { ...plain, decimalSeparator: "." })).toBe("bid;ctr\r\n12.5;0.07\r\n");
  });

  it("supports a comma delimiter and can drop the BOM and the note", () => {
    const rows = [{ a: "x;y", b: "p,q" }];
    expect(toCsv({ rows }, plain)).toBe('a;b\r\n"x;y";p,q\r\n');
    expect(toCsv({ rows }, { ...plain, delimiter: "," })).toBe('a,b\r\nx;y,"p,q"\r\n');
  });

  it("quotes fields with quotes, delimiters and line breaks (RFC 4180)", () => {
    const csv = toCsv(
      { rows: [{ a: 'он сказал "да"', b: "строка 1\nстрока 2", c: "a;b", d: "r\r\nn" }] },
      plain,
    );
    expect(csv).toBe('a;b;c;d\r\n"он сказал ""да""";"строка 1\nстрока 2";"a;b";"r\r\nn"\r\n');
  });

  it("infers columns from row keys in order of first appearance", () => {
    const csv = toCsv(
      {
        rows: [
          { b: 1, a: 2 },
          { c: 3, a: 4 },
        ],
      },
      plain,
    );
    expect(csv).toBe("b;a;c\r\n1;2;\r\n;4;3\r\n");
  });

  it("uses titles for the header and leaves missing keys empty", () => {
    const csv = toCsv(
      { columns: [{ key: "x", title: "Икс" }, { key: "y" }], rows: [{ x: 1 }] },
      plain,
    );
    expect(csv).toBe("Икс;y\r\n1;\r\n");
  });

  it("neutralizes CSV injection in strings only", () => {
    const csv = toCsv(
      {
        rows: [
          { a: "=1+1", b: "+7900", c: "-5", d: "@SUM(A1)", e: "\tx", f: "\rx", g: -5, h: "ok=1" },
        ],
      },
      plain,
    );
    expect(csv).toBe("a;b;c;d;e;f;g;h\r\n'=1+1;+7900;-5;'@SUM(A1);'\tx;\"'\rx\";-5;ok=1\r\n");
  });

  it("writes numeric strings as numbers without a prefix", () => {
    const rows = [{ a: "-12", b: "+3.5", c: "4,25", d: "-1-1", e: "+в москве", f: "-0.5e3" }];
    expect(toCsv({ rows }, plain)).toBe(
      "a;b;c;d;e;f\r\n-12;+3,5;4,25;'-1-1;'+в москве;'-0.5e3\r\n",
    );
    expect(toCsv({ rows }, { ...plain, delimiter: "," })).toBe(
      "a,b,c,d,e,f\r\n-12,+3.5,4.25,'-1-1,'+в москве,'-0.5e3\r\n",
    );
  });

  it("neutralizes injection in headers and inside quoted fields", () => {
    const csv = toCsv(
      { columns: [{ key: "a", title: "=HYPERLINK()" }], rows: [{ a: "=a;b" }] },
      plain,
    );
    expect(csv).toBe("'=HYPERLINK()\r\n\"'=a;b\"\r\n");
  });

  it("keeps numeric strings of number columns as numbers", () => {
    const csv = toCsv(
      { columns: [{ key: "n", type: "number" }], rows: [{ n: "-5.5" }, { n: "abc" }] },
      plain,
    );
    expect(csv).toBe("n\r\n-5,5\r\nabc\r\n");
  });

  it("formats booleans, dates, nulls and nested values", () => {
    const csv = toCsv(
      {
        columns: [{ key: "b" }, { key: "d" }, { key: "n" }, { key: "u" }, { key: "o" }],
        rows: [
          { b: true, d: new Date("2026-10-14T10:30:00Z"), n: null, o: { k: [1] } },
          { b: false },
        ],
      },
      plain,
    );
    expect(csv).toBe('b;d;n;u;o\r\nда;2026-10-14T10:30:00.000Z;;;"{""k"":[1]}"\r\nнет;;;;\r\n');
  });
});
