/**
 * IPC 契约：主进程、Preload 和渲染进程共用的唯一真源。
 *
 * 约定（对应开发计划 §3.2）：
 * - 渲染进程只能调用这里列出的通道，Preload 按 CHANNELS 白名单逐个挂载。
 * - 通道名一律 `<域>:<动作>`，域与主进程 handler 目录一一对应。
 * - 每个通道的入参出参都在 IpcContract 里声明，主进程与渲染层共享同一份类型。
 * - 主进程返回值统一包成 IpcResult，异常不跨进程抛，避免把堆栈泄漏给渲染层。
 */

import type { Sensitivity, ValueType } from './env-types.ts'
import type { ValidationOutcome } from './provider-types.ts'

export type { Sensitivity, ValueType }

export const CHANNELS = {
  appHealth: 'app:health',
  vaultStatus: 'vault:status',
  vaultInitialize: 'vault:initialize',
  vaultUnlock: 'vault:unlock',
  vaultLock: 'vault:lock',
  dbInfo: 'db:info',
  dialogSelectDirectory: 'dialog:select-directory',
  projectsList: 'projects:list',
  projectsPreview: 'projects:preview',
  projectsImport: 'projects:import',
  projectsRemove: 'projects:remove',
  projectsRescan: 'projects:rescan',
  entriesList: 'entries:list',
  entriesReveal: 'entries:reveal',
  entriesUpdate: 'entries:update',
  entriesDelete: 'entries:delete',
  credentialsList: 'credentials:list',
  credentialsProviders: 'credentials:providers',
  credentialsSuggest: 'credentials:suggest',
  credentialsCreate: 'credentials:create',
  credentialsUpdate: 'credentials:update',
  credentialsReveal: 'credentials:reveal',
  credentialsValidate: 'credentials:validate',
  credentialsDelete: 'credentials:delete',
  credentialsBind: 'credentials:bind',
  credentialsUnbind: 'credentials:unbind',
  credentialsSyncPreview: 'credentials:sync-preview',
  credentialsSync: 'credentials:sync',
  filesList: 'files:list',
  filesDiff: 'files:diff',
  filesAdopt: 'files:adopt',
  filesRestore: 'files:restore',
  activityList: 'activity:list'
} as const

/**
 * 主进程 → 渲染层的推送通道，方向和上面那些 invoke 反过来。
 * 单独列出来是因为 Preload 给它建的是 `on/off` 桥而不是 `invoke` 桥，
 * 混在 CHANNELS 里会让白名单的语义变得含糊。
 */
export const PUSH_CHANNELS = {
  filesChanged: 'files:changed'
} as const

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS]

/** 白名单：Preload 只会为这个数组里的通道建桥。 */
export const CHANNEL_LIST: readonly ChannelName[] = Object.values(CHANNELS)

// ---------------------------------------------------------------------------
// 载荷类型
// ---------------------------------------------------------------------------

export type VaultState =
  /** 本机还没有主密钥，需要先 initialize。 */
  | 'uninitialized'
  /** 主密钥存在但未载入内存，敏感值不可解密。 */
  | 'locked'
  /** 主密钥在内存中，可解密。 */
  | 'unlocked'

export interface VaultStatus {
  state: VaultState
  /** 系统密钥库是否可用；false 时不允许创建 Vault，避免明文落盘。 */
  keystoreAvailable: boolean
  /** 系统密钥库后端名称，仅用于展示与排障。 */
  keystoreBackend: string
  /** 主密钥密文文件路径，不包含密钥本身。 */
  keyFilePath: string
  /** 本次解锁的时间戳；locked 时为 null。 */
  unlockedAt: number | null
}

export interface AppHealth {
  appVersion: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  platform: string
  userDataPath: string
  vault: VaultStatus
  database: DatabaseInfo
}

export interface DatabaseInfo {
  filePath: string
  /** 已应用的迁移版本号，等于 PRAGMA user_version。 */
  schemaVersion: number
  /** 代码里定义的最新迁移版本号。 */
  latestVersion: number
  /** 本次启动实际执行的迁移，按顺序。 */
  appliedMigrations: AppliedMigration[]
  tables: string[]
}

export interface AppliedMigration {
  version: number
  name: string
  durationMs: number
}

export interface SelectDirectoryRequest {
  title?: string
}

export interface SelectDirectoryResult {
  canceled: boolean
  /** 用户选中的绝对路径；canceled 时为 null。 */
  path: string | null
}

