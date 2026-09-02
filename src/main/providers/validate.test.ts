/**
 * 验证执行层的契约测试。
 *
 * 这里钉住的是三件事：
 *   1. **状态码怎么翻译成结论**，尤其是「哪些不算数」—— 这一层的价值全在
 *      「网络不通不等于 Key 是坏的」上，正常路径反而是最不容易写错的；
 *   2. **超时和连不上是两种结论**，用户要采取的行动不一样；
 *   3. 🔴 **Key 不会出现在报告的任何字段里**。
 *
 * 全程用假传输，一个字节都不出网。
 *
 * 跑法：node --test src/main/providers/*.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getProvider } from './index.ts'
import type { ValidationRequest } from './index.ts'
import {
  DEFAULT_TIMEOUT_MS,
  classifyStatus,
  describeOutcome,
  isConclusive,
  runValidation
} from './validate.ts'
import type { ValidationTransport } from './validate.ts'

const FAKE_KEY = 'sk-proj-DO-NOT-SEND-abcdefghijklmnopqrstuvwxyz'

/** 固定回一个状态码的假传输。 */
function respondWith(status: number): ValidationTransport {
  return async () => ({ status })
}

/** OpenAI 适配器描述出来的一个真实请求（请求头里带着 FAKE_KEY）。 */
function sampleRequest(): ValidationRequest {
  return getProvider('openai')!.describeValidation('https://api.openai.com/v1', FAKE_KEY)
}

// ---------------------------------------------------------------------------
// 状态码 → 结论
// ---------------------------------------------------------------------------

test('2xx 一律算通过', () => {
  for (const status of [200, 201, 204, 299]) {
    assert.equal(classifyStatus(status), 'valid', `HTTP ${status}`)
  }
})

test('只有 401 和 403 算「厂商拒绝了这把 Key」', () => {
  assert.equal(classifyStatus(401), 'invalid')
  assert.equal(classifyStatus(403), 'invalid')
})

test('🔴 400 不算 Key 有问题 —— 它也可能是我们自己把请求拼错了', () => {
  // 把 400 判成 invalid，就会因为本应用的 bug 去给用户的 Key 定罪。
  assert.equal(classifyStatus(400), 'provider-error')
  assert.equal(isConclusive(classifyStatus(400)), false)
})

test('404 单独一类：地址填错了，和 Key 无关', () => {
  assert.equal(classifyStatus(404), 'endpoint-error')
})

test('429 是限流，5xx 是厂商的事，都不是结论', () => {
  assert.equal(classifyStatus(429), 'rate-limited')
  for (const status of [500, 502, 503, 504]) {
    assert.equal(classifyStatus(status), 'provider-error', `HTTP ${status}`)
  }
})

// ---------------------------------------------------------------------------
// 🔴 有结论 / 没结论
// ---------------------------------------------------------------------------

test('🔴 只有 valid 和 invalid 是结论，其余五个都不是', () => {
  assert.equal(isConclusive('valid'), true)
  assert.equal(isConclusive('invalid'), true)

  // 这五个都是「这次没问出答案」。允许它们改状态，
  // 用户离线点一次验证就会把所有凭据标成失效。
  for (const outcome of [
    'endpoint-error',
    'rate-limited',
    'provider-error',
    'unreachable',
    'timeout'
  ] as const) {
    assert.equal(isConclusive(outcome), false, outcome)
  }
})

test('没结论的几条都得说明「这不代表 Key 有问题」', () => {
  // 用户看到红字第一反应是「我的 Key 废了」，这几条必须把话说清楚。
  assert.match(describeOutcome('endpoint-error', 404), /不代表 Key 有问题/)
  for (const outcome of ['rate-limited', 'provider-error', 'unreachable', 'timeout'] as const) {
    assert.match(describeOutcome(outcome, 500), /没验出结论/, outcome)
  }
})

// ---------------------------------------------------------------------------
// runValidation
// ---------------------------------------------------------------------------

test('把适配器描述的请求原样交给传输层', async () => {
  const seen: ValidationRequest[] = []
  const transport: ValidationTransport = async (request) => {
    seen.push(request)
    return { status: 200 }
  }

  const request = sampleRequest()
  const report = await runValidation(request, transport)

  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], request)
  assert.equal(report.outcome, 'valid')
  assert.equal(report.httpStatus, 200)
})

test('传输层抛异常 → unreachable，不往外抛', async () => {
  const transport: ValidationTransport = async () => {
    throw new Error(`getaddrinfo ENOTFOUND api.openai.com（并且这里混进了 ${FAKE_KEY}）`)
  }

  const report = await runValidation(sampleRequest(), transport)
  assert.equal(report.outcome, 'unreachable')
  assert.equal(report.httpStatus, null)
  // 原始异常的 message 一个字都不能进报告 —— 这里故意把 Key 塞进了异常里。
  assert.equal(report.message.includes(FAKE_KEY), false)
  assert.equal(report.message.includes('ENOTFOUND'), false)
})

test('超时 → timeout，而且和「连不上」分得开', async () => {
  // 传输层老老实实等 abort 信号，模拟一个不响应的服务端。
  const transport: ValidationTransport = (_request, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    })

  const report = await runValidation(sampleRequest(), transport, 20)
  assert.equal(report.outcome, 'timeout')
  assert.equal(report.httpStatus, null)
})

test('拿到响应就不该再被超时打断', async () => {
  // 定时器没清干净的话，这个 20ms 的超时会在下一轮事件循环里
  // 把一个已经完成的请求 abort 掉。这条守的是 finally 里的 clearTimeout。
  const report = await runValidation(sampleRequest(), respondWith(200), 20)
  assert.equal(report.outcome, 'valid')
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(report.outcome, 'valid')
})

test('默认超时是 10 秒，不是无限等', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 10_000)
})

// ---------------------------------------------------------------------------
// 🔴 Key 不进报告
// ---------------------------------------------------------------------------

test('🔴 无论走哪条分支，报告里都搜不到 Key', async () => {
  const branches: [string, ValidationTransport][] = [
    ['200', respondWith(200)],
    ['401', respondWith(401)],
    ['404', respondWith(404)],
    ['429', respondWith(429)],
    ['500', respondWith(500)],
    [
      'throw',
      async () => {
        throw new Error(FAKE_KEY)
      }
    ]
  ]

  for (const [label, transport] of branches) {
    const report = await runValidation(sampleRequest(), transport)
    // 整个报告序列化之后再搜，避免将来加字段时漏掉新的那个。
    assert.equal(JSON.stringify(report).includes(FAKE_KEY), false, `分支 ${label} 泄漏了 Key`)
  }
})

test('🔴 请求头里确实带着 Key —— 上一条才有意义', () => {
  // 没有这条，「报告里搜不到 Key」可能只是因为 Key 压根没进过这条链路。
  const request = sampleRequest()
  assert.equal(JSON.stringify(request.headers).includes(FAKE_KEY), true)
})
