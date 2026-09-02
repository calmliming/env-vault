/**
 * 系统剪贴板与定时清理（开发计划 §7「复制操作支持自动清理剪贴板，默认 30 秒」）。
 *
 * 单独一个目录，和 `net/`、`git/` 同一个用意：让「谁会碰系统剪贴板」
 * 有一个一句话的答案。
 *
 * ## 明文在这里少过一次桥
 *
 * 复制原本是渲染层先调 `revealCredential` 把**明文取到渲染进程**，
 * 再 `navigator.clipboard.writeText`。但主进程自己就能写剪贴板 ——
 * 挪过来之后，复制这条路上明文完全不进渲染层（HANDOFF §6 的边界图少一条线）。
 *
 * ## 🔴 只清理我们写进去的那一份
 *
 * 30 秒后直接 `clear()` 是个陷阱：用户很可能在这 30 秒里复制了别的东西
 * （一段代码、一个网址、另一个密码），那样会**把他的剪贴板毁掉**。
 * 一个安全功能顺手破坏用户数据，比不做这个功能更糟。
 *
 * 所以写入时记下值的哈希，到点先读回来比对，一致才清。
 *
 * ## 🔴 记哈希，不留明文副本
 *
 * 值已经躺在系统剪贴板里了，没有任何理由在自己进程的内存里再存一份 ——
 * 那只是多一个会被崩溃转储捞出来的地方。哈希足够回答「还是不是那一份」。
 *
 * ## 目录约定
 *
 * 这一层是纯的，只 import `node:crypto` —— 真正碰 Electron 剪贴板的是
 * 同目录的 `port.ts`，注入进来。所以判定逻辑能被 `node --test` 直接跑，
 * 而测试不会动开发机的剪贴板。
 * 和 `env/`、`providers/`、`git/` 一样：import 带 `.ts` 后缀、不用 `@shared/*` 别名。
 */

import { createHash } from 'node:crypto'

/** §7 的默认值。写死为常量的理由见 PHASE-4B。 */
export const CLEAR_AFTER_MS = 30_000

/**
 * 只用到 Electron `clipboard` 的这三个方法。
 * 抽成接口是为了让单元测试塞一个假的进来 —— 跑测试不该动开发机的剪贴板。
 *
 * ⚠️ 三个都是异步的：Electron 44 的 `clipboard` 已经没有同步版本了。
 * 这直接影响退出时的清理，见 `main/index.ts` 里 `before-quit` 的处理。
 */
export interface ClipboardPort {
  writeText(text: string): Promise<void>
  readText(): Promise<string>
  clear(): Promise<void>
}

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 待清理的那一份。
 * 🔴 只有哈希，没有值 —— 这个对象被整个打印出来也不会泄漏任何东西。
 */
interface Pending {
  digest: string
  timer: ReturnType<typeof setTimeout>
}

let pending: Pending | null = null

/**
 * 写入剪贴板并安排清理。返回「多久之后会清」，**不返回值本身**。
 *
 * 一次只跟踪一份：新的复制会取消上一个定时器。否则用户连着复制两次，
 * 第一个定时器到点时会拿着旧哈希去比对 —— 那当然对不上，于是什么也不清，
 * 而真正该清的那一份要等第二个定时器。行为上不算错，但会让
 * 「30 秒后清理」在连续复制时静默失效。
 */
export async function copyWithAutoClear(
  value: string,
  port: ClipboardPort,
  clearAfterMs: number = CLEAR_AFTER_MS
): Promise<number> {
  cancelPending()
  await port.writeText(value)

  const expected = digest(value)
  const timer = setTimeout(() => {
    pending = null
    void clearIfUnchanged(port, expected)
  }, clearAfterMs)
  // 定时器不该拖住进程退出：剪贴板的事没重要到值得让应用多活 30 秒。
  timer.unref?.()
  pending = { digest: expected, timer }

  return clearAfterMs
}

/**
 * 🔴 内容还是我们写进去的那一份才清。
 * 用户在这期间复制了别的东西，就一个字节都不动。
 */
async function clearIfUnchanged(port: ClipboardPort, expected: string): Promise<boolean> {
  let current: string
  try {
    current = await port.readText()
  } catch {
    // 读不到就不敢清 —— 清一个不知道是什么的剪贴板，比不清更糟。
    return false
  }
  if (digest(current) !== expected) return false
  try {
    await port.clear()
  } catch {
    return false
  }
  return true
}

/**
 * 应用退出前再检查一次。
 *
 * 定时器随进程一起死，而剪贴板里的 Key 不会 —— 用户复制完 5 秒就关掉应用的话，
 * 那把 Key 会一直留在剪贴板里。这里补上最后一次机会。
 *
 * ⚠️ 这是**异步**的，而 `before-quit` 不会等 Promise。
 * 调用方（`main/index.ts`）要负责把退出拦住一下，否则这个函数等于没调。
 */
export async function clearOnExit(port: ClipboardPort): Promise<boolean> {
  if (!pending) return false
  const expected = pending.digest
  cancelPending()
  return clearIfUnchanged(port, expected)
}

export function cancelPending(): void {
  if (!pending) return
  clearTimeout(pending.timer)
  pending = null
}

/** 现在有没有待清理的一份。退出路径靠它决定要不要拦一下。 */
export function hasPending(): boolean {
  return pending !== null
}
