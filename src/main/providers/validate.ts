/**
 * 验证请求的**执行**层（开发计划 §7、§8）。
 *
 * `index.ts` 只描述一次请求该打哪、带什么头；这一层负责把它发出去、
 * 把响应翻译成一个结论。真正接触 socket 的是注入进来的 `transport` ——
 * 这一层自己不认识 `electron`、也不认识 `node:http`，所以 `node --test` 跑得动，
 * 而验收脚本可以塞一个假传输进来，跑遍全部分支且不产生任何出站流量。
 *
 * ## 🔴 三条规矩
 *
 * 1. **仅在用户显式点「验证」时才会走到这里**（计划 §7）。
 *    没有定时重试、没有启动探活、没有「顺手验一下」。这条由调用方保证，
 *    这一层不提供任何自动触发的入口。
 * 2. **只打元数据接口**（`/models` 这类），不打推理接口 ——
 *    §7「验证请求使用厂商元数据接口，避免无意产生推理费用」。地址由适配器给。
 * 3. **永不抛异常，也永不碰原始异常对象。** 见 `runValidation` 里的说明。
 *
 * ## 目录约定
 *
 * 和 `src/main/env/` 一样：import 必须带 `.ts` 后缀、不能用 `@shared/*` 别名，
 * 也不能用构造函数参数属性 —— 这些模块要能被 `node --test` 直接跑。
 */

import type { ValidationOutcome } from '../../shared/provider-types.ts'
import type { ValidationRequest } from './index.ts'

/** 默认超时。挂死的请求会让界面上那颗按钮一直转，必须有个头。 */
export const DEFAULT_TIMEOUT_MS = 10_000

/**
 * 传输层只需要回一个状态码。
 *
 * 🔴 刻意**不**包含响应体：状态码足以得出结论，而把厂商的响应体读进来
 * 只会平白多一份可能被打印、被塞进错误消息的数据。真传输那一层
 * 拿到状态码后直接把 body 取消掉。
 */
export interface TransportResponse {
  status: number
}

export type ValidationTransport = (
  request: ValidationRequest,
  signal: AbortSignal
) => Promise<TransportResponse>

export interface ValidationReport {
  outcome: ValidationOutcome
  /** 拿到了响应才有；连不上或超时是 null。 */
  httpStatus: number | null
  /**
   * 给人看的一句话。
   * 🔴 由这一层自己构造，绝不来自厂商响应体，也绝不来自原始异常的 message。
   */
  message: string
}

/**
 * 「这次问出答案了吗」。
 *
 * 🔴 只有这两个结论是**关于 Key 的**判断，也只有它们才允许改动凭据状态。
 * 其余五个说的都是「这次没问出来」—— 网络不通、厂商限流、地址填错。
 * 拿它们去改状态，等于用户离线点一次验证就把所有凭据标成失效。
 *
 * 这个条件只写在这里一处。在别处重写一遍 `outcome === 'valid' || ...`
 * 的后果是：将来加一个结论时漏掉其中一处，而且不会有任何报错。
 */
export function isConclusive(outcome: ValidationOutcome): boolean {
  return outcome === 'valid' || outcome === 'invalid'
}

/**
 * 状态码 → 结论。
 *
 * 🔴 只有 401 和 403 会被判成「这把 Key 不行」。400 不算 ——
 * 有的厂商拿 400 回一切它不喜欢的请求，包括我们自己把请求拼错的情况。
 * 把 400 算成 invalid，就会因为我们的 bug 去给用户的 Key 定罪。
 * 拿不准的一律归到「没结论」，这个方向上犯错是安全的。
 */
export function classifyStatus(status: number): ValidationOutcome {
  if (status >= 200 && status < 300) return 'valid'
  if (status === 401 || status === 403) return 'invalid'
  if (status === 404) return 'endpoint-error'
  if (status === 429) return 'rate-limited'
  return 'provider-error'
}

/** 结论 → 给人看的一句话。没结论的几条都要说清楚「这不代表 Key 有问题」。 */
export function describeOutcome(
  outcome: ValidationOutcome,
  httpStatus: number | null,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): string {
  switch (outcome) {
    case 'valid':
      return '验证通过，厂商认这把 Key。'
    case 'invalid':
      return `厂商明确拒绝了这把 Key（HTTP ${httpStatus}）。`
    case 'endpoint-error':
      return `调用地址上没有这个接口（HTTP ${httpStatus}），多半是地址填错了 —— 这不代表 Key 有问题。`
    case 'rate-limited':
      return `厂商限流（HTTP ${httpStatus}），这次没验出结论，过一会儿再试。`
    case 'provider-error':
      return `厂商返回 HTTP ${httpStatus}，这次没验出结论。`
    case 'unreachable':
      return '连不上厂商（网络、代理或证书），这次没验出结论。'
    case 'timeout':
      return `等了 ${Math.round(timeoutMs / 1000)} 秒没有响应，这次没验出结论。`
  }
}

/**
 * 发一次验证请求，把结果翻译成结论。
 *
 * 🔴 **这个函数永远不抛异常，也永远不读原始异常对象。**
 *
 * 原因在 `src/main/ipc/index.ts`：那里的 `toFailure` 对没认出来的异常会走
 * `console.error('[ipc] 未处理的异常', error)`。那是全应用唯一一处会把原始异常
 * 整个打印出来的地方 —— 而这一层手里的 `request.headers` 装着完整的 Key。
 * 让异常逃出去，就等于把「请求头会不会出现在日志里」这件事托付给
 * 「传输层的 error 对象大概不会带上请求头吧」这个假设。
 *
 * 所以这里 `catch` 连 error 都不绑定：拿不到就不可能不小心传出去。
 * 代价是丢掉了原始的失败原因，换来的是 unreachable / timeout 这两个
 * 足够用户采取行动的区分 —— 这笔交易是划算的。
 */
export async function runValidation(
  request: ValidationRequest,
  transport: ValidationTransport,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<ValidationReport> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    const response = await transport(request, controller.signal)
    const outcome = classifyStatus(response.status)
    return {
      outcome,
      httpStatus: response.status,
      message: describeOutcome(outcome, response.status, timeoutMs)
    }
  } catch {
    // 🔴 故意不绑定 error：见上面的说明。
    const outcome: ValidationOutcome = timedOut ? 'timeout' : 'unreachable'
    return { outcome, httpStatus: null, message: describeOutcome(outcome, null, timeoutMs) }
  } finally {
    clearTimeout(timer)
  }
}
