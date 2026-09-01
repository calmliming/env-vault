import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { ModalActions } from '../state/modal'

interface SearchModalProps {
  close(): void
  showToast(message: string): void
  /** 应用查询：跳到配置总览并把关键词填进表格上方的搜索框。 */
  applyQuery(query: string): void
}

export function SearchModal({ close, showToast, applyQuery }: SearchModalProps): ReactNode {
  const [query, setQuery] = useState('')

  function onSubmit(event: FormEvent): void {
    event.preventDefault()
    close()
    applyQuery(query)
    showToast(query ? `已筛选：${query}` : '已清除搜索')
  }

  return (
    <form onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="quick-search-input">变量名或来源文件</label>
        <input
          id="quick-search-input"
          placeholder="例如 OPENAI 或 .env.local"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="shortcut-row">
        <kbd>Enter</kbd> 应用筛选 <kbd>Esc</kbd> 关闭弹窗
      </div>
      <ModalActions cancelText="取消" submitText="应用搜索" onCancel={close} />
    </form>
  )
}
