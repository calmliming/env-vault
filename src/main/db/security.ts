/**
 * 安全检查（开发计划 §9 阶段 4「Git tracked 检查和 .gitignore 检查、
 * 疑似敏感值检测和风险分级」）。
 *
 * 把三样东西合成一份报告：
 *
 * ```
 * 磁盘上有哪些 .env*        ← env/scan.ts（连未纳管的也扫）
 * 每个文件里有多敏感的值     ← 纳管的查库、未纳管的就地分类
 * Git 拿它们怎么办          ← git/inspect.ts
 *                          ↓
 *                     git/risk.ts 判定
 * ```
 *
 * ## 🔴 报告里只有计数，没有值
 *
 * `FileRisk` 这个类型里压根没有能放配置值的字段 —— 不是靠调用方自觉不填，
 * 是类型上就填不进去。纳管文件的敏感度直接查 `config_entries.sensitivity`
 * 那一列（它本来就不加密），**全程不解密任何东西**。
 *
 * 副产品是这个页面在 **Vault 锁着的时候照样能用**，而这恰恰是它最该能用的
 * 时候之一：你不需要解开保险柜，才能知道保险柜有没有被拍照上传到 GitHub。
 *
 * ## 为什么连未纳管的文件也扫
 *
 * 用户在导入时取消勾选的 `.env.production` 不在库里，但它照样躺在磁盘上、
 * 照样可能正被 Git 跟踪着。安全页只看已导入的那几个，等于只检查用户
 * 已经在意的部分 —— 而漏掉的往往正是他没在意的那个。
 */

import { basename } from 'node:path'
import { getDatabase } from './index'
import { RepositoryError, getProject, toRelative } from './repositories'
import { identifyEnvFile } from '../env/classify.ts'
import { scanProject } from '../env/scan.ts'
import { inspectPaths, toRepoPath } from '../git/inspect.ts'
import { gradeRisk } from '../git/risk.ts'
import type { GitRunner } from '../git/run.ts'
import type { PathStatus } from '../git/inspect.ts'
import { RISK_ORDER } from '@shared/security-types'
import type { FileRisk, SecurityReport } from '@shared/ipc'

interface ManagedRow {
  absolute_path: string
  environment: string
  entry_count: number
  high_count: number
  sensitive_count: number
}

/** 纳管文件的敏感度统计。只数不解密 —— `sensitivity` 那一列是明文存的。 */
function managedFiles(projectId: number): Map<string, ManagedRow> {
  const rows = getDatabase()
    .prepare(
      `SELECT f.absolute_path, f.environment,
              COUNT(c.id) AS entry_count,
              COALESCE(SUM(CASE WHEN c.sensitivity = 'high' THEN 1 ELSE 0 END), 0) AS high_count,
              COALESCE(SUM(CASE WHEN c.sensitivity = 'sensitive' THEN 1 ELSE 0 END), 0) AS sensitive_count
       FROM env_files f
       LEFT JOIN config_entries c ON c.env_file_id = f.id
       WHERE f.project_id = ?
       GROUP BY f.id`
    )
    .all<ManagedRow>(projectId)
  return new Map(rows.map((row) => [row.absolute_path, row]))
}

/** 报告里每一条的骨架，Git 状态和判定还没填上。 */
interface Candidate {
  absolutePath: string
  relativePath: string
  fileName: string
  environment: string
  isTemplate: boolean
  managed: boolean
  onDisk: boolean
  entryCount: number
  highCount: number
  sensitiveCount: number
}

/**
 * 扫一个项目，给出每个 `.env*` 的风险等级。
 *
 * `runner` 可注入：验收脚本要么塞一个假的（不起进程），要么用真的对着一个
 * 真 git 仓库跑。默认走真 git。
 */
