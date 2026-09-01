import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { bridge } from '../lib/api'
import type { Workspace } from '../hooks/useWorkspace'
import type { ConfigEntryView, CredentialSuggestion, EnvFileView } from '@shared/ipc'

interface OverviewViewProps {
  workspace: Workspace
  query: string
  onQueryChange(query: string): void
  onAddProject(): void
  onOpenSync(): void
  onOpenDiff(file: EnvFileView): void
  onDeleteEntry(entry: ConfigEntryView, expectedHash: string): void
  onExtractCredential(suggestion: CredentialSuggestion): void
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
  onDeleteEntry,
  onExtractCredential,
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
  /** 正在编辑的条目 id 与草稿值。同一时刻只允许编辑一条。 */
  const [editing, setEditing] = useState<{ id: number; draft: string } | null>(null)
  const [saving, setSaving] = useState(false)

  /**
   * 文件的实时状态。
   *
   * 条目上的 `fileDrifted` 是 listEntries 那一刻算出来的，而 `files` 会被
   * 监听推送不断刷新。要判断「现在能不能就地编辑」，得看后者 ——
   * 否则用户会看到一个「已同步」的行，点保存却被主进程以「文件有外部改动」拒绝。
   */
  const fileById = useMemo(() => new Map(files.map((file) => [file.id, file])), [files])

  /**
   * 疑似模型凭据的变量（阶段 3，§6.2 步骤 1）。
   *
   * 跟着 entries 一起重算：提取成凭据之后那一条就该从建议里消失，
   * 不重算的话用户会看到一个"再提取一次"的按钮。
   */
  const [suggestions, setSuggestions] = useState<CredentialSuggestion[]>([])
  const projectId = selectedProject?.id ?? null

  const loadSuggestions = useCallback(async () => {
    if (projectId === null || locked) {
      setSuggestions([])
      return
    }
    const result = await bridge.suggestCredentials(projectId)
    setSuggestions(result.ok ? result.data : [])
  }, [projectId, locked])

  useEffect(() => {
    void loadSuggestions()
  }, [loadSuggestions, entries])

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

  /**
   * 这一条现在能不能就地改。
   *
   * 文件有未处理的外部改动时不给编辑入口 —— 这时候写回去等于替用户默默
   * 选了 §6.4 的方向，把别人的修改覆盖掉。正确路径是先去差异面板选一个方向。
   * 主进程侧同样会拦（那才是真正的守卫），这里只是别把用户引到死路上。
   */
  /**
   * 文件层面挡住写入的原因。编辑和删除都受它约束。
   *
   * 注意这和「状态」列的 drifted 是同一件事，但和下面的"归凭据管"不是 ——
   * 三个概念混成一个布尔值的话，一个归凭据管的变量会在状态列里
   * 被显示成「有差异」，而它的文件其实好好的。
   */
  function fileBlockedReason(entry: ConfigEntryView): string | null {
    const file = fileById.get(entry.fileId)
    if (!file) return '找不到这个变量的来源文件记录'
    if (file.currentHash === null) return '来源文件已从磁盘消失'
    if (file.drifted) return '来源文件在外部被改过，请先在「文件健康度」里处理差异'
    return null
  }

  /**
   * 编辑还多一条限制：🔴 归凭据管的变量真源在凭据那边，
   * 就地改会造成两个真源。主进程侧同样会拒（那才是守卫），
   * 这里只是别把用户引到死路上。
   *
   * 删除**不受**这条限制 —— 变量真的要没了是合理的，
   * 那时绑定会跟着一起解除。
   */
  function editBlockedReason(entry: ConfigEntryView): string | null {
    if (entry.managedBy?.role === 'key') {
      return `由凭据「${entry.managedBy.credentialName}」管理，请到「模型凭据」页修改后同步`
    }
    return fileBlockedReason(entry)
  }

  /** 用户看到这一行时文件的磁盘哈希，作为「我这个决定基于哪个版本」送给主进程。 */
  function expectedHashOf(entry: ConfigEntryView): string | null {
    return fileById.get(entry.fileId)?.currentHash ?? null
  }

