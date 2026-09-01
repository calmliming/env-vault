/**
 * 厂商适配器（开发计划 §8）。首批五家：OpenAI / Anthropic / Google Gemini /
 * DeepSeek / OpenRouter，外加「自定义厂商」。
 *
 * ## 🔴 这一层是纯函数，不发网络请求
 *
 * `describeValidation()` 只**描述**一次验证请求该打哪个地址、带什么头，
 * 真正发出去是另一层的事（本刀未做）。这样拆有三个好处：
 *
 *   1. 验收脚本跑遍所有适配器也不会产生任何出站流量 —— 一个管密钥的工具，
 *      测试时把用户的 Key 发到真实厂商去是不可接受的；
 *   2. 「仅在用户显式点『验证』时才发」这条规矩由调用方一处保证，
 *      而不是散在五个适配器里各自自觉；
 *   3. 描述里带着 Key（在请求头里），调用方能在发之前决定要不要记日志 ——
 *      §7 明确禁止完整 Key 出现在日志里，所以这里返回的对象**不能**被整体打印。
 *
 * 验证一律打**元数据接口**（模型列表这类），不打推理接口：
 * §7「验证请求使用厂商元数据接口，避免无意产生推理费用」。
 *
 * ## 目录约定
 *
 * 和 `src/main/env/` 一样：import 必须带 `.ts` 后缀、不能用 `@shared/*` 别名，
 * 也不能用构造函数参数属性 —— 这些模块要能被 `node --test` 直接跑。
 */

/** 一次验证请求的**描述**。发不发、怎么发，由调用方决定。 */
export interface ValidationRequest {
  url: string
  method: 'GET'
  /**
   * 🔴 这里面带着完整 Key。整个对象禁止进日志、错误消息和崩溃报告（§7）。
   * 需要展示时用 `redact()`。
   */
  headers: Record<string, string>
}

/** 某些厂商需要的额外字段（Azure 的 deployment、api-version 之类）。 */
export interface CredentialField {
  name: string
  label: string
  required: boolean
  placeholder?: string
}

export interface ProviderAdapter {
  id: string
  providerName: string
  defaultEndpoint: string
  /**
   * 除了地址和 Key 之外还需要的字段。首批五家都是空的 ——
   * §2.2「默认界面仍只展示地址和 Key」。留着这个字段是为了第二批的 Azure。
   */
  credentialSchema: readonly CredentialField[]
  /**
   * 值本身就能认出厂商的形状，且**不会和别家撞**（`sk-ant-`、`sk-or-v1-`、`AIza`）。
   * 命中这里就不需要再看变量名。
   */
  distinctiveKeyShapes: readonly RegExp[]
  /**
   * 认得出但**可能和别家撞**的形状。`sk-` 开头的裸 Key 同时符合
   * OpenAI 和 DeepSeek —— 这种情况要把两家都报出来，让用户选。
   */
  genericKeyShapes: readonly RegExp[]
  /** 变量名里出现这些就指向这家。 */
  variablePatterns: readonly RegExp[]
  /** 地址变量的值长这样就属于这家，用来配对 endpoint 变量。 */
  endpointPatterns: readonly RegExp[]
  /** 描述一次元数据请求。不发。 */
  describeValidation(endpoint: string, key: string): ValidationRequest
}

/** 去掉尾部斜杠，避免拼出 `https://x/v1//models`。 */
function joinUrl(endpoint: string, path: string): string {
  return `${endpoint.replace(/\/+$/, '')}${path}`
}

