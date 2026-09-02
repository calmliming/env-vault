/**
 * 问 git 两个问题：**这些文件被跟踪了吗？被 .gitignore 覆盖了吗？**
 *
 * ## 为什么是问 git，而不是自己解析 .gitignore
 *
 * 自己实现忽略规则要处理否定模式、`**`、目录尾斜杠、嵌套的 `.gitignore`
 * 之间的优先级、`.git/info/exclude`、`core.excludesFile`……
 * 写错的后果不是漏报，是**假的安心**：告诉用户「这个文件已经被忽略了」
 * 而实际上没有。对一个安全检查功能来说，这是最坏的一种错。
 *
 * `git check-ignore -v` 直接给出权威答案，还顺带告诉你是**哪一条规则**命中的。
 *
 * ## 目录约定
 *
 * 和 `env/`、`providers/` 一样：import 带 `.ts` 后缀、不用 `@shared/*` 别名、
 * 不用构造函数参数属性 —— 解析和判定这两处真正容易写错的逻辑要能被
 * `node --test` 直接跑，而 `runner` 是注入的，所以测试里一个进程都不会起。
 */

import { relative, sep } from 'node:path'
import { gitRunner } from './run.ts'
import type { GitRunner } from './run.ts'

/**
 * git 的 `-z` 模式用 NUL 分隔字段。
 *
 * ⚠️ 写成转义而不是在源码里嵌一个真的 NUL 字节：裸 NUL 会让 git 和 grep
 * 把整个文件当成二进制，diff 和 code review 就都失效了。
 * `db/credentials.ts` 正是这么中招的，一直到阶段 3 收尾才发现。
 */
const NUL = '\u0000'

export interface PathStatus {
  /** 被 Git 跟踪（在索引里）。 */
  tracked: boolean
  /** 被忽略规则覆盖。 */
  ignored: boolean
  /** 命中的规则，形如 `.gitignore:3:.env*`。没命中是 null。 */
  ignoreRule: string | null
}

export interface InspectResult {
  /** 仓库相对路径（正斜杠）→ 状态。 */
  statuses: Map<string, PathStatus>
  /** 非 null 表示这次没问出来，`statuses` 是空的。 */
  unavailable: string | null
}

/**
 * 绝对路径 → 仓库相对路径，一律正斜杠。
 *
 * git 的输入输出永远用正斜杠，Windows 上也一样 ——
 * 不归一化的话，`ls-files` 回来的 `src/.env` 和我们手里的 `src\.env`
 * 会被当成两个不同的文件，于是**每一个文件都显示成未跟踪**。
 */
export function toRepoPath(gitRoot: string, absolutePath: string): string {
  return relative(gitRoot, absolutePath).split(sep).join('/')
}

/** `-z` 输出末尾那个 NUL 会切出一个空串，要丢掉。 */
function splitNul(stdout: string): string[] {
  return stdout.split(NUL).filter((part) => part !== '')
}

/** `git ls-files -z` 的输出：NUL 分隔的仓库相对路径。 */
export function parseLsFiles(stdout: string): Set<string> {
  return new Set(splitNul(stdout))
}

/**
 * `git check-ignore -z --verbose --stdin` 的输出。
 *
 * 🔴 **四个字段一组**：source、行号、pattern、pathname。
 * 按行拆是错的 —— `-z` 模式下压根没有换行符，而且 pattern 本身可以包含
 * 任何字符（`.gitignore` 里写一个带空格的模式完全合法）。必须按 4 个一组走。
 */
export function parseCheckIgnore(stdout: string): Map<string, string> {
  const fields = splitNul(stdout)
  const ignored = new Map<string, string>()
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const source = fields[i]!
    const line = fields[i + 1]!
    const pattern = fields[i + 2]!
    const path = fields[i + 3]!
    // source 为空表示规则来自命令行 --exclude，这里不会出现；留着兜底。
    ignored.set(path, source === '' ? pattern : `${source}:${line}:${pattern}`)
  }
  return ignored
}

/**
 * 一次问完所有路径。**两条命令，不是每个文件两条** ——
 * 每个文件起两个进程，一个中等项目就是几十次 fork。
 */
export async function inspectPaths(
  gitRoot: string,
  absolutePaths: string[],
  runner: GitRunner = gitRunner
): Promise<InspectResult> {
  const statuses = new Map<string, PathStatus>()
  if (absolutePaths.length === 0) return { statuses, unavailable: null }

  const repoPaths = absolutePaths.map((path) => toRepoPath(gitRoot, path))

  // `--` 之后仍然会解析 pathspec 魔法（开头的 `:` 会被当成修饰符），
  // 所以再套一层 `:(literal)`：告诉 git 后面是一个字面路径，不是模式。
  const tracked = await runner(
    ['ls-files', '-z', '--', ...repoPaths.map((path) => `:(literal)${path}`)],
    gitRoot,
    null
  )
  if (!tracked.ok || tracked.code !== 0) {
    return { statuses, unavailable: tracked.message ?? '无法读取 Git 跟踪状态' }
  }
  const trackedSet = parseLsFiles(tracked.stdout)

  /**
   * 🔴 `--no-index` 是这一整个功能能不能成立的关键，别"顺手"删掉。
   *
   * `git check-ignore` 默认**不会**把已跟踪的文件报成 ignored ——
   * 因为对 git 来说，已跟踪的文件本来就不受忽略规则管。
   * 而我们要问的恰恰是另一个问题：「这个文件写没写在 .gitignore 里」。
   * 少了这个开关，「已经在 .gitignore 里、但仍然被跟踪着」这个最该报出来的
   * 情况就永远检测不到 —— 它会安静地显示成「没有被忽略」。
   *
   * 路径走 stdin 而不是 argv：既躲开 ARG_MAX，也让以 `-` 开头的路径
   * 不可能被当成选项。
   */
  const ignoreResult = await runner(
    ['check-ignore', '-z', '--verbose', '--no-index', '--stdin'],
    gitRoot,
    repoPaths.map((path) => path + NUL).join('')
  )
  // 🔴 退出码 1 是「你问的这些一个都没被忽略」，是正常答案而不是失败。
  if (!ignoreResult.ok || (ignoreResult.code !== 0 && ignoreResult.code !== 1)) {
    return { statuses, unavailable: ignoreResult.message ?? '无法读取 .gitignore 规则' }
  }
  const ignoredMap = parseCheckIgnore(ignoreResult.stdout)

  for (const path of repoPaths) {
    statuses.set(path, {
      tracked: trackedSet.has(path),
      ignored: ignoredMap.has(path),
      ignoreRule: ignoredMap.get(path) ?? null
    })
  }
  return { statuses, unavailable: null }
}
