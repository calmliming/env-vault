/**
 * 变量分类：值类型、敏感等级、以及从文件名推断环境（开发计划 §2.1、§4.2）。
 *
 * 分类只影响**展示与提醒**，不影响存储 —— 所有值一律加密入库（§7），
 * 不存在「判成 normal 就明文存」这种路径。所以这里判错的代价是提示不准，
 * 而不是泄密。这一点决定了下面的取舍：**宁可多报，不可漏报**。
 */

// 带 .ts 后缀是有意的：这些模块要能被 `node --test` 直接跑，
// 而 Node 的 ESM 解析不会替你补扩展名。同理不用 `@shared/*` 别名。
import type { Sensitivity, ValueType } from '../../shared/env-types.ts'

export type { Sensitivity, ValueType }

/**
 * 会被打包进前端产物的变量名前缀 —— 这些值最终会出现在浏览器里，
 * 按 secret 处理没有意义。但如果它们的**值**长得像密钥，那是个真问题，
 * 下面会照样升到 sensitive（阶段 4 的风险扫描会把它单独列出来）。
 */
const PUBLIC_PREFIXES = ['NEXT_PUBLIC_', 'VITE_', 'REACT_APP_', 'PUBLIC_', 'EXPO_PUBLIC_', 'GATSBY_']

/** 出现在变量名里就认为涉密的词。用词边界避免 `MONKEY` 命中 `KEY`。 */
const SECRET_NAME = /(^|_)(KEY|KEYS|SECRET|SECRETS|TOKEN|PASSWORD|PASSWD|PWD|PRIVATE|CREDENTIAL|CREDENTIALS|SALT|SIGNATURE|CERT|AUTH|DSN|SESSION)(_|$)/i

/** 值本身就是一把可识别的凭据。命中即 high。 */
const KEY_SHAPED: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM 私钥
  /^sk-[A-Za-z0-9_-]{16,}$/, // OpenAI
  /^sk-ant-[A-Za-z0-9_-]{16,}$/, // Anthropic
  /^gh[pousr]_[A-Za-z0-9]{20,}$/, // GitHub token
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/, // Slack
  /^AKIA[0-9A-Z]{16}$/, // AWS access key id
  /^AIza[0-9A-Za-z_-]{35}$/, // Google API key
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ // JWT
]

/** URL 里内嵌了用户名密码，例如 postgres://user:pass@host/db。 */
const URL_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i

const BOOLEAN_VALUES = new Set(['true', 'false', 'yes', 'no', 'on', 'off'])

export interface Classification {
  valueType: ValueType
  sensitivity: Sensitivity
}

export function classify(key: string, value: string): Classification {
  const trimmed = value.trim()

  // 1) 值长得像真 Key —— 最强的信号，压过一切命名规则。
  if (KEY_SHAPED.some((pattern) => pattern.test(trimmed))) {
    return { valueType: 'secret', sensitivity: 'high' }
  }

  // 2) 带凭据的连接串。它同时是 URL 和秘密，按秘密处理。
  if (URL_WITH_CREDENTIALS.test(trimmed)) {
    return { valueType: 'secret', sensitivity: 'high' }
  }

  const isPublic = PUBLIC_PREFIXES.some((prefix) => key.startsWith(prefix))
  const nameLooksSecret = !isPublic && SECRET_NAME.test(key)

  // 3) 名字涉密。空值不升级 —— `API_KEY=` 是占位符，掩码它只会碍事。
  if (nameLooksSecret && trimmed !== '') {
    return { valueType: 'secret', sensitivity: 'sensitive' }
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return { valueType: 'url', sensitivity: 'normal' }
  }
  if (trimmed !== '' && /^-?\d+(\.\d+)?$/.test(trimmed)) {
    return { valueType: 'number', sensitivity: 'normal' }
  }
  if (BOOLEAN_VALUES.has(trimmed.toLowerCase())) {
    return { valueType: 'boolean', sensitivity: 'normal' }
  }

  return { valueType: 'text', sensitivity: 'normal' }
}

/** 展示时是否默认掩码。 */
export function shouldMask(sensitivity: Sensitivity): boolean {
  return sensitivity !== 'normal'
}

// ---------------------------------------------------------------------------
// 文件名 → 环境
// ---------------------------------------------------------------------------

/** 只作模板、不该被同步真实值的文件后缀。 */
const TEMPLATE_SUFFIXES = new Set(['example', 'sample', 'template', 'dist', 'defaults'])

export interface EnvFileIdentity {
  /** 归一化后的环境名：default / local / development / test / production / … */
  environment: string
  /** `.env.example` 这类模板文件。默认不纳入同步。 */
  isTemplate: boolean
}

/**
 * 从文件名推断环境。
 *
 * `.env.development.local` 归到 `development` 而不是自成一档：
 * 它就是 development 的本机覆盖层，分成两个环境会让同一个变量在界面上
 * 出现两次却没有任何办法说明它们的优先级关系。
 */
export function identifyEnvFile(fileName: string): EnvFileIdentity | null {
  if (fileName === '.env') return { environment: 'default', isTemplate: false }
  if (!fileName.startsWith('.env.')) return null

  const parts = fileName.slice('.env.'.length).split('.').filter(Boolean)
  if (parts.length === 0) return null

  // 去掉末尾的 .local 覆盖层标记，但 `.env.local` 本身要保留 local 这个名字。
  const hasLocalSuffix = parts.length > 1 && parts[parts.length - 1] === 'local'
  const base = hasLocalSuffix ? parts.slice(0, -1) : parts
  const environment = base.join('.')

  return {
    environment,
    isTemplate: TEMPLATE_SUFFIXES.has(environment.toLowerCase())
  }
}

/** 界面上环境标签的排序：常用的在前，其余按字母序。 */
const ENVIRONMENT_ORDER = ['default', 'local', 'development', 'test', 'staging', 'production']

export function compareEnvironments(a: string, b: string): number {
  const ia = ENVIRONMENT_ORDER.indexOf(a)
  const ib = ENVIRONMENT_ORDER.indexOf(b)
  if (ia !== -1 && ib !== -1) return ia - ib
  if (ia !== -1) return -1
  if (ib !== -1) return 1
  return a.localeCompare(b)
}
