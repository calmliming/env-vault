import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { bridge } from '../lib/api'
import type { Workspace } from '../hooks/useWorkspace'
import type { ConfigEntryView, EnvFileView } from '@shared/ipc'

interface OverviewViewProps {
  workspace: Workspace
  query: string
  onQueryChange(query: string): void
  onAddProject(): void
  onOpenSync(): void
  onOpenDiff(file: EnvFileView): void
  onVaultAction(): void
  showToast(message: string): void
}

export function OverviewView({
  workspace,
  query,
  onQueryChange,
  onAddProject,
  onOpenSync,
  onOpenDiff,
  onVaultAction,
  showToast
}: OverviewViewProps): ReactNode {
  const { selectedProject, entries, files, environment, setEnvironment, locked, loading, error } =
    workspace

  /**
   * 已经点开显示的条目：id → 明文。
   * 明文只活在这个 map 里，切项目/切环境时随组件重挂载一起消失 ——
   * 不写进任何持久层，也不放进 workspace 那种跨视图共享的 state。
   */
  const [revealed, setRevealed] = useState<ReadonlyMap<number, string>>(new Map())
  const [rescanning, setRescanning] = useState(false)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return entries
    // 按 key + 来源文件 + 类型匹配。不匹配 displayValue：
    // 敏感项的 displayValue 是掩码占位符，拿它做匹配等于全体命中或全体落空。
    return entries.filter((entry) =>
      `${entry.key} ${entry.sourceFile} ${entry.valueType} ${entry.environment}`
        .toLowerCase()
        .includes(needle)
    )
  }, [entries, query])

  async function toggleReveal(entry: ConfigEntryView): Promise<void> {
    if (revealed.has(entry.id)) {
      setRevealed((prev) => {
        const next = new Map(prev)
        next.delete(entry.id)
        return next
      })
      showToast('敏感值已隐藏')
      return
    }

    const result = await bridge.revealEntry(entry.id)
    if (!result.ok) {
      showToast(result.message)
      return
    }
    setRevealed((prev) => new Map(prev).set(entry.id, result.data.value))
    showToast('敏感值已临时显示，本次操作已记入操作记录')
  }

  async function copyValue(entry: ConfigEntryView): Promise<void> {
    // 非敏感项的明文本来就在 displayValue 里，但仍然统一走 reveal ——
    // 这样"复制"这个动作在操作记录里不会漏记（§5.5）。
    const result = await bridge.revealEntry(entry.id)
    if (!result.ok) {
      showToast(result.message)
      return
    }
    try {
      await navigator.clipboard.writeText(result.data.value)
      showToast('已复制到剪贴板，自动清理将在阶段 4 接入')
    } catch {
      showToast('复制失败，请检查系统剪贴板权限')
    }
  }

  async function rescan(): Promise<void> {
    if (!selectedProject) return
    setRescanning(true)
    const result = await bridge.rescanProject(selectedProject.id)
    setRescanning(false)

    if (!result.ok) {
      showToast(result.message)
      return
    }
    await workspace.reloadProjects(selectedProject.id)
    await workspace.reloadCurrent()
    const { addedFiles, updatedFiles, missingFiles } = result.data
    showToast(
      addedFiles + updatedFiles + missingFiles === 0
        ? '扫描完成：没有变化'
        : `扫描完成：新增 ${addedFiles}、更新 ${updatedFiles}、缺失 ${missingFiles}`
    )
  }

  // --- 空态 -----------------------------------------------------------------

  if (!selectedProject) {
    return (
      <section>
        <PageHead
          eyebrow="配置总览"
          title="还没有项目"
          subtitle="选择任意一个包含 .env* 文件的目录，EnvVault 会先扫描并展示结果，再由你决定纳管哪些文件。"
        />
        <div className="empty-section">
          <h2>从添加一个项目开始</h2>
          <p>项目不需要位于同一个父目录，扫描过程只读，不会修改磁盘上的任何文件。</p>
          <div className="empty-actions">
            <button className="primary-btn" onClick={onAddProject}>
              + 添加项目
            </button>
          </div>
        </div>
      </section>
    )
  }

  const driftedFiles = files.filter((file) => file.drifted)

  return (
    <section>
      <div className="page-head">
        <div>
          <div className="eyebrow">项目配置 · {selectedProject.name}</div>
          <h1>{environment ?? '全部环境'}</h1>
          <p className="page-subtitle" title={selectedProject.absolutePath}>
            {selectedProject.absolutePath}
          </p>
        </div>
        <div className="head-actions">
          <button className="outline-btn" onClick={() => void rescan()} disabled={rescanning || locked}>
            {rescanning ? '扫描中…' : '重新扫描'}
          </button>
          <button className="outline-btn" onClick={onOpenSync} disabled={locked}>
            同步到文件
          </button>
        </div>
      </div>

      <div className="metrics">
        <Metric label="已记录变量" value={selectedProject.entryCount} />
        <Metric label="配置文件" value={selectedProject.fileCount} />
        <Metric
          label="待处理差异"
          value={driftedFiles.length}
          note={driftedFiles.length > 0 ? '需看' : '一致'}
          warn={driftedFiles.length > 0}
        />
        <Metric
          label="Git 仓库"
          value={selectedProject.gitRoot ? 1 : 0}
          note={selectedProject.gitRoot ? '已识别' : '未发现'}
          warn={!selectedProject.gitRoot}
        />
      </div>

      <div className="workspace-grid">
        <section className="panel table-panel">
          <div className="panel-head">
            <div>
              <div className="panel-title">环境变量</div>
              <div className="panel-kicker">
                {filtered.length} / {entries.length} 项
              </div>
            </div>
            <div className="env-tabs" role="tablist" aria-label="环境">
              <button
                role="tab"
                aria-selected={environment === null}
                className={environment === null ? 'env-tab active' : 'env-tab'}
                onClick={() => setEnvironment(null)}
              >
                全部
              </button>
              {selectedProject.environments.map((env) => (
                <button
                  key={env}
                  role="tab"
                  aria-selected={env === environment}
                  className={env === environment ? 'env-tab active' : 'env-tab'}
                  onClick={() => setEnvironment(env)}
                >
                  {env}
                </button>
              ))}
            </div>
          </div>

          <div className="table-tools">
            <label className="search">
              <span aria-hidden="true">⌕</span>
              <span className="sr-only">搜索变量</span>
              <input
                placeholder="搜索变量名或来源"
                value={query}
                onChange={(e) => onQueryChange(e.target.value)}
              />
            </label>
            <span className="tool-note">
              {locked
                ? 'Vault 已锁定'
                : driftedFiles.length > 0
                  ? `${driftedFiles.length} 个文件与记录不一致`
                  : '已与本地文件保持一致'}
            </span>
          </div>

          <table className="config-table">
            <thead>
              <tr>
                <th className="col-key">变量名</th>
                <th className="col-value">值</th>
                <th className="col-type">类型</th>
                <th className="col-source">来源</th>
                <th className="col-status">状态</th>
              </tr>
            </thead>
            <tbody>
              {locked && (
                <tr>
                  <td className="empty-row" colSpan={5}>
                    Vault 已锁定，解锁后才能读取配置值。
                    <button className="link-btn" onClick={onVaultAction}>
                      去解锁
                    </button>
                  </td>
                </tr>
              )}
              {!locked && error && (
                <tr>
                  <td className="empty-row" colSpan={5}>
                    {error}
                  </td>
                </tr>
              )}
              {!locked && !error && loading && (
                <tr>
                  <td className="empty-row" colSpan={5}>
                    读取中…
                  </td>
                </tr>
              )}
              {!locked && !error && !loading && filtered.length === 0 && (
                <tr>
                  <td className="empty-row" colSpan={5}>
                    {entries.length === 0 ? '这个环境下没有变量' : `没有匹配「${query}」的变量`}
                  </td>
                </tr>
              )}
              {!locked &&
                !error &&
                filtered.map((entry) => {
                  const plain = revealed.get(entry.id)
                  const shown = plain ?? entry.displayValue
                  return (
                    <tr key={entry.id}>
                      <td>
                        <div className="key-name" title={entry.key}>
                          {entry.key}
                        </div>
                      </td>
                      <td>
                        <div className="value-cell">
                          <span
                            className={entry.masked && plain === undefined ? 'value masked' : 'value'}
                            title={plain ?? undefined}
                          >
                            {shown === '' ? <span className="value-empty">（空值）</span> : shown}
                          </span>
                          {entry.masked && (
                            <button
                              className="mini-btn"
                              title="显示或隐藏"
                              aria-label={`显示或隐藏 ${entry.key}`}
                              onClick={() => void toggleReveal(entry)}
                            >
                              ◉
                            </button>
                          )}
                          <button
                            className="mini-btn"
                            title="复制"
                            aria-label={`复制 ${entry.key}`}
                            onClick={() => void copyValue(entry)}
                          >
                            □
                          </button>
                        </div>
                      </td>
                      <td>
                        <span className={`type-tag ${entry.valueType}`}>{entry.valueType}</span>
                      </td>
                      <td>
                        <span className="source-tag" title={entry.sourceFile}>
                          {entry.sourceFile}
                        </span>
                      </td>
                      <td>
                        <span className={entry.fileDrifted ? 'status warn' : 'status'}>
                          <span className="status-dot" />
                          {entry.fileDrifted ? '有差异' : '已同步'}
                        </span>
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </section>

        <div className="side-stack">
          <section className="panel">
            <div className="panel-head">
              <div>
                <div className="panel-title">模型凭据</div>
                <div className="panel-kicker">只记录地址与 Key</div>
              </div>
            </div>
            <div className="health">
              <p className="panel-empty">
                凭据库在阶段 3 接入。届时会从上面这些变量里识别厂商，
                并把地址与 Key 提到独立实体中管理。
              </p>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <div className="panel-title">文件健康度</div>
                <div className="panel-kicker" title={selectedProject.absolutePath}>
                  {files.length} 个纳管文件
                </div>
              </div>
              <span className={driftedFiles.length > 0 ? 'health-badge warn' : 'health-badge ok'}>
                {driftedFiles.length > 0 ? `${driftedFiles.length} 项差异` : '干净'}
              </span>
            </div>
            <div className="health">
              {files.length === 0 && <p className="panel-empty">没有纳管任何文件。</p>}
              {files.map((file) => (
                <div className="health-item" key={file.id}>
                  <div>
                    <div className="health-name">{file.fileName}</div>
                    <div className="health-path" title={file.relativePath}>
                      {file.relativePath} · {file.entryCount} 项
                    </div>
                  </div>
                  {/*
                    只有"内容变了"才给差异入口。文件已丢失时无从对比，
                    给一个点开就报错的按钮不如不给。
                  */}
                  {file.drifted && file.currentHash !== null ? (
                    <button
                      className="outline-btn tiny"
                      onClick={() => onOpenDiff(file)}
                      disabled={locked}
                    >
                      查看差异
                    </button>
                  ) : (
                    <span className={fileBadgeClass(file.currentHash, file.drifted)}>
                      {fileBadgeText(file.currentHash, file.drifted)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </section>
  )
}

function fileBadgeClass(currentHash: string | null, drifted: boolean): string {
  if (currentHash === null) return 'health-badge warn'
  return drifted ? 'health-badge warn' : 'health-badge ok'
}

function fileBadgeText(currentHash: string | null, drifted: boolean): string {
  if (currentHash === null) return '已丢失'
  return drifted ? '有改动' : '一致'
}

function Metric({
  label,
  value,
  note,
  warn = false
}: {
  label: string
  value: number
  note?: string
  warn?: boolean
}): ReactNode {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">
        {String(value).padStart(2, '0')}
        {note && <span className={warn ? 'metric-note warn' : 'metric-note'}>{note}</span>}
      </div>
    </div>
  )
}

function PageHead({
  eyebrow,
  title,
  subtitle
}: {
  eyebrow: string
  title: string
  subtitle: string
}): ReactNode {
  return (
    <div className="page-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p className="page-subtitle">{subtitle}</p>
      </div>
    </div>
  )
}
