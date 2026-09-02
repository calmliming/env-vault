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
import * as cred from '../src/main/db/credentials'
import * as vault from '../src/main/security/vault'
import { VaultError } from '../src/main/security/vault'
import { applyEdits, entriesOf, parseEnv, serializeEnv } from '../src/main/env/document.ts'
import type { ValidationTransport } from '../src/main/providers/validate.ts'
import { electronTransport } from '../src/main/net/transport'
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

/**
 * 🔴 这个进程一个字节都不许出网。
 *
 * 验收会走到「向厂商验证一把 Key」那条路，而那条路正常情况下是真的发包的。
 * 下面每一处验证都注入了假传输，但「记得注入」是一条靠自觉的规矩 ——
 * 一旦哪天有人加了一条断言忘了注入，后果是把测试用的假 Key 发到真实厂商去，
 * 而且测试照样绿，没有任何东西会提醒你。
 *
 * 所以在真传输那一侧（`src/main/net/transport.ts`）留了一道见到这个变量
 * 就拒发的拦，让「忘了注入」变成一次响亮的失败。本节末尾有一条断言
 * 直接调真传输，确认这道拦不是摆设。
 *
 * 必须在 import 之后、任何验证发生之前设上。写在脚本里而不是 npm script 里，
 * 是为了不给跨平台的环境变量语法引入一个 cross-env 依赖。
 */
process.env.ENVVAULT_BLOCK_NETWORK = '1'

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

