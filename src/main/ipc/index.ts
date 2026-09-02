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
import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import {
  CHANNELS,
  type ChannelName,
  type CredentialStatus,
  type IpcErrorCode,
  type IpcRequest,
  type IpcResponse,
  type IpcResult,
  type SelectDirectoryRequest
} from '@shared/ipc'
import { getDatabaseInfo, initializeDatabase } from '../db'
import * as repo from '../db/repositories'
import * as credentials from '../db/credentials'
import * as security from '../db/security'
import * as template from '../db/template'
import * as transfer from '../db/transfer'
import { PackageError, inspectPackage, openPackage, sealPackage } from '../transfer/package.ts'
import { electronClipboard } from '../clipboard/port'
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
  // 包错误的 message 是我们自己写的、面向用户的（「口令不对，或者这个文件已经损坏」），
  // 可以原样透出去。🔴 它里面不含口令、不含路径 —— 加新 message 时守住这条。
  if (error instanceof PackageError) return fail('INVALID_ARGUMENT', error.message)
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

function asPositiveIntArray(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) {
    throw new RepositoryError('INVALID_ARGUMENT', `参数 ${field} 必须是数组`)
  }
  return value.map((item) => asPositiveInt(item, `${field}[]`))
}

/**
 * 导出/导入口令。
 *
 * 🔴 这个函数**绝不能**把口令拼进任何错误信息里 —— `toFailure` 兜底那条
 * `console.error` 是全应用唯一会把原始异常整个打印出来的地方，
 * 而这里手上拿着的正是口令本身。上限 1024 是防一个几 MB 的串把 scrypt 拖死。
 */
function asPassphrase(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RepositoryError('INVALID_ARGUMENT', '口令不能为空')
  }
  if (value.length > 1024) {
    throw new RepositoryError('INVALID_ARGUMENT', '口令过长')
  }
  return value
}

/**
 * 导入包的路径。
 *
 * 🔴 只接受**由 `transfer:pickPackage` 那个对话框给出来的**那种绝对路径。
 * 这里不做目录白名单（用户本来就可以把包放在任何地方），但要挡住空值和
 * 相对路径 —— 相对路径会相对主进程的 cwd 解析，那是个用户完全预期不到的位置。
 */
function asPackagePath(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RepositoryError('INVALID_ARGUMENT', '没有指定导出包的位置')
  }
  if (!isAbsolute(value)) {
    throw new RepositoryError('PATH_REJECTED', '导出包必须用绝对路径指定')
  }
  return value
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
 * 同上，但允许 `null` —— 只给「目标文件当时还不存在」这一种情况用
 * （阶段 5b 新建 `.env.example`）。
 *
 * 🔴 `null` 的语义是**断言**「我预览的时候它不存在」，不是「跳过校验」。
 * 主进程收到 null 会用 `openSync(path, 'wx')` 独占创建来兑现这个断言，
 * 文件已经在了就失败。上面那个 `asFileHash` 的注释点名拒绝空值，
 * **别把这里的宽松挪过去**：那三条写盘路径的目标一定是已存在的文件，
 * 它们没有"文件不存在"这种合法情形。
 */
function asFileHashOrAbsent(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return asFileHash(value)
}

/**
 * 变量的新值。`.env` 里放 PEM 私钥、JWT 都是正常的，所以上限给得宽，
 * 但不能不设 —— 渲染层送来的字符串会被原样写进用户的文件。
 */
const MAX_VALUE_BYTES = 64 * 1024

/**
 * 短文本入参（厂商 id、变量名、地址、备注……）。
 *
 * 超长的一律**截断**而不是拒绝：这些值只影响展示和匹配，
 * 为一个多打了几个字的备注让整次保存失败没有道理。
 * 但空值要不要接受由 `fallback` 决定 —— 变量名为空是真的不能往下走。
 */
function asShortText(value: unknown, field: string, max: number, fallback?: string): string {
  if (value == null && fallback !== undefined) return fallback
  if (typeof value !== 'string') {
    throw new RepositoryError('INVALID_ARGUMENT', `参数 ${field} 必须是字符串`)
  }
  const trimmed = value.trim()
  if (trimmed === '' && fallback === undefined) {
    throw new RepositoryError('INVALID_ARGUMENT', `参数 ${field} 不能为空`)
  }
  return trimmed.slice(0, max)
}

