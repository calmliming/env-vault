/**
 * `.env` 文件的解析与写回（开发计划 §4.2 `original_format`、阶段 1 验收
 * 「重新写回不改变无关格式」）。
 *
 * ## 核心设计：不重排，只重建被改的那一行
 *
 * 常见做法是把文件解析成 `Record<string, string>` 再序列化回去 —— 那样注释、空行、
 * 顺序、引号风格、行尾符全都没了，用户下次 `git diff` 会看到整个文件被重写。
 *
 * 这里每个节点都保留 `raw`（原始字节的精确切片）。写回时：
 *   - 没改过的节点原样吐出 `raw`，**逐字节相同**；
 *   - 改过的条目才用 `prefix + 编码后的值 + suffix` 重建。
 *
 * 于是「不改变无关格式」不是靠小心翼翼维护，而是结构上就不可能违反。
 *
 * ## 刻意的取舍
 *
 * 1. **行内注释必须有前导空白**：`FOO=bar # 说明` 里 `# 说明` 是注释，
 *    但 `FOO=pa#ss` 里的 `#` 是值的一部分。dotenv 的某些版本在 `#` 处无条件截断，
 *    那会把含 `#` 的密码悄悄截掉一半 —— 对一个管密钥的工具来说这是数据损坏。
 * 2. **重复的 key 全部保留**，不去重。文件里真的写了两遍就是两条记录，
 *    去重等于替用户做决定，而哪一条生效取决于加载它的运行时。
 * 3. **未闭合的引号降级成无引号值**而不是报错。半个文件解析失败对用户没有价值，
 *    我们要的是「尽量读出来，并且原样写回去」。
 */

export type Quote = 'none' | 'single' | 'double'

interface NodeBase {
  /** 原始文本切片，不含行尾符。多行值时包含内部换行。 */
  raw: string
  /** 本节点最后一行的行尾符；文件末行无换行时为 ''。 */
  eol: string
  /** 1-based，节点起始行号。 */
  lineNumber: number
}

export interface BlankNode extends NodeBase {
  kind: 'blank'
}
export interface CommentNode extends NodeBase {
  kind: 'comment'
}
/** 既不是空行/注释、也不构成合法赋值的行。原样保留。 */
export interface UnknownNode extends NodeBase {
  kind: 'unknown'
}
export interface EntryNode extends NodeBase {
  kind: 'entry'
  key: string
  /** 解码后的值（引号已去除、转义已还原）。 */
  value: string
  quote: Quote
  exported: boolean
  /** `raw` 中值之前的部分，例如 `export FOO=`。 */
  prefix: string
  /** `raw` 中值之后的部分，例如 `  # 说明`。 */
  suffix: string
}

export type EnvNode = BlankNode | CommentNode | UnknownNode | EntryNode

export interface EnvDocument {
  nodes: EnvNode[]
  /** 文件是否以 UTF-8 BOM 开头。写回时要原样带上。 */
  hasBom: boolean
}

const BOM = '﻿'

/** `export ` 前缀、key、以及等号（含两侧空白）。 */
const ASSIGNMENT = /^(\s*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_.-]*)([ \t]*=[ \t]*)/

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

export function parseEnv(input: string): EnvDocument {
  const hasBom = input.startsWith(BOM)
  const text = hasBom ? input.slice(BOM.length) : input

  const nodes: EnvNode[] = []
  let pos = 0
  let lineNumber = 1

  while (pos < text.length) {
    const lineEnd = findLineEnd(text, pos)
    const line = text.slice(pos, lineEnd.contentEnd)
    const trimmed = line.trim()

    if (trimmed === '') {
      nodes.push({ kind: 'blank', raw: line, eol: lineEnd.eol, lineNumber })
      pos = lineEnd.next
      lineNumber += 1
      continue
    }

    if (trimmed.startsWith('#')) {
      nodes.push({ kind: 'comment', raw: line, eol: lineEnd.eol, lineNumber })
      pos = lineEnd.next
      lineNumber += 1
      continue
    }

    const match = ASSIGNMENT.exec(line)
    if (!match) {
      nodes.push({ kind: 'unknown', raw: line, eol: lineEnd.eol, lineNumber })
      pos = lineEnd.next
      lineNumber += 1
      continue
    }

    const [, lead = '', key = '', equals = ''] = match
    const valueStart = pos + lead.length + key.length + equals.length
    const parsed = readValue(text, valueStart)

    // 值可能跨行（带引号的多行值），所以结束位置要重新定位所在行。
    const endLine = findLineEnd(text, parsed.end)
    const nodeEnd = endLine.contentEnd

    nodes.push({
      kind: 'entry',
      raw: text.slice(pos, nodeEnd),
      eol: endLine.eol,
      lineNumber,
      key,
      value: parsed.value,
      quote: parsed.quote,
      exported: /export[ \t]+$/.test(lead),
      prefix: lead + key + equals,
      suffix: text.slice(parsed.end, nodeEnd)
    })

    lineNumber += countNewlines(text.slice(pos, nodeEnd)) + 1
    pos = endLine.next
  }

  return { nodes, hasBom }
}