  function beginEdit(entry: ConfigEntryView): void {
    const plain = revealed.get(entry.id)
    // 敏感项默认盲写：编辑框是空的，原值不因为「点了编辑」就跑到屏幕上。
    // 想看原值就点「显示」，那条路径会留痕（§5.5）。已经显示过的直接预填。
    const draft = entry.masked ? (plain ?? '') : (plain ?? entry.displayValue)
    setEditing({ id: entry.id, draft })
  }

  async function saveEdit(entry: ConfigEntryView): Promise<void> {
    if (!editing || editing.id !== entry.id) return
    const expectedHash = expectedHashOf(entry)
    if (expectedHash === null) {
      showToast('来源文件已从磁盘消失，无法保存')
      return
    }

    setSaving(true)
    const result = await bridge.updateEntry(entry.id, editing.draft, expectedHash)
    setSaving(false)
    if (!result.ok) {
      showToast(result.message)
      return
    }

    setEditing(null)
    // 手里那份明文缓存已经作废，删掉它让这一行回到掩码态 ——
    // 留着会显示一个已经不存在的旧值。
    setRevealed((prev) => {
      const next = new Map(prev)
      next.delete(entry.id)
      return next
    })
    await workspace.reloadCurrent()
    showToast(
      result.data.written
        ? `已更新 ${entry.key} 并写回 ${entry.sourceFile}，原文件已备份`
        : '值没有变化，文件未改动'
    )
  }

