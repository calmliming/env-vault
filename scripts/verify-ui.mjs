/**
 * 界面与 IPC 验收。启动真正构建出来的应用，用 Chrome DevTools Protocol
 * 在渲染进程里执行断言，不靠人眼看截图。
 *
 * ## 数据从哪来
 *
 * 先跑一遍 `verify-core`（`--keep <沙箱>`）：它会在沙箱里建库、创建 Vault、
 * 扫描并导入一个刻意做得很难看的样例项目，然后**保留**沙箱。
 * 界面随后用 `--user-data-dir=<沙箱>` 启动，面对的就是一份刚被逐条验证过的真数据。
 *
 * 这么绕一圈是因为「添加项目」要走系统目录对话框，CDP 点不动它。
 * 与其为了测试在生产代码里开一个后门，不如让测试从数据这一侧进入。
 *
 * ## 重点验什么
 *   1. 渲染进程确实拿不到 Node（contextIsolation + sandbox 生效）；
 *   2. preload 只挂了白名单方法，没有通用的 invoke 逃生口；
 *   3. Vault 锁定时读不到值、解锁后数据自己出现；
 *   4. 🔴 敏感值的明文不在页面 DOM 里，除非用户显式点了「显示」。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 9333
const ELECTRON = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
const OVERVIEW_SHOT = join(process.cwd(), 'out', 'verify-ui-overview.png')
const ACTIVITY_SHOT = join(process.cwd(), 'out', 'verify-ui-activity.png')
const CREDENTIALS_SHOT = join(process.cwd(), 'out', 'verify-ui-credentials.png')
const SECURITY_SHOT = join(process.cwd(), 'out', 'verify-ui-security.png')
const sandbox = mkdtempSync(join(tmpdir(), 'envvault-ui-'))

/** 样例数据里那把假 Key。整个流程都在确认它不会意外出现在页面上。 */
const FIXTURE_SECRET = 'sk-proj-abcdefghijklmnopqrstuvwxyz012345'

const checks = []
const check = (name, pass, detail) => checks.push({ name, pass, detail })

/** 页面侧的控制台错误与未捕获异常，由 CDP 事件填充。 */
const pageErrors = []

// --- 1. 播种 ----------------------------------------------------------------

// 🔴 `--user-data-dir` 必须和下面启动应用时用的是同一个，而且必须是这个开关
// 而不是脚本里的 app.setPath —— Windows 上 safeStorage 的密钥存在 userData 的
// `Local State` 里，两个进程用不同的 userData 就解不开对方写的 vault.key。
const seed = spawnSync(
  ELECTRON,
  [join('out', 'verify', 'index.mjs'), '--keep', sandbox, `--user-data-dir=${sandbox}`],
  { cwd: process.cwd(), encoding: 'utf8' }
)
const seedOk = seed.status === 0
check(
  '核心验收通过并保留了沙箱数据',
  seedOk,
  seedOk ? sandbox : `退出码 ${seed.status}：${(seed.stdout || '').split('\n').filter((l) => l.startsWith('FAIL')).join(' | ') || seed.stderr}`
)

let child = null
let ws = null
let nextId = 1
const pending = new Map()

if (seedOk) {
  child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${sandbox}`], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    // 🔴 界面验收会真的去点那颗「验证」按钮，而它背后是应用里唯一一条
    // 会发出站请求的路。这个变量让真传输直接拒发 —— 于是这条验收
    // 既能走到验证流程，又保证一个字节都不出网。
    // 附带的好处是它正好落在「没验出结论」那条分支上，
    // 而那正是最需要被守住的一条：验证失败不许改凭据状态。
    env: { ...process.env, ENVVAULT_BLOCK_NETWORK: '1' }
  })
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += d.toString()
  })

  try {
    const target = await waitForPageTarget()
    ws = await connect(target.webSocketDebuggerUrl)
    // Log.enable 在开启时会补发已有条目，所以连接稍晚也不会漏掉启动阶段的错误。
    await send('Runtime.enable')
    await send('Log.enable')
    await send('Page.enable')
    await waitForRender()
    await runChecks()
  } catch (error) {
    check('验收脚本正常结束', false, error?.message ?? String(error))
    if (stderr.trim()) check('应用 stderr', false, stderr.trim().slice(0, 500))
  } finally {
    ws?.close()
    child.kill()
  }
}

try {
  rmSync(sandbox, { recursive: true, force: true })
} catch {
  /* 应用可能还握着文件句柄，清理失败不影响结论 */
}

const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  —  ${c.detail}`)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)

// ---------------------------------------------------------------------------

