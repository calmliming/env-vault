/**
 * `.env.example` 生成的接线（阶段 5b）。
 *
 * 纯粹的生成逻辑在 `env/template.ts`（能被 `node --test` 直接跑）；
 * 这里只负责把 `fileId` 解析成磁盘路径、读盘、写盘、留痕。
 *
 * ## 🔴 这条路不解密，也不要求解锁
 *
 * 源头是**磁盘上的 `.env` 文件**，不是中心记录 —— 中心记录里根本没有注释，
 * 而模板的价值有一大半在注释上。既然从磁盘读，就不需要 Vault。
 * 和 `db/security.ts` 同一个性质：锁着也能用。别"顺手"加 `requireUnlocked()`。
 *
 * ## 🔴 内容由这里重新生成，不接受渲染层送来的文本
 *
 * 预览里那份 `content` 只是拿去显示的。如果写入通道接受渲染层送来的内容，
 * 那等于给渲染层开了一个「往任意 `.env.example` 写任意字节」的原语，
 * 而渲染层是加载页面内容的地方。
 */

import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { buildTemplate, isTemplateFileName, templateTargetPath } from '../env/template.ts'
import { hashFile, writeEnvFileAtomic } from '../env/write.ts'
import type { TemplatePreview, TemplateWriteResult } from '@shared/ipc'
import {
  RepositoryError,
  backupRoot,
  logActivity,
  requireFile,
  toRelative,
  writeGuarded
} from './repositories'

interface Resolved {
  file: ReturnType<typeof requireFile>
  sourceRelativePath: string
  targetPath: string
  targetRelativePath: string
  template: ReturnType<typeof buildTemplate>
}

/** 读源文件并生成一次。预览和写入走同一条路，免得两边算出不同的东西。 */
function resolve(fileId: number): Resolved {
  const file = requireFile(fileId)

  if (isTemplateFileName(file.absolute_path)) {
    throw new RepositoryError('INVALID_ARGUMENT', '这本身就是模板文件，不能再由它生成一份模板')
  }
  if (!existsSync(file.absolute_path)) {
    throw new RepositoryError('NOT_FOUND', '源文件已经从磁盘上消失了，无从生成模板')
  }

  const source = readFileSync(file.absolute_path).toString('utf8')
  const targetPath = templateTargetPath(file.absolute_path)

  return {
    file,
    sourceRelativePath: toRelative(file.project_path, file.absolute_path),
    targetPath,
    targetRelativePath: toRelative(file.project_path, targetPath),
    template: buildTemplate(source)
  }
}

export function previewTemplate(fileId: number): TemplatePreview {
  const { sourceRelativePath, targetPath, targetRelativePath, template } = resolve(fileId)

  return {
    sourceRelativePath,
    targetRelativePath,
    targetExists: existsSync(targetPath),
    targetHash: hashFile(targetPath),
    content: template.content,
    entryCount: template.entryCount,
    droppedLines: template.droppedLines,
    leaks: template.leaks
  }
}

export function writeTemplate(
  fileId: number,
  expectedTargetHash: string | null
): TemplateWriteResult {
  const { file, sourceRelativePath, targetPath, targetRelativePath, template } = resolve(fileId)

  // 🔴 兜底没过就绝不写盘。这个文件是要进 Git 的，写出去就收不回来了。
  // 消息里只有 key 名和行号 —— 值本身一个字符都不能出现在错误信息里。
  if (template.leaks.length > 0) {
    const where = template.leaks.map((leak) => `第 ${leak.lineNumber} 行（${leak.key}）`).join('、')
    throw new RepositoryError(
      'PATH_REJECTED',
      `生成结果里仍然能搜到源文件的敏感值：${where}。已中止，请先处理源文件里的这几处注释。`
    )
  }

  if (expectedTargetHash === null) {
    // 「我断言这个文件当时不存在」。用 'wx' 独占创建来兑现这个断言 ——
    // 比「先 existsSync 再写」少一个竞态窗口，别改回去。
    try {
      closeSync(openSync(targetPath, 'wx'))
    } catch {
      throw new RepositoryError(
        'PATH_REJECTED',
        '目标文件在预览之后被创建了，已中止。请重新预览，确认这次是覆盖。'
      )
    }
    // 这里不传 expectedHash：目标刚由我们独占创建，"守卫"拿现算的哈希比现算的哈希
    // 永远不可能触发（PHASE-2 §5）。真正的守卫是上面那个 'wx'。
    const result = writeEnvFileAtomic(targetPath, template.content, { backupRoot: backupRoot() })
    return finish(file, sourceRelativePath, targetRelativePath, template, result.bytesWritten, null)
  }

  const result = writeGuarded(
    targetPath,
    template.content,
    expectedTargetHash,
    '目标 .env.example 在预览之后被改过了，已中止。请重新预览再确认。'
  )
  return finish(
    file,
    sourceRelativePath,
    targetRelativePath,
    template,
    Buffer.byteLength(template.content, 'utf8'),
    result.backupPath
  )
}

function finish(
  file: ReturnType<typeof requireFile>,
  sourceRelativePath: string,
  targetRelativePath: string,
  template: ReturnType<typeof buildTemplate>,
  bytesWritten: number,
  backupPath: string | null
): TemplateWriteResult {
  const dropped = template.droppedLines > 0 ? `，略去 ${template.droppedLines} 行读不懂的内容` : ''
  logActivity({
    action: 'template.generate',
    projectId: file.project_id,
    environment: file.environment,
    targetKind: 'file',
    targetRef: targetRelativePath,
    // 只记路径和条数，不记 key 名、更不记值。
    detail: `由 ${sourceRelativePath} 生成 ${template.entryCount} 个变量${dropped}`
  })

  return {
    targetRelativePath,
    entryCount: template.entryCount,
    bytesWritten,
    backupPath
  }
}
