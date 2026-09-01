import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { ModalActions } from '../state/modal'
import { bridge } from '../lib/api'
import type { CredentialSuggestion, CredentialSummary, ProviderInfo } from '@shared/ipc'

interface CredentialModalProps {
  close(): void
  showToast(message: string): void
  providers: ProviderInfo[]
  /** 传了就是「轮换」：只换 Key，其余字段不动。 */
  rotating?: CredentialSummary
  /**
   * 从配置总览的识别建议里点进来时带上，用于预填厂商、地址和绑定。
   * 同时说明这把 Key 已经在某个文件里存在了 —— 表单会提示不必再粘一遍。
   */
  suggestion?: { projectId: number; suggestion: CredentialSuggestion }
  onSaved(credential: CredentialSummary): void
}

/**
 * 新增 / 轮换凭据（开发计划 §2.2、§6.5）。
 *
 * 🔴 Key 输入框是 `type="password"`：不让明文出现在录屏和截图里。
 *
 * 「轮换」只改凭据本身，**不碰任何文件** —— 同步到绑定的文件是独立的一步
 * （预览 → 勾选 → 写入）。把写多个 `.env` 作为"保存"的副作用发生，
 * 是用户最不希望在一个密钥管理器里遇到的事。
 */
export function CredentialModal({
  close,
  showToast,
  providers,
  rotating,
  suggestion,
  onSaved
}: CredentialModalProps): ReactNode {
  const suggested = suggestion?.suggestion
  const [providerId, setProviderId] = useState(
    rotating?.providerId ?? suggested?.providers[0]?.providerId ?? providers[0]?.id ?? 'openai'
  )
  const [name, setName] = useState(rotating?.credentialName ?? 'primary')
  const [endpoint, setEndpoint] = useState(
    rotating?.endpoint ?? suggested?.endpointPreview ?? defaultEndpointOf(providers, providerId)
  )
  const [apiKey, setApiKey] = useState('')
  const [bindHere, setBindHere] = useState(suggested !== undefined)
  const [busy, setBusy] = useState(false)

  /** 换厂商时把地址跟着换成那家的默认值 —— 除非用户已经自己改过。 */
  function pickProvider(nextId: string): void {
    const previousDefault = defaultEndpointOf(providers, providerId)
    setProviderId(nextId)
    if (endpoint === previousDefault || endpoint === '') {
      setEndpoint(defaultEndpointOf(providers, nextId))
    }
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (apiKey.trim() === '') {
      showToast('请填写 API Key')
      return
    }

    setBusy(true)
    const result = rotating
      ? await bridge.updateCredential({ credentialId: rotating.id, apiKey })
      : await bridge.createCredential({
          providerId,
          credentialName: name,
          endpoint,
          apiKey,
          ...(bindHere && suggestion
            ? {
                bind: {
                  projectId: suggestion.projectId,
                  environment: suggested!.environment,
                  keyVariable: suggested!.key,
                  endpointVariable: suggested!.endpointVariable
                }
              }
            : {})
        })
    setBusy(false)

    if (!result.ok) {
      showToast(result.message)
      return
    }
    close()
    onSaved(result.data)
    showToast(
      rotating
        ? `已轮换 ${result.data.credentialName} 的 Key；文件尚未同步，去「同步」预览影响范围`
        : `凭据已加密保存${bindHere && suggestion ? `，并绑定到 ${suggested!.key}` : ''}`
    )
  }

  return (
    <>
      <p className="modal-copy">
        {rotating
          ? '只更换这条凭据的 Key。绑定的文件不会被自动改写 —— 保存后到「同步」里预览影响范围再决定。'
          : '只保存调用地址与 API Key。列表里只展示指纹和末四位，原值加密保存在本地 Vault。'}
      </p>

      {suggested && (
        <p className="modal-note">
          来自 <span className="key-name">{suggested.sourceFile}</span> 的{' '}
          <span className="key-name">{suggested.key}</span>
          {suggested.providers.length > 1 && (
            <>
              {' '}
              —— 变量名和值指向了不同的厂商（
              {suggested.providers.map((p) => `${p.providerName}｜${basisLabel(p.basis)}`).join('，')}
              ），请确认选对了哪一家。
            </>
          )}
        </p>
      )}

      <form onSubmit={(event) => void onSubmit(event)}>
        {!rotating && (
          <div className="form-grid two">
            <div className="field">
              <label htmlFor="provider-name">厂商</label>
              <select
                id="provider-name"
                value={providerId}
                onChange={(e) => pickProvider(e.target.value)}
              >
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.providerName}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="credential-name">凭据名称</label>
              <input
                id="credential-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>
        )}

        <div className="form-grid spaced">
          {!rotating && (
            <div className="field">
              <label htmlFor="credential-endpoint">调用地址</label>
              <input
                id="credential-endpoint"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                required
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="credential-key">{rotating ? '新的 API Key' : 'API Key'}</label>
            <input
              id="credential-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="粘贴完整 Key"
              required
            />
            <small>
              {suggested
                ? '这把 Key 已经在文件里了，但我们不会替你把它读出来填进这个框 —— 请从厂商控制台或那个文件里自己粘贴一次。'
                : '列表只展示指纹和末四位，原值加密保存在本地 Vault。'}
            </small>
          </div>

          {suggestion && !rotating && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={bindHere}
                onChange={(e) => setBindHere(e.target.checked)}
              />
              保存后绑定到 {suggested!.key}（{suggested!.environment}）
            </label>
          )}
        </div>

        <ModalActions
          cancelText="取消"
          submitText={busy ? '保存中…' : rotating ? '保存新 Key' : '保存凭据'}
          onCancel={close}
          submitDisabled={busy}
        />
      </form>
    </>
  )
}

function defaultEndpointOf(providers: ProviderInfo[], providerId: string): string {
  return providers.find((provider) => provider.id === providerId)?.defaultEndpoint ?? ''
}

const BASIS_LABELS = {
  value: '按值识别',
  'variable-name': '按变量名识别',
  both: '值与变量名一致'
} as const

function basisLabel(basis: keyof typeof BASIS_LABELS): string {
  return BASIS_LABELS[basis]
}
