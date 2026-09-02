/**
 * 加密导出包的格式与口令加解密（阶段 5c）。
 *
 * 最重要的三组：**往返能开**、**口令不对就打不开**、
 * 以及**改包头一个字节就打不开**（KDF 参数进了 AAD）。
 * 别为了让某条用例跑快去放宽它们。
 *
 * 跑法：node --test src/main/transfer/*.test.ts
 *
 * ⚠️ 这里用的是**故意调低**的 KDF 参数（log2N=8）。真实默认是 2^17、
 * 单次几百毫秒，二十条用例跑下来要十几秒 —— 那会让人不愿意跑测试。
 * 但「默认参数确实是 2^17」单独有一条断言守着，见文件末尾。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_KDF,
  PACKAGE_VERSION,
  PackageError,
  inspectPackage,
  openPackage,
  sealPackage
} from './package.ts'

/** 跑得快的参数，只在测试里用。 */
const FAST = { log2N: 8, r: 8, p: 1 }

/** 翻转某一个字节。用 read/write 而不是 `buf[i] ^= …`：后者过不了索引空检查。 */
function flipByte(source: Buffer, index: number): Buffer {
  const copy = Buffer.from(source)
  copy.writeUInt8(copy.readUInt8(index) ^ 0xff, index)
  return copy
}

const PAYLOAD = JSON.stringify({ hello: '世界', key: 'sk-proj-abcdefghijklmnop' })

// ---------------------------------------------------------------------------
// 往返
// ---------------------------------------------------------------------------

test('封好再解开，拿回一模一样的明文', () => {
  const blob = sealPackage(PAYLOAD, 'correct horse battery staple', FAST)
  assert.equal(openPackage(blob, 'correct horse battery staple'), PAYLOAD)
})

test('同一段明文封两次，密文不同（salt 与 iv 都是随机的）', () => {
  const a = sealPackage(PAYLOAD, 'pw', FAST)
  const b = sealPackage(PAYLOAD, 'pw', FAST)
  assert.equal(a.equals(b), false, '两次封包产生了相同的字节')
  assert.equal(openPackage(a, 'pw'), openPackage(b, 'pw'))
})

test('🔴 包里搜不到明文片段', () => {
  const blob = sealPackage(PAYLOAD, 'pw', FAST)
  assert.equal(blob.includes(Buffer.from('sk-proj-', 'utf8')), false)
  assert.equal(blob.includes(Buffer.from('世界', 'utf8')), false)
})

test('空明文也能往返（导出了零个项目不该崩）', () => {
  const blob = sealPackage('', 'pw', FAST)
  assert.equal(openPackage(blob, 'pw'), '')
})

test('多字节内容不会被截断', () => {
  const text = '变量名=值\n注释：不要提交\n'.repeat(200)
  assert.equal(openPackage(sealPackage(text, 'pw', FAST), 'pw'), text)
})

// ---------------------------------------------------------------------------
// 🔴 口令
// ---------------------------------------------------------------------------

test('🔴 口令不对就打不开', () => {
  const blob = sealPackage(PAYLOAD, 'right', FAST)
  assert.throws(
    () => openPackage(blob, 'wrong'),
    (error) => error instanceof PackageError && error.code === 'BAD_PASSPHRASE'
  )
})

test('🔴 提示语不谎报成"口令错误" —— 损坏和口令错我们分不出来', () => {
  const blob = sealPackage(PAYLOAD, 'right', FAST)
  try {
    openPackage(blob, 'wrong')
    assert.fail('居然打开了')
  } catch (error) {
    assert.equal(error instanceof PackageError, true)
    const message = (error as PackageError).message
    assert.equal(message.includes('损坏'), true, `提示语没提损坏的可能：${message}`)
  }
})

test('口令做 NFKC 归一化 —— 同一个口令在不同系统上敲出来码点可能不同', () => {
  // é 有两种写法：单码点 U+00E9，或 e + U+0301 组合。用户看到的是同一个字。
  const composed = 'café'
  const decomposed = 'café'
  assert.notEqual(composed, decomposed, '这条用例的前提没成立')
  const blob = sealPackage(PAYLOAD, composed, FAST)
  assert.equal(openPackage(blob, decomposed), PAYLOAD)
})

test('空口令直接拒绝，不封出一个假装安全的包', () => {
  assert.throws(
    () => sealPackage(PAYLOAD, '', FAST),
    (error) => error instanceof PackageError && error.code === 'BAD_PARAMS'
  )
})

// ---------------------------------------------------------------------------
// 🔴 篡改
// ---------------------------------------------------------------------------

test('改包头里的 KDF 参数就打不开（参数参与密钥派生）', () => {
  // ⚠️ 这条**验不到 AAD**：log2N 本来就参与派生，改了它派生出的密钥就变了，
  // GCM 自然通不过 —— 把 setAAD 整个删掉这条照样绿。第一版误以为它在守 AAD，
  // 下面那两条才是。留着它是因为「改参数打不开」本身仍然值得钉住。
  const blob = sealPackage(PAYLOAD, 'pw', FAST)
  const tampered = Buffer.from(blob)
  tampered.writeUInt8(9, 6)
  assert.throws(
    () => openPackage(tampered, 'pw'),
    (error) => error instanceof PackageError && error.code === 'BAD_PASSPHRASE'
  )
})

