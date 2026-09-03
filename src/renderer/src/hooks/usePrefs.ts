/**
 * 把「读初值 + 每次 set 时写回」这一对包起来的小 hook。
 *
 * 只做布尔和整数两种，不做泛型 `usePref<T>` —— 泛型版要么带上序列化参数
 * （调用处反而更啰嗦），要么默认 JSON.parse（那就吞掉了 readIntPref 里的
 * 白名单校验，而那个校验是有理由的，见 lib/prefs.ts）。
 */

import { useCallback, useState } from 'react'
import { readBoolPref, readIntPref, writeBoolPref, writeIntPref } from '../lib/prefs'

export function useBoolPref(key: string, fallback: boolean): [boolean, (next: boolean) => void] {
  // 惰性初值：每次渲染都读一次 localStorage 是没必要的同步 IO。
  const [value, setValue] = useState(() => readBoolPref(key, fallback))

  const update = useCallback(
    (next: boolean) => {
      setValue(next)
      writeBoolPref(key, next)
    },
    [key]
  )

  return [value, update]
}

export function useIntPref(
  key: string,
  fallback: number,
  allowed: readonly number[]
): [number, (next: number) => void] {
  const [value, setValue] = useState(() => readIntPref(key, fallback, allowed))

  const update = useCallback(
    (next: number) => {
      setValue(next)
      writeIntPref(key, next)
    },
    [key]
  )

  return [value, update]
}