// ---------------------------------------------------------------------------
// 项目、配置项与文件
// ---------------------------------------------------------------------------

export interface ProjectSummary {
  id: number
  name: string
  absolutePath: string
  gitRoot: string | null
  createdAt: number
  lastOpenedAt: number | null
  fileCount: number
  entryCount: number
  /** 该项目下出现过的环境，已按常用顺序排好。 */
  environments: string[]
}

export interface ScanPreviewFile {
  absolutePath: string
  relativePath: string
  fileName: string
  environment: string
  isTemplate: boolean
  entryCount: number
  byteSize: number
  /** 读取失败的原因；非 null 时不可导入。 */
  error: string | null
}

/** 只读扫描的结果。对应 §6.1 步骤 3「展示发现的文件和变量数量，不立即修改文件」。 */
export interface ScanPreview {
  rootPath: string
  gitRoot: string | null
  /** 按目录名给出的项目名建议，用户可改。 */
  suggestedName: string
  files: ScanPreviewFile[]
  /** 触到深度或数量上限，没扫全。 */
  truncated: boolean
  totalEntries: number
  /** 这个路径已经被纳管过了。 */
  alreadyImported: boolean
}

export interface ImportProjectRequest {
  rootPath: string
  name: string
  /** 用户勾选要纳管的文件绝对路径。空数组表示不导入任何文件。 */
  includePaths: string[]
}

/**
 * 掩码占位符。定义在 shared 是因为主进程负责生成 displayValue、
 * 渲染层负责按它渲染 `.value.masked` 样式，两边必须是同一个串。
 */
export const MASKED_PLACEHOLDER = '••••••••••••••••••'

export interface ConfigEntryView {
  id: number
  key: string
  /**
   * 用于展示的值。敏感项在**主进程**就换成了占位符 ——
   * 明文不会随列表一起过桥（§7「搜索结果、日志、错误、通知禁止出现完整 Key」）。
   */
  displayValue: string
  masked: boolean
  valueType: ValueType
  sensitivity: Sensitivity
  environment: string
  /** 来源文件的项目内相对路径。 */
  sourceFile: string
  lineNumber: number | null
  fileId: number
  /** 来源文件在磁盘上已经和入库时不一致。 */
  fileDrifted: boolean
  /** 非 null 表示这个变量由某个模型凭据管理，就地编辑入口关闭。 */
  managedBy: EntryBindingRef | null
}

export interface EntriesQuery {
  projectId: number
  /** 省略表示所有环境。 */
  environment?: string
}

/**
 * 这个变量已经被提成模型凭据了（阶段 3）。
 *
 * 变量本身**仍然留在配置表里** —— §6.2 步骤 2「同时保留原始通用配置记录」，
 * 阶段 3 的验收也要求「通用配置页面仍能看到原始来源和绑定状态」。
 * 只是编辑入口挪到了凭据页：真源只能有一个，否则「改一次同步到多处」没有意义。
 */
export interface EntryBindingRef {
  bindingId: number
  credentialId: number
  credentialName: string
  providerName: string
  /** 这个变量在绑定里扮演的角色。 */
  role: 'key' | 'endpoint'
}

export interface EnvFileView {
  id: number
  relativePath: string
  fileName: string
  environment: string
  isTemplate: boolean
  entryCount: number
  storedHash: string | null
  /** 当前磁盘上的哈希；null 表示文件已不存在。 */
  currentHash: string | null
  /** 磁盘内容与入库时不一致，或文件已消失。 */
  drifted: boolean
  lastScannedAt: number | null
}

export interface RevealResult {
  id: number
  key: string
  /** 明文。只在这一个通道返回，且每次调用都会记一条操作日志。 */
  value: string
}

/**
 * 编辑或删除单个变量的结果。
 *
 * 这两个动作都是「改中心记录 + 立刻原子写回磁盘」的一次性操作：
 * 中途任何一步失败都不落库，所以不存在「记录改了文件没改」的中间态。
 */
export interface EntryMutationResult {
  /** 受影响的条目 id。删除之后这个 id 已经不存在了。 */
  entryId: number
  key: string
  fileId: number
  /**
   * 是否真的写了磁盘。两种情况为 false：新值和旧值相同，
   * 以及要删的 key 本来就不在磁盘文件里（只清掉了中心记录）。
   */
  written: boolean
  /** 写盘前的备份路径；没写盘时为 null。 */
  backupPath: string | null
  /** 文件当前哈希，界面拿去更新手里的 expectedHash。 */
  newHash: string
}

