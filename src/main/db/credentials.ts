/**
 * 模型凭据与绑定（开发计划 §4.3、§6.2、§9 阶段 3）。
 *
 * ## 凭据是 Key 的真源
 *
 * 一个变量被提成凭据之后，`config_entries` 里的那一条**仍然保留**
 * （§6.2 步骤 2、阶段 3 验收「通用配置页面仍能看到原始来源和绑定状态」），
 * 但它不再能就地编辑 —— 改动只能从凭据发起，再同步到全部绑定。
 *
 * 这不是洁癖：凭据库存在的全部意义就是「改一次，同步到多处」。
 * 如果每一处还能各自改，那就是多个真源，必然分叉，
 * 而分叉之后「这把 Key 到底是哪个」没有任何办法回答。
 *
 * ## 🔴 明文边界
 *
 * ```
 * 用户输入 / 从变量提取 → vault.encryptValue → model_credentials.encrypted_api_key
 *                       → 列表只给 fingerprint + last_four   ← 明文到这里止步
 *                       → 同步时在内存里解密，直接交给写盘，不经过任何返回值
 * ```
 *
 * 明文过桥只发生在 `revealCredentialKey` 一个函数里，且每次都留一条操作记录。
 * 同步预览同样不给明文 —— 它是一览视图，只回答「哪些地方要改」。
 *
 * ## 写盘走的是同一条路
 *
 * 同步复用 `repositories` 里的 `writeGuarded` / `syncFileState`，
 * 和「编辑单个变量」是同一条写入路径。另开一条的话，备份、并发校验、
 * 行号对齐这些保证会在新路径上悄悄缺席，而且不会有任何报错。
 */

import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { getDatabase } from './index'
import * as vault from '../security/vault'
import {
  RepositoryError,
  logActivity,
  requireUnlocked,
  syncFileState,
  toRelative,
  writeGuarded
} from './repositories'
import { classify } from '../env/classify.ts'
import { applyEdits, parseEnv, serializeEnv } from '../env/document.ts'
import { currentFileHash } from '../env/scan.ts'
import {
  PROVIDERS,
  getProvider,
  lastFour as lastFourOf,
  matchEndpoint,
  suggestProviders
} from '../providers/index.ts'
import { isConclusive, runValidation } from '../providers/validate.ts'
import type { ValidationTransport } from '../providers/validate.ts'
import { electronTransport } from '../net/transport'
import { copyWithAutoClear } from '../clipboard/index.ts'
import type { ClipboardPort } from '../clipboard/index.ts'
import type {
  CreateCredentialRequest,
  CredentialBindingView,
  CredentialRevealResult,
  CredentialStatus,
  CredentialSuggestion,
  CredentialSummary,
  CredentialSyncPreview,
  CredentialSyncResult,
  CredentialValidationResult,
  CredentialVersion,
  ProviderInfo,
  SyncOutcome,
  SyncTarget,
  SyncTargetState,
  UpdateCredentialRequest
} from '@shared/ipc'

// ---------------------------------------------------------------------------
// 指纹
// ---------------------------------------------------------------------------

/**
 * Key 的指纹：`HMAC-SHA256(从主密钥派生的子密钥, key)` 取前 16 位十六进制。
 *
 * 它要回答的问题只有一个：**这两个地方用的是不是同一把 Key**。
 * 所以要求是「同一把必然相同、不同的几乎必然不同、且不能从指纹反推出 Key」。
 *
 * 🔴 为什么用主密钥派生的子密钥而不是直接 SHA-256：
 * 裸哈希意味着任何拿到数据库文件的人都能拿一份候选 Key 字典逐个哈希去比对。
 * API Key 熵很高，字典攻击本来就不现实 —— 但「泄露的库 + 一份从别处
 * 拿到的 Key 列表」就能确认「这个人在用这把 Key」，这个信息本身是敏感的。
 * 用派生密钥之后，只有库、没有系统密钥库就什么都验证不了。
 *
 * 代价是指纹只能在解锁状态下计算。这不构成限制：需要算指纹的时刻
 * （新增、轮换）本来就要加密 Key，一样得解锁。
 */
