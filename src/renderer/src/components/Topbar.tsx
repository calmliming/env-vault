import type { ReactNode } from 'react'
import type { ViewId } from '../views/registry'
import { viewLabel } from '../views/registry'
import { IconBell, IconSearch } from './icons'

interface TopbarProps {
  activeView: ViewId
  onOpenSearch(): void
  onOpenNotices(): void
  onAddProject(): void
}

export function Topbar({ activeView, onOpenSearch, onOpenNotices, onAddProject }: TopbarProps): ReactNode {
  return (
    <header className="topbar">
      <div className="crumb">
        工作台 / <strong>{viewLabel(activeView)}</strong>
      </div>
      <div className="top-actions">
        <button className="icon-btn" title="搜索" aria-label="搜索配置" onClick={onOpenSearch}>
          <IconSearch />
        </button>
        <button className="icon-btn" title="通知" aria-label="最近提醒" onClick={onOpenNotices}>
          <IconBell />
        </button>
        <button className="primary-btn" onClick={onAddProject}>
          + 添加项目
        </button>
      </div>
    </header>
  )
}