export interface ActivityRecord {
  id: number
  action: string
  projectName: string | null
  environment: string | null
  targetKind: string | null
  targetRef: string | null
  detail: string | null
  createdAt: number
}

export type DiffStatus = 'unchanged' | 'changed' | 'added' | 'removed'

export interface FileDiffRow {
  key: string
  occurrence: number
  status: DiffStatus
  /**
   * 敏感项：两侧的值都是掩码占位符。
   * 用户能看到「这一项变了」，但看不到变成什么 —— 想看具体值要回配置表点「显示」，
   * 那条路径会留痕。差异面板是一览视图，把明文铺上去等于绕过了 reveal 的审计。
   */
  masked: boolean
  centralPreview: string | null
  diskPreview: string | null
  lineNumber: number | null
}

export interface DiffSummaryView {
  changed: number
  added: number
  removed: number
  unchanged: number
  hasChanges: boolean
}

export interface FileDiff {
  fileId: number
  relativePath: string
  environment: string
  storedHash: string | null
  currentHash: string
  summary: DiffSummaryView
  rows: FileDiffRow[]
}

/** 以磁盘为准，重新记录这个文件。 */
export interface AdoptResult {
  fileId: number
  entryCount: number
  newHash: string
}

/** 以中心记录为准，写回磁盘。 */
export interface RestoreResult {
  fileId: number
  written: number
  /** 磁盘文件里不存在的 key。不会被静默追加。 */
  skipped: string[]
  backupPath: string
  newHash: string
}

// ---------------------------------------------------------------------------
// 模型凭据（阶段 3）
// ---------------------------------------------------------------------------

export interface ProviderInfo {
  id: string
  providerName: string
  defaultEndpoint: string
}

/** 识别建议的依据。界面要如实说明，不能只给个厂商名了事。 */
export type SuggestionBasis = 'value' | 'variable-name' | 'both'

export interface ProviderChoice {
  providerId: string
  providerName: string
  basis: SuggestionBasis
}

/**
 * 「这个变量看起来是一把模型凭据」。
 *
 * 🔴 不含 Key 的明文，连掩码值都不给 —— 这是一个一览列表，
 * 用户还没有对任何一条做出决定，没有理由在这里解密。
 */
export interface CredentialSuggestion {
  entryId: number
  key: string
  environment: string
  sourceFile: string
  /** 按可信度排好序的候选厂商；长度 >1 说明变量名和值指向了不同的家。 */
  providers: ProviderChoice[]
  /** 同一环境里疑似的地址变量名，供预填。 */
  endpointVariable: string | null
  endpointPreview: string | null
}

/**
 * 凭据状态。
 *
 * 🔴 `invalid` 和 `revoked` 是**两件事**，不能合并：
 * 前者是厂商回了 401/403（「这把 Key 不行了」），后者是用户自己按的停用。
 * 合成一个之后，界面上看到「已停用」再也回答不了「这是谁的决定」，
 * 而这恰恰是用户下一步要做什么的依据。
 *
 * 只有真正问出了答案才会离开 `unverified` —— 网络不通、厂商限流、
 * 地址填错都**不**改状态，理由见 `shared/provider-types.ts`。
 */
export type CredentialStatus = 'unverified' | 'active' | 'invalid' | 'revoked'

export interface CredentialSummary {
  id: number
  providerName: string
  providerId: string
  credentialName: string
  endpoint: string
  /** Key 的末四位。太短的 Key 不给尾号。 */
  lastFour: string
  /** 同一把 Key 在不同项目里会得到相同的指纹，用来回答「这是同一把吗」。 */
  fingerprint: string
  status: CredentialStatus
  bindingCount: number
  createdAt: number
  lastValidatedAt: number | null
  notes: string | null
}

export interface CredentialBindingView {
  id: number
  credentialId: number
  projectId: number
  projectName: string
  environment: string
  keyVariable: string
  endpointVariable: string | null
  /** 这个环境里找不到对应的文件或变量时为 true，界面要标出来。 */
  unresolved: boolean
}

export interface CreateCredentialRequest {
  providerId: string
  credentialName: string
  endpoint: string
  apiKey: string
  notes?: string
  /** 同时建立一条绑定。留空则只入库不绑定。 */
  bind?: {
    projectId: number
    environment: string
    keyVariable: string
    endpointVariable?: string | null
  }
}

