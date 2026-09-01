/**
 * Vault：主密钥的生命周期，以及配置值的加解密（开发计划 §7）。
 *
 * 三态模型：
 *   uninitialized —— 本机还没有主密钥文件，需要先 initialize()
 *   locked        —— 主密钥文件存在，但明文密钥不在内存里，任何值都解不开
 *   unlocked      —— 明文主密钥在内存里，可以 encryptValue / decryptValue
 *
 * 密钥不下磁盘明文：32 字节随机主密钥经系统密钥库加密后写入 `vault.key`。
 * 解锁 = 把它读回来解密进内存；锁定 = 把内存里的那块 Buffer 清零并丢弃引用。
 *
 * 🔴 `lock()` 里的 `fill(0)` 不是形式主义：Buffer 是堆外内存，不清零的话
 * 进程崩溃时的 core dump、以及被换出的内存页里都会留下完整主密钥。
 *
 * 首版没有用户口令。这是有意的：主密钥由操作系统账户保护（Windows DPAPI 绑定
 * 登录用户），能读到 `vault.key` 的攻击者通常已经能读到用户目录下的 `.env*` 原文，
 * 再加一层口令只会带来「忘记口令等于丢全部配置」的新失败模式。
 * 要加口令属于阶段 4 的范围，届时把它作为主密钥的第二层包装即可，
 * 磁盘格式已经预留了 `version` 字段来做这次迁移。
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import * as keystore from './keystore'
import type { VaultStatus } from '@shared/ipc'

const KEY_FILE_NAME = 'vault.key'
const KEY_FILE_VERSION = 1
const MASTER_KEY_BYTES = 32
const GCM_IV_BYTES = 12
const GCM_TAG_BYTES = 16

/**
 * `vault.key` 的磁盘格式：一个 4 字节头 + 系统密钥库密文。
 * 头里的 version 让将来换 KDF / 加口令时能识别旧文件而不是把它当损坏处理。
 */
const HEADER_MAGIC = Buffer.from('EVK1', 'ascii')

/** 明文主密钥。只在 unlocked 状态下非空。 */
let masterKey: Buffer | null = null
let unlockedAt: number | null = null

function keyFilePath(): string {
  return join(app.getPath('userData'), KEY_FILE_NAME)
}

export function getStatus(): VaultStatus {
  const keystoreAvailable = keystore.isAvailable()
  const path = keyFilePath()

  let state: VaultStatus['state']
  if (masterKey) state = 'unlocked'
  else if (existsSync(path)) state = 'locked'
  else state = 'uninitialized'

  return {
    state,
    keystoreAvailable,
    keystoreBackend: keystore.getBackendName(),
    keyFilePath: path,
    unlockedAt: masterKey ? unlockedAt : null
  }
}

/**
 * 首次运行：生成主密钥、经系统密钥库加密后落盘，并直接进入 unlocked。
 * 已经初始化过时不覆盖 —— 覆盖等于让库里所有密文永久解不开。
 */
export function initialize(): VaultStatus {
  const path = keyFilePath()
  if (existsSync(path)) {
    // 已有密钥文件，initialize 退化为 unlock，避免误操作销毁现有 Vault。
    return unlock()
  }
  if (!keystore.isAvailable()) {
    throw new VaultError('KEYSTORE_UNAVAILABLE', '系统密钥库不可用，无法安全创建本地 Vault')
  }

  const key = randomBytes(MASTER_KEY_BYTES)
  const sealed = keystore.encrypt(key)

  mkdirSync(app.getPath('userData'), { recursive: true })
  // mode 0o600 在 Windows 上被忽略（那里靠 DPAPI 的账户绑定），
  // 但在 macOS / Linux 上它是防止同机其他用户读到密文的第一道门。
  writeFileSync(path, Buffer.concat([HEADER_MAGIC, sealed]), { mode: 0o600 })

  masterKey = key
  unlockedAt = Date.now()
  return getStatus()
}

