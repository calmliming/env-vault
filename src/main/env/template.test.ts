/**
 * `.env.example` 生成（阶段 5b）。
 *
 * 最重要的两组是**「结果里搜不到任何真值」**和**「格式跟着源文件走」**——
 * 前者是这个文件要进 Git 的全部理由，后者是别把用户的注释和顺序搅乱。
 * 别为了让某条用例好看去放宽它们。
 *
 * 跑法：node --test src/main/env/*.test.ts（Node 24 原生剥离类型，无需构建）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTemplate,
  isTemplateFileName,
  redactCommentText,
  templateTargetPath
} from './template.ts'

/** 一把会被 classify 判成 high 的假 Key（匹配 /^sk-[A-Za-z0-9_-]{16,}$/）。 */
const FAKE_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz012345'

// ---------------------------------------------------------------------------
// 格式跟着源文件走
// ---------------------------------------------------------------------------

test('值全部清空，export / 引号风格 / 空白 / 顺序 / 空行全部保留', () => {
  const source = [
    '# 顶部注释',
    '',
    'APP_NAME=envvault',
    'export EXPORTED=yes',
    "SINGLE='quoted'",
    'DOUBLE="quoted"',
    '  SPACED   =   padded  ',
    ''
  ].join('\n')

  const { content } = buildTemplate(source)

  assert.equal(
    content,
    [
      '# 顶部注释',
      '',
      'APP_NAME=',
      'export EXPORTED=',
      "SINGLE=''",
      'DOUBLE=""',
      '  SPACED   =     ',
      ''
    ].join('\n')
  )
})

test('CRLF 与 BOM 原样保留', () => {
  const source = '﻿A=1\r\nB=2\r\n'
  const { content } = buildTemplate(source)
  assert.equal(content, '﻿A=\r\nB=\r\n')
})

test('重复的 key 全部保留，不去重', () => {
  // 与 document.ts 的取舍一致：文件里写了三遍就是三条。
  const { content, entryCount } = buildTemplate('DUP=a\nDUP=b\nDUP=c\n')
  assert.equal(content, 'DUP=\nDUP=\nDUP=\n')
  assert.equal(entryCount, 3)
})

test('多行值收敛成一行，不把换行带进模板', () => {
  const { content } = buildTemplate('B="第一行\n第二行"\n')
  assert.equal(content, 'B=""\n')
})

// ---------------------------------------------------------------------------
// 🔴 注释脱敏 —— 一条规矩，两个位置
// ---------------------------------------------------------------------------

test('🔴 被注释掉的赋值也脱敏 —— formatSkeleton 够不着 comment 节点', () => {
  const source = `# ${'OPENAI_API_KEY'}=${FAKE_KEY}\nAPP_NAME=envvault\n`
  const { content, leaks } = buildTemplate(source)

  assert.equal(content.includes(FAKE_KEY), false, '注释里的明文 Key 进了模板')
  assert.equal(content, '# OPENAI_API_KEY=\nAPP_NAME=\n')
  assert.deepEqual(leaks, [])
})

test('🔴 行内注释里的赋值同样脱敏 —— 只堵整行等于只堵了一半', () => {
  const source = `PORT=5000   # 旧的 OPENAI_API_KEY=${FAKE_KEY}\n`
  const { content } = buildTemplate(source)

  assert.equal(content.includes(FAKE_KEY), false, '行内注释里的明文 Key 进了模板')
  assert.equal(content, 'PORT=   # 旧的 OPENAI_API_KEY=\n')
})

test('🔴 赋值前面带一段散文照样脱敏 —— `# 旧的 KEY=…` 是最常见的写法', () => {
  // 第一版要求「整段注释正文恰好是一条赋值」，这一条直接漏过去了。
  const source = `# 旧的 OPENAI_API_KEY=${FAKE_KEY}\n# old KEY=${FAKE_KEY}\n`
  const { content } = buildTemplate(source)

  assert.equal(content.includes(FAKE_KEY), false)
  assert.equal(content, '# 旧的 OPENAI_API_KEY=\n# old KEY=\n')
})

test('🔴 多重注释 ## 也要往里剥，否则剥完还是注释就漏过去了', () => {
  const { content } = buildTemplate(`## OPENAI_API_KEY=${FAKE_KEY}\n`)
  assert.equal(content.includes(FAKE_KEY), false)
  assert.equal(content, '## OPENAI_API_KEY=\n')
})

test('不像赋值的注释原样保留 —— 模板的文档价值有一大半在这儿', () => {
  const source = ['# 从 https://platform.openai.com/api-keys 申请', 'OPENAI_API_KEY=' + FAKE_KEY, ''].join(
    '\n'
  )
  const { content } = buildTemplate(source)
  assert.equal(content, '# 从 https://platform.openai.com/api-keys 申请\nOPENAI_API_KEY=\n')
})

