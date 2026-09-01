/**
 * 凭据 / 安全 / 记录三个视图。
 *
 * 「操作记录」在阶段 1 已经有真实数据了 —— `activity_log` 从导入的第一刻起就在写。
 * 另外两个仍是空态壳，但正文如实说明了它们在等哪个阶段，而不是假装已经能用。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { bridge } from '../lib/api'
import type { ActivityRecord, EnvFileView, ProjectSummary } from '@shared/ipc'

export function CredentialsView({
  onOpenCredential
}: {
  onOpenCredential(): void
}): ReactNode {
  return (
    <section>
      <div className="page-head">
        <div>
          <div className="eyebrow">独立凭据库</div>
          <h1>模型凭据</h1>
          <p className="page-subtitle">保存调用地址与 Key，按项目和环境建立绑定。</p>
        </div>
        <button className="primary-btn" onClick={onOpenCredential}>
          + 新增凭据
        </button>
      </div>
      <div className="empty-section">
        <h2>凭据库将在阶段 3 接入</h2>
        <p>
          届时会从已纳管的 `.env*` 变量里识别厂商，把调用地址与 API Key 提到独立实体，
          再按项目和环境建立绑定。现在点上面的按钮可以看到表单结构，但不会保存。
        </p>
      </div>
    </section>
  )
}

export function SecurityView({
  project,
  files
}: {
  project: ProjectSummary | null
  files: EnvFileView[]
}): ReactNode {
  const drifted = files.filter((file) => file.drifted)

  return (
    <section>
      <div className="page-head">
        <div>
          <div className="eyebrow">风险扫描</div>
          <h1>安全检查</h1>
          <p className="page-subtitle">检查 Git 忽略规则、文件跟踪状态和配置差异。</p>
        </div>
      </div>

      {/*
        Git 跟踪状态与 .gitignore 检查属于阶段 4。这里只展示阶段 1 已经**真的**
        算得出来的两件事：Git 根目录有没有找到、纳管文件与记录是否一致。
        剩下的如实标注，不放假的"通过"徽章。
      */}
      <div className="empty-section">
        <h2>阶段 1 能给出的结论</h2>
        {!project ? (
          <p>还没有选中项目。</p>
        ) : (
          <div className="check-list">
            <div className="check-item">
              <span className={project.gitRoot ? 'health-badge ok' : 'health-badge warn'}>
                {project.gitRoot ? '已识别' : '未发现'}
              </span>
              <div>
                <strong>Git 仓库根目录</strong>
                <p>{project.gitRoot ?? '这个目录不在任何 Git 仓库里，无法做跟踪状态检查。'}</p>
              </div>
            </div>
            <div className="check-item">
              <span className={drifted.length > 0 ? 'health-badge warn' : 'health-badge ok'}>
                {drifted.length > 0 ? `${drifted.length} 项` : '一致'}
              </span>
              <div>
                <strong>中心记录与本地文件</strong>
                <p>
                  {drifted.length > 0
                    ? drifted.map((file) => file.relativePath).join('、')
                    : '所有纳管文件的哈希都与入库时一致。'}
                </p>
              </div>
            </div>
            <div className="check-item">
              <span className="health-badge neutral">阶段 4</span>
              <div>
                <strong>Git 跟踪状态与 .gitignore 覆盖</strong>
                <p>敏感文件是否已被 Git 跟踪、疑似明文 Key 的风险分级，都在阶段 4 接入。</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

export function ActivityView(): ReactNode {
  const [records, setRecords] = useState<ActivityRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const result = await bridge.listActivity(100)
    if (result.ok) {
      setRecords(result.data)
      setError(null)
    } else {
      setError(result.message)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section>
      <div className="page-head">
        <div>
          <div className="eyebrow">审计记录</div>
          <h1>操作记录</h1>
          <p className="page-subtitle">记录导入、扫描与显示动作，只保存元数据，不保存明文值。</p>
        </div>
        <div className="head-actions">
          <button className="outline-btn" onClick={() => void load()} disabled={loading}>
            {loading ? '读取中…' : '刷新'}
          </button>
        </div>
      </div>

      {error && (
        <div className="empty-section">
          <h2>无法读取记录</h2>
          <p>{error}</p>
        </div>
      )}

      {!error && records.length === 0 && !loading && (
        <div className="empty-section">
          <h2>暂无记录</h2>
          <p>导入项目、重新扫描或显示敏感值时，这里会留下一条不含明文的记录。</p>
        </div>
      )}

      {!error && records.length > 0 && (
        <section className="panel activity-panel">
          <div className="panel-head">
            <div>
              <div className="panel-title">最近 {records.length} 条</div>
              <div className="panel-kicker">target 只记 key 名与路径，不含值</div>
            </div>
          </div>
          <div className="activity">
            {records.map((record) => (
              <div className="activity-item" key={record.id}>
                <span className={`activity-dot ${actionTone(record.action)}`} />
                <div className="activity-copy">
                  <strong>{actionLabel(record.action)}</strong>
                  {record.targetRef && <span className="activity-target">{record.targetRef}</span>}
                  <br />
                  {[record.projectName, record.environment, record.detail]
                    .filter(Boolean)
                    .join(' / ') || '—'}
                </div>
                <span className="activity-time">
                  {new Date(record.createdAt).toLocaleString('zh-CN')}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </section>
  )
}

const ACTION_LABELS: Record<string, string> = {
  'project.import': '导入项目',
  'project.rescan': '重新扫描',
  'project.remove': '移除项目',
  'entry.reveal': '显示敏感值'
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action
}

function actionTone(action: string): string {
  if (action === 'entry.reveal') return 'orange'
  if (action === 'project.remove') return 'orange'
  if (action === 'project.rescan') return 'blue'
  return ''
}
