import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentFileHash, findGitRoot, hashText, scanProject } from './scan.ts'

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'envvault-scan-'))

  writeFileSync(join(root, '.env'), 'SHARED=1\nPORT=3000\n')
  writeFileSync(join(root, '.env.local'), 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz01\n')
  writeFileSync(join(root, '.env.example'), 'SHARED=\nPORT=\n')
  writeFileSync(join(root, 'package.json'), '{}')
  writeFileSync(join(root, '.environment'), 'NOT_AN_ENV_FILE=1\n')

  mkdirSync(join(root, 'apps', 'web'), { recursive: true })
  writeFileSync(join(root, 'apps', 'web', '.env.production'), 'API_URL=https://api.example.com\n')

  // 依赖目录里的 .env 不该被收进来
  mkdirSync(join(root, 'node_modules', 'some-pkg'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'some-pkg', '.env'), 'GHOST=1\n')

  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'dist', '.env'), 'BUILT=1\n')

  return root
}

test('扫描发现所有 .env* 文件，跳过依赖与构建目录', () => {
  const root = makeFixture()
  try {
    const result = scanProject(root)
    const paths = result.files.map((f) => f.relativePath).sort()

    assert.deepEqual(paths, [
      '.env',
      '.env.example',
      '.env.local',
      'apps/web/.env.production'
    ])
    assert.equal(result.truncatedBy, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('相对路径始终用正斜杠，不出现反斜杠', () => {
  const root = makeFixture()
  try {
    const nested = scanProject(root).files.find((f) => f.fileName === '.env.production')
    assert.equal(nested?.relativePath, 'apps/web/.env.production')
    assert.equal(nested?.relativePath.includes('\\'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('环境名与模板标记来自文件名', () => {
  const root = makeFixture()
  try {
    const byName = new Map(scanProject(root).files.map((f) => [f.fileName, f]))
    assert.equal(byName.get('.env')?.environment, 'default')
    assert.equal(byName.get('.env.local')?.environment, 'local')
    assert.equal(byName.get('.env.production')?.environment, 'production')
    assert.equal(byName.get('.env.example')?.isTemplate, true)
    assert.equal(byName.get('.env')?.isTemplate, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('条目带上分类结果与格式骨架', () => {
  const root = makeFixture()
  try {
    const local = scanProject(root).files.find((f) => f.fileName === '.env.local')
    const entry = local?.entries[0]
    assert.equal(entry?.key, 'OPENAI_API_KEY')
    assert.equal(entry?.sensitivity, 'high')
    assert.equal(entry?.valueType, 'secret')
    assert.equal(entry?.lineNumber, 1)
    // 🔴 original_format 落在一个不加密的 TEXT 列上，所以扫描给出的是
    // 「把值换成占位符的那一行」而不是原始行 —— 否则明文直接落库。
    assert.equal(entry?.originalFormat, 'OPENAI_API_KEY=<value>')
    assert.equal(entry?.originalFormat.includes('sk-proj-'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('文件哈希与内容一致，可用于外部修改检测', () => {
  const root = makeFixture()
  try {
    const before = scanProject(root).files.find((f) => f.fileName === '.env')
    assert.equal(before?.fileHash, hashText('SHARED=1\nPORT=3000\n'))
    assert.equal(currentFileHash(join(root, '.env')), before?.fileHash)

    writeFileSync(join(root, '.env'), 'SHARED=2\nPORT=3000\n')
    assert.notEqual(currentFileHash(join(root, '.env')), before?.fileHash)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('文件不存在时哈希返回 null 而不是抛异常', () => {
  assert.equal(currentFileHash(join(tmpdir(), 'definitely-not-here-9f3a', '.env')), null)
})

test('深度上限生效并标记 truncatedBy: depth', () => {
  const root = mkdtempSync(join(tmpdir(), 'envvault-depth-'))
  try {
    mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true })
    writeFileSync(join(root, 'a', 'b', 'c', '.env'), 'DEEP=1\n')

    assert.equal(scanProject(root, { maxDepth: 1 }).files.length, 0)
    assert.equal(scanProject(root, { maxDepth: 1 }).truncatedBy, 'depth')
    assert.equal(scanProject(root, { maxDepth: 3 }).files.length, 1)
    assert.equal(scanProject(root, { maxDepth: 3 }).truncatedBy, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/*
 * 回归：这一条是这次改动的起因。
 *
 * 真实项目（monorepo + Next.js App Router）的路由目录能到 11 层，里面一个
 * `.env` 都没有，却让扫描报「这个项目下的文件很多」。归因错了，而且天天报。
 * 默认深度提到 12 之后，这种形状必须安静。
 */
test('深但没有 .env 的目录：默认参数下不报截断', () => {
  const root = mkdtempSync(join(tmpdir(), 'envvault-deep-empty-'))
  try {
    writeFileSync(join(root, '.env.example'), 'A=1\n')
    mkdirSync(join(root, 'apps', 'web', '.git'), { recursive: true })
    rmSync(join(root, 'apps', 'web', '.git'), { recursive: true, force: true })
    writeFileSync(join(root, '.env'), 'B=1\n')

    // apps/web/src/app/api/background/support/mail/received/[id]/attachments
    const deep = join(
      root, 'apps', 'web', 'src', 'app', 'api',
      'background', 'support', 'mail', 'received', '[id]', 'attachments'
    )
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, 'route.ts'), 'export const GET = () => null\n')

    const result = scanProject(root)
    assert.equal(result.truncatedBy, null, '深目录里没有 .env，不该报截断')
    assert.equal(result.files.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('文件数上限生效，浅层文件优先保留', () => {
  const root = mkdtempSync(join(tmpdir(), 'envvault-cap-'))
  try {
    writeFileSync(join(root, '.env'), 'A=1\n')
    mkdirSync(join(root, 'deep'), { recursive: true })
    writeFileSync(join(root, 'deep', '.env'), 'B=1\n')

    const capped = scanProject(root, { maxFiles: 1 })
    assert.equal(capped.files.length, 1)
    assert.equal(capped.files[0]?.relativePath, '.env')
    assert.equal(capped.truncatedBy, 'files')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('找不到 Git 仓库时 gitRoot 为 null，找得到时指向仓库根', () => {
  const root = mkdtempSync(join(tmpdir(), 'envvault-git-'))
  try {
    writeFileSync(join(root, '.env'), 'A=1\n')
    assert.equal(scanProject(root).gitRoot, null)

    // .git 在 worktree / submodule 里是文件不是目录，所以只判存在
    writeFileSync(join(root, '.git'), 'gitdir: ../elsewhere\n')
    assert.equal(findGitRoot(root), root)

    mkdirSync(join(root, 'nested'), { recursive: true })
    assert.equal(findGitRoot(join(root, 'nested')), root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('单个文件读取失败不会让整次扫描失败', () => {
  const root = mkdtempSync(join(tmpdir(), 'envvault-bad-'))
  try {
    writeFileSync(join(root, '.env'), 'OK=1\n')
    // 用目录冒充 .env 文件名：readdir 会把它当目录，不会进 files
    mkdirSync(join(root, '.env.weird'), { recursive: true })

    const result = scanProject(root)
    assert.equal(result.files.length, 1)
    assert.equal(result.files[0]?.error, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
