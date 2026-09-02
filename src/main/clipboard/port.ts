/**
 * 真正碰系统剪贴板的适配器。**全应用唯一 import Electron `clipboard` 的地方。**
 *
 * 单独一个文件的理由和 `net/transport.ts`、`git/run.ts` 一样：
 * 让「谁会碰系统剪贴板」有一个一句话的答案，顺带让同目录的判定逻辑
 * 保持能被 `node --test` 直接跑。
 */

import { clipboard } from 'electron'
import type { ClipboardPort } from './index.ts'

/**
 * ⚠️ Electron 44 的剪贴板 API 全是异步的，没有同步版本。
 * 这一点决定了退出时的清理必须把 `before-quit` 拦一下才来得及跑完
 * （见 `main/index.ts`）。
 */
export const electronClipboard: ClipboardPort = {
  writeText: (text) => clipboard.writeText(text),
  readText: () => clipboard.readText(),
  // Electron 的 clear() 会清掉所有格式（文本、HTML、图片）。
  // 我们只写过文本，但一并清干净是对的：某些应用会同时收下
  // text/plain 和 text/html 两份，只清一份等于没清。
  clear: async () => clipboard.clear()
}
