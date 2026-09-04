/**
 * 在弹窗里查看并修改一个变量的值。
 *
 * ## 和表格里那个行内编辑器的关系
 *
 * 它**不替代**行内编辑，是补充。行内那个适合改一个短值，但值列只有三成宽，
 * 一个 200 字符的连接串在里面根本读不了，更别说改。弹窗给的是完整宽度、
 * 多行、以及「先看清楚再动手」的余地。
 *
 * ## 🔴 明文只能从 revealEntry 来
 *
 * 这是整个文件最要紧的一条。`entries:reveal` 是唯一返回明文的通道，而它每次
 * 调用都写一条 `entry.reveal` 审计。DeleteEntryModal 特意不显示被删的值，
 * 就是为了不开一条绕过审计的口子（见那个文件顶部）—— 同一条规矩在这里
 * 同样成立：弹窗不接受外部塞进来的明文，要看值就自己去调 revealEntry，
 * 让这次查看和表格里点「显示」留下一模一样的痕迹。
 *
 * ## 盲写语义要原样搬过来
 *
 * 敏感项在用户点「显示」之前，输入框是**空的**，而这个空**不等于「清空该值」**，
 * 只等于「还没输入」。所以盲写状态下空草稿不许提交 —— 否则用户打开弹窗、
 * 顺手点了保存，就把一把 Key 抹成了空串。真要清空，先点显示再删干净。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { bridge } from '../lib/api'
import { ModalActions } from '../state/modal'
import { IconEye, IconEyeOff } from '../components/icons'
import type { ConfigEntryView } from '@shared/ipc'

interface EntryValueModalProps {
  entry: ConfigEntryView
  /** 用户看到这一行时文件的磁盘哈希。调用方保证非 null。 */
  expectedHash: string
  /** 非 null 时只读，并把原因显示出来。 */
  editBlockedReason: string | null
  close(): void
  showToast(message: string): void
  onSaved(): void
}

export function EntryValueModal({
  entry,
  expectedHash,
  editBlockedReason,
  close,
  showToast,
  onSaved
}: EntryValueModalProps): ReactNode {
  /** 已经点开显示过的明文。null = 还没显示过。 */
  const [plain, setPlain] = useState<string | null>(null)
  const [revealing, setRevealing] = useState(false)
  const [saving, setSaving] = useState(false)

  // 非敏感项的值本来就在 displayValue 里（没掩码），直接当初值。
  // 敏感项一律从空开始 —— 盲写。
  const [draft, setDraft] = useState(entry.masked ? '' : entry.displayValue)

  const blindWrite = entry.masked && plain === null
  const readOnly = editBlockedReason !== null

  const reveal = useCallback(async () => {
    if (plain !== null) {
      // 收起来：草稿里可能已经有用户改了一半的内容，不能一起抹掉，
      // 只把「我们知道原值」这件事撤销 —— 于是又回到盲写。
      setPlain(null)
      return
    }
    setRevealing(true)
    const result = await bridge.revealEntry(entry.id)
    setRevealing(false)
    if (!result.ok) {
      showToast(result.message)
      return
    }
    setPlain(result.data.value)
    // 只有草稿还没被动过（盲写状态下是空的）才预填，
    // 否则会把用户已经输入的内容冲掉。
    setDraft((current) => (current === '' ? result.data.value : current))
  }, [entry.id, plain, showToast])

  async function submit(): Promise<void> {
    if (readOnly) return
    if (blindWrite && draft === '') {
      showToast('原值没有显示出来，空的输入框不会被当成「清空」')
      return
    }

    setSaving(true)
    const result = await bridge.updateEntry(entry.id, draft, expectedHash)
    setSaving(false)
    if (!result.ok) {
      showToast(result.message)
      return
    }

    close()
    onSaved()
    showToast(
      result.data.written
        ? `已更新 ${entry.key} 并写回 ${entry.sourceFile}，原文件已备份`
        : '值没有变化，文件未改动'
    )
  }

  // Esc 由弹窗宿主统一处理，这里只管 Ctrl+Enter 这个「大输入框里的提交」惯例。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !readOnly && !saving) {
        void submit()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="entry-modal-meta">
        <span className="key-name">{entry.key}</span>
        <span className={`type-tag ${entry.valueType}`}>{entry.valueType}</span>
        <span className="source-tag">{entry.sourceFile}</span>
      </div>

      {readOnly && <p className="modal-copy">{editBlockedReason}</p>}

      {!readOnly && blindWrite && (
        <p className="modal-copy">
          这是敏感项，原值默认不显示。直接输入就是覆盖成新值；想在原值基础上改，
          先点「显示原值」—— 那一下会记进操作记录。
        </p>
      )}

      <div className="field">
        <label htmlFor="entry-value">
          {blindWrite ? '新值' : '值'}
          {entry.masked && (
            <button
              type="button"
              className="link-btn"
              data-action="modal-reveal"
              disabled={revealing}
              onClick={() => void reveal()}
            >
              {plain === null ? <IconEye size={12} /> : <IconEyeOff size={12} />}
              {revealing ? '读取中…' : plain === null ? '显示原值' : '隐藏原值'}
            </button>
          )}
        </label>
        <textarea
          id="entry-value"
          className="value-textarea"
          rows={5}
          spellCheck={false}
          readOnly={readOnly}
          value={draft}
          placeholder={blindWrite ? '输入新值（原值未显示）' : undefined}
          onChange={(event) => setDraft(event.target.value)}
        />
        <small>
          {readOnly
            ? '当前不可修改。'
            : '保存会写回磁盘文件，原文件自动备份。Ctrl+Enter 也可提交。'}
        </small>
      </div>

      {readOnly ? (
        <div className="modal-actions">
          <button type="button" className="outline-btn" onClick={close}>
            关闭
          </button>
        </div>
      ) : (
        <ModalActions
          submitText={saving ? '保存中…' : '保存并写回文件'}
          onCancel={close}
          submitDisabled={saving || (blindWrite && draft === '')}
        />
      )}
    </form>
  )
}
