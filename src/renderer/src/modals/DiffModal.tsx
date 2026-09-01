import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { bridge } from '../lib/api'
import type { DiffStatus, EnvFileView, FileDiff, FileDiffRow } from '@shared/ipc'

interface DiffModalProps {
  close(): void
  showToast(message: string): void
  file: EnvFileView
  onResolved(): void
}

/**
 * §6.4 的决策界面：文件在外部被改了，用户选一个方向。
 *
 * 🔴 两个方向都是**破坏性**的，所以：
 *   - 默认什么都不选中，用户必须显式勾选要写回的变量；
 *   - 按钮文案直说会发生什么（「用磁盘覆盖记录」/「用记录覆盖文件」），
 *     不用「同步」「确认」这种两边都说得通的词；
 *   - 写回前主进程还会再校验一次磁盘哈希，从这里到点确认之间文件又被改过就中止。
 *
 * 敏感项两侧都是掩码。用户能看到"这一项变了"，看不到变成什么 ——
 * 想看具体值回配置表点「显示」，那条路径会留痕。
 */
export function DiffModal({ close, showToast, file, onResolved }: DiffModalProps): ReactNode {
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const result = await bridge.diffFile(file.id)
    if (result.ok) {
      setDiff(result.data)
      setError(null)
    } else {
      setError(result.message)
    }
  }, [file.id])

  useEffect(() => {
    void load()
  }, [load])

  function toggle(key: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function adopt(): Promise<void> {
    setBusy(true)
    const result = await bridge.adoptDiskFile(file.id)
    setBusy(false)
    if (!result.ok) {
      showToast(result.message)
      return
    }
    close()
    onResolved()
    showToast(`已以磁盘为准，重新记录 ${result.data.entryCount} 个变量`)
  }

  async function restore(): Promise<void> {
    if (selected.size === 0 || !diff) return
    setBusy(true)
    // 把这份差异对应的磁盘哈希一起送过去：从展示差异到点确认之间文件可能又被改了，
    // 主进程会拿它做并发校验，对不上就中止而不是覆盖别人的修改。
    const result = await bridge.restoreFile(file.id, [...selected], diff.currentHash)
    setBusy(false)
    if (!result.ok) {
      showToast(result.message)
      // 冲突多半是文件又被改了，重新拉一次差异让用户看到新状态。
      void load()
      return
    }
    close()
    onResolved()
    const { written, skipped } = result.data
    showToast(
      skipped.length > 0
        ? `已写回 ${written} 项；${skipped.length} 项文件中不存在，未追加`
        : `已写回 ${written} 项，原文件已备份`
    )
  }

  if (error) {
    return (
      <>
        <p className="modal-copy">{error}</p>
        <div className="modal-actions">
          <button type="button" className="primary-btn" onClick={close}>
            关闭
          </button>
        </div>
      </>
    )
  }

  if (!diff) return <p className="modal-copy">正在对比…</p>

  const actionable = diff.rows.filter((row) => row.status !== 'unchanged')
  // 只有两边都存在的项能写回：磁盘上没有的 key 不会被静默追加。
  const restorable = diff.rows.filter((row) => row.status === 'changed')

  return (
    <>
      <p className="modal-copy">
        <span className="key-name">{diff.relativePath}</span> 在外部被修改。
        {diff.summary.changed} 项值不同、{diff.summary.added} 项磁盘上新增、
        {diff.summary.removed} 项磁盘上已删除，另有 {diff.summary.unchanged} 项一致。
      </p>

      {actionable.length === 0 ? (
        <p className="modal-copy">逐项对比下来没有实际差异，可能只是格式或注释变化。</p>
      ) : (
        <div className="diff-list">
          {actionable.map((row) => (
            <DiffRowView
              key={`${row.key}#${row.occurrence}`}
              row={row}
              selectable={row.status === 'changed'}
              checked={selected.has(row.key)}
              onToggle={() => toggle(row.key)}
            />
          ))}
        </div>
      )}

      <div className="modal-divider" />

      <p className="modal-copy">
        选一个方向。两个操作都会改动数据，写回前会自动备份原文件到应用数据目录。
      </p>

      <div className="modal-actions diff-actions">
        <button type="button" className="outline-btn" onClick={close} disabled={busy}>
          稍后处理
        </button>
        <button type="button" className="outline-btn" onClick={() => void adopt()} disabled={busy}>
          用磁盘覆盖记录
        </button>
        <button
          type="button"
          className="primary-btn"
          onClick={() => void restore()}
          disabled={busy || selected.size === 0}
        >
          用记录覆盖文件（{selected.size}）
        </button>
      </div>

      {restorable.length === 0 && actionable.length > 0 && (
        <p className="modal-note">
          没有可写回的项：只有两边都存在、仅值不同的变量能写回磁盘。
        </p>
      )}
    </>
  )
}

function DiffRowView({
  row,
  selectable,
  checked,
  onToggle
}: {
  row: FileDiffRow
  selectable: boolean
  checked: boolean
  onToggle(): void
}): ReactNode {
  return (
    <label className={selectable ? 'diff-row' : 'diff-row muted'}>
      <input type="checkbox" checked={checked} disabled={!selectable} onChange={onToggle} />
      <div>
        <div className="diff-key">
          {row.key}
          {row.occurrence > 0 && <span className="diff-occurrence">#{row.occurrence + 1}</span>}
        </div>
        <div className="diff-value">{describe(row)}</div>
      </div>
      <span className={`diff-state ${statusTone(row.status)}`}>{statusLabel(row.status)}</span>
    </label>
  )
}

function describe(row: FileDiffRow): string {
  switch (row.status) {
    case 'changed':
      return `记录 ${row.centralPreview} → 文件 ${row.diskPreview}`
    case 'added':
      return `文件里新增 · ${row.diskPreview}${row.lineNumber ? ` · 第 ${row.lineNumber} 行` : ''}`
    case 'removed':
      return `文件里已删除 · 记录中为 ${row.centralPreview}`
    default:
      return '两边一致'
  }
}

const STATUS_LABELS: Record<DiffStatus, string> = {
  changed: '值不同',
  added: '磁盘新增',
  removed: '磁盘删除',
  unchanged: '一致'
}

function statusLabel(status: DiffStatus): string {
  return STATUS_LABELS[status]
}

function statusTone(status: DiffStatus): string {
  return status === 'unchanged' ? 'ok' : ''
}
