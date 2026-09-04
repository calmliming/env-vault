/**
 * 安全检查与操作记录两个视图。
 *
 * 「操作记录」在阶段 1 已经有真实数据了 —— `activity_log` 从导入的第一刻起就在写。
 * 「安全检查」在阶段 4a 变成了真的：它去问 git 每个 `.env*` 有没有被跟踪、
 * 有没有被忽略规则覆盖，再和文件里的敏感度合成一个等级。
 *
 * 模型凭据页在阶段 3 变成了真实功能，已经挪到 `CredentialsView.tsx`。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { bridge } from '../lib/api'
import { Pagination } from '../components/Pagination'
import { useIntPref } from '../hooks/usePrefs'
import { PREF_KEYS } from '../lib/prefs'
import { RISK_ORDER } from '@shared/security-types'
import type { RiskLevel } from '@shared/security-types'
import type {
  ActivityRecord,
  EnvFileView,
  FileRisk,
  ProjectSummary,
  SecurityReport
} from '@shared/ipc'

const RISK_LABELS: Record<RiskLevel, string> = {
  critical: '高危',
  warning: '注意',
  unknown: '未知',
  ok: '正常'
}

/** 🔴 unknown 不能用绿色。它是「没查出来」，不是「没问题」。 */
function riskTone(level: RiskLevel): string {
  if (level === 'critical') return 'danger'
  if (level === 'warning') return 'warn'
  if (level === 'unknown') return 'neutral'
  return 'ok'
}