export function unlock(): VaultStatus {
  if (masterKey) return getStatus()

  const path = keyFilePath()
  if (!existsSync(path)) {
    throw new VaultError('VAULT_UNINITIALIZED', '本机还没有创建 Vault')
  }
  if (!keystore.isAvailable()) {
    throw new VaultError('KEYSTORE_UNAVAILABLE', '系统密钥库不可用，无法解锁 Vault')
  }

  const raw = readFileSync(path)
  const magic = raw.subarray(0, HEADER_MAGIC.length)
  if (magic.length !== HEADER_MAGIC.length || !timingSafeEqual(magic, HEADER_MAGIC)) {
    throw new VaultError('INTERNAL', `密钥文件格式无法识别（期望版本 ${KEY_FILE_VERSION}）`)
  }

  const key = keystore.decrypt(raw.subarray(HEADER_MAGIC.length))
  if (key.length !== MASTER_KEY_BYTES) {
    throw new VaultError('INTERNAL', '主密钥长度异常，密钥文件可能已损坏')
  }

  masterKey = key
  unlockedAt = Date.now()
  return getStatus()
}

/** 锁定并清零内存中的主密钥。幂等。 */
export function lock(): VaultStatus {
  if (masterKey) {
    masterKey.fill(0)
    masterKey = null
  }
  unlockedAt = null
  return getStatus()
}

// ---------------------------------------------------------------------------
// 值加解密：AES-256-GCM
// ---------------------------------------------------------------------------

/**
 * 密文布局：`IV(12) || TAG(16) || CIPHERTEXT`。
 * 选 GCM 是因为它自带完整性校验 —— 用户手改了库里的 BLOB，解密会直接失败，
 * 而不是安静地吐出一段乱码再被当成配置值写回 `.env`。
 */
export function encryptValue(plaintext: string): Buffer {
  const key = requireKey()
  const iv = randomBytes(GCM_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

export function decryptValue(payload: Buffer): string {
  const key = requireKey()
  if (payload.length < GCM_IV_BYTES + GCM_TAG_BYTES) {
    throw new VaultError('INTERNAL', '密文长度不足，记录可能已损坏')
  }
  const iv = payload.subarray(0, GCM_IV_BYTES)
  const tag = payload.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES)
  const body = payload.subarray(GCM_IV_BYTES + GCM_TAG_BYTES)

  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}

function requireKey(): Buffer {
  if (!masterKey) {
    throw new VaultError('VAULT_LOCKED', 'Vault 已锁定，请先解锁')
  }
  return masterKey
}

/**
 * 从主密钥派生一把**用途隔离**的子密钥（HKDF-SHA256）。
 *
 * 用途隔离的意思是：不同 label 派生出的子密钥互相独立，
 * 拿到其中一把推不出主密钥、也推不出另一把。所以需要一把"稳定的秘密"
 * （比如指纹用的 HMAC 密钥）时，派生一把出来，而不是把 masterKey 交出去。
 *
 * 🔴 这个函数**不返回主密钥本身**，也不该被改成那样。
 * 主密钥只在这个模块里存在，是 §7「解密值只在必要的内存生命周期内存在」的前提。
 */
export function deriveSubkey(label: string, bytes = 32): Buffer {
  const key = requireKey()
  // salt 留空、用途写进 info：主密钥本身已经是 32 字节均匀随机，
  // HKDF 在这种输入下不需要额外的 salt 来提取熵。
  return Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), `envvault:${label}`, bytes))
}

// ---------------------------------------------------------------------------

export class VaultError extends Error {
  constructor(
    readonly code: 'VAULT_LOCKED' | 'VAULT_UNINITIALIZED' | 'KEYSTORE_UNAVAILABLE' | 'INTERNAL',
    message: string
  ) {
    super(message)
    this.name = 'VaultError'
  }
}
