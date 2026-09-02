/**
 * git 输出解析与调用约定的测试。
 *
 * 全程用假 runner，**一个子进程都不会起** —— 所以这些用例在没装 git 的
 * 机器上也跑得动，而且跑得飞快。
 *
 * 钉住的是三件事：
 *   1. `-z` 输出的解析（check-ignore 是四个一组，不是按行）；
 *   2. 退出码 1 是「一个都没被忽略」这个正常答案，不是失败；
 *   3. 传给 git 的参数形状 —— `--no-index`、`:(literal)`、路径走 stdin。
 *      这三个都不是可选的讲究，理由见 inspect.ts 里的注释。
 *
 * 跑法：node --test src/main/git/*.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspectPaths, parseCheckIgnore, parseLsFiles, toRepoPath } from './inspect.ts'
import type { GitRunner } from './run.ts'

/** 源码里不嵌裸 NUL（会让文件被当成二进制），用构造的方式拿。 */
const NUL = String.fromCharCode(0)
const nul = (...parts: string[]): string => parts.map((part) => part + NUL).join('')

const ROOT = process.platform === 'win32' ? 'D:\\repo' : '/repo'
const abs = (name: string): string =>
  process.platform === 'win32' ? `D:\\repo\\${name.split('/').join('\\')}` : `/repo/${name}`