export async function scanSecurity(
  projectId: number,
  runner?: GitRunner
): Promise<SecurityReport> {
  const project = getProject(projectId)
  if (!project) throw new RepositoryError('NOT_FOUND', '项目不存在')

  const managed = managedFiles(projectId)
  const scan = scanProject(project.absolutePath)

  const candidates = new Map<string, Candidate>()

  // 磁盘上找到的每一个 .env*。纳管的用库里的统计（不解密），
  // 未纳管的用刚才就地分类的结果 —— 🔴 只取计数，值到此为止。
  for (const file of scan.files) {
    const row = managed.get(file.absolutePath)
    candidates.set(file.absolutePath, {
      absolutePath: file.absolutePath,
      relativePath: file.relativePath,
      fileName: file.fileName,
      environment: file.environment,
      isTemplate: file.isTemplate,
      managed: row !== undefined,
      onDisk: true,
      entryCount: row ? row.entry_count : file.entries.length,
      highCount: row
        ? row.high_count
        : file.entries.filter((entry) => entry.sensitivity === 'high').length,
      sensitiveCount: row
        ? row.sensitive_count
        : file.entries.filter((entry) => entry.sensitivity === 'sensitive').length
    })
  }

  // 纳管但已经从磁盘上消失的文件也要出现在报告里：Git 可能还跟踪着它，
  // 而「文件没了」不等于「仓库里没了」。
  for (const [absolutePath, row] of managed) {
    if (candidates.has(absolutePath)) continue
    const fileName = basename(absolutePath)
    candidates.set(absolutePath, {
      absolutePath,
      relativePath: toRelative(project.absolutePath, absolutePath),
      fileName,
      environment: row.environment,
      isTemplate: identifyEnvFile(fileName)?.isTemplate ?? false,
      managed: true,
      onDisk: false,
      entryCount: row.entry_count,
      highCount: row.high_count,
      sensitiveCount: row.sensitive_count
    })
  }

  const list = [...candidates.values()]

  // Git 状态：项目不在仓库里就直接是「查不了」，一个进程都不起。
  let statuses = new Map<string, PathStatus>()
  let gitUnavailable: string | null = null
  if (project.gitRoot === null) {
    gitUnavailable = '这个目录不在任何 Git 仓库里，无法检查跟踪状态。'
  } else {
    const inspected = await inspectPaths(
      project.gitRoot,
      list.map((item) => item.absolutePath),
      runner
    )
    statuses = inspected.statuses
    gitUnavailable = inspected.unavailable
  }

  const gitRoot = project.gitRoot
  const files: FileRisk[] = list.map((item) => {
    // 🔴 查不到状态时给 null 而不是 false。false 的意思是「我查过了，没被跟踪」，
    // 那在 git 不可用时是一句谎话。
    // 🔴 查表的键必须用**和 inspectPaths 同一个函数**算出来。
    // 另写一份"看起来一样"的路径归一化，两边只要有一点不同（大小写、
    // 尾斜杠、node:path.relative 与字符串截取的差别），查表就会全部落空，
    // 而表现是**每个文件都显示成未跟踪** —— 一个不会报错的假安心。
    const status =
      gitRoot === null || gitUnavailable !== null
        ? null
        : (statuses.get(toRepoPath(gitRoot, item.absolutePath)) ?? null)

    const verdict = gradeRisk({
      relativePath: item.relativePath,
      isTemplate: item.isTemplate,
      onDisk: item.onDisk,
      tracked: status?.tracked ?? null,
      ignored: status?.ignored ?? null,
      highCount: item.highCount,
      sensitiveCount: item.sensitiveCount
    })

    return {
      relativePath: item.relativePath,
      fileName: item.fileName,
      environment: item.environment,
      isTemplate: item.isTemplate,
      managed: item.managed,
      onDisk: item.onDisk,
      tracked: status?.tracked ?? null,
      ignored: status?.ignored ?? null,
      ignoreRule: status?.ignoreRule ?? null,
      entryCount: item.entryCount,
      highCount: item.highCount,
      sensitiveCount: item.sensitiveCount,
      level: verdict.level,
      reason: verdict.reason,
      remedy: verdict.remedy
    }
  })

  // 最危险的排最前。顺序来自 shared 的 RISK_ORDER，界面不要另写一套。
  files.sort(
    (a, b) => RISK_ORDER[a.level] - RISK_ORDER[b.level] || a.relativePath.localeCompare(b.relativePath)
  )

  // 刻意**不**写操作记录：这是一次只读检查，没有改动任何东西、
  // 也没有读出任何明文。每打开一次页面记一条，只会把真正重要的
  // reveal / 写盘记录淹掉。
  return {
    projectId: project.id,
    projectName: project.name,
    gitRoot: project.gitRoot,
    gitUnavailable,
    files,
    summary: {
      critical: files.filter((file) => file.level === 'critical').length,
      warning: files.filter((file) => file.level === 'warning').length,
      unknown: files.filter((file) => file.level === 'unknown').length,
      ok: files.filter((file) => file.level === 'ok').length
    },
    truncated: scan.truncated,
    scannedAt: Date.now()
  }
}
