/**
 * 工作台的数据层：项目列表、当前选中项目、环境筛选、配置项与文件。
 *
 * 全部来自主进程，没有任何占位常量。
 *
 * 两条贯穿的规则：
 *   1. **任何一次加载失败都要能区分「Vault 锁着」和「真出错」**。前者是正常状态，
 *      界面应该引导去解锁；后者才该报错。所以 `locked` 是独立字段，不是 error 里的一句话。
 *   2. 收到文件变化推送时**只刷新状态，绝不自动改数据**。计划 §6.4 那句
 *      「任何外部修改在用户确认前都不能被覆盖」反过来也成立：
 *      也不能在用户没确认时替他把中心记录改掉。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { bridge, isVaultBlocked } from '../lib/api'
import type { ConfigEntryView, EnvFileView, ProjectSummary, VaultStatus } from '@shared/ipc'

/** 环境筛选里的「全部」。用 null 表示不加 environment 条件。 */
export type EnvironmentFilter = string | null

export interface Workspace {
  projects: ProjectSummary[]
  selectedProject: ProjectSummary | null
  selectProject(projectId: number): void
  environment: EnvironmentFilter
  setEnvironment(environment: EnvironmentFilter): void
  entries: ConfigEntryView[]
  files: EnvFileView[]
  loading: boolean
  /** Vault 未解锁，数据读不出来。这不是错误。 */
  locked: boolean
  error: string | null
  /** 自上次查看以来，监听到的外部改动次数。用于顶栏的提醒标记。 */
  externalChanges: number
  acknowledgeChanges(): void
  reloadProjects(selectId?: number): Promise<void>
  reloadCurrent(): Promise<void>
}

export function useWorkspace(vault: VaultStatus | null): Workspace {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [environment, setEnvironment] = useState<EnvironmentFilter>(null)
  const [entries, setEntries] = useState<ConfigEntryView[]>([])
  const [files, setFiles] = useState<EnvFileView[]>([])
  const [loading, setLoading] = useState(false)
  const [locked, setLocked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [externalChanges, setExternalChanges] = useState(0)

  const vaultState = vault?.state ?? null

  /**
   * 订阅回调里要读当前选中的项目，但订阅必须只建一次
   * （每次 selectedId 变化都重订会在推送密集时漏事件）。用 ref 把值带进去。
   */
  const selectedIdRef = useRef<number | null>(null)
  selectedIdRef.current = selectedId

  const reloadProjects = useCallback(async (selectId?: number) => {
    const result = await bridge.listProjects()
    if (!result.ok) {
      setError(result.message)
      return
    }
    setProjects(result.data)
    setError(null)
    setSelectedId((current) => {
      if (selectId !== undefined) return selectId
      // 当前选中的项目还在就保持不动，否则落到第一个。
      if (current !== null && result.data.some((project) => project.id === current)) return current
      return result.data[0]?.id ?? null
    })
  }, [])

  const loadCurrent = useCallback(async (projectId: number, env: EnvironmentFilter) => {
    setLoading(true)
    const [entriesResult, filesResult] = await Promise.all([
      bridge.listEntries({ projectId, ...(env ? { environment: env } : {}) }),
      bridge.listFiles(projectId)
    ])

    if (!entriesResult.ok) {
      setEntries([])
      if (isVaultBlocked(entriesResult)) {
        setLocked(true)
        setError(null)
      } else {
        setLocked(false)
        setError(entriesResult.message)
      }
    } else {
      setEntries(entriesResult.data)
      setLocked(false)
      setError(null)
    }

    // 文件列表不含明文，Vault 锁着也读得出来，所以单独判断。
    setFiles(filesResult.ok ? filesResult.data : [])
    setLoading(false)
  }, [])

  /** 只刷文件列表。磁盘变了不等于中心记录变了，重拉 entries 是白跑一趟解密。 */
  const refreshFiles = useCallback(async () => {
    const projectId = selectedIdRef.current
    if (projectId === null) return
    const result = await bridge.listFiles(projectId)
    if (result.ok) setFiles(result.data)
  }, [])

  // 项目列表：启动时拉一次，Vault 状态变化后再拉一次
  // （锁定期间导入是禁止的，解锁后列表可能已经不同）。
  useEffect(() => {
    void reloadProjects()
  }, [reloadProjects, vaultState])

  // 切项目时清掉环境筛选：上一个项目的 `staging` 在新项目里可能根本不存在，
  // 留着会得到一张空表，而用户并不知道是筛选造成的。
  useEffect(() => {
    setEnvironment(null)
  }, [selectedId])

  useEffect(() => {
    if (selectedId === null) {
      setEntries([])
      setFiles([])
      setLocked(vaultState !== null && vaultState !== 'unlocked')
      return
    }
    void loadCurrent(selectedId, environment)
  }, [selectedId, environment, loadCurrent, vaultState])

  /**
   * 订阅主进程推来的文件变化（§6.4）。
   *
   * 🔴 退订必须调用返回的那个函数。preload 里的 off 绑定的是同一个 listener 引用，
   * 漏掉退订会让监听器在热更新/重挂载时越堆越多，一次变化触发 N 次重新加载。
   */
  useEffect(() => {
    if (typeof window === 'undefined' || !window.envvault) return
    return window.envvault.onFilesChanged((events) => {
      const drifted = events.filter((event) => event.drifted).length
      if (drifted > 0) setExternalChanges((prev) => prev + drifted)
      void refreshFiles()
    })
  }, [refreshFiles])

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedId) ?? null,
    [projects, selectedId]
  )

  const reloadCurrent = useCallback(async () => {
    if (selectedId === null) return
    await loadCurrent(selectedId, environment)
  }, [selectedId, environment, loadCurrent])

  const acknowledgeChanges = useCallback(() => setExternalChanges(0), [])

  return {
    projects,
    selectedProject,
    selectProject: setSelectedId,
    environment,
    setEnvironment,
    entries,
    files,
    loading,
    locked,
    error,
    externalChanges,
    acknowledgeChanges,
    reloadProjects,
    reloadCurrent
  }
}