test('redactCommentText 对没有 # 的文本原样返回', () => {
  assert.equal(redactCommentText(''), '')
  assert.equal(redactCommentText('   '), '   ')
})

test('已知的过度脱敏：带等号的散文也会被当成赋值', () => {
  // 分不出「被注释掉的配置」和「碰巧带等号的说明」，而目的地是 Git ——
  // 宁可多擦一句说明。这条用例是把这个取舍钉下来，不是描述一个 bug。
  assert.equal(redactCommentText('# note=see docs'), '# note=')
})

// ---------------------------------------------------------------------------
// unknown 行
// ---------------------------------------------------------------------------

test('读不懂的行被略去并计数，不静默丢', () => {
  const source = ['A=1', 'this line is not an assignment', 'B=2', ''].join('\n')
  const { content, droppedLines, entryCount } = buildTemplate(source)

  assert.equal(content, 'A=\nB=\n')
  assert.equal(droppedLines, 1)
  assert.equal(entryCount, 2)
})

// ---------------------------------------------------------------------------
// 🔴 兜底：结果里不许出现源文件的敏感值
// ---------------------------------------------------------------------------

test('🔴 正常模板不报泄漏 —— 兜底不能误报，否则用两次就没人看了', () => {
  const source = [
    '# 默认 true',
    'ENABLE_CACHE=true',
    'AUTH_MODE=jwt          # 支持 jwt 和 session',
    'PORT=5000',
    `OPENAI_API_KEY=${FAKE_KEY}`,
    ''
  ].join('\n')

  const { leaks } = buildTemplate(source)
  assert.deepEqual(leaks, [], '一份完全正常的模板被判成了泄漏')
})

test('🔴 检测漏掉的写法由兜底抓住 —— TODO: set X=… 不匹配赋值形状', () => {
  // `TODO` 后面是 `:` 不是 `=`，ASSIGNMENT 匹配不上，redactCommentText 够不着它。
  const source = [`# TODO: set the key to ${FAKE_KEY}`, `OPENAI_API_KEY=${FAKE_KEY}`, ''].join('\n')

  const { content, leaks } = buildTemplate(source)

  assert.equal(content.includes(FAKE_KEY), true, '这条用例的前提没成立：检测本该漏掉它')
  assert.equal(leaks.length, 1)
  assert.equal(leaks[0]?.key, 'OPENAI_API_KEY')
  assert.equal(leaks[0]?.lineNumber, 1)
})

test('🔴 泄漏报告只给 key 名和行号，不含值本身', () => {
  const { leaks } = buildTemplate(
    [`# 旧值 ${FAKE_KEY}`, `OPENAI_API_KEY=${FAKE_KEY}`, ''].join('\n')
  )
  assert.equal(leaks.length > 0, true)
  assert.equal(JSON.stringify(leaks).includes(FAKE_KEY), false, '泄漏报告里带上了值')
})

test('靠名字判出来的长口令也在兜底范围内', () => {
  const password = 'correct-horse-battery-staple'
  const source = [`# 上一版是 ${password}`, `DB_PASSWORD=${password}`, ''].join('\n')
  const { leaks } = buildTemplate(source)
  assert.equal(leaks.length, 1)
  assert.equal(leaks[0]?.key, 'DB_PASSWORD')
})

test('短的 sensitive 值不参与比对 —— 那是误报的来源', () => {
  const source = ['# 支持 jwt 和 session', 'AUTH_MODE=jwt', ''].join('\n')
  assert.deepEqual(buildTemplate(source).leaks, [])
})

test('空值不触发误报（includes("") 恒真）', () => {
  assert.deepEqual(buildTemplate('API_KEY=\nOTHER=x\n').leaks, [])
})

test('带凭据的连接串是 high，任何长度都查', () => {
  const dsn = 'postgres://user:secret@db.internal:5432/app'
  const { leaks } = buildTemplate([`# 旧的 ${dsn}`, `DATABASE_URL=${dsn}`, ''].join('\n'))
  assert.equal(leaks.length, 1)
  assert.equal(leaks[0]?.key, 'DATABASE_URL')
})

// ---------------------------------------------------------------------------
// 目标路径
// ---------------------------------------------------------------------------

test('模板落在源文件同目录，不是项目根', () => {
  const target = templateTargetPath('/repo/apps/web/.env.production')
  assert.equal(target.replace(/\\/g, '/'), '/repo/apps/web/.env.example')
})

test('认得出模板文件名，避免拿模板再生成一次模板', () => {
  assert.equal(isTemplateFileName('.env.example'), true)
  assert.equal(isTemplateFileName('/repo/.env.example'), true)
  assert.equal(isTemplateFileName('.env.local'), false)
})