test('🔴 把版本号降回去就打不开 —— 这条才真的在守 AAD', () => {
  // version 不参与密钥派生，`> PACKAGE_VERSION` 那道检查也拦不住往**低**改。
  // 没有 AAD 的话这个包会被照常解开。等格式演进到 v2，降级攻击就是靠这道拦的。
  const blob = sealPackage(PAYLOAD, 'pw', FAST)
  const downgraded = Buffer.from(blob)
  downgraded.writeUInt8(0, 4)
  assert.throws(
    () => openPackage(downgraded, 'pw'),
    (error) => error instanceof PackageError && error.code === 'BAD_PASSPHRASE'
  )
})

test('🔴 翻掉一个保留字节也打不开 —— 同样只有 AAD 拦得住', () => {
  // 偏移 9~11 是保留位，没有任何一处代码读它们。将来某个位可能表示"包体已压缩"，
  // 那时翻掉它会让解包方按错误的方式解释内容。现在就把这道锁上上。
  const blob = sealPackage(PAYLOAD, 'pw', FAST)
  assert.throws(
    () => openPackage(flipByte(blob, 9), 'pw'),
    (error) => error instanceof PackageError && error.code === 'BAD_PASSPHRASE'
  )
})

test('🔴 改密文任意一个字节就打不开（GCM 自带完整性）', () => {
  const blob = sealPackage(PAYLOAD, 'pw', FAST)
  assert.throws(() => openPackage(flipByte(blob, blob.length - 1), 'pw'), PackageError)
})

test('🔴 改 salt 也打不开', () => {
  const blob = sealPackage(PAYLOAD, 'pw', FAST)
  assert.throws(() => openPackage(flipByte(blob, 12), 'pw'), PackageError)
})

test('🔴 荒唐的 log2N 在派生之前就被挡住 —— AAD 是派生之后才校验的', () => {
  // 头虽然进了 AAD，但校验发生在解密时；如果先照着 log2N=40 去派生，
  // 我们会在校验之前尝试分配 1 TiB 内存。所以要有独立的上界检查。
  const blob = sealPackage(PAYLOAD, 'pw', FAST)
  const tampered = Buffer.from(blob)
  tampered.writeUInt8(40, 6)
  assert.throws(
    () => openPackage(tampered, 'pw'),
    (error) => error instanceof PackageError && error.code === 'BAD_PARAMS'
  )
})

// ---------------------------------------------------------------------------
// 格式识别
// ---------------------------------------------------------------------------

test('不是我们的文件就直说，不去猜', () => {
  assert.throws(
    () => openPackage(Buffer.from('这是一个普通的文本文件，随便写点什么凑长度'), 'pw'),
    (error) => error instanceof PackageError && error.code === 'NOT_A_PACKAGE'
  )
})

test('太短的文件不当成损坏的包，直接说不是包', () => {
  assert.throws(
    () => openPackage(Buffer.from('EVP1'), 'pw'),
    (error) => error instanceof PackageError && error.code === 'NOT_A_PACKAGE'
  )
})

test('🔴 更高版本的包拒绝导入，而不是硬解出半份数据', () => {
  const blob = sealPackage(PAYLOAD, 'pw', FAST)
  const future = Buffer.from(blob)
  future.writeUInt8(PACKAGE_VERSION + 1, 4)
  assert.throws(
    () => openPackage(future, 'pw'),
    (error) => error instanceof PackageError && error.code === 'VERSION_TOO_NEW'
  )
})

test('inspectPackage 不用口令就能认出版本与参数', () => {
  const blob = sealPackage(PAYLOAD, 'pw', FAST)
  assert.deepEqual(inspectPackage(blob), { version: PACKAGE_VERSION, kdf: FAST })
})

test('inspectPackage 对非包文件同样直说', () => {
  assert.throws(
    () => inspectPackage(Buffer.from('nope')),
    (error) => error instanceof PackageError && error.code === 'NOT_A_PACKAGE'
  )
})

// ---------------------------------------------------------------------------
// 🔴 默认参数
// ---------------------------------------------------------------------------

test('🔴 默认 KDF 参数是 2^17 —— 上面的用例用的是调低过的，这条守着真实默认', () => {
  // 没有这条的话，有人为了让测试跑快去改 DEFAULT_KDF，二十条用例照样全绿，
  // 而所有真实导出包的工作因子被悄悄降到了 2^8。
  assert.equal(DEFAULT_KDF.log2N, 17)
  assert.equal(DEFAULT_KDF.r, 8)
  assert.equal(DEFAULT_KDF.p, 1)
})

test('默认参数确实能封能开（只跑一次，慢是应该的）', () => {
  const blob = sealPackage('x', 'pw')
  assert.equal(inspectPackage(blob).kdf.log2N, 17)
  assert.equal(openPackage(blob, 'pw'), 'x')
})