/** 记下每次调用，并按顺序回放预置的输出。 */
function fakeRunner(
  outputs: { code: number; stdout: string }[]
): { runner: GitRunner; calls: { args: string[]; cwd: string; stdin: string | null }[] } {
  const calls: { args: string[]; cwd: string; stdin: string | null }[] = []
  let index = 0
  const runner: GitRunner = async (args, cwd, stdin) => {
    calls.push({ args, cwd, stdin })
    const next = outputs[index++] ?? { code: 0, stdout: '' }
    return { ok: true, code: next.code, stdout: next.stdout, message: null }
  }
  return { runner, calls }
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

test('ls-files 的 NUL 分隔输出，末尾空串要丢掉', () => {
  assert.deepEqual([...parseLsFiles(nul('.env', 'src/.env.local'))], ['.env', 'src/.env.local'])
  assert.equal(parseLsFiles('').size, 0)
})

test('check-ignore 按四个字段一组解析', () => {
  const stdout = nul('.gitignore', '3', '.env*', '.env', '.gitignore', '7', '*.local', 'a.local')
  const ignored = parseCheckIgnore(stdout)
  assert.equal(ignored.get('.env'), '.gitignore:3:.env*')
  assert.equal(ignored.get('a.local'), '.gitignore:7:*.local')
})

test('🔴 pattern 里有空格也不会把分组冲乱（这就是不能按行拆的原因）', () => {
  // .gitignore 里写一个带空格的模式完全合法。按行或按空格拆都会在这里散架。
  const stdout = nul('.gitignore', '2', 'my secret.env', 'my secret.env')
  const ignored = parseCheckIgnore(stdout)
  assert.equal(ignored.get('my secret.env'), '.gitignore:2:my secret.env')
})

test('不完整的尾组被丢掉，不产生半条记录', () => {
  const stdout = nul('.gitignore', '3', '.env*', '.env', '.gitignore', '9')
  assert.equal(parseCheckIgnore(stdout).size, 1)
})

test('🔴 仓库相对路径一律正斜杠', () => {
  // Windows 上不归一化的话，ls-files 回来的 src/.env 和我们手里的 src\.env
  // 对不上，于是每个文件都会显示成未跟踪。
  assert.equal(toRepoPath(ROOT, abs('src/.env')), 'src/.env')
  assert.equal(toRepoPath(ROOT, abs('.env')), '.env')
})

// ---------------------------------------------------------------------------
// 调用约定
// ---------------------------------------------------------------------------

test('🔴 check-ignore 必须带 --no-index', async () => {
  // 少了它，「已在 .gitignore 里但仍被跟踪」就永远检测不到 ——
  // git 默认不把已跟踪的文件报成 ignored。整个功能最有价值的一条会静默失效。
  const { runner, calls } = fakeRunner([{ code: 0, stdout: '' }, { code: 1, stdout: '' }])
  await inspectPaths(ROOT, [abs('.env')], runner)
  assert.equal(calls[1]?.args.includes('--no-index'), true, calls[1]?.args.join(' '))
})

test('🔴 路径走 stdin，不进 argv', async () => {
  // 以 `-` 开头的文件名进了 argv 就会被 git 当成选项。
  const { runner, calls } = fakeRunner([{ code: 0, stdout: '' }, { code: 1, stdout: '' }])
  await inspectPaths(ROOT, [abs('-weird.env')], runner)
  assert.equal(calls[1]?.stdin, `-weird.env${NUL}`)
  assert.equal(
    calls[1]?.args.some((arg) => arg.includes('weird')),
    false
  )
})

test('ls-files 的路径加了 :(literal) 前缀', async () => {
  const { runner, calls } = fakeRunner([{ code: 0, stdout: '' }, { code: 1, stdout: '' }])
  await inspectPaths(ROOT, [abs('.env')], runner)
  assert.equal(calls[0]?.args.includes(':(literal).env'), true, calls[0]?.args.join(' '))
})

test('两条命令，不是每个文件两条', async () => {
  const { runner, calls } = fakeRunner([{ code: 0, stdout: '' }, { code: 1, stdout: '' }])
  await inspectPaths(ROOT, [abs('.env'), abs('.env.local'), abs('src/.env')], runner)
  assert.equal(calls.length, 2)
})

test('没有路径要问时一条命令都不发', async () => {
  const { runner, calls } = fakeRunner([])
  const result = await inspectPaths(ROOT, [], runner)
  assert.equal(calls.length, 0)
  assert.equal(result.unavailable, null)
})

// ---------------------------------------------------------------------------
// 结果合并
// ---------------------------------------------------------------------------

test('把跟踪状态和忽略规则合到一起', async () => {
  const { runner } = fakeRunner([
    { code: 0, stdout: nul('.env', '.env.example') },
    { code: 0, stdout: nul('.gitignore', '3', '.env*', '.env') }
  ])
  const { statuses } = await inspectPaths(
    ROOT,
    [abs('.env'), abs('.env.example'), abs('.env.local')],
    runner
  )

  // 🔴 既被跟踪又被忽略 —— 这条链路能把它带出来，才有后面的风险判定。
  assert.deepEqual(statuses.get('.env'), {
    tracked: true,
    ignored: true,
    ignoreRule: '.gitignore:3:.env*'
  })
  assert.deepEqual(statuses.get('.env.example'), {
    tracked: true,
    ignored: false,
    ignoreRule: null
  })
  assert.deepEqual(statuses.get('.env.local'), {
    tracked: false,
    ignored: false,
    ignoreRule: null
  })
})

test('🔴 check-ignore 退出码 1 是「一个都没忽略」，不是失败', async () => {
  // 把它当成失败的话，一个没有 .gitignore 的项目会整页显示「查不了」，
  // 而真实结论恰恰是「什么都没被忽略」—— 最该报警的那种项目。
  const { runner } = fakeRunner([{ code: 0, stdout: nul('.env') }, { code: 1, stdout: '' }])
  const result = await inspectPaths(ROOT, [abs('.env')], runner)
  assert.equal(result.unavailable, null)
  assert.equal(result.statuses.get('.env')?.tracked, true)
  assert.equal(result.statuses.get('.env')?.ignored, false)
})

test('git 起不来时如实报不可用，且不留半份结果', async () => {
  const runner: GitRunner = async () => ({
    ok: false,
    code: null,
    stdout: '',
    message: '这台机器上找不到 git，无法检查跟踪状态'
  })
  const result = await inspectPaths(ROOT, [abs('.env')], runner)
  assert.match(result.unavailable ?? '', /找不到 git/)
  assert.equal(result.statuses.size, 0)
})

test('ls-files 异常退出也算不可用（128 是 git 的致命错误）', async () => {
  const { runner } = fakeRunner([{ code: 128, stdout: '' }])
  const result = await inspectPaths(ROOT, [abs('.env')], runner)
  assert.notEqual(result.unavailable, null)
  assert.equal(result.statuses.size, 0)
})
