/**
 * 主进程入口。
 *
 * 启动顺序是有讲究的：
 *   单实例锁 → app ready → CSP → 数据库（建库 + 迁移）→ IPC → 开窗
 *
 * 数据库排在开窗之前，是为了让「迁移失败」变成一个能看见的启动错误对话框，
 * 而不是窗口已经开好、用户点了几下才发现每个操作都在报 DATABASE_ERROR。
 *
 * Vault 刻意不自动解锁：解锁是用户可见的状态变化，界面上有明确的入口。
 * 自动解锁会让「锁定」这个功能在启动路径上永远走不到，也就永远测不到。
 */

import { app, BrowserWindow, dialog, session } from 'electron'
import { clearOnExit, hasPending } from './clipboard/index.ts'
import { electronClipboard } from './clipboard/port'
import { closeDatabase, initializeDatabase } from './db'
import { registerIpcHandlers } from './ipc'
import * as vault from './security/vault'
import { startWatching, stopWatching } from './watch-service'
import { createMainWindow } from './window'

const isDev = !app.isPackaged

// 单实例：多开会有两个主进程同时写同一个 SQLite 文件和同一个 vault.key。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  void app.whenReady().then(onReady)
}

async function onReady(): Promise<void> {
  applyContentSecurityPolicy()
  denyAllPermissionRequests()

  try {
    initializeDatabase()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('EnvVault 无法启动', `本地数据库初始化失败：\n${message}`)
    app.quit()
    return
  }

  registerIpcHandlers()
  createMainWindow()

  // 监听放在开窗之后：它只影响"能不能自动收到提醒"，
  // 起不来最多退化成手动点「重新扫描」，不该拖慢启动，更不该挡住窗口。
  void startWatching()

  app.on('activate', () => {
    // macOS：点 Dock 图标且没有窗口时重新开一个。
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
}

/**
 * CSP 用响应头下发，而不是只写在 HTML 的 <meta> 里 ——
 * meta 版本对 `file://` 之外的加载路径覆盖不全，而开发模式走的是 http://localhost。
 *
 * 生产策略里没有 'unsafe-inline'：渲染层的样式全部走打包出来的 CSS 文件，
 * 动态颜色用 CSS 变量而不是内联 style 字符串，就是为了让这条能收紧。
 */
function applyContentSecurityPolicy(): void {
  const policy = isDev
    ? [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // Vite HMR 注入
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'"
      ]
    : [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'none'", // 本地工具，渲染层不该发起任何网络请求
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'"
      ]

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy.join('; ')]
      }
    })
  })
}

/**
 * 本地配置工具不需要摄像头、麦克风、定位、通知里的任何一个。
 * 默认全部拒绝，将来真要用哪个再逐个开口子。
 */
function denyAllPermissionRequests(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * 🔴 退出前把剪贴板里的 Key 清掉。
 *
 * 定时器随进程一起死，而剪贴板里的 Key 不会 —— 用户复制完 5 秒就关掉应用的话，
 * 那把 Key 会一直留在系统剪贴板里。
 *
 * ⚠️ 这里必须**拦一下退出**：Electron 44 的剪贴板 API 全是异步的，而
 * `before-quit` 不会等 Promise —— 直接 fire-and-forget 的话进程先没了，
 * 清理根本来不及跑，等于写了一个不生效的安全措施。
 *
 * 两道保险，避免"清不掉剪贴板"变成"应用退不出去"：
 *   1. 只有真有待清理的东西时才拦（`hasPending()`）；
 *   2. 最多等 300ms —— 清剪贴板重要，但没重要到值得让用户面对一个卡住的窗口。
 * 标志位在发起异步之前就置上，所以第二次 `before-quit` 直接放行。
 */
let clipboardSettled = false

app.on('before-quit', (event) => {
  if (hasPending() && !clipboardSettled) {
    clipboardSettled = true
    event.preventDefault()
    void Promise.race([
      clearOnExit(electronClipboard),
      new Promise((resolve) => setTimeout(resolve, 300))
    ]).finally(() => app.quit())
    return
  }

  // 退出前停掉监听、清零内存里的主密钥，并让 WAL 正常检查点回主库文件。
  void stopWatching()
  vault.lock()
  closeDatabase()
})
