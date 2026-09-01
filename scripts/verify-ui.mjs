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
    stdio: ['ignore', 'pipe', 'pipe']
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
    isolation.bridgeType === 'object' && isolation.bridgeKeys.length === 20,
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
    'OPENAI_API_KEY', 'PORT', 'SNEAKY', 'STAGE'
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
  check('敏感项默认掩码（§7）', unlocked.maskedCells === 4, `掩码单元格=${unlocked.maskedCells}`)
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
    row.querySelector('.mini-btn').click();
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
    '记录包含导入、扫描与显示动作',
    ['导入项目', '重新扫描', '显示敏感值'].every((label) => activity.labels.includes(label)),
    [...new Set(activity.labels)].join('、')
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

  check('已截图供目视复核', existsSync(OVERVIEW_SHOT) && existsSync(ACTIVITY_SHOT), `${OVERVIEW_SHOT} / ${ACTIVITY_SHOT}`)

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
