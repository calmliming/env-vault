/**
 * 解析器的契约测试。
 *
 * 这里钉住的不是「解析得对不对」，而是阶段 1 的验收标准本身：
 * **写回不改变无关格式**。所以最重要的两组是「往返逐字节相同」和
 * 「改一个值，其余字节不动」—— 别为了让某条用例好看去放宽它们。
 *
 * 跑法：node --test src/main/env/*.test.ts（Node 24 原生剥离类型，无需构建）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEdits, encodeValue, entriesOf, parseEnv, serializeEnv } from './document.ts'

/** 一份刻意难看的样本：几乎每种边界都塞进去了。 */
const GNARLY = [
  '# 顶部注释',
  '',
  'PLAIN=value',
  'export EXPORTED=yes',
  '  SPACED   =   padded  ',
  'EMPTY=',
  'SINGLE=\'literal $NOT_EXPANDED\'',
  'DOUBLE="line1\\nline2"',
  'INLINE=bar   # 这是注释',
  'HASH_IN_VALUE=pa#ss',
  'QUOTED_HASH="has # inside"',
  'DUP=first',
  'DUP=second',
  'not an assignment line',
  'TRAILING=end'
].join('\n')

test('往返：解析再写回逐字节相同', () => {
  assert.equal(serializeEnv(parseEnv(GNARLY)), GNARLY)
})

test('往返：CRLF 行尾被保留', () => {
  const crlf = 'A=1\r\nB=2\r\n# 注释\r\n'
  assert.equal(serializeEnv(parseEnv(crlf)), crlf)
})

test('往返：混合行尾各自保留', () => {
  const mixed = 'A=1\r\nB=2\nC=3\r\n'
  assert.equal(serializeEnv(parseEnv(mixed)), mixed)
})

test('往返：BOM 被保留', () => {
  const withBom = '\uFEFFA=1\n'
  const doc = parseEnv(withBom)
  assert.equal(doc.hasBom, true)
  assert.equal(serializeEnv(doc), withBom)
})

test('往返：末行无换行符时不会被补上', () => {
  const noTrailing = 'A=1\nB=2'
  assert.equal(serializeEnv(parseEnv(noTrailing)), noTrailing)
})

test('往返：空文件', () => {
  assert.equal(serializeEnv(parseEnv('')), '')
})

// ---------------------------------------------------------------------------

test('值解码：引号风格与转义', () => {
  const doc = parseEnv(GNARLY)
  const byKey = new Map(entriesOf(doc).map((e) => [e.key, e]))

  assert.equal(byKey.get('PLAIN')?.value, 'value')
  assert.equal(byKey.get('PLAIN')?.quote, 'none')

  assert.equal(byKey.get('EXPORTED')?.value, 'yes')
  assert.equal(byKey.get('EXPORTED')?.exported, true)
  assert.equal(byKey.get('PLAIN')?.exported, false)

  // 等号两侧与值尾部的空白都不属于值
  assert.equal(byKey.get('SPACED')?.value, 'padded')

  assert.equal(byKey.get('EMPTY')?.value, '')

  // 单引号内不做任何转义或展开
  assert.equal(byKey.get('SINGLE')?.value, 'literal $NOT_EXPANDED')
  assert.equal(byKey.get('SINGLE')?.quote, 'single')

  // 双引号内 \n 是真换行
  assert.equal(byKey.get('DOUBLE')?.value, 'line1\nline2')
  assert.equal(byKey.get('DOUBLE')?.quote, 'double')
})

test('行内注释：前面有空白才算注释', () => {
  const byKey = new Map(entriesOf(parseEnv(GNARLY)).map((e) => [e.key, e]))
  assert.equal(byKey.get('INLINE')?.value, 'bar')
  // 🔴 这条最要命：无条件在 # 处截断会把含 # 的密码悄悄切一半
  assert.equal(byKey.get('HASH_IN_VALUE')?.value, 'pa#ss')
  assert.equal(byKey.get('QUOTED_HASH')?.value, 'has # inside')
})

test('重复 key 全部保留，不去重', () => {
  const dups = entriesOf(parseEnv(GNARLY)).filter((e) => e.key === 'DUP')
  assert.equal(dups.length, 2)
  assert.deepEqual(dups.map((e) => e.value), ['first', 'second'])
})

test('无法识别的行被原样保留', () => {
  const unknown = parseEnv(GNARLY).nodes.filter((n) => n.kind === 'unknown')
  assert.equal(unknown.length, 1)
  assert.equal(unknown[0]?.raw, 'not an assignment line')
})

test('多行带引号的值跨行解析并原样写回', () => {
  const source = 'KEY="第一行\n第二行\n第三行"\nAFTER=1\n'
  const doc = parseEnv(source)
  const entries = entriesOf(doc)
  assert.equal(entries.length, 2)
  assert.equal(entries[0]?.value, '第一行\n第二行\n第三行')
  assert.equal(entries[1]?.key, 'AFTER')
  assert.equal(serializeEnv(doc), source)
})

test('未闭合的引号降级为无引号值，且不丢内容', () => {
  const source = 'BROKEN="没闭合\nNEXT=2\n'
  const doc = parseEnv(source)
  assert.equal(serializeEnv(doc), source)
  const entries = entriesOf(doc)
  assert.equal(entries.length, 2)
  assert.equal(entries[1]?.key, 'NEXT')
})

