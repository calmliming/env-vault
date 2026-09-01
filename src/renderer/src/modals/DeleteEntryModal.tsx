import { useState } from 'react'
import type { ReactNode } from 'react'
import { bridge } from '../lib/api'
import type { ConfigEntryView } from '@shared/ipc'

interface DeleteEntryModalProps {
  close(): void
  showToast(message: string): void
  entry: ConfigEntryView
  /** 用户看到这一行时文件的磁盘哈希，交给主进程做并发校验。 */
  expectedHash: string
  onDeleted(): void
}

/**
 * 删除单个变量的确认框。
 *
 * 删除会同时改动中心记录和用户的 `.env` 文件，所以：
 *   - 说清楚会动哪个文件，而不是笼统的「确认删除吗」；
 *   - 按钮文案直说会发生什么，不用「确定」这种两边都说得通的词；
 *   - 🔴 不显示被删变量的值。删除不需要看见值，而这里显示等于开了一条
 *     绕过 reveal 审计的读明文路径（§5.5）。掩码占位符也不放 —— 没有意义。
 */
export function DeleteEntryModal({
  close,
  showToast,
  entry,
  expectedHash,
  onDeleted
}: DeleteEntryModalProps): ReactNode {
  const [busy, setBusy] = useState(false)

  async function confirm(): Promise<void> {
    setBusy(true)
    const result = await bridge.deleteEntry(entry.id, expectedHash)
    setBusy(false)
    if (!result.ok) {
      showToast(result.message)
      return
    }
    close()
    onDeleted()
    showToast(
      result.data.written
        ? `已删除 ${entry.key}，${entry.sourceFile} 里的那一行也已移除，原文件已备份`
        : `已删除 ${entry.key} 的记录；${entry.sourceFile} 里本来就没有这一行`
    )
  }

  return (
    <>
      <p className="modal-copy">
        将从中心记录里删除 <span className="key-name">{entry.key}</span>，
        并把 <span className="key-name">{entry.sourceFile}</span> 里的那一行一起删掉。
      </p>
      <p className="modal-copy">
        文件里的其余内容一个字节都不会动，注释和空行都保留。
        写入前会自动备份原文件到应用数据目录，备份不放在你的项目里。
      </p>
      <div className="modal-actions">
        <button type="button" className="outline-btn" onClick={close} disabled={busy}>
          取消
        </button>
        <button type="button" className="danger-btn" onClick={() => void confirm()} disabled={busy}>
          {busy ? '删除中…' : '删除变量并改写文件'}
        </button>
      </div>
    </>
  )
}