export interface UpdateCredentialRequest {
  credentialId: number
  credentialName?: string
  endpoint?: string
  notes?: string | null
  status?: CredentialStatus
  /** 轮换：换一把新 Key。只改凭据本身，同步到文件是单独一步。 */
  apiKey?: string
}

/** 同步预览里单个目标的状态。 */
export type SyncTargetState =
  /** 文件里的值已经和凭据一致，不需要写。 */
  | 'in-sync'
  /** 需要写入。 */
  | 'outdated'
  /** 绑定指定的变量在这个环境的文件里不存在。不会被静默追加。 */
  | 'missing-variable'
  /** 文件有未处理的外部改动，写下去会覆盖别人的修改。 */
  | 'file-drifted'
  /** 文件已从磁盘消失。 */
  | 'file-missing'

export interface SyncTarget {
  bindingId: number
  projectId: number
  projectName: string
  environment: string
  /** 项目内相对路径；无法定位文件时为 null。 */
  relativePath: string | null
  keyVariable: string
  state: SyncTargetState
  /**
   * 这个目标文件当前的磁盘哈希，`credentials:sync` 要原样带回来做并发校验。
   * 无法定位文件时为 null。
   */
  expectedHash: string | null
}

/**
 * 一改多同步的预览。
 *
 * 🔴 只说「哪些地方要改」，不说「改成什么」—— 预览是一览视图，
 * 把 Key 铺在上面等于绕过 reveal 的审计（和差异面板同一条规矩）。
 */
export interface CredentialSyncPreview {
  credentialId: number
  credentialName: string
  providerName: string
  targets: SyncTarget[]
  /** 可写入的目标数（state === 'outdated'）。 */
  writable: number
}

export interface SyncOutcome {
  bindingId: number
  projectName: string
  environment: string
  relativePath: string | null
  ok: boolean
  /** 失败或跳过的原因，面向用户的中文短句。成功时为 null。 */
  reason: string | null
}

/**
 * 同步结果。**逐个目标报告**，不是全有或全无：
 * 跨多个文件的写入没法原子回滚，一个文件写成功另一个冲突时，
 * 谎称"整体失败"会让用户以为第一个文件没被改。
 */
export interface CredentialSyncResult {
  credentialId: number
  written: number
  failed: number
  outcomes: SyncOutcome[]
}

export interface CredentialRevealResult {
  id: number
  credentialName: string
  /** 明文。只在这个通道返回，每次调用都留一条操作记录。 */
  apiKey: string
}

/**
 * 一次验证的结果（开发计划 §7、§8）。
 *
 * 🔴 里面**没有 Key**，也没有请求的任何部分。Key 在主进程内存里解密之后
 * 直接进了请求头，从不出现在返回值上 —— 和同步写盘那条路同一个模式。
 */
export interface CredentialValidationResult {
  /** 验证完之后的凭据摘要。没结论时它和调用前完全一样。 */
  credential: CredentialSummary
  outcome: ValidationOutcome
  /** 拿到了响应才有；连不上或超时是 null。 */
  httpStatus: number | null
  /** 给人看的一句话，由主进程构造，不来自厂商响应体也不来自原始异常。 */
  message: string
  /**
   * 这次验证有没有问出答案。`false` 时状态和「最后验证时间」都没有被改动 ——
   * 界面要如实说「这次没验出结论」，不能显示成验证失败。
   */
  conclusive: boolean
}

/** 监听到的文件变化，由主进程主动推送。 */
export interface FileChangedEvent {
  fileId: number
  absolutePath: string
  currentHash: string | null
  drifted: boolean
}

export interface RescanResult {
  projectId: number
  /** 新发现并纳管的文件数。 */
  addedFiles: number
  /** 内容变化后重新解析的文件数。 */
  updatedFiles: number
  /** 磁盘上已消失的文件数（记录保留，标记为 drifted）。 */
  missingFiles: number
  totalEntries: number
}

// ---------------------------------------------------------------------------
// 通道签名
// ---------------------------------------------------------------------------

