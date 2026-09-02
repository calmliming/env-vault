/**
 * 数据访问层：项目、`.env` 文件、配置项、操作记录。
 *
 * 两条贯穿全文件的规矩：
 *
 * 1. 🔴 **明文只在这一层短暂存在。** 写入前 `vault.encryptValue`，读出后按需
 *    `vault.decryptValue`。任何返回给 IPC 的结构里，敏感项都已经换成占位符 ——
 *    明文过桥只发生在 `revealEntry` 一个函数里，且每次都留一条操作记录（§7）。
 * 2. **导入是一个事务。** 项目、文件、条目要么全进要么全不进；
 *    半个项目在界面上和完整项目长得一样，但同步时会写坏文件。
 */

import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { getDatabase } from './index'
import * as vault from '../security/vault'
import { VaultError } from '../security/vault'
import { classify, compareEnvironments, shouldMask } from '../env/classify.ts'
import { diffEnvFile, summarizeDiff, type CentralEntry } from '../env/diff.ts'
import {
  applyEdits,
  entriesOf,
  formatSkeleton,
  parseEnv,
  removeEntries,
  serializeEnv
} from '../env/document.ts'
import {
  PARSER_VERSION,
  currentFileHash,
  scanSingleFile,
  scanProject,
  type ScannedFile
} from '../env/scan.ts'
import { WriteConflictError, writeEnvFileAtomic } from '../env/write.ts'
import { copyWithAutoClear } from '../clipboard/index.ts'
import type { ClipboardPort } from '../clipboard/index.ts'
import { getProvider } from '../providers/index.ts'
import {
  MASKED_PLACEHOLDER,
  type ActivityRecord,
  type AdoptResult,
  type ConfigEntryView,
  type EntriesQuery,
  type EntryMutationResult,
  type EnvFileView,
  type FileDiff,
  type ImportProjectRequest,
  type ProjectSummary,
  type RescanResult,
  type RestoreResult,
  type RevealResult,
  type ScanPreview,
  type Sensitivity,
  type ValueType
} from '@shared/ipc'

// ---------------------------------------------------------------------------
// 扫描预览（只读，不写库）
// ---------------------------------------------------------------------------