const openai: ProviderAdapter = {
  id: 'openai',
  providerName: 'OpenAI',
  defaultEndpoint: 'https://api.openai.com/v1',
  credentialSchema: [],
  distinctiveKeyShapes: [/^sk-proj-[A-Za-z0-9_-]{16,}$/],
  genericKeyShapes: [/^sk-[A-Za-z0-9_-]{20,}$/],
  variablePatterns: [/(^|_)OPENAI(_|$)/i, /(^|_)GPT(_|$)/i],
  endpointPatterns: [/api\.openai\.com/i],
  describeValidation: (endpoint, key) => ({
    url: joinUrl(endpoint, '/models'),
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` }
  })
}

const anthropic: ProviderAdapter = {
  id: 'anthropic',
  providerName: 'Anthropic',
  defaultEndpoint: 'https://api.anthropic.com/v1',
  credentialSchema: [],
  distinctiveKeyShapes: [/^sk-ant-[A-Za-z0-9_-]{16,}$/],
  genericKeyShapes: [],
  variablePatterns: [/(^|_)ANTHROPIC(_|$)/i, /(^|_)CLAUDE(_|$)/i],
  endpointPatterns: [/api\.anthropic\.com/i],
  describeValidation: (endpoint, key) => ({
    url: joinUrl(endpoint, '/models'),
    method: 'GET',
    // Anthropic 用 x-api-key，且要求带上版本头，否则元数据接口也会 400。
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
  })
}

const gemini: ProviderAdapter = {
  id: 'gemini',
  providerName: 'Google Gemini',
  defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta',
  credentialSchema: [],
  distinctiveKeyShapes: [/^AIza[0-9A-Za-z_-]{35}$/],
  genericKeyShapes: [],
  variablePatterns: [/(^|_)GEMINI(_|$)/i, /(^|_)GOOGLE_?(AI|GENAI)(_|$)/i],
  endpointPatterns: [/generativelanguage\.googleapis\.com/i],
  describeValidation: (endpoint, key) => ({
    url: joinUrl(endpoint, '/models'),
    method: 'GET',
    // 用请求头而不是 ?key= 查询串：URL 会被代理和服务端日志原样记下来。
    headers: { 'x-goog-api-key': key }
  })
}

const deepseek: ProviderAdapter = {
  id: 'deepseek',
  providerName: 'DeepSeek',
  defaultEndpoint: 'https://api.deepseek.com/v1',
  credentialSchema: [],
  // DeepSeek 的 Key 就是裸 `sk-`，和 OpenAI 的形状完全一样，
  // 所以它没有 distinctive 形状 —— 只靠值是分不出这两家的。
  distinctiveKeyShapes: [],
  genericKeyShapes: [/^sk-[A-Za-z0-9_-]{20,}$/],
  variablePatterns: [/(^|_)DEEPSEEK(_|$)/i],
  endpointPatterns: [/api\.deepseek\.com/i],
  describeValidation: (endpoint, key) => ({
    url: joinUrl(endpoint, '/models'),
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` }
  })
}

const openrouter: ProviderAdapter = {
  id: 'openrouter',
  providerName: 'OpenRouter',
  defaultEndpoint: 'https://openrouter.ai/api/v1',
  credentialSchema: [],
  distinctiveKeyShapes: [/^sk-or-v1-[A-Za-z0-9]{16,}$/],
  genericKeyShapes: [],
  variablePatterns: [/(^|_)OPENROUTER(_|$)/i, /(^|_)OPEN_ROUTER(_|$)/i],
  endpointPatterns: [/openrouter\.ai/i],
  describeValidation: (endpoint, key) => ({
    url: joinUrl(endpoint, '/models'),
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` }
  })
}

/**
 * 自定义厂商：用户自己填地址和 Key（§8「关闭验证也可保存」）。
 * 它不参与识别 —— 没有任何形状能"认出"一个自定义厂商，
 * 硬给它一条兜底规则只会让每个认不出的 Key 都被贴上这个标签。
 */
const custom: ProviderAdapter = {
  id: 'custom',
  providerName: '自定义厂商',
  defaultEndpoint: '',
  credentialSchema: [],
  distinctiveKeyShapes: [],
  genericKeyShapes: [],
  variablePatterns: [],
  endpointPatterns: [],
  describeValidation: (endpoint, key) => ({
    url: joinUrl(endpoint, '/models'),
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` }
  })
}

export const PROVIDERS: readonly ProviderAdapter[] = [
  openai,
  anthropic,
  gemini,
  deepseek,
  openrouter,
  custom
]

export function getProvider(id: string): ProviderAdapter | null {
  return PROVIDERS.find((provider) => provider.id === id) ?? null
}

