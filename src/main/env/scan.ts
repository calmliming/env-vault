/**
 * 项目目录扫描（开发计划 §6.1「添加项目与扫描」步骤 1~3）。
 *
 * 这一层是**只读**的：它发现文件、算哈希、解析内容，但绝不写盘、也不碰数据库。
 * §6.1 明确要求「展示发现的文件和变量数量，不立即修改文件」，
 * 把只读扫描和入库分成两个函数，是让那条要求在类型上就成立，而不是靠自觉。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { classify, identifyEnvFile, type Sensitivity, type ValueType } from './classify.ts'
import { entriesOf, formatSkeleton, parseEnv } from './document.ts'

/**
 * 解析器版本。写进 `env_files.parser_version`。
 * 解析规则有实质变化时 +1，这样升级后可以识别出哪些记录需要重新解析。
 */
export const PARSER_VERSION = 1

/**
 * 不进去找的目录。这些地方要么装的是依赖，要么是构建产物 ——
 * 里面的 `.env` 不是用户的源文件，纳管只会在下次 `npm install` 后变成幽灵记录。
 */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'vendor',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.gradle',
  '.idea',
  '.vscode'
])

/** `.env` 文件不该有这么大。超过就当它不是配置文件，跳过而不是读进内存。 */
const MAX_FILE_BYTES = 1024 * 1024

export interface ScanOptions {
  /** 相对项目根目录的最大深度。monorepo 的 `apps/web/.env.local` 是深度 2。 */
  maxDepth?: number
  /** 最多收多少个文件，防止选到 `C:\` 这种目录时扫穿整块盘。 */
  maxFiles?: number
}

export interface ScannedEntry {
  key: string
  value: string
  valueType: ValueType
  sensitivity: Sensitivity
  lineNumber: number
  /**
   * 该条目那一行的**格式骨架**：原始行文本，但值换成了占位符（§4.2 original_format）。
   *
   * 🔴 存骨架而不是原始行，是因为它的落点 `config_entries.original_format`
   * 是一个不加密的 TEXT 列。把 `API_KEY=sk-...` 整行存进去，明文就落库了。
   */
  originalFormat: string
}

export interface ScannedFile {
  absolutePath: string
  /** 相对项目根目录，用于展示。始终用 `/` 分隔，避免界面上出现反斜杠。 */
  relativePath: string
  fileName: string
  environment: string
  isTemplate: boolean
  /** 文件内容的 sha256，外部修改检测的基准（§6.4）。 */
  fileHash: string
  byteSize: number
  entries: ScannedEntry[]
  /** 读取失败的原因；非 null 时 entries 为空。 */
  error: string | null
}

export interface ScanResult {
  rootPath: string
  /** 项目所在的 Git 仓库根目录，找不到则为 null。 */
  gitRoot: string | null
  files: ScannedFile[]
  /** 是否因为触到 maxFiles/maxDepth 上限而没扫全。 */
  truncated: boolean
  scannedAt: number
}

/**
 * 从 `startDir` 向上找 `.git`。
 * 注意 `.git` 在 worktree 和 submodule 里是**文件**不是目录，所以只判存在。
 */
export function findGitRoot(startDir: string): string | null {
  let current = resolve(startDir)
  // 用路径长度收敛而不是 while(true)：到根目录后 dirname 会返回自身，否则死循环。
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = resolve(current, '..')
    if (parent === current) return null
    current = parent
  }
}

export function scanProject(rootPath: string, options: ScanOptions = {}): ScanResult {
  const maxDepth = options.maxDepth ?? 6
  const maxFiles = options.maxFiles ?? 200
  const root = resolve(rootPath)

  const files: ScannedFile[] = []
  let truncated = false

  const walk = (dir: string, depth: number): void => {
    if (files.length >= maxFiles) {
      truncated = true
      return
    }
    if (depth > maxDepth) {
      truncated = true
      return
    }

    let dirents
    try {
      dirents = readdirSync(dir, { withFileTypes: true })
    } catch {
      // 权限不足或目录消失：跳过这一支，不让整次扫描失败。
      return
    }

    // 先文件后目录：浅层的 `.env` 比深层的更重要，触到 maxFiles 时先留住浅的。
    for (const dirent of dirents) {
      if (!dirent.isFile()) continue
      const identity = identifyEnvFile(dirent.name)
      if (!identity) continue
      if (files.length >= maxFiles) {
        truncated = true
        return
      }
      files.push(readEnvFile(join(dir, dirent.name), root, dirent.name, identity))
    }

    for (const dirent of dirents) {
      // 不跟随符号链接：指回上层的链接会让遍历绕不出来。
      if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue
      if (SKIP_DIRECTORIES.has(dirent.name)) continue
      walk(join(dir, dirent.name), depth + 1)
    }
  }

  walk(root, 0)

  return {
    rootPath: root,
    gitRoot: findGitRoot(root),
    files,
    truncated,
    scannedAt: Date.now()
  }
}

/**
 * 只读一个已知路径的 `.env` 文件，不走目录遍历。
 * 用于「以磁盘为准重新导入这一个文件」（§6.4），那时路径已经在库里了。
 */
export function scanSingleFile(absolutePath: string, projectRoot: string): ScannedFile | null {
  const fileName = basename(absolutePath)
  const identity = identifyEnvFile(fileName)
  if (!identity) return null
  return readEnvFile(absolutePath, resolve(projectRoot), fileName, identity)
}

function readEnvFile(
  absolutePath: string,
  root: string,
  fileName: string,
  identity: { environment: string; isTemplate: boolean }
): ScannedFile {
  const base: Omit<ScannedFile, 'fileHash' | 'byteSize' | 'entries' | 'error'> = {
    absolutePath,
    relativePath: relative(root, absolutePath).split(sep).join('/'),
    fileName,
    environment: identity.environment,
    isTemplate: identity.isTemplate
  }

  try {
    const size = statSync(absolutePath).size
    if (size > MAX_FILE_BYTES) {
      return { ...base, fileHash: '', byteSize: size, entries: [], error: '文件过大，未纳入解析' }
    }

    const bytes = readFileSync(absolutePath)
    const fileHash = hashBytes(bytes)
    const doc = parseEnv(bytes.toString('utf8'))

    const entries = entriesOf(doc).map<ScannedEntry>((node) => {
      const { valueType, sensitivity } = classify(node.key, node.value)
      return {
        key: node.key,
        value: node.value,
        valueType,
        sensitivity,
        lineNumber: node.lineNumber,
        originalFormat: formatSkeleton(node)
      }
    })

    return { ...base, fileHash, byteSize: size, entries, error: null }
  } catch (error) {
    return {
      ...base,
      fileHash: '',
      byteSize: 0,
      entries: [],
      error: error instanceof Error ? error.message : '读取失败'
    }
  }
}

export function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function hashText(text: string): string {
  return hashBytes(Buffer.from(text, 'utf8'))
}

/** 当前磁盘上的文件是否还和记录里的哈希一致。文件不存在时返回 null。 */
export function currentFileHash(absolutePath: string): string | null {
  try {
    return hashBytes(readFileSync(absolutePath))
  } catch {
    return null
  }
}
