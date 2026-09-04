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
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDatabase, getDatabaseInfo, initializeDatabase } from '../src/main/db'
import { getSchemaVersion, migrate } from '../src/main/db/migrator'
import * as repo from '../src/main/db/repositories'
import * as cred from '../src/main/db/credentials'
import * as security from '../src/main/db/security'
import * as inject from '../src/main/db/inject'
import * as template from '../src/main/db/template'
import * as transfer from '../src/main/db/transfer'
import { openPackage, sealPackage } from '../src/main/transfer/package.ts'
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

/** 阶段 6：一个装着多个仓库的目录，自己也是仓库。 */
const workspaceRoot = join(sandbox, 'workspace')

/** 换行符。写成常量而不是字面量，免得被某一层转义处理搅乱。 */
const NEWLINE = String.fromCharCode(10)

/** repo-a 里那把「已提交又补进 .gitignore」的假 Key。 */
const WORKSPACE_KEY = 'sk-proj-workspaceaaaaaaaaaaaaaaaaaa'

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

  buildGitFixture()
  buildWorkspaceFixture()
}

/**
 * 阶段 6 专用：一个**装着多个仓库**的目录，而且它自己也是个仓库。
 *
 * 这是「问错仓库」缺陷最容易发生的布局：`~/code` 自己 git init 过，
 * 底下放着一堆 clone。把它整个当成一个项目纳管，repo-a 里那个
 * 「已提交又补进 .gitignore」的文件在**外层**仓库看来永远是「未跟踪」，
 * 于是那条 critical 静默消失。
 *
 * 🔴 单独造一份，不动 fixtureRoot —— 样例数据是共享的，
 * 往现有 fixture 里加仓库会弄红一堆按数量写死的断言（§8）。
 */
function buildWorkspaceFixture(): void {
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=verify', '-c', 'user.email=verify@example.com', ...args], {
      cwd,
      stdio: 'ignore'
    })
  }

  mkdirSync(workspaceRoot, { recursive: true })
  writeFileSync(join(workspaceRoot, '.env'), `WORKSPACE_LEVEL=1${NEWLINE}`)
  git(workspaceRoot, 'init', '-b', 'main')
  git(workspaceRoot, 'add', '.env')
  git(workspaceRoot, 'commit', '-m', 'workspace')

  // repo-a：复刻那个「假安心」——先提交，后补 .gitignore。
  const repoA = join(workspaceRoot, 'repo-a')
  mkdirSync(repoA, { recursive: true })
  writeFileSync(join(repoA, '.env.local'), `OPENAI_API_KEY=${WORKSPACE_KEY}${NEWLINE}`)
  writeFileSync(join(repoA, '.gitignore'), `.env.local${NEWLINE}`)
  git(repoA, 'init', '-b', 'main')
  git(repoA, 'add', '.gitignore')
  git(repoA, 'add', '-f', '.env.local')
  git(repoA, 'commit', '-m', 'repo-a')

  const repoB = join(workspaceRoot, 'repo-b')
  mkdirSync(repoB, { recursive: true })
  writeFileSync(join(repoB, '.env'), `PORT=4000${NEWLINE}`)
  git(repoB, 'init', '-b', 'main')
  git(repoB, 'add', '.env')
  git(repoB, 'commit', '-m', 'repo-b')
}

/**
 * 把样例项目做成一个**真的** Git 仓库（阶段 4a）。
 *
 * 安全检查这一层的价值全在真实 git 的行为上（`check-ignore --no-index` 到底
 * 报不报已跟踪的文件、退出码 1 是什么意思）—— 拿假数据验等于验了个寂寞。
 * 所以这里起真的 git，`inspectPaths` 也走真 runner。
 *
 * 布置出来的四种状态，覆盖判定表里最要紧的几条：
 *
 * ```
 * .env.local                  已跟踪 + 已忽略 + 有 Key  → critical（最该报的那条）
 * apps/web/.env.production    未跟踪 + 未忽略 + 有凭据串 → critical
 * .env                        已跟踪 + 干净             → ok（不喊狼来了）
 * .env.example                已跟踪 + 模板 + 干净       → ok，且它是未纳管文件
 * ```
 *
 * `.env.local` 用 `git add -f` 强行入库，模拟真实世界里最常见的顺序：
 * **先提交了，后来才想起来加进 .gitignore** —— 加完之后 git status 变干净，
 * 于是所有人都以为堵上了，而那把 Key 还在仓库里。
 */
