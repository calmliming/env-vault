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
import type { RiskLevel } from './security-types.ts'

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
  projectsDiscover: 'projects:discover',
  projectsImportBulk: 'projects:importBulk',
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
  credentialsVersions: 'credentials:versions',
  securityScan: 'security:scan',
  clipboardCopyEntry: 'clipboard:copy-entry',
  clipboardCopyCredential: 'clipboard:copy-credential',
  filesList: 'files:list',
  filesDiff: 'files:diff',
  filesAdopt: 'files:adopt',
  filesRestore: 'files:restore',
  templatePreview: 'template:preview',
  templateWrite: 'template:write',
  transferExportPreview: 'transfer:exportPreview',
  transferExport: 'transfer:export',
  transferPickPackage: 'transfer:pickPackage',
  transferImportPreview: 'transfer:importPreview',
  transferImport: 'transfer:import',
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

/**
 * 目录遍历没走完的原因。🔴 两者的确定性不同，界面必须分开措辞：
 *
 *   'files' —— 收满了文件数上限，**确实**有 `.env*` 没收进来。
 *   'depth' —— 有目录深过层数上限没进去，**不一定**漏了东西：
 *              深的那一支里可能一个 `.env` 都没有（Next.js 路由目录就是典型）。
 *
 * ⚠️ 与 `main/env/scan.ts` 里同名的 union 必须保持一致。那边不能 import
 * `@shared/*` 别名（要能被 `node --test` 直接跑，见 discover.ts 顶部），
 * 所以只能各写一份，改动时两处一起改。
 */
export type ScanTruncation = 'depth' | 'files'

/** 只读扫描的结果。对应 §6.1 步骤 3「展示发现的文件和变量数量，不立即修改文件」。 */
export interface ScanPreview {
  rootPath: string
  gitRoot: string | null
  /** 按目录名给出的项目名建议，用户可改。 */
  suggestedName: string
  files: ScanPreviewFile[]
  /** 遍历没走完的原因，null 表示扫全了。 */
  truncatedBy: ScanTruncation | null
  totalEntries: number
  /** 这个路径已经被纳管过了。 */
  alreadyImported: boolean
}

/**
 * 从一个父目录发现出来的、可以纳管的项目（阶段 6）。
 * 每一项都是**独立的仓库**，各自有正确的 gitRoot —— 这是它存在的理由，见
 * `env/discover.ts` 顶部。
 */
export interface DiscoveredProjectPreview {
  rootPath: string
  suggestedName: string
  /** 不在任何 Git 仓库里。仍可纳管，但安全检查那一半会如实说「查不了」。 */
  isGitRepo: boolean
  alreadyImported: boolean
  files: ScanPreviewFile[]
  totalEntries: number
  /** 这个仓库自己的扫描没走完的原因，null 表示扫全了。 */
  truncatedBy: ScanTruncation | null
}

export interface DiscoveryPreview {
  /** 选中的父目录。 */
  rootPath: string
  /** 选中目录本身就是一个仓库，此时 projects 只有它一个。 */
  startIsRepo: boolean
  /** 发现阶段触到了上限，还有仓库没找出来。 */
  truncated: boolean
  projects: DiscoveredProjectPreview[]
}

