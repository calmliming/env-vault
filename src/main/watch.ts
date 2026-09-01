/**
 * `.env*` 文件监听（开发计划 §3.1、§6.4）。
 *
 * ## 为什么监听目录而不是文件
 *
 * 编辑器保存文件普遍是「写临时文件 → rename 覆盖」。直接监听文件路径的话，
 * rename 之后原来的 inode/句柄就失效了，监听器会**静默失效** ——
 * 第一次保存能收到事件，之后再改就再也收不到，而且不报任何错。
 * 监听**父目录**、按文件名过滤则不受影响。
 *
 * ## 为什么要去抖
 *
 * 一次保存常常触发多个事件（unlink + add，或者 change 连发几次）。
 * 不去抖的话每次保存会给渲染层推好几条通知，界面上就是闪几下。
 *
 * ## 这一层不做决策
 *
 * 它只回答「磁盘上这个文件现在的哈希是什么」，然后把事件抛出去。
 * 要不要覆盖、导入哪一边，全部交给用户（§6.4：任何外部修改在用户确认前
 * 都不能被覆盖）。所以这里既不写库也不写盘。
 */

import { watch, type FSWatcher } from 'chokidar'
import { dirname, resolve } from 'node:path'
import { hashFile } from './env/write.ts'

export interface WatchedFile {
  id: number
  absolutePath: string
  /** 入库时记下的哈希，用来判断是否 drifted。 */
  storedHash: string | null
}

export interface FileChangeEvent {
  fileId: number
  absolutePath: string
  /** 磁盘当前哈希；null 表示文件已消失。 */
  currentHash: string | null
  /** 与入库时不一致，或文件已消失。 */
  drifted: boolean
}

type ChangeHandler = (events: FileChangeEvent[]) => void

const DEBOUNCE_MS = 300

export class EnvFileWatcher {
  #watcher: FSWatcher | null = null
  /** 归一化路径 → 被监听的文件。Windows 上大小写不敏感，所以 key 统一小写。 */
  #files = new Map<string, WatchedFile>()
  #pending = new Set<string>()
  #timer: ReturnType<typeof setTimeout> | null = null
  #handler: ChangeHandler | null = null

  onChange(handler: ChangeHandler): void {
    this.#handler = handler
  }

  /**
   * 换一批要监听的文件。项目导入/移除/重扫之后调用。
   * 整个重建而不是增量增删：文件数量是几十的量级，重建的开销远小于
   * 维护增量逻辑带来的出错面。
   */
  async watchFiles(files: readonly WatchedFile[]): Promise<void> {
    await this.stop()

    this.#files = new Map(files.map((file) => [normalize(file.absolutePath), file]))
    if (this.#files.size === 0) return

    const directories = [...new Set(files.map((file) => dirname(resolve(file.absolutePath))))]

    this.#watcher = watch(directories, {
      // 只看目录里直接放着的文件，不递归 —— 我们要监听的路径都是已知的。
      depth: 0,
      // 启动时的 add 事件是"发现已有文件"，不是变化，收了只会开机就误报。
      ignoreInitial: true,
      // 等文件大小稳定再报，避开编辑器写到一半的中间态。
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
    })

    this.#watcher.on('all', (_event, changedPath) => {
      const key = normalize(changedPath)
      if (!this.#files.has(key)) return // 同目录下的其它文件与我们无关
      this.#pending.add(key)
      this.#schedule()
    })

    // chokidar 的错误不该让主进程崩掉：监听失败最多是少一条自动提醒，
    // 用户手动点「重新扫描」仍然能拿到正确结果。
    this.#watcher.on('error', (error) => {
      console.error('[watch] 监听出错', error)
    })
  }

  async stop(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    this.#pending.clear()
    const watcher = this.#watcher
    this.#watcher = null
    if (watcher) await watcher.close()
  }

  #schedule(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#flush()
    }, DEBOUNCE_MS)
  }

  #flush(): void {
    const keys = [...this.#pending]
    this.#pending.clear()
    if (keys.length === 0 || !this.#handler) return

    const events: FileChangeEvent[] = []
    for (const key of keys) {
      const file = this.#files.get(key)
      if (!file) continue
      const currentHash = hashFile(file.absolutePath)
      events.push({
        fileId: file.id,
        absolutePath: file.absolutePath,
        currentHash,
        drifted: currentHash === null || currentHash !== file.storedHash
      })
    }

    if (events.length > 0) this.#handler(events)
  }
}

function normalize(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