async function runChecks() {
  // --- 外壳与进程隔离 -------------------------------------------------------
  const dom = await evaluate(`(() => ({
    title: document.title,
    shell: !!document.querySelector('.app-shell'),
    navCount: document.querySelectorAll('.nav button').length,
    logoCore: document.querySelectorAll('.brand-mark-core').length,
    projects: [...document.querySelectorAll('.project-name')].map(el => el.textContent.trim()),
    vaultText: document.querySelector('.vault-state')?.textContent.trim() ?? '',
    modalPresent: !!document.querySelector('.modal-layer')
  }))()`)

  check('页面标题正确', dom.title === 'EnvVault · 配置工作台', dom.title)
  check('应用外壳渲染成功', dom.shell === true, `.app-shell=${dom.shell}`)
  check('主导航五项齐全（§5.1）', dom.navCount === 5, `count=${dom.navCount}`)
  check('logo 受保护核心渲染一次', dom.logoCore === 1, `count=${dom.logoCore}`)
  check('弹窗默认不在 DOM 中', dom.modalPresent === false, `modal-layer=${dom.modalPresent}`)

  const isolation = await evaluate(`(() => ({
    hasRequire: typeof window.require,
    hasProcess: typeof window.process,
    hasModule: typeof window.module,
    hasIpcRenderer: typeof window.ipcRenderer,
    bridgeType: typeof window.envvault,
    bridgeKeys: window.envvault ? Object.keys(window.envvault).sort() : [],
    genericInvoke: typeof window.envvault?.invoke
  }))()`)

  check(
    '渲染进程拿不到 Node（§3.2 / MVP 清单最后一条）',
    isolation.hasRequire === 'undefined' &&
      isolation.hasProcess === 'undefined' &&
      isolation.hasModule === 'undefined',
    `require=${isolation.hasRequire} process=${isolation.hasProcess} module=${isolation.hasModule}`
  )
  check('ipcRenderer 未被暴露', isolation.hasIpcRenderer === 'undefined', `typeof=${isolation.hasIpcRenderer}`)
  check('没有通用 invoke 逃生口', isolation.genericInvoke === 'undefined', `typeof=${isolation.genericInvoke}`)
  check(
    'preload 只暴露白名单方法',
    // 阶段 3 收尾 +validateCredential（33→34）、4a +scanSecurity（→35）、
    // 4b +listCredentialVersions/copyEntryValue/copyCredentialKey（→38）。
    isolation.bridgeType === 'object' && isolation.bridgeKeys.length === 38,
    `${isolation.bridgeKeys.length} 个：${isolation.bridgeKeys.join(', ')}`
  )

  // --- 播种的项目已经在侧栏 -------------------------------------------------
  check(
    '侧栏列出了已纳管的项目',
    Array.isArray(dom.projects) && dom.projects.includes('fixture'),
    dom.projects.join(', ') || '（空）'
  )

  // --- Vault 锁定时读不到值 -------------------------------------------------
  check('启动时 Vault 为锁定态', dom.vaultText.includes('已锁定'), dom.vaultText)

  const locked = await evaluate(`(() => ({
    emptyRow: document.querySelector('.empty-row')?.textContent?.trim() ?? '',
    dataRows: document.querySelectorAll('.config-table tbody tr .key-name').length,
    bodyHasSecret: document.body.innerText.includes(${JSON.stringify(FIXTURE_SECRET)})
  }))()`)

  check('锁定时表格不显示任何变量', locked.dataRows === 0, `数据行=${locked.dataRows}`)
  check('锁定时给出解锁引导', locked.emptyRow.includes('Vault 已锁定'), locked.emptyRow)
  check('🔴 锁定时页面上没有明文密钥', locked.bodyHasSecret === false, `包含明文=${locked.bodyHasSecret}`)

  // --- 解锁后数据自己出现 ---------------------------------------------------
  const unlocked = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('.vault-action').click();
    for (let i = 0; i < 40; i++) {
      await wait(100);
      if (document.querySelectorAll('.config-table tbody tr .key-name').length > 0) break;
    }
    const keys = [...document.querySelectorAll('.config-table tbody tr .key-name')].map(el => el.textContent.trim());
    return {
      keys,
      maskedCells: document.querySelectorAll('.value.masked').length,
      vaultText: document.querySelector('.vault-state')?.textContent.trim() ?? '',
      envTabs: [...document.querySelectorAll('.env-tab')].map(el => el.textContent.trim()),
      bodyHasSecret: document.body.innerText.includes(${JSON.stringify(FIXTURE_SECRET)})
    };
  })()`, true)

  check('解锁后 Vault 状态变为已解锁', unlocked.vaultText.includes('已解锁'), unlocked.vaultText)

  /*
   * 断言的是**键的集合**而不是行数。
   * 行数只是个数字，verify-core 那边多做一步变更就得跟着改，而且失败时
   * 只会告诉你 "12 !== 14"，看不出少了谁、多了谁。
   * 这个集合是 verify-core 全部操作跑完后中心记录该有的样子。
   */
  const EXPECTED_KEYS = [
    'APP_NAME', 'BRAND_NEW', 'DATABASE_URL', 'DB_PASSWORD', 'DUP', 'DUP',
    'ENABLE_CACHE', 'LOG_LEVEL', 'NEXTAUTH_SECRET', 'NEXT_PUBLIC_API_URL',
    'OPENAI_API_KEY', 'PORT', 'STAGE'
  ]
  const actualKeys = [...unlocked.keys].sort()
  const expectedSorted = [...EXPECTED_KEYS].sort()
  const missingKeys = expectedSorted.filter((k) => !actualKeys.includes(k))
  const extraKeys = actualKeys.filter((k) => !expectedSorted.includes(k))
  check(
    '解锁后表格自动填上真实变量',
    JSON.stringify(actualKeys) === JSON.stringify(expectedSorted),
    missingKeys.length || extraKeys.length
      ? `缺少 [${missingKeys.join(', ')}] 多出 [${extraKeys.join(', ')}]`
      : `${actualKeys.length} 行，与预期集合完全一致`
  )
  check(
    '重复的 key 两条都显示出来',
    unlocked.keys.filter((k) => k === 'DUP').length === 2,
    `DUP 出现 ${unlocked.keys.filter((k) => k === 'DUP').length} 次`
  )
  // 五条：OPENAI_API_KEY / DB_PASSWORD / NEXTAUTH_SECRET / DATABASE_URL，
  // 外加 BRAND_NEW —— 核心验收把它的值改成了一把真 Key，重新分类后就该掩码。
  check('敏感项默认掩码（§7）', unlocked.maskedCells === 5, `掩码单元格=${unlocked.maskedCells}`)
  check(
    '🔴 解锁后明文密钥仍不在页面上（没点显示就不给）',
    unlocked.bodyHasSecret === false,
    `包含明文=${unlocked.bodyHasSecret}`
  )
  check(
    '环境标签来自真实数据',
    ['全部', 'default', 'local', 'production'].every((tab) => unlocked.envTabs.includes(tab)),
    unlocked.envTabs.join(' / ')
  )

  await capture(OVERVIEW_SHOT)

  // --- 显式点击后才给明文 ---------------------------------------------------
  const reveal = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const row = [...document.querySelectorAll('.config-table tbody tr')]
      .find(tr => tr.querySelector('.key-name')?.textContent.trim() === 'OPENAI_API_KEY');
    // 前一步失败时这里会是 undefined。直接返回可读的结论，
    // 而不是抛一个 "Cannot read properties of undefined" 把真正的失败原因盖掉。
    if (!row) return { shown: '', bodyHasSecret: false, missingRow: true };
    row.querySelector('[data-action="reveal"]').click();
    await wait(400);
    return {
      shown: row.querySelector('.value')?.textContent.trim() ?? '',
      bodyHasSecret: document.body.innerText.includes(${JSON.stringify(FIXTURE_SECRET)})
    };
  })()`, true)

  check(
    '点击"显示"后拿到真实明文',
    reveal.shown === FIXTURE_SECRET && reveal.bodyHasSecret === true,
    reveal.missingRow ? '找不到 OPENAI_API_KEY 行' : `显示值长度=${reveal.shown.length}`
  )

  // --- 筛选与环境切换 -------------------------------------------------------
  const search = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const input = document.querySelector('.table-tools input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'OPENAI');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(80);
    const filtered = document.querySelectorAll('.config-table tbody tr .key-name').length;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(80);
    return { filtered, restored: document.querySelectorAll('.config-table tbody tr .key-name').length };
  })()`, true)

  // 清空后应当回到解锁时的行数，不再写死数字。
  check(
    '表格搜索可用',
    search.filtered === 1 && search.restored === unlocked.keys.length,
    `筛选后 ${search.filtered} 行，清空后 ${search.restored} 行（应为 ${unlocked.keys.length}）`
  )

  const envFilter = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const tab = [...document.querySelectorAll('.env-tab')].find(b => b.textContent.trim() === 'production');
    tab.click();
    for (let i = 0; i < 30; i++) {
      await wait(100);
      const n = document.querySelectorAll('.config-table tbody tr .key-name').length;
      if (n > 0 && n < 12) break;
    }
    return [...document.querySelectorAll('.config-table tbody tr .key-name')].map(el => el.textContent.trim());
  })()`, true)

  check(
    '按环境筛选走的是真实查询',
    Array.isArray(envFilter) && envFilter.length === 1 && envFilter[0] === 'DATABASE_URL',
    envFilter.join(', ')
  )

  // --- 文件健康度反映磁盘真实状态 -------------------------------------------
  const health = await evaluate(`(() => {
    const items = [...document.querySelectorAll('.health-item')].map(el => ({
      name: el.querySelector('.health-name')?.textContent.trim() ?? '',
      badge: el.querySelector('.health-badge')?.textContent.trim() ?? ''
    }));
    return { items, panelBadge: document.querySelector('.side-stack .health-badge')?.textContent.trim() ?? '' };
  })()`)

  // 核心脚本最后删掉了 .env.staging，记录保留 —— 界面必须显示它已丢失
  const staging = health.items.find((item) => item.name === '.env.staging')
  check(
    '磁盘上消失的文件显示为已丢失',
    staging?.badge === '已丢失',
    health.items.map((i) => `${i.name}:${i.badge}`).join(' / ')
  )
  check(
    '未改动的文件显示为一致',
    health.items.filter((i) => i.badge === '一致').length === 3,
    `一致 ${health.items.filter((i) => i.badge === '一致').length} 个`
  )

  // --- 文件监听：外部改动不点任何按钮也要亮起来（§6.4）----------------------
  // 先把环境筛选切回「全部」：上面那条测试把它停在 production 了，
  // 而下面要看的 PORT 属于 default 环境，不切回来表格里根本没有它。
  await evaluate(`(async () => {
    [...document.querySelectorAll('.env-tab')].find(b => b.textContent.trim() === '全部').click();
    return new Promise(r => setTimeout(r, 500));
  })()`, true)

  const fixtureEnv = join(sandbox, 'fixture-project', '.env')
  const before = readFileSync(fixtureEnv, 'utf8')
  writeFileSync(fixtureEnv, before.replace(/^PORT=.*$/m, 'PORT=19999'))

  const watched = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const badge = () => [...document.querySelectorAll('.health-item')]
      .find(el => el.querySelector('.health-name')?.textContent.trim() === '.env')
      ?.querySelector('button, .health-badge')?.textContent.trim() ?? '';
    // 不点任何东西，纯等推送。监听有 300ms 去抖 + chokidar 200ms 稳定期。
    for (let i = 0; i < 60; i++) {
      await wait(150);
      if (badge() === '查看差异') break;
    }
    return badge();
  })()`, true)

  check('🔴 外部修改经监听自动反映到界面（无需手动刷新）', watched === '查看差异', `徽章=${watched}`)

  // --- §6.4 决策界面 --------------------------------------------------------
  const diffOpened = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    [...document.querySelectorAll('.health-item')]
      .find(el => el.querySelector('.health-name')?.textContent.trim() === '.env')
      ?.querySelector('button')?.click();
    for (let i = 0; i < 40; i++) {
      await wait(100);
      if (document.querySelector('.diff-list') || document.querySelector('.modal-copy')) break;
    }
    await wait(300);
    return {
      title: document.querySelector('#modal-title')?.textContent ?? '',
      rows: [...document.querySelectorAll('.diff-row')].map(el => ({
        key: el.querySelector('.diff-key')?.textContent.trim() ?? '',
        state: el.querySelector('.diff-state')?.textContent.trim() ?? '',
        detail: el.querySelector('.diff-value')?.textContent.trim() ?? ''
      })),
      buttons: [...document.querySelectorAll('.diff-actions button')].map(b => b.textContent.trim()),
      restoreDisabled: [...document.querySelectorAll('.diff-actions button')]
        .find(b => b.textContent.includes('用记录覆盖文件'))?.disabled ?? null
    };
  })()`, true)

  check('差异弹窗打开', diffOpened.title === '选择处理方向', diffOpened.title)
  check(
    '逐变量差异列出了改动项',
    diffOpened.rows.some((r) => r.key === 'PORT' && r.state === '值不同'),
    diffOpened.rows.map((r) => `${r.key}:${r.state}`).join(' / ') || '（空）'
  )
  check(
    '差异里带出两侧的值',
    diffOpened.rows.find((r) => r.key === 'PORT')?.detail.includes('19999') === true,
    diffOpened.rows.find((r) => r.key === 'PORT')?.detail ?? ''
  )
  check(
    '两个方向都给了按钮，措辞说明会发生什么',
    diffOpened.buttons.includes('用磁盘覆盖记录') &&
      diffOpened.buttons.some((b) => b.startsWith('用记录覆盖文件')),
    diffOpened.buttons.join(' / ')
  )
  check(
    '🔴 默认不选中任何项，写回按钮是禁用的',
    diffOpened.restoreDisabled === true,
    `disabled=${diffOpened.restoreDisabled}`
  )

  // 选方向一：以磁盘为准
  const adopted = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    [...document.querySelectorAll('.diff-actions button')]
      .find(b => b.textContent.trim() === '用磁盘覆盖记录').click();
    for (let i = 0; i < 40; i++) {
      await wait(150);
      if (!document.querySelector('.modal-layer')) break;
    }
    // 关弹窗后会重拉条目与项目列表。轮询到 PORT 有值为止，
    // 固定 sleep 在慢一点的机器上会偶发地读到重载中途的空表。
    const portCell = () => [...document.querySelectorAll('.config-table tbody tr')]
      .find(tr => tr.querySelector('.key-name')?.textContent.trim() === 'PORT')
      ?.querySelector('.value')?.textContent.trim() ?? '';
    for (let i = 0; i < 40; i++) {
      await wait(150);
      if (portCell() !== '') break;
    }
    return {
      closed: !document.querySelector('.modal-layer'),
      portValue: portCell(),
      envBadge: [...document.querySelectorAll('.health-item')]
        .find(el => el.querySelector('.health-name')?.textContent.trim() === '.env')
        ?.querySelector('button, .health-badge')?.textContent.trim() ?? ''
    };
  })()`, true)

  check('选择"用磁盘覆盖记录"后弹窗关闭', adopted.closed === true, `closed=${adopted.closed}`)
  check('中心记录已更新为磁盘上的新值', adopted.portValue === '19999', `PORT=${adopted.portValue}`)
  check('处理完差异后徽章回到一致', adopted.envBadge === '一致', `徽章=${adopted.envBadge}`)

  // --- 模型凭据：从变量提取 → 绑定 → 一改多同步（阶段 3）--------------------
  //
  // verify-core 已经把凭据层逐条验过了，这里验的是**界面到磁盘这条链**：
  // 点了按钮之后，中心记录和 `.env` 文件两头都要对上。

  // 配置总览的侧栏应该已经识别出疑似凭据（BRAND_NEW 的值在核心验收里
  // 被改成了一把 Anthropic 形状的 Key）。
  const suggest = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 30; i++) {
      await wait(150);
      if (document.querySelector('[data-action="extract-credential"]')) break;
    }
    const items = [...document.querySelectorAll('.side-stack .health-item')]
      .filter(el => el.querySelector('[data-action="extract-credential"]'))
      .map(el => ({
        key: el.querySelector('.health-name')?.textContent.trim() ?? '',
        detail: el.querySelector('.health-path')?.textContent.trim() ?? ''
      }));
    return { items, bodyHasSecret: document.body.innerText.includes(${JSON.stringify(FIXTURE_SECRET)}) };
  })()`, true)

  check(
    '配置总览识别出疑似模型凭据',
    suggest.items.some((item) => item.key === 'BRAND_NEW'),
    suggest.items.map((i) => `${i.key}(${i.detail})`).join(' / ') || '（空）'
  )
  check(
    '建议里说明了识别到的厂商',
    suggest.items.find((i) => i.key === 'BRAND_NEW')?.detail.includes('Anthropic') === true,
    suggest.items.find((i) => i.key === 'BRAND_NEW')?.detail ?? ''
  )

  // 提取 → 填 Key → 保存并绑定
  const CREDENTIAL_KEY = 'sk-ant-api03-ui-verify-0123456789abcdef'
  const extract = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const type = (el, value) => {
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };

    [...document.querySelectorAll('.side-stack .health-item')]
      .find(el => el.querySelector('.health-name')?.textContent.trim() === 'BRAND_NEW')
      ?.querySelector('[data-action="extract-credential"]')?.click();
    for (let i = 0; i < 30; i++) {
      await wait(100);
      if (document.querySelector('#credential-key')) break;
    }
    const title = document.querySelector('#modal-title')?.textContent ?? '';
    const keyField = document.querySelector('#credential-key');
    const prefilledKey = keyField.value;
    const keyFieldType = keyField.type;
    const provider = document.querySelector('#provider-name')?.value ?? '';

    type(keyField, ${JSON.stringify(CREDENTIAL_KEY)});
    await wait(80);
    document.querySelector('.modal-actions .primary-btn').click();
    for (let i = 0; i < 40; i++) {
      await wait(150);
      if (!document.querySelector('.modal-layer')) break;
    }
    return { title, prefilledKey, keyFieldType, provider, closed: !document.querySelector('.modal-layer') };
  })()`, true)

  check('从变量提取凭据的弹窗能打开', extract.title === '从变量提取凭据', extract.title)
  check(
    '按值识别把厂商预选成了 Anthropic',
    extract.provider === 'anthropic',
    `provider=${extract.provider}`
  )
  check(
    '🔴 Key 输入框是 password 且不预填 —— 不替用户把已有的 Key 读出来',
    extract.keyFieldType === 'password' && extract.prefilledKey === '',
    `type=${extract.keyFieldType} 预填=${JSON.stringify(extract.prefilledKey)}`
  )
  check('保存后弹窗关闭', extract.closed === true, `closed=${extract.closed}`)

  // 回到配置表：那一行还在，但标了「由凭据管理」，编辑入口关掉了
  const managed = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 30; i++) {
      await wait(150);
      if (document.querySelector('.binding-tag')) break;
    }
    const row = [...document.querySelectorAll('.config-table tbody tr')]
      .find(tr => tr.querySelector('.key-name')?.textContent.trim() === 'BRAND_NEW');
    if (!row) return { missingRow: true };
    return {
      present: true,
      source: row.querySelector('.source-tag')?.textContent.trim() ?? '',
      bindingTag: row.querySelector('.binding-tag')?.textContent.trim() ?? '',
      editDisabled: row.querySelector('[data-action="edit"]').disabled,
      editHint: row.querySelector('[data-action="edit"]').title,
      deleteDisabled: row.querySelector('[data-action="delete"]').disabled,
      status: row.querySelector('.status')?.textContent.trim() ?? ''
    };
  })()`, true)

  check(
    '🔴 提取后变量仍留在配置表里，来源照旧显示（阶段 3 验收）',
    managed.present === true && managed.source === '.env',
    managed.missingRow ? '找不到 BRAND_NEW 行' : `来源=${managed.source}`
  )
  check(
    '并标出它归哪条凭据管',
    typeof managed.bindingTag === 'string' && managed.bindingTag.includes('凭据 Key'),
    managed.bindingTag ?? ''
  )
  check(
    '🔴 归凭据管之后，就地编辑入口关闭并说明原因',
    managed.editDisabled === true && managed.editHint.includes('模型凭据'),
    managed.editHint ?? ''
  )
  check(
    '删除仍然可用（变量真的要没了是合理的，绑定会跟着解除）',
    managed.deleteDisabled === false,
    `disabled=${managed.deleteDisabled}`
  )
  check(
    '状态列说的仍然是文件的事，没被「归凭据管」污染',
    managed.status.includes('已同步'),
    managed.status ?? ''
  )

  // 凭据页：轮换 → 同步预览 → 写入
  const ROTATED_UI_KEY = 'sk-ant-api03-ui-rotated-0123456789abcd'
  const credentialPage = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    [...document.querySelectorAll('.nav button')].find(b => b.textContent.includes('模型凭据')).click();
    for (let i = 0; i < 30; i++) {
      await wait(150);
      if (document.querySelector('.credential-table tbody tr')) break;
    }
    const row = document.querySelector('.credential-table tbody tr');
    return {
      rows: document.querySelectorAll('.credential-table tbody tr[data-credential]').length,
      // 取 Key 那一格，不是行里第一个 .value（那是调用地址）。
      keyCell: row?.querySelector('.value-cell .value')?.textContent.trim() ?? '',
      masked: !!row?.querySelector('.value.masked'),
      bindings: row?.querySelector('[data-action="toggle-bindings"]')?.textContent.trim() ?? '',
      status: row?.querySelector('.type-tag')?.textContent.trim() ?? '',
      validatedAt: row?.querySelector('.credential-validated-at')?.textContent.trim() ?? '',
      bodyHasKey: document.body.innerText.includes(${JSON.stringify(CREDENTIAL_KEY)}),
      // 六列的凭据表最容易把「操作」那一列挤出可视区。文档级横向滚动条
      // 由别处的断言守着，但内容区自己横向溢出同样是列被切掉。
      paneOverflowsX: (() => {
        const pane = document.querySelector('.main-scroll');
        return pane ? pane.scrollWidth > pane.clientWidth : null;
      })(),
      actionsVisible: [...document.querySelectorAll('.credential-actions button')]
        .map(b => b.textContent.trim())
    };
  })()`, true)

  check('凭据页列出了刚创建的凭据', credentialPage.rows === 1, `${credentialPage.rows} 条`)
  check(
    '🔴 列表里 Key 是掩码的，页面上搜不到明文',
    credentialPage.masked === true && credentialPage.bodyHasKey === false,
    `显示=${credentialPage.keyCell} 含明文=${credentialPage.bodyHasKey}`
  )
  check(
    '绑定数来自真实数据',
    credentialPage.bindings.startsWith('1'),
    credentialPage.bindings ?? ''
  )
  check(
    '凭据表不横向溢出，操作列完整可见',
    credentialPage.paneOverflowsX === false &&
      ['验证', '绑定', '轮换', '同步', '删除'].every((label) =>
        credentialPage.actionsVisible.includes(label)
      ),
    `横向溢出=${credentialPage.paneOverflowsX} 操作=${(credentialPage.actionsVisible ?? []).join('/')}`
  )
  check(
    '新建的凭据如实显示「未验证」，没有假装验过',
    credentialPage.status === '未验证' && credentialPage.validatedAt === '尚未验证过',
    `状态=${credentialPage.status} / ${credentialPage.validatedAt}`
  )

  await capture(CREDENTIALS_SHOT)

  // --- 验证：点一次，确认失败不会被记成「Key 坏了」------------------------
  //
  // 这个进程带着 ENVVAULT_BLOCK_NETWORK=1（见上面的 spawn），所以真传输
  // 直接拒发，走到「连不上」那条分支 —— 零出站流量，又正好落在
  // 最需要守住的那一条上：**没验出结论时不许改状态**。
  // 把网络故障记成「已失效」，用户离线点一次验证就会以为所有 Key 都废了。
  const validated = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    // toast 节点是常驻的，上一步的消息还留在里面 —— 所以等的是"内容变了"，
    // 不是"内容非空"，否则会立刻拿到一条陈旧的提示。
    const before = document.querySelector('.toast')?.textContent.trim() ?? '';
    document.querySelector('[data-action="validate-credential"]').click();
    for (let i = 0; i < 60; i++) {
      await wait(100);
      const now = document.querySelector('.toast')?.textContent.trim() ?? '';
      const btn = document.querySelector('[data-action="validate-credential"]');
      if (now !== before && btn && btn.textContent.trim() === '验证') break;
    }
    const row = document.querySelector('.credential-table tbody tr[data-credential]');
    return {
      status: row?.querySelector('.type-tag')?.textContent.trim() ?? '',
      validatedAt: row?.querySelector('.credential-validated-at')?.textContent.trim() ?? '',
      toast: document.querySelector('.toast')?.textContent.trim() ?? ''
    };
  })()`, true)

  check(
    '🔴 验证没问出结论时，凭据状态原地不动（网络不通 ≠ Key 失效）',
    validated.status === '未验证' && validated.validatedAt === '尚未验证过',
    `状态=${validated.status} / ${validated.validatedAt}`
  )
  check(
    '并且如实告诉用户「这次没验出结论」，不说成验证失败',
    validated.toast.includes('没验出结论') && validated.toast.includes('保持不变'),
    validated.toast || '（没有提示）'
  )

  const rotate = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    [...document.querySelectorAll('.credential-actions button')]
      .find(b => b.textContent.trim() === '轮换').click();
    for (let i = 0; i < 30; i++) {
      await wait(100);
      if (document.querySelector('#credential-key')) break;
    }
    // 阶段 4b：影响范围要在**按下确认之前**就摆出来。
    // 它是异步查回来的，所以先等它出现。
    for (let i = 0; i < 40; i++) {
      await wait(100);
      const box = document.querySelector('[data-impact]');
      if (box && !box.innerText.includes('正在查')) break;
    }
    const impactBox = document.querySelector('[data-impact]');
    const impact = {
      present: !!impactBox,
      text: impactBox?.innerText ?? '',
      // 影响范围必须排在确认按钮之前 —— 摆在后面等于没摆。
      beforeConfirm: impactBox
        ? !!(document.querySelector('.modal-actions .primary-btn').compareDocumentPosition(impactBox)
            & Node.DOCUMENT_POSITION_PRECEDING)
        : false
    };

    const field = document.querySelector('#credential-key');
    setter.call(field, ${JSON.stringify(ROTATED_UI_KEY)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(80);
    document.querySelector('.modal-actions .primary-btn').click();
    for (let i = 0; i < 40; i++) {
      await wait(150);
      if (!document.querySelector('.modal-layer')) break;
    }
    return { closed: !document.querySelector('.modal-layer'), impact };
  })()`, true)

  // --- 阶段 4 验收句的后半段：轮换前列出受影响的项目和环境 ------------------
  check(
    '🔴 轮换弹窗在确认之前就列出了受影响的项目和环境',
    rotate.impact.present === true &&
      rotate.impact.beforeConfirm === true &&
      rotate.impact.text.includes('fixture'),
    rotate.impact.text.split('\n').filter(Boolean).slice(0, 3).join(' | ') || '（没有影响范围）'
  )
  check(
    '🔴 影响范围只说改哪儿，不显示 Key',
    !rotate.impact.text.includes(CREDENTIAL_KEY) &&
      !rotate.impact.text.includes(ROTATED_UI_KEY) &&
      !rotate.impact.text.includes('sk-ant-'),
    '和同步预览同一条规矩'
  )
  check(
    '并且说明轮换本身不会自动改写这些文件',
    rotate.impact.text.includes('不会自动改写'),
    '写盘仍然是独立的一步'
  )

  check('轮换弹窗保存后关闭', rotate.closed === true, `closed=${rotate.closed}`)
  check(
    '🔴 创建凭据和轮换都没有偷偷改文件 —— 写盘是独立的一步',
    // 到这里为止文件里仍然是核心验收留下的那把 Key：
    // 「提取」只是建立记录和绑定，「轮换」只换凭据，两者都不写盘。
    readFileSync(fixtureEnv, 'utf8').includes('sk-ant-api03-verify-') &&
      !readFileSync(fixtureEnv, 'utf8').includes(ROTATED_UI_KEY) &&
      !readFileSync(fixtureEnv, 'utf8').includes(CREDENTIAL_KEY),
    readFileSync(fixtureEnv, 'utf8').split('\n').find((l) => l.startsWith('BRAND_NEW=')) ?? ''
  )

  const sync = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('[data-action="sync-credential"]').click();
    for (let i = 0; i < 40; i++) {
      await wait(150);
      if (document.querySelector('.diff-list') || document.querySelector('[data-action="apply-sync"]')) break;
    }
    await wait(200);
    const applyBtn = () => document.querySelector('[data-action="apply-sync"]');
    const before = {
      title: document.querySelector('#modal-title')?.textContent ?? '',
      rows: [...document.querySelectorAll('.diff-row')].map(el => ({
        // 项目名和环境是相邻的两个 span，直接取 textContent 会连成一串。
        key: [...el.querySelectorAll('.diff-key, .diff-key *')]
          .slice(0, 1)
          .map(n => n.childNodes[0]?.textContent?.trim() ?? '')
          .join(''),
        env: el.querySelector('.diff-occurrence')?.textContent.trim() ?? '',
        state: el.querySelector('.diff-state')?.textContent.trim() ?? ''
      })),
      applyDisabled: applyBtn()?.disabled ?? null,
      modalHasKey: (document.querySelector('.modal-body')?.innerText ?? '')
        .includes(${JSON.stringify(ROTATED_UI_KEY)})
    };
    // 勾上唯一那个目标再写入
    document.querySelector('.diff-row input:not([disabled])')?.click();
    await wait(150);
    const afterCheck = applyBtn()?.disabled ?? null;
    applyBtn()?.click();
    for (let i = 0; i < 40; i++) {
      await wait(150);
      if (!document.querySelector('.modal-layer')) break;
    }
    return { ...before, afterCheck, closed: !document.querySelector('.modal-layer') };
  })()`, true)

  check('同步预览打开并列出绑定目标', sync.title.startsWith('同步'), sync.title)
  check(
    '预览如实标出待更新的目标',
    sync.rows.some((row) => row.state === '待更新'),
    sync.rows.map((r) => `${r.key}/${r.env}:${r.state}`).join(' , ') || '（空）'
  )
  check(
    '🔴 预览里不显示 Key 本身（只说哪里要改）',
    sync.modalHasKey === false,
    `含明文=${sync.modalHasKey}`
  )
  check(
    '🔴 默认不勾选任何目标，写入按钮是禁用的',
    sync.applyDisabled === true && sync.afterCheck === false,
    `初始 disabled=${sync.applyDisabled}，勾选后 disabled=${sync.afterCheck}`
  )
  check('写入后弹窗关闭', sync.closed === true, `closed=${sync.closed}`)
  check(
    '🔴 一改多同步真的落到了磁盘文件上',
    readFileSync(fixtureEnv, 'utf8').includes(ROTATED_UI_KEY),
    readFileSync(fixtureEnv, 'utf8').split('\n').find((l) => l.startsWith('BRAND_NEW=')) ?? ''
  )
  check(
    '同步只改那一行，其余内容不动',
    ['# 共享配置', 'APP_NAME=envvault-fixture', 'ENABLE_CACHE=true'].every((line) =>
      readFileSync(fixtureEnv, 'utf8').includes(line)
    ),
    '注释与其余变量都在'
  )

  // --- 复制与停用（阶段 4b）-------------------------------------------------
  //
  // 复制这条路现在整个在主进程里：渲染层只送一个 id 过去，
  // 明文不为了复制而过桥。这里验的是界面这一端如实说明了会发生什么。
  const copyAndRevoke = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const toastText = () => document.querySelector('.toast')?.textContent.trim() ?? '';

    const beforeCopy = toastText();
    document.querySelector('[data-action="copy-credential"]').click();
    for (let i = 0; i < 40; i++) {
      await wait(100);
      if (toastText() !== beforeCopy) break;
    }
    const copyToast = toastText();

    const beforeRevoke = toastText();
    document.querySelector('[data-action="toggle-revoked"]').click();
    for (let i = 0; i < 40; i++) {
      await wait(100);
      if (toastText() !== beforeRevoke) break;
    }
    await wait(200);

    const row = document.querySelector('.credential-table tbody tr[data-credential]');
    const btn = (action) => row?.querySelector('[data-action="' + action + '"]');
    return {
      copyToast,
      revokeToast: toastText(),
      status: row?.querySelector('.type-tag')?.textContent.trim() ?? '',
      syncDisabled: btn('sync-credential')?.disabled ?? null,
      syncTitle: btn('sync-credential')?.title ?? '',
      validateDisabled: btn('validate-credential')?.disabled ?? null,
      toggleLabel: btn('toggle-revoked')?.textContent.trim() ?? '',
      bodyHasKey: document.body.innerText.includes(${JSON.stringify(ROTATED_UI_KEY)})
    };
  })()`, true)

  check(
    '🔴 复制的提示不再说"将在阶段 4 接入"，而是说明多久后清理',
    copyAndRevoke.copyToast.includes('30 秒') && !copyAndRevoke.copyToast.includes('阶段 4'),
    copyAndRevoke.copyToast || '（没有提示）'
  )
  check(
    '并且说明期间复制了别的就不动它',
    copyAndRevoke.copyToast.includes('复制了别的'),
    '不会毁掉用户后来复制的内容'
  )
  check(
    '🔴 复制之后页面上依然搜不到明文（它只进了系统剪贴板）',
    copyAndRevoke.bodyHasKey === false,
    `含明文=${copyAndRevoke.bodyHasKey}`
  )
  check(
    '停用后状态显示为「已停用」',
    copyAndRevoke.status === '已停用',
    `状态=${copyAndRevoke.status}`
  )
  check(
    '🔴 停用后同步与验证的入口都点不动',
    copyAndRevoke.syncDisabled === true && copyAndRevoke.validateDisabled === true,
    `同步=${copyAndRevoke.syncDisabled} 验证=${copyAndRevoke.validateDisabled}`
  )
  check(
    '禁用时说明了为什么，而不是默默不响应',
    copyAndRevoke.syncTitle.includes('已停用'),
    copyAndRevoke.syncTitle || '（没有说明）'
  )
  check(
    '按钮变成「启用」，这个决定是可逆的',
    copyAndRevoke.toggleLabel === '启用',
    `按钮=${copyAndRevoke.toggleLabel}`
  )

  // --- 编辑与删除单个变量（阶段 2 的最后两项）------------------------------
  // 上面那段把视图切到了「模型凭据」，下面的断言都在配置表上，先切回去。
  await evaluate(`(async () => {
    [...document.querySelectorAll('.nav button')].find(b => b.textContent.includes('配置总览')).click();
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 150));
      if (document.querySelector('.config-table tbody tr .key-name')) break;
    }
  })()`, true)
  //
  // 走的是真界面 → 真 IPC → 真磁盘：断言分两头看，表格里的值和 `.env`
  // 文件里的字节都要对上。只看表格的话，一个"改了记录没写盘"的实现也能骗过去。
  const edit = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const rowOf = (key) => [...document.querySelectorAll('.config-table tbody tr')]
      .find(tr => tr.querySelector('.key-name')?.textContent.trim() === key);
    const row = rowOf('PORT');
    if (!row) return { missingRow: true };

    row.querySelector('[data-action="edit"]').click();
    await wait(150);
    const input = rowOf('PORT').querySelector('.value-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '5000');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(80);
    rowOf('PORT').querySelector('[data-action="save"]').click();

    for (let i = 0; i < 40; i++) {
      await wait(150);
      if (rowOf('PORT')?.querySelector('.value')?.textContent.trim() === '5000') break;
    }
    return {
      prefilled: input.defaultValue,
      shown: rowOf('PORT')?.querySelector('.value')?.textContent.trim() ?? '',
      editorClosed: !rowOf('PORT')?.querySelector('.value-input')
    };
  })()`, true)

  check(
    '编辑框保存后关闭，表格显示新值',
    edit.shown === '5000' && edit.editorClosed === true,
    edit.missingRow ? '找不到 PORT 行' : `值=${edit.shown} 编辑框已关=${edit.editorClosed}`
  )
  check(
    '🔴 编辑立刻落到磁盘文件上，不是只改了界面',
    readFileSync(fixtureEnv, 'utf8').includes('PORT=5000'),
    readFileSync(fixtureEnv, 'utf8').split('\n').find((l) => l.startsWith('PORT=')) ?? '（没有 PORT 行）'
  )

  // 🔴 敏感项：点开编辑不等于看见值。编辑框是空的，原值不会因为
  // "点了编辑"就跑到屏幕上 —— 想看要走「显示」，那条路径会留痕。
  const blind = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const rowOf = (key) => [...document.querySelectorAll('.config-table tbody tr')]
      .find(tr => tr.querySelector('.key-name')?.textContent.trim() === key);
    const row = rowOf('DB_PASSWORD');
    if (!row) return { missingRow: true };

    row.querySelector('[data-action="edit"]').click();
    await wait(200);
    const editor = rowOf('DB_PASSWORD');
    const result = {
      draft: editor.querySelector('.value-input')?.value ?? null,
      placeholder: editor.querySelector('.value-input')?.placeholder ?? '',
      saveDisabled: editor.querySelector('[data-action="save"]')?.disabled ?? null,
      bodyHasPassword: document.body.innerText.includes('pa#ss word')
    };
    editor.querySelector('[data-action="cancel"]').click();
    await wait(150);
    return result;
  })()`, true)

  check(
    '🔴 敏感项的编辑框默认是空的（盲写），原值没被带到屏幕上',
    blind.draft === '' && blind.bodyHasPassword === false,
    blind.missingRow ? '找不到 DB_PASSWORD 行' : `草稿=${JSON.stringify(blind.draft)} 页面含明文=${blind.bodyHasPassword}`
  )
  check(
    '空的编辑框不能保存（空值不等于"清空"）',
    blind.saveDisabled === true,
    `disabled=${blind.saveDisabled} placeholder=${blind.placeholder}`
  )

  // 来源文件对不上时不给编辑入口：写下去等于替用户选了 §6.4 的方向。
  // .env.staging 已经从磁盘上消失，它的变量就是这种情况。
  const blocked = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.config-table tbody tr')]
      .find(tr => tr.querySelector('.key-name')?.textContent.trim() === 'STAGE');
    if (!row) return { missingRow: true };
    return {
      editDisabled: row.querySelector('[data-action="edit"]').disabled,
      deleteDisabled: row.querySelector('[data-action="delete"]').disabled,
      hint: row.querySelector('[data-action="edit"]').title
    };
  })()`)

  check(
    '🔴 来源文件与记录不一致时，编辑和删除都点不动',
    blocked.editDisabled === true && blocked.deleteDisabled === true,
    blocked.missingRow ? '找不到 STAGE 行' : `编辑=${blocked.editDisabled} 删除=${blocked.deleteDisabled}`
  )
  check(
    '禁用时说明了为什么，而不是默默不响应',
    typeof blocked.hint === 'string' && blocked.hint.length > 0,
    blocked.hint ?? ''
  )

  // 删除：确认框 → 表格里的行消失 → 文件里的那一行也消失。
  //
  // 到这一步 BRAND_NEW 已经被上面那段提取成凭据并绑定了，所以这里顺带验到
  // 「删掉一个归凭据管的变量」这条路：删除是允许的（变量真的要没了），
  // 绑定会跟着一起解除。它的值是刚刚同步下去的那把 Key，
  // 正好用来确认确认框不会把被删变量的值铺出来。
  const BRAND_NEW_SECRET = ROTATED_UI_KEY
  const deletion = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const rowOf = (key) => [...document.querySelectorAll('.config-table tbody tr')]
      .find(tr => tr.querySelector('.key-name')?.textContent.trim() === key);
    const row = rowOf('BRAND_NEW');
    if (!row) return { missingRow: true };

    row.querySelector('[data-action="delete"]').click();
    for (let i = 0; i < 40; i++) {
      await wait(100);
      if (document.querySelector('.modal-layer')) break;
    }
    await wait(200);
    const title = document.querySelector('#modal-title')?.textContent ?? '';
    const modalText = document.querySelector('.modal-body')?.innerText ?? '';
    const confirmLabel = [...document.querySelectorAll('.modal-actions button')]
      .map(b => b.textContent.trim());

    document.querySelector('.modal-actions .danger-btn').click();
    for (let i = 0; i < 40; i++) {
      await wait(150);
      if (!document.querySelector('.modal-layer') && !rowOf('BRAND_NEW')) break;
    }
    return {
      title,
      confirmLabel,
      modalHadSecret: modalText.includes(${JSON.stringify(BRAND_NEW_SECRET)}),
      closed: !document.querySelector('.modal-layer'),
      rowGone: !rowOf('BRAND_NEW')
    };
  })()`, true)

  check(
    '删除前先弹确认框，且说明会动哪个文件',
    deletion.title === '删除 BRAND_NEW',
    deletion.missingRow ? '找不到 BRAND_NEW 行' : deletion.title
  )
  check(
    '确认按钮文案直说会发生什么',
    Array.isArray(deletion.confirmLabel) &&
      deletion.confirmLabel.some((label) => label.includes('删除变量并改写文件')),
    (deletion.confirmLabel ?? []).join(' / ')
  )
  check(
    '🔴 删除确认框里不显示被删变量的值',
    deletion.modalHadSecret === false,
    `含明文=${deletion.modalHadSecret}`
  )
  check(
    '确认后弹窗关闭，表格里的行消失',
    deletion.closed === true && deletion.rowGone === true,
    `closed=${deletion.closed} 行已移除=${deletion.rowGone}`
  )
  check(
    '🔴 删除同时从磁盘文件里移除了那一行',
    !readFileSync(fixtureEnv, 'utf8').includes('BRAND_NEW'),
    readFileSync(fixtureEnv, 'utf8').split('\n').filter(Boolean).join(' | ')
  )
  check(
    '删除没有波及文件里的其它行',
    ['# 共享配置', 'APP_NAME=envvault-fixture', 'PORT=5000', 'ENABLE_CACHE=true'].every((line) =>
      readFileSync(fixtureEnv, 'utf8').includes(line)
    ),
    '注释与其余变量都在'
  )

  // --- 安全检查页是真的（阶段 4a）-------------------------------------------
  //
  // 这一页现在会起 git 子进程去问跟踪状态。样例项目是个真仓库
  // （verify-core 的 buildGitFixture 建的），所以这里验的是完整那条链：
  // 界面 → IPC → 起 git → 判定 → 渲染。
  const securityPage = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    [...document.querySelectorAll('.nav button')].find(b => b.textContent.includes('安全检查')).click();
    for (let i = 0; i < 60; i++) {
      await wait(100);
      if (document.querySelector('[data-risk]')) break;
    }
    const rows = [...document.querySelectorAll('[data-risk]')].map(el => ({
      path: el.getAttribute('data-path'),
      level: el.getAttribute('data-risk'),
      text: el.innerText
    }));
    return {
      rows,
      // 最危险的必须排最前 —— 用户不该需要往下翻才看到高危项。
      firstLevel: rows[0]?.level ?? '',
      bodyText: document.body.innerText,
      bodyHasSecret: document.body.innerText.includes(${JSON.stringify(FIXTURE_SECRET)})
    };
  })()`, true)

  const leakedRow = securityPage.rows.find((row) => row.path === '.env.local')

  check(
    '安全检查页列出了真实的风险条目',
    securityPage.rows.length >= 4,
    securityPage.rows.map((r) => `${r.path}(${r.level})`).join(' / ') || '（一条都没有）'
  )
  check(
    '🔴 已提交又补进 .gitignore 的文件被标成高危',
    leakedRow?.level === 'critical',
    `${leakedRow?.path}=${leakedRow?.level}`
  )
  check(
    '🔴 并且在界面上直说了忽略规则对已跟踪的文件无效',
    (leakedRow?.text ?? '').includes('忽略规则对已跟踪的文件无效'),
    (leakedRow?.text ?? '').split('\n').find((line) => line.includes('忽略规则')) ?? '（没有这句话）'
  )
  check(
    '🔴 处置办法给到了具体命令',
    (leakedRow?.text ?? '').includes('git rm --cached'),
    (leakedRow?.text ?? '').includes('git rm --cached') ? '给了 git rm --cached' : '（没有给命令）'
  )
  check(
    '高危项排在最前面，不用往下翻',
    securityPage.firstLevel === 'critical',
    `第一条=${securityPage.firstLevel}`
  )
  check(
    '🔴 不再声称 Git 检查"属于阶段 4"',
    !securityPage.bodyText.includes('阶段 4'),
    securityPage.bodyText.includes('阶段 4') ? '页面上还留着过期说明' : '过期说明已清掉'
  )
  check(
    '🔴 安全检查页面不含任何明文值',
    securityPage.bodyHasSecret === false,
    `包含明文=${securityPage.bodyHasSecret}`
  )

  await capture(SECURITY_SHOT)

  // --- 操作记录是真的 -------------------------------------------------------
  const activity = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    [...document.querySelectorAll('.nav button')].find(b => b.textContent.includes('操作记录')).click();
    for (let i = 0; i < 30; i++) {
      await wait(100);
      if (document.querySelectorAll('.activity-item').length > 0) break;
    }
    return {
      count: document.querySelectorAll('.activity-item').length,
      labels: [...document.querySelectorAll('.activity-copy strong')].map(el => el.textContent.trim()),
      bodyHasSecret: document.body.innerText.includes(${JSON.stringify(FIXTURE_SECRET)})
    };
  })()`, true)

  check('操作记录有真实条目', activity.count > 0, `${activity.count} 条`)
  check(
    '记录包含导入、扫描、显示、编辑与删除动作',
    ['导入项目', '重新扫描', '显示敏感值', '编辑变量', '删除变量'].every((label) =>
      activity.labels.includes(label)
    ),
    [...new Set(activity.labels)].join('、')
  )
  check(
    '🔴 那次向厂商验证在操作记录里留了痕（出站请求必须可审计）',
    activity.labels.includes('向厂商验证'),
    [...new Set(activity.labels)].filter((l) => l.includes('验证') || l.includes('凭据')).join('、') ||
      '（记录里找不到验证动作）'
  )
  check(
    '记录里的动作都是中文，没漏掉哪一类而露出原始标识',
    activity.labels.every((label) => !label.includes('.')),
    activity.labels.filter((label) => label.includes('.')).join('、') || '全部有中文标签'
  )
  check(
    '🔴 操作记录页面不含任何明文值（§5.5）',
    activity.bodyHasSecret === false,
    `包含明文=${activity.bodyHasSecret}`
  )

  await capture(ACTIVITY_SHOT)

  // --- 窗口级零滚动条 -------------------------------------------------------
  // 把视口压矮，逼出内容溢出。原来靠"内容本来就比视口高"来验，
  // 那会随样例数据多少而时灵时不灵 —— 一条断言只在数据够多时才有意义，
  // 等于在数据变少时静默失效。
  // 高度取 620 —— 就是 BrowserWindow 的 minHeight。再矮就低于布局的设计下界了，
  // 那种尺寸下的溢出属于人为制造，验出来也不代表真实场景。
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1360,
    height: 620,
    deviceScaleFactor: 1,
    mobile: false
  })

  const scroll = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    [...document.querySelectorAll('.nav button')].find(b => b.textContent.includes('配置总览')).click();
    await wait(300);
    const root = document.documentElement;
    const pane = document.querySelector('.main-scroll');
    const topbar = document.querySelector('.topbar');
    const before = topbar.getBoundingClientRect().top;
    pane.scrollTop = pane.scrollHeight;
    return {
      docOverflowsY: root.scrollHeight > root.clientHeight,
      docOverflowsX: root.scrollWidth > root.clientWidth,
      windowScrollbar: window.innerWidth - root.clientWidth,
      paneScrolls: pane.scrollHeight > pane.clientHeight,
      paneScrolled: pane.scrollTop > 0,
      topbarMoved: topbar.getBoundingClientRect().top !== before,
      shellHeight: Math.round(document.querySelector('.app-shell').getBoundingClientRect().height),
      viewport: window.innerHeight
    };
  })()`, true)

  check(
    '没有文档级滚动条',
    scroll.docOverflowsY === false && scroll.docOverflowsX === false && scroll.windowScrollbar === 0,
    `纵向溢出=${scroll.docOverflowsY} 横向溢出=${scroll.docOverflowsX} 滚动条宽=${scroll.windowScrollbar}px`
  )
  check('外壳高度正好等于视口', scroll.shellHeight === scroll.viewport, `shell=${scroll.shellHeight}px viewport=${scroll.viewport}px`)
  check('滚动发生在内容区内部', scroll.paneScrolls === true && scroll.paneScrolled === true, `可滚=${scroll.paneScrolls} 已滚动=${scroll.paneScrolled}`)
  check('滚动时顶栏保持不动', scroll.topbarMoved === false, `位移=${scroll.topbarMoved}`)

  await send('Emulation.clearDeviceMetricsOverride')

  // --- 弹窗 -----------------------------------------------------------------
  const modal = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('.top-actions .primary-btn').click();
    await wait(200);
    const opened = document.querySelector('#modal-title')?.textContent ?? '';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(200);
    return { opened, closed: !document.querySelector('.modal-layer') };
  })()`, true)

  check('添加项目弹窗可以打开', modal.opened === '添加一个项目', modal.opened)
  check('Esc 关闭弹窗且节点从 DOM 移除', modal.closed === true, `closed=${modal.closed}`)

  // 「处理差异」列的是真实的待处理文件，并如实说明已丢失的那个无从对比 ——
  // 这里曾经是一句「将在阶段 2 接入」，阶段 2 做完之后它就成了假话。
  const pendingDiff = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    [...document.querySelectorAll('.head-actions button')]
      .find(b => b.textContent.includes('处理差异'))?.click();
    await wait(300);
    const rows = [...document.querySelectorAll('.diff-row')].map(el => ({
      path: el.querySelector('.diff-key')?.textContent.trim() ?? '',
      detail: el.querySelector('.diff-value')?.textContent.trim() ?? '',
      hasDiffButton: !!el.querySelector('button')
    }));
    const title = document.querySelector('#modal-title')?.textContent ?? '';
    const bodyText = document.querySelector('.modal-body')?.innerText ?? '';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(200);
    return { title, rows, mentionsFuturePhase: bodyText.includes('阶段 2') };
  })()`, true)

  check(
    '「处理差异」列出真实的待处理文件',
    pendingDiff.title === '待处理的文件差异' &&
      pendingDiff.rows.length === 1 &&
      pendingDiff.rows[0]?.path === '.env.staging',
    `${pendingDiff.title}：${pendingDiff.rows.map((r) => r.path).join(', ') || '（空）'}`
  )
  check(
    '已从磁盘消失的文件不给「查看差异」按钮（点开只会报错）',
    pendingDiff.rows[0]?.hasDiffButton === false && pendingDiff.rows[0]?.detail.includes('无从对比'),
    pendingDiff.rows[0]?.detail ?? ''
  )
  check(
    '不再声称这个功能"将在阶段 2 接入"',
    pendingDiff.mentionsFuturePhase === false,
    `含过期说明=${pendingDiff.mentionsFuturePhase}`
  )

  check(
    '已截图供目视复核',
    existsSync(OVERVIEW_SHOT) &&
      existsSync(ACTIVITY_SHOT) &&
      existsSync(CREDENTIALS_SHOT) &&
      existsSync(SECURITY_SHOT),
    `${OVERVIEW_SHOT} / ${ACTIVITY_SHOT} / ${CREDENTIALS_SHOT} / ${SECURITY_SHOT}`
  )

  // pageErrors 由 CDP 的 Log / Runtime 事件填充，不是页面里自报的变量 ——
  // 自报变量在没人写入时永远是空数组，那样的断言不可能失败，也就没有意义。
  check(
    '页面无控制台错误与未捕获异常',
    pageErrors.length === 0,
    pageErrors.length === 0 ? '无' : pageErrors.join(' | ')
  )
}

