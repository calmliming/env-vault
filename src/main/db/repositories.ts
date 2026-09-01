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
import { applyEdits, parseEnv, serializeEnv } from '../env/document.ts'
import {
  PARSER_VERSION,
  currentFileHash,
  scanSingleFile,
  scanProject,
  type ScannedFile
} from '../env/scan.ts'
import { WriteConflictError, writeEnvFileAtomic } from '../env/write.ts'
import {
  MASKED_PLACEHOLDER,
  type ActivityRecord,
  type AdoptResult,
  type ConfigEntryView,
  type EntriesQuery,
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
      fileDrifted: isDrifted(row.absolute_path, row.file_hash)
    }
  })
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

function requireFile(fileId: number): {
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

  let result
  try {
    result = writeEnvFileAtomic(file.absolute_path, content, {
      backupRoot: backupRoot(),
      expectedHash
    })
  } catch (error) {
    if (error instanceof WriteConflictError) {
      throw new RepositoryError('PATH_REJECTED', '文件在确认期间又被改动，已中止写入，请重新查看差异')
    }
    throw error
  }

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

function toRelative(projectPath: string, absolutePath: string): string {
  const normalizedProject = projectPath.replace(/\\/g, '/')
  const normalized = absolutePath.replace(/\\/g, '/')
  if (!normalized.startsWith(normalizedProject)) return normalized
  return normalized.slice(normalizedProject.length).replace(/^\/+/, '')
}

function requireUnlocked(): void {
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
