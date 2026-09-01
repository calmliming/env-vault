import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WriteConflictError, hashFile, makeBackupPath, restoreBackup, writeEnvFileAtomic } from './write.ts'

function fixture(content = 'A=1\nB=2\n'): { root: string; target: string; backups: string } {
  const root = mkdtempSync(join(tmpdir(), 'envvault-write-'))
  const target = join(root, '.env')
  const backups = join(root, 'backups')
  writeFileSync(target, content)
  mkdirSync(backups, { recursive: true })
  return { root, target, backups }
}

test('写入后内容正确，返回的哈希与磁盘一致', () => {
  const { root, target, backups } = fixture()
  try {
    const result = writeEnvFileAtomic(target, 'A=9\nB=2\n', { backupRoot: backups })
    assert.equal(readFileSync(target, 'utf8'), 'A=9\nB=2\n')
    assert.equal(result.newHash, hashFile(target))
    assert.equal(result.bytesWritten, Buffer.byteLength('A=9\nB=2\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('写入前先备份，备份内容是改动前的原文', () => {
  const { root, target, backups } = fixture('ORIGINAL=1\n')
  try {
    const result = writeEnvFileAtomic(target, 'CHANGED=2\n', { backupRoot: backups })
    assert.equal(readFileSync(result.backupPath, 'utf8'), 'ORIGINAL=1\n')
    assert.equal(readFileSync(target, 'utf8'), 'CHANGED=2\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('🔴 备份不落在用户目录里', () => {
  const { root, target, backups } = fixture()
  try {
    writeEnvFileAtomic(target, 'A=9\n', { backupRoot: backups })
    // 目标同目录下不该多出任何文件：备份在 backupRoot，临时文件已被 rename 掉
    const siblings = readdirSync(root).filter((name) => name !== 'backups')
    assert.deepEqual(siblings, ['.env'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('🔴 写完不留临时文件', () => {
  const { root, target, backups } = fixture()
  try {
    writeEnvFileAtomic(target, 'A=9\n', { backupRoot: backups })
    assert.equal(readdirSync(root).some((name) => name.includes('.tmp')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('🔴 磁盘在决策期间被改过就拒绝写入（§6.4）', () => {
  const { root, target, backups } = fixture('A=1\n')
  try {
    const staleHash = hashFile(target)
    // 有人在我们算完差异之后改了文件
    writeFileSync(target, 'A=someone-else-changed-this\n')

    assert.throws(
      () => writeEnvFileAtomic(target, 'A=ours\n', { backupRoot: backups, expectedHash: staleHash! }),
      WriteConflictError
    )
    // 别人的修改必须原封不动
    assert.equal(readFileSync(target, 'utf8'), 'A=someone-else-changed-this\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('哈希对得上时正常写入', () => {
  const { root, target, backups } = fixture('A=1\n')
  try {
    const current = hashFile(target)!
    writeEnvFileAtomic(target, 'A=2\n', { backupRoot: backups, expectedHash: current })
    assert.equal(readFileSync(target, 'utf8'), 'A=2\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('冲突检测发生在备份之前，不留下无意义的备份', () => {
  const { root, target, backups } = fixture('A=1\n')
  try {
    const staleHash = hashFile(target)!
    writeFileSync(target, 'A=changed\n')
    try {
      writeEnvFileAtomic(target, 'A=x\n', { backupRoot: backups, expectedHash: staleHash })
    } catch {
      /* 预期抛错 */
    }
    assert.deepEqual(readdirSync(backups), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('目标文件不存在时报错而不是凭空创建', () => {
  const { root, backups } = fixture()
  try {
    assert.throws(() => writeEnvFileAtomic(join(root, 'nope.env'), 'A=1\n', { backupRoot: backups }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('保留原文件的权限位', { skip: process.platform === 'win32' ? 'Windows 不用 POSIX 权限位' : false }, () => {
  const { root, target, backups } = fixture()
  try {
    chmodSync(target, 0o600)
    writeEnvFileAtomic(target, 'A=9\n', { backupRoot: backups })
    assert.equal(statSync(target).mode & 0o777, 0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('同名文件来自不同项目时备份不会互相覆盖', () => {
  const a = makeBackupPath('/projects/alpha/.env', '/backups')
  const b = makeBackupPath('/projects/beta/.env', '/backups')
  // 路径哈希分桶，所以目录不同
  assert.notEqual(a.split(/[\\/]/).slice(-2)[0], b.split(/[\\/]/).slice(-2)[0])
})

test('备份可以还原回去', () => {
  const { root, target, backups } = fixture('ORIGINAL=1\n')
  try {
    const first = writeEnvFileAtomic(target, 'BROKEN=2\n', { backupRoot: backups })
    assert.equal(readFileSync(target, 'utf8'), 'BROKEN=2\n')

    restoreBackup(first.backupPath, target, backups)
    assert.equal(readFileSync(target, 'utf8'), 'ORIGINAL=1\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('文件不存在时 hashFile 返回 null', () => {
  assert.equal(hashFile(join(tmpdir(), 'definitely-missing-8a3f', '.env')), null)
})