interface LineEnd {
  /** 行内容的结束下标（不含行尾符）。 */
  contentEnd: number
  eol: string
  /** 下一行的起始下标。 */
  next: number
}

function findLineEnd(text: string, from: number): LineEnd {
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\n') return { contentEnd: i, eol: '\n', next: i + 1 }
    if (ch === '\r') {
      if (text[i + 1] === '\n') return { contentEnd: i, eol: '\r\n', next: i + 2 }
      return { contentEnd: i, eol: '\r', next: i + 1 }
    }
  }
  return { contentEnd: text.length, eol: '', next: text.length }
}

interface ParsedValue {
  value: string
  quote: Quote
  /** 值在原文里的结束下标（不含闭合引号之后的内容）。 */
  end: number
}

function readValue(text: string, start: number): ParsedValue {
  const opener = text[start]

  if (opener === '"' || opener === "'") {
    const closed = findClosingQuote(text, start + 1, opener)
    if (closed !== -1) {
      const rawValue = text.slice(start + 1, closed)
      return {
        value: opener === '"' ? decodeDoubleQuoted(rawValue) : rawValue,
        quote: opener === '"' ? 'double' : 'single',
        end: closed + 1
      }
    }
    // 引号没闭合：不报错，按无引号值处理，raw 仍会被原样写回。
  }

  const lineEnd = findLineEnd(text, start).contentEnd
  const rest = text.slice(start, lineEnd)
  const commentAt = findInlineComment(rest)
  const body = commentAt === -1 ? rest : rest.slice(0, commentAt)
  const value = body.replace(/[ \t]+$/, '')
  return { value, quote: 'none', end: start + value.length }
}

function findClosingQuote(text: string, from: number, quote: string): number {
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]
    // 单引号内没有转义（与 shell 一致），所以只有双引号要跳过 \x。
    if (quote === '"' && ch === '\\') {
      i += 1
      continue
    }
    if (ch === quote) return i
  }
  return -1
}

/**
 * 返回行内注释的起始下标，没有则 -1。
 * 规则：`#` 必须在行首或前面紧跟空白 —— 否则 `pa#ss` 这种值会被截断。
 */
function findInlineComment(segment: string): number {
  for (let i = 0; i < segment.length; i += 1) {
    if (segment[i] !== '#') continue
    if (i === 0) return 0
    const prev = segment[i - 1]
    if (prev === ' ' || prev === '\t') return i
  }
  return -1
}

function countNewlines(segment: string): number {
  let count = 0
  for (let i = 0; i < segment.length; i += 1) {
    if (segment[i] === '\n') count += 1
    else if (segment[i] === '\r' && segment[i + 1] !== '\n') count += 1
  }
  return count
}

// ---------------------------------------------------------------------------
// 值的编解码
// ---------------------------------------------------------------------------

const DOUBLE_ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
  '\\': '\\',
  '"': '"',
  "'": "'",
  '$': '$'
}

function decodeDoubleQuoted(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = raw[i + 1]
    if (next === undefined) {
      out += '\\'
      continue
    }
    const mapped = DOUBLE_ESCAPES[next]
    if (mapped === undefined) {
      // 未知转义原样保留（连反斜杠一起），不猜用户意图。
      out += ch + next
    } else {
      out += mapped
    }
    i += 1
  }
  return out
}

function encodeDoubleQuoted(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
}

/** 无引号能否安全表示这个值。 */
function canGoUnquoted(value: string): boolean {
  if (value === '') return true
  if (/[\s"'#\\]/.test(value)) return false
  return true
}

/**
 * 按「尽量沿用原引号风格」的原则编码新值。
 * 只有原风格表达不了时才升级到双引号 —— 用户手写的 `FOO=bar` 改成 `FOO=baz`
 * 不该变成 `FOO="baz"`，那是无谓的 diff 噪声。
 */
export function encodeValue(value: string, preferred: Quote): { text: string; quote: Quote } {
  if (preferred === 'none' && canGoUnquoted(value)) {
    return { text: value, quote: 'none' }
  }
  if (preferred === 'single' && !value.includes("'") && !/[\r\n]/.test(value)) {
    return { text: `'${value}'`, quote: 'single' }
  }
  return { text: `"${encodeDoubleQuoted(value)}"`, quote: 'double' }
}

// ---------------------------------------------------------------------------
// 写回
// ---------------------------------------------------------------------------

export function serializeEnv(doc: EnvDocument): string {
  let out = doc.hasBom ? BOM : ''
  for (const node of doc.nodes) out += node.raw + node.eol
  return out
}

export interface EnvEdit {
  key: string
  value: string
  /**
   * 同名 key 出现多次时改第几个（0-based）。默认改最后一个 ——
   * 大多数 `.env` 加载器是后者覆盖前者，改最后一个才和运行时看到的一致。
   */
  occurrence?: number
}

/** 某个 key 的全部条目节点下标，按出现顺序。 */
function entryIndexes(nodes: readonly EnvNode[], key: string): number[] {
  const out: number[] = []
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]
    if (node?.kind === 'entry' && node.key === key) out.push(i)
  }
  return out
}

