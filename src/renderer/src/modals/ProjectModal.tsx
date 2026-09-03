import { useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { ModalActions } from '../state/modal'
import { bridge } from '../lib/api'
import type { DiscoveredProjectPreview, DiscoveryPreview } from '@shared/ipc'

interface ProjectModalProps {
  close(): void
  showToast(message: string): void
  /** 导入成功后回调，参数是要选中的项目 id。 */
  onImported(projectId: number): void
}

/**
 * 「添加项目」，对应开发计划 §6.1 步骤 1~5。
 *
 * 🔴 扫描与入库是两次独立的 IPC，中间隔着用户确认。这不是为了好看：
 * §6.1 步骤 3 明确要求「展示发现的文件和变量数量，**不立即修改文件**」。
 *
 * ## 一个入口，两种形态
 *
 * 选中目录后走 `projects:discover`：
 *
 *   - 选中的就是一个仓库（或底下一个仓库都没有）→ 只有一个项目，和以前一样；
 *   - 底下有多个仓库 → 逐个列出来，各自成为一个**独立项目**。
 *
 * 后者不是为了省几次点击，是**正确性**：一个项目只存一个 `git_root`，
 * 把十几个仓库塞进一个项目会让安全检查对着错误的仓库问跟踪状态，
 * 于是「已提交又补进 .gitignore」那条 critical 静默消失。见 `env/discover.ts`。
 *
 * 模板文件（`.env.example` 等）默认**不勾选** —— 它们的值是占位符，
 * 纳管进来只会在配置总览里制造一堆空值噪声。用户想要仍然可以勾上。
 */
export function ProjectModal({ close, showToast, onImported }: ProjectModalProps): ReactNode {
  const [path, setPath] = useState('')
  const [discovery, setDiscovery] = useState<DiscoveryPreview | null>(null)
  /** 勾选的文件绝对路径。跨项目共用一个集合 —— 路径本来就是全局唯一的。 */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  /** 用户改过的项目名，按项目根路径存。没改过就用建议名。 */
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map())
  const [busy, setBusy] = useState<'idle' | 'picking' | 'scanning' | 'importing'>('idle')

  const importable = useMemo(
    () => (discovery?.projects ?? []).filter((project) => !project.alreadyImported),
    [discovery]
  )
  const single = discovery !== null && discovery.projects.length === 1

  async function chooseDirectory(): Promise<void> {
    setBusy('picking')
    const picked = await bridge.selectDirectory('选择项目根目录，或一个装着多个仓库的目录')
    if (!picked.ok) {
      setBusy('idle')
      showToast(picked.message)
      return
    }
    if (picked.data.canceled || !picked.data.path) {
      setBusy('idle')
      return
    }
    await runDiscovery(picked.data.path)
  }

  async function runDiscovery(rootPath: string): Promise<void> {
    setBusy('scanning')
    const result = await bridge.discoverProjects(rootPath)
    setBusy('idle')

    if (!result.ok) {
      setDiscovery(null)
      showToast(result.message)
      return
    }

    setPath(result.data.rootPath)
    setDiscovery(result.data)
    // 默认勾选非模板、可读、且所属项目还没被纳管过的文件。
    setSelected(
      new Set(
        result.data.projects
          .filter((project) => !project.alreadyImported)
          .flatMap((project) => project.files)
          .filter((file) => !file.isTemplate && file.error === null)
          .map((file) => file.absolutePath)
      )
    )
    setNames(new Map())

    const totalFiles = result.data.projects.reduce((sum, p) => sum + p.files.length, 0)
    if (totalFiles === 0) showToast('这个目录下没有找到 .env* 文件')
  }

  function toggleFile(absolutePath: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(absolutePath)) next.delete(absolutePath)
      else next.add(absolutePath)
      return next
    })
  }

  /** 整个项目一起勾/取消。仓库多的时候逐个点文件太慢。 */
  function toggleProject(project: DiscoveredProjectPreview): void {
    const paths = project.files.filter((file) => file.error === null).map((f) => f.absolutePath)
    const allOn = paths.every((p) => selected.has(p))
    setSelected((prev) => {
      const next = new Set(prev)
      for (const p of paths) {
        if (allOn) next.delete(p)
        else next.add(p)
      }
      return next
    })
  }

  function nameOf(project: DiscoveredProjectPreview): string {
    return names.get(project.rootPath) ?? project.suggestedName
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!discovery) return

    const payload = importable
      .map((project) => ({
        rootPath: project.rootPath,
        name: nameOf(project),
        includePaths: project.files
          .map((f) => f.absolutePath)
          .filter((p) => selected.has(p))
      }))
      .filter((project) => project.includePaths.length > 0)

    if (payload.length === 0) return

    setBusy('importing')
    const result = await bridge.importProjects(payload)
    setBusy('idle')

    if (!result.ok) {
      showToast(result.message)
      return
    }

    const { imported, skipped } = result.data
    if (imported.length === 0) {
      // 全都被跳过时不关弹窗：用户需要看到为什么。
      showToast(skipped[0]?.reason ?? '没有导入任何项目')
      return
    }

    close()
    onImported(imported[0]!.id)
    const files = imported.reduce((sum, p) => sum + p.fileCount, 0)
    const entries = imported.reduce((sum, p) => sum + p.entryCount, 0)
    showToast(
      (imported.length === 1
        ? `已纳管 ${imported[0]!.name}：${files} 个文件、${entries} 个变量`
        : `已纳管 ${imported.length} 个项目：${files} 个文件、${entries} 个变量`) +
        (skipped.length > 0 ? `；${skipped.length} 个已存在，已跳过` : '')
    )
  }

  const selectedFileCount = selected.size
  const selectedEntryCount = (discovery?.projects ?? [])
    .flatMap((p) => p.files)
    .filter((file) => selected.has(file.absolutePath))
    .reduce((sum, file) => sum + file.entryCount, 0)

  return (
    <>
      <p className="modal-copy">
        选一个项目根目录，或者一个<strong>装着多个仓库</strong>的目录 ——
        后者会把里面每个 Git 仓库各自作为一个项目列出来。
        在你确认之前不会写入任何记录，磁盘上的文件也不会被改动。
      </p>

      <form onSubmit={(event) => void onSubmit(event)}>
        <div className="field">
          <label htmlFor="project-path">目录</label>
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
          <small>路径由系统对话框返回，渲染层不能自己拼路径。</small>
        </div>

        {discovery && (
          <>
            <div className="modal-divider" />

            {!single && (
              <div className="scan-summary" data-testid="discovery-summary">
                发现 {discovery.projects.length} 个项目 · 已选 {selectedFileCount} 个文件 /{' '}
                {selectedEntryCount} 个变量
              </div>
            )}

            {discovery.truncated && (
              <p className="modal-copy">
                目录很大，发现在达到上限后停止，下面可能不是全部仓库。
              </p>
            )}

            {discovery.projects.map((project) => (
              <div className="transfer-project" key={project.rootPath}>
                <div className="transfer-project-head">
                  {single ? (
                    <span className="diff-key">{nameOf(project)}</span>
                  ) : (
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={project.files.some((f) => selected.has(f.absolutePath))}
                        disabled={project.alreadyImported || busy !== 'idle'}
                        onChange={() => toggleProject(project)}
                      />
                      <span className="diff-key">{nameOf(project)}</span>
                    </label>
                  )}
                  <span className={project.isGitRepo ? 'diff-state ok' : 'diff-state'}>
                    {project.alreadyImported
                      ? '已纳管'
                      : project.isGitRepo
                        ? 'Git 仓库'
                        : '不在仓库里'}
                  </span>
                </div>
                <div className="transfer-project-path">{project.rootPath}</div>

                {!project.isGitRepo && !project.alreadyImported && (
                  <p className="modal-note">
                    这个目录不在任何 Git 仓库里 —— 可以纳管，但安全检查里的跟踪状态会显示「查不了」。
                  </p>
                )}
                {/*
                  分开措辞：'files' 是确定漏了，'depth' 只是可能漏了。
                  以前两种都说「文件很多」，而深目录才是绝大多数情况 ——
                  于是正常的 monorepo 每次纳管都吃一条错误归因的警告。
                */}
                {project.truncatedBy === 'files' && (
                  <p className="modal-note">
                    .env* 文件数达到上限，扫描提前停止了 —— 还有文件没列出来。
                  </p>
                )}
                {project.truncatedBy === 'depth' && (
                  <p className="modal-note">
                    有目录层数太深，扫描没有进去。如果那里面有 .env*，这次不会收进来；
                    深目录本身很常见（比如路由目录），通常不影响。
                  </p>
                )}

                {single && (
                  <div className="field">
                    <label htmlFor="project-name">项目名称</label>
                    <input
                      id="project-name"
                      value={nameOf(project)}
                      onChange={(event) =>
                        setNames((prev) =>
                          new Map(prev).set(project.rootPath, event.target.value)
                        )
                      }
                    />
                  </div>
                )}

                {project.files.length === 0 ? (
                  <p className="modal-note">没有找到 .env* 文件。</p>
                ) : (
                  <div className="diff-list">
                    {project.files.map((file) => (
                      <label className="diff-row" key={file.absolutePath}>
                        <input
                          type="checkbox"
                          checked={selected.has(file.absolutePath)}
                          disabled={
                            file.error !== null || project.alreadyImported || busy !== 'idle'
                          }
                          onChange={() => toggleFile(file.absolutePath)}
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
                )}
              </div>
            ))}
          </>
        )}

        <ModalActions
          cancelText="取消"
          submitText={
            busy === 'importing'
              ? '导入中…'
              : importable.length > 1
                ? `导入 ${importable.filter((p) => p.files.some((f) => selected.has(f.absolutePath))).length} 个项目`
                : '导入并纳管'
          }
          onCancel={close}
          submitDisabled={!discovery || selected.size === 0 || busy !== 'idle'}
        />
      </form>
    </>
  )
}
