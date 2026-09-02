/**
 * CLI 参数解析（开发计划 §9 阶段 5「`envvault run -- <command>` 进程注入」）。
 *
 * ```
 * envvault run --project <名称或路径> --env <环境> -- <命令> [参数…]
 * ```
 *
 * ## 🔴 `--` 之后一律原样交给子命令
 *
 * 我们只解析 `--` 之前的部分。之后的东西**一个字都不碰** ——
 * 否则 `envvault run -- npm run dev --watch` 里的 `--watch` 会被我们抢走，
 * 而用户完全看不出发生了什么，只会觉得 npm 行为不对。
 *
 * ## 目录约定
 *
 * 和 `env/`、`providers/`、`git/`、`clipboard/index.ts` 一样：
 * import 带 `.ts` 后缀、不用 `@shared/*` 别名、不用构造函数参数属性 ——
 * 这一层要能被 `node --test` 直接跑，而它本来就是纯函数。
 */

/** 默认环境。和 `env/classify.ts` 里 `.env` 映射出来的那个保持一致。 */
export const DEFAULT_ENVIRONMENT = 'default'

export interface RunCommand {
  kind: 'run'
  /** 项目名或项目的绝对路径，二选一都接受。 */
  project: string
  environment: string
  /** 要执行的命令及其参数。`--` 之后的原样内容，至少一项。 */
  command: string[]
}

export interface HelpCommand {
  kind: 'help'
}

export type CliCommand = RunCommand | HelpCommand

export class CliUsageError extends Error {}

/** argv 里有没有 CLI 子命令。没有就走图形界面那条路。 */
export function looksLikeCli(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === 'run' || arg === '--help' || arg === '-h')
}

/**
 * 解析 `run` 子命令之后的参数。
 *
 * 入参是**已经去掉 Electron 自己那些参数**的部分 —— 由调用方负责切，
 * 因为「哪些属于 Electron」取决于打包与否（开发期 argv[1] 是应用目录，
 * 打包后不是），那是 `cli/index.ts` 的事，不该混进这个纯函数里。
 */
export function parseArgs(args: readonly string[]): CliCommand {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return { kind: 'help' }
  }
  if (args[0] !== 'run') {
    throw new CliUsageError(`未知的子命令「${args[0]}」。目前只支持 run。`)
  }

  const separator = args.indexOf('--')

  /*
    `envvault run --help` 也要给帮助。

    这一条是跑起来才发现的：错误提示里写着「用 envvault run --help 看用法」，
    而那条命令自己会报「缺少 -- 分隔符」—— 我们把用户指向了一条会失败的命令。

    只认**分隔符之前**的 --help：之后的属于子命令
    （`envvault run -p x -- npm --help` 要的是 npm 的帮助，不是我们的）。
  */
  const helpAt = args.findIndex((arg) => arg === '--help' || arg === '-h')
  if (helpAt > 0 && (separator === -1 || helpAt < separator)) {
    return { kind: 'help' }
  }
  if (separator === -1) {
    throw new CliUsageError(
      '缺少 `--` 分隔符。用法：envvault run --project <项目> --env <环境> -- <命令>'
    )
  }

  // 🔴 分隔符之后原样保留，不做任何解析。
  const command = args.slice(separator + 1)
  if (command.length === 0) {
    throw new CliUsageError('`--` 后面没有要执行的命令。')
  }

  let project = ''
  let environment = DEFAULT_ENVIRONMENT

  /**
   * 取一个参数的值。
   *
   * 🔴 值必须落在分隔符**之前**。否则 `--project -- ls` 会把 `--` 本身
   * 当成项目名 —— 而它是分隔符，命令反倒只剩 `ls`。这种错法不会报错，
   * 只会去找一个叫「--」的项目然后说找不到，用户完全摸不着头脑。
   */
  const valueAt = (index: number, flag: string): string => {
    if (index >= separator) throw new CliUsageError(`${flag} 后面要跟一个值。`)
    const value = args[index]!
    if (value === '') throw new CliUsageError(`${flag} 后面要跟一个值。`)
    return value
  }

  for (let i = 1; i < separator; i++) {
    const arg = args[i]!
    if (arg === '--project' || arg === '-p') {
      project = valueAt(++i, '--project')
      continue
    }
    if (arg === '--env' || arg === '-e') {
      environment = valueAt(++i, '--env')
      continue
    }
    throw new CliUsageError(`不认识的参数「${arg}」。要传给子命令的参数请放在 \`--\` 之后。`)
  }

  if (project === '') {
    throw new CliUsageError('缺少 --project。用 envvault run --help 看用法。')
  }

  return { kind: 'run', project, environment, command }
}

/**
 * 帮助文本。
 *
 * 🔴 最后那段关于环境变量可见性的话是**必须**的，不是客套：
 * 我们做到的是「不落盘明文」，不是「完全隔离」。把这两件事混为一谈，
 * 用户会在一台共享机器上做出错误的判断。
 */
export const HELP_TEXT = `EnvVault CLI

用法：
  envvault run --project <项目名或路径> [--env <环境>] -- <命令> [参数…]

示例：
  envvault run --project my-app --env local -- npm run dev
  envvault run -p D:\\code\\my-app -e production -- node server.js

说明：
  --project, -p   项目名，或项目的绝对路径
  --env, -e       环境名，默认 ${DEFAULT_ENVIRONMENT}
  --              这之后的内容原样作为要执行的命令，不会被 envvault 解析

配置值以环境变量的形式传给子进程，**不写任何临时文件**。
绑定到模型凭据的变量取凭据的当前值（凭据才是那把 Key 的真源），
所以它可能和项目里 .env 文件的内容不一致 —— 启动时会列出是哪几个。

⚠️ 环境变量在多数系统上对**同一用户的其它进程**可见
   （Linux 的 /proc/<pid>/environ、Windows 上的进程查看工具等）。
   「不落盘」和「完全隔离」是两件事，在共享机器上请据此判断。
`
