/**
 * 从一个父目录里发现多个项目（阶段 6）。
 *
 * ## 要解决的是一个正确性问题，不是省几次点击
 *
 * `projects.git_root` 一个项目只存**一个**，而 `db/security.ts` 拿它做全部
 * Git 判断。把 `~/code`（底下十几个仓库）当成一个项目纳管，会有两种坏结果：
 *
 *   1. `~/code` 不在任何仓库里 → gitRoot 为 null → 安全检查整页「查不了」。
 *      这个至少是**吵**的，按 PHASE-4A 的规矩 `unknown ≠ ok`。
 *   2. `~/code` 自己恰好也是个仓库 → 所有 `git ls-files` / `check-ignore`
 *      对着**外层**仓库问，而嵌套仓库里的文件在外层看来一律「未跟踪」。
 *      于是「已经提交了、后来才补进 .gitignore」那条 critical
 *      —— 这个工具最有价值的一条检测 —— **静默消失**。
 *
 * 第 2 种是这个模块存在的理由：它不报错，只是不报。
 *
 * ## 🔴 发现和扫描必须分两阶段
 *
 * 直觉写法是「深扫一遍再按 .git 归组」，但 `scanProject` 的限额是**按单项目**
 * 定的（maxDepth 6 / maxFiles 200）。一次深扫十几个仓库，深度预算会被父目录
 * 那一层吃掉，200 个文件也可能在扫到第 8 个仓库时就触顶 —— 而 `walk()` 是
 * **先文件后目录**，触顶时后面的仓库会被整个丢掉，用户只看到「少了几个」。
 *
 * 所以这里只找 `.git`、**不读任何文件**，然后让调用方对每个仓库根各自调用
 * `scanProject`，各自享用完整的预算。
 *
 * ⚠️ 这个模块要能被 `node --test` 直接跑（HANDOFF §5）：
 * import 必须带 `.ts` 后缀、不能用 `@shared/*` 别名、不能用构造函数参数属性。
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { SKIP_DIRECTORIES } from './scan.ts'

export interface DiscoveredProject {
  rootPath: string
  /** 目录名，拿来当默认项目名。 */
  name: string
  /**
   * 这个目录里有 `.git`。false 表示它不在任何仓库里 ——
   * 仍然可以纳管，但安全检查那一半会如实说「查不了」。
   */
  isGitRepo: boolean
}

export interface DiscoveryResult {
  projects: DiscoveredProject[]
  /** 触到深度或数量上限，没找全。 */
  truncated: boolean
  /**
   * 选中目录本身就是一个仓库（它也在 projects 里）。
   * 只用于界面措辞 —— 「你选的这个目录自己也是个仓库」。
   */
  startIsRepo: boolean
}

export interface DiscoverOptions {
  /** 相对选中目录往下找几层。默认 4：再深就不像是"放仓库的地方"了。 */
  maxDepth?: number
  /** 最多发现多少个项目，防止指着 `C:\` 时扫穿整块盘。 */
  maxProjects?: number
}

/**
 * 往下找仓库根。**遇到 `.git` 就把这一支收成一个项目，不再往下钻** ——
 * 再往里钻会把子模块的子模块也翻出来，而每一层都已经作为独立项目被收了。
 * 配合 `scanProject` 同样在嵌套仓库处停，一个文件只会属于一个项目。
 *
 * `.git` 在 worktree 和 submodule 里是**文件**不是目录，所以只判存在，
 * 和 `scan.ts` 的 `findGitRoot` 用同一条规则。
 */
export function discoverProjects(
  startPath: string,
  options: DiscoverOptions = {}
): DiscoveryResult {
  const maxDepth = options.maxDepth ?? 4
  const maxProjects = options.maxProjects ?? 50
  const start = resolve(startPath)

  const startIsRepo = existsSync(join(start, '.git'))
  const projects: DiscoveredProject[] = []
  let truncated = false

  // 选中目录本身是仓库时，它也算一个项目 —— 但**仍然往下找**。
  //
  // 早先的写法是「指着仓库就只给这一个」，看着更"听话"，但它让最常见的
  // 一种布局用不上这个功能：`~/code` 自己也 git init 过、底下放着十几个仓库。
  // 那时用户一个都批量不了，而这恰恰是那个「问错仓库」缺陷最容易发生的场景。
  if (startIsRepo) {
    projects.push({ rootPath: start, name: basename(start), isGitRepo: true })
  }

  const walk = (dir: string, depth: number): void => {
    if (projects.length >= maxProjects) {
      truncated = true
      return
    }
    if (depth > maxDepth) {
      truncated = true
      return
    }

    let dirents
    try {
      dirents = readdirSync(dir, { withFileTypes: true })
    } catch {
      // 权限不足或目录消失：跳过这一支，不让整次发现失败。
      return
    }

    for (const dirent of dirents) {
      // 不跟随符号链接：指回上层的链接会让遍历绕不出来。
      if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue
      if (SKIP_DIRECTORIES.has(dirent.name)) continue

      const child = join(dir, dirent.name)
      if (existsSync(join(child, '.git'))) {
        if (projects.length >= maxProjects) {
          truncated = true
          return
        }
        projects.push({ rootPath: child, name: dirent.name, isGitRepo: true })
        continue // 🔴 收成一个项目就不再往里钻
      }
      walk(child, depth + 1)
    }
  }

  walk(start, 0)

  // 一个仓库都没找到时，退回「就把选中目录当成一个项目」——
  // 那正是没有这个功能之前的行为，不该因为加了发现而丢掉。
  if (projects.length === 0) {
    return {
      projects: [{ rootPath: start, name: basename(start), isGitRepo: false }],
      truncated,
      startIsRepo: false
    }
  }

  return { projects, truncated, startIsRepo }
}
