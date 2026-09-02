/**
 * 真正发包的那一层 —— 全应用**唯一**产生出站流量的地方。
 *
 * 单独一个文件、单独一个目录，是为了让「谁会上网」这个问题有一个一句话的答案。
 * 它没有放进 `src/main/providers/`：那个目录必须能被 `node --test` 直接跑，
 * 而这里 import 了 `electron`。
 *
 * ## 为什么用 `net.fetch` 而不是 Node 的全局 `fetch`
 *
 * `net.fetch` 走 Chromium 的网络栈，因此认**系统代理设置和企业根证书**。
 * Node 的 undici 两样都不认 —— 桌面工具的用户坐在公司代理后面是常态，
 * 用全局 fetch 的表现是「在开发机上好好的，到用户那儿一律连不上」。
 *
 * ## 🔴 三处刻意的收紧
 *
 * 1. **不跟随重定向**（`redirect: 'error'`）。fetch 规范只在跨源重定向时剥掉
 *    `Authorization`，而 Anthropic 用的是 `x-api-key`、Gemini 用的是
 *    `x-goog-api-key` —— **自定义头不在剥离名单里**。也就是说，一个配错的
 *    或被劫持的调用地址只要回一个 302，就能把完整的 Key 收到任意主机去。
 *    调用地址是用户填的（自定义厂商可以填任何 URL），所以这条必须堵死。
 *    代价是遇到正经的 301（比如 http→https）也会失败，报「连不上」——
 *    换来的是 Key 不会跟着跳转跑掉，这笔交易不用犹豫。
 * 2. **不带 cookie**（`credentials: 'omit'`）。这是一次 API 调用，
 *    没有任何理由把应用 session 里的 cookie 附上去。
 * 3. **不读响应体**。状态码足以得出结论，把厂商的响应体读进来只会平白多一份
 *    可能被打印、被塞进错误消息的数据。拿到状态码就把 body 取消掉，释放连接。
 */

import { net } from 'electron'
import type { TransportResponse, ValidationTransport } from '../providers/validate.ts'
import type { ValidationRequest } from '../providers/index.ts'

/**
 * 🔴 验收脚本用的硬拦：设了这个环境变量就一律拒发。
 *
 * 「验收脚本记得注入假传输」是一条**靠自觉**的规矩，而它一旦被忘记，
 * 后果是把测试用的 Key 发到真实厂商去 —— 并且不会有任何报错，
 * 测试照样绿。所以在真传输这一侧再加一道够不着就报错的拦，
 * 让「忘了注入」变成一次响亮的失败而不是一次静默的出站请求。
 *
 * `scripts/verify-core.ts` 在开头就设上它，`scripts/verify-ui.mjs` 给
 * 它拉起的 Electron 进程也带上。正常运行的应用里没有这个变量。
 */
export const BLOCK_NETWORK_ENV = 'ENVVAULT_BLOCK_NETWORK'

export function isNetworkBlocked(): boolean {
  return process.env[BLOCK_NETWORK_ENV] === '1'
}

export const electronTransport: ValidationTransport = async (
  request: ValidationRequest,
  signal: AbortSignal
): Promise<TransportResponse> => {
  if (isNetworkBlocked()) {
    throw new Error(`${BLOCK_NETWORK_ENV}=1：这个进程禁止出站请求（验收环境忘了注入假传输？）`)
  }

  const response = await net.fetch(request.url, {
    method: request.method,
    headers: request.headers,
    redirect: 'error',
    credentials: 'omit',
    signal
  })

  // 只要状态码，body 立刻丢掉。cancel 本身失败无所谓 —— 结论已经拿到了。
  try {
    await response.body?.cancel()
  } catch {
    /* 连接释放失败不影响结论 */
  }

  return { status: response.status }
}
