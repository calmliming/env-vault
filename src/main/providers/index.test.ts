/**
 * 厂商适配器的契约测试。
 *
 * 这里钉住的是两件事：
 *   1. **识别的取舍**：值优先、名字兜底、冲突时两家都报。这条规则的价值全在
 *      边界情况上（`OPENAI_API_KEY` 里放一把 OpenRouter 的 Key），
 *      所以那些用例比"正常情况能认出来"重要得多。
 *   2. **这一层不发请求**：describeValidation 只返回描述。
 *
 * 跑法：node --test src/main/providers/*.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROVIDERS,
  getProvider,
  lastFour,
  matchEndpoint,
  redact,
  suggestProviders
} from './index.ts'

const OPENAI_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz012345'
const ANTHROPIC_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'
const OPENROUTER_KEY = 'sk-or-v1-abcdef0123456789abcdef0123456789'
/** Google 的 Key 是 `AIza` + 35 位，一共 39 —— 少一位就该认不出来。 */
const GEMINI_KEY = 'AIzaSyA01234567890123456789012345678901'
const BARE_SK = 'sk-abcdefghijklmnopqrstuvwxyz0123'

test('首批五家厂商都在，外加自定义厂商', () => {
  const ids = PROVIDERS.map((p) => p.id)
  assert.deepEqual(ids, ['openai', 'anthropic', 'gemini', 'deepseek', 'openrouter', 'custom'])
})