export interface BulkImportResult {
  imported: ProjectSummary[]
  /** 没导进来的，以及为什么。🔴 逐个报，不是整批失败。 */
  skipped: { rootPath: string; reason: string }[]
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

/**
 * 分页读操作记录的结果。
 *
 * 带 `total` 而不是只回一页，是因为界面要算总页数、要说「共 N 条」。
 * 早先这个通道直接回 `ActivityRecord[]`，界面只好把「最近 N 条」绑在
 * `records.length` 上 —— 那个数在到达上限之前一直是对的，到了上限就开始
 * 撒谎，而且没有任何办法知道后面还有多少。
 *
 * 两个数由主进程在同一个读事务里查出来，见 repositories.listActivity。
 */
export interface ActivityPage {
  records: ActivityRecord[]
  /** 库里的总条数，不受 limit/offset 影响。 */
  total: number
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

/**
 * 凭据换过的每一代 Key（阶段 4b）。
 *
 * 🔴 这里**没有 Key**，库里也没存过 —— `credential_versions` 表里
 * 压根没有密文那一列。留着旧密钥是纯粹的负债：轮换的全部意义就是让旧的作废，
 * 而一个能翻出所有历史 Key 的数据库，会让"越勤于轮换、泄漏后果越严重"。
 *
 * 指纹留着是有用的：它足以在别处（另一个项目、一份旧备份）**认出**
 * 一把已经作废的 Key，而从指纹反推不回 Key 本身（HMAC，见 PHASE-3 §4）。
 */
export interface CredentialVersion {
  /** 第几代，从 1 开始。 */
  version: number
  fingerprint: string
  lastFour: string
  createdAt: number
  /** 被下一次轮换取代的时刻。当前这一代是 null。 */
  revokedAt: number | null
}

/** 复制到剪贴板的结果。🔴 里面没有明文，只有"多久之后会清"。 */
export interface ClipboardCopyResult {
  clearAfterMs: number
}

/**
 * 安全检查里单个文件的结论（阶段 4）。
 *
 * 🔴 这个类型里**没有任何能放配置值的字段** —— 只有计数。
 * 不是靠主进程自觉不填，是类型上就填不进去。
 */
export interface FileRisk {
  /** 项目内相对路径。 */
  relativePath: string
  fileName: string
  environment: string
  isTemplate: boolean
  /** 已经导入中心库，还是只在磁盘上发现的。 */
  managed: boolean
  /** 文件当前还在磁盘上。已纳管但被删掉的文件仍然会出现在报告里。 */
  onDisk: boolean
  /**
   * 被 Git 跟踪 / 被忽略规则覆盖。
   * 🔴 `null` 是「没查出来」，不是「否」—— git 不可用时两个都是 null。
   */
  tracked: boolean | null
  ignored: boolean | null
  /** 命中的忽略规则，形如 `.gitignore:3:.env*`。 */
  ignoreRule: string | null
  entryCount: number
  highCount: number
  sensitiveCount: number
  level: RiskLevel
  /** 为什么是这个等级。 */
  reason: string
  /** 该怎么办。没有可执行动作时为 null。 */
  remedy: string | null
}

export interface SecurityReport {
  projectId: number
  projectName: string
  gitRoot: string | null
  /**
   * 非 null 表示 Git 状态这一半没查出来（没装 git、或不在仓库里），
   * 此时所有 `tracked` / `ignored` 都是 null，等级都是 unknown。
   */
  gitUnavailable: string | null
  files: FileRisk[]
  summary: { critical: number; warning: number; unknown: number; ok: number }
  /** 目录遍历没走完的原因，null 表示扫全了。 */
  truncatedBy: ScanTruncation | null
  scannedAt: number
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
// `.env.example` 生成（阶段 5b）
// ---------------------------------------------------------------------------

/** 生成结果里仍能搜到源文件敏感值的位置。🔴 只有 key 名和行号，不含值。 */
export interface TemplateLeakView {
  lineNumber: number
  key: string
}

export interface TemplatePreview {
  /** 源文件在项目里的相对路径。 */
  sourceRelativePath: string
  /** 模板会写到哪（项目内相对路径）。固定是同目录下的 `.env.example`。 */
  targetRelativePath: string
  /** 目标已存在就是覆盖，界面必须说清楚。 */
  targetExists: boolean
  /**
   * 目标文件当前的磁盘哈希；不存在时为 null。
   * 写入时原样回传，语义同 `restoreFile`：「我这个决定是基于哪个版本做的」。
   */
  targetHash: string | null
  /** 生成结果全文。🔴 值全部清空，所以这一段不含明文，可以直接铺在界面上。 */
  content: string
  /** 进了模板的变量数。 */
  entryCount: number
  /** 读不懂、已被略去的行数。 */
  droppedLines: number
  /** 🔴 非空表示还能搜到源文件的敏感值。界面必须拦住，主进程也会拒绝写。 */
  leaks: TemplateLeakView[]
}

export interface TemplateWriteResult {
  targetRelativePath: string
  entryCount: number
  bytesWritten: number
  /** 覆盖已有文件时的备份路径；新建时为 null。 */
  backupPath: string | null
}

// ---------------------------------------------------------------------------
// 加密导出 / 导入（阶段 5c）
// ---------------------------------------------------------------------------

export interface ExportPreviewProject {
  projectId: number
  name: string
  absolutePath: string
  fileCount: number
  entryCount: number
}

export interface ExportPreview {
  projects: ExportPreviewProject[]
  /** 库里有多少条模型凭据。界面据此决定要不要显示那个默认不勾的开关。 */
  credentialCount: number
}

export interface ExportResult {
  targetPath: string
  projectCount: number
  entryCount: number
  credentialCount: number
  bytesWritten: number
}

export interface ImportPreviewFile {
  relativePath: string
  environment: string
  /** 本机中心记录里已经有这个文件了，还是全新的。 */
  status: 'new' | 'existing'
  /** 包里有、本机没有的变量数。 */
  addedCount: number
  /** 两边都有但值不同的变量数。 */
  changedCount: number
  /** 两边都有且值相同的变量数。 */
  sameCount: number
  /** 目标路径当前在磁盘上存在。导入不写磁盘，这只是给用户的一个事实。 */
  onDisk: boolean
}

export interface ImportPreviewProject {
  name: string
  /** 导出那台机器上的绝对路径。 */
  absolutePath: string
  status: 'new' | 'existing'
  /** 这个路径在**本机**存在吗。换机器导入时通常不存在。 */
  rootExistsOnDisk: boolean
  files: ImportPreviewFile[]
}

export interface ImportPreviewCredential {
  providerName: string
  credentialName: string
  /** 🔴 只给尾四位，不给 Key —— 和凭据列表同一条规矩。 */
  lastFour: string
  bindingCount: number
  status: 'new' | 'existing'
}

export interface ImportPreview {
  exportedAt: number
  projects: ImportPreviewProject[]
  credentials: ImportPreviewCredential[]
}

export interface ImportResult {
  projectsCreated: number
  filesCreated: number
  entriesAdded: number
  entriesUpdated: number
  credentialsCreated: number
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
  /**
   * 从一个父目录发现多个仓库（阶段 6）。只读，不写库。
   * 🔴 每个发现出来的项目都是独立仓库，各自有正确的 gitRoot ——
   * 那正是这条通道存在的理由，见 `env/discover.ts` 顶部。
   */
  [CHANNELS.projectsDiscover]: { request: { rootPath: string }; response: DiscoveryPreview }
  /** 批量纳管。逐项目一个事务，撞车的跳过并逐个报出来，不整批失败。 */
  [CHANNELS.projectsImportBulk]: {
    request: { projects: ImportProjectRequest[] }
    response: BulkImportResult
  }
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
  /**
   * 🔴 全应用唯一会执行外部程序的通道（它会起 git 子进程）。
   * 和验证请求不同，这个是**只读、本地、无副作用**的，所以允许打开页面时
   * 自动跑 —— 一个需要先点一下才肯工作的安全检查，等于没有。
   */
  [CHANNELS.credentialsVersions]: {
    request: { credentialId: number }
    response: CredentialVersion[]
  }
  [CHANNELS.securityScan]: { request: { projectId: number }; response: SecurityReport }
  /**
   * 🔴 复制走主进程，所以**明文不为了复制而过桥**：
   * 只有一个 id 进去、一个「多久之后清」出来。
   * 这是它和 `entries:reveal` / `credentials:reveal` 的根本区别 ——
   * 那两个必须过桥，因为值要显示在屏幕上。
   */
  [CHANNELS.clipboardCopyEntry]: {
    request: { entryId: number }
    response: ClipboardCopyResult
  }
  [CHANNELS.clipboardCopyCredential]: {
    request: { credentialId: number }
    response: ClipboardCopyResult
  }
  [CHANNELS.filesList]: { request: { projectId: number }; response: EnvFileView[] }
  [CHANNELS.filesDiff]: { request: { fileId: number }; response: FileDiff }
  [CHANNELS.filesAdopt]: { request: { fileId: number }; response: AdoptResult }
  [CHANNELS.filesRestore]: {
    request: { fileId: number; keys: string[]; expectedHash: string }
    response: RestoreResult
  }
  [CHANNELS.templatePreview]: { request: { fileId: number }; response: TemplatePreview }
  /**
   * 🔴 请求里**没有 content**：模板由主进程重新生成，不接受渲染层送来的内容。
   * 接受的话等于给渲染层开了一个「往任意 .env.example 写任意字节」的原语，
   * 预览里那份文本就只是显示用的。
   *
   * `expectedTargetHash` 为 null 的语义是「我断言这个文件当时不存在」，
   * **不是**「跳过校验」—— 主进程会去确认它确实不存在，见 ipc/index.ts。
   */
  [CHANNELS.templateWrite]: {
    request: { fileId: number; expectedTargetHash: string | null }
    response: TemplateWriteResult
  }
  [CHANNELS.transferExportPreview]: { request: void; response: ExportPreview }
  /**
   * 🔴 全应用**最宽的一条明文出口**：一次把选中项目的全部值（可能还有全部模型
   * Key）写成一个文件。所以它必须带口令，而且没有"不加密"这个选项。
   *
   * `passphrase` 是**渲染层 → 主进程**方向的秘密，和明文出主进程是反方向：
   * 用户在界面上输入它，主进程拿它派生密钥，它不进返回值、不进操作记录、
   * 不进任何日志。
   */
  [CHANNELS.transferExport]: {
    request: {
      projectIds: number[]
      includeCredentials: boolean
      passphrase: string
    }
    /** null 表示用户在保存对话框里取消了。保存对话框由主进程弹，见 ipc/index.ts。 */
    response: ExportResult | null
  }
  /**
   * 选一个导出包。刻意是**专用**通道而不是通用的「打开任意文件」——
   * 后者会给渲染层一个能读任意路径的口子，而白名单的意义就在于每个口都窄。
   * 它顺带只读包头做一次识别，好在问口令**之前**就能说"这不是个导出包"。
   */
  [CHANNELS.transferPickPackage]: {
    request: void
    response: { sourcePath: string; version: number } | null
  }
  [CHANNELS.transferImportPreview]: {
    request: { sourcePath: string; passphrase: string }
    response: ImportPreview
  }
  /**
   * 🔴 导入**只写中心记录，不碰磁盘上的 .env**。要把值落到文件，走既有的
   * 「以记录为准写回」—— 那条路自带备份、并发校验和逐变量确认。
   */
  [CHANNELS.transferImport]: {
    request: {
      sourcePath: string
      passphrase: string
      fileKeys: string[]
      credentialNames: string[]
    }
    response: ImportResult
  }
  [CHANNELS.activityList]: {
    request: { limit?: number; offset?: number }
    response: ActivityPage
  }
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
  /** 从一个父目录发现多个仓库，每个各自成为一个项目。只读。 */
  discoverProjects(rootPath: string): Promise<IpcResult<DiscoveryPreview>>
  /** 批量纳管。跳过的会逐个报出来，不是整批失败。 */
  importProjects(projects: ImportProjectRequest[]): Promise<IpcResult<BulkImportResult>>
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

