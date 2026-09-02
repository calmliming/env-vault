import { Fragment, useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { bridge } from '../lib/api'
import type { CredentialStore } from '../hooks/useCredentials'
import type { CredentialBindingView, CredentialSummary } from '@shared/ipc'

interface CredentialsViewProps {
  store: CredentialStore
  onAddCredential(): void
  onRotate(credential: CredentialSummary): void
  onBind(credential: CredentialSummary): void
  onSync(credential: CredentialSummary): void
  onDelete(credential: CredentialSummary): void
  onVaultAction(): void
  showToast(message: string): void
}

/**
 * 模型凭据页（开发计划 §5.3）。
 *
 * 列表字段照 §5.3：厂商 / 名称 / 地址 / Key 尾号 / 状态 / 绑定数。
 *
 * 🔴 列表里**没有**完整 Key，只有末四位和指纹。指纹的用途是回答
 * 「这两条记录是不是同一把 Key」—— 同一把 Key 在不同项目里指纹相同，
 * 而从指纹推不回 Key。想看明文要点「显示」，那次调用会留一条操作记录。
 */
export function CredentialsView({
  store,
  onAddCredential,
  onRotate,
  onBind,
  onSync,
  onDelete,
  onVaultAction,
  showToast
}: CredentialsViewProps): ReactNode {
  const { credentials, locked, loading, error } = store

  /** 展开的那一条，以及它的绑定列表。同一时刻只展开一条。 */
  const [expanded, setExpanded] = useState<number | null>(null)
  const [bindings, setBindings] = useState<CredentialBindingView[]>([])
  /** 已点开显示的 Key：id → 明文。不进任何持久层，切页面就没了。 */
  const [revealed, setRevealed] = useState<ReadonlyMap<number, string>>(new Map())
  /** 正在验证的那一条。同一时刻只允许一个在飞的验证请求。 */
  const [validating, setValidating] = useState<number | null>(null)

  const loadBindings = useCallback(async (credentialId: number) => {
    // 绑定列表跟着「同步预览」一起来 —— 它已经按绑定逐条算好了状态，
    // 单独再开一个只列绑定的通道等于把同一件事查两遍。
    const result = await bridge.previewCredentialSync(credentialId)
    if (!result.ok) {
      setBindings([])
      return
    }
    setBindings(
      result.data.targets.map((target) => ({
        id: target.bindingId,
        credentialId,
        projectId: target.projectId,
        projectName: target.projectName,
        environment: target.environment,
        keyVariable: target.keyVariable,
        endpointVariable: null,
        unresolved: target.state === 'missing-variable' || target.state === 'file-missing'
      }))
    )
  }, [])

  useEffect(() => {
    if (expanded === null) {
      setBindings([])
      return
    }
    void loadBindings(expanded)
  }, [expanded, loadBindings, credentials])

  async function toggleReveal(credential: CredentialSummary): Promise<void> {
    if (revealed.has(credential.id)) {
      setRevealed((prev) => {
        const next = new Map(prev)
        next.delete(credential.id)
        return next
      })
      return
    }
    const result = await bridge.revealCredential(credential.id)
    if (!result.ok) {
      showToast(result.message)
      return
    }
    setRevealed((prev) => new Map(prev).set(credential.id, result.data.apiKey))
    showToast('Key 已临时显示，本次操作已记入操作记录')
  }

  /**
   * 🔴 全应用唯一会发出站请求的动作，只在这里、只由这次点击触发。
   *
   * 不要给它加 `useEffect`、加重试、加「顺手验一下」——
   * 计划 §7 要求验证仅在用户显式发起时发生。
   *
   * 结果分两类，措辞必须分开：**没验出结论**（网络不通、限流、地址错）
   * 说的是「这次没问出来」，不是「你的 Key 坏了」。混为一谈会让用户
   * 在离线时以为自己的 Key 全废了。
   */
  async function validate(credential: CredentialSummary): Promise<void> {
    setValidating(credential.id)
    const result = await bridge.validateCredential(credential.id)
    setValidating(null)

    if (!result.ok) {
      showToast(result.message)
      return
    }
    await store.reload()
    showToast(
      result.data.conclusive
        ? result.data.message
        : `${result.data.message}凭据状态保持不变。`
    )
  }

  async function unbind(bindingId: number): Promise<void> {
    const result = await bridge.unbindCredential(bindingId)
    if (!result.ok) {
      showToast(result.message)
      return
    }
    await store.reload()
    showToast('已解除绑定，磁盘文件未改动')
  }

  async function copyKey(credential: CredentialSummary): Promise<void> {
    const result = await bridge.revealCredential(credential.id)
    if (!result.ok) {
      showToast(result.message)
      return
    }
    try {
      await navigator.clipboard.writeText(result.data.apiKey)
      showToast('已复制到剪贴板，自动清理将在阶段 4 接入')
    } catch {
      showToast('复制失败，请检查系统剪贴板权限')
    }
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <div className="eyebrow">独立凭据库</div>
          <h1>模型凭据</h1>
          <p className="page-subtitle">
            保存调用地址与 Key，按项目和环境建立绑定；改一次可以同步到全部绑定。
          </p>
        </div>
        <button className="primary-btn" onClick={onAddCredential} disabled={locked}>
          + 新增凭据
        </button>
      </div>

      {locked && (
        <div className="empty-section">
          <h2>Vault 已锁定</h2>
          <p>
            凭据的 Key 是加密存储的，解锁后才能读取。
            <button className="link-btn" onClick={onVaultAction}>
              去解锁
            </button>
          </p>
        </div>
      )}

      {!locked && error && (
        <div className="empty-section">
          <h2>读取失败</h2>
          <p>{error}</p>
        </div>
      )}

      {!locked && !error && loading && credentials.length === 0 && (
        <div className="empty-section">
          <h2>读取中…</h2>
        </div>
      )}

      {!locked && !error && !loading && credentials.length === 0 && (
        <div className="empty-section">
          <h2>还没有凭据</h2>
          <p>
            可以直接新增，也可以回到「配置总览」——
            那里会从已纳管的变量里识别出疑似的模型凭据，一键提取。
          </p>
          <div className="empty-actions">
            <button className="primary-btn" onClick={onAddCredential}>
              + 新增凭据
            </button>
          </div>
        </div>
      )}

      {!locked && !error && credentials.length > 0 && (
        <section className="panel credential-panel">
          <table className="config-table credential-table">
            <thead>
              <tr>
                <th>厂商 / 名称</th>
                <th>调用地址</th>
                <th>Key</th>
                <th>状态</th>
                <th>绑定</th>
                <th className="col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {credentials.map((credential) => {
                const plain = revealed.get(credential.id)
                const isOpen = expanded === credential.id
                return (
                  // key 要落在 map 返回的最外层节点上，也就是这个 Fragment，
                  // 放到里面的 <tr> 上 React 认不到。
                  <Fragment key={credential.id}>
                    <tr data-credential={credential.id}>
                      <td>
                        <div className="key-name">{credential.credentialName}</div>
                        <div className="credential-provider">{credential.providerName}</div>
                      </td>
                      <td>
                        <span className="value" title={credential.endpoint}>
                          {credential.endpoint}
                        </span>
                      </td>
                      <td>
                        <div className="value-cell">
                          <span className={plain ? 'value' : 'value masked'}>
                            {plain ?? `••••${credential.lastFour || '••••'}`}
                          </span>
                          <button
                            className="mini-btn"
                            data-action="reveal-credential"
                            title="显示或隐藏"
                            aria-label={`显示或隐藏 ${credential.credentialName} 的 Key`}
                            onClick={() => void toggleReveal(credential)}
                          >
                            ◉
                          </button>
                          <button
                            className="mini-btn"
                            data-action="copy-credential"
                            title="复制"
                            aria-label={`复制 ${credential.credentialName} 的 Key`}
                            onClick={() => void copyKey(credential)}
                          >
                            □
                          </button>
                        </div>
                        <div className="credential-fingerprint" title="同一把 Key 的指纹相同">
                          指纹 {credential.fingerprint.slice(0, 8)}
                        </div>
                      </td>
                      <td>
                        <span className={`type-tag ${statusTone(credential.status)}`}>
                          {STATUS_LABELS[credential.status]}
                        </span>
                        {/* 「什么时候验的」和「验成什么样」一样重要：
                            半年前验过的 active 和刚验过的 active 不是一回事。 */}
                        <div className="credential-validated-at">
                          {credential.lastValidatedAt === null
                            ? '尚未验证过'
                            : `验于 ${new Date(credential.lastValidatedAt).toLocaleString('zh-CN')}`}
                        </div>
                      </td>
                      <td>
                        <button
                          className="link-btn"
                          data-action="toggle-bindings"
                          onClick={() => setExpanded(isOpen ? null : credential.id)}
                        >
                          {credential.bindingCount} 处{isOpen ? ' ▴' : ' ▾'}
                        </button>
                      </td>
                      <td>
                        <div className="credential-actions">
                          <button
                            className="outline-btn tiny"
                            data-action="validate-credential"
                            onClick={() => void validate(credential)}
                            disabled={validating !== null}
                            title="向厂商的模型列表接口发一次请求，确认这把 Key 现在能不能用"
                          >
                            {validating === credential.id ? '验证中…' : '验证'}
                          </button>
                          <button className="outline-btn tiny" onClick={() => onBind(credential)}>
                            绑定
                          </button>
                          <button className="outline-btn tiny" onClick={() => onRotate(credential)}>
                            轮换
                          </button>
                          <button
                            className="outline-btn tiny"
                            data-action="sync-credential"
                            onClick={() => onSync(credential)}
                            disabled={credential.bindingCount === 0}
                            title={
                              credential.bindingCount === 0
                                ? '还没有绑定任何项目，没有可同步的地方'
                                : '预览并同步到全部绑定'
                            }
                          >
                            同步
                          </button>
                          <button
                            className="outline-btn tiny danger-text"
                            onClick={() => onDelete(credential)}
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="binding-row">
                        <td colSpan={6}>
                          {bindings.length === 0 ? (
                            <p className="panel-empty">
                              还没有绑定。绑定之后，改这一条凭据就能一次同步到所有用到它的项目。
                            </p>
                          ) : (
                            <div className="binding-list">
                              {bindings.map((binding) => (
                                <div className="binding-item" key={binding.id}>
                                  <div>
                                    <span className="key-name">{binding.projectName}</span>
                                    <span className="binding-env">{binding.environment}</span>
                                    <span className="binding-var">{binding.keyVariable}</span>
                                  </div>
                                  <div className="binding-tail">
                                    {binding.unresolved && (
                                      <span className="health-badge warn">找不到变量</span>
                                    )}
                                    <button
                                      className="link-btn"
                                      onClick={() => void unbind(binding.id)}
                                    >
                                      解绑
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </section>
      )}
    </section>
  )
}

/**
 * 🔴「已失效」和「已停用」是两件事，措辞上不能含糊：
 * 前者是厂商拒绝了这把 Key，后者是用户自己按的停用。
 * 用户看到前者要去厂商控制台换一把，看到后者只需要自己按回去。
 */
const STATUS_LABELS = {
  unverified: '未验证',
  active: '可用',
  invalid: '已失效',
  revoked: '已停用'
} as const

/** 复用配置表的 type-tag 配色，不另起一套。 */
function statusTone(status: CredentialSummary['status']): string {
  if (status === 'active') return 'boolean'
  // 「已失效」是需要用户去处理的坏消息，用和 secret 一样显眼的调子；
  // 「已停用」是用户自己的决定，不需要报警。
  if (status === 'invalid') return 'secret'
  if (status === 'revoked') return 'number'
  return 'text'
}
