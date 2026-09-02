/**
 * 把一个项目环境解析成可以注入子进程的环境变量（开发计划 §9 阶段 5）。
 *
 * ## 🔴 这个模块**绝不能**暴露成 IPC 通道
 *
 * `resolveEnvironment` 一次返回一个环境里**所有**变量的明文。
 * 逐变量 reveal 的审计（每次调用留一条记录、界面上要点一下才显示）
 * 存在的全部意义，就是不让这种批量读取悄悄发生。
 *
 * 它对 CLI 进程是必要的 —— 子进程要的就是这些值 —— 但一旦出现在
 * `shared/ipc.ts` 里，渲染层就能一次性拿走整个环境的明文，
 * 前面几刀在明文边界上做的所有功夫都会作废。
 *
 * 调用方只有一个：`src/main/cli/index.ts`，它跑在一个没有窗口、
 * 没有注册任何 IPC 处理器的进程里。
 *
 * ## 🔴 绑定到凭据的变量取凭据的当前值
 *
 * 和阶段 3「真源只能有一个」一致：凭据就是那把 Key 的真源。
 * 一把刚轮换、还没同步回文件的凭据，如果按文件里的旧值启动开发命令，
 * 用户会看着界面上明明已经换过的 Key，却怎么也想不通服务为什么还在用旧的。
 */

import { getDatabase } from './index'
import * as vault from '../security/vault'
import { RepositoryError, logActivity, requireUnlocked } from './repositories'
import { getProvider } from '../providers/index.ts'

/** 一个变量的来源。🔴 这里没有值，只有名字和来源。 */
export interface ResolvedVariable {
  key: string
  /** 值来自模型凭据而不是配置文件。 */
  fromCredential: boolean
  /** 凭据的值和文件里那条记录不一致 —— 说明凭据轮换过但还没同步。 */
  differsFromFile: boolean
  /** 归哪条凭据管，用于提示。 */
  credentialName: string | null
}

export interface ResolvedEnvironment {
  projectId: number
  projectName: string
  environment: string
  /**
   * 🔴 变量名 → 明文值。只在 CLI 进程的内存里活着，
   * 直接交给 `spawn` 的 env，不写文件、不进日志、不过 IPC。
   */
  values: Map<string, string>
  /** 每个变量的来源说明。给用户看的，里面没有值。 */
  variables: ResolvedVariable[]
}

interface EntryRow {
  key: string
  encrypted_value: Uint8Array | null
  environment: string
}

interface BoundRow {
  key_variable: string
  encrypted_api_key: Uint8Array
  credential_name: string
  provider_name: string
  status: string
}

function decrypt(blob: Uint8Array | null): string {
  return blob ? vault.decryptValue(Buffer.from(blob)) : ''
}

/**
 * 按项目名或绝对路径找项目。
 *
 * 两种都接受是因为两种都自然：在项目目录里跑的时候路径最顺手，
 * 从别处跑的时候名字最顺手。名字重复时按创建时间取第一个并说明。
 */
export function findProject(nameOrPath: string): { id: number; name: string } {
  const db = getDatabase()
  const needle = nameOrPath.trim()

  const byPath = db
    .prepare('SELECT id, name FROM projects WHERE absolute_path = ?')
    .get<{ id: number; name: string }>(needle)
  if (byPath) return byPath

  const byName = db
    .prepare('SELECT id, name FROM projects WHERE name = ? ORDER BY created_at ASC')
    .all<{ id: number; name: string }>(needle)
  if (byName.length === 0) {
    throw new RepositoryError('NOT_FOUND', `没有找到项目「${needle}」。用项目名或项目的绝对路径。`)
  }
  return byName[0]!
}

/**
 * 解析出一个环境的全部变量。
 *
 * 🔴 返回值里带着明文。调用方（CLI）拿到之后直接交给 `spawn` 的 env，
 * 不要落盘、不要打印、不要往任何返回值里塞。
 */
export function resolveEnvironment(projectId: number, environment: string): ResolvedEnvironment {
  requireUnlocked()
  const db = getDatabase()

  const project = db
    .prepare('SELECT id, name FROM projects WHERE id = ?')
    .get<{ id: number; name: string }>(projectId)
  if (!project) throw new RepositoryError('NOT_FOUND', '项目不存在')

  const rows = db
    .prepare(
      `SELECT c.key, c.encrypted_value, f.environment
       FROM config_entries c
       JOIN env_files f ON f.id = c.env_file_id
       WHERE f.project_id = ? AND f.environment = ?
       ORDER BY f.absolute_path ASC, c.source_line ASC`
    )
    .all<EntryRow>(projectId, environment)

  if (rows.length === 0) {
    throw new RepositoryError(
      'NOT_FOUND',
      `项目「${project.name}」的「${environment}」环境里没有任何配置项。`
    )
  }

  // 这个环境里被凭据管着的变量。
  const bound = new Map(
    db
      .prepare(
        `SELECT b.key_variable, m.encrypted_api_key, m.credential_name, m.provider_name, m.status
         FROM credential_bindings b
         JOIN model_credentials m ON m.id = b.credential_id
         WHERE b.project_id = ? AND b.environment = ?`
      )
      .all<BoundRow>(projectId, environment)
      .map((row) => [row.key_variable, row])
  )

  const values = new Map<string, string>()
  const variables: ResolvedVariable[] = []

  for (const row of rows) {
    // 同一个 key 在同一环境里可能出现多次（重复 key 是被有意保留的）。
    // 环境变量没有"重复"这回事，按运行时的惯例取最后一个。
    const fileValue = decrypt(row.encrypted_value)
    const binding = bound.get(row.key)

    if (!binding) {
      values.set(row.key, fileValue)
      variables.push({
        key: row.key,
        fromCredential: false,
        differsFromFile: false,
        credentialName: null
      })
      continue
    }

    // 🔴 已停用的凭据不注入。和「停用后拒绝同步」同一条规矩：
    // 用户说过这把不要了，那就不该再被塞进一个正在跑的进程里。
    if (binding.status === 'revoked') {
      variables.push({
        key: row.key,
        fromCredential: true,
        differsFromFile: false,
        credentialName: `${getProvider(binding.provider_name)?.providerName ?? binding.provider_name} / ${binding.credential_name}（已停用，未注入）`
      })
      continue
    }

    const credentialValue = decrypt(binding.encrypted_api_key)
    values.set(row.key, credentialValue)
    variables.push({
      key: row.key,
      fromCredential: true,
      differsFromFile: credentialValue !== fileValue,
      credentialName: `${getProvider(binding.provider_name)?.providerName ?? binding.provider_name} / ${binding.credential_name}`
    })
  }

  /*
    一次注入记**一条**记录，不是每个变量一条。
    这一次注入本来就是一个动作；逐变量记会把审计日志淹掉，
    真正重要的 reveal 和写盘记录就再也翻不出来了。

    🔴 detail 里是变量名和条数，没有值。
  */
  logActivity({
    action: 'cli.inject',
    projectId: project.id,
    environment,
    targetKind: 'project',
    targetRef: project.name,
    detail: `注入 ${values.size} 个变量：${[...values.keys()].join('、')}`
  })

  return {
    projectId: project.id,
    projectName: project.name,
    environment,
    values,
    variables
  }
}