function fingerprintOf(apiKey: string): string {
  const subkey = vault.deriveSubkey('credential-fingerprint')
  return createHmac('sha256', subkey).update(apiKey.trim(), 'utf8').digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// 厂商
// ---------------------------------------------------------------------------

export function listProviders(): ProviderInfo[] {
  return PROVIDERS.map((provider) => ({
    id: provider.id,
    providerName: provider.providerName,
    defaultEndpoint: provider.defaultEndpoint
  }))
}

// ---------------------------------------------------------------------------
// 识别建议（§6.2 步骤 1）
// ---------------------------------------------------------------------------

interface EntryRow {
  id: number
  key: string
  encrypted_value: Uint8Array | null
  environment: string
  absolute_path: string
  project_path: string
}

function decrypt(blob: Uint8Array | null): string {
  return blob ? vault.decryptValue(Buffer.from(blob)) : ''
}

/**
 * 扫一个项目里的变量，挑出看起来是模型凭据的。
 *
 * 已经绑定过的变量不再出现在建议里 —— 它已经有归属了，
 * 再建议一次只会让用户重复创建凭据。
 *
 * 🔴 返回值里没有任何 Key 的明文，连掩码都没有。这是一个一览列表，
 * 用户还没对任何一条做出决定，没有理由在这里解密给渲染层看。
 */
export function suggestCredentials(projectId: number): CredentialSuggestion[] {
  requireUnlocked()
  const db = getDatabase()

  const rows = db
    .prepare(
      `SELECT c.id, c.key, c.encrypted_value, f.environment, f.absolute_path,
              p.absolute_path AS project_path
       FROM config_entries c
       JOIN env_files f ON f.id = c.env_file_id
       JOIN projects p ON p.id = f.project_id
       WHERE f.project_id = ?
       ORDER BY f.absolute_path ASC, c.source_line ASC`
    )
    .all<EntryRow>(projectId)

  // 复合键用 U+0000 当分隔符：环境名和变量名里都不可能出现它，
  // 所以 (a, bc) 和 (ab, c) 不会撞成同一个键。
  // ⚠️ 写成转义而不是裸字节 —— 源码里嵌一个真的 NUL 会让 git 和 grep
  // 把整个文件当成二进制文件，diff 和 code review 就都失效了（这里踩过）。
  const bound = new Set(
    db
      .prepare(
        `SELECT environment, key_variable FROM credential_bindings WHERE project_id = ?`
      )
      .all<{ environment: string; key_variable: string }>(projectId)
      .map((row) => `${row.environment}\u0000${row.key_variable}`)
  )

  // 地址变量按环境归拢，用来给 Key 变量配一个 endpoint 建议。
  const endpointsByEnv = new Map<string, { key: string; value: string }[]>()
  for (const row of rows) {
    const value = decrypt(row.encrypted_value)
    if (!matchEndpoint(value)) continue
    const list = endpointsByEnv.get(row.environment) ?? []
    list.push({ key: row.key, value })
    endpointsByEnv.set(row.environment, list)
  }

  const suggestions: CredentialSuggestion[] = []
  for (const row of rows) {
    if (bound.has(`${row.environment}\u0000${row.key}`)) continue

    const value = decrypt(row.encrypted_value)
    const providers = suggestProviders(row.key, value)
    if (providers.length === 0) continue

    // 同环境里优先挑同一家的地址变量；找不到就退回这个环境里的任意一个地址。
    const candidates = endpointsByEnv.get(row.environment) ?? []
    const sameProvider = candidates.find(
      (candidate) => matchEndpoint(candidate.value)?.id === providers[0]?.providerId
    )
    const endpoint = sameProvider ?? candidates[0] ?? null

    suggestions.push({
      entryId: row.id,
      key: row.key,
      environment: row.environment,
      sourceFile: toRelative(row.project_path, row.absolute_path),
      providers,
      endpointVariable: endpoint?.key ?? null,
      // 地址不是秘密（§2.2 把它和 Key 分开列），给出来才能让用户确认配对对不对。
      endpointPreview: endpoint?.value ?? null
    })
  }
  return suggestions
}

// ---------------------------------------------------------------------------
// 版本历史（阶段 4b）
// ---------------------------------------------------------------------------

/**
 * 开一代新的 Key。调用方负责先把上一代关掉。
 *
 * 🔴 `credential_versions` 里**没有密文那一列**，所以这里也没什么可存的 ——
 * 只有指纹和末四位。理由见迁移 005：留着旧密钥是纯粹的负债，
 * 而轮换的全部意义就是让旧的那把作废。
 */
function openVersion(credentialId: number, apiKey: string, now: number): void {
  const db = getDatabase()
  const current =
    db
      .prepare(
        'SELECT COALESCE(MAX(version), 0) AS v FROM credential_versions WHERE credential_id = ?'
      )
      .get<{ v: number }>(credentialId)?.v ?? 0

  db.prepare(
    `INSERT INTO credential_versions
       (credential_id, version, fingerprint, last_four, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL)`
  ).run(credentialId, current + 1, fingerprintOf(apiKey), lastFourOf(apiKey), now)
}

/**
 * 关掉当前这一代。
 *
 * 只在**轮换**时调用。用户按「停用」改的是 `model_credentials.status`，
 * 不动版本行 —— 那把 Key 还是那把 Key，只是这条凭据被搁置了。
 * 两件事混进 `revoked_at` 一列，之后就再也分不开了。
 */
function closeCurrentVersion(credentialId: number, now: number): void {
  getDatabase()
    .prepare(
      'UPDATE credential_versions SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL'
    )
    .run(now, credentialId)
}

/**
 * 这条凭据换过几次 Key、每一代是什么时候作废的。
 *
 * 🔴 返回值里只有指纹和末四位，没有任何一代的 Key ——
 * 库里本来就没存。指纹的用处是**在别处认出残留的旧 Key**
 * （另一个项目、一份旧备份里出现同样的指纹，说明那把作废的 Key 还在用）。
 */
export function listCredentialVersions(credentialId: number): CredentialVersion[] {
  return getDatabase()
    .prepare(
      `SELECT version, fingerprint, last_four, created_at, revoked_at
       FROM credential_versions WHERE credential_id = ? ORDER BY version DESC`
    )
    .all<{
      version: number
      fingerprint: string
      last_four: string
      created_at: number
      revoked_at: number | null
    }>(credentialId)
    .map((row) => ({
      version: row.version,
      fingerprint: row.fingerprint,
      lastFour: row.last_four,
      createdAt: row.created_at,
      revokedAt: row.revoked_at
    }))
}

// ---------------------------------------------------------------------------
// 凭据 CRUD
// ---------------------------------------------------------------------------

interface CredentialRow {
  id: number
  provider_name: string
  credential_name: string
  endpoint: string
  encrypted_api_key: Uint8Array
  fingerprint: string
  last_four: string
  status: string
  tags: string
  notes: string | null
  created_at: number
  last_validated_at: number | null
}

/**
 * `provider_name` 存的是适配器 id（`openai`），展示名从适配器里取。
 * 存 id 而不是展示名，是为了让将来改中文名不需要跟着迁移数据。
 */
function toSummary(row: CredentialRow, bindingCount: number): CredentialSummary {
  const provider = getProvider(row.provider_name)
  return {
    id: row.id,
    providerId: row.provider_name,
    providerName: provider?.providerName ?? row.provider_name,
    credentialName: row.credential_name,
    endpoint: row.endpoint,
    lastFour: row.last_four,
    fingerprint: row.fingerprint,
    status: row.status as CredentialStatus,
    bindingCount,
    createdAt: row.created_at,
    lastValidatedAt: row.last_validated_at,
    notes: row.notes
  }
}

function bindingCounts(): Map<number, number> {
  return new Map(
    getDatabase()
      .prepare(
        'SELECT credential_id, COUNT(*) AS n FROM credential_bindings GROUP BY credential_id'
      )
      .all<{ credential_id: number; n: number }>()
      .map((row) => [row.credential_id, row.n])
  )
}

export function listCredentials(): CredentialSummary[] {
  const counts = bindingCounts()
  return getDatabase()
    .prepare('SELECT * FROM model_credentials ORDER BY created_at ASC')
    .all<CredentialRow>()
    .map((row) => toSummary(row, counts.get(row.id) ?? 0))
}

function requireCredential(credentialId: number): CredentialRow {
  const row = getDatabase()
    .prepare('SELECT * FROM model_credentials WHERE id = ?')
    .get<CredentialRow>(credentialId)
  if (!row) throw new RepositoryError('NOT_FOUND', '凭据不存在')
  return row
}

/**
 * 🔴 已停用的凭据不许再往外用。
 *
 * 「停用」是用户明确说过「这把不要了」。此后还把它写进 `.env` 文件、
 * 或者拿去向厂商验证，都是在替他撤回那个决定。
 *
 * 界面上同时会禁用入口并说明原因，但**这里才是真正的守卫** ——
 * 和「归凭据管的变量不能就地编辑」同一个模式：界面挡是为了不把用户
 * 引到死路上，主进程挡才是那条规矩真正成立的地方。
 */
function requireNotRevoked(row: CredentialRow, attempted: string): void {
  if (row.status !== 'revoked') return
  throw new RepositoryError(
    'PATH_REJECTED',
    `凭据「${row.credential_name}」已停用，不能${attempted}。要继续用请先启用它。`
  )
}

export function createCredential(request: CreateCredentialRequest): CredentialSummary {
  requireUnlocked()

  const provider = getProvider(request.providerId)
  if (!provider) throw new RepositoryError('INVALID_ARGUMENT', '未知的厂商')

  const apiKey = request.apiKey.trim()
  if (apiKey === '') throw new RepositoryError('INVALID_ARGUMENT', 'API Key 不能为空')

  const endpoint = request.endpoint.trim() || provider.defaultEndpoint
  if (endpoint === '') {
    throw new RepositoryError('INVALID_ARGUMENT', '自定义厂商必须填写调用地址')
  }

  const db = getDatabase()
  const now = Date.now()
  const credentialId = db.transaction(() => {
    const inserted = db
      .prepare(
        `INSERT INTO model_credentials
           (provider_name, credential_name, endpoint, encrypted_api_key, fingerprint,
            last_four, status, tags, notes, created_at, last_validated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'unverified', '[]', ?, ?, NULL)`
      )
      .run(
        provider.id,
        request.credentialName.trim() || 'primary',
        endpoint,
        vault.encryptValue(apiKey),
        fingerprintOf(apiKey),
        lastFourOf(apiKey),
        request.notes?.trim() || null,
        now
      )
    const id = Number(inserted.lastInsertRowid)
    // 第一代。和凭据在同一个事务里 —— 一条没有 v1 的凭据是坏数据。
    openVersion(id, apiKey, now)
    if (request.bind) insertBinding(id, request.bind)
    return id
  })

  logActivity({
    action: 'credential.create',
    projectId: request.bind?.projectId ?? null,
    environment: request.bind?.environment ?? null,
    targetKind: 'credential',
    // 只记厂商与凭据名，Key 和指纹都不记。
    targetRef: `${provider.providerName} / ${request.credentialName.trim() || 'primary'}`,
    detail: request.bind ? `已绑定到 ${request.bind.keyVariable}` : '尚未绑定到任何项目'
  })

  return toSummary(requireCredential(credentialId), request.bind ? 1 : 0)
}

/**
 * 改凭据本身。换 Key（轮换）也走这里 —— 但**只改凭据，不碰任何文件**。
 * 同步到绑定的文件是单独一步（预览 → 确认 → 写入），
 * 因为那一步是破坏性的，不能作为"保存"的副作用发生。
 */
export function updateCredential(request: UpdateCredentialRequest): CredentialSummary {
  requireUnlocked()
  const existing = requireCredential(request.credentialId)

  const db = getDatabase()
  const changes: string[] = []

  if (request.credentialName !== undefined && request.credentialName.trim() !== '') {
    db.prepare('UPDATE model_credentials SET credential_name = ? WHERE id = ?').run(
      request.credentialName.trim(),
      request.credentialId
    )
    changes.push('名称')
  }
  if (request.endpoint !== undefined && request.endpoint.trim() !== '') {
    db.prepare('UPDATE model_credentials SET endpoint = ? WHERE id = ?').run(
      request.endpoint.trim(),
      request.credentialId
    )
    changes.push('调用地址')
  }
  if (request.notes !== undefined) {
    db.prepare('UPDATE model_credentials SET notes = ? WHERE id = ?').run(
      request.notes?.trim() || null,
      request.credentialId
    )
    changes.push('备注')
  }
  if (request.status !== undefined) {
    db.prepare('UPDATE model_credentials SET status = ? WHERE id = ?').run(
      request.status,
      request.credentialId
    )
    changes.push(`状态→${request.status}`)
  }
  if (request.apiKey !== undefined) {
    const apiKey = request.apiKey.trim()
    if (apiKey === '') throw new RepositoryError('INVALID_ARGUMENT', 'API Key 不能为空')
    const now = Date.now()
    db.transaction(() => {
      db.prepare(
        `UPDATE model_credentials
         SET encrypted_api_key = ?, fingerprint = ?, last_four = ?,
             status = 'unverified', last_validated_at = NULL
         WHERE id = ?`
      ).run(
        vault.encryptValue(apiKey),
        fingerprintOf(apiKey),
        lastFourOf(apiKey),
        request.credentialId
      )
      // 上一代作废，新的一代开张。两步必须同一个事务：
      // 中间断掉会留下两代都是"当前"或者一代都没有的库。
      closeCurrentVersion(request.credentialId, now)
      openVersion(request.credentialId, apiKey, now)
    })
    // 🔴 换了 Key，之前那次验证的结论就作废了 —— 状态退回 unverified，
    // 验证时间**一并清空**。只退状态不清时间的话，界面上会出现
    // 「未验证」旁边挂着一个「验于 3 分钟前」，而那句话说的是另一把 Key。
    changes.push('轮换 Key')
  }

  if (changes.length > 0) {
    logActivity({
      action: request.apiKey !== undefined ? 'credential.rotate' : 'credential.update',
      targetKind: 'credential',
      targetRef: `${getProvider(existing.provider_name)?.providerName ?? existing.provider_name} / ${existing.credential_name}`,
      detail: `${changes.join('、')}；文件尚未同步`
    })
  }

  const counts = bindingCounts()
  return toSummary(requireCredential(request.credentialId), counts.get(request.credentialId) ?? 0)
}

/** 取出明文 Key。全应用唯一会把它送过桥的地方，所以必须留痕。 */
export function revealCredentialKey(credentialId: number): CredentialRevealResult {
  requireUnlocked()
  const row = requireCredential(credentialId)

  logActivity({
    action: 'credential.reveal',
    targetKind: 'credential',
    // 只记凭据名，绝不记 Key（§5.5）。
    targetRef: `${getProvider(row.provider_name)?.providerName ?? row.provider_name} / ${row.credential_name}`,
    detail: null
  })

  return {
    id: row.id,
    credentialName: row.credential_name,
    apiKey: decrypt(row.encrypted_api_key)
  }
}

/**
 * 向厂商验证一把 Key（开发计划 §7、§8、§9 阶段 3 最后一项）。
 *
 * 这是全应用**唯一**会产生出站流量的函数。四条规矩：
 *
 * 1. **仅在用户显式点「验证」时调用。** 没有定时重试、没有启动探活、
 *    没有作为保存的副作用顺手验一下 —— 入口只有凭据列表上那一个按钮。
 * 2. **只打元数据接口**，地址由适配器的 `describeValidation()` 给
 *    （§7：避免无意产生推理费用）。
 * 3. 🔴 **明文只活在下面那一个表达式里**：解密 → 进请求头 → 交给传输层。
 *    它不进返回值、不进操作记录、不进任何日志 —— 和同步写盘那条路同一个模式。
 * 4. 🔴 **没问出答案就一行 SQL 都不执行。** 网络不通、厂商限流、地址填错
 *    都不是「这把 Key 坏了」的证据。把它们当成证据的后果是：用户离线时
 *    点一次验证，所有凭据被标成失效 —— 而那正是他最需要这些 Key 的时候。
 *
 * `transport` 是可注入的：验收脚本塞一个假传输进来，就能跑遍全部分支
 * 而不发一个字节。真传输那一侧另有一道 `ENVVAULT_BLOCK_NETWORK` 硬拦，
 * 防止「忘了注入」变成一次静默的真实请求（见 `net/transport.ts`）。
 */
export async function validateCredential(
  credentialId: number,
  transport: ValidationTransport = electronTransport
): Promise<CredentialValidationResult> {
  requireUnlocked()
  const row = requireCredential(credentialId)
  requireNotRevoked(row, '向厂商发验证请求')

  const provider = getProvider(row.provider_name)
  if (!provider) throw new RepositoryError('INVALID_ARGUMENT', '未知的厂商')
  if (row.endpoint.trim() === '') {
    throw new RepositoryError('INVALID_ARGUMENT', '这条凭据没有调用地址，无从验证')
  }

  // 🔴 明文的全部生命周期就在这一行里：解密出来，直接进请求头。
  const request = provider.describeValidation(row.endpoint, decrypt(row.encrypted_api_key))
  const report = await runValidation(request, transport)
  const conclusive = isConclusive(report.outcome)

  if (conclusive) {
    getDatabase()
      .prepare('UPDATE model_credentials SET status = ?, last_validated_at = ? WHERE id = ?')
      .run(report.outcome === 'valid' ? 'active' : 'invalid', Date.now(), credentialId)
  }

  logActivity({
    action: 'credential.validate',
    targetKind: 'credential',
    // 只记厂商与凭据名。Key、请求头、调用地址一律不记 ——
    // 自定义厂商的地址是用户填的，谁也不敢保证里面没有秘密。
    targetRef: `${provider.providerName} / ${row.credential_name}`,
    detail: conclusive
      ? `${report.outcome === 'valid' ? '验证通过' : '厂商拒绝'}（HTTP ${report.httpStatus}）`
      : `没有结论（${report.outcome}）；状态与最后验证时间都未改动`
  })

  const counts = bindingCounts()
  return {
    credential: toSummary(requireCredential(credentialId), counts.get(credentialId) ?? 0),
    outcome: report.outcome,
    httpStatus: report.httpStatus,
    message: report.message,
    conclusive
  }
}

/**
 * 把 Key 复制到系统剪贴板，并安排 30 秒后清理（计划 §7）。
 *
 * 🔴 **返回值里没有明文，参数里也没有** —— 只有一个 id 进来、
 * 一个"多久之后清"出去。复制这条路上明文完全不进渲染层，
 * 这是它和 `revealCredentialKey` 的根本区别（后者必须过桥，因为要显示）。
 *
 * 记一条 `credential.copy` 而不是复用 `credential.reveal`：
 * 复制和查看是两种不同的暴露方式，审计时要分得开 ——
 * **复制出去的那一份会离开本应用**，而查看不会。
 */
export async function copyCredentialKey(
  credentialId: number,
  port: ClipboardPort
): Promise<number> {
  requireUnlocked()
  const row = requireCredential(credentialId)

  const clearAfterMs = await copyWithAutoClear(decrypt(row.encrypted_api_key), port)

  logActivity({
    action: 'credential.copy',
    targetKind: 'credential',
    targetRef: `${getProvider(row.provider_name)?.providerName ?? row.provider_name} / ${row.credential_name}`,
    detail: `${Math.round(clearAfterMs / 1000)} 秒后自动清理剪贴板`
  })

  return clearAfterMs
}

/**
 * 删凭据。绑定靠外键级联删掉，**磁盘上的 `.env` 文件一个字节都不动** ——
 * 删除的是"我们对这把 Key 的记录"，不是用户项目里的配置。
 * 想连变量一起删，走配置表那条路（那里会明确说要改文件）。
 */
export function deleteCredential(credentialId: number): boolean {
  const row = getDatabase()
    .prepare('SELECT provider_name, credential_name FROM model_credentials WHERE id = ?')
    .get<{ provider_name: string; credential_name: string }>(credentialId)
  if (!row) return false

  getDatabase().prepare('DELETE FROM model_credentials WHERE id = ?').run(credentialId)
  logActivity({
    action: 'credential.delete',
    targetKind: 'credential',
    targetRef: `${getProvider(row.provider_name)?.providerName ?? row.provider_name} / ${row.credential_name}`,
    detail: '仅删除凭据记录与绑定，磁盘文件未改动'
  })
  return true
}

// ---------------------------------------------------------------------------
// 绑定
// ---------------------------------------------------------------------------

interface BindingInput {
  projectId: number
  environment: string
  keyVariable: string
  endpointVariable?: string | null
}

/** 调用方负责开事务。 */
function insertBinding(credentialId: number, input: BindingInput): number {
  const db = getDatabase()
  const project = db
    .prepare('SELECT id FROM projects WHERE id = ?')
    .get<{ id: number }>(input.projectId)
  if (!project) throw new RepositoryError('NOT_FOUND', '项目不存在')

  const keyVariable = input.keyVariable.trim()
  if (keyVariable === '') {
    throw new RepositoryError('INVALID_ARGUMENT', '必须指定 Key 变量名')
  }

  // UNIQUE (project_id, environment, key_variable)：同一个环境里一个变量
  // 只能属于一个凭据。撞了就明确报错，而不是让 SQLite 抛一个原始约束错误。
  const clash = db
    .prepare(
      `SELECT credential_id FROM credential_bindings
       WHERE project_id = ? AND environment = ? AND key_variable = ?`
    )
    .get<{ credential_id: number }>(input.projectId, input.environment, keyVariable)
  if (clash) {
    throw new RepositoryError(
      'ALREADY_EXISTS',
      clash.credential_id === credentialId
        ? '这个变量已经绑定到当前凭据了'
        : '这个变量已经绑定到另一个凭据，请先解绑'
    )
  }

  const inserted = db
    .prepare(
      `INSERT INTO credential_bindings
         (credential_id, project_id, environment, endpoint_variable, key_variable,
          last_synced_hash, sync_mode, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'manual', ?)`
    )
    .run(
      credentialId,
      input.projectId,
      input.environment,
      input.endpointVariable?.trim() || null,
      keyVariable,
      Date.now()
    )
  return Number(inserted.lastInsertRowid)
}

export function bindCredential(
  credentialId: number,
  input: BindingInput
): CredentialBindingView[] {
  requireCredential(credentialId)
  getDatabase().transaction(() => insertBinding(credentialId, input))

  logActivity({
    action: 'credential.bind',
    projectId: input.projectId,
    environment: input.environment,
    targetKind: 'binding',
    targetRef: input.keyVariable,
    detail: '建立凭据绑定'
  })
  return listBindings(credentialId)
}

export function unbindCredential(bindingId: number): CredentialBindingView[] {
  const row = getDatabase()
    .prepare(
      'SELECT credential_id, project_id, environment, key_variable FROM credential_bindings WHERE id = ?'
    )
    .get<{
      credential_id: number
      project_id: number
      environment: string
      key_variable: string
    }>(bindingId)
  if (!row) throw new RepositoryError('NOT_FOUND', '绑定不存在')

  getDatabase().prepare('DELETE FROM credential_bindings WHERE id = ?').run(bindingId)
  logActivity({
    action: 'credential.unbind',
    projectId: row.project_id,
    environment: row.environment,
    targetKind: 'binding',
    targetRef: row.key_variable,
    detail: '解除绑定，磁盘文件未改动'
  })
  return listBindings(row.credential_id)
}

interface BindingRow {
  id: number
  credential_id: number
  project_id: number
  environment: string
  key_variable: string
  endpoint_variable: string | null
  project_name: string
}

export function listBindings(credentialId: number): CredentialBindingView[] {
  const rows = getDatabase()
    .prepare(
      `SELECT b.id, b.credential_id, b.project_id, b.environment, b.key_variable,
              b.endpoint_variable, p.name AS project_name
       FROM credential_bindings b
       JOIN projects p ON p.id = b.project_id
       WHERE b.credential_id = ?
       ORDER BY p.name ASC, b.environment ASC`
    )
    .all<BindingRow>(credentialId)

  return rows.map((row) => ({
    id: row.id,
    credentialId: row.credential_id,
    projectId: row.project_id,
    projectName: row.project_name,
    environment: row.environment,
    keyVariable: row.key_variable,
    endpointVariable: row.endpoint_variable,
    unresolved: resolveTargetEntry(row) === null
  }))
}

// ---------------------------------------------------------------------------
// 一改多同步（阶段 3 验收句）
// ---------------------------------------------------------------------------

interface TargetEntry {
  entryId: number
  occurrence: number
  fileId: number
  absolutePath: string
  projectPath: string
  storedHash: string | null
  encryptedValue: Uint8Array | null
}

/**
 * 把一条绑定解析成「要改的那一条配置项」。
 *
 * 绑定记的是 (项目, 环境, 变量名)，不是文件 id —— 一个环境可能对应多个文件
 * （`.env.production` 和 `.env.production.local` 都归到 production）。
 * 这里取该环境里**第一个**含这个变量的文件；找不到就返回 null，
 * 由调用方报成 `missing-variable`，绝不追加。
 */
function resolveTargetEntry(binding: {
  project_id: number
  environment: string
  key_variable: string
}): TargetEntry | null {
  const row = getDatabase()
    .prepare(
      `SELECT c.id, c.occurrence, c.encrypted_value, f.id AS file_id, f.absolute_path,
              f.file_hash, p.absolute_path AS project_path
       FROM config_entries c
       JOIN env_files f ON f.id = c.env_file_id
       JOIN projects p ON p.id = f.project_id
       WHERE f.project_id = ? AND f.environment = ? AND c.key = ?
       ORDER BY f.absolute_path ASC, c.occurrence ASC
       LIMIT 1`
    )
    .get<{
      id: number
      occurrence: number
      encrypted_value: Uint8Array | null
      file_id: number
      absolute_path: string
      file_hash: string | null
      project_path: string
    }>(binding.project_id, binding.environment, binding.key_variable)
  if (!row) return null

  return {
    entryId: row.id,
    occurrence: row.occurrence,
    fileId: row.file_id,
    absolutePath: row.absolute_path,
    projectPath: row.project_path,
    storedHash: row.file_hash,
    encryptedValue: row.encrypted_value
  }
}

function bindingRowsOf(credentialId: number): BindingRow[] {
  return getDatabase()
    .prepare(
      `SELECT b.id, b.credential_id, b.project_id, b.environment, b.key_variable,
              b.endpoint_variable, p.name AS project_name
       FROM credential_bindings b
       JOIN projects p ON p.id = b.project_id
       WHERE b.credential_id = ?
       ORDER BY p.name ASC, b.environment ASC`
    )
    .all<BindingRow>(credentialId)
}

/**
 * 预览：这把 Key 同步下去会动哪些文件。
 *
 * 🔴 只说「哪些地方要改」，不说「改成什么」。预览是一览视图，
 * 把 Key 铺在上面等于绕过 reveal 的审计（和差异面板同一条规矩）。
 */
export function previewCredentialSync(credentialId: number): CredentialSyncPreview {
  requireUnlocked()
  const credential = requireCredential(credentialId)
  const apiKey = decrypt(credential.encrypted_api_key)

  const targets: SyncTarget[] = bindingRowsOf(credentialId).map((binding) => {
    const base = {
      bindingId: binding.id,
      projectId: binding.project_id,
      projectName: binding.project_name,
      environment: binding.environment,
      keyVariable: binding.key_variable
    }

    const target = resolveTargetEntry(binding)
    if (!target) {
      return { ...base, relativePath: null, state: 'missing-variable' as const, expectedHash: null }
    }

    const relativePath = toRelative(target.projectPath, target.absolutePath)
    const currentHash = currentFileHash(target.absolutePath)
    if (currentHash === null) {
      return { ...base, relativePath, state: 'file-missing' as const, expectedHash: null }
    }
    // 文件有未处理的外部改动时不能写：那等于替用户默默选了 §6.4 的方向。
    if (currentHash !== target.storedHash) {
      return { ...base, relativePath, state: 'file-drifted' as const, expectedHash: currentHash }
    }

    const state: SyncTargetState = decrypt(target.encryptedValue) === apiKey ? 'in-sync' : 'outdated'
    return { ...base, relativePath, state, expectedHash: currentHash }
  })

  return {
    credentialId,
    credentialName: credential.credential_name,
    providerName: getProvider(credential.provider_name)?.providerName ?? credential.provider_name,
    targets,
    writable: targets.filter((target) => target.state === 'outdated').length
  }
}

const STATE_REASONS: Record<Exclude<SyncTargetState, 'outdated'>, string> = {
  'in-sync': '文件里已经是这把 Key，无需写入',
  'missing-variable': '这个环境的文件里没有这个变量，未追加',
  'file-drifted': '文件在外部被改过，请先处理差异',
  'file-missing': '文件已从磁盘消失'
}

/**
 * 把凭据的 Key 写进选中的目标。
 *
 * 🔴 **逐个目标报告，不是全有或全无。** 跨多个文件的写入没法原子回滚：
 * 第一个文件已经落盘之后第二个冲突了，谎称「整体失败」会让用户以为
 * 第一个文件没被改，而它已经改了。所以每个目标各自成败，如实报回去。
 *
 * 每个目标的 `expectedHash` 来自预览，语义同 `restoreFile`：
 * 「我这个决定是基于哪个版本做的」。对不上就跳过那一个，不影响其余目标。
 */
export function syncCredential(
  credentialId: number,
  requested: readonly { bindingId: number; expectedHash: string }[]
): CredentialSyncResult {
  requireUnlocked()
  const credential = requireCredential(credentialId)
  requireNotRevoked(credential, '把一把已停用的 Key 写进项目文件')
  const apiKey = decrypt(credential.encrypted_api_key)

  const bindings = new Map(bindingRowsOf(credentialId).map((row) => [row.id, row]))
  const outcomes: SyncOutcome[] = []

  for (const item of requested) {
    const binding = bindings.get(item.bindingId)
    if (!binding) {
      outcomes.push({
        bindingId: item.bindingId,
        projectName: '—',
        environment: '—',
        relativePath: null,
        ok: false,
        reason: '这条绑定已经不存在了'
      })
      continue
    }

    const base = {
      bindingId: binding.id,
      projectName: binding.project_name,
      environment: binding.environment
    }
    const target = resolveTargetEntry(binding)
    if (!target) {
      outcomes.push({
        ...base,
        relativePath: null,
        ok: false,
        reason: STATE_REASONS['missing-variable']
      })
      continue
    }

    const relativePath = toRelative(target.projectPath, target.absolutePath)
    const currentHash = currentFileHash(target.absolutePath)
    if (currentHash === null) {
      outcomes.push({ ...base, relativePath, ok: false, reason: STATE_REASONS['file-missing'] })
      continue
    }
    if (currentHash !== target.storedHash) {
      outcomes.push({ ...base, relativePath, ok: false, reason: STATE_REASONS['file-drifted'] })
      continue
    }
    if (currentHash !== item.expectedHash) {
      outcomes.push({
        ...base,
        relativePath,
        ok: false,
        reason: '文件在你查看预览之后又被改动，已跳过'
      })
      continue
    }
    if (decrypt(target.encryptedValue) === apiKey) {
      outcomes.push({ ...base, relativePath, ok: true, reason: null })
      continue
    }

    try {
      writeOneTarget(binding, target, apiKey, item.expectedHash)
      outcomes.push({ ...base, relativePath, ok: true, reason: null })
    } catch (error) {
      outcomes.push({
        ...base,
        relativePath,
        ok: false,
        // RepositoryError 的 message 是面向用户的中文短句，可以直接给；
        // 其它异常不透原始 message，它可能带内部路径。
        reason: error instanceof RepositoryError ? error.message : '写入失败，请查看应用日志'
      })
    }
  }

  const written = outcomes.filter((outcome) => outcome.ok).length
  logActivity({
    action: 'credential.sync',
    targetKind: 'credential',
    targetRef: `${getProvider(credential.provider_name)?.providerName ?? credential.provider_name} / ${credential.credential_name}`,
    // 只记数量和文件路径，Key 一个字符都不记。
    detail: `同步 ${written} 处、跳过 ${outcomes.length - written} 处`
  })

  return {
    credentialId,
    written,
    failed: outcomes.length - written,
    outcomes
  }
}

/**
 * 把新值写进一个目标文件，并让中心记录跟着对齐。
 * 走的是和「编辑单个变量」完全相同的写入路径（备份 → 并发校验 → 原子替换），
 * 所以备份、行号对齐、格式骨架这些保证不需要在这里重新实现一遍。
 */
function writeOneTarget(
  binding: BindingRow,
  target: TargetEntry,
  apiKey: string,
  expectedHash: string
): void {
  const original = readFileSync(target.absolutePath, 'utf8')
  const applied = applyEdits(parseEnv(original), [
    { key: binding.key_variable, value: apiKey, occurrence: target.occurrence }
  ])
  if (applied.missing.length > 0) {
    throw new RepositoryError('NOT_FOUND', STATE_REASONS['missing-variable'])
  }

  const content = serializeEnv(applied.doc)
  const result = writeGuarded(
    target.absolutePath,
    content,
    expectedHash,
    '文件在写入期间又被改动，已中止'
  )

  const { valueType, sensitivity } = classify(binding.key_variable, apiKey)
  const now = Date.now()
  const db = getDatabase()
  db.transaction(() => {
    db.prepare(
      `UPDATE config_entries
       SET encrypted_value = ?, value_type = ?, sensitivity = ?, updated_at = ?
       WHERE id = ?`
    ).run(vault.encryptValue(apiKey), valueType, sensitivity, now, target.entryId)
    syncFileState(target.fileId, result.newHash, content, now)
    db.prepare('UPDATE credential_bindings SET last_synced_hash = ? WHERE id = ?').run(
      result.newHash,
      binding.id
    )
  })
}
