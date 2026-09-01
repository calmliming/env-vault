/**
 * 核心验收脚本。在真实的 Electron 运行时里跑，不走 GUI。
 *
 * 它直接 import 主进程的真实模块（不是复制一份逻辑），逐条验证：
 *   阶段 0 —— 建库 + 迁移、Vault 锁定/解锁、值加解密往返；
 *   阶段 1 —— 目录扫描、导入入库、明文加密、掩码不过桥、重扫与差异检测。
 *
 * 两种运行模式：
 *   无参数            —— 用临时目录，跑完删干净；
 *   --keep <沙箱目录> —— 用指定目录并**保留**，供 verify-ui.mjs 拿去启动真界面。
 *                        这样界面验收面对的是一份刚刚被逐条验证过的数据。
 */

import { app } from 'electron'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDatabase, getDatabaseInfo, initializeDatabase } from '../src/main/db'
import { getSchemaVersion, migrate } from '../src/main/db/migrator'
import * as repo from '../src/main/db/repositories'
import * as vault from '../src/main/security/vault'
import { VaultError } from '../src/main/security/vault'
import { applyEdits, parseEnv, serializeEnv } from '../src/main/env/document.ts'
import { MASKED_PLACEHOLDER } from '../src/shared/ipc'

interface Check {
  name: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail })
}

// --- 运行模式 ---------------------------------------------------------------

const keepIndex = process.argv.indexOf('--keep')
const keepDir = keepIndex !== -1 ? process.argv[keepIndex + 1] : undefined
const sandbox = keepDir ?? mkdtempSync(join(tmpdir(), 'envvault-verify-'))
mkdirSync(sandbox, { recursive: true })

/**
 * 🔴 有 `--user-data-dir` 时**不能**再调 `app.setPath`。
 *
 * Windows 上 `safeStorage` 的密钥存在 userData 里的 `Local State`，而那个文件的
 * 位置在 Chromium 启动早期就定了 —— `app.setPath` 发生得太晚，改不动它。
 * 结果是：主密钥用 A 目录的 OSCrypt 密钥加密、却拿 B 目录的去解，
 * 报 `Error while decrypting the ciphertext provided to safeStorage.decryptString`。
 *
 * 所以要让另一个进程能解开这里写下的 vault.key，两边必须都走 `--user-data-dir`。
 * 独立运行（没有这个开关）时才回落到 setPath —— 那种情况下加解密都在同一个进程里，
 * 不存在跨进程问题。
 */
const hasUserDataDirSwitch = process.argv.some((arg) => arg.startsWith('--user-data-dir'))
if (!hasUserDataDirSwitch) app.setPath('userData', sandbox)

/** 被扫描的样例项目。放在沙箱里，界面验收会继续用它。 */
const fixtureRoot = join(sandbox, 'fixture-project')