// ---------------------------------------------------------------------------
// CDP 客户端
// ---------------------------------------------------------------------------

async function waitForPageTarget() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 调试端口还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('等待渲染进程调试端口超时')
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.addEventListener('open', () => resolve(socket))
    socket.addEventListener('error', () => reject(new Error('CDP 连接失败')))
    socket.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)

      // 无 id 的都是事件。只收 error 级别，warning 会把 React 的开发提示也算进来。
      if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
        pageErrors.push(`console: ${msg.params.entry.text}`)
        return
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const details = msg.params?.exceptionDetails
        pageErrors.push(`exception: ${details?.exception?.description ?? details?.text ?? '未知'}`)
        return
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
        pageErrors.push(`console.error: ${text}`)
        return
      }

      const resolver = pending.get(msg.id)
      if (!resolver) return
      pending.delete(msg.id)
      resolver(msg)
    })
  })
}

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function capture(path) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(path, Buffer.from(shot.data, 'base64'))
}

async function evaluate(expression, awaitPromise = false) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true
  })
  if (result.exceptionDetails) {
    throw new Error(`页面内异常: ${result.exceptionDetails.exception?.description ?? '未知'}`)
  }
  return result.result.value
}

/** 等 React 首屏挂载完成，而不是固定 sleep。 */
async function waitForRender() {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const ready = await evaluate(`!!document.querySelector('.vault-action') && !!document.querySelector('.config-table')`)
    if (ready) {
      // 首屏之后还有一次 IPC 回填（项目列表 + 文件），再等它稳定。
      await evaluate(`new Promise(r => setTimeout(r, 400))`, true)
      return
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('渲染进程首屏超时')
}