export function SecurityView({
  project,
  files
}: {
  project: ProjectSummary | null
  files: EnvFileView[]
}): ReactNode {
  const [report, setReport] = useState<SecurityReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const projectId = project?.id ?? null
  const drifted = files.filter((file) => file.drifted)

  const scan = useCallback(async () => {
    if (projectId === null) {
      setReport(null)
      return
    }
    setLoading(true)
    const result = await bridge.scanSecurity(projectId)
    setLoading(false)
    if (result.ok) {
      setReport(result.data)
      setError(null)
      return
    }
    setReport(null)
    setError(result.message)
  }, [projectId])

  /*
    打开页面就自动跑，不需要用户先点一下。
    这条和凭据验证那颗按钮的规矩**不同**，区别是有理由的：
    验证会向厂商发出站请求（可能产生费用、暴露使用痕迹），所以必须由用户发起；
    这里跑的是本地只读的 git ls-files / check-ignore，没有费用、没有副作用、
    不外发任何数据 —— 而一个需要先点一下才肯工作的安全检查，等于没有。
  */
  useEffect(() => {
    void scan()
  }, [scan])

  return (
    <section>
      <div className="page-head">
        <div>
          <div className="eyebrow">风险扫描</div>
          <h1>安全检查</h1>
          <p className="page-subtitle">
            检查每个 <code>.env*</code> 有没有被 Git 跟踪、有没有被 .gitignore 覆盖。
          </p>
        </div>
        <div className="head-actions">
          <button
            className="outline-btn"
            data-action="rescan-security"
            onClick={() => void scan()}
            disabled={loading || projectId === null}
          >
            {loading ? '检查中…' : '重新检查'}
          </button>
        </div>
      </div>

      {projectId === null ? (
        <div className="empty-section">
          <h2>还没有选中项目</h2>
          <p>在左侧选一个项目，这里会列出它每个 .env* 文件的 Git 暴露风险。</p>
        </div>
      ) : error !== null ? (
        <div className="empty-section">
          <h2>检查没能完成</h2>
          <p>{error}</p>
        </div>
      ) : report === null ? (
        <div className="empty-section">
          <h2>{loading ? '正在检查…' : '尚未检查'}</h2>
          <p>正在向 git 询问这些文件的跟踪状态。</p>
        </div>
      ) : (
        <>
          <div className="risk-summary">
            <span className="health-badge danger">高危 {report.summary.critical}</span>
            <span className="health-badge warn">注意 {report.summary.warning}</span>
            <span className="health-badge neutral">未知 {report.summary.unknown}</span>
            <span className="health-badge ok">正常 {report.summary.ok}</span>
          </div>

          {/*
            🔴 git 查不了的时候，整页只能说"查不了"。
            这时候放一个绿色的「通过」，用户会拿着它去决定要不要提交。
          */}
          {report.gitUnavailable !== null && (
            <p className="risk-notice">
              <strong>Git 状态未能确定：</strong>
              {report.gitUnavailable}
              下面每一条的跟踪状态都显示为「未知」—— 这不代表它们安全，只代表这次没查出来。
            </p>
          )}

          {report.truncatedBy === 'files' && (
            <p className="risk-notice">
              .env* 文件数达到上限，扫描提前停止了 —— 还有文件没检查到。
            </p>
          )}
          {report.truncatedBy === 'depth' && (
            <p className="risk-notice">
              有目录层数太深，扫描没有进去 —— 那里面如果有 .env*，这次没检查到。
            </p>
          )}

          <div className="empty-section">
            <h2>
              {report.files.length} 个配置文件
              {report.gitRoot !== null && <span className="page-subtitle"> · {report.gitRoot}</span>}
            </h2>

            <div className="check-list">
              {report.files.length === 0 ? (
                <p className="panel-empty">这个项目里没有发现任何 .env* 文件。</p>
              ) : (
                report.files
                  .slice()
                  .sort((a, b) => RISK_ORDER[a.level] - RISK_ORDER[b.level])
                  .map((file) => <RiskRow key={file.relativePath} file={file} />)
              )}
            </div>
          </div>

          <div className="empty-section">
            <h2>中心记录与本地文件</h2>
            <div className="check-list">
              <div className="check-item">
                <span className={drifted.length > 0 ? 'health-badge warn' : 'health-badge ok'}>
                  {drifted.length > 0 ? `${drifted.length} 项` : '一致'}
                </span>
                <div>
                  <strong>纳管文件的哈希</strong>
                  <p>
                    {drifted.length > 0
                      ? `${drifted.map((file) => file.relativePath).join('、')} 与入库时不一致，去配置总览处理差异。`
                      : '所有纳管文件的哈希都与入库时一致。'}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  )
}

function RiskRow({ file }: { file: FileRisk }): ReactNode {
  return (
    <div className="check-item" data-risk={file.level} data-path={file.relativePath}>
      <span className={`health-badge ${riskTone(file.level)}`}>{RISK_LABELS[file.level]}</span>
      <div>
        <strong className="risk-path">{file.relativePath}</strong>
        <div className="risk-tags">
          {/* 🔴 三态：跟踪中 / 未跟踪 / 未知。null 绝不能显示成「未跟踪」。 */}
          <span className={`type-tag ${file.tracked === true ? 'secret' : 'text'}`}>
            {file.tracked === null ? 'Git 状态未知' : file.tracked ? 'Git 跟踪中' : '未被跟踪'}
          </span>
          {file.ignored === true && (
            <span className="type-tag boolean" title={file.ignoreRule ?? undefined}>
              已忽略{file.ignoreRule ? ` · ${file.ignoreRule}` : ''}
            </span>
          )}
          {file.highCount > 0 && (
            <span className="type-tag secret">{file.highCount} 个高危值</span>
          )}
          {file.sensitiveCount > 0 && (
            <span className="type-tag number">{file.sensitiveCount} 个疑似敏感值</span>
          )}
          {!file.managed && <span className="type-tag text">未导入</span>}
          {!file.onDisk && <span className="type-tag text">磁盘上已不存在</span>}
        </div>
        <p>{file.reason}</p>
        {file.remedy !== null && <p className="risk-remedy">{file.remedy}</p>}
      </div>
    </div>
  )
}

/**
 * 操作记录的每页条数。
 *
 * 默认 20 —— 审计流水是拿来一条条读的，不是拿来滚的。
 *
 * ⚠️ verify-ui 有几条断言要从渲染出来的条目里收集动作标签（「导入项目」
 * 「加密导出」这些），而最老的那条在种子数据里排在第 90 位往后。那些断言
 * 验的是「审计日志记下了这些动作类型」，属于数据断言 —— 所以脚本里是先把
 * 每页选到最大再读标签，而不是让这里迁就它给一个 100 的默认值。
 */
const ACTIVITY_PAGE_SIZES = [20, 50, 100, 200] as const
const ACTIVITY_PAGE_SIZE_DEFAULT = 20

export function ActivityView(): ReactNode {
  const [records, setRecords] = useState<ActivityRecord[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useIntPref(
    PREF_KEYS.activityPageSize,
    ACTIVITY_PAGE_SIZE_DEFAULT,
    ACTIVITY_PAGE_SIZES
  )

  /**
   * 🔴 这一页是服务端分页，和变量表那边不一样。
   *
   * 变量表的数据本来就全量在内存里，切片是白送的；操作记录是只增不减的
   * 审计流水，几万条也不奇怪，全量拉过来只为了显示 20 条是在浪费内存和
   * 序列化时间。所以翻页真的会重新查一次。
   */
  const load = useCallback(async () => {
    setLoading(true)
    const result = await bridge.listActivity(pageSize, (page - 1) * pageSize)
    if (result.ok) {
      setRecords(result.data.records)
      setTotal(result.data.total)
      setError(null)
    } else {
      setError(result.message)
    }
    setLoading(false)
  }, [page, pageSize])

  useEffect(() => {
    void load()
  }, [load])

  /*
   * 删项目会连带删掉它的记录（activity_log.project_id 是 SET NULL，
   * 但别的路径会真删），停在最后一页时总数缩水就会翻到一个空页。
   * 总数变了就把越界的页码拨回最后一页。
   */
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  useEffect(() => {
    if (page > pageCount) setPage(pageCount)
  }, [page, pageCount])

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

      {!error && total === 0 && !loading && (
        <div className="empty-section">
          <h2>暂无记录</h2>
          <p>导入项目、重新扫描或显示敏感值时，这里会留下一条不含明文的记录。</p>
        </div>
      )}

      {!error && records.length > 0 && (
        <section className="panel activity-panel">
          <div className="panel-head">
            <div>
              {/*
                标题说的是**总数**，不再是 records.length。
                后者绑的是「这一页有几条」—— 没分页的时候它碰巧等于总数，
                到达上限之后就开始撒谎，而且没有任何办法知道后面还有多少。
              */}
              <div className="panel-title">共 {total} 条</div>
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

          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            pageSizeOptions={ACTIVITY_PAGE_SIZES}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size)
              setPage(1)
            }}
            label="操作记录"
          />
        </section>
      )}
    </section>
  )
}

