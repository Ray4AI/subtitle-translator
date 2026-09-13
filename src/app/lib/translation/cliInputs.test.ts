import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveCliInputs, isPriorTranslationName, expandDirectory, formatInputWarning, producedOutputExists, matchesOutputPrefix } from "./cliInputs";

/**
 * 这些用例覆盖的是"目录输入"这个特性的每一条分支,都不是凭空想出来的 ——
 * 每条对应开发过程中真实踩到或专门验证过的一个场景(见方案文档的实测表)。
 */

let root: string;

const SRT = "1\n00:00:01,000 --> 00:00:02,000\nHello\n\n";
const ASS = "[Script Info]\nTitle: t\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello\n";

// 注意:输出扩展名由【内容】决定(detectSubtitleFormat),不是文件后缀 ——
// 所以 .ass 的夹具必须真的写 ASS 内容,否则会按 SRT 回写成 .srt。
const touch = (rel: string, content = SRT) => {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return full;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cli-inputs-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("expandDirectory", () => {
  test("recurses into nested subdirectories", () => {
    touch("season1/s01e01.srt");
    touch("season2/nested/ep.ass", ASS);
    const found = expandDirectory(root).map((p) => p.slice(root.length + 1)).sort();
    expect(found).toEqual(["season1/s01e01.srt", "season2/nested/ep.ass"]);
  });

  test("skips dot-prefixed files and directories", () => {
    touch("a.srt");
    touch(".hidden.srt");
    touch(".git/config.srt");
    const found = expandDirectory(root).map((p) => p.slice(root.length + 1));
    expect(found).toEqual(["a.srt"]);
  });

  test("is deterministic (sorted) regardless of filesystem readdir order", () => {
    // readdir 顺序依文件系统而异;不排序的话同样的命令在不同机器上处理顺序不同,
    // 复现问题时会误导。
    for (const n of ["c.srt", "a.srt", "b.srt"]) touch(n);
    const first = expandDirectory(root);
    const second = expandDirectory(root);
    expect(first).toEqual(second);
    expect(first.map((p) => p.slice(root.length + 1))).toEqual(["a.srt", "b.srt", "c.srt"]);
  });

  test("returns empty for an empty directory", () => {
    expect(expandDirectory(root)).toEqual([]);
  });
});

describe("isPriorTranslationName", () => {
  test("recognizes stem.<lang>.<ext> for the run's target languages", () => {
    expect(isPriorTranslationName("movie.zh.srt", ["zh"])).toBe(true);
    expect(isPriorTranslationName("movie.zh.srt", ["ja"])).toBe(false);
  });

  test("recognizes the bilingual suffix in both positions", () => {
    expect(isPriorTranslationName("movie.zh_bilingual.ass", ["zh"])).toBe(true);
    // 双语后缀本身就够 —— 它不在任何源文件的命名习惯里。
    expect(isPriorTranslationName("movie.zh_bilingual.ass", ["ja"])).toBe(true);
  });

  test("is case-insensitive (Windows volumes don't distinguish case)", () => {
    expect(isPriorTranslationName("movie.ZH.srt", ["zh"])).toBe(true);
    expect(isPriorTranslationName("movie.zh.srt", ["ZH"])).toBe(true);
    expect(isPriorTranslationName("MOVIE.Zh_BILINGUAL.ass", ["zh"])).toBe(true);
  });

  test("recognizes every target language in a multi-language run", () => {
    expect(isPriorTranslationName("m.ja.srt", ["zh", "ja", "ko"])).toBe(true);
    expect(isPriorTranslationName("m.fr.srt", ["zh", "ja", "ko"])).toBe(false);
  });

  test("does not fire on a language code that merely shares a prefix", () => {
    // zh-hant 与 zh 是不同的语言码;`m.zh.srt` 不该被 "zh-hant" 的过滤器吃掉,
    // 反之亦然。判据是 ".lang." / ".lang_" 的完整分隔,不是前缀匹配。
    expect(isPriorTranslationName("m.zh.srt", ["zh-hant"])).toBe(false);
    expect(isPriorTranslationName("m.zh-hant.srt", ["zh-hant"])).toBe(true);
  });

  test("a source-like name with no language tag is never a prior translation", () => {
    expect(isPriorTranslationName("s01e01.srt", ["zh"])).toBe(false);
  });
});

describe("resolveCliInputs", () => {
  const opts = (targets = ["zh"], skip = true) => ({ skipPriorTranslations: skip, targetLanguages: targets });

  test("expands a directory argument into the files inside it", () => {
    const a = touch("s/s01e01.srt");
    const b = touch("s/s01e02.srt");
    const r = resolveCliInputs([root], opts());
    expect(r.inputs.map((i) => i.path).sort()).toEqual([a, b].sort());
    expect(r.inputs.every((i) => i.origin === "expanded")).toBe(true);
  });

  test("keeps explicit file arguments as-is", () => {
    const a = touch("a.srt");
    const r = resolveCliInputs([a], opts());
    expect(r.inputs).toEqual([{ path: a, origin: "explicit" }]);
  });

  test("skips prior translations when re-running the same directory (idempotency)", () => {
    touch("s/a.srt");
    touch("s/a.zh.srt");
    const r = resolveCliInputs([root], opts(["zh"]));
    expect(r.inputs.map((i) => i.path.slice(root.length + 1))).toEqual(["s/a.srt"]);
    expect(r.warnings.some((w) => w.kind === "skippedPrior")).toBe(true);
  });

  test("--overwrite disables the skip filter", () => {
    touch("s/a.srt");
    touch("s/a.zh.srt");
    const r = resolveCliInputs([root], opts(["zh"], false));
    expect(r.inputs.map((i) => i.path.slice(root.length + 1)).sort()).toEqual(["s/a.srt", "s/a.zh.srt"]);
    expect(r.warnings).toEqual([]);
  });

  test("an explicitly named file wins over the directory filter, even inside an expanded directory", () => {
    // 这是原型第一版真踩到的坑:用户 `-i season -i season/a.zh.srt` 是【点名】
    // 要翻那个文件,过滤器不能因为它在被展开的目录里就把它吃掉。
    const prior = touch("s/a.zh.srt");
    touch("s/a.srt");
    const r = resolveCliInputs([root, prior], opts(["zh"]));
    const byOrigin = new Map(r.inputs.map((i) => [i.path, i.origin]));
    expect(byOrigin.get(prior)).toBe("explicit");
    expect(r.inputs.map((i) => i.path.slice(root.length + 1)).sort()).toEqual(["s/a.srt", "s/a.zh.srt"]);
  });

  test("deduplicates a file reachable both ways (dir + explicit path)", () => {
    const a = touch("s/a.srt");
    const r = resolveCliInputs([root, a], opts());
    expect(r.inputs.filter((i) => i.path === a)).toHaveLength(1);
  });

  test("warns on an empty directory instead of silently doing nothing", () => {
    const r = resolveCliInputs([root], opts());
    expect(r.inputs).toEqual([]);
    expect(r.warnings).toEqual([{ kind: "emptyDirectory", dir: root }]);
  });

  test("warns distinctly when a directory is nothing but prior translations", () => {
    touch("s/a.zh.srt");
    const r = resolveCliInputs([root], opts(["zh"]));
    expect(r.inputs).toEqual([]);
    expect(r.warnings).toEqual([{ kind: "allSkipped", dir: root, skipped: 1 }]);
  });

  test("passes a nonexistent path through so the caller can report ENOENT", () => {
    // 不能在这里吞掉:那会把"路径打错"变成"没有输入文件",两种失败无法区分。
    const ghost = join(root, "nope.srt");
    const r = resolveCliInputs([ghost], opts());
    expect(r.inputs).toEqual([{ path: ghost, origin: "explicit" }]);
    expect(r.warnings).toEqual([]);
  });

  test("emits one aggregated skip warning, not one per file", () => {
    // 200 文件的季度包刷 200 行警告会把真正的 ✖ 淹掉。
    for (let i = 0; i < 25; i++) {
      touch(`s/e${i}.srt`);
      touch(`s/e${i}.zh.srt`);
    }
    const r = resolveCliInputs([root], opts(["zh"]));
    const skips = r.warnings.filter((w) => w.kind === "skippedPrior");
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({ kind: "skippedPrior", skipped: 25 });
  });

  test("mixed tree: only the non-products are translated", () => {
    touch("season1/s01e01.srt");
    touch("season1/s01e01.zh.srt");
    touch("season2/nested/ep.ass", ASS);
    touch("season2/nested/ep.zh.ass");
    touch("README.md");
    const r = resolveCliInputs([root], opts(["zh"]));
    expect(r.inputs.map((i) => i.path.slice(root.length + 1)).sort()).toEqual(["README.md", "season1/s01e01.srt", "season2/nested/ep.ass"]);
  });
});

describe("formatInputWarning", () => {
  test("every warning kind renders one actionable line", () => {
    expect(formatInputWarning({ kind: "emptyDirectory", dir: "/x" })).toContain("/x");
    expect(formatInputWarning({ kind: "allSkipped", dir: "/x", skipped: 3 })).toContain("--overwrite");
    const many = formatInputWarning({ kind: "skippedPrior", skipped: 2, langs: ["zh", "ja"] });
    expect(many).toContain("--overwrite");
    const one = formatInputWarning({ kind: "skippedPrior", skipped: 2, langs: ["zh"] });
    expect(one).toContain('"zh"');
  });
});

/**
 * 端到端:真跑一遍 CLI 二进制,确认译文确实落回各自源文件目录,并且重跑不产生
 * *.zh.zh.srt。用 gtxFreeAPI 的【缓存命中】路径避免打真实 API —— 先跑一次暖缓存,
 * 之后的重跑全部命中本地缓存,不产生计费请求。
 */
describe("CLI end-to-end: directory input", () => {
  const CLI = join(process.cwd(), "scripts/cli.ts");
  const runCli = (args: string[], cacheFile: string) => {
    // 走真实 CLI 进程:这条用例要验的正是"驱动 + 格式层 + 写出路径"串起来之后的
    // 落盘位置,只测纯函数是盖不住的。缓存落在一个临时文件里 —— 第一次运行
    // 真打一次 gtxFreeAPI(免密钥),之后的重跑全部命中缓存,不产生计费请求。
    return spawnSync("npx", ["tsx", CLI, ...args, "--cache-file", cacheFile], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 120_000,
    });
  };

  test("translates a tree in place and is idempotent on re-run", () => {
    const cacheFile = join(root, "cache.json");
    touch("season1/s01e01.srt");
    touch("season2/nested/ep.ass", ASS);

    const first = runCli(["-i", root, "-t", "zh"], cacheFile);
    expect(first.status).toBe(0);

    // 译文回到各自源文件旁 —— 这就是用户要的"各自回原目录"。
    expect(existsSync(join(root, "season1/s01e01.zh.srt"))).toBe(true);
    expect(existsSync(join(root, "season2/nested/ep.zh.ass"))).toBe(true);

    const second = runCli(["-i", root, "-t", "zh"], cacheFile);
    expect(second.status).toBe(0);
    // 幂等:不产生 *.zh.zh.*,也不新增任何产物。
    expect(existsSync(join(root, "season1/s01e01.zh.zh.srt"))).toBe(false);
    expect(existsSync(join(root, "season2/nested/ep.zh.zh.ass"))).toBe(false);
    const produced = readdirSync(root, { recursive: true } as never)
      .map(String)
      .filter((n) => n.endsWith(".zh.srt") || n.endsWith(".zh.ass"));
    expect(produced.sort()).toEqual(["season1/s01e01.zh.srt", "season2/nested/ep.zh.ass"].sort());
  }, 180_000);

  test("never overwrites an existing translation (the expensive-to-notice failure)", () => {
    // 这条是端到端里最要紧的一条:已有的 a.zh.srt 必须**原封不动**。
    // 覆盖它不会报错 —— 软失败行保留原文,所以只是悄悄把好译文换成半份原文,
    // 退出码还是 1,用户根本不会去看那个文件。
    const cacheFile = join(root, "cache.json");
    touch("a.srt", SRT);
    // 译文与源文刻意不同,便于断言"没被碰过"。
    const existing = "1\n00:00:01,000 --> 00:00:02,000\n预置译文不要动\n\n";
    touch("a.zh.srt", existing);

    const r = runCli(["-i", root, "-t", "zh", "--no-cache"], cacheFile);
    expect(r.status).toBe(0);
    expect(readFileSync(join(root, "a.zh.srt"), "utf8")).toBe(existing);
    // 而且必须是"跳过",不是"翻了但内容恰好一样"。
    expect(r.stderr).toContain("already translated");

    // --overwrite 是唯一的翻案途径 —— 但要作用在**源文件**上,不能只 -i 目录。
    // `-i <dir> --overwrite` 会把 a.zh.srt 也当成输入(它不再被过滤器跳过),
    // 于是 "输出会覆盖本轮输入" 守卫正确拦下 a.srt(产出 a.zh.srt 会盖掉那个输入),
    // 而 a.zh.srt 自己反而被翻成 a.zh.zh.srt —— 守卫工作正常,但显然不是本意。
    // 点名源文件才是"重译这一集"的正确用法,所以文档里 --overwrite 的示例走单文件。
    const forced = runCli(["-i", join(root, "a.srt"), "-t", "zh", "--overwrite", "--no-cache"], cacheFile);
    expect(forced.status).toBe(0);
    expect(readFileSync(join(root, "a.zh.srt"), "utf8")).not.toBe(existing);
  }, 180_000);
});

