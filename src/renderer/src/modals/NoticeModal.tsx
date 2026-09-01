import type { ReactNode } from 'react'
import type { EnvFileView, ProjectSummary, VaultStatus } from '@shared/ipc'

interface NoticeModalProps {
  close(): void
  vault: VaultStatus | null
  project: ProjectSummary | null
  files: EnvFileView[]
}

interface Notice {
  tone: '' | 'blue' | 'green'
  title: string
  body: string
}

/**
 * 通知中心。
 *
 * 原型里这三条是写死的示例文案。现在全部由真实状态推导 ——
 * 一个"提醒"面板如果提醒的是假事件，比没有这个面板更糟：
 * 用户会学会忽略它，等到有真问题时也一样忽略。
 */
export function NoticeModal({ close, vault, project, files }: NoticeModalProps): ReactNode {
  const notices = buildNotices(vault, project, files)

  return (
    <>
      {notices.length === 0 ? (
        <p className="modal-copy">当前没有需要处理的提醒。</p>
      ) : (
        <div className="notice-list">
          {notices.map((notice) => (
            <div className="notice" key={notice.title}>
              <span className={notice.tone ? `notice-dot ${notice.tone}` : 'notice-dot'} />
              <div>
                <strong>{notice.title}</strong>
                <p>{notice.body}</p>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="primary-btn" onClick={close}>
          知道了
        </button>
      </div>
    </>
  )
}

function buildNotices(
  vault: VaultStatus | null,
  project: ProjectSummary | null,
  files: EnvFileView[]
): Notice[] {
  const notices: Notice[] = []

  if (vault && !vault.keystoreAvailable) {
    notices.push({
      tone: '',
      title: '系统密钥库不可用',
      body: `后端为 ${vault.keystoreBackend}，无法安全保存主密钥，Vault 功能已禁用。`
    })
  } else if (vault?.state === 'locked') {
    notices.push({ tone: '', title: 'Vault 已锁定', body: '解锁后才能读取和导入配置值。' })
  } else if (vault?.state === 'uninitialized') {
    notices.push({ tone: 'blue', title: '尚未创建本地 Vault', body: '首次使用需要生成主密钥。' })
  }

  const missing = files.filter((file) => file.currentHash === null)
  if (missing.length > 0) {
    notices.push({
      tone: '',
      title: `${missing.length} 个文件已从磁盘消失`,
      body: missing.map((file) => file.relativePath).join('、')
    })
  }

  const changed = files.filter((file) => file.drifted && file.currentHash !== null)
  if (changed.length > 0) {
    notices.push({
      tone: '',
      title: `${changed.length} 个文件在外部被修改`,
      body: `${changed.map((file) => file.relativePath).join('、')}。在你确认前不会覆盖。`
    })
  }

  if (project && !project.gitRoot) {
    notices.push({
      tone: 'blue',
      title: '项目不在 Git 仓库内',
      body: `${project.name} 找不到 .git，无法做跟踪状态检查。`
    })
  }

  if (notices.length === 0 && project) {
    notices.push({
      tone: 'green',
      title: '一切正常',
      body: `${project.name} 的 ${project.fileCount} 个文件都与中心记录一致。`
    })
  }

  return notices
}
