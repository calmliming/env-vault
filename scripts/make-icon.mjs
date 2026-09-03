/**
 * 生成应用图标（阶段 7）。
 *
 * 产出 `build/icon.ico`（Windows，多尺寸）和 `build/icon.png`（Linux，512）。
 *
 * ## 为什么是脚本而不是直接放一个二进制
 *
 * 一个来历不明的 .ico 没人改得动 —— 想调个边距都得重新找工具。
 * 这里用有符号距离场（SDF）把形状算出来，改一个数就能重新生成，
 * 而且**小尺寸单独做了视觉修正**（见 strokeBoost），那是手工导出做不到的。
 *
 * 跑法：node scripts/make-icon.mjs
 *
 * ## 设计
 *
 * 一把挂锁，**锁体就是 `=`**。
 *
 * 语义正好是这个应用做的事：一个被锁起来的配置值。而且它在 16px 下
 * 只剩「一道弧 + 两条横杠」，仍然认得出来 —— 这是选它而不是选
 * 「保险柜转盘」「盾牌」的原因，后两者缩到 16px 都会糊成一团。
 *
 * 两处调过之后才立住的比例：
 *   - **锁梁的腿要短。** 第一版腿长是半径的两倍，读出来是"拱门"不是"挂锁"。
 *   - **锁梁和 `=` 之间要留白。** 腿直接踩在第一条横杠上时，那条杠就被吸收进
 *     锁的轮廓里，`=` 只剩一条 —— 整个图案变成"钟"或"墓碑"。留出空隙之后，
 *     上面是锁、下面是两条等长的杠，两个意思才都读得出来。
 *
 * 配色直接取界面的设计令牌（`styles/global.css`）：
 * 深墨底 + 米白标记。深底是有意的 —— 浅色和深色任务栏上都立得住。
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// --- 设计令牌（和 styles/global.css 保持一致）-------------------------------

/**
 * 底色用 --green，不是 --ink。
 *
 * 第一版用近黑的 --ink，在浅色任务栏上很精神，但**深色任务栏上整块瓷砖
 * 直接消失**，只剩标记浮在那儿 —— 图标失去了轮廓，也失去了辨识度。
 * 任务栏底色两种都有，一个只在其中一种上成立的图标等于只做了一半。
 * 鼠尾草绿两边都立得住，而且它本来就是这个应用的主色。
 */
const BASE = [0x4a, 0x63, 0x57] // --green 压暗一点，作为底部
const BASE_TOP = [0x5d, 0x7a, 0x6c] // 顶部提亮，给一点体积感
const CANVAS = [0xf6, 0xf6, 0xf3] // --canvas，标记色

/** 圆角比例。Windows 11 的图标不追求 iOS 那种大圆角。 */
const CORNER = 0.185

// --- 形状（归一化坐标，0..1）------------------------------------------------

const SHACKLE_CX = 0.5
const SHACKLE_CY = 0.345
const SHACKLE_R = 0.128 // 中线半径
const SHACKLE_W = 0.058 // 线宽
const SHACKLE_LEG_END = 0.45 // 腿要短：长过半径就成了拱门，不是挂锁

const BAR_X0 = 0.255
const BAR_X1 = 0.745
const BAR_W = 0.078
const BAR_Y1 = 0.59
const BAR_Y2 = 0.775

// --- SDF 工具 ---------------------------------------------------------------

