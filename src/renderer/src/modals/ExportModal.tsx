import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { bridge } from '../lib/api'
import type { ExportPreview } from '@shared/ipc'

interface ExportModalProps {
  close(): void
  showToast(message: string): void
}

/**
 * 加密导出（阶段 5c）。
 *
 * 🔴 这是全应用**最宽的一条明文出口**：前面几条一次放走一个值或一个环境，
 * 这里一次放走选中项目的全部值，勾上凭据还会带走全部模型 Key。
 * 所以这个弹窗的职责不是"少点几下"，而是让用户在按下去之前清楚知道
 * 自己正在把什么装进一个文件里：
 *
 *   - 项目逐个勾，默认全不勾 —— 不替用户决定导出范围；
 *   - 凭据单独一个开关，默认关，打开时另给一句警示；
 *   - 口令输两遍，不一致不给导；
 *   - 底部实时算出"这一次会带走多少个值"。
 *
 * 不提供"不加密导出"。规格 §7 只说「优先导出加密包」并未禁止明文，
 * 但明文导出是一条真正的明文出口，而用户已经有两条合法途径拿到值
 * （逐变量 reveal、CLI 注入）。要做也该单独想清楚，见 PHASE-5C §6。
 */
export function ExportModal({ close, showToast }: ExportModalProps): ReactNode {
  const [preview, setPreview] = useState<ExportPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set())
  const [includeCredentials, setIncludeCredentials] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [confirmPassphrase, setConfirmPassphrase] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const result = await bridge.previewExport()
    if (result.ok) setPreview(result.data)
    else setError(result.message)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function toggle(projectId: number): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

  const entryTotal = useMemo(
    () =>
      (preview?.projects ?? [])
        .filter((project) => selected.has(project.projectId))
        .reduce((sum, project) => sum + project.entryCount, 0),
    [preview, selected]
  )

  const mismatch = confirmPassphrase.length > 0 && passphrase !== confirmPassphrase
  const ready =
    selected.size > 0 && passphrase.length > 0 && passphrase === confirmPassphrase && !busy

  async function confirm(): Promise<void> {
    if (!ready) return
    setBusy(true)
    const result = await bridge.exportPackage({
      projectIds: [...selected],
      includeCredentials,
      passphrase
    })
    setBusy(false)
    if (!result.ok) {
      showToast(result.message)
      return
    }
    if (result.data === null) return // 用户在保存对话框里取消了，留在弹窗里
    close()
    const { projectCount, entryCount, credentialCount, targetPath } = result.data
    showToast(
      `已导出 ${projectCount} 个项目、${entryCount} 个变量` +
        (credentialCount > 0 ? `、${credentialCount} 条凭据` : '') +
        ` → ${targetPath}`
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

  if (!preview) return <p className="modal-copy">正在读取…</p>

  return (
    <>
      <p className="modal-copy">
        把选中项目的配置封成一个<strong>口令加密</strong>的包。包里是明文值，
        安全性完全取决于你设的口令 —— 它没有第二道锁，也没有找回途径。
      </p>

      {preview.projects.length === 0 ? (
        <p className="modal-copy">还没有纳管任何项目，没有可导出的内容。</p>
      ) : (
        <div className="diff-list">
          {preview.projects.map((project) => (
            <label className="diff-row" key={project.projectId}>
              <input
                type="checkbox"
                checked={selected.has(project.projectId)}
                onChange={() => toggle(project.projectId)}
                disabled={busy}
              />
              <div>
                <div className="diff-key">{project.name}</div>
                <div className="diff-value">
                  {project.fileCount} 个文件 · {project.entryCount} 个变量 ·{' '}
                  {project.absolutePath}
                </div>
              </div>
            </label>
          ))}
        </div>
      )}

      {preview.credentialCount > 0 && (
        <>
          <div className="modal-divider" />
          <label className="check-row">
            <input
              type="checkbox"
              checked={includeCredentials}
              onChange={(event) => setIncludeCredentials(event.target.checked)}
              disabled={busy}
            />
            <span>
              一并导出 {preview.credentialCount} 条模型凭据的 Key
              {includeCredentials && (
                <strong className="danger-text">
                  {' '}
                  —— 这个包将装着你全部的模型 Key，口令弱一点代价就大很多。
                </strong>
              )}
            </span>
          </label>
        </>
      )}

      <div className="modal-divider" />

      <div className="form-grid two">
        <div className="field">
          <label htmlFor="export-passphrase">口令</label>
          <input
            id="export-passphrase"
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            disabled={busy}
            autoComplete="new-password"
          />
        </div>
        <div className="field">
          <label htmlFor="export-passphrase-confirm">再输一遍</label>
          <input
            id="export-passphrase-confirm"
            type="password"
            value={confirmPassphrase}
            onChange={(event) => setConfirmPassphrase(event.target.value)}
            disabled={busy}
            autoComplete="new-password"
          />
        </div>
      </div>

      {mismatch && <p className="modal-note danger-text">两次输入不一致。</p>}
      <p className="modal-note">
        口令不会被保存在任何地方 —— 忘了就打不开这个包了，我们也帮不上忙。
      </p>

      <div className="modal-actions">
        <button type="button" className="outline-btn" onClick={close} disabled={busy}>
          取消
        </button>
        <button
          type="button"
          className="primary-btn"
          onClick={() => void confirm()}
          disabled={!ready}
          data-testid="export-confirm"
        >
          {busy ? '加密中…' : `导出 ${selected.size} 个项目（${entryTotal} 个变量）`}
        </button>
      </div>
    </>
  )
}
