/**
 * 加密导出 / 导入导出包的接线（开发计划 §7、§9 阶段 5，阶段 5c）。
 *
 * 包格式与口令加解密在 `transfer/package.ts`（纯 node:crypto，可 node --test）；
 * 这里只负责「从库里收集出什么」和「把包里的东西写回库」。
 *
 * ## 🔴 导出是第五条明文出口，也是最宽的一条
 *
 * 前面四条一次只放走一个值（reveal / copy）或一个环境（CLI 注入）。
 * 导出一次放走**选中项目的全部值**，可能还带上全部模型 Key。所以：
 *
 *   - 必须有口令，不给"不加密导出"这个选项（5c 范围，见 PHASE-5C §6）；
 *   - 凭据默认**不勾**，勾的时候单独警示；
 *   - 操作记录标橙色，并记下"导了几个项目、带没带凭据"，但不记任何值。
 *
 * ## 🔴 导入只写中心记录，绝不碰磁盘上的 .env
 *
 * 这是有意的收窄。导入若直接往磁盘写，就成了一条全新的、绕过 §6.4 的写盘路径 ——
 * 而「任何外部修改在用户确认前都不能被覆盖」正是这个应用最核心的禁令。
 * 导入之后，用户走既有的「以记录为准写回」把值落到磁盘，那条路自带备份、
 * 并发校验和逐变量确认。**别为了省一步而在这里加写盘。**
 *
 * ## 合并语义：只增不删
 *
 * 导入一个已存在的文件时，包里有而本机没有的变量会被加进来、值不同的会被更新，
 * 本机独有的变量**不动**。所以导入不是"恢复到快照那一刻"——
 * 备份之后删掉的变量不会因为导入而回来。这一点在界面上直说，
 * 因为"以为恢复了其实没恢复"比"没恢复"更糟。
 */