export interface ApplyResult {
  doc: EnvDocument
  /** 实际改动的条目（值确实变了的才算）。 */
  changed: { key: string; lineNumber: number }[]
  /** 文件里找不到的 key。调用方决定是追加还是报错。 */
  missing: string[]
}

/**
 * 应用一组值修改，返回新文档。
 * 没被改到的节点会**复用同一个对象引用**，因此 serialize 的结果逐字节不变。
 */
export function applyEdits(doc: EnvDocument, edits: readonly EnvEdit[]): ApplyResult {
  const nodes = [...doc.nodes]
  const changed: ApplyResult['changed'] = []
  const missing: string[] = []

  for (const edit of edits) {
    const indexes = entryIndexes(nodes, edit.key)

    if (indexes.length === 0) {
      missing.push(edit.key)
      continue
    }

    const pick = edit.occurrence ?? indexes.length - 1
    const target = indexes[Math.min(Math.max(pick, 0), indexes.length - 1)]
    if (target === undefined) continue

    const node = nodes[target]
    if (!node || node.kind !== 'entry') continue
    if (node.value === edit.value) continue // 值没变就不动 raw

    const encoded = encodeValue(edit.value, node.quote)
    nodes[target] = {
      ...node,
      raw: node.prefix + encoded.text + node.suffix,
      value: edit.value,
      quote: encoded.quote
    }
    changed.push({ key: node.key, lineNumber: node.lineNumber })
  }

  return { doc: { nodes, hasBom: doc.hasBom }, changed, missing }
}

export interface EnvTarget {
  key: string
  /** 同名 key 出现多次时删第几个（0-based）。默认删最后一个，与 applyEdits 一致。 */
  occurrence?: number
}

export interface RemoveResult {
  doc: EnvDocument
  removed: { key: string; lineNumber: number }[]
  /** 文件里找不到的 key，或者该序号不存在。调用方决定是报错还是当作已完成。 */
  missing: string[]
}

/**
 * 删掉整条赋值（连同它的行尾符）。
 *
 * 未被点名的节点仍然**复用同一个对象引用**，所以除了消失的那一行，
 * serialize 出来的其余字节和原文逐字节相同 —— 和 applyEdits 是同一个保证。
 *
 * 两处刻意的取舍：
 *
 * 1. **越界的 occurrence 报 missing，不像 applyEdits 那样夹到边界上。**
 *    改错一行还能改回来，删错一行是把用户的数据删了；宁可这次操作失败。
 * 2. **相邻的注释不动。** `# 这个 key 是干嘛的` 到底属于下面那行、上面那行、
 *    还是整个段落，只有写它的人知道。猜错就是替用户删掉他的笔记。
 *
 * ⚠️ 删掉的若是末行、且原文件末尾没有换行符，前一行的 eol 会留下来，
 * 于是文件末尾多出一个换行。这是删整行不可避免的：要么留下这个换行，
 * 要么去改一个我们本来不该碰的节点。留换行更符合惯例。
 */
export function removeEntries(doc: EnvDocument, targets: readonly EnvTarget[]): RemoveResult {
  const doomed = new Set<number>()
  const removed: RemoveResult['removed'] = []
  const missing: string[] = []

  for (const target of targets) {
    const indexes = entryIndexes(doc.nodes, target.key)
    const pick = target.occurrence ?? indexes.length - 1
    const index = indexes[pick]
    if (index === undefined) {
      missing.push(target.key)
      continue
    }

    const node = doc.nodes[index]
    if (node?.kind !== 'entry') continue
    doomed.add(index)
    removed.push({ key: node.key, lineNumber: node.lineNumber })
  }

  return {
    doc: { nodes: doc.nodes.filter((_, index) => !doomed.has(index)), hasBom: doc.hasBom },
    removed,
    missing
  }
}

/** 格式骨架里占据值那个位置的占位符。 */
export const REDACTED_VALUE = '<value>'

/**
 * 一行的**格式骨架**：原始行文本，但值的位置换成占位符。
 *
 * 🔴 `config_entries.original_format` 是普通 TEXT 列，不加密。
 * 把 `node.raw` 原样存进去等于让 `API_KEY=sk-...` 的明文落库 ——
 * 加密边界（HANDOFF §6）就漏在这一列上。所以入库的是骨架而不是原文。
 *
 * 骨架保留了 §4.2 要的全部东西：`export` 前缀、等号两侧的空白、引号风格、
 * 行内注释。唯独不保留值本身，而值恰恰是那一列不该有的东西。
 */
export function formatSkeleton(node: EntryNode): string {
  return node.prefix + encodeValue(REDACTED_VALUE, node.quote).text + node.suffix
}

/** 文档里全部条目，按出现顺序。 */
export function entriesOf(doc: EnvDocument): EntryNode[] {
  return doc.nodes.filter((node): node is EntryNode => node.kind === 'entry')
}
