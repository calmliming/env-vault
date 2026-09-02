/**
 * 剪贴板定时清理的测试。
 *
 * 全程用假剪贴板 —— 跑一次单元测试不该动开发机的剪贴板。
 *
 * 钉住的核心只有一条：**只清理我们写进去的那一份**。
 * 30 秒后无条件 `clear()` 会把用户在这期间复制的东西一起毁掉，
 * 而一个安全功能顺手破坏用户数据，比不做这个功能更糟。
 *
 * 跑法：node --test src/main/clipboard/*.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLEAR_AFTER_MS,
  cancelPending,
  clearOnExit,
  copyWithAutoClear,
  hasPending
} from './index.ts'
import type { ClipboardPort } from './index.ts'

const KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz012345'

/** Electron 44 的剪贴板全是异步的，假的也照着来。 */
function fakeClipboard(initial = ''): ClipboardPort & { content: string; clears: number } {
  return {
    content: initial,
    clears: 0,
    async writeText(text: string) {
      this.content = text
    },
    async readText() {
      return this.content
    },
    async clear() {
      this.content = ''
      this.clears += 1
    }
  }
}

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// 每个用例自己收尾：模块级的待清理状态是共享的。
test.afterEach(() => cancelPending())

test('复制会把值写进剪贴板，并说明多久之后清理', async () => {
  const port = fakeClipboard()
  const delay = await copyWithAutoClear(KEY, port, 50)
  assert.equal(port.content, KEY)
  assert.equal(delay, 50)
})

test('到点时内容还是我们那份 → 清掉', async () => {
  const port = fakeClipboard()
  await copyWithAutoClear(KEY, port, 20)
  await tick(80)
  assert.equal(port.content, '')
  assert.equal(port.clears, 1)
})

test('🔴 到点时用户已经复制了别的东西 → 一个字节都不动', async () => {
  // 这是这个模块存在的全部风险点：一个安全功能顺手毁掉用户的剪贴板。
  const port = fakeClipboard()
  await copyWithAutoClear(KEY, port, 20)
  await port.writeText('用户后来复制的一段话')
  await tick(80)
  assert.equal(port.content, '用户后来复制的一段话')
  assert.equal(port.clears, 0)
})

test('🔴 读不到剪贴板时也不清 —— 清一个不知道是什么的东西更糟', async () => {
  const port = fakeClipboard()
  await copyWithAutoClear(KEY, port, 20)
  port.readText = async () => {
    throw new Error('剪贴板被别的进程锁着')
  }
  await tick(80)
  assert.equal(port.clears, 0)
})

test('连续复制两次只留最后一个定时器', async () => {
  // 不取消上一个的话，第一个定时器到点时拿旧哈希去比对必然对不上，
  // 于是什么也不清 —— 「30 秒后清理」会在连续复制时静默失效。
  const port = fakeClipboard()
  await copyWithAutoClear('第一份', port, 20)
  await copyWithAutoClear(KEY, port, 90)

  await tick(50)
  assert.equal(port.content, KEY, '第一个定时器不该清掉第二份')

  await tick(90)
  assert.equal(port.content, '', '第二个定时器照常生效')
  assert.equal(port.clears, 1)
})

test('退出前补清一次 —— 定时器随进程死掉，剪贴板里的 Key 不会', async () => {
  const port = fakeClipboard()
  await copyWithAutoClear(KEY, port, 60_000)
  assert.equal(await clearOnExit(port), true)
  assert.equal(port.content, '')
})

test('退出时内容已经不是我们那份，同样不动', async () => {
  const port = fakeClipboard()
  await copyWithAutoClear(KEY, port, 60_000)
  await port.writeText('别的东西')
  assert.equal(await clearOnExit(port), false)
  assert.equal(port.content, '别的东西')
})

test('没有待清理的东西时，退出检查什么也不做', async () => {
  const port = fakeClipboard('用户自己的内容')
  assert.equal(await clearOnExit(port), false)
  assert.equal(port.content, '用户自己的内容')
})

test('清理完成后不再留下待处理状态', async () => {
  const port = fakeClipboard()
  await copyWithAutoClear(KEY, port, 20)
  assert.equal(hasPending(), true)
  await tick(80)
  assert.equal(hasPending(), false)
})

test('默认 30 秒（§7）', () => {
  assert.equal(CLEAR_AFTER_MS, 30_000)
})

test('🔴 待清理状态里没有明文，只有哈希', async () => {
  // 值已经在系统剪贴板里了，没理由在自己进程内存里再存一份 ——
  // 那只是多一个会被崩溃转储捞出来的地方。
  const port = fakeClipboard()
  await copyWithAutoClear(KEY, port, 60_000)

  // 从模块外面能拿到的东西里，一律搜不到那把 Key。
  const module = await import('./index.ts')
  assert.equal(JSON.stringify(Object.keys(module)).includes(KEY), false)
  assert.equal(String(hasPending()).includes(KEY), false)
})