/** 圆角矩形的有符号距离。 */
function sdRoundRect(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r)
  const qy = Math.abs(py - cy) - (hy - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

/** 圆头线段（胶囊）的有符号距离。 */
function sdCapsule(px, py, ax, ay, bx, by, r) {
  const pax = px - ax
  const pay = py - ay
  const bax = bx - ax
  const bay = by - ay
  const denom = bax * bax + bay * bay
  const h = denom === 0 ? 0 : Math.min(Math.max((pax * bax + pay * bay) / denom, 0), 1)
  return Math.hypot(pax - bax * h, pay - bay * h) - r
}

/**
 * 锁梁：上半个圆环 + 两条竖腿。
 *
 * 环只取 y <= cy 的那一半，下半部分交给竖腿 —— 这样腿尾自带圆头，
 * 而不是被环硬切出一个方口。
 */
function sdShackle(px, py, s) {
  const cx = SHACKLE_CX * s
  const cy = SHACKLE_CY * s
  const r = SHACKLE_R * s
  const hw = (SHACKLE_W * s) / 2

  let d = Infinity
  if (py <= cy) {
    d = Math.abs(Math.hypot(px - cx, py - cy) - r) - hw
  }
  const legEnd = SHACKLE_LEG_END * s
  d = Math.min(d, sdCapsule(px, py, cx - r, cy, cx - r, legEnd, hw))
  d = Math.min(d, sdCapsule(px, py, cx + r, cy, cx + r, legEnd, hw))
  return d
}

/** 锁体：两条圆头横杠，也就是那个 `=`。 */
function sdBars(px, py, s) {
  const hw = (BAR_W * s) / 2
  const x0 = BAR_X0 * s + hw
  const x1 = BAR_X1 * s - hw
  const d1 = sdCapsule(px, py, x0, BAR_Y1 * s, x1, BAR_Y1 * s, hw)
  const d2 = sdCapsule(px, py, x0, BAR_Y2 * s, x1, BAR_Y2 * s, hw)
  return Math.min(d1, d2)
}

/**
 * 小尺寸的视觉修正。
 *
 * 几何上等比缩放到 16px 时线宽只剩 1 像素出头，看着发虚、发灰。
 * 图标在小尺寸下本来就该加粗一点 —— 这是手工导出 PNG 做不到、
 * 只有按尺寸重新绘制才能得到的东西。
 */
function strokeBoost(size) {
  if (size <= 20) return 1.18
  if (size <= 32) return 1.1
  if (size <= 48) return 1.05
  return 1
}

/**
 * 小尺寸下把整个标记放大，让它占满更多瓷砖。
 *
 * 大尺寸下留白是设计；16px 下留白只是浪费像素 —— 标记只占一半宽度时，
 * 锁梁那道弧不到 4 个像素，怎么加粗都是一团灰。
 * 系统图标集在不同尺寸下画的本来就不是同一张图，这是其中最要紧的一条。
 */
function markScale(size) {
  if (size <= 20) return 1.3
  if (size <= 32) return 1.18
  if (size <= 48) return 1.08
  return 1
}

// --- 光栅化 -----------------------------------------------------------------

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ]
}

/** 距离 → 覆盖率。半像素过渡带，抗锯齿不靠超采样。 */
function coverage(d) {
  return Math.min(Math.max(0.5 - d, 0), 1)
}

function render(size) {
  const boost = strokeBoost(size)
  const scale = markScale(size)
  const pixels = Buffer.alloc(size * size * 4)

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5
      const py = y + 0.5

      // 底：圆角方块
      const dBg = sdRoundRect(px, py, size / 2, size / 2, size / 2, size / 2, CORNER * size)
      const bgAlpha = coverage(dBg)

      // 极轻的纵向渐变，给一点体积感。小尺寸下看不出来，也不碍事。
      const base = mix(BASE_TOP, BASE, y / Math.max(size - 1, 1))

      // 标记：锁梁 + 锁体。小尺寸下先整体放大，再补线宽。
      // 缩放靠把采样点朝中心拉回来实现，距离再乘回去 —— SDF 的标准做法。
      const mx = (px - size / 2) / scale + size / 2
      const my = (py - size / 2) / scale + size / 2
      const grow = ((boost - 1) * SHACKLE_W * size) / 2
      const dMark =
        scale * Math.min(sdShackle(mx, my, size), sdBars(mx, my, size)) - grow
      const markAlpha = coverage(dMark) * bgAlpha // 不许溢出圆角

      const rgb = mix(base, CANVAS, markAlpha)
      const offset = (y * size + x) * 4
      pixels[offset] = rgb[0]
      pixels[offset + 1] = rgb[1]
      pixels[offset + 2] = rgb[2]
      pixels[offset + 3] = Math.round(bgAlpha * 255)
    }
  }

  return pixels
}

// --- PNG 编码 ---------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.writeUInt8(8, 8) // 位深
  ihdr.writeUInt8(6, 9) // RGBA
  ihdr.writeUInt8(0, 10)
  ihdr.writeUInt8(0, 11)
  ihdr.writeUInt8(0, 12)

  // 每行前面加一个 filter 字节（0 = None）。
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// --- ICO 打包 ---------------------------------------------------------------

/**
 * ICO 容器。每一项直接装 PNG（Vista 起支持），不用 BMP ——
 * 目标是 Windows 10/11，而 PNG 省掉了 BMP 那套上下颠倒 + AND 掩码的麻烦。
 */
