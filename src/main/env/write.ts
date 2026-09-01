/**
 * 原子写回 `.env` 文件（开发计划 §6.3 步骤 4~5、§7「写文件前创建备份」）。
 *
 * ## 为什么必须原子
 *
 * 直接 `writeFileSync(target, content)` 会先把文件截断成 0 字节再写。
 * 如果这中间断电、崩溃、或者杀进程，用户拿到的是一个**空的** `.env` ——
 * 而这是他项目里唯一一份配置。所以流程是：
 *
 *   1. 备份原文件（到 userData，不是用户仓库里）
 *   2. 写同目录下的临时文件
 *   3. fsync 临时文件，确保内容真落盘而不是停在页缓存
 *   4. rename 覆盖目标 —— 同一文件系统内的 rename 是原子的
 *
 * 临时文件必须和目标**同目录**：跨设备 rename 会退化成复制+删除，就不原子了。
 *
 * ## 备份为什么不放在原目录
 *
 * `.env.bak-1234` 落在用户仓库里会被 `git status` 看见、可能被误提交、
 * 还会被下一次扫描当成 `.env.*` 文件发现。备份放 userData 下按项目哈希分目录。
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

export interface WriteOptions {
  /** 备份根目录。通常是 `<userData>/backups`。 */
  backupRoot: string
  /**
   * 写入前校验：磁盘当前内容的哈希必须等于这个值。
   * 传了就意味着「我基于这个版本算的改动」—— 对不上说明文件在我们决策
   * 期间又被改了，这时候写下去就是覆盖掉别人的修改（§6.4 的核心禁令）。
   */
  expectedHash?: string
}

export interface WriteResult {
  /** 备份文件的绝对路径。 */
  backupPath: string
  /** 写入后的内容哈希，调用方拿去更新 env_files.file_hash。 */
  newHash: string
  bytesWritten: number
}

/**
 * ⚠️ 不用构造函数参数属性（`constructor(readonly x: T)`）。
 * `env/` 下的模块要能被 `node --test` 直接跑，而 Node 的类型剥离是 strip-only 的，
 * 参数属性需要真正的代码生成，会报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
 */
export class WriteConflictError extends Error {
  readonly expected: string
  readonly actual: string | null

  constructor(expected: string, actual: string | null) {
    super('文件在准备写入期间被外部修改，已中止')
    this.name = 'WriteConflictError'
    this.expected = expected
    this.actual = actual
  }
}

export function writeEnvFileAtomic(
  targetPath: string,
  content: string,
  options: WriteOptions
): WriteResult {
  if (!existsSync(targetPath)) {
    throw new Error(`目标文件不存在：${targetPath}`)
  }

  // 1) 并发校验。必须在备份之前 —— 备份一个已经不是我们以为的那个版本没有意义。
  if (options.expectedHash !== undefined) {
    const actual = hashFile(targetPath)
    if (actual !== options.expectedHash) {
      throw new WriteConflictError(options.expectedHash, actual)
    }
  }

  // 2) 备份
  const backupPath = makeBackupPath(targetPath, options.backupRoot)
  mkdirSync(dirname(backupPath), { recursive: true })
  copyFileSync(targetPath, backupPath)

  // 3) 写临时文件 + fsync
  const directory = dirname(targetPath)
  const tempPath = join(directory, `.${basename(targetPath)}.envvault-${process.pid}-${Date.now()}.tmp`)
  const bytes = Buffer.from(content, 'utf8')

  // 继承原文件的权限位。新建文件默认 0o666&~umask，会把原来 0o600 的 .env 放宽。
  const mode = statSync(targetPath).mode & 0o777

  const fd = openSync(tempPath, 'w', mode)
  try {
    writeSync(fd, bytes)
    // 没有 fsync 的话，rename 可能先于数据落盘 —— 掉电后得到一个长度正确但内容是零的文件。
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }

  // 4) 原子替换。Node 在 Windows 上用 MoveFileExW + REPLACE_EXISTING，会覆盖已有文件。
  try {
    renameSync(tempPath, targetPath)
  } catch (error) {
    // rename 失败要把临时文件清掉，否则下次扫描会看到一堆 .tmp
    try {
      rmSync(tempPath, { force: true })
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw error
  }

  return {
    backupPath,
    newHash: createHash('sha256').update(bytes).digest('hex'),
    bytesWritten: bytes.length
  }
}

/**
 * 备份路径：`<backupRoot>/<目标路径哈希前 12 位>/<时间戳>-<文件名>`。
 *
 * 用路径哈希分目录而不是直接铺平，是因为不同项目里同名的 `.env.local` 会撞在一起；
 * 而完整路径当目录名在 Windows 上会超长（MAX_PATH）也带非法字符。
 */
export function makeBackupPath(targetPath: string, backupRoot: string): string {
  const bucket = createHash('sha256').update(targetPath).digest('hex').slice(0, 12)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(backupRoot, bucket, `${stamp}-${basename(targetPath)}`)
}

export function hashFile(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/** 把备份写回原位（同样走原子替换，所以恢复本身也不会写坏文件）。 */
export function restoreBackup(backupPath: string, targetPath: string, backupRoot: string): WriteResult {
  const content = readFileSync(backupPath).toString('utf8')
  if (!existsSync(targetPath)) {
    // 目标已被删除时先造一个空文件，让原子替换有东西可覆盖。
    writeFileSync(targetPath, '')
  }
  return writeEnvFileAtomic(targetPath, content, { backupRoot })
}