app.whenReady().then(async () => {
  try {
    // `run` 从阶段 3 收尾起是异步的 —— 厂商验证那一节要 await 一个（假的）请求。
    await run()
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
      // 阶段 3 专用：绑定、同步、轮换、删除都拿这一条练手。
      // 不复用 OPENAI_API_KEY 是因为同步会覆盖它的值，而界面验收
      // 还要靠那把 Key 验「没点显示就不给明文」。
      'ANTHROPIC_API_KEY=sk-ant-api03-fixture-0123456789abcdef',
      // 三条而不是两条：删掉中间/开头的一条之后，剩下的序号必须整体前移。
      // 只有两条时，applyEdits 对越界序号的"夹到边界"会碰巧命中正确的那一行，
      // 于是"忘了重新编号"这个 bug 在两条的样本上是看不见的。
      'DUP=first',
      'DUP=second',
      'DUP=third'
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

async function run(): Promise<void> {
  // =========================================================================
  // 阶段 0：数据库与 Vault
  // =========================================================================
  const db = initializeDatabase()
  const info = getDatabaseInfo()

  check('数据库文件已创建', existsSync(info.filePath) && statSync(info.filePath).size > 0, info.filePath)
  check(
    '迁移已推进到最新版本',
    info.schemaVersion === info.latestVersion && info.latestVersion >= 4,
    `user_version=${info.schemaVersion} / latest=${info.latestVersion}`
  )
  check(
    '四条迁移都已执行',
    info.appliedMigrations.length === 4,
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

  // .env 4 条 + .env.local 8 条（含重复的 DUP 三条）+ .env.production 1 条
  check('条目总数正确（含重复 key）', entries.length === 13, `共 ${entries.length} 条`)
  check(
    '重复 key 三条都在',
    entries.filter((e) => e.key === 'DUP').length === 3,
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
    localOnly.length === 8 && localOnly.every((e) => e.environment === 'local'),
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

  // =========================================================================
  // 阶段 2（续）：编辑与删除单个变量（计划 §9 阶段 2 的最后两项）
  // =========================================================================

  /** 磁盘当前哈希 —— 界面手里那个 expectedHash 就是从这条路来的。 */
  const diskHashOf = (fileName: string): string =>
    repo.listFiles(project.id).find((f) => f.fileName === fileName)!.currentHash!
  const entryOf = (key: string) =>
    repo.listEntries({ projectId: project.id }).find((e) => e.key === key)!

  // --- 改一个值：中心记录与磁盘一起变 ---------------------------------------
  const envBeforeEdit = readFileSync(envPath, 'utf8')
  const portId = entryOf('PORT').id
  const portEdit = repo.updateEntryValue(portId, '4321', diskHashOf('.env'))

  check('编辑更新了中心记录', repo.revealEntry(portId).value === '4321', 'PORT: 8080 → 4321')
  check(
    '编辑立刻写盘，不需要再点一次同步',
    portEdit.written && readFileSync(envPath, 'utf8').includes('PORT=4321'),
    `written=${portEdit.written}`
  )

  const editedLines = readFileSync(envPath, 'utf8').split('\n')
  const beforeEditLines = envBeforeEdit.split('\n')
  const editTouched = beforeEditLines
    .map((line, i) => (line === editedLines[i] ? null : i))
    .filter((i): i is number => i !== null)
  check(
    '🔴 编辑只改那一行，注释与空行原样保留',
    editTouched.length === 1 && beforeEditLines[editTouched[0]!] === 'PORT=8080',
    `变化行号: ${editTouched.map((i) => i + 1).join(', ') || '无'}`
  )
  check(
    '编辑前备份了原文件，备份内容是改动前的版本',
    portEdit.backupPath !== null && readFileSync(portEdit.backupPath, 'utf8') === envBeforeEdit,
    portEdit.backupPath ?? '（没有备份）'
  )
  check(
    '编辑的备份不落在用户项目目录里',
    portEdit.backupPath !== null && !portEdit.backupPath.startsWith(fixtureRoot),
    '在 userData/backups 下'
  )

  const noop = repo.updateEntryValue(portId, '4321', diskHashOf('.env'))
  check(
    '值没变时不写盘、不备份、不留一条空操作记录',
    noop.written === false && noop.backupPath === null,
    `written=${noop.written} backup=${noop.backupPath}`
  )

  // 值变了，类型和敏感度要跟着重新判 —— 把普通值改成一把真 Key，
  // 下一次列表就该把它掩码起来，而不是等到下次重扫。
  const NEW_SECRET = 'sk-ant-api03-verify-abcdefghijklmnop'
  repo.updateEntryValue(entryOf('BRAND_NEW').id, NEW_SECRET, diskHashOf('.env'))
  const reclassified = entryOf('BRAND_NEW')
  check(
    '编辑后重新分类：普通值改成真 Key 会立刻升级为敏感并掩码',
    reclassified.sensitivity === 'high' && reclassified.displayValue === MASKED_PLACEHOLDER,
    `sensitivity=${reclassified.sensitivity} display=${reclassified.displayValue}`
  )

  // --- 🔴 明文不落库：这次扫整行，不只扫 encrypted_value ---------------------
  //
  // 上面那条同名断言只翻了 encrypted_value 一列，够不着 original_format ——
  // 而 original_format 是不加密的 TEXT 列，一直存着**完整的原始行**，
  // 于是每一把 Key 的明文都躺在库里。断言绿的，漏洞在的。
  // 一条够不着目标的断言和一条真通过了的断言，在报告上长得一模一样（§5 的教训）。
  const NEEDLES = ['sk-proj-', 'sk-ant-', 'pa#ss', 'user:secret', 'line1\\nline2']
  const leakedColumns = db
    .prepare(
      `SELECT c.* FROM config_entries c
       JOIN env_files f ON f.id = c.env_file_id
       WHERE f.project_id = ?`
    )
    .all<Record<string, unknown>>(project.id)
    .flatMap((row) =>
      Object.entries(row)
        .filter(([, v]) => typeof v === 'string' && NEEDLES.some((n) => v.includes(n)))
        .map(([column]) => column)
    )
  check(
    '🔴 config_entries 的每一列都没有明文（不只是 encrypted_value）',
    leakedColumns.length === 0,
    leakedColumns.length === 0
      ? '逐列扫描通过'
      : `泄漏的列: ${[...new Set(leakedColumns)].join(', ')}`
  )

  // 再从字节层面兜一次底：WAL 模式下最近的写可能还在 -wal 里。
  const dbBytes = [info.filePath, `${info.filePath}-wal`]
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path).toString('latin1'))
    .join('')
  const leakedNeedles = NEEDLES.filter((needle) => dbBytes.includes(needle))
  check(
    '🔴 数据库文件的字节里也搜不到明文片段',
    leakedNeedles.length === 0,
    leakedNeedles.length === 0
      ? `扫了 ${Math.round(dbBytes.length / 1024)} KiB（含 -wal）`
      : `命中: ${leakedNeedles.join(', ')}`
  )

  // --- 守卫一：文件有未处理的外部改动时，不许就地编辑 ------------------------
  // 这时候写下去等于替用户默默选了 §6.4 的方向，把别人的修改盖掉。
  const hashBeforeInterloper = diskHashOf('.env')
  writeFileSync(envPath, readFileSync(envPath, 'utf8') + 'INTERLOPER=1\n')

  let driftRefused = ''
  try {
    // 注意：这里传的是**当前**磁盘哈希，所以并发校验那一关是过得去的。
    // 能拦下来只可能是「文件与记录不一致」这道守卫 —— 两道守卫各自可达。
    repo.updateEntryValue(portId, '9999', diskHashOf('.env'))
  } catch (error) {
    driftRefused = error instanceof repo.RepositoryError ? error.code : String(error)
  }
  check(
    '🔴 文件有未处理的外部改动时拒绝就地编辑（先走差异流程）',
    driftRefused === 'PATH_REJECTED',
    `code=${driftRefused}`
  )
  check(
    '被拒绝后别人的修改和中心记录都没被动过',
    readFileSync(envPath, 'utf8').includes('INTERLOPER=1') &&
      repo.revealEntry(portId).value === '4321',
    '文件与记录都原样'
  )

  // --- 守卫二：调用方手里的哈希过期了 ---------------------------------------
  // 先把外部改动收进来，让「文件与记录不一致」这道守卫过关，
  // 只剩下"你做决定时看到的内容已经不是现在这份了"这一种可能。
  repo.adoptDiskFile(repo.listFiles(project.id).find((f) => f.fileName === '.env')!.id)
  const portIdAfterAdopt = entryOf('PORT').id

  let staleRefused = ''
  try {
    repo.updateEntryValue(portIdAfterAdopt, '9999', hashBeforeInterloper)
  } catch (error) {
    staleRefused = error instanceof repo.RepositoryError ? error.code : String(error)
  }
  check(
    '🔴 调用方基于旧版本做的决定被中止（expectedHash 过期）',
    staleRefused === 'PATH_REJECTED',
    `code=${staleRefused}`
  )
  check(
    '中止后值没有被改成 9999',
    repo.revealEntry(portIdAfterAdopt).value === '4321',
    `PORT=${repo.revealEntry(portIdAfterAdopt).value}`
  )

  // --- 删除：记录和文件里那一行一起消失 -------------------------------------
  const envBeforeDelete = readFileSync(envPath, 'utf8')
  const interloperId = entryOf('INTERLOPER').id
  const deleted = repo.deleteEntry(interloperId, diskHashOf('.env'))

  check(
    '删除同时清掉了中心记录',
    !repo.listEntries({ projectId: project.id }).some((e) => e.key === 'INTERLOPER'),
    '记录里已无 INTERLOPER'
  )
  check(
    '删除把文件里的那一行也删掉了',
    deleted.written && !readFileSync(envPath, 'utf8').includes('INTERLOPER'),
    `written=${deleted.written}`
  )
  check(
    '🔴 删除只少那一行，其余逐行不变',
    JSON.stringify(readFileSync(envPath, 'utf8').split('\n')) ===
      JSON.stringify(envBeforeDelete.split('\n').filter((line) => line !== 'INTERLOPER=1')),
    '注释、空行与其余变量都在'
  )
  check(
    '删除前也备份了原文件',
    deleted.backupPath !== null && readFileSync(deleted.backupPath, 'utf8') === envBeforeDelete,
    deleted.backupPath ?? '（没有备份）'
  )

  // --- 删除重复 key 里的一条：剩下的序号必须重新对齐磁盘 --------------------
  const localBeforeDupDelete = readFileSync(localPath, 'utf8')
  const dupBefore = repo
    .listEntries({ projectId: project.id })
    .filter((e) => e.key === 'DUP')
  const dupDeleted = repo.deleteEntry(dupBefore[0]!.id, diskHashOf('.env.local'))
  const localAfterDupDelete = readFileSync(localPath, 'utf8')

  check(
    '删掉重复 key 的第一条，文件里只少那一行',
    dupDeleted.written &&
      JSON.stringify(localAfterDupDelete.split('\r\n')) ===
        JSON.stringify(localBeforeDupDelete.split('\r\n').filter((line) => line !== 'DUP=first')),
    `剩下 ${localAfterDupDelete.split('\r\n').filter((l) => l.startsWith('DUP=')).length} 条 DUP`
  )

  const dupRows = db
    .prepare(
      `SELECT c.occurrence FROM config_entries c
       JOIN env_files f ON f.id = c.env_file_id
       WHERE f.absolute_path = ? AND c.key = 'DUP'
       ORDER BY c.occurrence ASC`
    )
    .all<{ occurrence: number }>(localPath)
  check(
    '🔴 剩下两条的 occurrence 重新编号为 0、1',
    JSON.stringify(dupRows.map((r) => r.occurrence)) === JSON.stringify([0, 1]),
    `occurrence=${dupRows.map((r) => r.occurrence).join(', ')}`
  )

  // 上面那条是白盒断言，这条证明它确实有用：序号没重编的话，
  // 这次编辑会落到 DUP=third 那一行上，而且不会报任何错。
  const survivingDup = repo.listEntries({ projectId: project.id }).filter((e) => e.key === 'DUP')
  repo.updateEntryValue(survivingDup[0]!.id, 'survivor', diskHashOf('.env.local'))
  const dupLines = readFileSync(localPath, 'utf8')
    .split('\r\n')
    .filter((line) => line.startsWith('DUP='))
  check(
    '🔴 序号重编之后，编辑第一条改的是正确的那一行',
    JSON.stringify(dupLines) === JSON.stringify(['DUP=survivor', 'DUP=third']),
    dupLines.join(' / ')
  )

  // --- 行号与磁盘对齐 -------------------------------------------------------
  const localDoc = parseEnv(readFileSync(localPath, 'utf8'))
  const diskLines = new Map(
    entriesOf(localDoc).map((node, index) => [`${node.key}#${index}`, node.lineNumber])
  )
  const storedLines = db
    .prepare(
      `SELECT c.key, c.source_line FROM config_entries c
       JOIN env_files f ON f.id = c.env_file_id
       WHERE f.absolute_path = ?
       ORDER BY c.source_line ASC, c.id ASC`
    )
    .all<{ key: string; source_line: number }>(localPath)
  const lineMismatch = storedLines.filter(
    (row, index) => diskLines.get(`${row.key}#${index}`) !== row.source_line
  )
  check(
    '删除之后中心记录的行号跟着磁盘整体上移',
    lineMismatch.length === 0 && storedLines.length === entriesOf(localDoc).length,
    lineMismatch.length === 0
      ? `${storedLines.length} 条行号与磁盘一致`
      : `对不上: ${lineMismatch.map((r) => r.key).join(', ')}`
  )

  // --- 中心记录里的陈旧条目：磁盘上本来就没有这一行 -------------------------
  // 删它只清记录，不该去动文件（连备份都不该产生）。
  const productionFile = repo.listFiles(project.id).find((f) => f.fileName === '.env.production')!
  const productionPath = join(fixtureRoot, 'apps', 'web', '.env.production')
  db.prepare(
    `INSERT INTO config_entries (env_file_id, key, occurrence, encrypted_value, value_type,
       sensitivity, source_line, original_format, updated_at)
     VALUES (?, 'GHOST_ENTRY', 0, ?, 'text', 'normal', 99, NULL, ?)`
  ).run(productionFile.id, vault.encryptValue('stale'), Date.now())

  const productionBefore = readFileSync(productionPath, 'utf8')
  const ghost = repo.deleteEntry(entryOf('GHOST_ENTRY').id, diskHashOf('.env.production'))
  check(
    '磁盘上没有的陈旧条目：只清记录，文件一个字节不碰',
    ghost.written === false &&
      ghost.backupPath === null &&
      readFileSync(productionPath, 'utf8') === productionBefore,
    `written=${ghost.written} backup=${ghost.backupPath}`
  )

  // --- 中心记录与磁盘在某个 key 上早就分叉了 --------------------------------
  //
  // 「以记录为准」只勾了部分变量时会留下这种状态：文件哈希是对的，
  // 但另一个 key 的中心值和磁盘不一样。这时把中心值改成磁盘上已有的那个值，
  // 应该只对齐记录、不写文件 —— 而不是报「变量找不到」。
  const forkedFile = repo.listFiles(project.id).find((f) => f.fileName === '.env.local')!
  db.prepare(
    `UPDATE config_entries SET encrypted_value = ?
     WHERE env_file_id = ? AND key = 'LOG_LEVEL'`
  ).run(vault.encryptValue('分叉了'), forkedFile.id)

  const localBeforeAlign = readFileSync(localPath, 'utf8')
  // 磁盘上 LOG_LEVEL 是 info（外部改动后被重扫收进来的）。
  const aligned = repo.updateEntryValue(entryOf('LOG_LEVEL').id, 'info', diskHashOf('.env.local'))
  check(
    '中心值追上磁盘上已有的值：只对齐记录，不写文件',
    aligned.written === false &&
      aligned.backupPath === null &&
      readFileSync(localPath, 'utf8') === localBeforeAlign &&
      repo.revealEntry(entryOf('LOG_LEVEL').id).value === 'info',
    `written=${aligned.written} 文件未变=${readFileSync(localPath, 'utf8') === localBeforeAlign}`
  )

  // --- 操作记录：有痕迹，但没有值 -------------------------------------------
  const mutationLog = repo
    .listActivity(200)
    .filter((r) => r.action === 'entry.update' || r.action === 'entry.delete')
  check(
    '编辑与删除都留了操作记录',
    mutationLog.some((r) => r.action === 'entry.update') &&
      mutationLog.some((r) => r.action === 'entry.delete'),
    `${mutationLog.length} 条`
  )
  check(
    '🔴 编辑/删除的记录里只有 key 名，没有新旧值',
    !NEEDLES.some((needle) => JSON.stringify(mutationLog).includes(needle)) &&
      !JSON.stringify(mutationLog).includes('4321'),
    '只记 key 名与文件路径'
  )

  // 留给界面验收的必须是一份干净数据：三个文件哈希对齐、.env.staging 已丢失。
  const leftover = repo.listFiles(project.id).filter((f) => f.drifted)
  check(
    '这一段跑完后只剩「磁盘上已消失」那一个差异',
    leftover.length === 1 && leftover[0]?.fileName === '.env.staging',
    leftover.map((f) => `${f.fileName}:${f.currentHash === null ? '已丢失' : '有改动'}`).join(', ')
  )

  // =========================================================================
  // 阶段 3：模型凭据库
  // =========================================================================

  // --- 适配器是纯的：跑遍五家也不该产生任何出站流量 -------------------------
  const providers = cred.listProviders()
  check(
    '首批五家厂商加自定义厂商都在（§8）',
    providers.length === 6 && providers.some((p) => p.id === 'anthropic'),
    providers.map((p) => p.providerName).join('、')
  )

  // --- 识别建议（§6.2 步骤 1）----------------------------------------------
  const suggested = cred.suggestCredentials(project.id)
  const anthropicSuggestion = suggested.find((s) => s.key === 'ANTHROPIC_API_KEY')
  check(
    '从变量里识别出模型凭据',
    anthropicSuggestion !== undefined,
    suggested.map((s) => s.key).join(', ') || '（无）'
  )
  check(
    '按值识别：sk-ant- 指向 Anthropic',
    anthropicSuggestion?.providers[0]?.providerId === "anthropic" &&
      anthropicSuggestion.providers[0]?.basis === 'both',
    `${anthropicSuggestion?.providers[0]?.providerName} / ${anthropicSuggestion?.providers[0]?.basis}`
  )
  check(
    '普通变量不会被误判成凭据',
    !suggested.some((s) => ['PORT', 'APP_NAME', 'ENABLE_CACHE'].includes(s.key)),
    suggested.map((s) => s.key).join(', ') || '（无）'
  )
  check(
    '🔴 识别建议里不含任何 Key 明文',
    !NEEDLES.some((needle) => JSON.stringify(suggested).includes(needle)),
    '只给变量名、环境与厂商候选'
  )

  // --- 创建凭据：明文加密入库 -----------------------------------------------
  const ROTATED_KEY = 'sk-ant-api03-rotated-0123456789abcdef'
  const primary = cred.createCredential({
    providerId: 'anthropic',
    credentialName: 'verify-primary',
    endpoint: 'https://api.anthropic.com/v1',
    apiKey: 'sk-ant-api03-original-0123456789abcdef'
  })
  check(
    '凭据创建后只暴露指纹与末四位',
    primary.lastFour === 'cdef' && primary.fingerprint.length === 16,
    `lastFour=${primary.lastFour} fingerprint=${primary.fingerprint}`
  )
  check(
    '🔴 凭据列表里没有 Key 明文',
    !JSON.stringify(cred.listCredentials()).includes('sk-ant-api03-original'),
    '只有指纹和末四位'
  )

  const credentialBlob = db
    .prepare('SELECT encrypted_api_key AS v FROM model_credentials WHERE id = ?')
    .get<{ v: Uint8Array }>(primary.id)
  check(
    '🔴 Key 加密落库',
    credentialBlob !== undefined &&
      !Buffer.from(credentialBlob.v).toString('latin1').includes('sk-ant-api03-original'),
    `密文 ${credentialBlob?.v.length ?? 0} 字节`
  )

  // 指纹要能回答「这两处是不是同一把 Key」，且不能从指纹反推出 Key
  const twin = cred.createCredential({
    providerId: 'anthropic',
    credentialName: 'verify-twin',
    endpoint: 'https://api.anthropic.com/v1',
    apiKey: 'sk-ant-api03-original-0123456789abcdef'
  })
  check(
    '同一把 Key 在两条记录上得到相同指纹',
    twin.fingerprint === primary.fingerprint,
    `${primary.fingerprint} === ${twin.fingerprint}`
  )
  check(
    '🔴 指纹里搜不到 Key 的任何片段',
    !primary.fingerprint.includes('original') && !primary.fingerprint.includes('cdef'),
    primary.fingerprint
  )
  cred.deleteCredential(twin.id)

  // --- 绑定 -----------------------------------------------------------------
  const bindings = cred.bindCredential(primary.id, {
    projectId: project.id,
    environment: 'local',
    keyVariable: 'ANTHROPIC_API_KEY'
  })
  check(
    '绑定建立成功并能定位到真实变量',
    bindings.length === 1 && bindings[0]?.unresolved === false,
    `${bindings[0]?.projectName} / ${bindings[0]?.environment} / ${bindings[0]?.keyVariable}`
  )

  let duplicateBind = ''
  try {
    cred.bindCredential(primary.id, {
      projectId: project.id,
      environment: 'local',
      keyVariable: 'ANTHROPIC_API_KEY'
    })
  } catch (error) {
    duplicateBind = error instanceof repo.RepositoryError ? error.code : String(error)
  }
  check(
    '同一个变量不能重复绑定',
    duplicateBind === 'ALREADY_EXISTS',
    `code=${duplicateBind}`
  )

  // --- 🔴 绑定之后配置表里不能再就地改这个变量 ------------------------------
  const boundEntry = entryOf('ANTHROPIC_API_KEY')
  check(
    '配置表仍然看得到这个变量和它的绑定状态（阶段 3 验收）',
    boundEntry.managedBy?.credentialName === 'verify-primary' &&
      boundEntry.managedBy.role === 'key',
    `managedBy=${boundEntry.managedBy?.credentialName} / ${boundEntry.managedBy?.role}`
  )

  let managedEditRefused = ''
  try {
    repo.updateEntryValue(boundEntry.id, 'sk-hijacked', diskHashOf('.env.local'))
  } catch (error) {
    managedEditRefused = error instanceof repo.RepositoryError ? error.code : String(error)
  }
  check(
    '🔴 归凭据管的变量不能在配置表里就地编辑（真源只有一个）',
    managedEditRefused === 'PATH_REJECTED',
    `code=${managedEditRefused}`
  )
  check(
    '被拒绝后文件没有被改动',
    readFileSync(localPath, 'utf8').includes('sk-ant-api03-fixture-0123456789abcdef'),
    '磁盘上还是原来的值'
  )

  // --- 一改多同步（阶段 3 验收句）-------------------------------------------
  const beforeSync = cred.previewCredentialSync(primary.id)
  check(
    '预览：绑定的那一处需要更新',
    beforeSync.writable === 1 && beforeSync.targets[0]?.state === 'outdated',
    `state=${beforeSync.targets[0]?.state} writable=${beforeSync.writable}`
  )
  check(
    '🔴 同步预览里不含 Key 明文（只说哪里要改，不说改成什么）',
    !NEEDLES.some((needle) => JSON.stringify(beforeSync).includes(needle)) &&
      !JSON.stringify(beforeSync).includes('sk-ant-api03-original'),
    '只有项目、环境、变量名与状态'
  )

  const localBeforeSync = readFileSync(localPath, 'utf8')
  const synced = cred.syncCredential(primary.id, [
    { bindingId: beforeSync.targets[0]!.bindingId, expectedHash: beforeSync.targets[0]!.expectedHash! }
  ])
  const localAfterSync = readFileSync(localPath, 'utf8')

  check('同步写入了 1 处', synced.written === 1 && synced.failed === 0, `written=${synced.written}`)
  check(
    '凭据的 Key 落到了磁盘文件里',
    localAfterSync.includes('sk-ant-api03-original-0123456789abcdef'),
    'ANTHROPIC_API_KEY 已更新'
  )
  check(
    '🔴 同步只改那一行，CRLF、注释与其余变量都保留',
    JSON.stringify(localAfterSync.split('\r\n').filter((l) => !l.startsWith('ANTHROPIC_API_KEY='))) ===
      JSON.stringify(localBeforeSync.split('\r\n').filter((l) => !l.startsWith('ANTHROPIC_API_KEY='))),
    '其余行逐行相同'
  )
  check(
    '中心记录跟着一起更新了',
    repo.revealEntry(entryOf('ANTHROPIC_API_KEY').id).value ===
      'sk-ant-api03-original-0123456789abcdef',
    '记录与磁盘一致'
  )
  check(
    '同步后该文件不再有差异',
    repo.listFiles(project.id).find((f) => f.fileName === '.env.local')?.drifted === false,
    '哈希已更新'
  )

  const afterSync = cred.previewCredentialSync(primary.id)
  check(
    '再预览一次变成「已一致」，不会重复写',
    afterSync.writable === 0 && afterSync.targets[0]?.state === 'in-sync',
    `state=${afterSync.targets[0]?.state}`
  )

  // --- 轮换：只改凭据，不碰文件 ---------------------------------------------
  const beforeRotate = readFileSync(localPath, 'utf8')
  const rotated = cred.updateCredential({ credentialId: primary.id, apiKey: ROTATED_KEY })
  check(
    '🔴 轮换只改凭据，文件一个字节都不动',
    readFileSync(localPath, 'utf8') === beforeRotate,
    '同步是独立的一步，不是保存的副作用'
  )
  check(
    '轮换后指纹和末四位都变了',
    rotated.fingerprint !== primary.fingerprint && rotated.lastFour === 'cdef',
    `${primary.fingerprint} → ${rotated.fingerprint}`
  )
  check(
    '轮换后预览显示需要更新',
    cred.previewCredentialSync(primary.id).writable === 1,
    '绑定处待同步'
  )

  // --- 🔴 并发守卫：预览之后文件又被改过 ------------------------------------
  const stalePreview = cred.previewCredentialSync(primary.id)
  writeFileSync(localPath, readFileSync(localPath, 'utf8') + 'OUTSIDER=1\r\n')

  const conflicted = cred.syncCredential(primary.id, [
    {
      bindingId: stalePreview.targets[0]!.bindingId,
      expectedHash: stalePreview.targets[0]!.expectedHash!
    }
  ])
  check(
    '🔴 预览之后文件被外部改过就跳过那个目标，不覆盖',
    conflicted.written === 0 && conflicted.failed === 1,
    conflicted.outcomes[0]?.reason ?? ''
  )
  check(
    '别人的修改原封不动，Key 也没被写进去',
    readFileSync(localPath, 'utf8').includes('OUTSIDER=1') &&
      !readFileSync(localPath, 'utf8').includes(ROTATED_KEY),
    '中止后未覆盖'
  )

  // 把外部改动收进来。这既是恢复现场，也让下一条断言能验到**另一道**守卫：
  // 现在 stored === current，「文件有外部改动」那一关必过，
  // 于是 stalePreview 里那个过期哈希只可能被并发校验拦下。
  repo.adoptDiskFile(repo.listFiles(project.id).find((f) => f.fileName === '.env.local')!.id)

  check(
    '🔴 绑定按 (项目, 环境, 变量名) 配对，重建条目后依然有效',
    cred.previewCredentialSync(primary.id).targets[0]?.state === 'outdated',
    'adoptDiskFile 重建了 config_entries.id，绑定没跟着失效'
  )

  const staleHashSync = cred.syncCredential(primary.id, [
    {
      bindingId: stalePreview.targets[0]!.bindingId,
      expectedHash: stalePreview.targets[0]!.expectedHash!
    }
  ])
  check(
    '🔴 调用方基于旧预览做的决定被跳过（expectedHash 过期，与上一条是两道不同的守卫）',
    staleHashSync.written === 0 &&
      staleHashSync.outcomes[0]?.reason?.includes('预览之后') === true,
    staleHashSync.outcomes[0]?.reason ?? ''
  )

  // 收尾：把刚才制造并发场景用的 OUTSIDER 清掉。
  // 界面验收拿的是这份沙箱，留着测试残留会让那边的「变量集合」断言多出一条 ——
  // 而那条断言的价值正在于它精确。
  repo.deleteEntry(entryOf('OUTSIDER').id, diskHashOf('.env.local'))

  // --- 🔴 逐个目标报告，不是全有或全无 -------------------------------------
  // 造一条指向不存在变量的绑定，和一条正常的一起同步：
  // 正常的必须成功，坏的必须失败，而不是一起回滚。
  db.prepare(
    `INSERT INTO credential_bindings
       (credential_id, project_id, environment, endpoint_variable, key_variable,
        last_synced_hash, sync_mode, created_at)
     VALUES (?, ?, 'production', NULL, 'NO_SUCH_VARIABLE', NULL, 'manual', ?)`
  ).run(primary.id, project.id, Date.now())

  const mixedPreview = cred.previewCredentialSync(primary.id)
  const badTarget = mixedPreview.targets.find((t) => t.keyVariable === 'NO_SUCH_VARIABLE')
  const goodTarget = mixedPreview.targets.find((t) => t.keyVariable === 'ANTHROPIC_API_KEY')
  check(
    '预览如实标出「这个环境里没有这个变量」',
    badTarget?.state === 'missing-variable' && badTarget.expectedHash === null,
    `state=${badTarget?.state}`
  )

  const mixed = cred.syncCredential(primary.id, [
    { bindingId: goodTarget!.bindingId, expectedHash: goodTarget!.expectedHash! },
    // 坏目标没有 expectedHash，用一个合法但对不上的串占位 —— 它会先被
    // 「变量不存在」拦下，正好验证坏目标不会连累好目标。
    { bindingId: badTarget!.bindingId, expectedHash: '0'.repeat(64) }
  ])
  check(
    '🔴 一好一坏：好的写进去了，坏的单独报错，不是一起回滚',
    mixed.written === 1 &&
      mixed.failed === 1 &&
      mixed.outcomes.some((o) => o.ok) &&
      mixed.outcomes.some((o) => !o.ok),
    mixed.outcomes.map((o) => `${o.environment}:${o.ok ? 'ok' : o.reason}`).join(' / ')
  )
  check(
    '轮换后的新 Key 确实写到了文件里',
    readFileSync(localPath, 'utf8').includes(ROTATED_KEY),
    '好目标写入成功'
  )
  check(
    '磁盘上不存在的变量不会被追加',
    !readFileSync(join(fixtureRoot, 'apps', 'web', '.env.production'), 'utf8').includes(
      'NO_SUCH_VARIABLE'
    ),
    '未静默追加'
  )

  // --- 厂商验证请求（阶段 3 最后一项，计划 §7 与 §8）------------------------
  //
  // 🔴 全程注入假传输，一个字节都不出网。本节末尾有一条断言直接调真传输，
  // 确认 ENVVAULT_BLOCK_NETWORK 那道硬拦真的能触发 —— 否则「没出网」
  // 这件事就只是一个假设，而假设和断言在测试报告上长得一模一样。

  interface SeenRequest {
    url: string
    method: string
    headers: Record<string, string>
  }
  const seenRequests: SeenRequest[] = []

  /** 记下收到的请求，然后回一个指定的状态码。 */
  function fakeTransport(status: number): ValidationTransport {
    return async (request) => {
      seenRequests.push({
        url: request.url,
        method: request.method,
        headers: { ...request.headers }
      })
      return { status }
    }
  }

  const statusOf = (id: number): { status: string; last_validated_at: number | null } =>
    db
      .prepare('SELECT status, last_validated_at FROM model_credentials WHERE id = ?')
      .get<{ status: string; last_validated_at: number | null }>(id)!

  check(
    '发起验证之前，状态如实是「未验证」，验证时间为空',
    statusOf(primary.id).status === 'unverified' && statusOf(primary.id).last_validated_at === null,
    `status=${statusOf(primary.id).status} last_validated_at=${statusOf(primary.id).last_validated_at}`
  )

  // --- 通过：200 → active ---------------------------------------------------
  seenRequests.length = 0
  const passed = await cred.validateCredential(primary.id, fakeTransport(200))
  check(
    '验证通过后状态变为「可用」并记下验证时间',
    passed.outcome === 'valid' &&
      passed.conclusive &&
      statusOf(primary.id).status === 'active' &&
      statusOf(primary.id).last_validated_at !== null,
    `outcome=${passed.outcome} status=${statusOf(primary.id).status}`
  )
  check(
    '🔴 打的是元数据接口，不是推理接口（§7：避免无意产生推理费用）',
    seenRequests.length === 1 &&
      seenRequests[0]!.url.endsWith('/models') &&
      seenRequests[0]!.method === 'GET',
    `${seenRequests[0]?.method} ${seenRequests[0]?.url}`
  )
  check(
    '🔴 Key 走请求头，不在 URL 里（URL 会被代理和服务端日志原样记下来）',
    !seenRequests[0]!.url.includes('sk-ant-') &&
      JSON.stringify(seenRequests[0]!.headers).includes(ROTATED_KEY),
    `url=${seenRequests[0]?.url}`
  )
  check(
    '🔴 验证的返回值里没有 Key —— 明文只进了请求头',
    !JSON.stringify(passed).includes(ROTATED_KEY) && !JSON.stringify(passed).includes('sk-ant-'),
    '返回值只有摘要、结论与一句话'
  )

  // --- 🔴 轮换之后，上一次验证的结论必须作废 --------------------------------
  // 「可用」说的是某一把具体的 Key。换了一把之后还挂着它，
  // 等于拿旧 Key 的体检报告给新 Key 背书。
  const REVALIDATE_KEY = 'sk-ant-api03-revalidate-0123456789abcdef'
  cred.updateCredential({ credentialId: primary.id, apiKey: REVALIDATE_KEY })
  check(
    '🔴 轮换 Key 之后状态退回「未验证」，验证时间一并清空',
    statusOf(primary.id).status === 'unverified' && statusOf(primary.id).last_validated_at === null,
    `status=${statusOf(primary.id).status} last_validated_at=${statusOf(primary.id).last_validated_at}`
  )

  // --- 拒绝：401 → invalid，且不是 revoked ----------------------------------
  const rejected = await cred.validateCredential(primary.id, fakeTransport(401))
  check(
    '🔴 厂商拒绝记为「已失效」，不是用户按的「已停用」',
    rejected.outcome === 'invalid' &&
      rejected.conclusive &&
      statusOf(primary.id).status === 'invalid',
    `outcome=${rejected.outcome} status=${statusOf(primary.id).status}`
  )
  check(
    '被拒绝时说清楚了是厂商拒的，并带上状态码',
    rejected.message.includes('拒绝') && rejected.httpStatus === 401,
    rejected.message
  )

  // --- 🔴 没结论的一律不许动状态 --------------------------------------------
  //
  // 这是这一层最容易写错的地方：把网络超时记成「Key 失效」，用户离线点一次
  // 验证就会看到所有凭据被标成失效 —— 而那正是他最需要这些 Key 的时候。
  //
  // ⚠️ 先把状态验回 `active` 再跑这一组，不是多此一举：
  // 如果从 `invalid` 起步，一次错误的写入正好也写 `invalid`，而
  // last_validated_at 又可能落在同一毫秒里 —— 于是「改了」和「没改」
  // 长得一模一样，断言够不着它要守的分支。（这是把 bug 放回去跑一遍时
  // 发现的：四个用例里「连不上」那条当时没红。）
  // 从 `active` 起步，任何错误写入都会翻成 `invalid`，一眼可见。
  // 顺带这也是更真实的场景：昨天验过是可用的，今天离线点一次。
  await cred.validateCredential(primary.id, fakeTransport(200))
  const beforeInconclusive = statusOf(primary.id)
  check(
    '（前置）已经是「可用」，下面任何一次错误写入都会翻成「已失效」',
    beforeInconclusive.status === 'active',
    `status=${beforeInconclusive.status}`
  )
  const inconclusiveCases: [string, ValidationTransport][] = [
    [
      '连不上',
      async () => {
        throw new Error('getaddrinfo ENOTFOUND api.anthropic.com')
      }
    ],
    ['厂商 500', fakeTransport(500)],
    ['限流 429', fakeTransport(429)],
    ['地址错 404', fakeTransport(404)]
  ]
  const mutatedBy: string[] = []
  const outcomes: string[] = []
  for (const [label, transport] of inconclusiveCases) {
    const report = await cred.validateCredential(primary.id, transport)
    outcomes.push(`${label}→${report.outcome}`)
    const after = statusOf(primary.id)
    if (
      report.conclusive ||
      after.status !== beforeInconclusive.status ||
      after.last_validated_at !== beforeInconclusive.last_validated_at
    ) {
      mutatedBy.push(label)
    }
  }
  check(
    '🔴 没验出结论时，状态和验证时间一个都不动',
    mutatedBy.length === 0,
    mutatedBy.length === 0 ? outcomes.join(' / ') : `被改动了: ${mutatedBy.join('、')}`
  )
  check(
    '没结论的提示语说的是「这次没问出来」，不是「你的 Key 坏了」',
    (await cred.validateCredential(primary.id, fakeTransport(500))).message.includes('没验出结论'),
    '措辞不会误导用户去换 Key'
  )

  // --- Gemini：Key 必须走请求头而不是 ?key= ---------------------------------
  // 单独验一条是因为 Gemini 是唯一一家官方示例用查询串传 Key 的，
  // 而查询串会被代理、CDN 和服务端访问日志原样记下来。
  const geminiKey = 'AIzaSyA01234567890123456789012345678901'
  const gemini = cred.createCredential({
    providerId: 'gemini',
    credentialName: 'verify-gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: geminiKey
  })
  seenRequests.length = 0
  await cred.validateCredential(gemini.id, fakeTransport(200))
  check(
    '🔴 Gemini 的 Key 也走请求头，没有拼进查询串',
    seenRequests.length === 1 &&
      !seenRequests[0]!.url.includes(geminiKey) &&
      !seenRequests[0]!.url.includes('key=') &&
      seenRequests[0]!.headers['x-goog-api-key'] === geminiKey,
    seenRequests[0]?.url ?? '（没发出请求）'
  )
  // 用完就删：留着会让后面「凭据都删干净了」和界面那条「列表 1 条」都变红。
  cred.deleteCredential(gemini.id)

  // --- 🔴 那道「禁止出网」的拦是真的能触发的 --------------------------------
  // 上面所有验证都靠注入假传输才没出网。这条断言直接调真传输，
  // 确认忘了注入时会失败而不是静默发包。没有这条，「没出网」只是一个假设。
  let blocked = ''
  try {
    await electronTransport(
      { url: 'https://api.anthropic.com/v1/models', method: 'GET', headers: {} },
      new AbortController().signal
    )
  } catch (error) {
    blocked = error instanceof Error ? error.message : String(error)
  }
  check(
    '🔴 ENVVAULT_BLOCK_NETWORK 下真传输直接拒发（忘了注入假传输会响亮地失败）',
    blocked.includes('ENVVAULT_BLOCK_NETWORK'),
    blocked || '（真传输没有拒绝，这个进程可能真的发过包）'
  )

  // --- 删除变量时绑定要跟着走 -----------------------------------------------
  const bindingsBeforeDelete = cred.previewCredentialSync(primary.id).targets.length
  repo.deleteEntry(entryOf('ANTHROPIC_API_KEY').id, diskHashOf('.env.local'))
  check(
    '🔴 删掉被绑定的变量会连带解绑（否则下次同步会静默少写一处）',
    cred.previewCredentialSync(primary.id).targets.length === bindingsBeforeDelete - 1,
    `绑定 ${bindingsBeforeDelete} → ${cred.previewCredentialSync(primary.id).targets.length}`
  )

  // --- 删除凭据不动磁盘 -----------------------------------------------------
  const localBeforeCredentialDelete = readFileSync(localPath, 'utf8')
  cred.deleteCredential(primary.id)
  check(
    '删除凭据只清记录与绑定，磁盘文件不动',
    cred.listCredentials().length === 0 &&
      readFileSync(localPath, 'utf8') === localBeforeCredentialDelete,
    '文件未改动'
  )
  check(
    '凭据删掉后，绑定也随外键级联消失',
    db.prepare('SELECT COUNT(*) AS n FROM credential_bindings').get<{ n: number }>()?.n === 0,
    '级联删除生效'
  )

  // --- 🔴 凭据相关的记录里同样没有明文 --------------------------------------
  const credentialLog = repo
    .listActivity(300)
    .filter((r) => r.action.startsWith('credential.'))
  check(
    '凭据的增删改绑同步与验证都留了记录',
    ['credential.create', 'credential.bind', 'credential.sync', 'credential.rotate',
     'credential.validate', 'credential.delete'].every((action) =>
      credentialLog.some((r) => r.action === action)
    ),
    [...new Set(credentialLog.map((r) => r.action))].join('、')
  )
  check(
    '验证的记录如实区分「有结论」和「没结论」',
    credentialLog.some((r) => r.action === 'credential.validate' && r.detail?.includes('HTTP 401')) &&
      credentialLog.some(
        (r) => r.action === 'credential.validate' && r.detail?.includes('没有结论')
      ),
    '两类结果在审计记录里分得开'
  )
  check(
    '🔴 凭据操作记录里没有 Key 明文，也没有调用地址',
    !JSON.stringify(credentialLog).includes('sk-ant-api03') &&
      !JSON.stringify(credentialLog).includes('AIza') &&
      !JSON.stringify(credentialLog).includes('anthropic.com') &&
      !NEEDLES.some((needle) => JSON.stringify(credentialLog).includes(needle)),
    '只记厂商、凭据名、结论与状态码'
  )

  // 整库再扫一遍：阶段 3 新增了两张表，明文断言必须覆盖到它们。
  const dbBytesAfterCredentials = [info.filePath, `${info.filePath}-wal`]
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path).toString('latin1'))
    .join('')
  const credentialNeedles = ['sk-ant-api03-original', ROTATED_KEY, REVALIDATE_KEY, ...NEEDLES]
  const leakedAfter = credentialNeedles.filter((needle) => dbBytesAfterCredentials.includes(needle))
  check(
    '🔴 加上凭据两张表之后，数据库文件里仍然搜不到任何明文',
    leakedAfter.length === 0,
    leakedAfter.length === 0 ? `扫了 ${Math.round(dbBytesAfterCredentials.length / 1024)} KiB` : `命中: ${leakedAfter.join(', ')}`
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
