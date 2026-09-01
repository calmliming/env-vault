/**
 * Toast：单条、自动消失，与原型行为一致（2600ms）。
 *
 * 刻意只保留一条：这是本地工具，同时冒出多条提示只会互相遮挡。
 * 新消息直接顶掉旧的，计时器重置。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

const TOAST_DURATION_MS = 2600

interface ToastApi {
  showToast(message: string): void
}

const ToastContext = createContext<ToastApi | null>(null)

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [message, setMessage] = useState('')
  const [visible, setVisible] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((next: string) => {
    setMessage(next)
    setVisible(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setVisible(false), TOAST_DURATION_MS)
  }, [])

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const api = useMemo(() => ({ showToast }), [showToast])

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/*
        节点常驻是有意的：aria-live 区域必须在消息出现之前就存在于 DOM 里，
        否则屏幕阅读器不会播报后插入的内容。
      */}
      <div className={visible ? 'toast show' : 'toast'} role="status" aria-live="polite">
        {message}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast 必须在 ToastProvider 内使用')
  return ctx
}