app.whenReady().then(() => {
  try {
    run()
  } catch (error) {
    check('脚本未抛异常', false, error instanceof Error ? error.message : String(error))
  }

  const failed = checks.filter((c) => !c.pass)
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  —  ${c.detail}`)
  console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)

  try {
    closeDatabase()
    if (!keepDir) rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* 临时目录清理失败不影响结论 */
  }

  /**
   * 🔴 成功路径必须用 `app.quit()` 而不是 `app.exit()`。
   *
   * `app.exit()` 立即终止进程，Chromium 的 pref store 来不及把 `Local State` 落盘 ——
   * 而 Windows 上 safeStorage 的 OSCrypt 密钥就存在那个文件里。密钥没写下来，
   * 下一个进程会重新生成一把，于是解不开这里写的 `vault.key`。
   * （实测：沙箱里只有 envvault.db 和 vault.key，没有 Local State。）
   *
   * 失败路径无所谓刷不刷盘，用 exit(1) 把退出码直接带出去。
   */
  if (failed.length === 0) {
    process.exitCode = 0
    app.quit()
  } else {
    app.exit(1)
  }
})

// ---------------------------------------------------------------------------

/**
 * 样例项目。刻意做得难看：CRLF、注释、行内注释、引号风格混用、
 * 含 `#` 的值、重复 key、模板文件、深层目录、依赖目录里的干扰文件。
 */
function buildFixture(): void {
  rmSync(fixtureRoot, { recursive: true, force: true })
  mkdirSync(fixtureRoot, { recursive: true })

  writeFileSync(
    join(fixtureRoot, '.env'),
    [
      '# 共享配置',
      'APP_NAME=envvault-fixture',
      'PORT=3000',
      'ENABLE_CACHE=true',
      '',
      'NEXT_PUBLIC_API_URL=https://api.example.com/v1'
    ].join('\n') + '\n'
  )

  // CRLF + 各种引号 + 含 # 的密码 + 重复 key
  writeFileSync(
    join(fixtureRoot, '.env.local'),
    [
      '# 本机覆盖，不进 Git',
      'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345',
      "DB_PASSWORD='pa#ss word'",
      'NEXTAUTH_SECRET="line1\\nline2"',
      'LOG_LEVEL=debug   # 只在本机开 debug',
      'DUP=first',
      'DUP=second'
    ].join('\r\n') + '\r\n'
  )

  writeFileSync(join(fixtureRoot, '.env.example'), 'APP_NAME=\nPORT=\n')

  mkdirSync(join(fixtureRoot, 'apps', 'web'), { recursive: true })
  writeFileSync(
    join(fixtureRoot, 'apps', 'web', '.env.production'),
    'DATABASE_URL=postgres://user:secret@db.internal:5432/app\n'
  )

  mkdirSync(join(fixtureRoot, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(fixtureRoot, 'node_modules', 'pkg', '.env'), 'GHOST=1\n')
}

function run(): void {
  // =========================================================================
  // 阶段 0：数据库与 Vault
  // =========================================================================
  const db = initializeDatabase()
  const info = getDatabaseInfo()

  check('数据库文件已创建', existsSync(info.filePath) && statSync(info.filePath).size > 0, info.filePath)
  check(
    '迁移已推进到最新版本',
    info.schemaVersion === info.latestVersion && info.latestVersion >= 3,
    `user_version=${info.schemaVersion} / latest=${info.latestVersion}`
  )
  check(
    '三条迁移都已执行',
    info.appliedMigrations.length === 3,
    info.appliedMigrations.map((m) => `${m.version}:${m.name}`).join(', ') || '（无）'
  )

  const expectedTables = [
    'activity_log',
    'config_entries',
    'credential_bindings',
    'env_files',
    'model_credentials',
    'project_exclusions',
    'projects'
  ]
  const missing = expectedTables.filter((t) => !info.tables.includes(t))
  check('§4 数据模型的表全部建好', missing.length === 0, `缺失: ${missing.join(', ') || '无'}`)

  const occurrenceColumn = db
    .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('config_entries') WHERE name = 'occurrence'")
    .get<{ n: number }>()
  check('迁移 002 加上了 occurrence 列', occurrenceColumn?.n === 1, `列数=${occurrenceColumn?.n}`)

  check('重复迁移是空操作', migrate(db).length === 0, `user_version=${getSchemaVersion(db)}`)

  const fk = db.prepare('PRAGMA foreign_keys').get<{ foreign_keys: number }>()
  check('外键约束已启用', fk?.foreign_keys === 1, `foreign_keys=${fk?.foreign_keys}`)

  const initial = vault.getStatus()
  check('系统密钥库可用', initial.keystoreAvailable, `后端=${initial.keystoreBackend}`)
  if (!initial.keystoreAvailable) {
    check('后续检查', false, '系统密钥库不可用，跳过')
    return
  }

  check('全新目录下 Vault 为未初始化', initial.state === 'uninitialized', `state=${initial.state}`)
  const created = vault.initialize()
  check('创建后 Vault 处于解锁态', created.state === 'unlocked', `state=${created.state}`)

  const secret = 'sk-verify-0123456789-абв-中文-🔐'
  const sealed = vault.encryptValue(secret)
  check('往返解密一致（含多字节字符）', vault.decryptValue(sealed) === secret, '中文/西里尔/emoji')

  const tampered = Buffer.from(sealed)
  const last = tampered.length - 1
  tampered[last] = (tampered[last]! ^ 0xff) & 0xff
  let tamperRejected = false
  try {
    vault.decryptValue(tampered)
  } catch {
    tamperRejected = true
  }
  check('篡改的密文被拒绝', tamperRejected, 'AES-256-GCM 认证标签生效')

  vault.lock()
  let lockedCode = ''
  try {
    vault.decryptValue(sealed)
  } catch (error) {
    lockedCode = error instanceof VaultError ? error.code : String(error)
  }
  check('锁定后解密被拒绝', lockedCode === 'VAULT_LOCKED', `code=${lockedCode}`)
  check('重新解锁后旧密文仍可解开', (vault.unlock(), vault.decryptValue(sealed)) === secret, '主密钥未变')

  // =========================================================================
  // 阶段 1：扫描、导入、查询
  // =========================================================================
  buildFixture()

  // --- 预览是只读的 ---------------------------------------------------------
  const preview = repo.previewProject(fixtureRoot)
  const previewPaths = preview.files.map((f) => f.relativePath).sort()
  check(
    '预览发现全部 .env* 并跳过 node_modules',
    JSON.stringify(previewPaths) ===
      JSON.stringify(['.env', '.env.example', '.env.local', 'apps/web/.env.production']),
    previewPaths.join(', ')
  )
  check('预览标出模板文件', preview.files.find((f) => f.fileName === '.env.example')?.isTemplate === true, '.env.example')
  check('预览尚未写库', repo.listProjects().length === 0, `项目数=${repo.listProjects().length}`)

  // --- 导入 -----------------------------------------------------------------
  const include = preview.files.filter((f) => !f.isTemplate).map((f) => f.absolutePath)
  const project = repo.importProject({ rootPath: fixtureRoot, name: 'fixture', includePaths: include })

  check('导入创建了项目', project.id > 0 && project.name === 'fixture', `id=${project.id}`)
  check('只纳管勾选的文件（模板未选中）', project.fileCount === 3, `文件数=${project.fileCount}`)
  check(
    '环境按常用顺序排列',
    JSON.stringify(project.environments) === JSON.stringify(['default', 'local', 'production']),
    project.environments.join(' → ')
  )

  let duplicateBlocked = ''
  try {
    repo.importProject({ rootPath: fixtureRoot, name: 'again', includePaths: include })
  } catch (error) {
    duplicateBlocked = error instanceof repo.RepositoryError ? error.code : String(error)
  }
  check('同一目录不能重复纳管', duplicateBlocked === 'ALREADY_EXISTS', `code=${duplicateBlocked}`)

  // --- 值确实是加密落库的 ---------------------------------------------------
  const rawBlob = db
    .prepare(
      `SELECT c.encrypted_value AS v FROM config_entries c
       JOIN env_files f ON f.id = c.env_file_id
       WHERE f.project_id = ? AND c.key = 'OPENAI_API_KEY'`
    )
    .get<{ v: Uint8Array }>(project.id)
  const blobText = rawBlob ? Buffer.from(rawBlob.v).toString('latin1') : ''
  check(
    '🔴 明文不落库',
    rawBlob !== undefined && !blobText.includes('sk-proj-'),
    `密文 ${rawBlob?.v.length ?? 0} 字节，未出现明文片段`
  )

  // --- 列表不带明文 ---------------------------------------------------------
  const entries = repo.listEntries({ projectId: project.id })
  const byKey = new Map(entries.map((e) => [e.key, e]))

  // .env 4 条 + .env.local 6 条（含重复的 DUP）+ .env.production 1 条
  check('条目总数正确（含重复 key）', entries.length === 11, `共 ${entries.length} 条`)
  check(
    '重复 key 两条都在',
    entries.filter((e) => e.key === 'DUP').length === 2,
    entries.filter((e) => e.key === 'DUP').map((e) => e.displayValue).join(' / ')
  )

  const apiKey = byKey.get('OPENAI_API_KEY')
  check('高危值被判为 high 并掩码', apiKey?.sensitivity === 'high' && apiKey.masked, `sensitivity=${apiKey?.sensitivity}`)
  check(
    '🔴 掩码项的明文不随列表过桥',
    apiKey?.displayValue === MASKED_PLACEHOLDER,
    `displayValue=${apiKey?.displayValue}`
  )
  check(
    '所有敏感项的 displayValue 里没有任何明文',
    entries.filter((e) => e.masked).every((e) => e.displayValue === MASKED_PLACEHOLDER),
    `掩码项 ${entries.filter((e) => e.masked).length} 条`
  )
  check(
    '非敏感项正常显示值',
    byKey.get('PORT')?.displayValue === '3000' && byKey.get('PORT')?.masked === false,
    `PORT=${byKey.get('PORT')?.displayValue}`
  )
  check(
    '带凭据的连接串被判为 secret',
    byKey.get('DATABASE_URL')?.valueType === 'secret',
    `valueType=${byKey.get('DATABASE_URL')?.valueType}`
  )
  check(
    '前端公开变量不被误判为 secret',
    byKey.get('NEXT_PUBLIC_API_URL')?.valueType === 'url',
    `valueType=${byKey.get('NEXT_PUBLIC_API_URL')?.valueType}`
  )

  // --- 明文只走 reveal，且留痕 ---------------------------------------------
  const revealed = repo.revealEntry(apiKey!.id)
  check(
    'reveal 返回正确明文',
    revealed.value === 'sk-proj-abcdefghijklmnopqrstuvwxyz012345',
    `key=${revealed.key}`
  )
  const hashPassword = repo.revealEntry(byKey.get('DB_PASSWORD')!.id)
  check(
    '含 # 的值没有被截断',
    hashPassword.value === 'pa#ss word',
    JSON.stringify(hashPassword.value)
  )
  const multiline = repo.revealEntry(byKey.get('NEXTAUTH_SECRET')!.id)
  check('双引号内的 \\n 解析成真换行', multiline.value === 'line1\nline2', JSON.stringify(multiline.value))
  const inline = repo.revealEntry(byKey.get('LOG_LEVEL')!.id)
  check('行内注释没有进入值', inline.value === 'debug', JSON.stringify(inline.value))

  const revealLog = repo.listActivity(100).filter((r) => r.action === 'entry.reveal')
  check('每次 reveal 都留了记录', revealLog.length === 4, `记录 ${revealLog.length} 条`)
  check(
    '🔴 操作记录里不含明文值',
    revealLog.every((r) => !JSON.stringify(r).includes('sk-proj-') && !JSON.stringify(r).includes('pa#ss')),
    '只记 key 名'
  )

  // --- 环境筛选 -------------------------------------------------------------
  const localOnly = repo.listEntries({ projectId: project.id, environment: 'local' })
  check(
    '按环境筛选生效',
    localOnly.length === 6 && localOnly.every((e) => e.environment === 'local'),
    `local 环境 ${localOnly.length} 条`
  )

  // --- 文件健康度 -----------------------------------------------------------
  const files = repo.listFiles(project.id)
  check('刚导入时所有文件都一致', files.every((f) => !f.drifted), `${files.length} 个文件`)

  // --- 外部修改与重扫 -------------------------------------------------------
  const localPath = join(fixtureRoot, '.env.local')
  const before = readFileSync(localPath, 'utf8')
  writeFileSync(localPath, before.replace('LOG_LEVEL=debug', 'LOG_LEVEL=info'))

  const driftedFiles = repo.listFiles(project.id).filter((f) => f.drifted)
  check(
    '外部修改被哈希检测出来',
    driftedFiles.length === 1 && driftedFiles[0]?.fileName === '.env.local',
    driftedFiles.map((f) => f.relativePath).join(', ')
  )

  // 新增一个文件，验证重扫会自动纳管
  writeFileSync(join(fixtureRoot, '.env.staging'), 'STAGE=1\n')
  const rescan = repo.rescanProject(project.id)
  check(
    '重扫：1 个更新、1 个新增、0 个缺失',
    rescan.updatedFiles === 1 && rescan.addedFiles === 1 && rescan.missingFiles === 0,
    `更新 ${rescan.updatedFiles} / 新增 ${rescan.addedFiles} / 缺失 ${rescan.missingFiles}`
  )
  check('重扫后不再有差异', repo.listFiles(project.id).every((f) => !f.drifted), '哈希已更新')

  // 🔴 回归守卫：导入时取消勾选的 .env.example 不能被重扫悄悄收进来。
  // 这条是验收脚本自己抓出来的 bug，修法是 migration 003 的 project_exclusions。
  check(
    '被取消勾选的文件不会被重扫自动纳管',
    !repo.listFiles(project.id).some((f) => f.fileName === '.env.example'),
    repo.listFiles(project.id).map((f) => f.fileName).join(', ')
  )

  const afterRescan = repo.listEntries({ projectId: project.id })
  const newLogLevel = afterRescan.find((e) => e.key === 'LOG_LEVEL')
  check(
    '重扫读到了外部改后的新值',
    newLogLevel !== undefined && repo.revealEntry(newLogLevel.id).value === 'info',
    'LOG_LEVEL: debug → info'
  )

  // 没变的文件不该被重建条目 —— 将来的凭据绑定要指向这些 id
  const portEntry = afterRescan.find((e) => e.key === 'PORT')
  check(
    '未变化文件的条目 id 保持稳定',
    portEntry?.id === byKey.get('PORT')?.id,
    `导入时 id=${byKey.get('PORT')?.id}，重扫后 id=${portEntry?.id}`
  )

  // 文件消失只标记，不删记录
  rmSync(join(fixtureRoot, '.env.staging'))
  const afterDelete = repo.rescanProject(project.id)
  check('磁盘文件消失被记为 missing', afterDelete.missingFiles === 1, `缺失 ${afterDelete.missingFiles}`)
  check(
    '文件消失后记录仍在（不替用户删）',
    repo.listFiles(project.id).some((f) => f.fileName === '.env.staging' && f.currentHash === null),
    '标记为已丢失'
  )

  // --- 写回格式保持（阶段 1 验收句的后半段）--------------------------------
  const original = readFileSync(join(fixtureRoot, '.env.local'), 'utf8')
  const doc = parseEnv(original)
  const edited = applyEdits(doc, [{ key: 'LOG_LEVEL', value: 'warn' }])
  const rewritten = serializeEnv(edited.doc)

  const originalLines = original.split('\r\n')
  const rewrittenLines = rewritten.split('\r\n')
  const differing = originalLines
    .map((line, i) => (line === rewrittenLines[i] ? null : i))
    .filter((i): i is number => i !== null)

  check(
    '🔴 改一个值，只有那一行变（CRLF、注释、引号全部保留）',
    differing.length === 1 && originalLines[differing[0]!]?.startsWith('LOG_LEVEL='),
    `变化行号: ${differing.map((i) => i + 1).join(', ')}`
  )
  check(
    '行内注释在写回后仍在',
    rewrittenLines[differing[0]!] === 'LOG_LEVEL=warn   # 只在本机开 debug',
    JSON.stringify(rewrittenLines[differing[0]!])
  )

  // =========================================================================
  // 阶段 2：§6.4 外部修改的两个方向
  // =========================================================================
  const envPath = join(fixtureRoot, '.env')
  const envFile = repo.listFiles(project.id).find((f) => f.fileName === '.env')!

  // 在编辑器里改一个值、加一个新变量、删一个旧变量
  writeFileSync(
    envPath,
    [
      '# 共享配置',
      'APP_NAME=envvault-fixture',
      'PORT=8080', // changed
      'ENABLE_CACHE=true',
      '',
      'NEXT_PUBLIC_API_URL=https://api.example.com/v1',
      'BRAND_NEW=hello' // added
    ].join('\n') + '\n'
  )

  const diff = repo.diffFile(envFile.id)
  check(
    '逐变量差异：1 改、1 增、0 删',
    diff.summary.changed === 1 && diff.summary.added === 1 && diff.summary.removed === 0,
    `改 ${diff.summary.changed} / 增 ${diff.summary.added} / 删 ${diff.summary.removed} / 同 ${diff.summary.unchanged}`
  )
  const portRow = diff.rows.find((r) => r.key === 'PORT')
  check(
    '改动项两侧的值都带出来了',
    portRow?.centralPreview === '3000' && portRow.diskPreview === '8080',
    `${portRow?.centralPreview} → ${portRow?.diskPreview}`
  )
  check(
    '未改动的项不会因为下面多了一行就飘红',
    diff.rows.find((r) => r.key === 'APP_NAME')?.status === 'unchanged',
    `APP_NAME=${diff.rows.find((r) => r.key === 'APP_NAME')?.status}`
  )

  // 敏感项的差异也不能把明文铺在一览视图里
  const localFile = repo.listFiles(project.id).find((f) => f.fileName === '.env.local')!
  const localOriginal = readFileSync(join(fixtureRoot, '.env.local'), 'utf8')
  writeFileSync(
    join(fixtureRoot, '.env.local'),
    localOriginal.replace('sk-proj-abcdefghijklmnopqrstuvwxyz012345', 'sk-proj-DIFFERENT-KEY-9876543210')
  )
  const localDiff = repo.diffFile(localFile.id)
  const keyRow = localDiff.rows.find((r) => r.key === 'OPENAI_API_KEY')
  check(
    '🔴 敏感项的差异两侧都是掩码，不铺明文',
    keyRow?.status === 'changed' &&
      keyRow.centralPreview === MASKED_PLACEHOLDER &&
      keyRow.diskPreview === MASKED_PLACEHOLDER,
    `status=${keyRow?.status} central=${keyRow?.centralPreview}`
  )
  check(
    '🔴 整个差异结构里搜不到任何一把 Key',
    !JSON.stringify(localDiff).includes('sk-proj-'),
    '序列化后无明文片段'
  )

  // --- 方向一：以磁盘为准 ---------------------------------------------------
  const adopted = repo.adoptDiskFile(envFile.id)
  check('以磁盘为准后条目数变为 5', adopted.entryCount === 5, `entryCount=${adopted.entryCount}`)
  check('以磁盘为准后该文件不再有差异', repo.listFiles(project.id).find((f) => f.id === envFile.id)?.drifted === false, '哈希已对齐')
  const afterAdopt = repo.listEntries({ projectId: project.id, environment: 'default' })
  check(
    '磁盘上的新值进了中心记录',
    repo.revealEntry(afterAdopt.find((e) => e.key === 'PORT')!.id).value === '8080',
    'PORT: 3000 → 8080'
  )
  check(
    '磁盘上新增的变量也被收进来',
    afterAdopt.some((e) => e.key === 'BRAND_NEW'),
    afterAdopt.map((e) => e.key).join(', ')
  )

  // --- 方向二：以中心记录为准 -----------------------------------------------
  const beforeRestore = readFileSync(join(fixtureRoot, '.env.local'), 'utf8')
  const localDiffNow = repo.diffFile(localFile.id)
  const restored = repo.restoreFileFromCentral(
    localFile.id,
    ['OPENAI_API_KEY'],
    localDiffNow.currentHash
  )
  const afterRestore = readFileSync(join(fixtureRoot, '.env.local'), 'utf8')

  check('写回了 1 项', restored.written === 1, `written=${restored.written}`)
  check(
    '中心记录里的原值回到了文件里',
    afterRestore.includes('sk-proj-abcdefghijklmnopqrstuvwxyz012345'),
    '磁盘上的临时改动已被覆盖'
  )

  const beforeLines = beforeRestore.split('\r\n')
  const afterLines = afterRestore.split('\r\n')
  const touched = beforeLines
    .map((line, i) => (line === afterLines[i] ? null : i))
    .filter((i): i is number => i !== null)
  check(
    '🔴 只有那一行变了：CRLF、注释、单引号、行内注释全部保留',
    touched.length === 1 && beforeLines[touched[0]!]?.startsWith('OPENAI_API_KEY='),
    `变化行号: ${touched.map((i) => i + 1).join(', ')}`
  )
  check(
    '原文件已备份且备份内容是改动前的版本',
    existsSync(restored.backupPath) && readFileSync(restored.backupPath, 'utf8') === beforeRestore,
    restored.backupPath
  )
  check(
    '备份不落在用户项目目录里',
    !restored.backupPath.startsWith(fixtureRoot),
    '在 userData/backups 下'
  )
  check('写回后该文件不再有差异', repo.listFiles(project.id).find((f) => f.id === localFile.id)?.drifted === false, '哈希已更新')

  // --- 并发保护 -------------------------------------------------------------
  // 模拟"算完差异之后、点确认之前，文件又被别人改了"
  const conflictFile = repo.listFiles(project.id).find((f) => f.fileName === '.env')!
  // 用户在这一刻看到差异，并基于它做决定
  const staleDiff = repo.diffFile(conflictFile.id)
  // 他还在看的时候，别人改了文件
  writeFileSync(envPath, readFileSync(envPath, 'utf8') + 'SNEAKY=someone-else\n')

  let conflictCode = ''
  try {
    repo.restoreFileFromCentral(conflictFile.id, ['PORT'], staleDiff.currentHash)
  } catch (error) {
    conflictCode = error instanceof repo.RepositoryError ? error.code : String(error)
  }
  check(
    '🔴 期间被外部改过就中止写入（§6.4 核心禁令）',
    conflictCode === 'PATH_REJECTED',
    `code=${conflictCode}`
  )
  check(
    '别人的修改原封不动',
    readFileSync(envPath, 'utf8').includes('SNEAKY=someone-else'),
    '中止后未覆盖'
  )

  // 磁盘上不存在的 key 不静默追加
  repo.adoptDiskFile(conflictFile.id) // 先对齐哈希
  writeFileSync(envPath, readFileSync(envPath, 'utf8').replace('SNEAKY=someone-else\n', ''))
  const freshDiff = repo.diffFile(conflictFile.id)
  const partial = repo.restoreFileFromCentral(
    conflictFile.id,
    ['PORT', 'SNEAKY'],
    freshDiff.currentHash
  )
  check(
    '文件里不存在的 key 进 skipped，不被追加',
    partial.skipped.includes('SNEAKY') && !readFileSync(envPath, 'utf8').includes('SNEAKY'),
    `skipped=${partial.skipped.join(', ')}`
  )

  // --- Vault 锁定后读不到值 -------------------------------------------------
  vault.lock()
  let listBlocked = ''
  try {
    repo.listEntries({ projectId: project.id })
  } catch (error) {
    listBlocked = error instanceof VaultError ? error.code : String(error)
  }
  check('Vault 锁定后无法列出配置值', listBlocked === 'VAULT_LOCKED', `code=${listBlocked}`)

  let revealBlocked = ''
  try {
    repo.revealEntry(apiKey!.id)
  } catch (error) {
    revealBlocked = error instanceof VaultError ? error.code : String(error)
  }
  check('Vault 锁定后无法 reveal', revealBlocked === 'VAULT_LOCKED', `code=${revealBlocked}`)
  check('但文件健康度仍可读（不含明文）', repo.listFiles(project.id).length > 0, '哈希比对不需要主密钥')

  // 留给界面验收的是锁定态：让它自己走一遍解锁 → 数据出现。
  if (keepDir) {
    console.log(`\n沙箱已保留：${sandbox}`)
    console.log(`样例项目：${fixtureRoot}`)
  }
}