const ACTION_LABELS: Record<string, string> = {
  'project.import': '导入项目',
  'project.rescan': '重新扫描',
  'project.remove': '移除项目',
  'entry.reveal': '显示敏感值',
  'entry.copy': '复制到剪贴板',
  'entry.update': '编辑变量',
  'entry.delete': '删除变量',
  'file.adopt': '以磁盘为准',
  'file.restore': '以记录为准写回',
  'credential.create': '新增凭据',
  'credential.update': '修改凭据',
  'credential.rotate': '轮换 Key',
  'credential.reveal': '显示 Key',
  'credential.copy': '复制 Key 到剪贴板',
  'credential.validate': '向厂商验证',
  'credential.bind': '绑定凭据',
  'credential.unbind': '解除绑定',
  'credential.sync': '同步到绑定文件',
  'credential.delete': '删除凭据',
  'cli.inject': 'CLI 注入到子进程',
  'template.generate': '生成 .env.example',
  'transfer.export': '加密导出',
  'transfer.import': '从导出包导入'
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action
}

/**
 * 会动到用户磁盘文件、或者读出过明文的动作标橙色，其余按信息量分。
 *
 * 用集合而不是一串 if：凭据那边有同样性质的动作
 * （`credential.reveal` 读出过明文、`credential.sync` 会改磁盘文件），
 * 一条条 if 排下去的结果就是漏掉它们 —— 之前正是漏了。
 */
const ORANGE_ACTIONS = new Set([
  // 读出过明文
  'entry.reveal',
  'credential.reveal',
  // 🔴 复制比查看更值得标出来：复制出去的那一份**离开了本应用**，
  // 而查看只是在屏幕上停留了一会儿。
  'entry.copy',
  'credential.copy',
  // 🔴 注入把一整个环境的明文交给了另一个程序 —— 比复制走得更远。
  'cli.inject',
  // 改过用户的磁盘文件
  'entry.delete',
  'file.restore',
  'credential.sync',
  // 🔴 生成的模板本身不含值，但它是唯一一个**设计上就要被提交进 Git** 的产物 ——
  // 会离开这台机器的东西，值得在记录里一眼看见。
  'template.generate',
  // 🔴 导出是最宽的一条明文出口：一次把选中项目的全部值（可能还有全部模型 Key）
  // 装进一个文件。它比上面任何一条走得都远。
  'transfer.export',
  // 导入会成批改写中心记录。
  'transfer.import',
  // 删掉了中心记录
  'project.remove',
  'credential.delete'
])

const BLUE_ACTIONS = new Set([
  'project.rescan',
  'entry.update',
  'credential.validate',
  'credential.rotate'
])

function actionTone(action: string): string {
  if (ORANGE_ACTIONS.has(action)) return 'orange'
  if (BLUE_ACTIONS.has(action)) return 'blue'
  return ''
}
