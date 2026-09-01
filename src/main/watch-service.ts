/**
 * 监听器的生命周期与推送。
 *
 * 单独于 `watch.ts`：那个文件是纯粹的「盯着这些路径，变了告诉我」，
 * 不认识数据库也不认识窗口。这里才负责把两头接上 ——
 * 从库里取要监听的文件，把事件推给所有窗口。
 *
 * 分开的实际好处是 `watch.ts` 可以被单独测试，不用先造一个数据库。
 */

import { BrowserWindow } from 'electron'
import { PUSH_CHANNELS, type FileChangedEvent } from '@shared/ipc'
import { listWatchTargets } from './db/repositories'
import { EnvFileWatcher } from './watch.ts'

const watcher = new EnvFileWatcher()
let started = false

/**
 * 重建监听集合。任何会改变「有哪些文件 / 它们的基准哈希」的操作之后都要调 ——
 * 导入、移除、重扫、以磁盘为准、以记录为准，五处。
 *
 * 漏掉其中任何一处的后果是**静默的**：监听器还活着，但拿旧哈希去比新文件，
 * 于是要么一直报差异，要么真变了却不报。
 */
export async function refreshWatchTargets(): Promise<void> {
  if (!started) return
  try {
    await watcher.watchFiles(listWatchTargets())
  } catch (error) {
    console.error('[watch] 重建监听失败', error)
  }
}

export async function startWatching(): Promise<void> {
  if (started) return
  started = true

  watcher.onChange((events) => broadcast(events))
  await refreshWatchTargets()
}

export async function stopWatching(): Promise<void> {
  started = false
  await watcher.stop()
}

function broadcast(events: FileChangedEvent[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    // 窗口正在关闭时 webContents 可能已经销毁，send 会抛。
    if (win.webContents.isDestroyed()) continue
    win.webContents.send(PUSH_CHANNELS.filesChanged, events)
  }
}
