/**
 * 加密导出包的格式与口令加解密（开发计划 §7「导出配置必须二次确认，
 * 并优先导出加密包」，阶段 5c）。
 *
 * ## 为什么不复用 vault 那一套
 *
 * `vault.deriveSubkey` 是 HKDF，它的前提是输入**已经是**一段均匀随机的高熵密钥
 * （32 字节主密钥）。用户口令不是 —— 它低熵、可枚举，必须走一个带 salt 和
 * 工作因子的 KDF，否则拿到包的人可以用字典每秒试几百万次。
 *
 * 也不能拿主密钥派生：那样导出的包**只有本机能解**，而「换机器 / 备份」
 * 正是导出的用途。一个打不开的备份不叫备份。
 *
 * ## KDF 选 scrypt
 *
 * 不是因为它最好，是因为它是**这台机器上唯一装得上的**：Argon2 要编译原生模块，
 * 而这个环境没有 Visual Studio 构建工具（HANDOFF §3.1）。`node:crypto` 自带
 * scrypt，零依赖。这个取舍和 SQLite 用 `node:sqlite` 而不是 better-sqlite3 同源。
 *
 * ## 磁盘布局
 *
 * ```
 * 0   magic      'EVP1'   4      认不出来就不是我们的包，别去猜
 * 4   version    u8       1      格式版本，从 1 起
 * 5   kdfId      u8       1      1 = scrypt
 * 6   log2N      u8       1      scrypt 的 N = 1 << log2N
 * 7   r          u8       1
 * 8   p          u8       1
 * 9   reserved   u8[3]    3      对齐到 12，留给将来（比如压缩标志）
 * 12  salt                16
 * 28  iv                  12
 * 40  tag                 16
 * 56  ciphertext          ...
 * ```
 *
 * 🔴 **12 字节的头整个作为 AAD 参与认证。**
 *
 * ⚠️ 它保护的**不是** KDF 参数 —— 那几个字节本来就参与密钥派生，改一个字节
 * 派生出的密钥就变了，GCM 自然通不过，有没有 AAD 都一样。
 * （这一点是踩出来的：第一版的断言拿"改 log2N"去验 AAD，把 AAD 整个删掉
 * 那条断言照样绿 —— 它够不着自己要守的东西。见 PHASE-5C §7。）
 *
 * AAD 真正保护的是头里**不参与派生**的字段：`version` 和 9~11 那三个保留字节。
 * 今天 version 只有 1、保留字节还没启用，所以这是一道**为将来准备**的锁：
 * 等格式演进到 v2、或者某个保留位开始表示"包体是压缩的"，
 * 把它降回 v1 或翻掉那个标志位就会让解包方按错误的方式解释内容，
 * 而 AAD 让这种降级攻击当场失败。
 *
 * ⚠️ 这个模块要能被 `node --test` 直接跑（HANDOFF §5）：
 * import 必须带 `.ts` 后缀、不能用 `@shared/*` 别名、不能用构造函数参数属性。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const MAGIC = Buffer.from('EVP1', 'ascii')
const HEADER_BYTES = 12
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

/** 当前格式版本。解包时**拒绝**比它更新的版本，见 openPackage。 */
export const PACKAGE_VERSION = 1

const KDF_SCRYPT = 1

/**
 * scrypt 参数。N = 2^17、r = 8、p = 1 —— 约 128 MiB 内存、单次几百毫秒。
 *
 * 这是个取舍：再往上调用户会觉得"点了没反应"，往下调则离线爆破更便宜。
 * 128 MiB 的内存开销正是 scrypt 的价值所在 —— 它让 GPU/ASIC 并行爆破变贵，
 * 而这恰恰是纯计算型 KDF（PBKDF2）拦不住的。
 *
 * 参数写进包头，所以将来调大不会让旧包解不开。
 */
const DEFAULT_LOG2N = 17
const DEFAULT_R = 8
const DEFAULT_P = 1

/** scrypt 默认 maxmem 是 32 MiB，不显式抬高的话 N=2^17 会直接抛错。 */
function maxmemFor(n: number, r: number, p: number): number {
  return Math.max(32 * 1024 * 1024, 256 * n * r + 128 * r * p + 1024 * 1024)
}

export interface KdfParams {
  log2N: number
  r: number
  p: number
}

export const DEFAULT_KDF: KdfParams = { log2N: DEFAULT_LOG2N, r: DEFAULT_R, p: DEFAULT_P }

/**
 * 🔴 不用构造函数参数属性：这个目录要能被 `node --test` 直接跑，
 * 而 Node 的类型剥离是 strip-only 的，参数属性需要真正的代码生成。
 */
export class PackageError extends Error {
  readonly code: 'NOT_A_PACKAGE' | 'VERSION_TOO_NEW' | 'BAD_PASSPHRASE' | 'BAD_PARAMS'

  constructor(code: PackageError['code'], message: string) {
    super(message)
    this.name = 'PackageError'
    this.code = code
  }
}

function deriveKey(passphrase: string, salt: Buffer, kdf: KdfParams): Buffer {
  const n = 1 << kdf.log2N
  return scryptSync(passphrase.normalize('NFKC'), salt, KEY_BYTES, {
    N: n,
    r: kdf.r,
    p: kdf.p,
    maxmem: maxmemFor(n, kdf.r, kdf.p)
  })
}

