import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { ModalActions } from '../state/modal'
import { bridge } from '../lib/api'
import type { ScanPreview } from '@shared/ipc'

interface ProjectModalProps {
  close(): void
  showToast(message: string): void
  /** 导入成功后回调，参数是新项目 id。 */
  onImported(projectId: number): void
}

/**
 * 「添加项目」两步流程，对应开发计划 §6.1 步骤 1~5。
 *
 * 🔴 扫描与入库是两次独立的 IPC，中间隔着用户确认。这不是为了好看：
 * §6.1 步骤 3 明确要求「展示发现的文件和变量数量，**不立即修改文件**」。
 * 预览走 `projects:preview`（主进程侧纯只读），确认后才走 `projects:import`。
 *
 * 模板文件（`.env.example` 等）默认**不勾选** —— 它们的值是占位符，
 * 纳管进来只会在配置总览里制造一堆空值噪声。用户想要仍然可以勾上。
 */
export function ProjectModal({ close, showToast, onImported }: ProjectModalProps): ReactNode {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [preview, setPreview] = useState<ScanPreview | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState<'idle' | 'picking' | 'scanning' | 'importing'>('idle')

  async function chooseDirectory(): Promise<void> {
    setBusy('picking')
    const picked = await bridge.selectDirectory('选择项目根目录')
    if (!picked.ok) {
      setBusy('idle')
      showToast(picked.message)
      return
    }
    if (picked.data.canceled || !picked.data.path) {
      setBusy('idle')
      return
    }
    await runPreview(picked.data.path)
  }

  async function runPreview(rootPath: string): Promise<void> {
    setBusy('scanning')
    const result = await bridge.previewProject(rootPath)
    setBusy('idle')

    if (!result.ok) {
      setPreview(null)
      showToast(result.message)
      return
    }

    setPath(result.data.rootPath)
    setPreview(result.data)
    setName((current) => current.trim() || result.data.suggestedName)
    // 默认勾选非模板且可读的文件
    setSelected(
      new Set(
        result.data.files
          .filter((file) => !file.isTemplate && file.error === null)
          .map((file) => file.absolutePath)
      )
    )

    if (result.data.files.length === 0) {
      showToast('这个目录下没有找到 .env* 文件')
    }
  }

  function toggle(absolutePath: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(absolutePath)) next.delete(absolutePath)
      else next.add(absolutePath)
      return next
    })
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!preview || selected.size === 0) return

    setBusy('importing')
    const result = await bridge.importProject({
      rootPath: preview.rootPath,
      name: name.trim() || preview.suggestedName,
      includePaths: [...selected]
    })
    setBusy('idle')

    if (!result.ok) {
      showToast(result.message)
      return
    }
    close()
    onImported(result.data.id)
    showToast(`已纳管 ${result.data.name}：${result.data.fileCount} 个文件、${result.data.entryCount} 个变量`)
  }

  const selectedEntryCount =
    preview?.files
      .filter((file) => selected.has(file.absolutePath))
      .reduce((sum, file) => sum + file.entryCount, 0) ?? 0

  return (
    <>
      <p className="modal-copy">
        选择项目根目录后，EnvVault 会查找所有 .env* 文件并显示扫描结果。
        在你确认之前不会写入任何记录，磁盘上的文件也不会被改动。
      </p>

      <form onSubmit={(event) => void onSubmit(event)}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="project-path">项目路径</label>
            <div className="path-picker">
              <input
                id="project-path"
                placeholder="点右侧按钮选择目录"
                required
                readOnly
                value={path}
                data-selected={path ? 'true' : undefined}
              />
              <button
                type="button"
                className="outline-btn"
                onClick={() => void chooseDirectory()}
                disabled={busy !== 'idle'}
              >
                {busy === 'picking' ? '选择中…' : busy === 'scanning' ? '扫描中…' : '选择目录'}
              </button>
            </div>
            <small>
              {preview
                ? `Git 仓库 · ${preview.gitRoot ?? '未发现'}`
                : '路径由系统对话框返回，渲染层不能自己拼路径。'}
            </small>
          </div>

          {preview && (
            <div className="field">
              <label htmlFor="project-name">项目名称</label>
              <input id="project-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          )}
        </div>

        {preview && (
          <>
            <div className="modal-divider" />

            {preview.alreadyImported && (
              <p className="modal-copy">这个目录已经在管理中，无法重复添加。</p>
            )}

            {preview.truncated && (
              <p className="modal-copy">
                目录很大，扫描在达到上限后停止，下面可能不是全部文件。
              </p>
            )}

            {preview.files.length === 0 ? (
              <p className="modal-copy">没有找到 .env* 文件。</p>
            ) : (
              <>
                <div className="scan-summary">
                  发现 {preview.files.length} 个文件 · 共 {preview.totalEntries} 个变量 ·
                  已选 {selected.size} 个文件 / {selectedEntryCount} 个变量
                </div>
                <div className="diff-list">
                  {preview.files.map((file) => (
                    <label className="diff-row" key={file.absolutePath}>
                      <input
                        type="checkbox"
                        checked={selected.has(file.absolutePath)}
                        disabled={file.error !== null || preview.alreadyImported}
                        onChange={() => toggle(file.absolutePath)}
                      />
                      <div>
                        <div className="diff-key">{file.relativePath}</div>
                        <div className="diff-value">
                          {file.error
                            ? file.error
                            : `${file.environment} · ${file.entryCount} 个变量`}
                        </div>
                      </div>
                      <span className={file.isTemplate ? 'diff-state' : 'diff-state ok'}>
                        {file.isTemplate ? '模板' : file.environment}
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        <ModalActions
          cancelText="取消"
          submitText={busy === 'importing' ? '导入中…' : '导入并纳管'}
          onCancel={close}
          submitDisabled={
            !preview || preview.alreadyImported || selected.size === 0 || busy !== 'idle'
          }
        />
      </form>
    </>
  )
}