describe("producedOutputExists (the \"already translated, don't redo it\" gate)", () => {
  // 这些用例覆盖的是一个真实踩到的坑:目录里 a.srt 的产物 a.zh.srt 已经存在时,
  // 重跑会把它【覆盖】成本轮翻译结果 —— 而软失败行保留原文,所以一次限流就能
  // 把一份好译文换成半份原文,exit code 只报 1,用户很难注意到。
  test("detects a plain <stem>.<lang>.<ext> product", () => {
    touch("a.zh.srt");
    expect(producedOutputExists(root, "a", "zh")).toBe(true);
    expect(producedOutputExists(root, "a", "ja")).toBe(false);
  });

  test("detects a bilingual product (the _ separator, not just .)", () => {
    touch("a.zh_bilingual.ass");
    expect(producedOutputExists(root, "a", "zh")).toBe(true);
  });

  test("detects an extension-normalized product (srt input, ass output)", () => {
    // 精确扩展名要等 handler 按内容跑完才知道,所以判据必须止步于前缀。
    touch("a.zh.ass");
    expect(producedOutputExists(root, "a", "zh")).toBe(true);
  });

  test("does not fire on a longer stem that merely shares the prefix", () => {
    // a.zhh.srt 不是 a 的产物。判据要求前缀后紧跟 . 或 _。
    touch("a.zhh.srt");
    expect(producedOutputExists(root, "a", "zh")).toBe(false);
  });

  test("does not fire on a different language", () => {
    touch("a.ja.srt");
    expect(producedOutputExists(root, "a", "zh")).toBe(false);
  });

  test("is case-insensitive", () => {
    touch("A.ZH.SRT");
    expect(producedOutputExists(root, "a", "zh")).toBe(true);
  });

  test("ignores directories that happen to match", () => {
    mkdirSync(join(root, "a.zh.srt"), { recursive: true });
    expect(producedOutputExists(root, "a", "zh")).toBe(false);
  });

  test("returns false for a missing directory instead of throwing", () => {
    expect(producedOutputExists(join(root, "nope"), "a", "zh")).toBe(false);
  });

  test("matchesOutputPrefix is the single source of the . / _ rule", () => {
    expect(matchesOutputPrefix("m.zh.srt", "m", "zh")).toBe(true);
    expect(matchesOutputPrefix("m.zh_bilingual.ass", "m", "zh")).toBe(true);
    expect(matchesOutputPrefix("m.zhh.srt", "m", "zh")).toBe(false);
    expect(matchesOutputPrefix("m.zh", "m", "zh")).toBe(false); // 光秃秃的前缀不算产物
  });
});
