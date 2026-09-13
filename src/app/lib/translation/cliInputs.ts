// CLI 输入解析:把 `-i` 收到的路径(文件或**目录**)解析成本次要翻译的文件列表。
//
// 为什么单独一个模块(而不是留在 scripts/cli.ts 里):
//   scripts/cli.ts 顶层就调 parseCliArgs()、末尾直接 .then(process.exitCode = …),
//   任何 import 都会真的把 CLI 跑一遍 —— 它【不可测】。目录展开是本次新增的、
//   分支最多的一块逻辑(空目录 / 嵌套 / 隐藏文件 / 上次产物过滤 / 显式路径压过
//   过滤器),必须能脱离进程真实 argv 与真实 API 单测。放在 lib/translation 下与
//   cliFormat.ts 同层:这是主仓与翻译子项目路径唯一相同的地方,同步规则不会把它
//   落在某个子仓的目录之外。
//
// 【不引入 glob 依赖】fast-glob / tinyglobby 只是 Next 的传递依赖,不是本项目的
// 直接依赖;目录展开用 node:fs 的标准库原语就够(见 expandDirectory)。

import { readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, join, resolve } from "node:path";

/** 展开过程中产生的提示(驱动按既有 `warning:` / `✖` 措辞打印)。 */
export type InputWarning =
  /** 目录存在但一个文件都没有。 */
  | { kind: "emptyDirectory"; dir: string }
  /** 目录里有文件,但全部被「上次产物」过滤器跳过。 */
  | { kind: "allSkipped"; dir: string; skipped: number }
  /** 跳过了一批疑似上次产物的文件(至少有一个真正参与本轮)。 */
  | { kind: "skippedPrior"; skipped: number; langs: string[] };

/** 一个输入文件的来源:决定它能否被「上次产物」过滤器跳过。 */
export type InputOrigin =
  /** 目录参数展开出来的 —— 可以被过滤器跳过。 */
  | "expanded"
  /** 命令行上显式写的路径 —— 永不被过滤器跳过(用户是故意的)。 */
  | "explicit";

export interface ResolvedInput {
  /** 绝对路径。 */
  path: string;
  origin: InputOrigin;
}

export interface ResolveInputsOptions {
  /**
   * 是否启用「跳过上次产物」过滤器(对应 --overwrite 的反面)。
   * false 时目录展开出的文件也原样参与 —— 用户显式要求重译。
   */
  skipPriorTranslations: boolean;
  /** 本次目标语言(用于识别 stem.<lang>.<ext>)。大小写不敏感。 */
  targetLanguages: readonly string[];
}

export interface ResolveInputsResult {
  inputs: ResolvedInput[];
  warnings: InputWarning[];
}

/**
 * 产出文件名里"这是译文而非源文件"的识别规则。与 scripts/cli.ts 的写出形状
 * 一一对应,形状来自 formats/subtitle.ts 的 getOutputFileExtension +
 * appendBilingualSuffix:
 *
 *   普通  <stem>.<lang>.<ext>
 *   双语  <stem>.<lang>_bilingual.<ext>
 *
 * 两条限制,都【有意】保留:
 *  1. 只认本次的 targetLanguages。用 -t ja 跑过、这次用 -t zh 跑,*.ja.srt 不在
 *     词表里,会被当成源文件翻一遍。跨语言的"上次产物"识别需要扫描全语言表,
 *     会显著提高误报(源文件真叫 x.pt.srt 也会被吃掉),不值得。
 *  2. 靠文件名判,不看内容。源文件本来就叫 foo.zh.srt 就会被静默跳过 —— 这是
 *     本过滤器唯一的误报方向,所以它【只作用于目录展开出来的文件】,且跳过时
 *     必须打 keep-audit 警告(见 resolveCliInputs),用户看到得、也关得掉。
 *
 * 大小写不敏感:.zh. 与 .ZH. 都要认(Windows 卷不区分大小写,产出也只在大小写上
 * 有差别)。与 cli.ts 的 pathKey / sameLang 同一判据。
 */
