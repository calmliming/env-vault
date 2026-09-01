/**
 * 设置 · 系统状态。
 *
 * 阶段 0 的验收标准是「应用可以启动、创建本地数据库、锁定/解锁 Vault，
 * 并通过最小 IPC 读写健康状态」—— 这一页就是那条标准的可见形式。
 * 上面每一个数字都来自主进程的一次真实 IPC 调用，没有任何占位常量。
 */

import type { ReactNode } from 'react'
import type { AppHealth, VaultStatus } from '@shared/ipc'

interface SettingsViewProps {
  health: AppHealth | null
  error: string | null
  loading: boolean
  vaultBusy: boolean
  onRefresh(): void
  onVaultAction(): void
}

export function SettingsView({
  health,
  error,
  loading,
  vaultBusy,
  onRefresh,
  onVaultAction
}: SettingsViewProps): ReactNode {
  return (
    <section>
      <div className="page-head">
        <div>
          <div className="eyebrow">运行时</div>
          <h1>系统状态</h1>
          <p className="page-subtitle">
            主进程、本地数据库与 Vault 的实时状态，全部通过 IPC 白名单读取。
          </p>
        </div>
        <div className="head-actions">
          <button className="outline-btn" onClick={onRefresh} disabled={loading}>
            {loading ? '读取中…' : '刷新'}
          </button>
        </div>
      </div>

      {error && (
        <div className="empty-section">
          <h2>无法读取状态</h2>
          <p>{error}</p>
        </div>
      )}

      {health && (
        <div className="status-grid">
          <VaultPanel vault={health.vault} busy={vaultBusy} onAction={onVaultAction} />

          <section className="panel">
            <div className="panel-head">
              <div>
                <div className="panel-title">本地数据库</div>
                <div className="panel-kicker">SQLite · WAL</div>
              </div>
              <span
                className={
                  health.database.schemaVersion === health.database.latestVersion
                    ? 'health-badge ok'
                    : 'health-badge warn'
                }
              >
                v{health.database.schemaVersion}
              </span>
            </div>
            <div className="status-body">
              <Row label="文件" value={health.database.filePath} />
              <Row
                label="Schema 版本"
                value={`${health.database.schemaVersion} / 最新 ${health.database.latestVersion}`}
              />
              <Row
                label="本次迁移"
                value={
                  health.database.appliedMigrations.length === 0 ? (
                    '无（已是最新）'
                  ) : (
                    <>
                      {health.database.appliedMigrations.map((migration) => (
                        <span className="migration-line" key={migration.version}>
                          <span>
                            {String(migration.version).padStart(3, '0')} · {migration.name}
                          </span>
                          <span>{migration.durationMs}ms</span>
                        </span>
                      ))}
                    </>
                  )
                }
              />
              <Row label="数据表" value={health.database.tables.join('、')} />
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <div className="panel-title">运行环境</div>
                <div className="panel-kicker">进程与版本</div>
              </div>
              <span className="health-badge neutral">{health.platform}</span>
            </div>
            <div className="status-body">
              <Row label="EnvVault" value={health.appVersion} />
              <Row label="Electron" value={health.electronVersion} />
              <Row label="Chromium" value={health.chromeVersion} />
              <Row label="Node" value={health.nodeVersion} />
              <Row label="数据目录" value={health.userDataPath} />
            </div>
          </section>
        </div>
      )}
    </section>
  )
}

function VaultPanel({
  vault,
  busy,
  onAction
}: {
  vault: VaultStatus
  busy: boolean
  onAction(): void
}): ReactNode {
  const badge =
    vault.state === 'unlocked'
      ? 'health-badge ok'
      : vault.state === 'locked'
        ? 'health-badge warn'
        : 'health-badge neutral'

  const stateText =
    vault.state === 'unlocked' ? '已解锁' : vault.state === 'locked' ? '已锁定' : '未创建'

  const actionText =
    vault.state === 'unlocked' ? '锁定 Vault' : vault.state === 'locked' ? '解锁 Vault' : '创建本地 Vault'

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">本地 Vault</div>
          <div className="panel-kicker">主密钥由系统密钥库保护</div>
        </div>
        <span className={badge}>{stateText}</span>
      </div>
      <div className="status-body">
        <Row label="系统密钥库" value={vault.keystoreAvailable ? `可用 · ${vault.keystoreBackend}` : `不可用 · ${vault.keystoreBackend}`} />
        <Row label="密钥文件" value={vault.keyFilePath} />
        <Row
          label="解锁时间"
          value={vault.unlockedAt ? new Date(vault.unlockedAt).toLocaleString('zh-CN') : '未解锁'}
        />
      </div>
      <div className="status-actions">
        <button className="primary-btn" onClick={onAction} disabled={busy || !vault.keystoreAvailable}>
          {busy ? '处理中…' : actionText}
        </button>
      </div>
    </section>
  )
}

function Row({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="status-row">
      <span className="status-key">{label}</span>
      <span className="status-val">{value}</span>
    </div>
  )
}