import { basename } from 'node:path'
import { existsSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { getDatabase } from './index'
import * as vault from '../security/vault'
import { RepositoryError, logActivity, requireUnlocked, toRelative } from './repositories'
import { classify } from '../env/classify.ts'
import { currentFileHash } from '../env/scan.ts'
import { PARSER_VERSION } from '../env/scan.ts'
import type {
  ExportPreview,
  ImportPreview,
  ImportPreviewFile,
  ImportPreviewProject,
  ImportResult
} from '@shared/ipc'

/** 包内 JSON 的形状。改它必须同时把 `formatVersion` 加一。 */
const PAYLOAD_VERSION = 1

interface PayloadEntry {
  key: string
  occurrence: number
  value: string
}

interface PayloadFile {
  /** 项目内相对路径。**不存绝对路径** —— 换台机器项目根就不一样了。 */
  relativePath: string
  environment: string
  entries: PayloadEntry[]
}

interface PayloadProject {
  name: string
  /** 导出那台机器上的绝对路径。只用于给用户当提示，导入时可以重新指定。 */
  absolutePath: string
  files: PayloadFile[]
}

interface PayloadCredential {
  providerName: string
  credentialName: string
  endpoint: string
  apiKey: string
  tags: string
  notes: string | null
  /**
   * 绑定按 (项目名, 环境, 变量名) 记，不按 id ——
   * 和 HANDOFF §5 那条「绑定不按 config_entries.id 配对」同一个理由，
   * 何况 id 换台机器根本没有意义。
   */
  bindings: {
    projectName: string
    environment: string
    keyVariable: string
    endpointVariable: string | null
  }[]
}

interface Payload {
  formatVersion: number
  exportedAt: number
  projects: PayloadProject[]
  credentials: PayloadCredential[]
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/** 导出前给用户看的清单：有哪些项目、各自多少变量、有多少条凭据。 */
export function previewExport(): ExportPreview {
  const db = getDatabase()
  const projects = db
    .prepare(
      `SELECT p.id, p.name, p.absolute_path,
              (SELECT COUNT(*) FROM env_files f WHERE f.project_id = p.id) AS file_count,
              (SELECT COUNT(*) FROM config_entries c
                 JOIN env_files f2 ON f2.id = c.env_file_id
                WHERE f2.project_id = p.id) AS entry_count
         FROM projects p ORDER BY p.name ASC`
    )
    .all<{
      id: number
      name: string
      absolute_path: string
      file_count: number
      entry_count: number
    }>()

  const credentialCount = db
    .prepare('SELECT COUNT(*) AS n FROM model_credentials')
    .get<{ n: number }>()

  return {
    projects: projects.map((row) => ({
      projectId: row.id,
      name: row.name,
      absolutePath: row.absolute_path,
      fileCount: row.file_count,
      entryCount: row.entry_count
    })),
    credentialCount: credentialCount?.n ?? 0
  }
}

/**
 * 收集要导出的东西。**返回的对象里全是明文**，调用方必须立刻封包，
 * 不许把它写日志、不许放进 IPC 返回值。
 */
export function buildPayload(projectIds: number[], includeCredentials: boolean): Payload {
  requireUnlocked()
  const db = getDatabase()

  const projects: PayloadProject[] = []
  for (const projectId of projectIds) {
    const project = db
      .prepare('SELECT id, name, absolute_path FROM projects WHERE id = ?')
      .get<{ id: number; name: string; absolute_path: string }>(projectId)
    if (!project) throw new RepositoryError('NOT_FOUND', `项目 ${projectId} 不存在`)

    const files = db
      .prepare(
        'SELECT id, environment, absolute_path FROM env_files WHERE project_id = ? ORDER BY absolute_path ASC'
      )
      .all<{ id: number; environment: string; absolute_path: string }>(projectId)

    projects.push({
      name: project.name,
      absolutePath: project.absolute_path,
      files: files.map((file) => ({
        relativePath: toRelative(project.absolute_path, file.absolute_path),
        environment: file.environment,
        entries: db
          .prepare(
            `SELECT key, occurrence, encrypted_value FROM config_entries
              WHERE env_file_id = ? ORDER BY occurrence ASC, key ASC`
          )
          .all<{ key: string; occurrence: number; encrypted_value: Uint8Array | null }>(file.id)
          .map((row) => ({
            key: row.key,
            occurrence: row.occurrence,
            value: row.encrypted_value ? vault.decryptValue(Buffer.from(row.encrypted_value)) : ''
          }))
      }))
    })
  }

  const credentials: PayloadCredential[] = []
  if (includeCredentials) {
    const rows = db
      .prepare(
        `SELECT id, provider_name, credential_name, endpoint, encrypted_api_key, tags, notes
           FROM model_credentials ORDER BY credential_name ASC`
      )
      .all<{
        id: number
        provider_name: string
        credential_name: string
        endpoint: string
        encrypted_api_key: Uint8Array
        tags: string
        notes: string | null
      }>()

    for (const row of rows) {
      const bindings = db
        .prepare(
          `SELECT p.name AS project_name, b.environment, b.key_variable, b.endpoint_variable
             FROM credential_bindings b JOIN projects p ON p.id = b.project_id
            WHERE b.credential_id = ?`
        )
        .all<{
          project_name: string
          environment: string
          key_variable: string
          endpoint_variable: string | null
        }>(row.id)

      credentials.push({
        providerName: row.provider_name,
        credentialName: row.credential_name,
        endpoint: row.endpoint,
        apiKey: vault.decryptValue(Buffer.from(row.encrypted_api_key)),
        tags: row.tags,
        notes: row.notes,
        // 🔴 指纹**不进包**：它是 HMAC(本机主密钥派生的子密钥, key)，
        // 换台机器没有任何意义。导入时用目标机器的子密钥重算。
        bindings: bindings.map((b) => ({
          projectName: b.project_name,
          environment: b.environment,
          keyVariable: b.key_variable,
          endpointVariable: b.endpoint_variable
        }))
      })
    }
  }

  return { formatVersion: PAYLOAD_VERSION, exportedAt: Date.now(), projects, credentials }
}

/** 导出成功后留痕。🔴 只记数量，不记项目名以外的任何东西，更不记值。 */
export function logExport(
  projectCount: number,
  entryCount: number,
  credentialCount: number,
  targetPath: string
): void {
  logActivity({
    action: 'transfer.export',
    projectId: null,
    environment: null,
    targetKind: 'package',
    targetRef: basename(targetPath),
    detail:
      `导出 ${projectCount} 个项目、${entryCount} 个变量` +
      (credentialCount > 0 ? `，含 ${credentialCount} 条模型凭据` : '，不含模型凭据')
  })
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

function parsePayload(json: string): Payload {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new RepositoryError('INVALID_ARGUMENT', '包能解开，但里面的内容不是合法的 JSON')
  }
  const payload = parsed as Payload
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.projects)) {
    throw new RepositoryError('INVALID_ARGUMENT', '包的内容结构不认识')
  }
  if (payload.formatVersion > PAYLOAD_VERSION) {
    throw new RepositoryError(
      'INVALID_ARGUMENT',
      `包里的数据格式是更高版本（v${payload.formatVersion}），请升级后再导入`
    )
  }
  return {
    formatVersion: payload.formatVersion,
    exportedAt: payload.exportedAt,
    projects: payload.projects,
    credentials: Array.isArray(payload.credentials) ? payload.credentials : []
  }
}

