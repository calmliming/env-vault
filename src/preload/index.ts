/**
 * Preload：渲染进程与主进程之间唯一的桥（开发计划 §3.2「只暴露白名单 API」）。
 *
 * 这里刻意**不**暴露 `ipcRenderer` 本身，也不暴露任何接受通道名当参数的通用
 * `invoke(channel, payload)`。那样等于把白名单交还给渲染层去自觉遵守，
 * 而渲染层是加载页面内容的地方 —— 一旦有 XSS，通用 invoke 就是一把万能钥匙。
 *
 * 每个方法都写死自己的通道常量，新增能力必须同时改 shared/ipc.ts 和这个文件，
 * 这道「改两处」的摩擦是有意的。
 *
 * 🔴 本文件在 sandbox 模式下运行，必须编译成 CommonJS（见 electron.vite.config.ts）。
 */

import { contextBridge, ipcRenderer } from 'electron'
import {
  CHANNELS,
  PUSH_CHANNELS,
  type ActivityPage,
  type AdoptResult,
  type BulkImportResult,
  type DiscoveryPreview,
  type AppHealth,
  type ClipboardCopyResult,
  type ConfigEntryView,
  type CreateCredentialRequest,
  type CredentialBindingView,
  type CredentialRevealResult,
  type CredentialSuggestion,
  type CredentialSummary,
  type CredentialSyncPreview,
  type CredentialSyncResult,
  type CredentialValidationResult,
  type CredentialVersion,
  type FileChangedEvent,
  type ProviderInfo,
  type UpdateCredentialRequest,
  type FileDiff,
  type RestoreResult,
  type DatabaseInfo,
  type EntriesQuery,
  type EntryMutationResult,
  type EnvFileView,
  type EnvVaultApi,
  type ImportProjectRequest,
  type IpcResult,
  type ProjectSummary,
  type RescanResult,
  type RevealResult,
  type ScanPreview,
  type SecurityReport,
  type ExportPreview,
  type ExportResult,
  type ImportPreview,
  type ImportResult,
  type SelectDirectoryRequest,
  type SelectDirectoryResult,
  type TemplatePreview,
  type TemplateWriteResult,
  type VaultStatus
} from '@shared/ipc'

