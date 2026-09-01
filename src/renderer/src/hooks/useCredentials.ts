/**
 * 凭据库的数据层。
 *
 * 和 `useWorkspace` 同一套规矩：区分「Vault 锁着」和「真出错」，
 * 前者是正常状态，界面该引导去解锁而不是报错。
 *
 * 🔴 这里只拿得到 `CredentialSummary` —— 指纹和末四位，没有 Key 明文。
 * 明文只在用户点「显示」时经 `revealCredential` 单独取一次，且那次会留痕。
 */

import { useCallback, useEffect, useState } from 'react'
import { bridge, isVaultBlocked } from '../lib/api'
import type { CredentialSummary, ProviderInfo, VaultStatus } from '@shared/ipc'

export interface CredentialStore {
  credentials: CredentialSummary[]
  providers: ProviderInfo[]
  loading: boolean
  locked: boolean
  error: string | null
  reload(): Promise<void>
}

export function useCredentials(vault: VaultStatus | null): CredentialStore {
  const [credentials, setCredentials] = useState<CredentialSummary[]>([])
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [locked, setLocked] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const vaultState = vault?.state ?? null

  const reload = useCallback(async () => {
    setLoading(true)
    const [list, providerList] = await Promise.all([
      bridge.listCredentials(),
      bridge.listProviders()
    ])
    setLoading(false)

    // 厂商表是静态元数据，不含任何用户数据，锁着也读得出来。
    if (providerList.ok) setProviders(providerList.data)

    if (list.ok) {
      setCredentials(list.data)
      setLocked(false)
      setError(null)
      return
    }
    setCredentials([])
    if (isVaultBlocked(list)) {
      setLocked(true)
      setError(null)
    } else {
      setLocked(false)
      setError(list.message)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload, vaultState])

  return { credentials, providers, loading, locked, error, reload }
}
