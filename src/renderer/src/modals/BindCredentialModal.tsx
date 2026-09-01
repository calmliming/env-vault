import { useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { ModalActions } from '../state/modal'
import { bridge } from '../lib/api'
import type { ConfigEntryView, CredentialSummary, ProjectSummary } from '@shared/ipc'

interface BindCredentialModalProps {
  close(): void
  showToast(message: string): void
  credential: CredentialSummary
  projects: ProjectSummary[]
  onBound(): void
}

/**
 * 把一条已有凭据绑定到某个项目环境的某个变量（§4.3、§6.2 步骤 4~5）。
 *
 * 变量名是**从这个环境已有的变量里选**，不是手打的。手打意味着一个拼错的
 * 变量名会生成一条永远同步不到任何东西的绑定，而且不会报错 ——
 * 它只会在轮换的时候悄悄少写一处。
 */
export function BindCredentialModal({
  close,
  showToast,
  credential,
  projects,
  onBound
}: BindCredentialModalProps): ReactNode {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? 0)
  const [environment, setEnvironment] = useState('')
  const [entries, setEntries] = useState<ConfigEntryView[]>([])
  const [keyVariable, setKeyVariable] = useState('')
  const [busy, setBusy] = useState(false)

  const project = projects.find((item) => item.id === projectId) ?? null

  // 换项目时把环境重置到它自己的第一个 —— 上一个项目的 staging
  // 在新项目里可能根本不存在，留着会得到一个空的变量列表。
  useEffect(() => {
    setEnvironment(project?.environments[0] ?? '')
  }, [project])

  useEffect(() => {
    if (projectId === 0 || environment === '') {
      setEntries([])
      return
    }
    let alive = true
    void bridge.listEntries({ projectId, environment }).then((result) => {
      if (!alive) return
      setEntries(result.ok ? result.data : [])
    })
    return () => {
      alive = false
    }
  }, [projectId, environment])

  /** 已经被别的凭据接管的变量不给选：那条绑定会因为唯一约束直接失败。 */
  const selectable = useMemo(
    () => entries.filter((entry) => entry.managedBy === null),
    [entries]
  )

  useEffect(() => {
    setKeyVariable(selectable[0]?.key ?? '')
  }, [selectable])

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (keyVariable === '') {
      showToast('请选择要绑定的变量')
      return
    }
    setBusy(true)
    const result = await bridge.bindCredential({
      credentialId: credential.id,
      projectId,
      environment,
      keyVariable
    })
    setBusy(false)
    if (!result.ok) {
      showToast(result.message)
      return
    }
    close()
    onBound()
    showToast(`已绑定 ${keyVariable}；绑定本身不会改动文件，需要时到「同步」写入`)
  }

  return (
    <>
      <p className="modal-copy">
        把 <span className="key-name">{credential.providerName} / {credential.credentialName}</span>{' '}
        绑定到一个项目环境的变量上。绑定只是建立对应关系，
        <strong>不会立刻改动任何文件</strong>。
      </p>

      {projects.length === 0 ? (
        <p className="modal-copy">还没有纳管任何项目，先去「配置总览」添加一个。</p>
      ) : (
        <form onSubmit={(event) => void onSubmit(event)}>
          <div className="form-grid two">
            <div className="field">
              <label htmlFor="bind-project">项目</label>
              <select
                id="bind-project"
                value={projectId}
                onChange={(e) => setProjectId(Number(e.target.value))}
              >
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="bind-environment">环境</label>
              <select
                id="bind-environment"
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
              >
                {(project?.environments ?? []).map((env) => (
                  <option key={env} value={env}>
                    {env}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="form-grid spaced">
            <div className="field">
              <label htmlFor="bind-variable">Key 变量名</label>
              <select
                id="bind-variable"
                value={keyVariable}
                onChange={(e) => setKeyVariable(e.target.value)}
                disabled={selectable.length === 0}
              >
                {selectable.map((entry) => (
                  <option key={entry.id} value={entry.key}>
                    {entry.key}
                  </option>
                ))}
              </select>
              <small>
                {selectable.length === 0
                  ? '这个环境里没有可绑定的变量（可能都已经被别的凭据接管了）。'
                  : '只列出这个环境里已有的变量 —— 手打一个拼错的名字会生成一条永远同步不到东西的绑定。'}
              </small>
            </div>
          </div>

          <ModalActions
            cancelText="取消"
            submitText={busy ? '绑定中…' : '建立绑定'}
            onCancel={close}
            submitDisabled={busy || selectable.length === 0}
          />
        </form>
      )}
    </>
  )
}