test('每家都给了默认地址（自定义厂商除外，它由用户填）', () => {
  for (const provider of PROVIDERS) {
    if (provider.id === 'custom') {
      assert.equal(provider.defaultEndpoint, '')
      continue
    }
    assert.match(provider.defaultEndpoint, /^https:\/\//, `${provider.id} 的默认地址不对`)
  }
})

// ---------------------------------------------------------------------------
// 识别：值优先
// ---------------------------------------------------------------------------

test('独有形状的 Key 单凭值就能认出来', () => {
  assert.deepEqual(
    suggestProviders('SOME_RANDOM_NAME', ANTHROPIC_KEY).map((s) => [s.providerId, s.basis]),
    [['anthropic', 'value']]
  )
  assert.deepEqual(
    suggestProviders('SOME_RANDOM_NAME', OPENROUTER_KEY).map((s) => [s.providerId, s.basis]),
    [['openrouter', 'value']]
  )
  assert.deepEqual(
    suggestProviders('SOME_RANDOM_NAME', GEMINI_KEY).map((s) => [s.providerId, s.basis]),
    [['gemini', 'value']]
  )
})

test('独有形状压过通用形状：sk-ant- 不会被报成 DeepSeek', () => {
  const ids = suggestProviders('API_KEY', ANTHROPIC_KEY).map((s) => s.providerId)
  assert.deepEqual(ids, ['anthropic'])
  assert.equal(ids.includes('deepseek'), false, 'sk-ant- 同时符合 DeepSeek 的通用 sk- 规则')
})

test('名字和值都指向同一家时依据是 both', () => {
  const [top] = suggestProviders('ANTHROPIC_API_KEY', ANTHROPIC_KEY)
  assert.equal(top?.providerId, 'anthropic')
  assert.equal(top?.basis, 'both')
})

test('🔴 名字和值冲突时两家都报，不替用户猜', () => {
  // 真实项目里非常常见：变量名没改，值换成了别家的 Key。
  const suggestions = suggestProviders('OPENAI_API_KEY', OPENROUTER_KEY)
  const ids = suggestions.map((s) => s.providerId)
  assert.equal(ids.includes('openrouter'), true, '值指向 OpenRouter')
  assert.equal(ids.includes('openai'), true, '名字指向 OpenAI，也要列出来')
  // 值的证据更强，排在前面
  assert.equal(suggestions[0]?.providerId, 'openrouter')
  assert.equal(suggestions[0]?.basis, 'value')
  assert.equal(suggestions[1]?.basis, 'variable-name')
})

test('🔴 裸 sk- 分不出 OpenAI 和 DeepSeek，两家都报', () => {
  const ids = suggestProviders('LLM_KEY', BARE_SK).map((s) => s.providerId)
  assert.deepEqual(ids.sort(), ['deepseek', 'openai'])
})

test('裸 sk- 加上变量名就能定下来，另一家仍然列出', () => {
  const suggestions = suggestProviders('DEEPSEEK_API_KEY', BARE_SK)
  assert.equal(suggestions[0]?.providerId, 'deepseek')
  assert.equal(suggestions[0]?.basis, 'both')
  // OpenAI 仍在候选里 —— 值确实也符合它的形状，隐藏掉就是在替用户下结论
  assert.equal(suggestions.some((s) => s.providerId === 'openai' && s.basis === 'value'), true)
})

test('只有名字命中时依据是 variable-name', () => {
  const suggestions = suggestProviders('GEMINI_API_KEY', 'some-opaque-value-1234567890')
  assert.deepEqual(suggestions.map((s) => [s.providerId, s.basis]), [['gemini', 'variable-name']])
})

test('认不出来就不给建议，不硬套一个自定义厂商', () => {
  assert.deepEqual(suggestProviders('DATABASE_URL', 'postgres://user:pass@host/db'), [])
  assert.deepEqual(suggestProviders('PORT', '3000'), [])
})

test('自定义厂商永远不出现在识别结果里', () => {
  const samples = [OPENAI_KEY, ANTHROPIC_KEY, BARE_SK, 'anything', '']
  for (const value of samples) {
    const ids = suggestProviders('CUSTOM_API_KEY', value).map((s) => s.providerId)
    assert.equal(ids.includes('custom'), false, `${value} 不该建议自定义厂商`)
  }
})

test('值两侧的空白不影响识别', () => {
  assert.equal(suggestProviders('K', `  ${ANTHROPIC_KEY}  `)[0]?.providerId, 'anthropic')
})

// ---------------------------------------------------------------------------
// 地址配对
// ---------------------------------------------------------------------------

test('从地址值认出厂商', () => {
  assert.equal(matchEndpoint('https://api.anthropic.com/v1')?.id, 'anthropic')
  assert.equal(matchEndpoint('https://openrouter.ai/api/v1')?.id, 'openrouter')
  assert.equal(matchEndpoint('https://api.openai.com/v1/')?.id, 'openai')
  assert.equal(matchEndpoint('https://internal.corp/llm'), null)
})

// ---------------------------------------------------------------------------
// 🔴 不发请求
// ---------------------------------------------------------------------------

test('describeValidation 只返回描述，打的是元数据接口', () => {
  for (const provider of PROVIDERS) {
    const endpoint = provider.defaultEndpoint || 'https://example.internal/v1'
    const request = provider.describeValidation(endpoint, OPENAI_KEY)
    assert.equal(request.method, 'GET', `${provider.id} 不该用非 GET 验证`)
    assert.match(request.url, /\/models$/, `${provider.id} 必须打模型列表这类元数据接口`)
    assert.equal(typeof request.headers, 'object')
  }
})

test('地址结尾多一个斜杠不会拼出双斜杠', () => {
  const request = getProvider('openai')!.describeValidation('https://api.openai.com/v1/', 'k')
  assert.equal(request.url, 'https://api.openai.com/v1/models')
})

test('Gemini 的 Key 走请求头而不是查询串（URL 会被日志原样记下）', () => {
  const request = getProvider('gemini')!.describeValidation('https://x/v1', GEMINI_KEY)
  assert.equal(request.url.includes(GEMINI_KEY), false, 'Key 不该出现在 URL 里')
  assert.equal(request.headers['x-goog-api-key'], GEMINI_KEY)
})

test('Anthropic 带上版本头，否则元数据接口也会失败', () => {
  const request = getProvider('anthropic')!.describeValidation('https://x/v1', ANTHROPIC_KEY)
  assert.equal(request.headers['x-api-key'], ANTHROPIC_KEY)
  assert.equal(typeof request.headers['anthropic-version'], 'string')
})

// ---------------------------------------------------------------------------
// 遮蔽
// ---------------------------------------------------------------------------

test('redact 只留头尾，中间遮掉', () => {
  const masked = redact(OPENAI_KEY)
  assert.equal(masked.includes('abcdefghijkl'), false)
  assert.equal(masked.endsWith('2345'), true)
  assert.ok(masked.length < OPENAI_KEY.length)
})

test('🔴 短值全遮：露 4 个字符等于泄露一半', () => {
  assert.equal(redact('sk-12345'), '••••••••')
  assert.equal(redact('abc').includes('abc'), false)
  assert.equal(redact(''), '••••')
})

test('lastFour 对短值不给尾号', () => {
  assert.equal(lastFour(OPENAI_KEY), '2345')
  assert.equal(lastFour('sk-12345'), '')
  assert.equal(lastFour(''), '')
})
