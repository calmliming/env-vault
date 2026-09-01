/**
 * 渲染层调用主进程的薄封装。
 *
 * 主进程从不跨进程抛异常，一律返回 IpcResult 信封（见 shared/ipc.ts）。
 * 这里把信封拆开：成功给数据，失败给一句可以直接进 toast 的中文 + 错误码。
 *
 * `code` 必须带出来：界面要区分「Vault 锁着，去解锁」和「真的出错了」，
 * 靠匹配 message 字符串做这件事，会在改一次文案时静默失效。
 */

import type {
  CreateCredentialRequest,
  EntriesQuery,
  ImportProjectRequest,
  IpcErrorCode,
  IpcResult,
  UpdateCredentialRequest
} from '@shared/ipc'

export interface CallFailure {
  ok: false
  code: IpcErrorCode
  message: string
}
export interface CallSuccess<T> {
  ok: true
  data: T
}
export type CallOutcome<T> = CallSuccess<T> | CallFailure

/**
 * 除了拆信封，还兜住「preload 没注入」和「invoke 本身 reject」两种情况。
 * 前者出现在浏览器里直接打开页面时，后者出现在主进程 handler 尚未注册时；
 * 两者都不该让整个界面白屏。
 */
export async function call<T>(run: () => Promise<IpcResult<T>>): Promise<CallOutcome<T>> {
  if (typeof window === 'undefined' || !window.envvault) {
    return { ok: false, code: 'INTERNAL', message: '桥接未就绪：请在 EnvVault 应用中打开' }
  }
  try {
    const result = await run()
    if (result.ok) return { ok: true, data: result.data }
    return { ok: false, code: result.code, message: result.message }
  } catch {
    return { ok: false, code: 'INTERNAL', message: '与主进程通信失败' }
  }
}

/** Vault 没解锁导致的失败，界面要引导用户去解锁而不是报错。 */
export function isVaultBlocked(failure: CallFailure): boolean {
  return failure.code === 'VAULT_LOCKED' || failure.code === 'VAULT_UNINITIALIZED'
}

export const bridge = {
  health: () => call(() => window.envvault.getHealth()),
  vaultStatus: () => call(() => window.envvault.getVaultStatus()),
  initializeVault: () => call(() => window.envvault.initializeVault()),
  unlockVault: () => call(() => window.envvault.unlockVault()),
  lockVault: () => call(() => window.envvault.lockVault()),
  databaseInfo: () => call(() => window.envvault.getDatabaseInfo()),
  selectDirectory: (title?: string) => call(() => window.envvault.selectDirectory({ title })),
  listProjects: () => call(() => window.envvault.listProjects()),
  previewProject: (rootPath: string) => call(() => window.envvault.previewProject(rootPath)),
  importProject: (request: ImportProjectRequest) =>
    call(() => window.envvault.importProject(request)),
  removeProject: (projectId: number) => call(() => window.envvault.removeProject(projectId)),
  rescanProject: (projectId: number) => call(() => window.envvault.rescanProject(projectId)),
  listEntries: (query: EntriesQuery) => call(() => window.envvault.listEntries(query)),
  revealEntry: (entryId: number) => call(() => window.envvault.revealEntry(entryId)),
  updateEntry: (entryId: number, value: string, expectedHash: string) =>
    call(() => window.envvault.updateEntry(entryId, value, expectedHash)),
  deleteEntry: (entryId: number, expectedHash: string) =>
    call(() => window.envvault.deleteEntry(entryId, expectedHash)),
  listFiles: (projectId: number) => call(() => window.envvault.listFiles(projectId)),
  diffFile: (fileId: number) => call(() => window.envvault.diffFile(fileId)),
  adoptDiskFile: (fileId: number) => call(() => window.envvault.adoptDiskFile(fileId)),
  restoreFile: (fileId: number, keys: string[], expectedHash: string) =>
    call(() => window.envvault.restoreFile(fileId, keys, expectedHash)),
  listActivity: (limit?: number) => call(() => window.envvault.listActivity(limit)),

  // --- 模型凭据（阶段 3）---
  listCredentials: () => call(() => window.envvault.listCredentials()),
  listProviders: () => call(() => window.envvault.listProviders()),
  suggestCredentials: (projectId: number) =>
    call(() => window.envvault.suggestCredentials(projectId)),
  createCredential: (request: CreateCredentialRequest) =>
    call(() => window.envvault.createCredential(request)),
  updateCredential: (request: UpdateCredentialRequest) =>
    call(() => window.envvault.updateCredential(request)),
  revealCredential: (credentialId: number) =>
    call(() => window.envvault.revealCredential(credentialId)),
  deleteCredential: (credentialId: number) =>
    call(() => window.envvault.deleteCredential(credentialId)),
  bindCredential: (request: {
    credentialId: number
    projectId: number
    environment: string
    keyVariable: string
    endpointVariable?: string | null
  }) => call(() => window.envvault.bindCredential(request)),
  unbindCredential: (bindingId: number) => call(() => window.envvault.unbindCredential(bindingId)),
  previewCredentialSync: (credentialId: number) =>
    call(() => window.envvault.previewCredentialSync(credentialId)),
  syncCredential: (credentialId: number, targets: { bindingId: number; expectedHash: string }[]) =>
    call(() => window.envvault.syncCredential(credentialId, targets))
}
