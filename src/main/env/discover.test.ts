/**
 * 从父目录发现多个项目（阶段 6）。
 *
 * 最重要的一组是**「遇到 .git 就停，不再往下钻」**：
 * 它是「一个项目一个 git_root，而且是对的」这条不变量的前提。
 *
 * 跑法：node --test src/main/env/discover.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverProjects } from './discover.ts'
import { scanProject } from './scan.ts'

/** 造一个目录树。`.git/` 用目录，`.git` 用文件（模拟 submodule）。 */
function fixture(build: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'envvault-discover-'))
  build(root)
  return root
}

function repo(path: string, { asFile = false } = {}): void {
  mkdirSync(path, { recursive: true })
  if (asFile) writeFileSync(join(path, '.git'), 'gitdir: ../.git/modules/x\n')
  else mkdirSync(join(path, '.git'), { recursive: true })
}

function names(root: string): string[] {
  return discoverProjects(root)
    .projects.map((p) => p.name)
    .sort()
}

// ---------------------------------------------------------------------------

test('父目录下的多个仓库各自成为一个项目', () => {
  const root = fixture((r) => {
    repo(join(r, 'repo-a'))
    repo(join(r, 'repo-b'))
    repo(join(r, 'repo-c'))
  })
  try {
    assert.deepEqual(names(root), ['repo-a', 'repo-b', 'repo-c'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('🔴 遇到 .git 就停，不把子模块也列成独立项目', () => {
  // 不停的话，sub 会同时属于 repo-a 和它自己 —— 重复归属，
  // 而且父项目那份会拿**父仓库**去问 sub 的跟踪状态。
  const root = fixture((r) => {
    repo(join(r, 'repo-a'))
    repo(join(r, 'repo-a', 'packages', 'sub'))
  })
  try {
    assert.deepEqual(names(root), ['repo-a'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('.git 是文件（submodule / worktree）也算仓库', () => {
  const root = fixture((r) => {
    repo(join(r, 'linked'), { asFile: true })
  })
  try {
    assert.deepEqual(names(root), ['linked'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('仓库藏在中间层也找得到', () => {
  const root = fixture((r) => {
    repo(join(r, 'work', 'client', 'repo-x'))
  })
  try {
    assert.deepEqual(names(root), ['repo-x'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('不进 node_modules —— 依赖里的仓库不是用户的项目', () => {
  const root = fixture((r) => {
    repo(join(r, 'repo-a'))
    repo(join(r, 'node_modules', 'some-dep'))
  })
  try {
    assert.deepEqual(names(root), ['repo-a'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('🔴 选中目录自己是仓库时，它和底下的仓库都要列出来', () => {
  // 早先只给选中的那一个，结果最常见的布局用不上这个功能：
  // `~/code` 自己也 git init 过、底下放着一堆仓库 —— 而那恰恰是
  // 「问错仓库」缺陷最容易发生的场景。
  const root = fixture((r) => {
    repo(r)
    repo(join(r, 'repo-a'))
    repo(join(r, 'repo-b'))
  })
  try {
    const result = discoverProjects(root)
    assert.equal(result.startIsRepo, true)
    assert.equal(result.projects.length, 3)
    assert.deepEqual(
      result.projects.map((p) => p.name).sort(),
      ['repo-a', 'repo-b', result.projects.find((p) => p.rootPath === root)!.name].sort()
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('一个仓库都没有时，退回「就把这个目录当一个项目」', () => {
  // 那正是没有发现功能之前的行为，不该因为加了发现而丢掉。
  const root = fixture((r) => {
    mkdirSync(join(r, 'plain'), { recursive: true })
    writeFileSync(join(r, 'plain', '.env'), 'A=1\n')
  })
  try {
    const result = discoverProjects(root)
    assert.equal(result.projects.length, 1)
    assert.equal(result.projects[0]?.isGitRepo, false)
    assert.equal(result.projects[0]?.rootPath, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('数量上限会如实标出来，不静默截断', () => {
  const root = fixture((r) => {
    for (let i = 0; i < 5; i += 1) repo(join(r, `repo-${i}`))
  })
  try {
    const result = discoverProjects(root, { maxProjects: 3 })
    assert.equal(result.projects.length, 3)
    assert.equal(result.truncated, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('深度上限同样如实标出来', () => {
  const root = fixture((r) => {
    repo(join(r, 'a', 'b', 'c', 'd', 'e', 'deep'))
  })
  try {
    const result = discoverProjects(root, { maxDepth: 2 })
    assert.equal(result.truncated, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 🔴 扫描侧的另一半：scanProject 也要在嵌套仓库处停
// ---------------------------------------------------------------------------

test('🔴 scanProject 不把嵌套仓库里的 .env 收进父项目', () => {
  // 收了的话，那个文件会拿**父仓库**的 git_root 去判断跟踪状态，
  // 而它在父仓库看来永远「未跟踪」——「已提交又补进 .gitignore」
  // 那条 critical 就永远报不出来了。
  const root = fixture((r) => {
    repo(r)
    writeFileSync(join(r, '.env'), 'PARENT=1\n')
    repo(join(r, 'packages', 'sub'))
    writeFileSync(join(r, 'packages', 'sub', '.env'), 'CHILD=2\n')
  })
  try {
    const scan = scanProject(root)
    assert.deepEqual(
      scan.files.map((f) => f.relativePath),
      ['.env']
    )
    assert.equal(scan.nestedRepos.length, 1)
    assert.equal(scan.nestedRepos[0]?.replace(/\\/g, '/').endsWith('packages/sub'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('普通 monorepo 子目录照旧扫得到（没有 .git 就不是边界）', () => {
  const root = fixture((r) => {
    repo(r)
    writeFileSync(join(r, '.env'), 'A=1\n')
    mkdirSync(join(r, 'apps', 'web'), { recursive: true })
    writeFileSync(join(r, 'apps', 'web', '.env.production'), 'B=2\n')
  })
  try {
    const scan = scanProject(root)
    assert.deepEqual(
      scan.files.map((f) => f.relativePath).sort(),
      ['.env', 'apps/web/.env.production']
    )
    assert.equal(scan.nestedRepos.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
