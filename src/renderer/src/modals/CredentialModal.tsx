import type { FormEvent, ReactNode } from 'react'
import { ModalActions } from '../state/modal'

/** 首批适配的厂商（开发计划 §8）。阶段 3 接入验证适配器时会挪到 shared。 */
const PROVIDER_OPTIONS = [
  'OpenAI',
  'Anthropic',
  'Google Gemini',
  'DeepSeek',
  'OpenRouter',
  '自定义厂商'
] as const

interface CredentialModalProps {
  close(): void
  showToast(message: string): void
}

/**
 * 「新增调用凭据」表单，字段与开发计划 §2.2 一致：厂商 / 名称 / 调用地址 / API Key。
 * 落库属于阶段 3，所以这里不做受控输入 —— 没有任何地方会读这些值，
 * 用 defaultValue 让浏览器自己管，避免写出一堆假装在存数据的 state。
 *
 * 🔴 Key 输入框用 type="password"：即便还没接后端，也不让明文 Key 出现在录屏和截图里。
 */
export function CredentialModal({ close, showToast }: CredentialModalProps): ReactNode {
  function onSubmit(event: FormEvent): void {
    event.preventDefault()
    close()
    showToast('凭据表单已就绪，加密存储将在阶段 3 接入')
  }

  return (
    <>
      <p className="modal-copy">
        只保存调用地址与 API Key。Key 默认掩码，保存后可绑定到多个项目环境。
      </p>
      <form onSubmit={onSubmit}>
        <div className="form-grid two">
          <div className="field">
            <label htmlFor="provider-name">厂商</label>
            <select id="provider-name" defaultValue={PROVIDER_OPTIONS[0]}>
              {PROVIDER_OPTIONS.map((provider) => (
                <option key={provider}>{provider}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="credential-name">凭据名称</label>
            <input id="credential-name" defaultValue="primary" />
          </div>
        </div>
        <div className="form-grid spaced">
          <div className="field">
            <label htmlFor="credential-endpoint">调用地址</label>
            <input id="credential-endpoint" defaultValue="https://api.openai.com/v1" required />
          </div>
          <div className="field">
            <label htmlFor="credential-key">API Key</label>
            <input id="credential-key" type="password" placeholder="粘贴完整 Key" required />
            <small>列表只展示指纹和末四位，原值加密保存在本地 Vault。</small>
          </div>
          <label className="check-row">
            <input type="checkbox" defaultChecked />
            保存后绑定到 musegen-one / development
          </label>
        </div>
        <ModalActions cancelText="取消" submitText="保存凭据" onCancel={close} />
      </form>
    </>
  )
}
