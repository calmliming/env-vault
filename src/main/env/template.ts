/**
 * 从一份 `.env*` 生成 `.env.example`（开发计划 §9「阶段 5」第二项）。
 *
 * ## 这是整个应用第一个「设计上就要进 Git」的产物
 *
 * 前面几条外部边界（出站流量、执行外部程序、剪贴板、交给子进程）都是
 * 「值离开本进程」；这一条是「值离开本机、进入版本库、可能进入公开仓库」——
 * 正是阶段 4a 那套安全检查存在的理由。所以这里的默认必须是**保守**的：
 * 拿不准的行宁可略去，也不赌它不含值。
 *
 * ## 为什么从磁盘读，而不是从中心记录拼
 *
 * 中心记录里根本没有注释（`config_entries` 只存 key + 密文 + 格式骨架），
 * 而 `.env.example` 的价值有一大半在注释上（「# 从 https://… 申请」）。
 * 所以源头只能是磁盘文件。
 *
 * 顺带的好处：这条路**完全不解密、不碰 Vault**，锁着也能跑。
 * 和 `db/security.ts` 同一个性质。🔴 别"顺手"把 vault 接进来。
 *
 * ## 🔴 注释脱敏是检测，检测有缝，所以后面还有一道结构性兜底
 *
 * `# OPENAI_API_KEY=sk-proj-…` 解析出来是 `comment` 节点，`raw` 里是整行原文，
 * `formatSkeleton` 只作用于 `entry` 节点，**够不着它**。所以要单独脱敏。
 *
 * 但「像不像赋值」是个形状判断，必然漏：`# TODO: set API_KEY=sk-real`
 * 里 `TODO` 后面是 `:` 不是 `=`，不匹配赋值形状，会原样留下。
 * 因此 `buildTemplate` 生成完还要反过来查一遍：源文件里那些**高敏**值，
 * 有没有哪个还能在结果里搜到（见 `findLeaks`）。检测负责多数情况，
 * 兜底负责"我没想到的那种写法"。
 *
 * 诚实的残留：注释里若是一把**已经不在文件里的旧 Key**，兜底也够不着它 ——
 * 它不在"源文件当前的值"这个集合里。这一点在界面和 PHASE-5B 里直说，
 * 不假装覆盖全。
 *
 * ⚠️ 这个模块要能被 `node --test` 直接跑（HANDOFF §5）：
 * import 必须带 `.ts` 后缀、不能用 `@shared/*` 别名、不能用构造函数参数属性。
 */

import { basename, dirname, join } from 'node:path'
import { classify } from './classify.ts'
import {
  entriesOf,
  formatSkeleton,
  parseEnv,
  serializeEnv,
  type EntryNode,
  type EnvNode
} from './document.ts'

/**
 * 模板里值的位置留什么。
 *
 * 空串而不是 `<value>`：`.env.example` 的惯例就是 `KEY=`，而且照抄成 `.env`
 * 之后不会残留一个会被真的读进去的垃圾值。入库用的骨架仍然是 `<value>`，
 * 两者共用 `formatSkeleton`，只是占位符不同。
 */
export const TEMPLATE_PLACEHOLDER = ''

/** 生成的模板固定叫这个名字。 */
export const TEMPLATE_FILE_NAME = '.env.example'

export interface TemplateLeak {
  /** 泄漏出现在**生成结果**的第几行（1-based）。 */
  lineNumber: number
  /** 是哪个变量的值漏了过去。🔴 只有 key 名，不含值本身。 */
  key: string
}

export interface TemplateResult {
  content: string
  /** 进了模板的变量数。同名 key 出现多次按多次算，与 document 的取舍一致。 */
  entryCount: number
  /** 无法识别、已被略去的行数。报给用户，不静默丢。 */
  droppedLines: number
  /**
   * 🔴 非空表示生成结果里仍能搜到源文件的高敏值 —— **绝不能写盘**。
   * 调用方必须检查这个字段；空数组才算生成成功。
   */
  leaks: TemplateLeak[]
}

/**
 * 把一段注释文本里的赋值脱敏，其余原样返回。
 *
 * 同时用在两个位置：整行注释（`CommentNode.raw`）和行内注释
 * （`EntryNode.suffix`）。**一条规矩两个调用点**，不是两套逻辑 ——
 * 只堵整行不堵行内，等于只堵了一半。
 *
 * `## KEY=secret` 这种多重注释会往里再剥一层，否则第一层剥完剩下的
 * 还是个注释，就漏过去了。
 *
 * ⚠️ 已知的过度脱敏：`# note=see docs` 这种散文也会被当成赋值，变成 `# note=`。
 * 我们分不出「被注释掉的配置」和「碰巧带等号的说明」，而目的地是 Git ——
 * 宁可多擦掉一句说明，也不赌它不是一把 Key。
 */