  function requestDelete(entry: ConfigEntryView): void {
    const expectedHash = expectedHashOf(entry)
    if (expectedHash === null) {
      showToast('来源文件已从磁盘消失，无法删除')
      return
    }
    onDeleteEntry(entry, expectedHash)
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
            处理差异{driftedFiles.length > 0 ? `（${driftedFiles.length}）` : ''}
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
                  const fileBlocked = fileBlockedReason(entry)
                  const editBlocked = editBlockedReason(entry)
                  // 状态列说的是**文件**的事，不该被"归凭据管"污染。
                  const drifted = fileBlocked !== null
                  const isEditing = editing?.id === entry.id
                  // 敏感项还没点过「显示」时是盲写：编辑框空着，空值不等于"清空"，
                  // 而是"还没输入"。要真的把它清空，先点显示、再删掉预填的内容。
                  const blindWrite = entry.masked && plain === undefined

                  return (
                    <tr key={entry.id}>
                      <td>
                        <div className="key-name" title={entry.key}>
                          {entry.key}
                        </div>
                      </td>
                      <td>
                        {isEditing ? (
                          <form
                            className="value-edit"
                            onSubmit={(event) => {
                              event.preventDefault()
                              void saveEdit(entry)
                            }}
                          >
                            <input
                              className="value-input"
                              autoFocus
                              value={editing.draft}
                              placeholder={blindWrite ? '输入新值（原值未显示）' : undefined}
                              aria-label={`${entry.key} 的新值`}
                              onChange={(e) => setEditing({ id: entry.id, draft: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') setEditing(null)
                              }}
                            />
                            <button
                              type="submit"
                              className="mini-btn"
                              data-action="save"
                              title="保存并写回文件"
                              aria-label={`保存 ${entry.key}`}
                              disabled={saving || (blindWrite && editing.draft === '')}
                            >
                              ✓
                            </button>
                            <button
                              type="button"
                              className="mini-btn"
                              data-action="cancel"
                              title="取消"
                              aria-label={`取消编辑 ${entry.key}`}
                              disabled={saving}
                              onClick={() => setEditing(null)}
                            >
                              ✕
                            </button>
                          </form>
                        ) : (
                          <div className="value-cell">
                            <span
                              className={
                                entry.masked && plain === undefined ? 'value masked' : 'value'
                              }
                              title={plain ?? undefined}
                            >
                              {shown === '' ? <span className="value-empty">（空值）</span> : shown}
                            </span>
                            {entry.masked && (
                              <button
                                className="mini-btn"
                                data-action="reveal"
                                title="显示或隐藏"
                                aria-label={`显示或隐藏 ${entry.key}`}
                                onClick={() => void toggleReveal(entry)}
                              >
                                ◉
                              </button>
                            )}
                            <button
                              className="mini-btn"
                              data-action="copy"
                              title="复制"
                              aria-label={`复制 ${entry.key}`}
                              onClick={() => void copyValue(entry)}
                            >
                              □
                            </button>
                            <button
                              className="mini-btn"
                              data-action="edit"
                              title={editBlocked ?? '编辑并写回文件'}
                              aria-label={`编辑 ${entry.key}`}
                              disabled={editBlocked !== null}
                              onClick={() => beginEdit(entry)}
                            >
                              ✎
                            </button>
                            <button
                              className="mini-btn danger"
                              data-action="delete"
                              title={
                                fileBlocked ??
                                (entry.managedBy
                                  ? '删除变量并解除凭据绑定，同时从文件里删掉那一行'
                                  : '删除变量，并从文件里删掉那一行')
                              }
                              aria-label={`删除 ${entry.key}`}
                              disabled={fileBlocked !== null}
                              onClick={() => requestDelete(entry)}
                            >
                              ✕
                            </button>
                          </div>
                        )}
                      </td>
                      <td>
                        <span className={`type-tag ${entry.valueType}`}>{entry.valueType}</span>
                      </td>
                      <td>
                        <span className="source-tag" title={entry.sourceFile}>
                          {entry.sourceFile}
                        </span>
                        {/*
                          阶段 3 验收要求「通用配置页面仍能看到原始来源和绑定状态」：
                          变量留在表里，来源照旧显示，另外标出它归哪条凭据管。
                        */}
                        {entry.managedBy && (
                          <span
                            className="binding-tag"
                            data-role={entry.managedBy.role}
                            title={`${entry.managedBy.providerName} / ${entry.managedBy.credentialName}`}
                          >
                            {entry.managedBy.role === 'key' ? '凭据 Key' : '凭据地址'} ·{' '}
                            {entry.managedBy.credentialName}
                          </span>
                        )}
                      </td>
                      <td>
                        <span className={drifted ? 'status warn' : 'status'}>
                          <span className="status-dot" />
                          {drifted ? '有差异' : '已同步'}
                        </span>
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </section>

        <div className="side-stack">
          {/*
            §6.2 步骤 1~3：给出厂商建议 → 保留原始配置记录 → 用户确认后创建凭据。
            这里只做「建议」，创建永远要用户点一下 —— 值优先、名字兜底，
            两个信号冲突时两家都列出来，不替用户下结论。
          */}
          <section className="panel">
            <div className="panel-head">
              <div>
                <div className="panel-title">疑似模型凭据</div>
                <div className="panel-kicker">
                  {suggestions.length > 0 ? `${suggestions.length} 个待处理` : '只记录地址与 Key'}
                </div>
              </div>
            </div>
            <div className="health">
              {locked && <p className="panel-empty">解锁后才能识别。</p>}
              {!locked && suggestions.length === 0 && (
                <p className="panel-empty">
                  这个项目里没有识别出未纳管的模型凭据。已经提取过的变量不会重复出现在这里。
                </p>
              )}
              {!locked &&
                suggestions.map((suggestion) => (
                  <div className="health-item" key={suggestion.entryId}>
                    <div>
                      <div className="health-name">{suggestion.key}</div>
                      <div className="health-path">
                        {suggestion.providers.map((provider) => provider.providerName).join(' 或 ')}
                        {suggestion.providers.length > 1 && ' · 需确认'} · {suggestion.environment}
                      </div>
                    </div>
                    <button
                      className="outline-btn tiny"
                      data-action="extract-credential"
                      onClick={() => onExtractCredential(suggestion)}
                    >
                      提取
                    </button>
                  </div>
                ))}
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
