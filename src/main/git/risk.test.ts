/**
 * 风险判定表的逐条测试。
 *
 * 这张表的价值全在边界上：
 *   - 「既被跟踪又在 .gitignore 里」必须报出来（真实世界里最常见的假安心）；
 *   - 「被跟踪的干净模板」必须**不**报（喊狼来了的功能等于没有功能）；
 *   - 「查不出来」必须是 unknown 而不是 ok。
 *
 * 跑法：node --test src/main/git/*.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gradeRisk } from './risk.ts'
import type { RiskInput } from './risk.ts'

function input(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    relativePath: '.env',
    isTemplate: false,
    onDisk: true,
    tracked: false,
    ignored: true,
    highCount: 0,
    sensitiveCount: 0,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// 磁盘上已经没有的文件
// ---------------------------------------------------------------------------

test('磁盘上没有、Git 里也没有 → ok，不建议去保护一个不存在的文件', () => {
  // 这条是看着界面截图补的：之前会显示成
  // 「磁盘上已不存在」+「建议把它加进 .gitignore」并排。
  const verdict = gradeRisk(input({ onDisk: false, tracked: false, ignored: false }))
  assert.equal(verdict.level, 'ok')
  assert.equal(verdict.remedy, null)
  assert.match(verdict.reason, /已从磁盘消失/)
})

test('🔴 但本地删了、仓库里还有的，照样定罪', () => {
  // 本地删掉不会让内容离开 git 历史。这里放行就等于替用户宣布"已经清理了"。
  const verdict = gradeRisk(input({ onDisk: false, tracked: true, ignored: false, highCount: 1 }))
  assert.equal(verdict.level, 'critical')
  assert.match(verdict.remedy ?? '', /git rm --cached/)
})

// ---------------------------------------------------------------------------
// 🔴 查不出来 ≠ 没问题
// ---------------------------------------------------------------------------

test('🔴 Git 状态未知时是 unknown，不是 ok', () => {
  // 绿色的「通过」会被用户拿去决定要不要提交。没查出来就必须说没查出来。
  for (const unknown of [
    { tracked: null, ignored: null },
    { tracked: null, ignored: false },
    { tracked: true, ignored: null }
  ] as const) {
    const verdict = gradeRisk(input({ ...unknown, highCount: 3 }))
    assert.equal(verdict.level, 'unknown', JSON.stringify(unknown))
  }
})

test('未知时也如实报出文件里有什么', () => {
  const verdict = gradeRisk(input({ tracked: null, ignored: null, highCount: 2 }))
  assert.match(verdict.reason, /2 个高危值/)
  assert.equal(verdict.remedy, null)
})

// ---------------------------------------------------------------------------
// 🔴 既被跟踪、又在 .gitignore 里
// ---------------------------------------------------------------------------

test('🔴 已跟踪 + 已忽略 + 有敏感值 → critical，并说明忽略规则无效', () => {
  const verdict = gradeRisk(input({ tracked: true, ignored: true, highCount: 1 }))
  assert.equal(verdict.level, 'critical')
  assert.match(verdict.reason, /忽略规则对已跟踪的文件无效/)
})

test('🔴 处置办法给的是 git rm --cached，并提醒历史里的旧版本还在', () => {
  // 只说「加进 .gitignore」是错的建议 —— 那正是用户已经做过、
  // 并且以为已经解决了的事。
  const verdict = gradeRisk(input({ tracked: true, ignored: true, highCount: 1 }))
  assert.match(verdict.remedy ?? '', /git rm --cached/)
  assert.match(verdict.remedy ?? '', /历史/)
  assert.match(verdict.remedy ?? '', /作废/)
})

test('已跟踪 + 已忽略但没有敏感值 → warning，仍然要提一句', () => {
  // 现在没东西可泄漏，但等哪天往里加了 Key，上一条就成立了。
  const verdict = gradeRisk(input({ tracked: true, ignored: true }))
  assert.equal(verdict.level, 'warning')
  assert.match(verdict.reason, /忽略规则对已跟踪的文件无效/)
})

// ---------------------------------------------------------------------------
// 已经在仓库里
// ---------------------------------------------------------------------------

test('已跟踪 + 高危值 → critical', () => {
  const verdict = gradeRisk(input({ tracked: true, ignored: false, highCount: 2 }))
  assert.equal(verdict.level, 'critical')
  assert.match(verdict.reason, /仓库历史/)
  assert.match(verdict.remedy ?? '', /git rm --cached/)
})

test('已跟踪 + 只有疑似敏感值 → warning', () => {
  const verdict = gradeRisk(input({ tracked: true, ignored: false, sensitiveCount: 1 }))
  assert.equal(verdict.level, 'warning')
})

// ---------------------------------------------------------------------------
// 还没进仓库，但也没人拦着
// ---------------------------------------------------------------------------

test('未跟踪 + 未忽略 + 高危值 → critical，指出下一次 git add 就带进去', () => {
  const verdict = gradeRisk(input({ tracked: false, ignored: false, highCount: 1 }))
  assert.equal(verdict.level, 'critical')
  assert.match(verdict.reason, /git add/)
  assert.match(verdict.remedy ?? '', /\.gitignore/)
})

test('未跟踪 + 未忽略 + 没有敏感值的真实配置 → warning', () => {
  // 现在是空的，但 .env 这类文件迟早会装上东西。
  const verdict = gradeRisk(input({ tracked: false, ignored: false }))
  assert.equal(verdict.level, 'warning')
  assert.match(verdict.reason, /以后往里加 Key/)
})

// ---------------------------------------------------------------------------
// 🔴 不喊狼来了
// ---------------------------------------------------------------------------

test('🔴 被跟踪的干净模板是 ok —— 那是正常做法，不是风险', () => {
  // 每个项目都把 .env.example 标红的安全页，用户看两次就再也不看了。
  const verdict = gradeRisk(
    input({ relativePath: '.env.example', isTemplate: true, tracked: true, ignored: false })
  )
  assert.equal(verdict.level, 'ok')
  assert.equal(verdict.remedy, null)
})

test('🔴 但模板里塞了真 Key 依然是 critical', () => {
  // classify.ts 那条「公开前缀里塞了真 Key 依然要报出来」在这里接上。
  const verdict = gradeRisk(
    input({
      relativePath: '.env.example',
      isTemplate: true,
      tracked: true,
      ignored: false,
      highCount: 1
    })
  )
  assert.equal(verdict.level, 'critical')
})

test('未跟踪的模板不因为「没被忽略」而报警', () => {
  const verdict = gradeRisk(
    input({ relativePath: '.env.example', isTemplate: true, tracked: false, ignored: false })
  )
  assert.equal(verdict.level, 'ok')
})

test('已忽略且未跟踪 → ok，这是我们希望看到的状态', () => {
  const verdict = gradeRisk(input({ tracked: false, ignored: true, highCount: 5 }))
  assert.equal(verdict.level, 'ok')
  assert.match(verdict.reason, /不会进入仓库/)
})

// ---------------------------------------------------------------------------
// 🔴 结论里只有计数
// ---------------------------------------------------------------------------

test('🔴 判定的入参里压根没有放值的字段', () => {
  // 这一层拿不到值，所以不可能不小心把值写进 reason 里。
  //
  // 这条会因为**任何**新增字段而变红，那是有意的：加字段时必须有人过一眼，
  // 确认新加的不是一个能装下配置值的口子。改这个列表前先想清楚。
  const keys = Object.keys(input())
  assert.deepEqual(keys.sort(), [
    'highCount',
    'ignored',
    'isTemplate',
    'onDisk',
    'relativePath',
    'sensitiveCount',
    'tracked'
  ])
})
