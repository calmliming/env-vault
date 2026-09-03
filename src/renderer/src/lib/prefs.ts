/**
 * 界面偏好的本地存储。
 *
 * ## 为什么是 localStorage 而不是走 IPC 存进数据库
 *
 * 这里存的全是**纯界面偏好**：侧栏收不收起、列表每页多少条、导出对话框
 * 默认开在哪个目录。它们不是应用数据 —— 换台机器不需要跟着走，丢了也只是
 * 回到默认值。为它们开 IPC 通道要动五个文件，还会让 preload 的方法数
 * 变化（那个数字被 verify-ui 写死盯着，见 scripts/verify-ui.mjs），
 * 代价和收益完全不成比例。
 *
 * 🔴 **敏感数据一律不许进这里。** localStorage 是明文、不设防、任何拿到
 * 渲染进程的代码都读得到。值、口令、Key 走 Vault，没有例外。
 *
 * ## 为什么每次读写都包 try/catch
 *
 * `localStorage` 不只是「可能返回 null」——在隐私模式、企业策略禁用站点
 * 数据、或磁盘配额满的情况下，**存取动作本身会抛异常**。不包住的话，
 * 一次读偏好就能把整个界面炸成白屏。任何一次失败都退回默认值，静默处理：
 * 用户不需要为「侧栏宽度没记住」看一个报错。
 */

const PREFIX = 'envvault.ui.'

export const PREF_KEYS = {
  sidebarCollapsed: `${PREFIX}sidebarCollapsed`,
  entriesPageSize: `${PREFIX}entriesPageSize`,
  activityPageSize: `${PREFIX}activityPageSize`,
  defaultExportDir: `${PREFIX}defaultExportDir`
} as const

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeRaw(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // 存不进去就算了。偏好没记住不值得打断用户手上的事。
  }
}

export function readBoolPref(key: string, fallback: boolean): boolean {
  const raw = readRaw(key)
  if (raw === 'true') return true
  if (raw === 'false') return false
  return fallback
}

export function writeBoolPref(key: string, value: boolean): void {
  writeRaw(key, value ? 'true' : 'false')
}

/**
 * 读一个整数偏好。
 *
 * `allowed` 是白名单而不是范围校验：页大小这类值来自一个固定的下拉框，
 * 存进去的东西理论上只可能是其中之一。但 localStorage 是用户可改的，
 * 一个手改成 999999 的每页条数会让表格一次渲染上万行卡死界面 ——
 * 所以不在白名单里就退回默认值，而不是钳制到边界。
 */
export function readIntPref(key: string, fallback: number, allowed: readonly number[]): number {
  const raw = readRaw(key)
  if (raw === null) return fallback
  const parsed = Number.parseInt(raw, 10)
  return allowed.includes(parsed) ? parsed : fallback
}

export function writeIntPref(key: string, value: number): void {
  writeRaw(key, String(value))
}

export function readStringPref(key: string): string | null {
  const raw = readRaw(key)
  return raw === null || raw === '' ? null : raw
}

export function writeStringPref(key: string, value: string | null): void {
  if (value === null || value === '') {
    try {
      window.localStorage.removeItem(key)
    } catch {
      // 同上。
    }
    return
  }
  writeRaw(key, value)
}
