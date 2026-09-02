/**
 * CLI 注入（开发计划 §9 阶段 5，验收句：
 * 「CLI 注入模式可以在不落盘明文 Key 的情况下启动本地开发命令」）。
 *
 * 这是应用**第一次把 Key 交给别的程序** —— 第四个外部边界
 * （前三个是出站流量 `net/`、执行外部程序 `git/`、系统剪贴板 `clipboard/`）。
 *
 * ## 🔴 不落盘
 *
 * 值只经 `spawn` 的 `env` 传给子进程。没有临时文件、没有 `.env` 副本、
 * 不写任何东西到磁盘上。验收里有一条断言在 CLI 跑完之后扫沙箱和系统临时目录
 * 的字节，确认那把 Key 一个字节都没落下。
 *
 * ## 🔴 「不落盘」不等于「完全隔离」
 *
 * 环境变量在多数系统上对**同一用户的其它进程**可见
 * （Linux 的 `/proc/<pid>/environ`、Windows 上的进程查看工具）。
 * 帮助文本里写明白了这一点，不能顺势宣称成隔离 —— 那是两件事。
 *
 * ## 为什么必须跑在 Electron 里
 *
 * 主密钥是用 Electron 的 `safeStorage` 封的（`security/keystore.ts`），
 * 纯 Node 进程解不开。所以 CLI 是同一个应用的另一种启动模式，
 * 而不是一个独立的 node 脚本。
 */

import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { delimiter, join } from 'node:path'
import { CliUsageError, HELP_TEXT, parseArgs } from './args.ts'
import type { RunCommand } from './args.ts'
import { closeDatabase, initializeDatabase } from '../db'
import { findProject, resolveEnvironment } from '../db/inject'
import type { ResolvedEnvironment } from '../db/inject'
import * as vault from '../security/vault'

/**
 * 从完整的 argv 里切出属于我们的部分。
 *
 * 开发期是 `electron . run …`（argv[1] 是应用目录），打包后是
 * `EnvVault.exe run …`（没有那个目录参数）。用 `app.isPackaged` 判断，
 * 再把 Electron 自己的开关（`--user-data-dir=…` 之类）滤掉。
 */
export function cliArgsFrom(argv: readonly string[]): string[] {
  const rest = argv.slice(app.isPackaged ? 1 : 2)
  return rest.filter((arg) => !arg.startsWith('--user-data-dir') && !arg.startsWith('--remote-'))
}

/** 🔴 所有自己的输出都走 stderr，别污染子进程的 stdout。 */
function note(message: string): void {
  process.stderr.write(`${message}\n`)
}

/**
 * 把「哪些变量来自凭据、其中哪些和文件不一致」说清楚。
 * 🔴 只列变量名，一个值都不打印。
 */
function reportSources(resolved: ResolvedEnvironment): void {
  const injected = resolved.variables.filter((v) => resolved.values.has(v.key))
  note(
    `EnvVault：向 ${resolved.projectName} / ${resolved.environment} 注入 ${injected.length} 个变量`
  )

  const fromCredential = injected.filter((v) => v.fromCredential)
  if (fromCredential.length > 0) {
    note(`  来自模型凭据：${fromCredential.map((v) => v.key).join('、')}`)
  }

  // 凭据轮换过但还没同步回文件时，注入的值和文件里的不一样。
  // 不说一声的话，用户会对着 .env 百思不得其解。
  const drifted = fromCredential.filter((v) => v.differsFromFile)
  if (drifted.length > 0) {
    note(
      `  ⚠️ 这些变量的凭据值与项目文件不一致（凭据是真源，注入的是凭据的值）：${drifted
        .map((v) => v.key)
        .join('、')}`
    )
  }

  const skipped = resolved.variables.filter((v) => !resolved.values.has(v.key))
  if (skipped.length > 0) {
    note(`  未注入：${skipped.map((v) => `${v.key}（${v.credentialName ?? '未知原因'}）`).join('、')}`)
  }
}

/**
 * Windows 上把命令解析成「真正要起的可执行文件 + 参数」。
 *
 * 起因是一个不能接受的取舍：`npm` / `pnpm` 在 Windows 上是 `.cmd` 脚本，
 * `spawn` 不开 shell 起不来（Node 18.20+ 起还因为 CVE-2024-27980 明确拒绝）；
 * 但一旦开了 shell，cmd.exe 会**重新解析**所有参数，
 * `node -e "if (a) …"` 里的引号和括号就被搅乱了 —— 静默地。
 *
 * 折中办法：只在命令确实是 `.cmd` / `.bat` 时，显式起 `cmd.exe /d /s /c`，
 * 参数照旧逐个传给 spawn（不拼命令行）。其余情况（`node`、任何 `.exe`、
 * 以及所有非 Windows 平台）完全不经过 shell，参数原样送达。
 *
 * 已知边界：传给 `.cmd` 的参数里如果嵌了双引号，cmd 的引号规则和
 * Node 的转义规则对不齐，仍可能走样。真遇到时用 `--` 后面直接写
 * `cmd /c ...` 自己控制。这条写进 PHASE-5A 了。
 */
