import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffEnvFile, summarizeDiff, type CentralEntry } from './diff.ts'
import { parseEnv } from './document.ts'

const central = (list: [string, string, number?][]): CentralEntry[] =>
  list.map(([key, value, occurrence]) => ({ key, value, occurrence: occurrence ?? 0 }))

test('两边一致时全部 unchanged', () => {
  const rows = diffEnvFile(central([['A', '1'], ['B', '2']]), parseEnv('A=1\nB=2\n'))
  assert.deepEqual(rows.map((r) => r.status), ['unchanged', 'unchanged'])
  assert.equal(summarizeDiff(rows).hasChanges, false)
})

test('值不同判为 changed，两侧的值都带出来', () => {
  const rows = diffEnvFile(central([['A', '1']]), parseEnv('A=2\n'))
  assert.equal(rows[0]?.status, 'changed')
  assert.equal(rows[0]?.centralValue, '1')
  assert.equal(rows[0]?.diskValue, '2')
})

test('磁盘上多出来的判为 added', () => {
  const rows = diffEnvFile(central([['A', '1']]), parseEnv('A=1\nNEW=x\n'))
  const added = rows.find((r) => r.key === 'NEW')
  assert.equal(added?.status, 'added')
  assert.equal(added?.centralValue, null)
  assert.equal(added?.diskValue, 'x')
  assert.equal(added?.lineNumber, 2)
})

test('磁盘上被删掉的判为 removed，且排在最后', () => {
  const rows = diffEnvFile(central([['A', '1'], ['GONE', 'x']]), parseEnv('A=1\n'))
  assert.equal(rows[rows.length - 1]?.key, 'GONE')
  assert.equal(rows[rows.length - 1]?.status, 'removed')
  assert.equal(rows[rows.length - 1]?.diskValue, null)
  // 磁盘上没有位置，所以没有行号
  assert.equal(rows[rows.length - 1]?.lineNumber, null)
})

test('🔴 上面插入一行注释不会让所有变量都变成 changed', () => {
  // 按行号配对的实现会在这里全线飘红；按 key 配对才只看值。
  const rows = diffEnvFile(central([['A', '1'], ['B', '2']]), parseEnv('# 新注释\nA=1\nB=2\n'))
  assert.equal(summarizeDiff(rows).hasChanges, false)
  assert.equal(rows.find((r) => r.key === 'A')?.lineNumber, 2)
})

test('🔴 重复 key 按 occurrence 配对，不互相顶掉', () => {
  const rows = diffEnvFile(
    central([['DUP', 'first', 0], ['DUP', 'second', 1]]),
    parseEnv('DUP=first\nDUP=CHANGED\n')
  )
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.status, 'unchanged')
  assert.equal(rows[1]?.status, 'changed')
  assert.equal(rows[1]?.occurrence, 1)
})

test('重复 key 在磁盘上少了一条时只报最后那条 removed', () => {
  const rows = diffEnvFile(
    central([['DUP', 'first', 0], ['DUP', 'second', 1]]),
    parseEnv('DUP=first\n')
  )
  assert.deepEqual(rows.map((r) => `${r.occurrence}:${r.status}`), ['0:unchanged', '1:removed'])
})

test('结果按磁盘出现顺序排列', () => {
  const rows = diffEnvFile(central([['A', '1'], ['B', '2']]), parseEnv('B=2\nA=1\n'))
  assert.deepEqual(rows.map((r) => r.key), ['B', 'A'])
})

test('空值与缺失值是两回事', () => {
  const emptyBoth = diffEnvFile(central([['A', '']]), parseEnv('A=\n'))
  assert.equal(emptyBoth[0]?.status, 'unchanged')

  const emptyOnDisk = diffEnvFile(central([['A', 'x']]), parseEnv('A=\n'))
  assert.equal(emptyOnDisk[0]?.status, 'changed')
  assert.equal(emptyOnDisk[0]?.diskValue, '')
})

test('摘要统计各状态数量', () => {
  const rows = diffEnvFile(
    central([['SAME', '1'], ['MOD', 'a'], ['GONE', 'x']]),
    parseEnv('SAME=1\nMOD=b\nNEW=n\n')
  )
  const summary = summarizeDiff(rows)
  assert.deepEqual(
    { ...summary },
    { unchanged: 1, changed: 1, added: 1, removed: 1, hasChanges: true }
  )
})

test('注释与空行不参与对比', () => {
  const rows = diffEnvFile(central([['A', '1']]), parseEnv('# c\n\nA=1\n\n# tail\n'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.status, 'unchanged')
})