/** 逐文件比对包与本机，给用户一份「导进来会发生什么」的清单。 */
export function previewImport(json: string): ImportPreview {
  requireUnlocked()
  const payload = parsePayload(json)
  const db = getDatabase()

  const projects: ImportPreviewProject[] = payload.projects.map((project) => {
    const existing = db
      .prepare('SELECT id FROM projects WHERE absolute_path = ?')
      .get<{ id: number }>(project.absolutePath)

    const files: ImportPreviewFile[] = project.files.map((file) => {
      const absolutePath = joinUnderRoot(project.absolutePath, file.relativePath)
      const row = existing
        ? db
            .prepare('SELECT id FROM env_files WHERE project_id = ? AND absolute_path = ?')
            .get<{ id: number }>(existing.id, absolutePath)
        : undefined

      let added = 0
      let changed = 0
      let same = 0
      if (row) {
        for (const entry of file.entries) {
          const current = db
            .prepare(
              'SELECT encrypted_value FROM config_entries WHERE env_file_id = ? AND key = ? AND occurrence = ?'
            )
            .get<{ encrypted_value: Uint8Array | null }>(row.id, entry.key, entry.occurrence)
          if (!current) added += 1
          else {
            const value = current.encrypted_value
              ? vault.decryptValue(Buffer.from(current.encrypted_value))
              : ''
            if (value === entry.value) same += 1
            else changed += 1
          }
        }
      } else {
        added = file.entries.length
      }

      return {
        relativePath: file.relativePath,
        environment: file.environment,
        status: row ? 'existing' : 'new',
        addedCount: added,
        changedCount: changed,
        sameCount: same,
        onDisk: currentFileHash(absolutePath) !== null
      }
    })

    return {
      name: project.name,
      absolutePath: project.absolutePath,
      status: existing ? 'existing' : 'new',
      // 换台机器导入时，包里记的项目根多半不存在。这不是错误，但界面要说出来 ——
      // 「导进来的项目指向一个不存在的目录」如果不讲，用户会以为导入失败了。
      rootExistsOnDisk: dirLooksPresent(project.absolutePath),
      files
    }
  })

  return {
    exportedAt: payload.exportedAt,
    projects,
    credentials: payload.credentials.map((credential) => ({
      providerName: credential.providerName,
      credentialName: credential.credentialName,
      // 🔴 预览里给的是尾四位，不是 Key 本身 —— 和凭据列表同一条规矩。
      lastFour: lastFourOf(credential.apiKey),
      bindingCount: credential.bindings.length,
      status: existingCredential(credential) ? 'existing' : 'new'
    }))
  }
}

export interface ImportSelection {
  /** 要导入的文件，形如 `<项目 absolutePath>0000<相对路径>`。 */
  fileKeys: string[]
  /** 要导入的凭据名。 */
  credentialNames: string[]
}

/**
 * 按选择写库。
 *
 * 🔴 全程只动中心记录，一个磁盘文件都不写 —— 见文件顶部。
 * 合并是**只增不删**：包里有的补进来或更新，本机独有的不动。
 */
