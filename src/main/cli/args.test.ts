/**
 * CLI 参数解析的测试。
 *
 * 最要紧的一条：**`--` 之后的东西一个字都不许碰**。
 * 抢走 `npm run dev --watch` 里的 `--watch` 之后，用户看到的现象是
 * "npm 行为不对"，而完全想不到是这个包装器干的。
 *
 * 跑法：node --test src/main/cli/*.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CliUsageError, DEFAULT_ENVIRONMENT, HELP_TEXT, looksLikeCli, parseArgs } from './args.ts'
import type { RunCommand } from './args.ts'

const run = (args: string[]): RunCommand => parseArgs(args) as RunCommand

test('解析出项目、环境和命令', () => {
  const parsed = run(['run', '--project', 'my-app', '--env', 'local', '--', 'npm', 'run', 'dev'])
  assert.equal(parsed.kind, 'run')
  assert.equal(parsed.project, 'my-app')
  assert.equal(parsed.environment, 'local')
  assert.deepEqual(parsed.command, ['npm', 'run', 'dev'])
})

test('短参数 -p / -e 等价', () => {
  const parsed = run(['run', '-p', 'my-app', '-e', 'production', '--', 'node', 'server.js'])
  assert.equal(parsed.project, 'my-app')
  assert.equal(parsed.environment, 'production')
})

test(`没写 --env 时用默认环境 ${DEFAULT_ENVIRONMENT}`, () => {
  assert.equal(run(['run', '-p', 'x', '--', 'ls']).environment, DEFAULT_ENVIRONMENT)
})

// ---------------------------------------------------------------------------
// 🔴 `--` 之后原样保留
// ---------------------------------------------------------------------------

test('🔴 子命令自己的 --flag 不会被我们抢走', () => {
  const parsed = run(['run', '-p', 'x', '--', 'npm', 'run', 'dev', '--watch', '--port', '3000'])
  assert.deepEqual(parsed.command, ['npm', 'run', 'dev', '--watch', '--port', '3000'])
})

test('🔴 子命令里出现 --project 也照样原样传下去', () => {
  // 这是最容易写错的形状：只用 indexOf 找参数而不看位置的话，
  // 会把子命令的 --project 当成自己的。
  const parsed = run(['run', '-p', 'real', '--', 'my-tool', '--project', 'other'])
  assert.equal(parsed.project, 'real')
  assert.deepEqual(parsed.command, ['my-tool', '--project', 'other'])
})

test('子命令里再出现一个 `--` 也原样保留', () => {
  const parsed = run(['run', '-p', 'x', '--', 'npm', 'exec', '--', 'tsc'])
  assert.deepEqual(parsed.command, ['npm', 'exec', '--', 'tsc'])
})

test('带空格的参数原样保留', () => {
  const parsed = run(['run', '-p', 'x', '--', 'echo', 'hello world'])
  assert.deepEqual(parsed.command, ['echo', 'hello world'])
})

// ---------------------------------------------------------------------------
// 说不清楚就报错，不猜
// ---------------------------------------------------------------------------

test('缺 `--` 分隔符时报错，不把剩下的当命令', () => {
  assert.throws(() => parseArgs(['run', '-p', 'x', 'npm', 'run', 'dev']), CliUsageError)
})

test('`--` 后面没东西时报错', () => {
  assert.throws(() => parseArgs(['run', '-p', 'x', '--']), CliUsageError)
})

test('缺 --project 时报错', () => {
  assert.throws(() => parseArgs(['run', '--', 'ls']), CliUsageError)
})

test('--project 后面没值时报错', () => {
  assert.throws(() => parseArgs(['run', '--project', '--', 'ls']), CliUsageError)
})

test('不认识的参数报错，并提示放到 `--` 之后', () => {
  try {
    parseArgs(['run', '-p', 'x', '--verbose', '--', 'ls'])
    assert.fail('应该抛错')
  } catch (error) {
    assert.ok(error instanceof CliUsageError)
    assert.match(error.message, /`--` 之后/)
  }
})

test('未知子命令报错', () => {
  assert.throws(() => parseArgs(['deploy', '--', 'ls']), CliUsageError)
})

// ---------------------------------------------------------------------------
// 帮助与识别
// ---------------------------------------------------------------------------

test('无参数、--help、-h 都给帮助', () => {
  for (const args of [[], ['--help'], ['-h']]) {
    assert.equal(parseArgs(args).kind, 'help')
  }
})

test('🔴 `run --help` 也给帮助，不报「缺少 --」', () => {
  // 跑起来才发现的：错误提示里写着「用 envvault run --help 看用法」，
  // 而那条命令自己会报错 —— 我们把用户指向了一条会失败的命令。
  assert.equal(parseArgs(['run', '--help']).kind, 'help')
  assert.equal(parseArgs(['run', '-p', 'x', '--help']).kind, 'help')
})

test('但 `--` 之后的 --help 属于子命令，不归我们', () => {
  // `envvault run -p x -- npm --help` 要的是 npm 的帮助。
  const parsed = run(['run', '-p', 'x', '--', 'npm', '--help'])
  assert.equal(parsed.kind, 'run')
  assert.deepEqual(parsed.command, ['npm', '--help'])
})

test('argv 里有 run 或 --help 才算 CLI 调用', () => {
  assert.equal(looksLikeCli(['electron', '.', 'run', '--', 'ls']), true)
  assert.equal(looksLikeCli(['electron', '.', '--help']), true)
  // 图形界面正常启动时不该被误判成 CLI。
  assert.equal(looksLikeCli(['electron', '.']), false)
  assert.equal(looksLikeCli(['electron', '.', '--user-data-dir=/tmp/x']), false)
})

test('🔴 帮助文本如实说明环境变量对同用户的其它进程可见', () => {
  // 我们做到的是「不落盘明文」，不是「完全隔离」。
  // 把这两件事混为一谈，用户会在共享机器上做出错误判断。
  assert.match(HELP_TEXT, /不写任何临时文件/)
  assert.match(HELP_TEXT, /同一用户的其它进程/)
  assert.match(HELP_TEXT, /「不落盘」和「完全隔离」是两件事/)
})

test('帮助文本说明了绑定变量取凭据的值', () => {
  assert.match(HELP_TEXT, /凭据的当前值/)
})
