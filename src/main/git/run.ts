/**
 * 起 git 子进程。**全应用唯一会执行外部程序的地方**（第二个外部边界，
 * 第一个是 `net/transport.ts` 的出站请求）。
 *
 * 单独一个文件、单独一个目录，和 `net/` 是同一个用意：让「这个应用会执行
 * 什么外部程序」有一个一句话的答案。
 *
 * ## 🔴 为什么必须是 execFile 而不是 exec
 *
 * `exec` 把命令交给 shell 解析，于是路径里的空格、`&`、`;`、反引号
 * 全都变成语法。我们要传的是**用户项目里的文件路径** —— 那是用户能控制的内容。
 * `execFile` 直接 execve，参数数组原样传给程序，shell 从头到尾没参与。
 *
 * ## 🔴 为什么固定加 `-c core.fsmonitor=`
 *
 * git 会读**仓库本地**的 `.git/config`，而 `core.fsmonitor` 的值是一条
 * 会被 git 执行的命令。也就是说，在一个来路不明的仓库里跑任何 git 命令
 * 都可能执行仓库作者写的代码 —— 这是有记录的 RCE 向量。
 * 而这个应用恰恰是在**用户选的任意目录**里跑 git。
 * 命令行上的 `-c` 优先级压过仓库配置，堵掉它成本为零。
 *
 * 同理加 `--no-optional-locks`：这是一次只读检查，不该往用户的仓库里
 * 写任何东西（`git status` 之类默认会顺手刷新索引）。
 */

import { execFile } from 'node:child_process'

/** 结果里刻意没有 stderr —— 它可能包含仓库路径，而调用方只需要知道成没成。 */
export interface GitOutput {
  /** 进程正常起来并退出了（**不管退出码是几**）。 */
  ok: boolean
  /**
   * 退出码。起不来时是 null。
   *
   * 🔴 非 0 不一定是错：`git check-ignore` 用退出码 1 表示
   * 「你问的这些路径一个都没被忽略」，那是一个完全正常的答案。
   * 所以这一层不替调用方判断成败，只如实报出来。
   */
  code: number | null
  stdout: string
  /**
   * 进程起不来时给一句能展示给用户的话。
   * 🔴 由这一层自己构造，不透传 git 的 stderr 或原始异常。
   */
  message: string | null
}

export type GitRunner = (
  args: string[],
  cwd: string,
  stdin: string | null
) => Promise<GitOutput>

/** 5 秒。一个只读的 ls-files 要是这么久还没回来，那就是有别的问题了。 */
const TIMEOUT_MS = 5_000

/** 8 MiB。超大仓库的 ls-files 输出可能很长，但我们只问了几个路径。 */
const MAX_BUFFER = 8 * 1024 * 1024

/**
 * 每次调用都强制带上的参数。
 * 放在最前面 —— `-c` 必须出现在子命令之前，git 才认。
 */
const HARDENING = ['-c', 'core.fsmonitor=', '--no-optional-locks']

export const gitRunner: GitRunner = (args, cwd, stdin) =>
  new Promise<GitOutput>((resolve) => {
    const child = execFile(
      'git',
      [...HARDENING, ...args],
      {
        cwd,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8'
      },
      (error, stdout) => {
        if (!error) {
          resolve({ ok: true, code: 0, stdout, message: null })
          return
        }

        // 进程起来了、只是退出码非 0：如实报出去，由调用方判断那算不算失败。
        // （check-ignore 的 1 就是一个正常答案。）
        const exitCode = typeof error.code === 'number' ? error.code : null
        if (exitCode !== null) {
          resolve({ ok: true, code: exitCode, stdout, message: null })
          return
        }

        // 🔴 不透传 error.message：它带着仓库路径和命令行。
        // ENOENT 是「机器上没有 git」，其余（超时、杀进程）归到「这次没问出来」。
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
        resolve({
          ok: false,
          code: null,
          stdout: '',
          message: missing
            ? '这台机器上找不到 git，无法检查跟踪状态'
            : 'git 命令没有正常返回，这次检查没有结论'
        })
      }
    )

    // check-ignore 的路径走 stdin。写失败（比如 git 已经退出）不额外处理 ——
    // 上面的回调会以失败收场，结论一样。
    if (stdin !== null) {
      child.stdin?.on('error', () => {
        /* 由回调统一收敛成失败 */
      })
      child.stdin?.end(stdin)
    }
  })