export function redactCommentText(text: string): string {
  const hash = text.indexOf('#')
  if (hash === -1) return text

  const head = text.slice(0, hash + 1)
  const body = text.slice(hash + 1)

  // 赋值前面可能还有一段散文（`# 旧的 KEY=…`、`# old KEY=…`），所以不能要求
  // 整段正文恰好是一条赋值 —— 那是这条规矩第一版的写法，`# 旧的 KEY=…` 直接漏过去。
  // 从每个「词首」试一次，用**真正的解析器**判断，而不是在这里另抄一份赋值正则
  // （抄一份就意味着 document.ts 的解析规则改了这里不会跟着改）。
  // `## KEY=…` 这类多重注释也由这个循环一并覆盖。
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch === undefined || !/[A-Za-z_]/.test(ch)) continue
    const prev = i === 0 ? undefined : body[i - 1]
    if (prev !== undefined && !/\s/.test(prev)) continue // 词中间不算起点

    const nodes = parseEnv(body.slice(i)).nodes
    const only = nodes.length === 1 ? nodes[0] : undefined
    if (only?.kind === 'entry') {
      return head + body.slice(0, i) + templateLine(only)
    }
  }

  return text
}

/** 一行赋值在模板里的样子：值清空，行内注释过同一条脱敏规矩。 */
function templateLine(node: EntryNode): string {
  return formatSkeleton({ ...node, suffix: redactCommentText(node.suffix) }, TEMPLATE_PLACEHOLDER)
}

/**
 * 靠**名字**判出来的 `sensitive` 值，要参与比对得先够这么长。
 *
 * `high` 是值本身长得像凭据（`sk-…`、PEM、带密码的连接串），那种任何长度都查。
 * `sensitive` 只是名字里有 KEY/TOKEN/AUTH 之类，值可能是 `jwt`、`on` 这种短词 ——
 * `AUTH_MODE=jwt` 配上一句 `# 支持 jwt 和 session`，全量比对就会把一份完全正常的
 * 模板判成泄漏。而一条会误报的断言，用两次就没人看了（HANDOFF §8）。
 *
 * 16 位是个判断：到这个长度还能在注释里逐字符撞上，基本不可能是巧合。
 */
const SENSITIVE_MIN_LENGTH = 16

/**
 * 🔴 反过来查：源文件里的敏感值，有没有哪个还留在生成结果里。
 *
 * 这是兜底，不是主力。主力是 `redactCommentText`；这里负责它漏掉的形状
 * （`# TODO: set API_KEY=sk-real` 这种不匹配赋值形状的写法）。
 *
 * 空值不查 —— `KEY=` 的值是空串，而 `includes('')` 恒为真。
 */
function findLeaks(sourceDoc: ReturnType<typeof parseEnv>, content: string): TemplateLeak[] {
  const lines = content.split(/\r\n|\r|\n/)
  const leaks: TemplateLeak[] = []

  for (const node of entriesOf(sourceDoc)) {
    if (node.value === '') continue

    const { sensitivity } = classify(node.key, node.value)
    const worthChecking =
      sensitivity === 'high' ||
      (sensitivity === 'sensitive' && node.value.length >= SENSITIVE_MIN_LENGTH)
    if (!worthChecking) continue

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (line !== undefined && line.includes(node.value)) {
        leaks.push({ lineNumber: i + 1, key: node.key })
      }
    }
  }

  return leaks
}

/**
 * 生成模板内容。
 *
 * 逐节点映射，**不重排**：注释、空行、顺序、引号风格、行尾符、BOM 全部跟着
 * 源文件走。和 `document.ts` 的核心设计是同一条 —— 用户下次 `git diff`
 * 不该看到整个文件被重写。
 *
 * `unknown` 节点（既不是空行/注释、也不构成合法赋值的行）**略去**：
 * 它的定义就是"我们没读懂这一行"，而我们无法证明没读懂的东西里不含值，
 * 目的地又是 Git。略去是结构性保证，比再写一个检测可靠。数目报给用户。
 */
export function buildTemplate(source: string): TemplateResult {
  const doc = parseEnv(source)
  const nodes: EnvNode[] = []
  let entryCount = 0
  let droppedLines = 0

  for (const node of doc.nodes) {
    switch (node.kind) {
      case 'blank':
        nodes.push(node)
        break
      case 'comment':
        nodes.push({ ...node, raw: redactCommentText(node.raw) })
        break
      case 'unknown':
        droppedLines += 1
        break
      case 'entry':
        nodes.push({ ...node, raw: templateLine(node) })
        entryCount += 1
        break
    }
  }

  const content = serializeEnv({ nodes, hasBom: doc.hasBom })
  return { content, entryCount, droppedLines, leaks: findLeaks(doc, content) }
}

/**
 * 模板落在**源文件同目录**下，而不是项目根。
 * 源文件可能是 `apps/web/.env.production`，那份模板属于 `apps/web/`。
 */
export function templateTargetPath(sourceAbsolutePath: string): string {
  return join(dirname(sourceAbsolutePath), TEMPLATE_FILE_NAME)
}

/** 源文件本身就是模板时不该再生成一份（会把自己覆盖成空值版）。 */
export function isTemplateFileName(fileName: string): boolean {
  return basename(fileName) === TEMPLATE_FILE_NAME
}
