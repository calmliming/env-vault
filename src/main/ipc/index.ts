/**
 * IPC 注册中心（开发计划 §3.2「IPC 命令校验」）。
 *
 * 三层把关，缺一不可：
 *   1. Preload 只为 CHANNEL_LIST 里的通道建桥 —— 渲染进程碰不到别的通道；
 *   2. 这里校验发送方，拒绝来自非本应用窗口的调用；
 *   3. 这里校验入参形状，再交给业务函数。
 *
 * 所有 handler 都返回 IpcResult 信封而不是抛异常：跨进程抛出去的 Error 会把
 * 主进程的堆栈和文件路径带到渲染层，而渲染层是加载页面内容的地方。
 */

import { BrowserWindow, app, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  CHANNELS,
  type ChannelName,
  type IpcErrorCode,
  type IpcRequest,
  type IpcResponse,
  type IpcResult,
  type SelectDirectoryRequest
} from '@shared/ipc'
import { getDatabaseInfo, initializeDatabase } from '../db'
import * as repo from '../db/repositories'
import { RepositoryError } from '../db/repositories'
import * as vault from '../security/vault'
import { VaultError } from '../security/vault'
import { refreshWatchTargets } from '../watch-service'

type Handler<C extends ChannelName> = (
  request: IpcRequest<C>,
  event: IpcMainInvokeEvent
) => IpcResponse<C> | Promise<IpcResponse<C>>

/**
 * 只接受来自本应用自己创建的窗口的主框架。
 * 页面里若被塞进 iframe（例如未来渲染某段第三方内容），子框架发的 invoke 会在这里被挡下。
 */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return false
  const frame = event.senderFrame
  return frame !== null && frame.parent === null
}

function fail(code: IpcErrorCode, message: string): IpcResult<never> {
  return { ok: false, code, message }
}

function toFailure(error: unknown): IpcResult<never> {
  if (error instanceof VaultError) return fail(error.code, error.message)
  if (error instanceof RepositoryError) return fail(error.code, error.message)
  // 不把原始 message 透出去：它可能包含内部路径或 SQL 片段。
  console.error('[ipc] 未处理的异常', error)
  return fail('INTERNAL', '操作失败，请查看应用日志')
}

function handle<C extends ChannelName>(channel: C, handler: Handler<C>): void {
  ipcMain.handle(channel, async (event, request: unknown): Promise<IpcResult<IpcResponse<C>>> => {
    if (!isTrustedSender(event)) {
      return fail('INVALID_ARGUMENT', '调用来源不受信任')
    }
    try {
      const data = await handler(request as IpcRequest<C>, event)
      return { ok: true, data }
    } catch (error) {
      return toFailure(error)
    }
  })
}

// ---------------------------------------------------------------------------
// 入参校验
// ---------------------------------------------------------------------------

function asSelectDirectoryRequest(input: unknown): SelectDirectoryRequest {
  if (input == null) return {}
  if (typeof input !== 'object') {
    throw new VaultError('INTERNAL', '参数格式不正确')
  }
  const title = (input as Record<string, unknown>).title
  if (title !== undefined && typeof title !== 'string') {
    throw new VaultError('INTERNAL', '参数 title 必须是字符串')
  }
  // 截断而不是拒绝：标题只影响系统对话框的显示，过长的值没必要让整个操作失败。
  return title === undefined ? {} : { title: title.slice(0, 120) }
}

function asRecord(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object') {
    throw new RepositoryError('INTERNAL', '参数格式不正确')
  }
  return input as Record<string, unknown>
}

function asPositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new RepositoryError('INTERNAL', `参数 ${field} 必须是正整数`)
  }
  return value
}

/**
 * 路径校验（§3.2「IPC 参数进行类型、路径和权限校验」）。
 *
 * 渲染层送来的路径最终会被拿去遍历磁盘，所以这里必须挡住三类输入：
 * 非字符串、空串、以及不存在或不是目录的路径。
 * 不做白名单限制 —— 计划 §5.2 明确要求「不要求位于同一个父目录」，
 * 用户本来就该能选任意目录。
 */
function asDirectoryPath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RepositoryError('INTERNAL', `参数 ${field} 必须是非空路径`)
  }
  const path = value.trim()
  if (!repo.directoryExists(path)) {
    throw new RepositoryError('PATH_REJECTED', '目录不存在或无法访问')
  }
  return path
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new RepositoryError('INTERNAL', `参数 ${field} 必须是数组`)
  }
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * 并发校验用的磁盘哈希。
 *
 * 长度写死 64 是因为它必须是一个 sha256 十六进制串。
 * 🔴 不接受空值、也不做「没传就跳过校验」—— 少了它守卫就形同虚设，
 * 宁可让调用失败。写盘的三条路径（写回、编辑、删除）用的是同一道关。
 */
function asFileHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new RepositoryError('INVALID_ARGUMENT', '缺少 expectedHash，无法做并发校验')
  }
  return value
}

/**
 * 变量的新值。`.env` 里放 PEM 私钥、JWT 都是正常的，所以上限给得宽，
 * 但不能不设 —— 渲染层送来的字符串会被原样写进用户的文件。
 */
const MAX_VALUE_BYTES = 64 * 1024

function asEntryValue(value: unknown): string {
  if (typeof value !== 'string') {
    throw new RepositoryError('INVALID_ARGUMENT', '参数 value 必须是字符串')
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
    throw new RepositoryError('INVALID_ARGUMENT', '值超过 64 KiB，请检查是否粘错了内容')
  }
  return value
}

