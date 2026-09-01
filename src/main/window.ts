/**
 * 主窗口创建与导航封锁。
 *
 * 安全基线对应开发计划 §3.2：
 *   nodeIntegration: false / contextIsolation: true / sandbox: true
 *   渲染进程拿不到 Node，也拿不到文件系统，只能通过 Preload 白名单里的通道说话。
 *
 * 🔴 `sandbox: true` 要求 Preload 是 CommonJS，所以构建配置把 preload 单独输出成
 * `index.cjs`（见 electron.vite.config.ts）。这里的扩展名不能顺手改回 `.js`/`.mjs`。
 */

import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'

const DEV_SERVER_URL = process.env['ELECTRON_RENDERER_URL']

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#f6f6f3',
    autoHideMenuBar: true,
    title: 'EnvVault',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      // 渲染进程不需要拿到 <webview>，关掉少一个攻击面。
      webviewTag: false,
      spellcheck: false
    }
  })

  // 先隐藏、渲染好再显示，避免启动时先闪一帧空白窗口。
  win.once('ready-to-show', () => win.show())

  lockDownNavigation(win)

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  return win
}

/**
 * 应用是本地工具，不加载任何远程页面（§3.2）。
 * 一切站内跳转都由渲染层自己的路由完成，所以这里可以一刀切：
 * 任何真正的导航请求都拦下，外链交给系统浏览器。
 */
function lockDownNavigation(win: BrowserWindow): void {
  const allowedOrigin = DEV_SERVER_URL ? new URL(DEV_SERVER_URL).origin : null

  win.webContents.on('will-navigate', (event, url) => {
    const isDevReload = allowedOrigin !== null && new URL(url).origin === allowedOrigin
    if (isDevReload) return
    event.preventDefault()
    openExternally(url)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url)
    return { action: 'deny' }
  })

  // 附着新的 webContents（例如意外创建的 webview）一律拒绝挂 Node。
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())
}

function openExternally(url: string): void {
  // 只放行 http/https，避免把 file:// 或自定义协议交给系统去执行。
  if (url.startsWith('http://') || url.startsWith('https://')) {
    void shell.openExternal(url)
  }
}