/**
 * 🔴 用户**能自己选**的状态只有这两个。
 *
 * `active` 和 `invalid` 是验证的**结论**，只能由 `credentialsValidate` 那条路
 * 写进去。放进这个白名单等于允许渲染层在一个请求都没发出去的情况下
 * 把凭据标成「可用」或「已失效」—— 那就是在假装做过实际没做的事，
 * 而这个应用里没有任何一处这么干。
 */
const USER_SETTABLE_STATUSES = new Set<CredentialStatus>(['unverified', 'revoked'])

function asCredentialStatus(value: unknown): CredentialStatus {
  if (typeof value !== 'string' || !USER_SETTABLE_STATUSES.has(value as CredentialStatus)) {
    throw new RepositoryError('INVALID_ARGUMENT', '这个状态不能手动设置')
  }
  return value as CredentialStatus
}

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

  // --- 模型凭据（阶段 3）-----------------------------------------------------

  handle(CHANNELS.credentialsProviders, () => credentials.listProviders())
  handle(CHANNELS.credentialsList, () => credentials.listCredentials())

  handle(CHANNELS.credentialsSuggest, (request) => {
    const body = asRecord(request)
    return credentials.suggestCredentials(asPositiveInt(body.projectId, 'projectId'))
  })

  handle(CHANNELS.credentialsCreate, (request) => {
    const body = asRecord(request)
    const bind = body.bind == null ? undefined : asRecord(body.bind)
    return credentials.createCredential({
      providerId: asShortText(body.providerId, 'providerId', 40),
      credentialName: asShortText(body.credentialName, 'credentialName', 80, ''),
      endpoint: asShortText(body.endpoint, 'endpoint', 300, ''),
      apiKey: asEntryValue(body.apiKey),
      notes: asShortText(body.notes, 'notes', 500, ''),
      ...(bind
        ? {
            bind: {
              projectId: asPositiveInt(bind.projectId, 'bind.projectId'),
              environment: asShortText(bind.environment, 'bind.environment', 60),
              keyVariable: asShortText(bind.keyVariable, 'bind.keyVariable', 200),
              endpointVariable: asShortText(bind.endpointVariable, 'bind.endpointVariable', 200, '')
            }
          }
        : {})
    })
  })

  handle(CHANNELS.credentialsUpdate, (request) => {
    const body = asRecord(request)
    return credentials.updateCredential({
      credentialId: asPositiveInt(body.credentialId, 'credentialId'),
      ...(body.credentialName !== undefined
        ? { credentialName: asShortText(body.credentialName, 'credentialName', 80, '') }
        : {}),
      ...(body.endpoint !== undefined
        ? { endpoint: asShortText(body.endpoint, 'endpoint', 300, '') }
        : {}),
      ...(body.notes !== undefined ? { notes: asShortText(body.notes, 'notes', 500, '') } : {}),
      ...(body.status !== undefined ? { status: asCredentialStatus(body.status) } : {}),
      ...(body.apiKey !== undefined ? { apiKey: asEntryValue(body.apiKey) } : {})
    })
  })

  handle(CHANNELS.credentialsReveal, (request) => {
    const body = asRecord(request)
    return credentials.revealCredentialKey(asPositiveInt(body.credentialId, 'credentialId'))
  })

  /**
   * 🔴 全应用唯一会发出站请求的通道，只在用户点「验证」时被调用。
   *
   * 这里**不接受**任何来自渲染层的传输层参数：能选择「怎么发」的只有主进程。
   * 假传输是验收脚本直接调 `credentials.validateCredential` 时注入的，
   * 不经过 IPC —— 让渲染层能左右出站行为等于把这道边界交还给页面。
   */
  handle(CHANNELS.credentialsValidate, (request) => {
    const body = asRecord(request)
    return credentials.validateCredential(asPositiveInt(body.credentialId, 'credentialId'))
  })

  handle(CHANNELS.credentialsDelete, (request) => {
    const body = asRecord(request)
    return { removed: credentials.deleteCredential(asPositiveInt(body.credentialId, 'credentialId')) }
  })

  handle(CHANNELS.credentialsBind, (request) => {
    const body = asRecord(request)
    return credentials.bindCredential(asPositiveInt(body.credentialId, 'credentialId'), {
      projectId: asPositiveInt(body.projectId, 'projectId'),
      environment: asShortText(body.environment, 'environment', 60),
      keyVariable: asShortText(body.keyVariable, 'keyVariable', 200),
      endpointVariable: asShortText(body.endpointVariable, 'endpointVariable', 200, '')
    })
  })

  handle(CHANNELS.credentialsUnbind, (request) => {
    const body = asRecord(request)
    return credentials.unbindCredential(asPositiveInt(body.bindingId, 'bindingId'))
  })

  handle(CHANNELS.credentialsVersions, (request) => {
    const body = asRecord(request)
    return credentials.listCredentialVersions(asPositiveInt(body.credentialId, 'credentialId'))
  })

  // --- 剪贴板（阶段 4b）------------------------------------------------------

  /**
   * 🔴 这两个通道**不返回明文**，只返回「多久之后会清」。
   *
   * 复制原本要先走 `entries:reveal` / `credentials:reveal` 把值取到渲染层，
   * 再由渲染层写剪贴板。挪到主进程之后，复制这条路上明文完全不过桥。
   */
  handle(CHANNELS.clipboardCopyEntry, async (request) => {
    const body = asRecord(request)
    return {
      clearAfterMs: await repo.copyEntryValue(
        asPositiveInt(body.entryId, 'entryId'),
        electronClipboard
      )
    }
  })

  handle(CHANNELS.clipboardCopyCredential, async (request) => {
    const body = asRecord(request)
    return {
      clearAfterMs: await credentials.copyCredentialKey(
        asPositiveInt(body.credentialId, 'credentialId'),
        electronClipboard
      )
    }
  })

  // --- 安全检查（阶段 4a）----------------------------------------------------

  /**
   * 🔴 全应用唯一会执行外部程序的通道 —— 它会起 git 子进程。
   *
   * 和 `credentialsValidate` 一样，这里**不接受**任何来自渲染层的 runner：
   * 能决定「执行什么程序」的只有主进程。假 runner 是验收脚本直接调
   * `security.scanSecurity` 时注入的，不经过 IPC。
   *
   * 但触发规矩和验证请求**不同**：这个允许打开页面时自动跑。
   * 它是本地只读操作，没有费用、没有副作用、不外发任何数据 ——
   * 而一个需要先点一下才肯工作的安全检查，等于没有。
   */
  handle(CHANNELS.securityScan, (request) => {
    const body = asRecord(request)
    return security.scanSecurity(asPositiveInt(body.projectId, 'projectId'))
  })

  handle(CHANNELS.credentialsSyncPreview, (request) => {
    const body = asRecord(request)
    return credentials.previewCredentialSync(asPositiveInt(body.credentialId, 'credentialId'))
  })

  // 同步会写多个 `.env` 文件，所以它也在「会改变监听基准」的那一组里。
  handle(CHANNELS.credentialsSync, (request) => {
    const body = asRecord(request)
    if (!Array.isArray(body.targets)) {
      throw new RepositoryError('INVALID_ARGUMENT', '参数 targets 必须是数组')
    }
    const targets = body.targets.map((item) => {
      const target = asRecord(item)
      return {
        bindingId: asPositiveInt(target.bindingId, 'targets[].bindingId'),
        // 每个目标各自带一个哈希：它们是不同的文件，共用一个哈希没有意义。
        expectedHash: asFileHash(target.expectedHash)
      }
    })
    const result = credentials.syncCredential(
      asPositiveInt(body.credentialId, 'credentialId'),
      targets
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

  // --- .env.example 生成（阶段 5b）-------------------------------------------
  // 两个 handler 都不要求解锁：源头是磁盘上的 .env 文件，全程不解密。
  // 和 security:scan 同一个性质，见 db/template.ts 顶部。

  handle(CHANNELS.templatePreview, (request) => {
    const body = asRecord(request)
    return template.previewTemplate(asPositiveInt(body.fileId, 'fileId'))
  })

  handle(CHANNELS.templateWrite, (request) => {
    const body = asRecord(request)
    const result = template.writeTemplate(
      asPositiveInt(body.fileId, 'fileId'),
      asFileHashOrAbsent(body.expectedTargetHash)
    )
    // 生成会在磁盘上造出/改掉一个 .env* 文件。它通常不纳管（模板默认不勾选），
    // 但用户勾过就会纳管 —— 那时不刷新就是拿旧哈希去比新文件，静默失效。
    void refreshWatchTargets()
    return result
  })

  // --- 加密导出 / 导入（阶段 5c）---------------------------------------------

  handle(CHANNELS.transferExportPreview, () => transfer.previewExport())

  handle(CHANNELS.transferExport, async (request, event) => {
    const body = asRecord(request)
    const projectIds = asPositiveIntArray(body.projectIds, 'projectIds')
    const includeCredentials = body.includeCredentials === true
    const passphrase = asPassphrase(body.passphrase)

    // 先收集再问路径：收集会因为 Vault 锁着而失败，那时候不该已经弹过对话框。
    const payload = transfer.buildPayload(projectIds, includeCredentials)

    const window = BrowserWindow.fromWebContents(event.sender)
    const picked = await dialog.showSaveDialog(window ?? BrowserWindow.getAllWindows()[0]!, {
      title: '保存加密导出包',
      defaultPath: `envvault-${new Date().toISOString().slice(0, 10)}.evpkg`,
      filters: [{ name: 'EnvVault 导出包', extensions: ['evpkg'] }]
    })
    if (picked.canceled || !picked.filePath) return null

    const blob = sealPackage(JSON.stringify(payload), passphrase)
    writeFileSync(picked.filePath, blob, { mode: 0o600 })

    const entryCount = payload.projects.reduce(
      (sum, project) => sum + project.files.reduce((n, file) => n + file.entries.length, 0),
      0
    )
    transfer.logExport(
      payload.projects.length,
      entryCount,
      payload.credentials.length,
      picked.filePath
    )

    return {
      targetPath: picked.filePath,
      projectCount: payload.projects.length,
      entryCount,
      credentialCount: payload.credentials.length,
      bytesWritten: blob.length
    }
  })

  handle(CHANNELS.transferPickPackage, async (_request, event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const picked = await dialog.showOpenDialog(window ?? BrowserWindow.getAllWindows()[0]!, {
      title: '选择要导入的加密导出包',
      properties: ['openFile'],
      filters: [{ name: 'EnvVault 导出包', extensions: ['evpkg'] }]
    })
    const sourcePath = picked.filePaths[0]
    if (picked.canceled || !sourcePath) return null

    // 只读包头就能识别。在问口令**之前**说"这不是个导出包"，
    // 比让用户输完一遍口令再告诉他要好。
    const header = inspectPackage(readFileSync(sourcePath))
    return { sourcePath, version: header.version }
  })

  handle(CHANNELS.transferImportPreview, (request) => {
    const body = asRecord(request)
    const json = openPackage(
      readFileSync(asPackagePath(body.sourcePath)),
      asPassphrase(body.passphrase)
    )
    return transfer.previewImport(json)
  })

  handle(CHANNELS.transferImport, (request) => {
    const body = asRecord(request)
    const json = openPackage(
      readFileSync(asPackagePath(body.sourcePath)),
      asPassphrase(body.passphrase)
    )
    const result = transfer.applyImport(json, {
      fileKeys: asStringArray(body.fileKeys, 'fileKeys'),
      credentialNames: asStringArray(body.credentialNames, 'credentialNames')
    })
    // 导入会新增 env_files 行，监听集合跟着变（HANDOFF §5 那一组，现在是十处）。
    void refreshWatchTargets()
    return result
  })

  handle(CHANNELS.activityList, (request) => {
    const body = asRecord(request ?? {})
    const limit = typeof body.limit === 'number' ? body.limit : 50
    return repo.listActivity(limit)
  })
}
