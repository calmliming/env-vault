import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { bridge } from '../lib/api'
import type { ImportPreview } from '@shared/ipc'

interface ImportModalProps {
  close(): void
  showToast(message: string): void
  onImported(): void
}

/** 和主进程 `db/transfer.ts` 的 `fileKeyOf` 必须一致。分隔符是 NUL。 */
const KEY_SEPARATOR = String.fromCharCode(0)
const fileKeyOf = (projectPath: string, relativePath: string): string =>
  projectPath + KEY_SEPARATOR + relativePath

/**
 * 导入加密导出包（阶段 5c）。
 *
 * 三步：选包 → 输口令 → 逐文件确认要导哪些。
 *
 * 🔴 导入**只写中心记录，不碰磁盘上的 .env**。这一点必须在界面上说出来，
 * 否则用户会以为导入等于"文件也恢复了"。要落到磁盘，走既有的
 * 「处理差异 → 以记录为准写回」，那条路自带备份和并发校验。
 *
 * 合并是**只增不删**：包里有的补进来或更新，本机独有的变量不动。
 * 所以这不是"恢复到快照那一刻" —— 备份之后删掉的变量不会因为导入而回来。
 * 说清楚，因为"以为恢复了其实没恢复"比"没恢复"更糟。
 */
export function ImportModal({ close, showToast, onImported }: ImportModalProps): ReactNode {
  const [sourcePath, setSourcePath] = useState<string | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<ReadonlySet<string>>(new Set())
  const [selectedCredentials, setSelectedCredentials] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)

  async function pick(): Promise<void> {
    setError(null)
    const result = await bridge.pickPackage()
    if (!result.ok) {
      setError(result.message)
      return
    }
    if (result.data === null) return
    setSourcePath(result.data.sourcePath)
    setPreview(null)
  }

  async function unlock(): Promise<void> {
    if (!sourcePath || passphrase.length === 0) return
    setBusy(true)
    setError(null)
    const result = await bridge.previewImport(sourcePath, passphrase)
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setPreview(result.data)
    // 默认全不勾：导入会改中心记录，不替用户决定改哪些。
    setSelectedFiles(new Set())
    setSelectedCredentials(new Set())
  }

  function toggleFile(key: string): void {
    setSelectedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const summary = useMemo(() => {
    if (!preview) return { added: 0, changed: 0 }
    let added = 0
    let changed = 0
    for (const project of preview.projects) {
      for (const file of project.files) {
        if (!selectedFiles.has(fileKeyOf(project.absolutePath, file.relativePath))) continue
        added += file.addedCount
        changed += file.changedCount
      }
    }
    return { added, changed }
  }, [preview, selectedFiles])

  async function confirm(): Promise<void> {
    if (!sourcePath || selectedFiles.size + selectedCredentials.size === 0) return
    setBusy(true)
    const result = await bridge.importPackage({
      sourcePath,
      passphrase,
      fileKeys: [...selectedFiles],
      credentialNames: [...selectedCredentials]
    })
    setBusy(false)
    if (!result.ok) {
      showToast(result.message)
      return
    }
    close()
    onImported()
    const { projectsCreated, entriesAdded, entriesUpdated, credentialsCreated } = result.data
    showToast(
      `已导入：新增 ${projectsCreated} 个项目、${entriesAdded} 个变量，更新 ${entriesUpdated} 个` +
        (credentialsCreated > 0 ? `，新增 ${credentialsCreated} 条凭据` : '') +
        '。磁盘文件未改动。'
    )
  }

  return (
    <>
      <p className="modal-copy">
        从一个加密导出包恢复配置。<strong>导入只写中心记录，不会改动磁盘上的 .env 文件</strong>
        —— 要把值落到文件，导入后走「处理差异 → 以记录为准写回」。
      </p>

      <div className="field">
        <label htmlFor="import-source">导出包</label>
        <div className="path-picker">
          <input
            id="import-source"
            readOnly
            value={sourcePath ?? ''}
            placeholder="还没有选择文件"
            data-selected={sourcePath ? 'true' : 'false'}
          />
          <button type="button" className="outline-btn" onClick={() => void pick()} disabled={busy}>
            选择…
          </button>
        </div>
      </div>

      {sourcePath && !preview && (
        <>
          <div className="field form-grid spaced">
            <label htmlFor="import-passphrase">口令</label>
            <input
              id="import-passphrase"
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              disabled={busy}
              autoComplete="current-password"
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="outline-btn" onClick={close} disabled={busy}>
              取消
            </button>
            <button
              type="button"
              className="primary-btn"
              onClick={() => void unlock()}
              disabled={busy || passphrase.length === 0}
            >
              {busy ? '解包中…' : '解开并预览'}
            </button>
          </div>
        </>
      )}

      {error && <p className="modal-copy danger-text">{error}</p>}

      {preview && (
        <>
          <div className="modal-divider" />
          <p className="modal-copy">
            这个包导出于 {new Date(preview.exportedAt).toLocaleString()}。勾选要导入的文件 ——
            <strong>合并是只增不删</strong>：包里有的会补进来或更新，本机独有的变量不动。
          </p>

          {preview.projects.map((project) => (
            <div key={project.absolutePath} className="transfer-project">
              <div className="transfer-project-head">
                <span className="diff-key">{project.name}</span>
                <span className={project.status === 'new' ? 'diff-state' : 'diff-state ok'}>
                  {project.status === 'new' ? '新项目' : '已存在'}
                </span>
              </div>
              <div className="transfer-project-path">{project.absolutePath}</div>
              {!project.rootExistsOnDisk && (
                <p className="modal-note">
                  这个目录在本机不存在（多半是从另一台机器导出的）。记录照样能导进来，
                  但在你把项目移到这个路径、或重新添加项目之前，它们没有对应的磁盘文件。
                </p>
              )}
              <div className="diff-list">
                {project.files.map((file) => {
                  const key = fileKeyOf(project.absolutePath, file.relativePath)
                  return (
                    <label className="diff-row" key={key}>
                      <input
                        type="checkbox"
                        checked={selectedFiles.has(key)}
                        onChange={() => toggleFile(key)}
                        disabled={busy}
                      />
                      <div>
                        <div className="diff-key">{file.relativePath}</div>
                        <div className="diff-value">
                          {file.status === 'new'
                            ? `全新 · ${file.addedCount} 个变量`
                            : `新增 ${file.addedCount} · 值不同 ${file.changedCount} · 相同 ${file.sameCount}`}
                        </div>
                      </div>
                      <span className={file.status === 'new' ? 'diff-state' : 'diff-state ok'}>
                        {file.status === 'new' ? '新增' : '合并'}
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
          ))}

          {preview.credentials.length > 0 && (
            <>
              <div className="modal-divider" />
              <p className="modal-copy">
                包里还有 {preview.credentials.length} 条模型凭据。
                导入后<strong>不会自动重建绑定关系</strong> ——
                目标机器上的项目和环境可能对不上，猜错一次就是把一把 Key
                绑到错的文件上，而下一次同步会真的写下去。
              </p>
              <div className="diff-list">
                {preview.credentials.map((credential) => (
                  <label className="diff-row" key={credential.credentialName}>
                    <input
                      type="checkbox"
                      checked={selectedCredentials.has(credential.credentialName)}
                      onChange={() =>
                        setSelectedCredentials((prev) => {
                          const next = new Set(prev)
                          if (next.has(credential.credentialName))
                            next.delete(credential.credentialName)
                          else next.add(credential.credentialName)
                          return next
                        })
                      }
                      disabled={busy || credential.status === 'existing'}
                    />
                    <div>
                      <div className="diff-key">{credential.credentialName}</div>
                      <div className="diff-value">
                        {credential.providerName} · 尾号 {credential.lastFour || '（太短，不显示）'}{' '}
                        · 原有 {credential.bindingCount} 处绑定
                      </div>
                    </div>
                    <span className={credential.status === 'new' ? 'diff-state' : 'diff-state ok'}>
                      {credential.status === 'new' ? '新增' : '已存在，跳过'}
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}

          <div className="modal-actions">
            <button type="button" className="outline-btn" onClick={close} disabled={busy}>
              取消
            </button>
            <button
              type="button"
              className="primary-btn"
              onClick={() => void confirm()}
              disabled={busy || selectedFiles.size + selectedCredentials.size === 0}
              data-testid="import-confirm"
            >
              {busy
                ? '导入中…'
                : `导入（新增 ${summary.added} 个变量、更新 ${summary.changed} 个）`}
            </button>
          </div>
        </>
      )}
    </>
  )
}
