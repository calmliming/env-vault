import type { ReactNode } from 'react'
import type { ViewId } from '../views/registry'
import { VIEWS } from '../views/registry'
import type { ProjectSummary, VaultStatus } from '@shared/ipc'

interface SidebarProps {
  activeView: ViewId
  onSelectView(view: ViewId): void
  projects: ProjectSummary[]
  selectedProjectId: number | null
  onSelectProject(projectId: number): void
  vault: VaultStatus | null
  vaultBusy: boolean
  onVaultAction(): void
}

export function Sidebar({
  activeView,
  onSelectView,
  projects,
  selectedProjectId,
  onSelectProject,
  vault,
  vaultBusy,
  onVaultAction
}: SidebarProps): ReactNode {
  const label = vaultLabel(vault)

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark" aria-label="EnvVault logo">
          <span className="brand-mark-core" />
        </div>
        <div>
          <div className="brand-name">EnvVault</div>
          <span className="brand-meta">local workspace</span>
        </div>
      </div>

      <div className="nav-label">工作台</div>
      <nav className="nav" aria-label="主导航">
        {VIEWS.map((view) => (
          <button
            key={view.id}
            className={view.id === activeView ? 'active' : undefined}
            aria-current={view.id === activeView ? 'page' : undefined}
            onClick={() => onSelectView(view.id)}
          >
            <span className="nav-icon" aria-hidden="true">
              {view.icon}
            </span>
            {view.label}
          </button>
        ))}
      </nav>

      <div className="nav-label">已连接项目</div>
      <div className="project-list">
        {projects.length === 0 && <div className="project-empty">还没有添加项目</div>}
        {projects.map((project) => (
          <button
            key={project.id}
            type="button"
            className={project.id === selectedProjectId ? 'project active' : 'project'}
            onClick={() => onSelectProject(project.id)}
            title={project.absolutePath}
          >
            {/* 有未纳入 Git 的风险时才变色，颜色在这里是信息不是装饰。 */}
            <span className={project.gitRoot ? 'project-dot' : 'project-dot orange'} />
            <span className="project-name">{project.name}</span>
            <span className="project-path">{project.entryCount}</span>
          </button>
        ))}
      </div>

      <div className="sidebar-foot">
        <div className={`vault-state ${vault?.state ?? 'uninitialized'}`}>
          <span className="state-dot" />
          {label.text}
        </div>
        <div>{label.detail}</div>
        {label.action && (
          <button className="vault-action" onClick={onVaultAction} disabled={vaultBusy}>
            {vaultBusy ? '处理中…' : label.action}
          </button>
        )}
      </div>
    </aside>
  )
}

function vaultLabel(vault: VaultStatus | null): { text: string; detail: string; action: string | null } {
  if (!vault) return { text: '正在读取状态', detail: '连接主进程…', action: null }

  // 系统密钥库不可用时不给任何创建入口：宁可什么都不做，
  // 也不能把主密钥写进一个只是"看起来加密"的文件里。
  if (!vault.keystoreAvailable) {
    return {
      text: '系统密钥库不可用',
      detail: `后端 · ${vault.keystoreBackend}`,
      action: null
    }
  }

  switch (vault.state) {
    case 'unlocked':
      return { text: '本地 Vault 已解锁', detail: `密钥库 · ${vault.keystoreBackend}`, action: '锁定 Vault' }
    case 'locked':
      return { text: '本地 Vault 已锁定', detail: '敏感值当前不可解密', action: '解锁 Vault' }
    default:
      return { text: '尚未创建 Vault', detail: '首次使用需要生成主密钥', action: '创建本地 Vault' }
  }
}