test('未知转义序列原样保留，不猜用户意图', () => {
  const doc = parseEnv('P="C:\\\\Users\\\\me" Q=1\n')
  assert.equal(entriesOf(doc)[0]?.value, 'C:\\Users\\me')
  assert.equal(entriesOf(parseEnv('X="a\\qb"\n'))[0]?.value, 'a\\qb')
})

// ---------------------------------------------------------------------------

test('改一个值：其余字节完全不动', () => {
  const doc = parseEnv(GNARLY)
  const { doc: next, changed, missing } = applyEdits(doc, [{ key: 'PLAIN', value: 'changed' }])

  assert.deepEqual(missing, [])
  assert.equal(changed.length, 1)
  assert.equal(changed[0]?.key, 'PLAIN')

  const before = GNARLY.split('\n')
  const after = serializeEnv(next).split('\n')
  assert.equal(before.length, after.length)
  for (let i = 0; i < before.length; i += 1) {
    if (before[i] === 'PLAIN=value') {
      assert.equal(after[i], 'PLAIN=changed')
    } else {
      assert.equal(after[i], before[i], `第 ${i + 1} 行不该被改动`)
    }
  }
})

test('改值沿用原引号风格，不制造无谓 diff', () => {
  const doc = parseEnv("A=bare\nB='single'\nC=\"double\"\n")
  const { doc: next } = applyEdits(doc, [
    { key: 'A', value: 'still-bare' },
    { key: 'B', value: 'still-single' },
    { key: 'C', value: 'still-double' }
  ])
  assert.equal(serializeEnv(next), "A=still-bare\nB='still-single'\nC=\"still-double\"\n")
})

test('原风格表达不了时才升级引号', () => {
  const doc = parseEnv("A=bare\nB='has apostrophe'\n")
  const { doc: next } = applyEdits(doc, [
    { key: 'A', value: 'now has spaces' },
    { key: 'B', value: "it's here" }
  ])
  assert.equal(serializeEnv(next), 'A="now has spaces"\nB="it\'s here"\n')
})

test('值没变时不重建那一行', () => {
  const doc = parseEnv('  SPACED   =   padded  \n')
  const { doc: next, changed } = applyEdits(doc, [{ key: 'SPACED', value: 'padded' }])
  assert.deepEqual(changed, [])
  // 若被重建，尾部那两个空格会消失
  assert.equal(serializeEnv(next), '  SPACED   =   padded  \n')
})

test('重复 key 默认改最后一个（与运行时"后者覆盖前者"一致）', () => {
  const doc = parseEnv('DUP=first\nDUP=second\n')
  const { doc: next } = applyEdits(doc, [{ key: 'DUP', value: 'changed' }])
  assert.equal(serializeEnv(next), 'DUP=first\nDUP=changed\n')
})

test('重复 key 可以按序号指定改哪一个', () => {
  const doc = parseEnv('DUP=first\nDUP=second\n')
  const { doc: next } = applyEdits(doc, [{ key: 'DUP', value: 'changed', occurrence: 0 }])
  assert.equal(serializeEnv(next), 'DUP=changed\nDUP=second\n')
})

test('改值保留行内注释', () => {
  const doc = parseEnv('INLINE=bar   # 这是注释\n')
  const { doc: next } = applyEdits(doc, [{ key: 'INLINE', value: 'baz' }])
  assert.equal(serializeEnv(next), 'INLINE=baz   # 这是注释\n')
})

test('改值保留 export 前缀', () => {
  const doc = parseEnv('export TOKEN=old\n')
  const { doc: next } = applyEdits(doc, [{ key: 'TOKEN', value: 'new' }])
  assert.equal(serializeEnv(next), 'export TOKEN=new\n')
})

test('不存在的 key 进 missing，不静默追加', () => {
  const doc = parseEnv('A=1\n')
  const { doc: next, missing } = applyEdits(doc, [{ key: 'NOPE', value: 'x' }])
  assert.deepEqual(missing, ['NOPE'])
  assert.equal(serializeEnv(next), 'A=1\n')
})

test('含换行的新值被编码成双引号转义形式', () => {
  const doc = parseEnv('A=1\n')
  const { doc: next } = applyEdits(doc, [{ key: 'A', value: 'line1\nline2' }])
  assert.equal(serializeEnv(next), 'A="line1\\nline2"\n')
  // 且能原路解回来
  assert.equal(entriesOf(parseEnv(serializeEnv(next)))[0]?.value, 'line1\nline2')
})

test('编码后再解码，任意值都能还原', () => {
  const samples = [
    'simple',
    '',
    'with spaces',
    "it's",
    'say "hi"',
    'back\\slash',
    'line1\nline2',
    'tab\there',
    'has # hash',
    '中文与 emoji 🔐',
    '$NOT_EXPANDED'
  ]
  for (const value of samples) {
    for (const style of ['none', 'single', 'double'] as const) {
      const encoded = encodeValue(value, style)
      const roundTripped = entriesOf(parseEnv(`K=${encoded.text}\n`))[0]?.value
      assert.equal(roundTripped, value, `风格 ${style} 下 ${JSON.stringify(value)} 未能还原`)
    }
  }
})

test('行号指向 key 所在行，多行值之后仍然正确', () => {
  const doc = parseEnv('A=1\n\n# c\nB="x\ny"\nC=3\n')
  const byKey = new Map(entriesOf(doc).map((e) => [e.key, e.lineNumber]))
  assert.equal(byKey.get('A'), 1)
  assert.equal(byKey.get('B'), 4)
  assert.equal(byKey.get('C'), 6)
})
