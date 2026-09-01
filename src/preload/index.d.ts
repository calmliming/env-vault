import type { EnvVaultApi } from '@shared/ipc'

declare global {
  interface Window {
    /** 由 preload 通过 contextBridge 注入，见 src/preload/index.ts。 */
    envvault: EnvVaultApi
  }
}

export {}