export interface IpcContract {
  [CHANNELS.appHealth]: { request: void; response: AppHealth }
  [CHANNELS.vaultStatus]: { request: void; response: VaultStatus }
  [CHANNELS.vaultInitialize]: { request: void; response: VaultStatus }
  [CHANNELS.vaultUnlock]: { request: void; response: VaultStatus }
  [CHANNELS.vaultLock]: { request: void; response: VaultStatus }
  [CHANNELS.dbInfo]: { request: void; response: DatabaseInfo }
  [CHANNELS.dialogSelectDirectory]: {
    request: SelectDirectoryRequest
    response: SelectDirectoryResult
  }
  [CHANNELS.projectsList]: { request: void; response: ProjectSummary[] }
  [CHANNELS.projectsPreview]: { request: { rootPath: string }; response: ScanPreview }
  [CHANNELS.projectsImport]: { request: ImportProjectRequest; response: ProjectSummary }
  [CHANNELS.projectsRemove]: { request: { projectId: number }; response: { removed: boolean } }
  [CHANNELS.projectsRescan]: { request: { projectId: number }; response: RescanResult }
  [CHANNELS.entriesList]: { request: EntriesQuery; response: ConfigEntryView[] }
  [CHANNELS.entriesReveal]: { request: { entryId: number }; response: RevealResult }
  [CHANNELS.entriesUpdate]: {
    request: { entryId: number; value: string; expectedHash: string }
    response: EntryMutationResult
  }
  [CHANNELS.entriesDelete]: {
    request: { entryId: number; expectedHash: string }
    response: EntryMutationResult
  }
  [CHANNELS.credentialsList]: { request: void; response: CredentialSummary[] }
  [CHANNELS.credentialsProviders]: { request: void; response: ProviderInfo[] }
  [CHANNELS.credentialsSuggest]: {
    request: { projectId: number }
    response: CredentialSuggestion[]
  }
  [CHANNELS.credentialsCreate]: {
    request: CreateCredentialRequest
    response: CredentialSummary
  }
  [CHANNELS.credentialsUpdate]: {
    request: UpdateCredentialRequest
    response: CredentialSummary
  }
  [CHANNELS.credentialsReveal]: {
    request: { credentialId: number }
    response: CredentialRevealResult
  }
  /**
   * 🔴 全应用唯一会产生出站流量的通道。仅在用户显式点「验证」时调用 ——
   * 没有任何自动触发的路径（计划 §7）。
   */
  [CHANNELS.credentialsValidate]: {
    request: { credentialId: number }
    response: CredentialValidationResult
  }
  [CHANNELS.credentialsDelete]: {
    request: { credentialId: number }
    response: { removed: boolean }
  }
  [CHANNELS.credentialsBind]: {
    request: {
      credentialId: number
      projectId: number
      environment: string
      keyVariable: string
      endpointVariable?: string | null
    }
    response: CredentialBindingView[]
  }
  [CHANNELS.credentialsUnbind]: {
    request: { bindingId: number }
    response: CredentialBindingView[]
  }
  [CHANNELS.credentialsSyncPreview]: {
    request: { credentialId: number }
    response: CredentialSyncPreview
  }
  [CHANNELS.credentialsSync]: {
    request: { credentialId: number; targets: { bindingId: number; expectedHash: string }[] }
    response: CredentialSyncResult
  }
  [CHANNELS.filesList]: { request: { projectId: number }; response: EnvFileView[] }
  [CHANNELS.filesDiff]: { request: { fileId: number }; response: FileDiff }
  [CHANNELS.filesAdopt]: { request: { fileId: number }; response: AdoptResult }
  [CHANNELS.filesRestore]: {
    request: { fileId: number; keys: string[]; expectedHash: string }
    response: RestoreResult
  }
  [CHANNELS.activityList]: { request: { limit?: number }; response: ActivityRecord[] }
}

export type IpcRequest<C extends ChannelName> = IpcContract[C]['request']
export type IpcResponse<C extends ChannelName> = IpcContract[C]['response']

// ---------------------------------------------------------------------------
// 统一返回信封
// ---------------------------------------------------------------------------

export type IpcErrorCode =
  | 'INVALID_ARGUMENT'
  | 'VAULT_LOCKED'
  | 'VAULT_UNINITIALIZED'
  | 'KEYSTORE_UNAVAILABLE'
  | 'DATABASE_ERROR'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'PATH_REJECTED'
  | 'INTERNAL'

export interface IpcFailure {
  ok: false
  code: IpcErrorCode
  /** 面向用户的中文短句，不含路径以外的敏感信息，禁止出现完整 Key。 */
  message: string
}

export interface IpcSuccess<T> {
  ok: true
  data: T
}

export type IpcResult<T> = IpcSuccess<T> | IpcFailure