// ---------------------------------------------------------------------------

export function registerIpcHandlers(): void {
  handle(CHANNELS.appHealth, () => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    chromeVersion: process.versions.chrome ?? 'unknown',
    nodeVersion: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    userDataPath: app.getPath('userData'),
    vault: vault.getStatus(),
    database: getDatabaseInfo()
  }))

  handle(CHANNELS.vaultStatus, () => vault.getStatus())
  handle(CHANNELS.vaultInitialize, () => vault.initialize())
  handle(CHANNELS.vaultUnlock, () => vault.unlock())
  handle(CHANNELS.vaultLock, () => vault.lock())

  handle(CHANNELS.dbInfo, () => {
    // 第一次调用时库可能还没打开（例如迁移被推迟到用户解锁之后）。
    initializeDatabase()
    return getDatabaseInfo()
  })

  handle(CHANNELS.dialogSelectDirectory, async (request, event) => {
    const { title } = asSelectDirectoryRequest(request)
    const win = BrowserWindow.fromWebContents(event.sender)

    // 挂在窗口上，让对话框成为模态子窗口；否则在 Windows 上它可能跑到主窗口后面。
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: title ?? '选择项目目录',
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({
          title: title ?? '选择项目目录',
          properties: ['openDirectory', 'createDirectory']
        })

    const picked = result.filePaths[0]
    return {
      canceled: result.canceled || picked === undefined,
      path: picked ?? null
    }
  })

  // --- 项目 -----------------------------------------------------------------

  handle(CHANNELS.projectsList, () => repo.listProjects())

  handle(CHANNELS.projectsPreview, (request) => {
    const body = asRecord(request)
    return repo.previewProject(asDirectoryPath(body.rootPath, 'rootPath'))
  })

  // 下面三个都会改变"有哪些文件、它们的基准哈希是什么"，
  // 所以每个都要重建监听集合。漏掉任何一个都会让监听静默失准。
  handle(CHANNELS.projectsImport, (request) => {
    const body = asRecord(request)
    const name = typeof body.name === 'string' ? body.name.slice(0, 120) : ''
    const project = repo.importProject({
      rootPath: asDirectoryPath(body.rootPath, 'rootPath'),
      name,
      includePaths: asStringArray(body.includePaths, 'includePaths')
    })
    void refreshWatchTargets()
    return project
  })

  handle(CHANNELS.projectsRemove, (request) => {
    const body = asRecord(request)
    const removed = repo.removeProject(asPositiveInt(body.projectId, 'projectId'))
    void refreshWatchTargets()
    return { removed }
  })

  handle(CHANNELS.projectsRescan, (request) => {
    const body = asRecord(request)
    const result = repo.rescanProject(asPositiveInt(body.projectId, 'projectId'))
    void refreshWatchTargets()
    return result
  })

  // --- 配置项与文件 ---------------------------------------------------------

  handle(CHANNELS.entriesList, (request) => {
    const body = asRecord(request)
    const environment =
      typeof body.environment === 'string' && body.environment !== '' ? body.environment : undefined
    return repo.listEntries({
      projectId: asPositiveInt(body.projectId, 'projectId'),
      ...(environment ? { environment } : {})
    })
  })

  handle(CHANNELS.entriesReveal, (request) => {
    const body = asRecord(request)
    return repo.revealEntry(asPositiveInt(body.entryId, 'entryId'))
  })

  // 编辑和删除都会写盘，所以它们也在「会改变监听基准」的那一组里。
  handle(CHANNELS.entriesUpdate, (request) => {
    const body = asRecord(request)
    const result = repo.updateEntryValue(
      asPositiveInt(body.entryId, 'entryId'),
      asEntryValue(body.value),
      asFileHash(body.expectedHash)
    )
    void refreshWatchTargets()
    return result
  })

  handle(CHANNELS.entriesDelete, (request) => {
    const body = asRecord(request)
    const result = repo.deleteEntry(
      asPositiveInt(body.entryId, 'entryId'),
      asFileHash(body.expectedHash)
    )
    void refreshWatchTargets()
    return result
  })

  handle(CHANNELS.filesList, (request) => {
    const body = asRecord(request)
    return repo.listFiles(asPositiveInt(body.projectId, 'projectId'))
  })

  handle(CHANNELS.filesDiff, (request) => {
    const body = asRecord(request)
    return repo.diffFile(asPositiveInt(body.fileId, 'fileId'))
  })

  handle(CHANNELS.filesAdopt, (request) => {
    const body = asRecord(request)
    const result = repo.adoptDiskFile(asPositiveInt(body.fileId, 'fileId'))
    // 哈希变了，监听器记的基准也要跟着变，否则下次变化会被判成"没变"。
    void refreshWatchTargets()
    return result
  })

  handle(CHANNELS.filesRestore, (request) => {
    const body = asRecord(request)
    const result = repo.restoreFileFromCentral(
      asPositiveInt(body.fileId, 'fileId'),
      asStringArray(body.keys, 'keys'),
      asFileHash(body.expectedHash)
    )
    void refreshWatchTargets()
    return result
  })

  handle(CHANNELS.activityList, (request) => {
    const body = asRecord(request ?? {})
    const limit = typeof body.limit === 'number' ? body.limit : 50
    return repo.listActivity(limit)
  })
}
