import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { bridge } from '../lib/api'
import type { EnvFileView, TemplatePreview } from '@shared/ipc'

interface TemplateModalProps {
  close(): void
  showToast(message: string): void
  files: EnvFileView[]
  onWritten(): void
}

/**
 * 生成 `.env.example`（阶段 5b）。
 *
 * 🔴 这是整个应用**唯一一个设计上就要被提交进 Git 的产物**，所以这个弹窗的
 * 职责不只是"点一下生成"，而是让用户在写盘前真的看见将要进版本库的每一行：
 *
 *   - 全文预览，不是摘要。值已经全部清空，所以铺出来是安全的；
 *   - 目标已存在时明确说这是覆盖，并说明原文件会先备份；
 *   - 🔴 兜底检查没过就**根本不给按钮**，不是弹个警告让人点掉。
 *
 * 不做逐变量勾选：`.env.example` 的惯例就是"所有 key 都列出来"，
 * 漏掉一个反而坑人，而"漏选了某个 key"这种错误是静默的。
 */
export function TemplateModal({
  close,
  showToast,
  files,
  onWritten
}: TemplateModalProps): ReactNode {
  /**
   * 能当模板底本的文件：还在磁盘上、且本身不是模板。
   * 拿 `.env.example` 再生成一份 `.env.example` 只会把它自己覆盖成空值版。
   */
  const sources = useMemo(
    () => files.filter((file) => file.currentHash !== null && !file.isTemplate),
    [files]
  )

  /** 默认挑 `.env`；没有就挑变量最多的那份 —— 那份最可能是"变量的全集"。 */
  const defaultId = useMemo(() => {
    const dotEnv = sources.find((file) => file.fileName === '.env')
    if (dotEnv) return dotEnv.id
    return sources.reduce<EnvFileView | null>(
      (best, file) => (best === null || file.entryCount > best.entryCount ? file : best),
      null
    )?.id
  }, [sources])

  const [fileId, setFileId] = useState<number | undefined>(defaultId)
  const [preview, setPreview] = useState<TemplatePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (id: number) => {
    setPreview(null)
    setError(null)
    const result = await bridge.previewTemplate(id)
    if (result.ok) setPreview(result.data)
    else setError(result.message)
  }, [])

  useEffect(() => {
    if (fileId !== undefined) void load(fileId)
  }, [fileId, load])

  async function confirm(): Promise<void> {
    if (fileId === undefined || !preview) return
    setBusy(true)
    // 目标当时的哈希一起送过去；null 表示"那会儿它还不存在"。
    // 从预览到点确认之间目标可能被创建或改动，主进程会拿它兜住。
    const result = await bridge.writeTemplate(fileId, preview.targetHash)
    setBusy(false)
    if (!result.ok) {
      showToast(result.message)
      void load(fileId) // 多半是目标变了，重新预览让用户看到新状态
      return
    }
    close()
    onWritten()
    const { targetRelativePath, entryCount, backupPath } = result.data
    showToast(
      backupPath
        ? `已生成 ${targetRelativePath}（${entryCount} 个变量），原文件已备份`
        : `已生成 ${targetRelativePath}，共 ${entryCount} 个变量`
    )
  }

  if (sources.length === 0) {
    return (
      <>
        <p className="modal-copy">
          这个项目里没有可以当底本的配置文件 —— 需要一份还在磁盘上、且本身不是模板的
          <span className="key-name"> .env*</span> 文件。
        </p>
        <div className="modal-actions">
          <button type="button" className="primary-btn" onClick={close}>
            关闭
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <p className="modal-copy">
        按底本生成一份不含值的 <span className="key-name">.env.example</span>，
        变量名、注释、顺序和格式都保留下来，值全部清空。
      </p>

      <div className="field">
        <label htmlFor="template-source">以哪份文件为底本</label>
        <select
          id="template-source"
          value={fileId ?? ''}
          onChange={(event) => setFileId(Number(event.target.value))}
          disabled={busy}
        >
          {sources.map((file) => (
            <option key={file.id} value={file.id}>
              {file.relativePath}（{file.entryCount} 个变量）
            </option>
          ))}
        </select>
      </div>

      {error && <p className="modal-copy danger-text">{error}</p>}
      {!error && !preview && <p className="modal-copy">正在生成…</p>}

      {preview && (
        <>
          <div className="modal-divider" />

          <p className="modal-copy">
            将写入 <span className="key-name">{preview.targetRelativePath}</span>
            {preview.targetExists ? (
              <> —— 该文件<strong>已存在，会被覆盖</strong>，原文件先自动备份到应用数据目录。</>
            ) : (
              <> —— 新建文件。</>
            )}
          </p>

          {preview.droppedLines > 0 && (
            <p className="modal-note">
              有 {preview.droppedLines} 行没能解析成配置或注释，已略去 ——
              读不懂的内容不放进要提交的文件里。
            </p>
          )}

          {preview.leaks.length > 0 && (
            <div className="template-blocked" data-testid="template-leaks">
              <strong>已中止：生成结果里仍然能搜到源文件的敏感值。</strong>
              <p>
                位置：
                {preview.leaks.map((leak) => `第 ${leak.lineNumber} 行（${leak.key}）`).join('、')}
                。多半是注释里写着一段带值的说明，而它不是「像赋值」的写法，
                自动脱敏够不着。请先改掉源文件里的那几行，再回来生成。
              </p>
            </div>
          )}

          <div className="template-preview">
            <div className="template-preview-head">
              预览 · {preview.entryCount} 个变量
            </div>
            {/* 值已经全部清空，所以整段铺出来不违反明文边界。 */}
            <pre className="template-preview-body">{preview.content}</pre>
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
          disabled={busy || !preview || preview.leaks.length > 0}
        >
          {busy ? '写入中…' : preview?.targetExists ? '覆盖并写入' : '生成文件'}
        </button>
      </div>
    </>
  )
}
