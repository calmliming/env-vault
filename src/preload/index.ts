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
  type ActivityRecord,
  type AdoptResult,
  type AppHealth,
  type ConfigEntryView,
  type FileChangedEvent,
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
  type SelectDirectoryRequest,
  type SelectDirectoryResult,
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
  listActivity: (limit?: number) =>
    ipcRenderer.invoke(CHANNELS.activityList, { limit }) as Promise<IpcResult<ActivityRecord[]>>,
  diffFile: (fileId: number) =>
    ipcRenderer.invoke(CHANNELS.filesDiff, { fileId }) as Promise<IpcResult<FileDiff>>,
  adoptDiskFile: (fileId: number) =>
    ipcRenderer.invoke(CHANNELS.filesAdopt, { fileId }) as Promise<IpcResult<AdoptResult>>,
  restoreFile: (fileId: number, keys: string[], expectedHash: string) =>
    ipcRenderer.invoke(CHANNELS.filesRestore, { fileId, keys, expectedHash }) as Promise<
      IpcResult<RestoreResult>
    >,

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