function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: 1 = 图标
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = header.length + dir.length

  entries.forEach((entry, index) => {
    const at = index * 16
    // 256 要写成 0 —— 这个字段只有一个字节。
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, at)
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1)
    dir.writeUInt8(0, at + 2) // 调色板色数
    dir.writeUInt8(0, at + 3) // reserved
    dir.writeUInt16LE(1, at + 4) // 颜色平面
    dir.writeUInt16LE(32, at + 6) // 位深
    dir.writeUInt32LE(entry.png.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

// --- 出图 -------------------------------------------------------------------

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

mkdirSync(join(ROOT, 'build'), { recursive: true })

const entries = ICO_SIZES.map((size) => ({ size, png: encodePng(size, render(size)) }))
const ico = encodeIco(entries)
writeFileSync(join(ROOT, 'build', 'icon.ico'), ico)

// Linux 的 AppImage 要一张 512 的 PNG。
const png512 = encodePng(512, render(512))
writeFileSync(join(ROOT, 'build', 'icon.png'), png512)

/**
 * 目视复核用的对照表。
 *
 * 图标好不好，只看 256 那张是判断不了的 —— 真正会天天见到的是任务栏和
 * 标题栏里的 16~32px。这张表把小尺寸按整数倍放大（最近邻，看得见每个像素），
 * 并且**在浅色和深色两种底色上各铺一遍**：任务栏底色两种都有，
 * 一个只在深色上好看的图标等于只做了一半。
 */
function buildSheet() {
  const zoom = 6
  const shown = [16, 24, 32, 48]
  const pad = 12
  const strips = [
    [0xf6, 0xf6, 0xf3], // 浅色任务栏
    [0x1b, 0x1b, 0x1b] // 深色任务栏
  ]

  const rowH = Math.max(...shown) * zoom + pad * 2
  const width = shown.reduce((sum, sz) => sum + sz * zoom + pad, pad)
  const height = rowH * strips.length
  const out = Buffer.alloc(width * height * 4)

  strips.forEach((bg, row) => {
    const top = row * rowH
    for (let y = 0; y < rowH; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const o = ((top + y) * width + x) * 4
        out[o] = bg[0]
        out[o + 1] = bg[1]
        out[o + 2] = bg[2]
        out[o + 3] = 255
      }
    }

    let cursor = pad
    for (const sz of shown) {
      const src = render(sz)
      const drawn = sz * zoom
      const oy = top + pad + (Math.max(...shown) * zoom - drawn) / 2
      for (let y = 0; y < drawn; y += 1) {
        for (let x = 0; x < drawn; x += 1) {
          // 最近邻：要看的就是像素本身，不是插值之后的样子。
          const si = (Math.floor(y / zoom) * sz + Math.floor(x / zoom)) * 4
          const a = src[si + 3] / 255
          const o = ((oy + y) * width + (cursor + x)) * 4
          out[o] = Math.round(bg[0] * (1 - a) + src[si] * a)
          out[o + 1] = Math.round(bg[1] * (1 - a) + src[si + 1] * a)
          out[o + 2] = Math.round(bg[2] * (1 - a) + src[si + 2] * a)
          out[o + 3] = 255
        }
      }
      cursor += drawn + pad
    }
  })

  return encodePng2(width, height, out)
}

/** 和 encodePng 一样，但允许非正方形。 */
function encodePng2(w, h, pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.writeUInt8(8, 8)
  ihdr.writeUInt8(6, 9)
  const raw = Buffer.alloc(h * (w * 4 + 1))
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 4 + 1)] = 0
    pixels.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// 供目视复核：各尺寸单独出一张，放 out/ 不进版本库。
mkdirSync(join(ROOT, 'out', 'icon-preview'), { recursive: true })
for (const entry of entries) {
  writeFileSync(join(ROOT, 'out', 'icon-preview', `icon-${entry.size}.png`), entry.png)
}

console.log(`build/icon.ico  ${ICO_SIZES.join('/')} 共 ${(ico.length / 1024).toFixed(1)} KiB`)
console.log(`build/icon.png  512×512  ${(png512.length / 1024).toFixed(1)} KiB`)
writeFileSync(join(ROOT, 'out', 'icon-preview', 'sheet.png'), buildSheet())
console.log(`out/icon-preview/  各尺寸单张 + sheet.png（放大对照，浅/深两种底色）`)
