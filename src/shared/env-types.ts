/**
 * `.env` 领域里最基础的两个枚举。
 *
 * 单独成文件是因为它同时被两边用到：
 *   - 主进程的 `env/classify.ts`（用相对路径 import，好让 `node --test` 直接跑）
 *   - `shared/ipc.ts`（渲染层要按类型渲染标签和掩码）
 * 放进 `shared/ipc.ts` 会让领域逻辑反过来依赖 IPC 契约，方向不对；
 * 各留一份又必然会漂移。
 */

export type ValueType = 'secret' | 'url' | 'number' | 'boolean' | 'text'

export type Sensitivity =
  /** 普通配置，展示时不掩码。 */
  | 'normal'
  /** 疑似敏感，默认掩码。 */
  | 'sensitive'
  /** 高危：值本身长得就像一把真 Key，或者是私钥。 */
  | 'high'
