import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { bridge } from '../lib/api'
import type { CredentialSummary, CredentialSyncPreview, SyncTarget, SyncTargetState } from '@shared/ipc'

interface CredentialSyncModalProps {
  close(): void
  showToast(message: string): void
  credential: CredentialSummary
  onSynced(): void
}

/**
 * 一改多同步（阶段 3 验收句：「同一个凭据修改一次，可以预览并同步到多个项目」）。
 *
 * 🔴 三条和差异面板同源的规矩：
 *   - 预览**只说哪些地方要改，不说改成什么**。把 Key 铺在一览视图上
 *     等于绕过 reveal 的审计；
 *   - 默认不勾选任何项，写入按钮在没选之前是禁用的；
 *   - 每个目标各自带一个 `expectedHash`（来自这次预览）。它们是不同的文件，
 *     共用一个哈希没有意义，而少了它并发校验就是摆设。
 *
 * 结果**逐个目标报告**：跨文件写入没法原子回滚，第一个写成功第二个冲突时，
 * 报一个笼统的"失败"会让用户以为第一个也没动 —— 而它已经动了。
 */
export function CredentialSyncModal({
  close,
  showToast,
  credential,
  onSynced
}: CredentialSyncModalProps): ReactNode {
  const [preview, setPreview] = useState<CredentialSyncPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set())
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const result = await bridge.previewCredentialSync(credential.id)
    if (result.ok) {
      setPreview(result.data)
      setError(null)
    } else {
      setError(result.message)
    }
  }, [credential.id])

  useEffect(() => {
    void load()
  }, [load])

  function toggle(bindingId: number): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(bindingId)) next.delete(bindingId)
      else next.add(bindingId)
      return next
    })
  }

  async function apply(): Promise<void> {
    if (!preview || selected.size === 0) return
    const targets = preview.targets
      .filter((target) => selected.has(target.bindingId) && target.expectedHash !== null)
      .map((target) => ({ bindingId: target.bindingId, expectedHash: target.expectedHash! }))

    setBusy(true)
    const result = await bridge.syncCredential(credential.id, targets)
    setBusy(false)
    if (!result.ok) {
      showToast(result.message)
      void load()
      return
    }

    const { written, failed, outcomes } = result.data
    onSynced()
    if (failed === 0) {
      close()
      showToast(`已同步 ${written} 处，原文件均已备份`)
      return
    }
    // 有失败就不关弹窗：用户需要看到**哪一个**没成、为什么。
    setSelected(new Set())
    void load()
    const firstFailure = outcomes.find((outcome) => !outcome.ok)
    showToast(
      `同步 ${written} 处，${failed} 处未写入：${firstFailure?.projectName ?? ''} ${firstFailure?.reason ?? ''}`
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

  if (!preview) return <p className="modal-copy">正在检查绑定…</p>

  const writable = preview.targets.filter((target) => target.state === 'outdated')

  return (
    <>
      <p className="modal-copy">
        <span className="key-name">{preview.providerName} / {preview.credentialName}</span>{' '}
        绑定了 {preview.targets.length} 处，其中 {preview.writable} 处需要写入。
        这里只列出「哪些地方要改」，不显示 Key 本身。
      </p>

      {preview.targets.length === 0 ? (
        <p className="modal-copy">这条凭据还没有绑定任何项目环境。</p>
      ) : (
        <div className="diff-list">
          {preview.targets.map((target) => (
            <SyncTargetRow
              key={target.bindingId}
              target={target}
              checked={selected.has(target.bindingId)}
              onToggle={() => toggle(target.bindingId)}
            />
          ))}
        </div>
      )}

      <div className="modal-divider" />

      <p className="modal-copy">
        写入是原子的，每个文件在改动前都会备份到应用数据目录。
        只有勾选的目标会被写入，其余一个字节都不动。
      </p>

      <div className="modal-actions">
        <button type="button" className="outline-btn" onClick={close} disabled={busy}>
          稍后处理
        </button>
        <button
          type="button"
          className="primary-btn"
          data-action="apply-sync"
          onClick={() => void apply()}
          disabled={busy || selected.size === 0}
        >
          写入选中的 {selected.size} 处
        </button>
      </div>

      {writable.length === 0 && preview.targets.length > 0 && (
        <p className="modal-note">
          没有可写入的目标：要么文件里已经是这把 Key，要么文件有未处理的外部改动
          （那种情况要先去「配置总览」处理差异，否则写下去会覆盖别人的修改）。
        </p>
      )}
    </>
  )
}

function SyncTargetRow({
  target,
  checked,
  onToggle
}: {
  target: SyncTarget
  checked: boolean
  onToggle(): void
}): ReactNode {
  const selectable = target.state === 'outdated'
  return (
    <label className={selectable ? 'diff-row' : 'diff-row muted'}>
      <input type="checkbox" checked={checked} disabled={!selectable} onChange={onToggle} />
      <div>
        <div className="diff-key">
          {target.projectName}
          <span className="diff-occurrence">{target.environment}</span>
        </div>
        <div className="diff-value">
          {target.keyVariable}
          {target.relativePath ? ` · ${target.relativePath}` : ' · 找不到对应文件'}
        </div>
      </div>
      <span className={`diff-state ${target.state === 'in-sync' ? 'ok' : ''}`}>
        {STATE_LABELS[target.state]}
      </span>
    </label>
  )
}

const STATE_LABELS: Record<SyncTargetState, string> = {
  'in-sync': '已一致',
  outdated: '待更新',
  'missing-variable': '变量不存在',
  'file-drifted': '文件有改动',
  'file-missing': '文件已丢失'
}