export function previewProject(rootPath: string): ScanPreview {
  const scan = scanProject(rootPath)
  const db = getDatabase()
  const existing = db
    .prepare('SELECT id FROM projects WHERE absolute_path = ?')
    .get<{ id: number }>(scan.rootPath)

  return {
    rootPath: scan.rootPath,
    gitRoot: scan.gitRoot,
    suggestedName: basename(scan.rootPath) || scan.rootPath,
    truncated: scan.truncated,
    totalEntries: scan.files.reduce((sum, file) => sum + file.entries.length, 0),
    alreadyImported: existing !== undefined,
    files: scan.files.map((file) => ({
      absolutePath: file.absolutePath,
      relativePath: file.relativePath,
      fileName: file.fileName,
      environment: file.environment,
      isTemplate: file.isTemplate,
      entryCount: file.entries.length,
      byteSize: file.byteSize,
      error: file.error
    }))
  }
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

export function importProject(request: ImportProjectRequest): ProjectSummary {
  requireUnlocked()

  const db = getDatabase()
  const scan = scanProject(request.rootPath)

  const duplicate = db
    .prepare('SELECT id FROM projects WHERE absolute_path = ?')
    .get<{ id: number }>(scan.rootPath)
  if (duplicate) {
    throw new RepositoryError('ALREADY_EXISTS', '这个目录已经在管理中')
  }

  const include = new Set(request.includePaths)
  const selected = scan.files.filter((file) => include.has(file.absolutePath) && file.error === null)

  const now = Date.now()
  const projectId = db.transaction(() => {
    const inserted = db
      .prepare(
        `INSERT INTO projects (name, absolute_path, git_root, tags, created_at, last_opened_at)
         VALUES (?, ?, ?, '[]', ?, ?)`
      )
      .run(request.name.trim() || basename(scan.rootPath), scan.rootPath, scan.gitRoot, now, now)

    const id = Number(inserted.lastInsertRowid)
    for (const file of selected) insertFile(id, file, now)

    // 扫到了但用户没勾的，记成排除项。否则下一次重扫的「自动纳管新文件」
    // 会把它们收进来，等于推翻用户刚做的决定。
    const excluded = db.prepare(
      'INSERT INTO project_exclusions (project_id, absolute_path, excluded_at) VALUES (?, ?, ?)'
    )
    for (const file of scan.files) {
      if (include.has(file.absolutePath)) continue
      excluded.run(id, file.absolutePath, now)
    }
    return id
  })

  logActivity({
    action: 'project.import',
    projectId,
    targetKind: 'project',
    targetRef: scan.rootPath,
    detail: `纳管 ${selected.length} 个文件、${selected.reduce((s, f) => s + f.entries.length, 0)} 个变量`
  })

  const summary = getProject(projectId)
  if (!summary) throw new RepositoryError('INTERNAL', '项目写入后读取失败')
  return summary
}

/** 插入一个文件及其全部条目。调用方负责开事务。 */
function insertFile(projectId: number, file: ScannedFile, now: number): number {
  const db = getDatabase()
  const inserted = db
    .prepare(
      `INSERT INTO env_files (project_id, environment, absolute_path, file_hash, parser_version, last_scanned_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(projectId, file.environment, file.absolutePath, file.fileHash, PARSER_VERSION, now)

  const fileId = Number(inserted.lastInsertRowid)
  insertEntries(fileId, file, now)
  return fileId
}

function insertEntries(fileId: number, file: ScannedFile, now: number): void {
  const db = getDatabase()
  const statement = db.prepare(
    `INSERT INTO config_entries
       (env_file_id, key, occurrence, encrypted_value, value_type, sensitivity,
        source_line, original_format, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )

  // 同名 key 在一个文件里可以出现多次，occurrence 是它们的顺序号。
  const seen = new Map<string, number>()
  for (const entry of file.entries) {
    const occurrence = seen.get(entry.key) ?? 0
    seen.set(entry.key, occurrence + 1)

    statement.run(
      fileId,
      entry.key,
      occurrence,
      vault.encryptValue(entry.value),
      entry.valueType,
      entry.sensitivity,
      entry.lineNumber,
      entry.originalFormat,
      now
    )
  }
}

// ---------------------------------------------------------------------------
// 重新扫描
// ---------------------------------------------------------------------------

/**
 * 重扫已纳管的项目。
 *
 * 🔴 只有**哈希变了**的文件才重新解析并替换条目。没变的文件一个字节都不碰 ——
 * 无条件重建会让 `config_entries.id` 每次扫描都变，而将来的凭据绑定要指向这些 id。
 *
 * 磁盘上消失的文件**不删记录**，只留着让它显示为 drifted。
 * §6.4「任何外部修改在用户确认前都不能被覆盖」的对称面是：
 * 也不能在用户没确认时替他把记录清掉。
 */
export function rescanProject(projectId: number): RescanResult {
  requireUnlocked()

  const db = getDatabase()
  const project = db
    .prepare('SELECT id, absolute_path FROM projects WHERE id = ?')
    .get<{ id: number; absolute_path: string }>(projectId)
  if (!project) throw new RepositoryError('NOT_FOUND', '项目不存在')

  const scan = scanProject(project.absolute_path)
  const byPath = new Map(scan.files.map((file) => [file.absolutePath, file]))

  const known = db
    .prepare('SELECT id, absolute_path, file_hash FROM env_files WHERE project_id = ?')
    .all<{ id: number; absolute_path: string; file_hash: string | null }>(projectId)
  const knownPaths = new Set(known.map((row) => row.absolute_path))
  const excludedPaths = new Set(
    db
      .prepare('SELECT absolute_path FROM project_exclusions WHERE project_id = ?')
      .all<{ absolute_path: string }>(projectId)
      .map((row) => row.absolute_path)
  )

  const now = Date.now()
  let addedFiles = 0
  let updatedFiles = 0
  let missingFiles = 0

  db.transaction(() => {
    for (const row of known) {
      const found = byPath.get(row.absolute_path)
      if (!found) {
        missingFiles += 1
        continue
      }
      if (found.fileHash === row.file_hash) continue

      db.prepare('DELETE FROM config_entries WHERE env_file_id = ?').run(row.id)
      insertEntries(row.id, found, now)
      db.prepare('UPDATE env_files SET file_hash = ?, last_scanned_at = ? WHERE id = ?').run(
        found.fileHash,
        now,
        row.id
      )
      updatedFiles += 1
    }

    // 真正新出现的文件自动纳管：用户已经把这个目录交给我们了，
    // 再为每个新增的 `.env.staging` 弹一次确认只会变成点掉不看的噪声。
    //
    // 🔴 但「新」的判断必须同时排掉 project_exclusions —— 用户在导入时
    // 特意去掉勾选的文件不是新文件，把它收进来是在推翻用户的决定。
    for (const file of scan.files) {
      if (knownPaths.has(file.absolutePath) || file.error !== null) continue
      if (excludedPaths.has(file.absolutePath)) continue
      insertFile(projectId, file, now)
      addedFiles += 1
    }

    db.prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run(now, projectId)
  })

  const totalEntries = countEntries(projectId)
  logActivity({
    action: 'project.rescan',
    projectId,
    targetKind: 'project',
    targetRef: project.absolute_path,
    detail: `新增 ${addedFiles}、更新 ${updatedFiles}、缺失 ${missingFiles}`
  })

  return { projectId, addedFiles, updatedFiles, missingFiles, totalEntries }
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export function listProjects(): ProjectSummary[] {
  const db = getDatabase()
  return db
    .prepare('SELECT id FROM projects ORDER BY created_at ASC')
    .all<{ id: number }>()
    .map((row) => getProject(row.id))
    .filter((project): project is ProjectSummary => project !== null)
}

export function getProject(projectId: number): ProjectSummary | null {
  const db = getDatabase()
  const row = db
    .prepare(
      `SELECT id, name, absolute_path, git_root, created_at, last_opened_at
       FROM projects WHERE id = ?`
    )
    .get<{
      id: number
      name: string
      absolute_path: string
      git_root: string | null
      created_at: number
      last_opened_at: number | null
    }>(projectId)
  if (!row) return null

  const files = db
    .prepare('SELECT environment FROM env_files WHERE project_id = ?')
    .all<{ environment: string }>(projectId)

  return {
    id: row.id,
    name: row.name,
    absolutePath: row.absolute_path,
    gitRoot: row.git_root,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
    fileCount: files.length,
    entryCount: countEntries(projectId),
    environments: [...new Set(files.map((file) => file.environment))].sort(compareEnvironments)
  }
}

function countEntries(projectId: number): number {
  const row = getDatabase()
    .prepare(
      `SELECT COUNT(*) AS n FROM config_entries
       JOIN env_files ON env_files.id = config_entries.env_file_id
       WHERE env_files.project_id = ?`
    )
    .get<{ n: number }>(projectId)
  return row?.n ?? 0
}

export function listFiles(projectId: number): EnvFileView[] {
  const db = getDatabase()
  const rows = db
    .prepare(
      `SELECT f.id, f.environment, f.absolute_path, f.file_hash, f.last_scanned_at,
              p.absolute_path AS project_path,
              (SELECT COUNT(*) FROM config_entries c WHERE c.env_file_id = f.id) AS entry_count
       FROM env_files f
       JOIN projects p ON p.id = f.project_id
       WHERE f.project_id = ?
       ORDER BY f.absolute_path ASC`
    )
    .all<{
      id: number
      environment: string
      absolute_path: string
      file_hash: string | null
      last_scanned_at: number | null
      project_path: string
      entry_count: number
    }>(projectId)

  return rows.map((row) => {
    const current = currentFileHash(row.absolute_path)
    return {
      id: row.id,
      relativePath: toRelative(row.project_path, row.absolute_path),
      fileName: basename(row.absolute_path),
      environment: row.environment,
      isTemplate: /\.(example|sample|template|dist|defaults)$/.test(basename(row.absolute_path)),
      entryCount: row.entry_count,
      storedHash: row.file_hash,
      currentHash: current,
      drifted: current === null || current !== row.file_hash,
      lastScannedAt: row.last_scanned_at
    }
  })
}

export function listEntries(query: EntriesQuery): ConfigEntryView[] {
  requireUnlocked()

  const db = getDatabase()
  const rows = db
    .prepare(
      `SELECT c.id, c.key, c.encrypted_value, c.value_type, c.sensitivity, c.source_line,
              f.id AS file_id, f.environment, f.absolute_path, f.file_hash,
              p.absolute_path AS project_path
       FROM config_entries c
       JOIN env_files f ON f.id = c.env_file_id
       JOIN projects p ON p.id = f.project_id
       WHERE f.project_id = ?${query.environment ? ' AND f.environment = ?' : ''}
       ORDER BY f.absolute_path ASC, c.source_line ASC, c.id ASC`
    )
    .all<{
      id: number
      key: string
      encrypted_value: Uint8Array | null
      value_type: string
      sensitivity: string
      source_line: number | null
      file_id: number
      environment: string
      absolute_path: string
      file_hash: string | null
      project_path: string
    }>(...(query.environment ? [query.projectId, query.environment] : [query.projectId]))

  /**
   * 已被凭据接管的变量：`环境 变量名` → 绑定信息。
   *
   * 绑定记的是 (项目, 环境, 变量名) 而不是 entry id ——
   * 重扫会重建条目 id，绑定不能跟着失效。所以这里按三元组配对。
   */
  const managed = new Map<string, ConfigEntryView['managedBy']>()
  for (const row of db
    .prepare(
      `SELECT b.id, b.credential_id, b.environment, b.key_variable, b.endpoint_variable,
              c.credential_name, c.provider_name
       FROM credential_bindings b
       JOIN model_credentials c ON c.id = b.credential_id
       WHERE b.project_id = ?`
    )
    .all<{
      id: number
      credential_id: number
      environment: string
      key_variable: string
      endpoint_variable: string | null
      credential_name: string
      provider_name: string
    }>(query.projectId)) {
    const shared = {
      bindingId: row.id,
      credentialId: row.credential_id,
      credentialName: row.credential_name,
      providerName: providerDisplayName(row.provider_name)
    }
    managed.set(`${row.environment} ${row.key_variable}`, { ...shared, role: 'key' })
    if (row.endpoint_variable) {
      managed.set(`${row.environment} ${row.endpoint_variable}`, { ...shared, role: 'endpoint' })
    }
  }

  // 每个文件只算一次哈希，不要每行都去摸一次盘。
  const driftCache = new Map<string, boolean>()
  const isDrifted = (absolutePath: string, storedHash: string | null): boolean => {
    const cached = driftCache.get(absolutePath)
    if (cached !== undefined) return cached
    const current = currentFileHash(absolutePath)
    const drifted = current === null || current !== storedHash
    driftCache.set(absolutePath, drifted)
    return drifted
  }

  return rows.map((row) => {
    const sensitivity = row.sensitivity as Sensitivity
    const masked = shouldMask(sensitivity)
    return {
      id: row.id,
      key: row.key,
      // 🔴 敏感项的明文到这里就止步了，不随列表过桥。
      displayValue: masked ? MASKED_PLACEHOLDER : decryptOrPlaceholder(row.encrypted_value),
      masked,
      valueType: row.value_type as ValueType,
      sensitivity,
      environment: row.environment,
      sourceFile: toRelative(row.project_path, row.absolute_path),
      lineNumber: row.source_line,
      fileId: row.file_id,
      fileDrifted: isDrifted(row.absolute_path, row.file_hash),
      managedBy: managed.get(`${row.environment} ${row.key}`) ?? null
    }
  })
}

/**
 * `model_credentials.provider_name` 存的是适配器 id，展示名从适配器取。
 * 存 id 而不是中文名，是为了改展示文案时不用迁移数据。
 */
function providerDisplayName(providerId: string): string {
  return getProvider(providerId)?.providerName ?? providerId
}

/**
 * 取出单条明文。这是全应用唯一会把明文送过桥的地方，所以它必须留痕。
 */
export function revealEntry(entryId: number): RevealResult {
  requireUnlocked()

  const db = getDatabase()
  const row = db
    .prepare(
      `SELECT c.id, c.key, c.encrypted_value, f.environment, f.project_id
       FROM config_entries c
       JOIN env_files f ON f.id = c.env_file_id
       WHERE c.id = ?`
    )
    .get<{
      id: number
      key: string
      encrypted_value: Uint8Array | null
      environment: string
      project_id: number
    }>(entryId)
  if (!row) throw new RepositoryError('NOT_FOUND', '配置项不存在')

  logActivity({
    action: 'entry.reveal',
    projectId: row.project_id,
    environment: row.environment,
    targetKind: 'entry',
    // 只记 key 名，绝不记值（§5.5「只保存元数据，不保存完整敏感值」）。
    targetRef: row.key,
    detail: null
  })

  return {
    id: row.id,
    key: row.key,
    value: row.encrypted_value ? vault.decryptValue(Buffer.from(row.encrypted_value)) : ''
  }
}

/**
 * 把配置值复制到系统剪贴板，并安排 30 秒后清理（计划 §7）。
 *
 * 🔴 **返回值里没有明文** —— 只有一个 id 进来、一个"多久之后清"出去。
 * 复制这条路上明文完全不进渲染层，这是它和 `revealEntry` 的根本区别
 * （后者必须过桥，因为要显示在屏幕上）。
 *
 * 记 `entry.copy` 而不是复用 `entry.reveal`：复制和查看是两种不同的暴露方式，
 * 审计时要分得开 —— **复制出去的那一份会离开本应用**，而查看不会。
 */
export async function copyEntryValue(entryId: number, port: ClipboardPort): Promise<number> {
  requireUnlocked()

  const row = getDatabase()
    .prepare(
      `SELECT c.key, c.encrypted_value, f.environment, f.project_id
       FROM config_entries c
       JOIN env_files f ON f.id = c.env_file_id
       WHERE c.id = ?`
    )
    .get<{
      key: string
      encrypted_value: Uint8Array | null
      environment: string
      project_id: number
    }>(entryId)
  if (!row) throw new RepositoryError('NOT_FOUND', '配置项不存在')

  const value = row.encrypted_value ? vault.decryptValue(Buffer.from(row.encrypted_value)) : ''
  const clearAfterMs = await copyWithAutoClear(value, port)

  logActivity({
    action: 'entry.copy',
    projectId: row.project_id,
    environment: row.environment,
    targetKind: 'entry',
    targetRef: row.key,
    detail: `${Math.round(clearAfterMs / 1000)} 秒后自动清理剪贴板`
  })

  return clearAfterMs
}

/**
 * 所有需要监听的文件。监听是全局的（不分项目）——
 * 用户在别的项目里改了文件，切回去时也该看到提醒。
 */
export function listWatchTargets(): { id: number; absolutePath: string; storedHash: string | null }[] {
  return getDatabase()
    .prepare('SELECT id, absolute_path, file_hash FROM env_files')
    .all<{ id: number; absolute_path: string; file_hash: string | null }>()
    .map((row) => ({ id: row.id, absolutePath: row.absolute_path, storedHash: row.file_hash }))
}

export function removeProject(projectId: number): boolean {
  const db = getDatabase()
  const row = db
    .prepare('SELECT absolute_path FROM projects WHERE id = ?')
    .get<{ absolute_path: string }>(projectId)
  if (!row) return false

  // env_files / config_entries 靠外键级联删除，这也是 driver 里
  // `PRAGMA foreign_keys = ON` 存在的理由。
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)

  logActivity({
    action: 'project.remove',
    projectId: null,
    targetKind: 'project',
    targetRef: row.absolute_path,
    detail: '仅移除中心记录，磁盘文件未改动'
  })
  return true
}

// ---------------------------------------------------------------------------
// §6.4 外部修改的两个方向
// ---------------------------------------------------------------------------

/** 读一个文件的中心记录（明文），供 diff 与写回用。仅主进程内部使用。 */
function centralEntriesOf(fileId: number): (CentralEntry & { sensitivity: Sensitivity })[] {
  return getDatabase()
    .prepare(
      `SELECT key, occurrence, encrypted_value, sensitivity
       FROM config_entries WHERE env_file_id = ?
       ORDER BY occurrence ASC, source_line ASC, id ASC`
    )
    .all<{
      key: string
      occurrence: number
      encrypted_value: Uint8Array | null
      sensitivity: string
    }>(fileId)
    .map((row) => ({
      key: row.key,
      occurrence: row.occurrence,
      value: row.encrypted_value ? vault.decryptValue(Buffer.from(row.encrypted_value)) : '',
      sensitivity: row.sensitivity as Sensitivity
    }))
}

/** 导出给 credentials.ts：绑定要按 (project, environment) 定位同一批文件记录。 */
export function requireFile(fileId: number): {
  id: number
  absolute_path: string
  file_hash: string | null
  environment: string
  project_id: number
  project_path: string
} {
  const row = getDatabase()
    .prepare(
      `SELECT f.id, f.absolute_path, f.file_hash, f.environment, f.project_id,
              p.absolute_path AS project_path
       FROM env_files f JOIN projects p ON p.id = f.project_id
       WHERE f.id = ?`
    )
    .get<{
      id: number
      absolute_path: string
      file_hash: string | null
      environment: string
      project_id: number
      project_path: string
    }>(fileId)
  if (!row) throw new RepositoryError('NOT_FOUND', '文件记录不存在')
  return row
}

/**
 * 逐变量对比中心记录与磁盘文件。
 *
 * 🔴 敏感项的两侧值都换成掩码占位符。用户能看到「这一项变了」，
 * 但看不到变成了什么 —— 想看具体值要回配置表点「显示」，那条路径会留痕。
 * 差异面板是个一览视图，把明文铺在上面等于绕过了 reveal 的审计。
 */
export function diffFile(fileId: number): FileDiff {
  requireUnlocked()
  const file = requireFile(fileId)

  const currentHash = currentFileHash(file.absolute_path)
  if (currentHash === null) {
    throw new RepositoryError('NOT_FOUND', '磁盘上找不到这个文件')
  }

  const central = centralEntriesOf(fileId)
  const sensitivityByPair = new Map(
    central.map((entry) => [`${entry.key} ${entry.occurrence}`, entry.sensitivity])
  )

  const disk = parseEnv(readFileSync(file.absolute_path, 'utf8'))
  const rows = diffEnvFile(central, disk)

  return {
    fileId,
    relativePath: toRelative(file.project_path, file.absolute_path),
    environment: file.environment,
    storedHash: file.file_hash,
    currentHash,
    summary: summarizeDiff(rows),
    rows: rows.map((row) => {
      // 磁盘上新增的项没有中心记录的敏感度，就地判一次。
      const sensitivity =
        sensitivityByPair.get(`${row.key} ${row.occurrence}`) ??
        classify(row.key, row.diskValue ?? '').sensitivity
      const masked = shouldMask(sensitivity)
      return {
        key: row.key,
        occurrence: row.occurrence,
        status: row.status,
        masked,
        centralPreview: row.centralValue === null ? null : masked ? MASKED_PLACEHOLDER : row.centralValue,
        diskPreview: row.diskValue === null ? null : masked ? MASKED_PLACEHOLDER : row.diskValue,
        lineNumber: row.lineNumber
      }
    })
  }
}

/**
 * 方向一：**以磁盘为准**，把文件重新解析后替换中心记录。
 * 用户在编辑器里改了 `.env`，想让 EnvVault 接受这次改动时走这条。
 */
export function adoptDiskFile(fileId: number): AdoptResult {
  requireUnlocked()
  const file = requireFile(fileId)

  const scanned = scanSingleFile(file.absolute_path, file.project_path)
  if (!scanned || scanned.error !== null) {
    throw new RepositoryError('NOT_FOUND', scanned?.error ?? '磁盘上找不到这个文件')
  }

  const db = getDatabase()
  const now = Date.now()
  db.transaction(() => {
    db.prepare('DELETE FROM config_entries WHERE env_file_id = ?').run(fileId)
    insertEntries(fileId, scanned, now)
    db.prepare('UPDATE env_files SET file_hash = ?, last_scanned_at = ? WHERE id = ?').run(
      scanned.fileHash,
      now,
      fileId
    )
  })

  logActivity({
    action: 'file.adopt',
    projectId: file.project_id,
    environment: file.environment,
    targetKind: 'file',
    targetRef: toRelative(file.project_path, file.absolute_path),
    detail: `以磁盘为准，重新记录 ${scanned.entries.length} 个变量`
  })

  return { fileId, entryCount: scanned.entries.length, newHash: scanned.fileHash }
}

/**
 * 方向二：**以中心记录为准**，把选中的变量写回磁盘文件。
 *
 * 三条硬性约束：
 * 1. 只改选中的 key，其余一个字节都不动（靠 `applyEdits` 的复用 raw 保证）；
 * 2. 写入前用 `expectedHash` 再校验一次磁盘内容 —— 从算差异到点确认之间
 *    文件可能又被改了，这时候写下去就是覆盖别人的修改（§6.4 的核心禁令）；
 * 3. 磁盘上不存在的 key **不追加**，原样报回去让调用方决定。
 *    静默追加会把中心记录里的陈旧变量塞回用户已经清理过的文件。
 */
export function restoreFileFromCentral(
  fileId: number,
  keys: readonly string[],
  /**
   * 🔴 用户看到的那份差异对应的磁盘哈希，由调用方传入 —— **不能**在这里现算。
   *
   * 现算的话这个参数永远等于当前值，守卫就成了摆设。
   * （第一版正是这么写的，验收脚本里那条"期间被外部改过就中止"因此从来没红过，
   * 直到给它补上真正的并发场景才暴露出来。）
   */
  expectedHash: string
): RestoreResult {
  requireUnlocked()
  const file = requireFile(fileId)

  if (currentFileHash(file.absolute_path) === null) {
    throw new RepositoryError('NOT_FOUND', '磁盘上找不到这个文件')
  }

  const central = centralEntriesOf(fileId)
  const wanted = new Set(keys)
  const edits = central
    .filter((entry) => wanted.has(entry.key))
    .map((entry) => ({ key: entry.key, value: entry.value, occurrence: entry.occurrence }))

  if (edits.length === 0) {
    throw new RepositoryError('INTERNAL', '没有可写回的变量')
  }

  const original = readFileSync(file.absolute_path, 'utf8')
  const applied = applyEdits(parseEnv(original), edits)
  const content = serializeEnv(applied.doc)

  const result = writeGuarded(
    file.absolute_path,
    content,
    expectedHash,
    '文件在确认期间又被改动，已中止写入，请重新查看差异'
  )

  getDatabase()
    .prepare('UPDATE env_files SET file_hash = ?, last_scanned_at = ? WHERE id = ?')
    .run(result.newHash, Date.now(), fileId)

  logActivity({
    action: 'file.restore',
    projectId: file.project_id,
    environment: file.environment,
    targetKind: 'file',
    targetRef: toRelative(file.project_path, file.absolute_path),
    // 只记 key 名与条数，不记值
    detail: `写回 ${applied.changed.length} 项${applied.missing.length > 0 ? `，${applied.missing.length} 项文件中不存在未追加` : ''}`
  })

  return {
    fileId,
    written: applied.changed.length,
    skipped: applied.missing,
    backupPath: result.backupPath,
    newHash: result.newHash
  }
}

function backupRoot(): string {
  return join(app.getPath('userData'), 'backups')
}

/**
 * 原子写入 + 把并发冲突翻译成一句用户看得懂的话。
 *
 * 导出是给 `credentials.ts` 用的：凭据的「一改多同步」写的是同一批 `.env` 文件，
 * 必须走同一条写入路径，否则备份、并发校验这些保证会在第二条路径上悄悄缺席。
 */
export function writeGuarded(
  absolutePath: string,
  content: string,
  expectedHash: string,
  conflictMessage: string
): { backupPath: string; newHash: string } {
  try {
    return writeEnvFileAtomic(absolutePath, content, { backupRoot: backupRoot(), expectedHash })
  } catch (error) {
    if (error instanceof WriteConflictError) {
      throw new RepositoryError('PATH_REJECTED', conflictMessage)
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// 编辑与删除单个变量（计划 §9 阶段 2「编辑、删除」）
// ---------------------------------------------------------------------------

interface EditableEntry {
  id: number
  key: string
  occurrence: number
  encrypted_value: Uint8Array | null
  env_file_id: number
}

interface EditContext {
  entry: EditableEntry
  file: ReturnType<typeof requireFile>
  /** 磁盘当前哈希，已经过下面两道校验。 */
  currentHash: string
  /** 磁盘当前内容。和 currentHash 是同一次读取的结果。 */
  content: string
}

/**
 * 编辑与删除共用的前置检查。两道守卫拦的是**不同的**两件事，都不能省：
 *
 * 1. **`file_hash`（库里记的）vs 磁盘现值** —— 文件有还没处理的外部改动。
 *    这时候就地写回等于替用户默默决定了 §6.4 的方向，把别人的修改覆盖掉。
 *    正确做法是先去差异面板选一个方向，所以这里直接拒绝。
 * 2. **`expectedHash`（调用方传的）vs 磁盘现值** —— 界面拿到数据之后、
 *    用户点保存之前，文件又被改了。
 *
 * 🔴 两个被比较的值都来自**外部**（一个来自数据库、一个来自调用方），
 * 不是在这里现算的。PHASE-2 §5 那个「守卫写成了摆设」的 bug，
 * 根因就是拿现算的值去和现算的值比 —— 那种断言永远绿，因为它够不着判断。
 */
function requireEditableEntry(entryId: number, expectedHash: string): EditContext {
  requireUnlocked()

  const entry = getDatabase()
    .prepare(
      'SELECT id, key, occurrence, encrypted_value, env_file_id FROM config_entries WHERE id = ?'
    )
    .get<EditableEntry>(entryId)
  if (!entry) throw new RepositoryError('NOT_FOUND', '配置项不存在')

  const file = requireFile(entry.env_file_id)
  const currentHash = currentFileHash(file.absolute_path)
  if (currentHash === null) {
    throw new RepositoryError('NOT_FOUND', '磁盘上找不到这个文件')
  }
  if (currentHash !== file.file_hash) {
    throw new RepositoryError(
      'PATH_REJECTED',
      '这个文件在外部被改过，请先在「查看差异」里处理，再编辑变量'
    )
  }
  if (currentHash !== expectedHash) {
    throw new RepositoryError('PATH_REJECTED', '文件在你查看之后又被改动，已中止，请刷新后重试')
  }

  return { entry, file, currentHash, content: readFileSync(file.absolute_path, 'utf8') }
}

/**
 * 这个变量是不是某条绑定的 **Key 变量**（阶段 3）。
 *
 * 按 (项目, 环境, 变量名) 配对而不是按 entry id：重扫会重建条目 id，
 * 绑定不能跟着失效。
 *
 * 只认 Key 变量，不认地址变量 —— 同步写的只有 Key，所以只有 Key 是
 * 「凭据说了算」的。把地址也锁上就是禁止一个我们其实并不管理的东西。
 */
function keyBindingOf(entry: { key: string }, file: { project_id: number; environment: string }): {
  id: number
  credential_name: string
} | null {
  return (
    getDatabase()
      .prepare(
        `SELECT b.id, c.credential_name
         FROM credential_bindings b
         JOIN model_credentials c ON c.id = b.credential_id
         WHERE b.project_id = ? AND b.environment = ? AND b.key_variable = ?`
      )
      .get<{ id: number; credential_name: string }>(
        file.project_id,
        file.environment,
        entry.key
      ) ?? null
  )
}

/**
 * 写盘之后，把中心记录里跟着文件内容走的那几列重新对齐：
 * 文件哈希、每一条的行号、以及格式骨架。
 *
 * 为什么是「重新解析写出去的内容」而不是就地做偏移算术：删一行会让它之后
 * 所有变量的行号整体上移，改一个值也可能改变行数（多行值改成单行，或反过来）。
 * 拿写出去的内容重新解析一遍是唯一不需要算偏移的办法，也就不会算错。
 *
 * ⚠️ 只 UPDATE，不重建记录 —— `config_entries.id` 必须保持稳定，
 * 阶段 3 的凭据绑定要指向这些 id（同 `rescanProject` 的理由）。
 */
/** 导出给 credentials.ts：同步写盘后同样要把行号、骨架、哈希对齐。 */
export function syncFileState(fileId: number, newHash: string, content: string, now: number): void {
  const db = getDatabase()
  db.prepare('UPDATE env_files SET file_hash = ?, last_scanned_at = ? WHERE id = ?').run(
    newHash,
    now,
    fileId
  )

  const statement = db.prepare(
    `UPDATE config_entries SET source_line = ?, original_format = ?
     WHERE env_file_id = ? AND key = ? AND occurrence = ?`
  )
  const seen = new Map<string, number>()
  for (const node of entriesOf(parseEnv(content))) {
    const occurrence = seen.get(node.key) ?? 0
    seen.set(node.key, occurrence + 1)
    // 🔴 存骨架不存原始行：original_format 这一列不加密。
    statement.run(node.lineNumber, formatSkeleton(node), fileId, node.key, occurrence)
  }
}

/**
 * 改一个变量的值：更新中心记录，并立刻把新值原子写回磁盘文件。
 *
 * 「立刻写盘」而不是攒着等一次同步，是因为 drift 是靠哈希比对算出来的 ——
 * 只改中心记录不会让文件变成 drifted，界面会显示「已同步」而实际上不一致。
 * 要支持攒着就得引入一个 pending 标记和一整套新的状态语义；
 * 一次动作一个确定结果要简单得多，而写回的机器本来就已经全部就位。
 */
export function updateEntryValue(
  entryId: number,
  newValue: string,
  expectedHash: string
): EntryMutationResult {
  const { entry, file, currentHash, content: original } = requireEditableEntry(entryId, expectedHash)

  // 🔴 真源只能有一个。这个变量归某个凭据管时，改动必须从凭据发起，
  // 否则「改一次同步到多处」就成了空话 —— 每一处都能各自改的话，
  // 它们迟早不一样，而且没有任何办法回答"哪个才算数"。
  const binding = keyBindingOf(entry, file)
  if (binding) {
    throw new RepositoryError(
      'PATH_REJECTED',
      `这个变量由凭据「${binding.credential_name}」管理，请在模型凭据页修改后同步`
    )
  }

  const oldValue = entry.encrypted_value
    ? vault.decryptValue(Buffer.from(entry.encrypted_value))
    : ''
  if (oldValue === newValue) {
    // 值没变就什么都不做：不写盘、不备份，也不在操作记录里留一条「改了但没改」。
    return {
      entryId,
      key: entry.key,
      fileId: file.id,
      written: false,
      backupPath: null,
      newHash: currentHash
    }
  }

  const applied = applyEdits(parseEnv(original), [
    { key: entry.key, value: newValue, occurrence: entry.occurrence }
  ])
  if (applied.missing.length > 0) {
    // 哈希对得上却找不到这一行，说明中心记录和磁盘的对应关系已经断了。
    // 与其猜一个位置写下去，不如让这次操作失败。
    throw new RepositoryError('NOT_FOUND', '这个变量在磁盘文件里已经找不到了，请先重新扫描')
  }

  // `changed` 为空但 key 找得到，说明磁盘上那一行本来就是新值 ——
  // 中心记录和磁盘在这个 key 上早就分叉了（上一次「以记录为准」只勾了部分变量
  // 就会留下这种状态，哈希仍然是对的）。这时文件不用动，但记录要跟着对齐。
  const touchesDisk = applied.changed.length > 0
  const content = touchesDisk ? serializeEnv(applied.doc) : original
  const result = touchesDisk
    ? writeGuarded(
        file.absolute_path,
        content,
        expectedHash,
        '文件在保存期间又被改动，已中止写入，请刷新后重试'
      )
    : null

  // 重新分类：值变了，类型和敏感度可能跟着变（把普通值改成一把真 Key，
  // 下一秒就该被掩码起来）。key 没变，所以命名规则那一路的判断不受影响。
  const { valueType, sensitivity } = classify(entry.key, newValue)
  const now = Date.now()
  const db = getDatabase()
  db.transaction(() => {
    db.prepare(
      `UPDATE config_entries
       SET encrypted_value = ?, value_type = ?, sensitivity = ?, updated_at = ?
       WHERE id = ?`
    ).run(vault.encryptValue(newValue), valueType, sensitivity, now, entryId)
    syncFileState(file.id, result?.newHash ?? currentHash, content, now)
  })

  const relativePath = toRelative(file.project_path, file.absolute_path)
  logActivity({
    action: 'entry.update',
    projectId: file.project_id,
    environment: file.environment,
    targetKind: 'entry',
    // 只记 key 名，新旧值一个都不记（§5.5）。
    targetRef: entry.key,
    detail: touchesDisk
      ? `值已更新并写回 ${relativePath}`
      : `值已更新；${relativePath} 里本来就是这个值，未改动文件`
  })

  return {
    entryId,
    key: entry.key,
    fileId: file.id,
    written: touchesDisk,
    backupPath: result?.backupPath ?? null,
    newHash: result?.newHash ?? currentHash
  }
}

/**
 * 删一个变量：清掉中心记录，并把磁盘文件里的那一行一起删掉。
 *
 * 之所以两边都删：只删记录的话，下一次重扫或「以磁盘为准」会把它原样收回来 ——
 * 删除看起来自己撤销了自己，这是最糟糕的一种结果。
 *
 * 磁盘上本来就没有这一行时（中心记录里的陈旧条目），只清记录，文件一个字节不碰。
 */
export function deleteEntry(entryId: number, expectedHash: string): EntryMutationResult {
  const { entry, file, currentHash, content: original } = requireEditableEntry(entryId, expectedHash)

  const removal = removeEntries(parseEnv(original), [
    { key: entry.key, occurrence: entry.occurrence }
  ])
  const touchesDisk = removal.removed.length > 0
  const content = touchesDisk ? serializeEnv(removal.doc) : original
  const written = touchesDisk
    ? writeGuarded(
        file.absolute_path,
        content,
        expectedHash,
        '文件在删除期间又被改动，已中止写入，请刷新后重试'
      )
    : null

  // 删除是允许的（变量真的要没了），但绑定必须跟着走 ——
  // 留下一条指向已删变量的绑定，下次同步会静默地少写一处。
  const binding = keyBindingOf(entry, file)

  const now = Date.now()
  const db = getDatabase()
  db.transaction(() => {
    db.prepare('DELETE FROM config_entries WHERE id = ?').run(entryId)
    if (binding) db.prepare('DELETE FROM credential_bindings WHERE id = ?').run(binding.id)
    // 🔴 删掉重复 key 里的一条，会让它后面几条在文件里的序号整体前移。
    // 中心记录不跟着改，occurrence 就和磁盘对不上了 —— 下次编辑那个 key
    // 会按错误的序号去改**另一行**，而且不会报任何错。
    db.prepare(
      `UPDATE config_entries SET occurrence = occurrence - 1
       WHERE env_file_id = ? AND key = ? AND occurrence > ?`
    ).run(entry.env_file_id, entry.key, entry.occurrence)
    syncFileState(file.id, written?.newHash ?? currentHash, content, now)
  })

  logActivity({
    action: 'entry.delete',
    projectId: file.project_id,
    environment: file.environment,
    targetKind: 'entry',
    targetRef: entry.key,
    detail: [
      touchesDisk
        ? `已从 ${toRelative(file.project_path, file.absolute_path)} 删除该变量`
        : '磁盘文件里本来就没有这一行，只清除了中心记录',
      binding ? `并解除了与凭据「${binding.credential_name}」的绑定` : null
    ]
      .filter(Boolean)
      .join('；')
  })

  return {
    entryId,
    key: entry.key,
    fileId: file.id,
    written: touchesDisk,
    backupPath: written?.backupPath ?? null,
    newHash: written?.newHash ?? currentHash
  }
}

// ---------------------------------------------------------------------------
// 操作记录
// ---------------------------------------------------------------------------

interface ActivityInput {
  action: string
  projectId?: number | null
  environment?: string | null
  targetKind?: string | null
  targetRef?: string | null
  detail?: string | null
}

export function logActivity(input: ActivityInput): void {
  getDatabase()
    .prepare(
      `INSERT INTO activity_log (action, project_id, environment, target_kind, target_ref, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.action,
      input.projectId ?? null,
      input.environment ?? null,
      input.targetKind ?? null,
      input.targetRef ?? null,
      input.detail ?? null,
      Date.now()
    )
}

export function listActivity(limit = 50): ActivityRecord[] {
  return getDatabase()
    .prepare(
      `SELECT a.id, a.action, a.environment, a.target_kind, a.target_ref, a.detail, a.created_at,
              p.name AS project_name
       FROM activity_log a
       LEFT JOIN projects p ON p.id = a.project_id
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ?`
    )
    .all<{
      id: number
      action: string
      environment: string | null
      target_kind: string | null
      target_ref: string | null
      detail: string | null
      created_at: number
      project_name: string | null
    }>(Math.min(Math.max(limit, 1), 500))
    .map((row) => ({
      id: row.id,
      action: row.action,
      projectName: row.project_name,
      environment: row.environment,
      targetKind: row.target_kind,
      targetRef: row.target_ref,
      detail: row.detail,
      createdAt: row.created_at
    }))
}

// ---------------------------------------------------------------------------

function decryptOrPlaceholder(blob: Uint8Array | null): string {
  if (!blob) return ''
  try {
    return vault.decryptValue(Buffer.from(blob))
  } catch {
    // 解不开通常意味着记录损坏或换过主密钥。显示出来比整页报错有用。
    return '（无法解密）'
  }
}

/** 导出给 credentials.ts。 */
export function toRelative(projectPath: string, absolutePath: string): string {
  const normalizedProject = projectPath.replace(/\\/g, '/')
  const normalized = absolutePath.replace(/\\/g, '/')
  if (!normalized.startsWith(normalizedProject)) return normalized
  return normalized.slice(normalizedProject.length).replace(/^\/+/, '')
}

/** 导出给 credentials.ts。 */
export function requireUnlocked(): void {
  const status = vault.getStatus()
  if (status.state === 'unlocked') return
  if (status.state === 'uninitialized') {
    throw new VaultError('VAULT_UNINITIALIZED', '请先创建本地 Vault')
  }
  throw new VaultError('VAULT_LOCKED', 'Vault 已锁定，请先解锁')
}

/** 路径存在性检查，给 IPC 层用。 */
export function directoryExists(path: string): boolean {
  return existsSync(path)
}

export class RepositoryError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'ALREADY_EXISTS'
      | 'PATH_REJECTED'
      | 'DATABASE_ERROR'
      | 'INVALID_ARGUMENT'
      | 'INTERNAL',
    message: string
  ) {
    super(message)
    this.name = 'RepositoryError'
  }
}