function resolveExecutable(command: readonly string[]): [string, string[]] {
  const [executable, ...args] = command
  if (process.platform !== 'win32') return [executable!, args]

  const resolved = findOnPath(executable!)
  if (resolved === null || !/\.(cmd|bat)$/i.test(resolved)) return [executable!, args]

  const comspec = process.env.ComSpec || 'cmd.exe'
  // /d 跳过 AutoRun 注册表项（别让用户机器上的 AutoRun 掺进来）；
  // /s /c 是给 /c 传命令时的标准组合。
  return [comspec, ['/d', '/s', '/c', resolved, ...args]]
}

/** 按 PATH + PATHEXT 找出命令对应的真实文件。找不到返回 null。 */
function findOnPath(executable: string): string | null {
  if (executable.includes('/') || executable.includes('\\')) {
    return existsSync(executable) ? executable : null
  }
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of ['', ...extensions]) {
      const candidate = join(dir, executable + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * 起子进程，把注入后的环境交给它，等它结束。
 *
 * 🔴 退出码原样传出去。吞掉退出码的包装器在脚本和 CI 里没法用 ——
 * 那时候「命令失败了」和「命令成功了」在调用方眼里长得一模一样。
 */
function runChild(command: readonly string[], values: ReadonlyMap<string, string>): Promise<number> {
  const env = { ...process.env }
  for (const [key, value] of values) env[key] = value
  const [executable, args] = resolveExecutable(command)

  return new Promise<number>((resolve) => {
    // 🔴 一律不开 shell。开了的话 cmd.exe 会**重新解析**参数，
    // `node -e "if (a) …"` 里的引号和括号会被搅乱 —— 而且是静默的，
    // 用户只会觉得"我的脚本怎么突然语法错误了"。
    // Windows 上的 .cmd（npm / pnpm 之类）由 resolveExecutable 换成
    // 显式的 cmd.exe /d /s /c，参数仍然逐个传，不拼命令行。
    const child = spawn(executable, args, { env, stdio: 'inherit' })

    // 转发信号：父进程先死会把子进程变成孤儿，用户按了 Ctrl+C
    // 却发现 dev server 还在后台跑着。
    const forward = (signal: NodeJS.Signals) => (): void => {
      if (!child.killed) child.kill(signal)
    }
    const onInt = forward('SIGINT')
    const onTerm = forward('SIGTERM')
    process.on('SIGINT', onInt)
    process.on('SIGTERM', onTerm)

    const finish = (code: number): void => {
      process.off('SIGINT', onInt)
      process.off('SIGTERM', onTerm)
      resolve(code)
    }

    child.on('error', (error) => {
      note(`EnvVault：无法启动「${executable}」—— ${error.message}`)
      finish(127) // 约定俗成的「命令找不到」
    })
    // 被信号杀死时没有退出码，按 shell 的惯例折算成 128+signal。
    child.on('exit', (code, signal) =>
      finish(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1))
    )
  })
}

async function runInjection(request: RunCommand): Promise<number> {
  initializeDatabase()
  vault.unlock()

  const project = findProject(request.project)
  const resolved = resolveEnvironment(project.id, request.environment)
  reportSources(resolved)

  return runChild(request.command, resolved.values)
}

/**
 * CLI 入口。返回进程退出码。
 *
 * 调用方（`main/index.ts`）必须在**取单实例锁之前**分支到这里：
 * 用户开着图形界面再跑 `envvault run` 是最正常的用法，
 * 被单实例锁挡下来的表现是「命令莫名其妙什么也没做就退出了」。
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  try {
    const parsed = parseArgs(cliArgsFrom(argv))
    if (parsed.kind === 'help') {
      process.stderr.write(HELP_TEXT)
      return 0
    }
    return await runInjection(parsed)
  } catch (error) {
    // 🔴 只打印我们自己构造的消息。RepositoryError / VaultError 的 message
    // 是给人看的，其余异常一律给一句通用的 —— 原始异常里可能带着路径和 SQL。
    if (error instanceof CliUsageError) {
      note(`EnvVault：${error.message}`)
      note('用 envvault run --help 看用法。')
      return 2
    }
    const message =
      error instanceof Error && error.name.endsWith('Error') && 'code' in error
        ? error.message
        : '执行失败，请在图形界面里检查项目与 Vault 状态。'
    note(`EnvVault：${message}`)
    return 1
  } finally {
    try {
      closeDatabase()
    } catch {
      /* 关库失败不该盖掉子进程的退出码 */
    }
  }
}

/** 跑完就退出，不开窗、不注册 IPC、不启动文件监听。 */
export async function runCliAndExit(argv: readonly string[]): Promise<void> {
  const code = await runCli(argv)
  app.exit(code)
}