  listCredentialVersions(credentialId: number): Promise<IpcResult<CredentialVersion[]>>

  /** 🔴 唯一会让应用执行外部程序的方法（起 git 子进程）。 */
  scanSecurity(projectId: number): Promise<IpcResult<SecurityReport>>

  /** 🔴 复制不需要明文过桥：只给 id，拿回「多久之后清」。 */
  copyEntryValue(entryId: number): Promise<IpcResult<ClipboardCopyResult>>
  copyCredentialKey(credentialId: number): Promise<IpcResult<ClipboardCopyResult>>

  listFiles(projectId: number): Promise<IpcResult<EnvFileView[]>>
  diffFile(fileId: number): Promise<IpcResult<FileDiff>>
  adoptDiskFile(fileId: number): Promise<IpcResult<AdoptResult>>
  /** `expectedHash` 是用户看到的那份差异对应的磁盘哈希，对不上就中止写入。 */
  restoreFile(fileId: number, keys: string[], expectedHash: string): Promise<IpcResult<RestoreResult>>

  /** 预览由这个环境文件生成的 `.env.example`。只读，不写盘。 */
  previewTemplate(fileId: number): Promise<IpcResult<TemplatePreview>>
  /**
   * 写出 `.env.example`。内容由主进程重新生成，渲染层送不进来。
   *
   * `expectedTargetHash` 取自预览：目标已存在时是它当时的哈希，
   * 不存在时是 null（断言「那会儿它不存在」，不是跳过校验）。
   */
  writeTemplate(
    fileId: number,
    expectedTargetHash: string | null
  ): Promise<IpcResult<TemplateWriteResult>>

