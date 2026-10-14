import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parsePhraseText, splitCsvLine } from "../../../src/cli/input.js";
import { toCsv } from "../../../src/export/csv.js";
import { MISSING_KEY_RU } from "../../../src/mcp/links.js";
import { fakeHandlers } from "../scenarios/helpers.js";
import { cleanup, cli, json, tempDir } from "./helpers.js";

afterEach(cleanup);

const api = () =>
  fakeHandlers({
    wordstat: {
      "натяжные потолки": {
        "натяжные потолки": 120_000,
        "натяжные потолки цена": 45_000,
        "матовый натяжной потолок": 2_000,
        "натяжные потолки бесплатно": 50,
      },
    },
    exact: { "натяжные потолки": 30_000, "натяжные потолки цена": 9_000 },
  });

describe("scenario commands", () => {
  it("core --dry-run prints the estimate without API calls", async () => {
    const result = await cli(["core", "натяжные потолки", "--budget", "10", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.calls).toHaveLength(0);
    expect(result.stderr).toContain("--dry-run, API не вызывалось");
    expect(result.stderr).toContain("Смета: 10.00 ₽");
    expect(result.stderr).toContain("max_phrases 500 → 499");
    expect(result.stdout).toContain("wordstat_qs;499");
  });

  it("core needs --budget and runs with --yes", async () => {
    const missing = await cli(["core", "натяжные потолки"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("--budget");
    const ask = await cli(
      ["core", "натяжные потолки", "--budget", "5", "--source", "wordstat"],
      api(),
    );
    expect(ask.code).toBe(3);
    expect(ask.calls).toHaveLength(0);
    const result = await cli(
      ["core", "натяжные потолки", "--budget", "5", "--source", "wordstat", "--yes", "--json"],
      api(),
    );
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as { rows: Record<string, unknown>[]; total: number };
    expect(output.total).toBe(4);
    expect(output.rows[0]).toMatchObject({
      phrase: "натяжные потолки",
      base: 120_000,
      wordstat_qs: 30_000,
      cluster: "натяжные потолки",
    });
    expect(output.rows.map((row) => row.phrase)).toContain("натяжные потолки бесплатно");
    expect(result.stderr).toContain("Итоги / Summary");
  });

  it("core --exclude sets the junk categories", async () => {
    const run = (extra: string[]) =>
      cli(
        [
          "core",
          "натяжные потолки",
          "--budget",
          "5",
          "--source",
          "wordstat",
          "--yes",
          "--json",
        ].concat(extra),
        api(),
      );
    const free = await run(["--exclude", "free,job"]);
    expect(free.code).toBe(0);
    const rows = (JSON.parse(free.stdout) as { rows: { phrase: string }[] }).rows;
    expect(rows.map((row) => row.phrase)).not.toContain("натяжные потолки бесплатно");
    expect(free.stderr).toContain('"minusWords":["бесплатно"]');
    const bad = await run(["--exclude", "spam"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("excludeCategories");
    expect(bad.calls).toHaveLength(0);
  });

  it("expand reads a core CSV written by core -o", async () => {
    const root = await tempDir();
    const core = toCsv({
      columns: [
        { key: "phrase", title: "Фраза" },
        { key: "base", title: "Базовая частота", type: "number" },
      ],
      rows: [{ phrase: "натяжные потолки", base: 120_000 }],
    });
    await writeFile(join(root, "core.csv"), core);
    const result = await cli(
      ["expand", "-i", "core.csv", "--budget", "1", "--source", "wordstat", "--yes"],
      api(),
      { root },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("натяжные потолки цена");
    expect(result.stdout).not.toMatch(/^натяжные потолки;/m);
  });

  it("cluster reads phrases with frequencies from CSV", async () => {
    const root = await tempDir();
    await writeFile(
      join(root, "phrases.csv"),
      "Фраза;Частота\nнатяжные потолки;120 000\nматовый натяжной потолок;2000\nокна пвх;6000\n",
    );
    const result = await cli(["cluster", "-i", "phrases.csv"], {}, { root });
    expect(result.code).toBe(0);
    expect(result.calls).toHaveLength(0);
    const lines = result.stdout.trim().split(/\r?\n/);
    expect(lines[0]).toBe("Кластер;Фраза;Частота;Главная фраза");
    expect(lines[1]).toBe("натяжные потолки;натяжные потолки;120000;да");
    expect(lines[2]).toBe("натяжные потолки;матовый натяжной потолок;2000;нет");
    expect(lines[3]).toBe("окна пвх;окна пвх;6000;да");
  });

  it("title, minus, plan and gap work from the command line", async () => {
    const title = await cli(["title", "окна пвх", "окна пвх цена", "--brand", "М"], {
      ...fakeHandlers({ exact: { "окна пвх": 100, "окна пвх цена": 50 } }),
    });
    expect(title.code).toBe(0);
    expect(title.stdout).toContain("Title;Окна пвх — цена | М");

    const minus = await cli(["minus", "-i", "-"], {}, { stdin: "окна бесплатно\nокна пвх\n" });
    expect(minus.code).toBe(0);
    expect(minus.stderr).toContain("Минус-слова для Директа / Direct: -бесплатно");
    expect(minus.calls).toHaveLength(0);
    const ask = await cli(["minus", "окна", "--dry-run"]);
    expect(ask.code).toBe(0);
    expect(ask.stderr).toContain("Смета: 0.02 ₽");
    expect(ask.calls).toHaveLength(0);

    const plan = await cli(["plan", "-i", "-"], {}, { stdin: "как мыть окна\nокна\n" });
    expect(plan.code).toBe(0);
    expect(plan.stdout).toContain("Как мыть окна?");

    const gap = await cli(["gap", "my.ru", "--competitors", "a.ru"], {
      "serp.report": (call) =>
        json(
          (call.body as { domain: string }).domain === "a.ru"
            ? [{ keyword: "окна пвх", position: 1, region_wsn: 10 }]
            : [],
        ),
    });
    expect(gap.code).toBe(0);
    expect(gap.stdout).toContain("окна пвх;10;1;1;a.ru");

    const project = await cli(["cluster", "--mode", "project", "--project", "5"], {
      "progect.keywords": () => json([{ keyword: "окна", claster_id: "1" }]),
    });
    expect(project.code).toBe(0);
    expect(project.stdout).toContain("окна;окна;;да");
  });
});

describe("scenario commands without MUTAGEN_API_KEY", () => {
  it("run the free cases locally without any request", async () => {
    const root = await tempDir();
    await writeFile(join(root, "title.csv"), "Фраза;Частота\nокна пвх;100\nокна пвх цена;50\n");
    const offline = { root, key: false };
    const cluster = await cli(
      ["cluster", "натяжные потолки", "матовый натяжной потолок", "окна пвх"],
      {},
      offline,
    );
    expect(cluster.code).toBe(0);
    expect(cluster.stdout).toContain("натяжные потолки;матовый натяжной потолок");
    const minus = await cli(["minus", "-i", "-"], {}, { ...offline, stdin: "окна бесплатно\n" });
    expect(minus.code).toBe(0);
    expect(minus.stderr).toContain("Direct: -бесплатно");
    const plan = await cli(["plan", "-i", "-"], {}, { ...offline, stdin: "как мыть окна\n" });
    expect(plan.code).toBe(0);
    expect(plan.stdout).toContain("Как мыть окна?");
    const title = await cli(["title", "-i", "title.csv"], {}, offline);
    expect(title.code).toBe(0);
    expect(title.stdout).toContain("Title;Окна пвх — цена");
    for (const result of [cluster, minus, plan, title]) expect(result.calls).toHaveLength(0);
  });

  it("asks for the key when the case needs the API", async () => {
    for (const argv of [
      ["title", "окна пвх"],
      ["cluster", "окна пвх", "--mode", "serp"],
      ["minus", "окна", "--budget", "1"],
      ["plan", "окна", "--budget", "1"],
      ["expand", "окна пвх", "--budget", "1"],
    ]) {
      const result = await cli(argv, {}, { key: false });
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.stderr, argv.join(" ")).toContain(MISSING_KEY_RU);
      expect(result.calls).toHaveLength(0);
    }
  });
});

describe("text command", () => {
  it("dedupes phrases from stdin", async () => {
    const result = await cli(
      ["text", "dedupe"],
      {},
      {
        key: false,
        stdin: "окна пвх\nОкна  ПВХ\nпластиковые окна\n",
      },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("пластиковые окна");
    expect(result.stdout.match(/пвх/gi)).toHaveLength(1);
    expect(result.stderr).toContain('"removed":1');
  });

  it("compares two files and combines word lists", async () => {
    const root = await tempDir();
    await writeFile(join(root, "a.txt"), "окна\nдвери\n");
    await writeFile(join(root, "b.txt"), "окно\nкрыша\n");
    const compare = await cli(
      ["text", "compare", "-i", "a.txt", "-i", "b.txt", "--implicit"],
      {},
      { root, key: false },
    );
    expect(compare.code).toBe(0);
    expect(compare.stdout).toContain("окна;both");
    expect(compare.stdout).toContain("крыша;only_b");
    const combined = await cli(
      ["text", "combinator", "-i", "a.txt", "-i", "b.txt"],
      {},
      { root, key: false },
    );
    expect(combined.stdout).toContain("окна окно");
    expect((await cli(["text", "compare", "-i", "a.txt"], {}, { root })).code).toBe(2);
    expect((await cli(["text", "combinator", "-i", "a.txt"], {}, { root })).code).toBe(2);
    const filter = await cli(["text", "filter", "окна пвх", "двери", "--exclude", "пвх"]);
    expect(filter.stdout).toContain("двери");
    expect(filter.stdout).not.toContain("окна пвх");
    expect((await cli(["text", "nope"])).code).toBe(2);
  });
});

describe("phrase files", () => {
  it("reads plain lines, CSV with headers and exported tables", () => {
    expect(parsePhraseText("окна, двери\n# comment\n\nкрыша\n")).toEqual([
      { phrase: "окна, двери" },
      { phrase: "крыша" },
    ]);
    expect(parsePhraseText('phrase,frequency\n"окна, пвх",1200\nдвери,\n')).toEqual([
      { phrase: "окна, пвх", frequency: 1200 },
      { phrase: "двери" },
    ]);
    const exported = toCsv({
      columns: [
        { key: "phrase", title: "Фраза" },
        { key: "base", title: "Базовая частота", type: "number" },
      ],
      rows: [
        { phrase: "-окна", base: 12.5 },
        { phrase: 'двери "люкс"', base: 3 },
      ],
    });
    expect(parsePhraseText(exported)).toEqual([
      { phrase: "-окна", frequency: 12.5 },
      { phrase: 'двери "люкс"', frequency: 3 },
    ]);
    expect(parsePhraseText("окна;5\nдвери;7\n", true)).toEqual([
      { phrase: "окна", frequency: 5 },
      { phrase: "двери", frequency: 7 },
    ]);
    expect(parsePhraseText("ключ\tчастотность\nокна\t1 000\n")).toEqual([
      { phrase: "окна", frequency: 1000 },
    ]);
    expect(parsePhraseText("")).toEqual([]);
    expect(splitCsvLine('a;"b;""c""";d', ";")).toEqual(["a", 'b;"c"', "d"]);
  });
});