export const isPriorTranslationName = (name: string, targetLanguages: readonly string[]): boolean => {
  const lower = name.toLowerCase();
  // 双语后缀可能出现在语言码之前(双语)、也可能是 stem 自带的形状;
  // 只要出现 _bilingual 就被当作产物 —— 它本来就不是任何源文件的命名习惯。
  if (lower.includes("_bilingual")) return true;
  return targetLanguages.some((lang) => {
    const l = lang.toLowerCase();
    return lower.includes(`.${l}.`) || lower.includes(`.${l}_`);
  });
};

/**
 * 递归收集目录下的文件。
 *
 * 跳过点开头的条目(隐藏文件/目录):`.DS_Store`、`.git/` 之类必然是噪音,
 * 展开进输入列表只会换成一堆 `cannot infer format` 的 ✖。这是【有意】的取舍:
 * 真有一份叫 `.hidden.srt` 的字幕要翻时,显式写 `-i .hidden.srt` 仍可翻(它走
 * explicit 来源,不受展开规则约束)。
 *
 * 不做符号链接跟随(用 withFileTypes 的 isDirectory/isFile,链到目录的 symlink
 * 两条都 false,会被当普通文件交给 handler,由 format 推断如实报错)——
 * 跟随 symlink 会让 A→B、B→A 这种环把展开变成死循环。
 */
export const expandDirectory = (dir: string): string[] => {
  const out: string[] = [];
  // 显式栈而非递归:极深的目录树(某些字幕组按 s01/e01/… 层层分包)不会爆栈。
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // 读不动的子目录(权限/竞态删除)按"没有文件"处理,不打断整批 ——
      // 与 cli.ts 里"单个文件读失败只记 ✖ 不中断"同一个契约。
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  // readdirSync 的顺序依赖文件系统;排序让同一棵树的展开结果稳定 ——
  // 否则同样的命令在不同机器上产出不同的处理顺序,复现问题时会误导。
  return out.sort();
};

/**
 * 把 `-i` 的参数解析成本次真正要翻的文件。
 *
 * 关键不变量(逐条对应一条测试):
 *  - 目录参数递归展开,译文因此落回各自源文件同目录(驱动侧
 *    `outDir = dirname(inputPath)` 天然满足,不需要额外逻辑)。
 *  - 展开出来的文件里,名字像"上次产物"的被跳过 —— 否则重跑同一目录会把
 *    `a.zh.srt` 当输入,产出 `a.zh.zh.srt` 并撞上"输出覆盖输入"守卫。
 *  - 命令行上【显式】写的路径永不被跳过,即使它长得像产物、即使它在被展开的
 *    目录里面。用户点名要翻它,就翻。
 *  - 不存在的路径原样传下去:让 cli.ts 打它原来那句 `cannot read (ENOENT)`,
 *    保持"路径写错"与"目录里没文件"两种失败可区分。
 */
