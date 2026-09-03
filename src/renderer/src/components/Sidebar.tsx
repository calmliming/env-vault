import type { ReactNode } from 'react'
import type { ViewId } from '../views/registry'
import { VIEWS } from '../views/registry'
import { IconLock, IconSidebar, IconUnlock, LogoMark } from './icons'
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
  collapsed: boolean
  onToggleCollapsed(): void
}

export function Sidebar({
  activeView,
  onSelectView,
  projects,
  selectedProjectId,
  onSelectProject,
  vault,
  vaultBusy,
  onVaultAction,
  collapsed,
  onToggleCollapsed
}: SidebarProps): ReactNode {
  const label = vaultLabel(vault)

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark" aria-label="EnvVault logo">
          {/*
            类名 `brand-mark-core` 保留在标记本身上。verify-ui 断言它恰好渲染
            一次（「logo 受保护核心渲染一次」），换成 SVG 之后这个标记就是核心。
          */}
          <LogoMark className="brand-mark-core" size={22} />
        </div>
        <div className="brand-text">
          <div className="brand-name">EnvVault</div>
          <span className="brand-meta">local workspace</span>
        </div>
        {/*
          🔴 收起按钮必须留在 .brand 里，不能进 .nav ——
          verify-ui 断言 `.nav button` 恰好是 5 个（主导航五项，§5.1）。
        */}
        <button
          className="sidebar-toggle"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
        >
          <IconSidebar />
        </button>
      </div>

      <div className="nav-label">工作台</div>
      <nav className="nav" aria-label="主导航">
        {VIEWS.map((view) => (
          <button
            key={view.id}
            className={view.id === activeView ? 'active' : undefined}
            aria-current={view.id === activeView ? 'page' : undefined}
            onClick={() => onSelectView(view.id)}
            // 收起后只剩图标，标签得靠原生 tooltip 补回来。
            title={collapsed ? view.label : undefined}
          >
            <span className="nav-icon">
              <view.icon />
            </span>
            {/* 🔴 标签必须包一层：收起态要把它藏掉，裸文本节点没有元素可选。 */}
            <span className="nav-text">{view.label}</span>
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
            // 收起后项目名也没了，只剩一个点 —— tooltip 里得把名字带上。
            title={collapsed ? `${project.name} · ${project.absolutePath}` : project.absolutePath}
          >
            {/* 有未纳入 Git 的风险时才变色，颜色在这里是信息不是装饰。 */}
            <span className={project.gitRoot ? 'project-dot' : 'project-dot orange'} />
            <span className="project-name">{project.name}</span>
            <span className="project-path">{project.entryCount}</span>
          </button>
        ))}
      </div>

      {/*
        🔴 收起后这一块不能整个藏掉。
        Vault 锁着的时候，「解锁」是这里唯一的入口 —— 藏掉它等于把用户关在
        门外，逼他先展开侧栏才能干活。所以收起态只压缩表现：状态点留着
        （锁没锁是必须一眼可见的信息），文字进 tooltip，按钮退化成图标。
      */}
      <div className="sidebar-foot">
        <div
          className={`vault-state ${vault?.state ?? 'uninitialized'}`}
          title={collapsed ? `${label.text} · ${label.detail}` : undefined}
        >
          <span className="state-dot" />
          <span className="vault-state-text">{label.text}</span>
        </div>
        <div className="vault-detail">{label.detail}</div>
        {label.action && (
          <button
            className="vault-action"
            onClick={onVaultAction}
            disabled={vaultBusy}
            title={collapsed ? label.action : undefined}
            aria-label={collapsed ? label.action : undefined}
          >
            {collapsed ? (
              vault?.state === 'unlocked' ? (
                <IconLock />
              ) : (
                <IconUnlock />
              )
            ) : vaultBusy ? (
              '处理中…'
            ) : (
              label.action
            )}
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