export function applyImport(json: string, selection: ImportSelection): ImportResult {
  requireUnlocked()
  const payload = parsePayload(json)
  const db = getDatabase()
  const now = Date.now()

  const wanted = new Set(selection.fileKeys)
  const wantedCredentials = new Set(selection.credentialNames)

  let projectsCreated = 0
  let filesCreated = 0
  let entriesAdded = 0
  let entriesUpdated = 0
  let credentialsCreated = 0

  db.transaction(() => {
    for (const project of payload.projects) {
      const selectedFiles = project.files.filter((file) =>
        wanted.has(fileKeyOf(project.absolutePath, file.relativePath))
      )
      if (selectedFiles.length === 0) continue

      let projectRow = db
        .prepare('SELECT id FROM projects WHERE absolute_path = ?')
        .get<{ id: number }>(project.absolutePath)

      if (!projectRow) {
        const inserted = db
          .prepare(
            `INSERT INTO projects (name, absolute_path, git_root, tags, created_at, last_opened_at)
             VALUES (?, ?, NULL, '[]', ?, ?)`
          )
          .run(project.name, project.absolutePath, now, now)
        projectRow = { id: Number(inserted.lastInsertRowid) }
        projectsCreated += 1
      }

      for (const file of selectedFiles) {
        const absolutePath = joinUnderRoot(project.absolutePath, file.relativePath)
        let fileRow = db
          .prepare('SELECT id FROM env_files WHERE project_id = ? AND absolute_path = ?')
          .get<{ id: number }>(projectRow.id, absolutePath)

        if (!fileRow) {
          const inserted = db
            .prepare(
              `INSERT INTO env_files
                 (project_id, environment, absolute_path, file_hash, parser_version, last_scanned_at)
               VALUES (?, ?, ?, NULL, ?, ?)`
            )
            .run(projectRow.id, file.environment, absolutePath, PARSER_VERSION, now)
          fileRow = { id: Number(inserted.lastInsertRowid) }
          filesCreated += 1
        }

        for (const entry of file.entries) {
          const { valueType, sensitivity } = classify(entry.key, entry.value)
          const current = db
            .prepare(
              'SELECT id, encrypted_value FROM config_entries WHERE env_file_id = ? AND key = ? AND occurrence = ?'
            )
            .get<{ id: number; encrypted_value: Uint8Array | null }>(
              fileRow.id,
              entry.key,
              entry.occurrence
            )

          if (!current) {
            db.prepare(
              `INSERT INTO config_entries
                 (env_file_id, key, occurrence, encrypted_value, value_type, sensitivity,
                  source_line, original_format, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`
            ).run(
              fileRow.id,
              entry.key,
              entry.occurrence,
              vault.encryptValue(entry.value),
              valueType,
              sensitivity,
              now
            )
            entriesAdded += 1
            continue
          }

          const existingValue = current.encrypted_value
            ? vault.decryptValue(Buffer.from(current.encrypted_value))
            : ''
          if (existingValue === entry.value) continue

          db.prepare(
            'UPDATE config_entries SET encrypted_value = ?, value_type = ?, sensitivity = ?, updated_at = ? WHERE id = ?'
          ).run(vault.encryptValue(entry.value), valueType, sensitivity, now, current.id)
          entriesUpdated += 1
        }
      }
    }

    for (const credential of payload.credentials) {
      if (!wantedCredentials.has(credential.credentialName)) continue
      if (existingCredential(credential)) continue

      const apiKey = credential.apiKey.trim()
      if (apiKey === '') continue

      db.prepare(
        `INSERT INTO model_credentials
           (provider_name, credential_name, endpoint, encrypted_api_key, fingerprint,
            last_four, status, tags, notes, created_at, last_validated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'unverified', ?, ?, ?, NULL)`
      ).run(
        credential.providerName,
        credential.credentialName,
        credential.endpoint,
        vault.encryptValue(apiKey),
        // 🔴 用**本机**的子密钥重算指纹。包里那份换了机器没有意义。
        fingerprintOf(apiKey),
        lastFourOf(apiKey),
        credential.tags,
        credential.notes,
        now
      )
      credentialsCreated += 1
      // 绑定不在这一刀里自动重建：目标机器上的项目和环境可能对不上，
      // 猜错一次就是把一把 Key 绑到错的文件上，下次同步会真的写下去。
    }
  })

  logActivity({
    action: 'transfer.import',
    projectId: null,
    environment: null,
    targetKind: 'package',
    targetRef: null,
    detail:
      `导入 ${projectsCreated} 个新项目、${filesCreated} 个文件；` +
      `新增 ${entriesAdded} 个变量、更新 ${entriesUpdated} 个` +
      (credentialsCreated > 0 ? `；新增 ${credentialsCreated} 条凭据` : '')
  })

  return {
    projectsCreated,
    filesCreated,
    entriesAdded,
    entriesUpdated,
    credentialsCreated
  }
}

// ---------------------------------------------------------------------------

/**
 * 文件在选择集里的稳定标识。
 *
 * 分隔符是 NUL（U+0000）：路径里不可能出现它。空格、`|`、`:` 在真实路径里
 * 都出现得了，拿它们当分隔符早晚会撞上一个含该字符的目录名，
 * 撞上之后的表现是「勾了 A 却导入了 B」。
 *
 * ⚠️ 用 `String.fromCharCode(0)` 而不是把一个裸控制字符敲进源码 ——
 * 后者在编辑器里完全不可见，复制粘贴、过一遍格式化工具、或者被某个处理管道
 * 当成字符串结束符，都可能让它悄悄消失，而代码看起来一点没变。
 */
const KEY_SEPARATOR = String.fromCharCode(0)

export function fileKeyOf(projectPath: string, relativePath: string): string {
  return projectPath + KEY_SEPARATOR + relativePath
}

function joinUnderRoot(root: string, relativePath: string): string {
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const normalized = separator === '\\' ? relativePath.replace(/\//g, '\\') : relativePath
  return `${root.replace(/[/\\]+$/, '')}${separator}${normalized}`
}

function dirLooksPresent(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

function existingCredential(credential: PayloadCredential): boolean {
  const row = getDatabase()
    .prepare('SELECT id FROM model_credentials WHERE provider_name = ? AND credential_name = ?')
    .get<{ id: number }>(credential.providerName, credential.credentialName)
  return row !== undefined
}

function fingerprintOf(apiKey: string): string {
  const subkey = vault.deriveSubkey('credential-fingerprint')
  return createHmac('sha256', subkey).update(apiKey.trim(), 'utf8').digest('hex').slice(0, 16)
}

function lastFourOf(apiKey: string): string {
  const trimmed = apiKey.trim()
  return trimmed.length >= 8 ? trimmed.slice(-4) : ''
}
