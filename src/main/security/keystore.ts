/**
 * 系统密钥库封装（开发计划 §3.1「系统密钥库」、§7「主密钥只保存在操作系统密钥库」）。
 *
 * 底层用 Electron 的 `safeStorage`，它按平台映射到：
 *   Windows → DPAPI（绑定当前 Windows 用户账户）
 *   macOS   → Keychain
 *   Linux   → Secret Service（gnome-libsecret / kwallet），无桌面环境时降级为
 *             `basic_text`，那实际上是硬编码密钥的混淆，**不是加密**。
 *
 * 🔴 因此 `isAvailable()` 在 Linux 上必须额外拒绝 `basic_text` 后端：
 * 让主密钥落在一个人人可解的文件里，比不加密更危险，因为界面会显示「已加密」。
 * 这一条是这个文件存在的主要理由，不要为了让 Linux 跑起来而删掉。
 */

import { app, safeStorage } from 'electron'

/** Linux 上 safeStorage 的降级后端，不提供真实加密。 */
const INSECURE_LINUX_BACKENDS = new Set(['basic_text'])

export function getBackendName(): string {
  if (process.platform === 'win32') return 'dpapi'
  if (process.platform === 'darwin') return 'keychain'
  if (process.platform === 'linux') {
    try {
      // getSelectedStorageBackend 只在 Linux 上有定义，且必须在 app ready 之后调用。
      return app.isReady() ? safeStorage.getSelectedStorageBackend() : 'unknown'
    } catch {
      return 'unknown'
    }
  }
  return 'unknown'
}

export function isAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform === 'linux' && INSECURE_LINUX_BACKENDS.has(getBackendName())) return false
  return true
}

/** 用系统密钥库加密任意字节。调用前必须先确认 isAvailable()。 */
export function encrypt(plain: Buffer): Buffer {
  if (!isAvailable()) {
    throw new Error('系统密钥库不可用，拒绝写入未受保护的密钥')
  }
  // safeStorage 只收字符串，用 base64 承载二进制，避免非 UTF-8 字节被破坏。
  return safeStorage.encryptString(plain.toString('base64'))
}

export function decrypt(cipher: Buffer): Buffer {
  if (!isAvailable()) {
    throw new Error('系统密钥库不可用，无法解密主密钥')
  }
  return Buffer.from(safeStorage.decryptString(cipher), 'base64')
}