export const resolveCliInputs = (paths: readonly string[], opts: ResolveInputsOptions): ResolveInputsResult => {
  const warnings: InputWarning[] = [];
  const explicit = new Set(paths);
  const inputs: ResolvedInput[] = [];
  const seen = new Set<string>();
  let totalSkipped = 0;

  const push = (p: string, origin: InputOrigin) => {
    const abs = resolve(p);
    if (seen.has(abs)) return;
    seen.add(abs);
    inputs.push({ path: abs, origin });
  };

  for (const p of paths) {
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      // 不存在/不可读:当作文件交给下游报错。别在这里吞掉 —— 那会把一个
      // 打错的路径变成"没有输入文件"。
      push(p, "explicit");
      continue;
    }

    if (!isDir) {
      push(p, "explicit");
      continue;
    }

    const found = expandDirectory(p);
    if (found.length === 0) {
      warnings.push({ kind: "emptyDirectory", dir: p });
      continue;
    }

    let skippedHere = 0;
    for (const file of found) {
      // 显式点名的文件永远赢:即使它长得像产物、又恰好在被展开的目录里。
      if (explicit.has(file)) {
        push(file, "explicit");
        continue;
      }
      if (opts.skipPriorTranslations && isPriorTranslationName(basename(file), opts.targetLanguages)) {
        skippedHere++;
        continue;
      }
      push(file, "expanded");
    }
    totalSkipped += skippedHere;
    if (skippedHere > 0 && skippedHere === found.length) {
      warnings.push({ kind: "allSkipped", dir: p, skipped: skippedHere });
    }
  }

  // 汇总一条 skip 警告,而不是每个文件一条 —— 200 文件的季度包会刷 200 行,
  // 把真正的 ✖ 淹掉(cli.ts 里 firstLangForFile 那条注释是同一个教训)。
  if (totalSkipped > 0 && !warnings.some((w) => w.kind === "allSkipped")) {
    warnings.push({ kind: "skippedPrior", skipped: totalSkipped, langs: [...opts.targetLanguages] });
  }

  return { inputs, warnings };
};

/** 警告 → 一行人类可读文本。措辞集中在这里,驱动只负责往 stderr 打印。 */
export const formatInputWarning = (w: InputWarning): string => {
  switch (w.kind) {
    case "emptyDirectory":
      return `directory ${w.dir} contains no files — nothing to translate there.`;
    case "allSkipped":
      return `directory ${w.dir}: all ${w.skipped} file(s) look like output of a previous run and were skipped — pass --overwrite to translate them anyway.`;
    case "skippedPrior":
      return `skipped ${w.skipped} file(s) that look like output of a previous run (name contains ${w.langs.length > 1 ? "one of the target languages" : `"${w.langs[0]}"`} or _bilingual) — pass --overwrite to translate them anyway.`;
  }
};

/**
 * 产出文件名前缀 —— 本轮会写出的所有形状都以它开头:
 *
 *   普通  <stem>.<lang>.<ext>
 *   双语  <stem>.<lang>_bilingual.<ext>   (appendBilingualSuffix 插在最后一个点前)
 *
 * 只判到分隔符为止(`.` / `_`),不是整名比较 —— 因为精确扩展名要等 handler
 * 按【内容】跑完才知道(srt 输入双语输出是 .ass);而只比 `stem.lang` 又会误伤
 * `clip.zhh.srt` 这种。这是 scripts/cli.ts 的 collidingInput 守卫用了很久的同一判据。
 */
export const outputPrefix = (stem: string, lang: string): string => `${stem}.${lang}`;

/**
 * 名称是否形如 `<prefix>.<anything>` 或 `<prefix>_<anything>`。
 * 大小写不敏感(Windows/macOS 默认卷不区分;产出也常只在大小写上有别)。
 */
export const matchesOutputPrefix = (name: string, stem: string, lang: string): boolean => {
  const lower = name.toLowerCase();
  const prefix = outputPrefix(stem, lang).toLowerCase();
  return lower.startsWith(`${prefix}.`) || lower.startsWith(`${prefix}_`);
};

/**
 * outDir 里是否已经有本轮某个目标语言的产物。
 *
 * 给驱动的「已存在就跳过」闸用 —— 它只解决"要不要花钱重翻",不负责给出精确路径
 * (写出的路径仍由 handler 的 ext + bilingualSuffix 决定)。
 */
export const producedOutputExists = (outDir: string, stem: string, lang: string): boolean => {
  let entries: Dirent[];
  try {
    entries = readdirSync(outDir, { withFileTypes: true });
  } catch {
    return false; // 目录读不动 = 当作没有产物,让真正的写失败在下游如实报告
  }
  return entries.some((e) => e.isFile() && matchesOutputPrefix(e.name, stem, lang));
};
