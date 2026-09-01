/**
 * 弹窗宿主。
 *
 * 与原型的行为差异只有一处，其余（Esc 关闭、点遮罩关闭、打开后聚焦第一个字段）
 * 都照搬：**关闭时整个弹窗从 DOM 移除**，而不是留在树里靠 opacity 隐藏。
 * 原型那种常驻写法会让隐藏的表单字段仍然可被 Tab 聚焦，键盘用户会"掉进"
 * 一个看不见的弹窗里。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export interface ModalRenderContext {
  close(): void
}

export interface ModalDescriptor {
  kicker: string
  title: string
  render(ctx: ModalRenderContext): ReactNode
}

interface ModalApi {
  openModal(descriptor: ModalDescriptor): void
  closeModal(): void
}

const ModalContext = createContext<ModalApi | null>(null)

export function ModalProvider({ children }: { children: ReactNode }): ReactNode {
  const [descriptor, setDescriptor] = useState<ModalDescriptor | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const closeModal = useCallback(() => setDescriptor(null), [])
  const openModal = useCallback((next: ModalDescriptor) => setDescriptor(next), [])

  useEffect(() => {
    if (!descriptor) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeModal()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [descriptor, closeModal])

  useEffect(() => {
    if (!descriptor) return
    // 与原型一致：等一帧再聚焦，避免动画起始位置上的元素抢到焦点后触发滚动跳动。
    const id = setTimeout(() => {
      bodyRef.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus()
    }, 50)
    return () => clearTimeout(id)
  }, [descriptor])

  const api = useMemo(() => ({ openModal, closeModal }), [openModal, closeModal])

  return (
    <ModalContext.Provider value={api}>
      {children}
      {descriptor && (
        <div className="modal-layer">
          <div className="modal-backdrop" onClick={closeModal} />
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <div className="modal-head">
              <div>
                <div className="eyebrow">{descriptor.kicker}</div>
                <h2 id="modal-title">{descriptor.title}</h2>
              </div>
              <button className="modal-close" onClick={closeModal} aria-label="关闭弹窗">
                ×
              </button>
            </div>
            <div className="modal-body" ref={bodyRef}>
              {descriptor.render({ close: closeModal })}
            </div>
          </section>
        </div>
      )}
    </ModalContext.Provider>
  )
}

export function useModal(): ModalApi {
  const ctx = useContext(ModalContext)
  if (!ctx) throw new Error('useModal 必须在 ModalProvider 内使用')
  return ctx
}

/** 弹窗底部的取消/确认按钮组，原型里的 formActions()。 */
export function ModalActions({
  cancelText = '取消',
  submitText = '确认',
  onCancel,
  submitDisabled = false
}: {
  cancelText?: string
  submitText?: string
  onCancel(): void
  submitDisabled?: boolean
}): ReactNode {
  return (
    <div className="modal-actions">
      <button type="button" className="outline-btn" onClick={onCancel}>
        {cancelText}
      </button>
      <button type="submit" className="primary-btn" disabled={submitDisabled}>
        {submitText}
      </button>
    </div>
  )
}