const api: EnvVaultApi = {
  getHealth: () => ipcRenderer.invoke(CHANNELS.appHealth) as Promise<IpcResult<AppHealth>>,
  getVaultStatus: () => ipcRenderer.invoke(CHANNELS.vaultStatus) as Promise<IpcResult<VaultStatus>>,
  initializeVault: () => ipcRenderer.invoke(CHANNELS.vaultInitialize) as Promise<IpcResult<VaultStatus>>,
  unlockVault: () => ipcRenderer.invoke(CHANNELS.vaultUnlock) as Promise<IpcResult<VaultStatus>>,
  lockVault: () => ipcRenderer.invoke(CHANNELS.vaultLock) as Promise<IpcResult<VaultStatus>>,
  getDatabaseInfo: () => ipcRenderer.invoke(CHANNELS.dbInfo) as Promise<IpcResult<DatabaseInfo>>,
  selectDirectory: (request: SelectDirectoryRequest = {}) =>
    ipcRenderer.invoke(CHANNELS.dialogSelectDirectory, request) as Promise<
      IpcResult<SelectDirectoryResult>
    >,
  listProjects: () => ipcRenderer.invoke(CHANNELS.projectsList) as Promise<IpcResult<ProjectSummary[]>>,
  previewProject: (rootPath: string) =>
    ipcRenderer.invoke(CHANNELS.projectsPreview, { rootPath }) as Promise<IpcResult<ScanPreview>>,
  importProject: (request: ImportProjectRequest) =>
    ipcRenderer.invoke(CHANNELS.projectsImport, request) as Promise<IpcResult<ProjectSummary>>,
  // 阶段 6：从一个父目录发现多个仓库，各自成为一个项目（各自有正确的 gitRoot）。
  discoverProjects: (rootPath: string) =>
    ipcRenderer.invoke(CHANNELS.projectsDiscover, { rootPath }) as Promise<
      IpcResult<DiscoveryPreview>
    >,
  importProjects: (projects: ImportProjectRequest[]) =>
    ipcRenderer.invoke(CHANNELS.projectsImportBulk, { projects }) as Promise<
      IpcResult<BulkImportResult>
    >,
  removeProject: (projectId: number) =>
    ipcRenderer.invoke(CHANNELS.projectsRemove, { projectId }) as Promise<
      IpcResult<{ removed: boolean }>
    >,
  rescanProject: (projectId: number) =>
    ipcRenderer.invoke(CHANNELS.projectsRescan, { projectId }) as Promise<IpcResult<RescanResult>>,
  listEntries: (query: EntriesQuery) =>
    ipcRenderer.invoke(CHANNELS.entriesList, query) as Promise<IpcResult<ConfigEntryView[]>>,
  revealEntry: (entryId: number) =>
    ipcRenderer.invoke(CHANNELS.entriesReveal, { entryId }) as Promise<IpcResult<RevealResult>>,
  updateEntry: (entryId: number, value: string, expectedHash: string) =>
    ipcRenderer.invoke(CHANNELS.entriesUpdate, { entryId, value, expectedHash }) as Promise<
      IpcResult<EntryMutationResult>
    >,
  deleteEntry: (entryId: number, expectedHash: string) =>
    ipcRenderer.invoke(CHANNELS.entriesDelete, { entryId, expectedHash }) as Promise<
      IpcResult<EntryMutationResult>
    >,
  listFiles: (projectId: number) =>
    ipcRenderer.invoke(CHANNELS.filesList, { projectId }) as Promise<IpcResult<EnvFileView[]>>,

  // --- 模型凭据（阶段 3）---
  listCredentials: () =>
    ipcRenderer.invoke(CHANNELS.credentialsList) as Promise<IpcResult<CredentialSummary[]>>,
  listProviders: () =>
    ipcRenderer.invoke(CHANNELS.credentialsProviders) as Promise<IpcResult<ProviderInfo[]>>,
  suggestCredentials: (projectId: number) =>
    ipcRenderer.invoke(CHANNELS.credentialsSuggest, { projectId }) as Promise<
      IpcResult<CredentialSuggestion[]>
    >,
  createCredential: (request: CreateCredentialRequest) =>
    ipcRenderer.invoke(CHANNELS.credentialsCreate, request) as Promise<IpcResult<CredentialSummary>>,
  updateCredential: (request: UpdateCredentialRequest) =>
    ipcRenderer.invoke(CHANNELS.credentialsUpdate, request) as Promise<IpcResult<CredentialSummary>>,
  revealCredential: (credentialId: number) =>
    ipcRenderer.invoke(CHANNELS.credentialsReveal, { credentialId }) as Promise<
      IpcResult<CredentialRevealResult>
    >,
  /** 🔴 唯一会让应用发出站请求的桥。只有用户点「验证」时才会走到。 */
  validateCredential: (credentialId: number) =>
    ipcRenderer.invoke(CHANNELS.credentialsValidate, { credentialId }) as Promise<
      IpcResult<CredentialValidationResult>
    >,
  deleteCredential: (credentialId: number) =>
    ipcRenderer.invoke(CHANNELS.credentialsDelete, { credentialId }) as Promise<
      IpcResult<{ removed: boolean }>
    >,
  bindCredential: (request: {
    credentialId: number
    projectId: number
    environment: string
    keyVariable: string
    endpointVariable?: string | null
  }) =>
    ipcRenderer.invoke(CHANNELS.credentialsBind, request) as Promise<
      IpcResult<CredentialBindingView[]>
    >,
  unbindCredential: (bindingId: number) =>
    ipcRenderer.invoke(CHANNELS.credentialsUnbind, { bindingId }) as Promise<
      IpcResult<CredentialBindingView[]>
    >,
  previewCredentialSync: (credentialId: number) =>
    ipcRenderer.invoke(CHANNELS.credentialsSyncPreview, { credentialId }) as Promise<
      IpcResult<CredentialSyncPreview>
    >,
  syncCredential: (
    credentialId: number,
    targets: { bindingId: number; expectedHash: string }[]
  ) =>
    ipcRenderer.invoke(CHANNELS.credentialsSync, { credentialId, targets }) as Promise<
      IpcResult<CredentialSyncResult>
    >,
  listCredentialVersions: (credentialId: number) =>
    ipcRenderer.invoke(CHANNELS.credentialsVersions, { credentialId }) as Promise<
      IpcResult<CredentialVersion[]>
    >,
  /**
   * 🔴 复制走主进程 —— 明文**不为了复制而过桥**。
   * 只有 id 进去、「多久之后清」出来。
   */
  copyEntryValue: (entryId: number) =>
    ipcRenderer.invoke(CHANNELS.clipboardCopyEntry, { entryId }) as Promise<
      IpcResult<ClipboardCopyResult>
    >,
  copyCredentialKey: (credentialId: number) =>
    ipcRenderer.invoke(CHANNELS.clipboardCopyCredential, { credentialId }) as Promise<
      IpcResult<ClipboardCopyResult>
    >,
  /** 🔴 唯一会让应用执行外部程序的桥（起 git 子进程做只读检查）。 */
  scanSecurity: (projectId: number) =>
    ipcRenderer.invoke(CHANNELS.securityScan, { projectId }) as Promise<
      IpcResult<SecurityReport>
    >,
  listActivity: (limit?: number, offset?: number) =>
    ipcRenderer.invoke(CHANNELS.activityList, { limit, offset }) as Promise<IpcResult<ActivityPage>>,
  diffFile: (fileId: number) =>
    ipcRenderer.invoke(CHANNELS.filesDiff, { fileId }) as Promise<IpcResult<FileDiff>>,
  adoptDiskFile: (fileId: number) =>
    ipcRenderer.invoke(CHANNELS.filesAdopt, { fileId }) as Promise<IpcResult<AdoptResult>>,
  restoreFile: (fileId: number, keys: string[], expectedHash: string) =>
    ipcRenderer.invoke(CHANNELS.filesRestore, { fileId, keys, expectedHash }) as Promise<
      IpcResult<RestoreResult>
    >,

  // --- .env.example 生成（阶段 5b）---
  // 🔴 写入这一侧只送 id 和目标哈希，**不送内容**：模板由主进程重新生成。
  // 让渲染层把内容送进来，等于给它开一个「往任意 .env.example 写任意字节」的原语。
  previewTemplate: (fileId: number) =>
    ipcRenderer.invoke(CHANNELS.templatePreview, { fileId }) as Promise<IpcResult<TemplatePreview>>,
  writeTemplate: (fileId: number, expectedTargetHash: string | null) =>
    ipcRenderer.invoke(CHANNELS.templateWrite, { fileId, expectedTargetHash }) as Promise<
      IpcResult<TemplateWriteResult>
    >,

  // --- 加密导出 / 导入（阶段 5c）---
  // 🔴 口令走的是渲染层 → 主进程方向。这和「明文出主进程」是反方向：
  // 用户在界面上敲它，主进程拿它派生密钥，它不会从任何一个通道回来。
  previewExport: () =>
    ipcRenderer.invoke(CHANNELS.transferExportPreview) as Promise<IpcResult<ExportPreview>>,
  exportPackage: (request: {
    projectIds: number[]
    includeCredentials: boolean
    passphrase: string
  }) => ipcRenderer.invoke(CHANNELS.transferExport, request) as Promise<IpcResult<ExportResult | null>>,
  pickPackage: () =>
    ipcRenderer.invoke(CHANNELS.transferPickPackage) as Promise<
      IpcResult<{ sourcePath: string; version: number } | null>
    >,
  previewImport: (sourcePath: string, passphrase: string) =>
    ipcRenderer.invoke(CHANNELS.transferImportPreview, { sourcePath, passphrase }) as Promise<
      IpcResult<ImportPreview>
    >,
  importPackage: (request: {
    sourcePath: string
    passphrase: string
    fileKeys: string[]
    credentialNames: string[]
  }) => ipcRenderer.invoke(CHANNELS.transferImport, request) as Promise<IpcResult<ImportResult>>,

  onFilesChanged: (handler: (events: FileChangedEvent[]) => void) => {
    // 包一层，不把 Electron 的 IpcRendererEvent 透给渲染层 ——
    // 那个对象带着 sender 等能力，没有理由过桥。
    const listener = (_event: unknown, payload: FileChangedEvent[]): void => handler(payload)
    ipcRenderer.on(PUSH_CHANNELS.filesChanged, listener)
    // 🔴 退订必须带上 listener：不传的话会清掉这个通道上的全部监听器。
    return () => {
      ipcRenderer.off(PUSH_CHANNELS.filesChanged, listener)
    }
  }
}

// contextIsolation 打开时，exposeInMainWorld 会把对象深拷贝到隔离世界，
// 渲染层拿到的是副本，改不动这边的引用。
contextBridge.exposeInMainWorld('envvault', api)