/** 渲染进程通过 window.envvault 拿到的 API 形状。 */
export interface EnvVaultApi {
  getHealth(): Promise<IpcResult<AppHealth>>
  getVaultStatus(): Promise<IpcResult<VaultStatus>>
  initializeVault(): Promise<IpcResult<VaultStatus>>
  unlockVault(): Promise<IpcResult<VaultStatus>>
  lockVault(): Promise<IpcResult<VaultStatus>>
  getDatabaseInfo(): Promise<IpcResult<DatabaseInfo>>
  selectDirectory(request?: SelectDirectoryRequest): Promise<IpcResult<SelectDirectoryResult>>
  listProjects(): Promise<IpcResult<ProjectSummary[]>>
  previewProject(rootPath: string): Promise<IpcResult<ScanPreview>>
  importProject(request: ImportProjectRequest): Promise<IpcResult<ProjectSummary>>
  removeProject(projectId: number): Promise<IpcResult<{ removed: boolean }>>
  rescanProject(projectId: number): Promise<IpcResult<RescanResult>>
  listEntries(query: EntriesQuery): Promise<IpcResult<ConfigEntryView[]>>
  revealEntry(entryId: number): Promise<IpcResult<RevealResult>>
  /**
   * 改一个变量的值：更新中心记录并立刻原子写回磁盘。
   *
   * `expectedHash` 是界面看到这份数据时文件的磁盘哈希 ——
   * 语义同 `restoreFile`：「我这个决定是基于哪个版本做的」。对不上就中止。
   */
  updateEntry(
    entryId: number,
    value: string,
    expectedHash: string
  ): Promise<IpcResult<EntryMutationResult>>
  /** 删一个变量：清掉中心记录，并把磁盘文件里的那一行一起删掉。 */
  deleteEntry(entryId: number, expectedHash: string): Promise<IpcResult<EntryMutationResult>>
  // --- 模型凭据（阶段 3）---
  listCredentials(): Promise<IpcResult<CredentialSummary[]>>
  listProviders(): Promise<IpcResult<ProviderInfo[]>>
  suggestCredentials(projectId: number): Promise<IpcResult<CredentialSuggestion[]>>
  createCredential(request: CreateCredentialRequest): Promise<IpcResult<CredentialSummary>>
  updateCredential(request: UpdateCredentialRequest): Promise<IpcResult<CredentialSummary>>
  /** 明文 Key。只有这一个通道会返回它，且每次调用都留痕。 */
  revealCredential(credentialId: number): Promise<IpcResult<CredentialRevealResult>>
  /** 🔴 唯一会让应用发出站请求的方法。 */
  validateCredential(credentialId: number): Promise<IpcResult<CredentialValidationResult>>
  deleteCredential(credentialId: number): Promise<IpcResult<{ removed: boolean }>>
  bindCredential(request: {
    credentialId: number
    projectId: number
    environment: string
    keyVariable: string
    endpointVariable?: string | null
  }): Promise<IpcResult<CredentialBindingView[]>>
  unbindCredential(bindingId: number): Promise<IpcResult<CredentialBindingView[]>>
  previewCredentialSync(credentialId: number): Promise<IpcResult<CredentialSyncPreview>>
  /** `targets` 里的 expectedHash 来自预览，语义同 restoreFile：对不上就跳过那个目标。 */
  syncCredential(
    credentialId: number,
    targets: { bindingId: number; expectedHash: string }[]
  ): Promise<IpcResult<CredentialSyncResult>>

  listFiles(projectId: number): Promise<IpcResult<EnvFileView[]>>
  diffFile(fileId: number): Promise<IpcResult<FileDiff>>
  adoptDiskFile(fileId: number): Promise<IpcResult<AdoptResult>>
  /** `expectedHash` 是用户看到的那份差异对应的磁盘哈希，对不上就中止写入。 */
  restoreFile(fileId: number, keys: string[], expectedHash: string): Promise<IpcResult<RestoreResult>>
  listActivity(limit?: number): Promise<IpcResult<ActivityRecord[]>>
  /**
   * 订阅文件变化推送。返回退订函数。
   *
   * 🔴 退订必须传入**同一个** listener 引用。`ipcRenderer.off(channel)` 不传 handler
   * 会清掉该通道上的全部监听器，把别的订阅方一起干掉。
   */
  onFilesChanged(handler: (events: FileChangedEvent[]) => void): () => void
}