function buildGitFixture(): void {
  writeFileSync(
    join(fixtureRoot, '.gitignore'),
    ['# 本机覆盖不进仓库', '.env.local', ''].join('\n')
  )

  // -c 传身份而不是依赖机器上的全局配置：验收要在任何机器上结果一致。
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=verify', '-c', 'user.email=verify@example.com', ...args], {
      cwd: fixtureRoot,
      stdio: 'ignore'
    })
  }

  git('init', '-b', 'main')
  git('add', '.env', '.env.example', '.gitignore')
  // -f 才加得进去：它已经被 .gitignore 挡着了。这一步就是在造那个「假安心」。
  git('add', '-f', '.env.local')
  git('commit', '-m', 'fixture')
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
    info.schemaVersion === info.latestVersion && info.latestVersion >= 5,
    `user_version=${info.schemaVersion} / latest=${info.latestVersion}`
  )
  check(
    '五条迁移都已执行，且版本号连续无缺口',
    // 不写死条数：迁移是 append-only 的，每加一条就要来改一次数字，
    // 而那种"顺手 +1"的改动本身就是在把这条断言变成橡皮图章。
    // 连续性才是真正要守的不变量 —— 缺号意味着有人删了或重排了已发布的迁移。
    info.appliedMigrations.length === info.latestVersion &&
      info.appliedMigrations.every((m, i) => m.version === i + 1),
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

  const revealLog = repo.listActivity(100).records.filter((r) => r.action === 'entry.reveal')
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

  // 阶段 4a：Git 风险检查
  // -------------------------------------------------------------------------
  //
  // 这一段跑的是**真的 git**（`buildGitFixture` 起了一个真仓库）。假 runner
  // 只能验解析，验不了 `check-ignore --no-index` 到底报不报已跟踪的文件 ——
  // 而整个功能最有价值的那条结论正好压在这个行为上。
  //
  // ⚠️ 位置很讲究：必须在**任何东西改动样例文件之前**跑。
  // 放到脚本末尾的话，.env 已经被「以磁盘为准」那一步写进了一把 Key、
  // .env.staging 也还留着给界面验收用 —— 断言测的就成了一堆残留状态，
  // 而不是这里刻意布置的那四种。（第一版就是这么写的，三条断言当场变红。）

  const report = await security.scanSecurity(project.id)
  const riskOf = (path: string) => report.files.find((file) => file.relativePath === path)

  // 🔴 git 不可用时要**响亮地失败**，不能静默跳过下面这一组。
  // 跳过的断言和通过的断言在报告上长得一模一样（HANDOFF §8）。
  check(
    'git 可用，下面这一组才有意义',
    report.gitUnavailable === null && report.gitRoot !== null,
    report.gitUnavailable ?? `gitRoot=${report.gitRoot}`
  )

  check(
    '报告覆盖磁盘上全部 .env*，含未纳管的那个',
    report.files.length === 4 &&
      riskOf('.env.example')?.managed === false &&
      riskOf('.env.local')?.managed === true,
    report.files.map((f) => `${f.relativePath}(${f.level})`).join(' / ')
  )

  // --- 🔴 最该报出来的那条：已经在 .gitignore 里，但仍然被跟踪着 -------------
  const leaked = riskOf('.env.local')
  check(
    '🔴 已提交又补进 .gitignore 的文件被判为 critical',
    leaked?.level === 'critical' && leaked.tracked === true && leaked.ignored === true,
    `level=${leaked?.level} tracked=${leaked?.tracked} ignored=${leaked?.ignored}`
  )
  check(
    '🔴 并且说清楚了忽略规则对已跟踪的文件无效',
    leaked?.reason.includes('忽略规则对已跟踪的文件无效') === true,
    leaked?.reason ?? '（没有理由）'
  )
  check(
    '🔴 处置办法给的是 git rm --cached，不是「加进 .gitignore」',
    // 后者正是用户已经做过、并且以为已经解决了的事。
    leaked?.remedy?.includes('git rm --cached') === true &&
      leaked.remedy.includes('历史') &&
      !leaked.remedy.startsWith('把'),
    leaked?.remedy ?? '（没有处置办法）'
  )
  check(
    '命中的忽略规则被指了出来',
    leaked?.ignoreRule?.startsWith('.gitignore:') === true,
    leaked?.ignoreRule ?? '（没有规则）'
  )

  // --- 还没进仓库，但也没人拦着 ---------------------------------------------
  const exposed = riskOf('apps/web/.env.production')
  check(
    '🔴 未被忽略且含凭据串的文件被判为 critical',
    exposed?.level === 'critical' && exposed.tracked === false && exposed.ignored === false,
    `level=${exposed?.level} tracked=${exposed?.tracked} ignored=${exposed?.ignored}`
  )
  check(
    '它的处置办法是加进 .gitignore（这个文件还没进仓库，不用 rm --cached）',
    exposed?.remedy?.includes('.gitignore') === true &&
      exposed.remedy.includes('git rm') === false,
    exposed?.remedy ?? '（没有处置办法）'
  )

  // --- 🔴 不喊狼来了 --------------------------------------------------------
  // 每个项目都把干净文件标红的安全页，用户看两次就再也不看了 ——
  // 之后真出事那次他也不会看。
  check(
    '🔴 被跟踪但不含敏感值的文件是 ok，不报警',
    riskOf('.env')?.level === 'ok' && riskOf('.env')?.tracked === true,
    `.env level=${riskOf('.env')?.level} tracked=${riskOf('.env')?.tracked}`
  )
  check(
    '🔴 被跟踪的干净模板同样是 ok',
    riskOf('.env.example')?.level === 'ok' && riskOf('.env.example')?.tracked === true,
    `.env.example level=${riskOf('.env.example')?.level}`
  )

  check(
    '摘要计数和逐条结论对得上',
    report.summary.critical === report.files.filter((f) => f.level === 'critical').length &&
      report.summary.critical === 2 &&
      report.summary.ok === 2,
    `critical=${report.summary.critical} warning=${report.summary.warning} unknown=${report.summary.unknown} ok=${report.summary.ok}`
  )

  // --- 🔴 报告里只有计数，没有值 --------------------------------------------
  // 针串在这里自带一份，不复用后面凭据段落的 NEEDLES ——
  // 那些常量定义在这一段**之后**，引用过来会直接 TDZ 报错。
  // 一个只在段落内有效的列表也更好读：它列的正好是此刻磁盘上的那几把假 Key。
  const reportJson = JSON.stringify(report)
  const leakedInReport = [
    'sk-proj-abcdefghijklmnopqrstuvwxyz012345',
    'sk-ant-api03-fixture-0123456789abcdef',
    'pa#ss word',
    'user:secret',
    'line1'
  ].filter((needle) => reportJson.includes(needle))
  check(
    '🔴 安全报告里搜不到任何配置值，只有计数',
    leakedInReport.length === 0,
    leakedInReport.length === 0
      ? `high=${leaked?.highCount} sensitive=${leaked?.sensitiveCount}`
      : `命中: ${leakedInReport.join(', ')}`
  )
  check(
    '🔴 但它确实数到了那些敏感值 —— 上一条才有意义',
    (leaked?.highCount ?? 0) > 0,
    `.env.local 高危 ${leaked?.highCount} 个、疑似敏感 ${leaked?.sensitiveCount} 个`
  )

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
    .records
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
  /*
    ⚠️ 这条原来写的是 `!fingerprint.includes('cdef')`（Key 的末四位），
    结果它是一条会随机变红的断言：指纹本身就是 16 位十六进制，而 `cdef`
    也是合法的十六进制串 —— 它偶然出现的概率大约 1/5000，而每次跑
    沙箱的主密钥都不一样，指纹跟着变。实测撞上过一次（790e48a7cdef059c）。

    更要紧的是**那样测没有意义**：十六进制串里出现四个十六进制字符，
    说明不了任何事情。真正该守的性质有两条，都是确定性的：
      1. Key 里那些**不是十六进制**的片段绝不该出现（真出现就是拼接了原值）；
      2. 🔴 指纹不等于裸 SHA-256 —— 也就是派生子密钥确实参与了计算。
         这才是 PHASE-3 §4 的全部理由所在：裸哈希会让拿到库文件的人
         能拿候选 Key 字典逐个比对，而派生之后没有系统密钥库就什么都验证不了。
  */
  check(
    '🔴 指纹里没有 Key 的可辨认片段',
    !primary.fingerprint.includes('original') && !primary.fingerprint.includes('sk-ant'),
    primary.fingerprint
  )
  check(
    '🔴 指纹不是裸哈希 —— 派生子密钥确实参与了计算',
    /^[0-9a-f]{16}$/.test(primary.fingerprint) &&
      primary.fingerprint !==
        createHash('sha256')
          .update('sk-ant-api03-original-0123456789abcdef', 'utf8')
          .digest('hex')
          .slice(0, 16),
    `指纹=${primary.fingerprint} 裸哈希前 16 位=${createHash('sha256').update('sk-ant-api03-original-0123456789abcdef', 'utf8').digest('hex').slice(0, 16)}`
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

  // 阶段 4b：版本历史、停用、剪贴板
  // ---------------------------------------------------------------------------

  // --- 版本历史：每换一次 Key 就是新的一代 ----------------------------------
  const versions = cred.listCredentialVersions(primary.id)
  check(
    '每换一次 Key 就记一代，当前那代没有作废时间',
    versions.length === 3 &&
      versions[0]!.version === 3 &&
      versions[0]!.revokedAt === null &&
      versions.slice(1).every((v) => v.revokedAt !== null),
    versions.map((v) => `v${v.version}${v.revokedAt ? '(已作废)' : '(当前)'}`).join(' ')
  )
  check(
    '当前这一代的指纹和凭据本身对得上',
    versions[0]!.fingerprint === cred.listCredentials().find((c) => c.id === primary.id)?.fingerprint,
    `v${versions[0]!.version} 指纹=${versions[0]!.fingerprint.slice(0, 8)}`
  )
  check(
    '历代指纹互不相同（换的确实是不同的 Key）',
    new Set(versions.map((v) => v.fingerprint)).size === versions.length,
    versions.map((v) => v.fingerprint.slice(0, 8)).join(' / ')
  )
  check(
    '每条凭据都至少有一代记录（迁移 005 的存量补齐要维持这个不变量）',
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM model_credentials c
         WHERE NOT EXISTS (SELECT 1 FROM credential_versions v WHERE v.credential_id = c.id)`
      )
      .get<{ n: number }>()?.n === 0,
    '没有孤立的凭据'
  )

  // --- 🔴 版本表里没有任何一代的 Key ----------------------------------------
  // 留着旧密钥是纯粹的负债：轮换的全部意义就是让旧的那把作废，
  // 而一个能翻出所有历史 Key 的库，会让「越勤于轮换、泄漏后果越严重」。
  const versionRows = db
    .prepare('SELECT * FROM credential_versions')
    .all<Record<string, unknown>>()
  const versionNeedles = ['sk-ant-api03-original', ROTATED_KEY, REVALIDATE_KEY, ...NEEDLES]
  const leakedInVersions = versionRows.flatMap((row) =>
    Object.entries(row)
      .filter(
        ([, value]) => typeof value === 'string' && versionNeedles.some((n) => value.includes(n))
      )
      .map(([column]) => column)
  )
  check(
    '🔴 版本表逐列扫描，没有任何一代的 Key 明文',
    leakedInVersions.length === 0,
    leakedInVersions.length === 0
      ? `${versionRows.length} 行 × ${Object.keys(versionRows[0] ?? {}).length} 列`
      : `泄漏的列: ${[...new Set(leakedInVersions)].join(', ')}`
  )
  check(
    '🔴 版本表里压根没有存密文的列',
    !Object.keys(versionRows[0] ?? {}).some((column) => column.includes('encrypted')),
    Object.keys(versionRows[0] ?? {}).join(', ')
  )

  // --- 轮换前的影响范围就是同步预览那一份 -----------------------------------
  // 🔴 界面上「轮换会波及哪儿」直接调 previewCredentialSync。
  // 另写一份计算必然分叉，而分叉之后「到底会改哪几个文件」没有办法回答。
  const impact = cred.previewCredentialSync(primary.id)
  check(
    '轮换前能列出受影响的项目和环境（阶段 4 验收句的后半段）',
    impact.targets.length > 0 &&
      impact.targets.every((t) => t.projectName !== '' && t.environment !== ''),
    impact.targets.map((t) => `${t.projectName}/${t.environment}:${t.keyVariable}`).join(' / ')
  )
  check(
    '🔴 影响范围里不含 Key（和同步预览同一条规矩）',
    !JSON.stringify(impact).includes('sk-ant-') && !JSON.stringify(impact).includes(REVALIDATE_KEY),
    '只说改哪儿，不说改成什么'
  )

  // --- 停用：主进程独立拦一道 -----------------------------------------------
  cred.updateCredential({ credentialId: primary.id, status: 'revoked' })

  let syncBlocked = ''
  try {
    cred.syncCredential(primary.id, [
      { bindingId: impact.targets[0]!.bindingId, expectedHash: impact.targets[0]!.expectedHash! }
    ])
  } catch (error) {
    syncBlocked = error instanceof repo.RepositoryError ? error.code : String(error)
  }
  check(
    '🔴 停用之后拒绝把这把 Key 写进项目文件',
    syncBlocked === 'PATH_REJECTED',
    `code=${syncBlocked}`
  )

  let validateBlocked = ''
  try {
    await cred.validateCredential(primary.id, fakeTransport(200))
  } catch (error) {
    validateBlocked = error instanceof repo.RepositoryError ? error.code : String(error)
  }
  check(
    '🔴 停用之后也不再向厂商发验证请求',
    validateBlocked === 'PATH_REJECTED',
    `code=${validateBlocked}`
  )
  check(
    '停用不动版本行 —— 那把 Key 还是那把，只是这条凭据被搁置了',
    cred.listCredentialVersions(primary.id)[0]!.revokedAt === null,
    '当前代仍然是当前代'
  )

  // 启用回来，后面的段落还要用它。
  cred.updateCredential({ credentialId: primary.id, status: 'unverified' })
  check(
    '启用之后同步预览又能算出来了',
    cred.previewCredentialSync(primary.id).targets.length === impact.targets.length,
    '恢复正常'
  )

  // --- 剪贴板：复制不经过返回值 ---------------------------------------------
  const clipboardLog: string[] = []
  const fakeClipboard = {
    content: '',
    async writeText(text: string) {
      this.content = text
      clipboardLog.push('write')
    },
    async readText() {
      return this.content
    },
    async clear() {
      this.content = ''
      clipboardLog.push('clear')
    }
  }

  const copyDelay = await cred.copyCredentialKey(primary.id, fakeClipboard)
  check(
    '复制把 Key 写进了剪贴板，并给出清理倒计时',
    fakeClipboard.content === REVALIDATE_KEY && copyDelay === 30_000,
    `${copyDelay / 1000} 秒后清理`
  )
  check(
    '🔴 复制的返回值只有倒计时，没有值',
    typeof copyDelay === 'number',
    '主进程直接写剪贴板，明文不为了复制而过桥'
  )

  const copyLog = repo.listActivity(300).records.filter((r) => r.action === 'credential.copy')
  check(
    '🔴 复制留了独立的记录（和「显示」分开），且不含 Key',
    copyLog.length === 1 && !JSON.stringify(copyLog).includes('sk-ant-'),
    copyLog[0]?.detail ?? '（没有记录）'
  )

  // 配置项那一侧同一条路
  await repo.copyEntryValue(entryOf('DB_PASSWORD').id, fakeClipboard)
  check(
    '配置项的复制走同一条路，记 entry.copy',
    fakeClipboard.content === 'pa#ss word' &&
      repo.listActivity(300).records.some((r) => r.action === 'entry.copy'),
    '两侧同一个模块'
  )
  check(
    '🔴 复制的操作记录里没有值',
    !JSON.stringify(repo.listActivity(300).records.filter((r) => r.action.endsWith('.copy'))).includes(
      'pa#ss'
    ),
    '只记 key 名与倒计时'
  )

  // 阶段 5a：CLI 注入
  // ---------------------------------------------------------------------------
  //
  // 验收句：「CLI 注入模式可以在不落盘明文 Key 的情况下启动本地开发命令」。

  // --- 🔴 绑定变量注入的是凭据的当前值，不是文件里的旧值 --------------------
  //
  // 此刻 primary 的 Key 是 REVALIDATE_KEY（上一段轮换过），
  // 而磁盘文件和 config_entries 里还停在 ROTATED_KEY —— 没同步过。
  // 这正是要守的场景：界面上明明换过了，用命令跑起来却还在用旧的。
  const fileValue = repo.revealEntry(entryOf('ANTHROPIC_API_KEY').id).value
  const resolved = inject.resolveEnvironment(project.id, 'local')

  check(
    '（前置）文件里的值和凭据当前值确实不同，下面那条才有意义',
    fileValue === ROTATED_KEY && fileValue !== REVALIDATE_KEY,
    `文件=${fileValue.slice(0, 24)}… 凭据=${REVALIDATE_KEY.slice(0, 24)}…`
  )
  check(
    '🔴 绑定到凭据的变量注入凭据的当前值（真源只有一个）',
    resolved.values.get('ANTHROPIC_API_KEY') === REVALIDATE_KEY,
    resolved.values.get('ANTHROPIC_API_KEY') === REVALIDATE_KEY
      ? '注入的是凭据的新 Key'
      : '注入的是文件里的旧值'
  )
  check(
    '并如实标出「这个变量来自凭据，且和文件不一致」',
    resolved.variables.find((v) => v.key === 'ANTHROPIC_API_KEY')?.fromCredential === true &&
      resolved.variables.find((v) => v.key === 'ANTHROPIC_API_KEY')?.differsFromFile === true,
    '用户不会对"注入值和文件不一样"感到意外'
  )
  check(
    '没绑定的普通变量照旧取文件里的值',
    resolved.values.get('DB_PASSWORD') === 'pa#ss word' &&
      resolved.variables.find((v) => v.key === 'DB_PASSWORD')?.fromCredential === false,
    `DB_PASSWORD 来自文件`
  )

  // --- 🔴 一次注入只记一条，且只有变量名 ------------------------------------
  const injectLog = repo.listActivity(300).records.filter((r) => r.action === 'cli.inject')
  check(
    '🔴 一次注入记一条操作记录，detail 里只有变量名',
    injectLog.length === 1 &&
      injectLog[0]!.detail?.includes('ANTHROPIC_API_KEY') === true &&
      !JSON.stringify(injectLog).includes('sk-ant-') &&
      !NEEDLES.some((needle) => JSON.stringify(injectLog).includes(needle)),
    injectLog[0]?.detail?.slice(0, 60) ?? '（没有记录）'
  )

  // --- 停用的凭据不注入 -----------------------------------------------------
  cred.updateCredential({ credentialId: primary.id, status: 'revoked' })
  const whileRevoked = inject.resolveEnvironment(project.id, 'local')
  check(
    '🔴 已停用的凭据不会被塞进正在跑的进程',
    !whileRevoked.values.has('ANTHROPIC_API_KEY') &&
      whileRevoked.variables
        .find((v) => v.key === 'ANTHROPIC_API_KEY')
        ?.credentialName?.includes('已停用') === true,
    '和「停用后拒绝同步」同一条规矩'
  )
  cred.updateCredential({ credentialId: primary.id, status: 'unverified' })

  /*
    ⚠️ 端到端那几条（起真的 `electron . run …` 子进程）**不在这里**，在 verify-ui.mjs。

    原因是脚本开头那条 safeStorage 的坑：独立跑 `pnpm verify:core` 时
    没有 `--user-data-dir` 开关，于是走 `app.setPath('userData', sandbox)` ——
    而 Windows 上 safeStorage 的 OSCrypt 密钥存在 **Chromium 启动早期就定下的**
    那个 userData 的 `Local State` 里，setPath 改不动它。
    结果是：数据库在沙箱里，而解 vault.key 的密钥在默认 userData 里，
    两者是分开的。子进程无论用哪个 userData 都凑不齐这两样。

    verify-ui.mjs 那边两个进程都带着同一个 `--user-data-dir`，
    所以端到端只能放在那儿跑。

    🔴 第一版把它写在这里，结果是 CLI 根本没起来，而「磁盘上搜不到 Key」
    那条却 **PASS 了** —— 它是空过的。断言够不着它要守的分支时，
    看起来和真的通过一模一样（HANDOFF §8）。
  */

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
    .records
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

  // --- 🔴 模板生成：兜底没过就绝不写盘（阶段 5b）-----------------------------
  //
  // 单独造一个项目，**不往 fixture 里加文件** —— 样例数据是共享的（§8），
  // 往里加一个 .env* 会弄红后面和界面验收里那些"文件集合"断言。用完就删。
  //
  // 这一处的写法是故意挑的：`TODO:` 后面是冒号不是等号，不匹配赋值形状，
  // 自动脱敏（redactCommentText）够不着它 —— 只有兜底那道能抓住。
  const leakRoot = join(sandbox, 'leaky-project')
  mkdirSync(leakRoot, { recursive: true })
  writeFileSync(
    join(leakRoot, '.env'),
    [
      `# TODO: 上线前把 key 换成 sk-proj-abcdefghijklmnopqrstuvwxyz012345`,
      'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345',
      ''
    ].join('\n')
  )
  const leakProject = repo.importProject({
    rootPath: leakRoot,
    name: 'leaky',
    includePaths: [join(leakRoot, '.env')]
  })
  const leakFile = repo.listFiles(leakProject.id)[0]!
  const leakPreview = template.previewTemplate(leakFile.id)
  check(
    '🔴 兜底认出了自动脱敏漏掉的那一处',
    leakPreview.leaks.length === 1 && leakPreview.leaks[0]?.key === 'OPENAI_API_KEY',
    `leaks=${JSON.stringify(leakPreview.leaks)}`
  )

  let leakWriteError = ''
  try {
    template.writeTemplate(leakFile.id, null)
  } catch (error) {
    leakWriteError = error instanceof Error ? error.message : String(error)
  }
  const leakTargetExists = existsSync(join(leakRoot, '.env.example'))
  check(
    '🔴 兜底没过就拒绝写盘，且磁盘上没留下半个文件',
    leakWriteError.includes('敏感值') && !leakTargetExists,
    `拒绝信息=${leakWriteError || '（居然没拒绝）'} / 目标文件存在=${leakTargetExists}`
  )
  check(
    '🔴 拒绝信息里只有行号和 key 名，没有值本身',
    !leakWriteError.includes('sk-proj-abcdefghijklmnopqrstuvwxyz012345'),
    leakWriteError.includes('sk-proj-') ? '拒绝信息里带上了 Key' : leakWriteError
  )
  repo.removeProject(leakProject.id)
  rmSync(leakRoot, { recursive: true, force: true })

  // --- 🔴 一次纳管多个项目：每个仓库各自一个 gitRoot（阶段 6）-------------
  //
  // 这一段守的是一个**正确性**问题，不是"省几次点击"：一个项目只存一个
  // git_root，而安全检查拿它做全部判断。十几个仓库塞进一个项目 =
  // 对着错误的仓库问跟踪状态 = 那条最有价值的 critical 静默消失。

  const discovered = repo.discoverProjectsPreview(workspaceRoot)
  check(
    '发现出选中目录自己 + 底下两个仓库，一共三个项目',
    discovered.projects.length === 3 && discovered.startIsRepo === true,
    discovered.projects.map((p) => `${p.suggestedName}(${p.isGitRepo ? 'git' : '非git'})`).join(', ')
  )

  const wsSelf = discovered.projects.find((p) => p.rootPath === workspaceRoot)!
  check(
    '🔴 父目录那个项目里**没有**子仓库的文件（扫描在嵌套仓库处停了）',
    wsSelf.files.length === 1 && wsSelf.files[0]?.relativePath === '.env',
    wsSelf.files.map((f) => f.relativePath).join(', ') || '（一个文件都没有）'
  )

  const bulk = repo.importProjects(
    discovered.projects.map((project) => ({
      rootPath: project.rootPath,
      name: project.suggestedName,
      includePaths: project.files.map((f) => f.absolutePath)
    }))
  )
  check(
    '批量纳管把三个项目都建起来了',
    bulk.imported.length === 3 && bulk.skipped.length === 0,
    `导入 ${bulk.imported.length}、跳过 ${bulk.skipped.length}`
  )

  const repoAProject = bulk.imported.find((p) => p.name === 'repo-a')!
  const repoBProject = bulk.imported.find((p) => p.name === 'repo-b')!
  check(
    '🔴 每个项目的 gitRoot 是**它自己**的仓库根，不是父目录',
    repoAProject.gitRoot === join(workspaceRoot, 'repo-a') &&
      repoBProject.gitRoot === join(workspaceRoot, 'repo-b'),
    `repo-a=${repoAProject.gitRoot} / repo-b=${repoBProject.gitRoot}`
  )

  // 🔴 这一条才是全部理由：那把「已提交又补进 .gitignore」的 Key
  // 必须在 repo-a **自己的**仓库里被判成 critical。
  // 如果三个仓库共用父目录当 gitRoot，它在父仓库看来是「未跟踪」，
  // tracked=false → 判定表走不到那一条 → 这条 critical 整个消失。
  const repoAReport = await security.scanSecurity(repoAProject.id)
  const repoALocal = repoAReport.files.find((f) => f.relativePath === '.env.local')
  check(
    '🔴 「已提交又补进 .gitignore」在子仓库里照样报得出来',
    repoALocal?.level === 'critical' &&
      repoALocal.tracked === true &&
      repoALocal.ignored === true,
    `level=${repoALocal?.level} tracked=${repoALocal?.tracked} ignored=${repoALocal?.ignored}`
  )
  check(
    '🔴 而且 Git 状态是查得了的（不是退化成 unknown 蒙混过关）',
    repoAReport.gitUnavailable === null,
    repoAReport.gitUnavailable ?? '查得了'
  )

  check(
    '重复批量导入会逐个跳过，不是整批失败',
    (() => {
      const again = repo.importProjects([
        {
          rootPath: repoAProject.absolutePath,
          name: 'repo-a',
          includePaths: []
        }
      ])
      return again.imported.length === 0 && again.skipped.length === 1
    })(),
    '已存在的逐个报出来'
  )

  for (const project of bulk.imported) repo.removeProject(project.id)

  // --- 🔴 加密导出：包里搜不到明文（阶段 5c）--------------------------------
  const PASSPHRASE = 'a-long-enough-test-passphrase'

  // 自己造一条凭据再导：跑到这一段时前面的凭据已经被「删除凭据」那节删光了，
  // 指望共享样例数据的残留，这条断言会随着别处的改动悄悄变成"导出 0 条也算过"。
  // 和阶段 3 单独加一个 ANTHROPIC_API_KEY 是同一个理由（§8）。
  const TRANSFER_KEY = 'sk-ant-api03-transfer-0123456789abcdef'
  const transferCredential = cred.createCredential({
    providerId: 'anthropic',
    credentialName: 'verify-transfer',
    endpoint: 'https://api.anthropic.com/v1',
    apiKey: TRANSFER_KEY
  })

  const payload = transfer.buildPayload([project.id], true)
  // 用调低的 KDF 参数：验收脚本要跑得完，而「默认参数是 2^17」由单元测试守着。
  const sealedPackage = sealPackage(JSON.stringify(payload), PASSPHRASE, { log2N: 10, r: 8, p: 1 })

  // 针串里额外加上刚造的那把凭据 Key —— 它是这一段里唯一"因为勾了凭据才进包"的值。
  const TRANSFER_NEEDLES = [...NEEDLES, TRANSFER_KEY]
  const sealedLeaks = TRANSFER_NEEDLES.filter((needle) =>
    sealedPackage.includes(Buffer.from(needle, 'utf8'))
  )
  check(
    '🔴 加密包的字节里搜不到任何一把样例密钥',
    sealedLeaks.length === 0,
    sealedLeaks.length === 0 ? `${sealedPackage.length} 字节` : `命中: ${sealedLeaks.join(', ')}`
  )
  check(
    '🔴 但明文 payload 里确实有它们 —— 上一条才有意义',
    TRANSFER_NEEDLES.filter((needle) => JSON.stringify(payload).includes(needle)).length >= 3,
    `明文 payload 里命中 ${TRANSFER_NEEDLES.filter((n) => JSON.stringify(payload).includes(n)).length} 条`
  )
  check(
    '勾了凭据就真的带上了凭据的明文 Key',
    payload.credentials.some((c) => c.apiKey === TRANSFER_KEY),
    `${payload.credentials.length} 条凭据`
  )
  check(
    '🔴 不勾凭据时包里一条凭据都没有',
    transfer.buildPayload([project.id], false).credentials.length === 0,
    '默认不勾，勾了才带'
  )
  check(
    '🔴 包里不含凭据指纹 —— 它是本机主密钥派生的，换台机器没有意义',
    !JSON.stringify(payload).includes('fingerprint'),
    '只带 apiKey，指纹由导入方重算'
  )

  // 留痕由 IPC handler 调（写盘那一步在那儿），这里显式调一次 ——
  // 否则界面验收那条「记录里的动作都是中文」永远盖不到 transfer.export，
  // 而它恰恰是最该被审计的一条。
  transfer.logExport(
    payload.projects.length,
    payload.projects.reduce((s, p) => s + p.files.reduce((n, f) => n + f.entries.length, 0), 0),
    payload.credentials.length,
    join(sandbox, 'verify.evpkg')
  )

  let wrongPassphrase = ''
  try {
    openPackage(sealedPackage, 'not-the-passphrase')
  } catch (error) {
    wrongPassphrase = error instanceof Error ? error.message : String(error)
  }
  check('🔴 口令不对就打不开', wrongPassphrase.includes('口令不对'), wrongPassphrase || '（居然打开了）')

  // --- 往返保真：解开之后和库里逐条对得上 -----------------------------------
  const reopened = openPackage(sealedPackage, PASSPHRASE)
  const roundTrip = transfer.previewImport(reopened)
  const rtFiles = roundTrip.projects.flatMap((p) => p.files)
  check(
    '🔴 原样导回来时，每个文件都是「已存在且全部相同」—— 往返没丢也没改',
    rtFiles.length > 0 &&
      rtFiles.every((f) => f.status === 'existing' && f.addedCount === 0 && f.changedCount === 0),
    rtFiles.map((f) => `${f.relativePath}(+${f.addedCount}/~${f.changedCount}/=${f.sameCount})`).join(' ')
  )

  // --- 🔴 导入不碰磁盘 -------------------------------------------------------
  /** 文件不存在时给一个固定串，好让"消失了"和"内容变了"都能被下面那条比出来。 */
  const hashOf = (path: string): string =>
    existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : '(缺失)'

  const allFileKeys = rtFiles.map((f) =>
    transfer.fileKeyOf(roundTrip.projects[0]!.absolutePath, f.relativePath)
  )

  check(
    '把同一个包原样再导一遍是空操作',
    (() => {
      const noop = transfer.applyImport(reopened, { fileKeys: allFileKeys, credentialNames: [] })
      return noop.entriesAdded === 0 && noop.entriesUpdated === 0
    })(),
    '包和库一致时不产生任何写入'
  )

  // 🔴 下面这条「磁盘没变」如果只跟着上面那次**空操作**跑，它是空过的 ——
  // 什么都没导，磁盘当然不会变。所以先把中心记录里一个值改掉，
  // 让这次导入**真的有事可做**，再看磁盘动没动。
  const victim = repo
    .listEntries({ projectId: project.id })
    .find((entry) => entry.key === 'LOG_LEVEL')!
  // 🔴 原值现读，不写死：前面「重扫」那节已经把 LOG_LEVEL 从 debug 改成 info 了，
  // 照初始 fixture 写一个字面量，这条断言会随着别处的改动悄悄失真（§8）。
  const victimOriginal = repo.revealEntry(victim.id).value
  db.prepare('UPDATE config_entries SET encrypted_value = ? WHERE id = ?').run(
    vault.encryptValue('tampered-by-verify'),
    victim.id
  )

  const watchedPaths = repo.listFiles(project.id).map((f) => join(fixtureRoot, f.relativePath))
  const hashesBefore = watchedPaths.map((p) => `${p}=${hashOf(p)}`)
  const restoring = transfer.applyImport(reopened, {
    fileKeys: allFileKeys,
    credentialNames: []
  })
  const hashesAfter = watchedPaths.map((p) => `${p}=${hashOf(p)}`)

  check(
    '🔴 这次导入确实改了中心记录 —— 下一条才有意义',
    restoring.entriesUpdated === 1,
    `更新 ${restoring.entriesUpdated} 个变量`
  )
  // detail 要分别写成功和失败两种情况：第一版无论过没过都说「N 个文件哈希未变」，
  // 而它红的时候那句话正好是反的 —— 一条说谎的失败信息比没有信息更费时间。
  const touchedByImport = hashesBefore.filter((line, index) => line !== hashesAfter[index])
  check(
    '🔴 但磁盘上的 .env 一个字节都没变（导入只写中心记录）',
    touchedByImport.length === 0,
    touchedByImport.length === 0
      ? `${hashesBefore.length} 个文件哈希未变`
      : `被改动的文件：${touchedByImport.map((line) => line.split('=')[0]).join(', ')}`
  )
  check(
    '导入把被改掉的值还原了回来',
    repo.revealEntry(victim.id).value === victimOriginal,
    `还原成 ${repo.revealEntry(victim.id).value}（原值 ${victimOriginal}）`
  )

  // --- 导入一个本机没有的项目：记录建起来，但磁盘上什么都不写 ---------------
  const importedRoot = join(sandbox, 'imported-project')
  const syntheticPayload = JSON.stringify({
    formatVersion: 1,
    exportedAt: Date.now(),
    projects: [
      {
        name: 'imported',
        absolutePath: importedRoot,
        files: [
          {
            relativePath: '.env.local',
            environment: 'local',
            entries: [
              { key: 'IMPORTED_KEY', occurrence: 0, value: 'sk-proj-importedvalue0123456789' },
              { key: 'IMPORTED_PORT', occurrence: 0, value: '9000' }
            ]
          }
        ]
      }
    ],
    credentials: []
  })
  const importedResult = transfer.applyImport(syntheticPayload, {
    fileKeys: [transfer.fileKeyOf(importedRoot, '.env.local')],
    credentialNames: []
  })
  check(
    '导入一个新项目会把记录建起来',
    importedResult.projectsCreated === 1 &&
      importedResult.filesCreated === 1 &&
      importedResult.entriesAdded === 2,
    `项目 ${importedResult.projectsCreated}、文件 ${importedResult.filesCreated}、变量 ${importedResult.entriesAdded}`
  )
  check(
    '🔴 但磁盘上连那个目录都没被创建出来 —— 导入只写中心记录',
    !existsSync(importedRoot),
    existsSync(importedRoot) ? '导入把文件写到磁盘上了' : '磁盘未被触碰'
  )

  const importedProject = repo.listProjects().find((p) => p.name === 'imported')
  const importedEntries = repo.listEntries({ projectId: importedProject!.id })
  check(
    '🔴 导入的敏感值同样是加密入库的（列表里只给掩码）',
    importedEntries.every((entry) =>
      entry.sensitivity === 'high' ? entry.displayValue === MASKED_PLACEHOLDER : true
    ) && importedEntries.some((entry) => entry.sensitivity === 'high'),
    importedEntries.map((entry) => `${entry.key}:${entry.sensitivity}`).join(', ')
  )
  repo.removeProject(importedProject!.id)
  // 这一段自己造的凭据也要收干净，否则界面验收那边的凭据列表会多出一条（§8）。
  cred.deleteCredential(transferCredential.id)

  // --- Vault 锁定后读不到值 -------------------------------------------------
  vault.lock()

  // 🔴 安全检查不需要解锁：敏感度那一列本来就不加密，全程不解密任何东西。
  // 这恰恰是它最该能用的时候之一 —— 你不需要打开保险柜，
  // 才能知道保险柜有没有被拍照传到 GitHub 上。
  const lockedReport = await security.scanSecurity(project.id)
  check(
    '🔴 Vault 锁着时安全检查照样出结论',
    lockedReport.files.length > 0 &&
      lockedReport.gitUnavailable === null &&
      lockedReport.files.find((f) => f.relativePath === '.env.local')?.level === 'critical',
    `锁定后列出 ${lockedReport.files.length} 个文件，.env.local=${lockedReport.files.find((f) => f.relativePath === '.env.local')?.level}`
  )
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

  // --- 🔴 生成 .env.example：全程不解密，所以锁着也能用（阶段 5b）------------
  //
  // 故意放在 vault.lock() **之后**：模板是从磁盘文件生成的，中心记录里根本没有
  // 注释，所以这条路不需要主密钥。和安全检查同一个性质。
  // 拿 .env.local 当底本 —— 它是 fixture 里唯一密钥密布的那份，
  // 用一份本来就没有秘密的文件去验"模板里没有秘密"是空过的。
  const tplSource = repo.listFiles(project.id).find((f) => f.fileName === '.env.local')!
  const tplPreview = template.previewTemplate(tplSource.id)
  check(
    '🔴 Vault 锁着时照样能生成模板（全程不解密）',
    tplPreview.entryCount > 0 && tplPreview.leaks.length === 0,
    `${tplPreview.entryCount} 个变量 → ${tplPreview.targetRelativePath}，leaks=${tplPreview.leaks.length}`
  )
  check(
    '模板保留了注释、行内注释与引号风格，只清掉值',
    tplPreview.content.includes('# 本机覆盖，不进 Git') &&
      tplPreview.content.includes('OPENAI_API_KEY=') &&
      tplPreview.content.includes('LOG_LEVEL=   # 只在本机开 debug') &&
      tplPreview.content.includes("DB_PASSWORD=''"),
    JSON.stringify(tplPreview.content.slice(0, 120))
  )
  // 🔴 期望从**此刻的源文件**现算，不写死数字：前面的段落删过 DUP、
  // 也删过 ANTHROPIC_API_KEY，写死的期望会随着别处的改动悄悄失真
  // （而这里要验的本来就是"模板跟着源文件走"，不是"fixture 长什么样"）。
  const tplSourceKeys = entriesOf(
    parseEnv(readFileSync(join(fixtureRoot, '.env.local'), 'utf8'))
  ).map((node) => node.key)
  const tplTemplateKeys = entriesOf(parseEnv(tplPreview.content)).map((node) => node.key)
  check(
    '模板的变量序列和源文件逐个对得上（含重复 key）',
    JSON.stringify(tplTemplateKeys) === JSON.stringify(tplSourceKeys),
    `模板=${tplTemplateKeys.join(',')} / 源=${tplSourceKeys.join(',')}`
  )
  check(
    '🔴 模板里每个变量的值都是空的',
    entriesOf(parseEnv(tplPreview.content)).every((node) => node.value === ''),
    entriesOf(parseEnv(tplPreview.content))
      .filter((node) => node.value !== '')
      .map((node) => node.key)
      .join(',') || '全部为空'
  )

  const tplTarget = join(fixtureRoot, '.env.example')
  check('底本之外，目标模板此刻是存在的（下一条验的是覆盖）', existsSync(tplTarget), tplTarget)
  const tplWritten = template.writeTemplate(tplSource.id, tplPreview.targetHash)
  const tplOnDisk = readFileSync(tplTarget, 'utf8')

  // 🔴 扫的是**磁盘上真实写出来的那份**，不是返回值里的字符串 ——
  // 返回值干净但写出去的不干净，正是这条断言要防的事。
  const tplLeaked = NEEDLES.filter((needle) => tplOnDisk.includes(needle))
  check(
    '🔴 写出来的 .env.example 里搜不到任何一把样例密钥（阶段 5b 的全部理由）',
    tplLeaked.length === 0,
    tplLeaked.length === 0 ? `${tplOnDisk.length} 字节，${tplWritten.entryCount} 个变量` : `命中: ${tplLeaked.join(', ')}`
  )
  check(
    '🔴 但它确实带上了源文件的每一个变量名 —— 上一条才有意义',
    tplSourceKeys.length > 0 && tplSourceKeys.every((key) => tplOnDisk.includes(key)),
    tplSourceKeys.filter((key) => !tplOnDisk.includes(key)).join(',') ||
      `${tplSourceKeys.length} 个变量名都在，值都不在`
  )
  check(
    '覆盖已存在的模板时留了备份',
    tplWritten.backupPath !== null && existsSync(tplWritten.backupPath),
    tplWritten.backupPath ?? '（没有备份）'
  )
  check(
    '🔴 生成模板不会把它顺手纳管进来',
    !repo.listFiles(project.id).some((f) => f.fileName === '.env.example'),
    repo.listFiles(project.id).map((f) => f.fileName).join(', ')
  )

  // 目标已经存在了，再拿"我断言它不存在"去写必须失败 —— 那个 null 是断言，不是旁路。
  let tplAbsentBlocked = ''
  try {
    template.writeTemplate(tplSource.id, null)
  } catch (error) {
    tplAbsentBlocked = error instanceof Error ? error.message : String(error)
  }
  check(
    '🔴 目标已存在时，expectedTargetHash=null 会被拒绝',
    tplAbsentBlocked.includes('被创建'),
    tplAbsentBlocked || '（居然写成功了）'
  )

  // 留给界面验收的是锁定态：让它自己走一遍解锁 → 数据出现。
  if (keepDir) {
    console.log(`\n沙箱已保留：${sandbox}`)
    console.log(`样例项目：${fixtureRoot}`)
  }
}
