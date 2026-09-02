/**
 * 安全检查的风险等级。
 *
 * 单独成文件的理由和 `env-types.ts` / `provider-types.ts` 一样：它同时被两边用到 ——
 *   - 主进程的 `git/risk.ts`（用相对路径 import，好让 `node --test` 直接跑）
 *   - `shared/ipc.ts`（渲染层要按等级渲染徽章和排序）
 * 放进 `shared/ipc.ts` 会让领域逻辑反过来依赖 IPC 契约，方向不对；
 * 各留一份又必然会漂移。
 */

/**
 * 一个文件的风险等级。
 *
 * 🔴 `unknown` 不是「没风险」，是「没查出来」—— 这两件事在界面上必须分得开。
 * git 不在 PATH 上、或者项目不在任何仓库里时就是这个等级，
 * 而那时候一个绿色的「通过」徽章是彻头彻尾的谎话。
 */
export type RiskLevel =
  /** 敏感值正暴露在 Git 里，或者下一次提交就会进去。要立刻处理。 */
  | 'critical'
  /** 值得看一眼，但不是明火。 */
  | 'warning'
  /** 查过了，没问题。 */
  | 'ok'
  /** 查不了。git 不可用，或者这个目录不在 Git 仓库里。 */
  | 'unknown'

/** 排序用：越危险越靠前。界面不要另写一套顺序。 */
export const RISK_ORDER: Record<RiskLevel, number> = {
  critical: 0,
  warning: 1,
  unknown: 2,
  ok: 3
}