// ---------------------------------------------------------------------------
// 识别
// ---------------------------------------------------------------------------

/** 这条建议是从哪儿来的。界面上要如实说明，不能只给一个厂商名了事。 */
export type SuggestionBasis = 'value' | 'variable-name' | 'both'

export interface ProviderSuggestion {
  providerId: string
  providerName: string
  /**
   * 依据本身就是可信度：both > value > variable-name。
   * 不另外给一个 confidence 字段 —— 两个字段表达同一件事，
   * 早晚会有一个忘了跟着改。
   */
  basis: SuggestionBasis
}

const BASIS_ORDER: Record<SuggestionBasis, number> = { both: 0, value: 1, 'variable-name': 2 }

/**
 * 从「变量名 + 值」推测厂商，按可信度排序返回**全部**候选。
 *
 * 🔴 值优先，名字兜底，冲突时不猜。理由和 `classify.ts` 的取舍一致：
 * 值长得像某家的 Key 是最强的信号，而"变量名没改、值换成了别家"在真实项目里
 * 非常常见（`OPENAI_API_KEY` 里放一把 OpenRouter 的 Key 是标准做法）。
 * 按名字猜会**系统性地**猜错，而且错得很自信。
 *
 * 两个信号对不上时两家都返回，由用户在确认框里选 ——
 * §6.2 本来就要求「用户确认后创建模型凭据」，这里给的只是排序，不是结论。
 */
export function suggestProviders(variableName: string, value: string): ProviderSuggestion[] {
  const trimmed = value.trim()
  const byName = new Set(
    PROVIDERS.filter((p) => p.variablePatterns.some((re) => re.test(variableName))).map((p) => p.id)
  )

  const distinctive = PROVIDERS.filter((p) =>
    p.distinctiveKeyShapes.some((re) => re.test(trimmed))
  )
  // 命中了独有形状就不再看通用形状：`sk-ant-...` 同时符合 DeepSeek 的
  // 通用 `sk-` 规则，但它显然不是 DeepSeek 的 Key。
  const byValue =
    distinctive.length > 0
      ? distinctive
      : PROVIDERS.filter((p) => p.genericKeyShapes.some((re) => re.test(trimmed)))

  const suggestions = new Map<string, ProviderSuggestion>()
  for (const provider of byValue) {
    suggestions.set(provider.id, {
      providerId: provider.id,
      providerName: provider.providerName,
      basis: byName.has(provider.id) ? 'both' : 'value'
    })
  }
  for (const id of byName) {
    if (suggestions.has(id)) continue
    const provider = getProvider(id)
    if (!provider) continue
    suggestions.set(id, {
      providerId: id,
      providerName: provider.providerName,
      basis: 'variable-name'
    })
  }

  return [...suggestions.values()].sort(
    (a, b) => BASIS_ORDER[a.basis] - BASIS_ORDER[b.basis] || a.providerId.localeCompare(b.providerId)
  )
}

/** 这个值看起来是不是某家的调用地址。用来把 endpoint 变量配到凭据上。 */
export function matchEndpoint(value: string): ProviderAdapter | null {
  const trimmed = value.trim()
  return PROVIDERS.find((p) => p.endpointPatterns.some((re) => re.test(trimmed))) ?? null
}

// ---------------------------------------------------------------------------
// 展示
// ---------------------------------------------------------------------------

/**
 * 遮掉 Key 的中间部分，只留尾巴（§8 的 `redact`）。
 *
 * 🔴 短值一律全遮。留前缀在长 Key 上是安全的（`sk-ant-` 本来就是公开前缀），
 * 但对一个 8 字符的 Key 露出 4 个字符等于泄露一半。
 */
export function redact(value: string): string {
  if (value.length <= 12) return '•'.repeat(Math.max(value.length, 4))
  return `${value.slice(0, 3)}…${'•'.repeat(6)}${value.slice(-4)}`
}

/** 末四位。太短的值不给 —— 那等于直接给出一大半明文。 */
export function lastFour(value: string): string {
  return value.length <= 8 ? '' : value.slice(-4)
}