/**
 * 把一段明文封成加密包。
 *
 * 口令先做 NFKC 归一化：用户在 macOS 上输入的带重音字符和在 Windows 上输入的
 * 可能是不同的码点序列，不归一化的话同一个口令在两台机器上派生出不同的密钥，
 * 表现是"我口令没输错但就是打不开"。
 */
export function sealPackage(plaintext: string, passphrase: string, kdf: KdfParams = DEFAULT_KDF): Buffer {
  if (passphrase.length === 0) {
    throw new PackageError('BAD_PARAMS', '口令不能为空')
  }

  const header = Buffer.alloc(HEADER_BYTES)
  MAGIC.copy(header, 0)
  header.writeUInt8(PACKAGE_VERSION, 4)
  header.writeUInt8(KDF_SCRYPT, 5)
  header.writeUInt8(kdf.log2N, 6)
  header.writeUInt8(kdf.r, 7)
  header.writeUInt8(kdf.p, 8)

  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = deriveKey(passphrase, salt, kdf)

  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    // 🔴 头进 AAD。注意它**不是**为了保护 KDF 参数（改那几个字节会直接改变
    // 派生出的密钥，GCM 本来就会失败）；它保护的是头里不参与派生的字段：
    // version 和保留字节。见 package.test.ts 里那两条用例。
    cipher.setAAD(header)
    // 🔴 头进 AAD：KDF 参数被改一个字节就解不开，见文件顶部。
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return Buffer.concat([header, salt, iv, cipher.getAuthTag(), body])
  } finally {
    // 派生密钥是堆外内存，用完清零 —— 和 vault.lock() 里的 fill(0) 同一个理由。
    key.fill(0)
  }
}

/**
 * 解开一个加密包。
 *
 * 🔴 口令错和文件损坏**在 GCM 这里是同一种失败**，我们分不出来，所以也不假装
 * 分得出来 —— 提示语两种可能都说。谎报成"口令错误"会让用户对着一个已经损坏的
 * 备份反复试口令。
 */
export function openPackage(blob: Buffer, passphrase: string): string {
  if (blob.length < HEADER_BYTES + SALT_BYTES + IV_BYTES + TAG_BYTES) {
    throw new PackageError('NOT_A_PACKAGE', '这个文件不是 EnvVault 导出包（长度不足）')
  }

  const header = blob.subarray(0, HEADER_BYTES)
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new PackageError('NOT_A_PACKAGE', '这个文件不是 EnvVault 导出包')
  }

  const version = header.readUInt8(4)
  if (version > PACKAGE_VERSION) {
    throw new PackageError(
      'VERSION_TOO_NEW',
      `这个包是更高版本（v${version}）的 EnvVault 导出的，请升级后再导入`
    )
  }
  if (header.readUInt8(5) !== KDF_SCRYPT) {
    throw new PackageError('BAD_PARAMS', '包里记的密钥派生算法本版本不认识')
  }

  const kdf: KdfParams = {
    log2N: header.readUInt8(6),
    r: header.readUInt8(7),
    p: header.readUInt8(8)
  }
  // 上界是防守：包头是攻击者能改的，log2N=40 会让我们试图分配 1 TiB 内存。
  // 头虽然进了 AAD，但 AAD 是在**派生之后**才校验的 —— 那时内存已经申请过了。
  if (kdf.log2N < 1 || kdf.log2N > 22 || kdf.r < 1 || kdf.r > 32 || kdf.p < 1 || kdf.p > 16) {
    throw new PackageError('BAD_PARAMS', '包头里的密钥派生参数超出合理范围，文件可能已损坏')
  }

  const salt = blob.subarray(HEADER_BYTES, HEADER_BYTES + SALT_BYTES)
  const iv = blob.subarray(HEADER_BYTES + SALT_BYTES, HEADER_BYTES + SALT_BYTES + IV_BYTES)
  const tagStart = HEADER_BYTES + SALT_BYTES + IV_BYTES
  const tag = blob.subarray(tagStart, tagStart + TAG_BYTES)
  const body = blob.subarray(tagStart + TAG_BYTES)

  const key = deriveKey(passphrase, salt, kdf)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(header)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    // 🔴 不绑定 error：这里的异常来自 OpenSSL，没有可用信息，
    // 而把它往上抛只会让 ipc 那层的兜底 console.error 打印出一堆无用的东西。
    throw new PackageError('BAD_PASSPHRASE', '口令不对，或者这个文件已经损坏')
  } finally {
    key.fill(0)
  }
}

/** 只读包头，不派生密钥、不解密。用于在问口令**之前**先确认这是个能认的包。 */
export function inspectPackage(blob: Buffer): { version: number; kdf: KdfParams } {
  if (blob.length < HEADER_BYTES || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new PackageError('NOT_A_PACKAGE', '这个文件不是 EnvVault 导出包')
  }
  return {
    version: blob.readUInt8(4),
    kdf: { log2N: blob.readUInt8(6), r: blob.readUInt8(7), p: blob.readUInt8(8) }
  }
}