  // --- 加密导出 / 导入（阶段 5c）---
  previewExport(): Promise<IpcResult<ExportPreview>>
  /**
   * 🔴 最宽的一条明文出口。口令是渲染层 → 主进程方向的秘密，
   * 不进返回值、不进操作记录、不进日志。保存位置由主进程弹对话框选，
   * 返回 null 表示用户取消了。
   */
  exportPackage(request: {
    projectIds: number[]
    includeCredentials: boolean
    passphrase: string
  }): Promise<IpcResult<ExportResult | null>>
  pickPackage(): Promise<IpcResult<{ sourcePath: string; version: number } | null>>
  previewImport(sourcePath: string, passphrase: string): Promise<IpcResult<ImportPreview>>
  /** 🔴 只写中心记录，不碰磁盘上的 .env。 */
  importPackage(request: {
    sourcePath: string
    passphrase: string
    fileKeys: string[]
    credentialNames: string[]
  }): Promise<IpcResult<ImportResult>>

  listActivity(limit?: number, offset?: number): Promise<IpcResult<ActivityPage>>
  /**
   * 订阅文件变化推送。返回退订函数。
   *
   * 🔴 退订必须传入**同一个** listener 引用。`ipcRenderer.off(channel)` 不传 handler
   * 会清掉该通道上的全部监听器，把别的订阅方一起干掉。
   */
  onFilesChanged(handler: (events: FileChangedEvent[]) => void): () => void
}
