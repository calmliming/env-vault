/**
 * 主进程健康状态（Vault + 数据库 + 版本）。
 *
 * 这是阶段 0 里唯一一条真实的数据链路：渲染进程 → preload 白名单 → IPC → 主进程。
 * 界面上「设置 · 系统状态」和侧栏的 Vault 指示灯都读它，
 * 所以只要那两处显示正常，验收标准里的「最小 IPC 读写健康状态」就是被看见的。
 */

import { useCallback, useEffect, useState } from 'react'
import { bridge } from '../lib/api'
import type { AppHealth } from '@shared/ipc'

interface HealthState {
  health: AppHealth | null
  error: string | null
  loading: boolean
  refresh(): Promise<void>
}

export function useAppHealth(): HealthState {
  const [health, setHealth] = useState<AppHealth | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    const result = await bridge.health()
    if (result.ok) {
      setHealth(result.data)
      setError(null)
    } else {
      setError(result.message)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { health, error, loading, refresh }
}
