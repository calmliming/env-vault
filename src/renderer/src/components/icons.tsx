/**
 * 内联 SVG 图标集。
 *
 * ## 为什么是一个文件，不是一个目录
 *
 * Electron 打包没有 tree-shaking 收益，拆成二十个文件只会让「还有没有漏网的
 * 字符图标」这件事没法一眼看完。全应用的图标就这一份清单，改哪个、缺哪个，
 * 读一遍就知道。
 *
 * ## 🔴 两条硬约束
 *
 * 1. **不能有 `style=` 属性。** 生产 CSP 是 `style-src 'self'`（main/index.ts），
 *    内联样式会被直接拦掉，而且不报错、只是不生效。颜色一律 `currentColor`，
 *    尺寸走 `width`/`height` **属性** —— 属性不是 CSS，不受 CSP 管辖。
 * 2. **描边宽度固定 1.5，viewBox 固定 16。** 混用会让同一排按钮里的图标粗细
 *    不一，在 13px 的表格行里非常显眼。LogoMark 是唯一例外（它按应用图标的
 *    归一化坐标走 100 的 viewBox）。
 */

import type { ReactNode } from 'react'

export interface IconProps {
  /** 边长（px）。默认 16，和 `.mini-btn` / `.nav-icon` 的盒子对齐。 */
  size?: number
  className?: string
}

export type IconComponent = (props: IconProps) => ReactNode

/**
 * 所有描边图标共用的外壳。
 * `aria-hidden` 是默认值：图标一律是装饰，语义由外层按钮的 aria-label 承担。
 */
function Svg({
  size = 16,
  className,
  children
}: IconProps & { children: ReactNode }): ReactNode {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

// --- 值列的行内操作 ---------------------------------------------------------

/** 睁眼 —— 值当前是显示的，点一下会隐藏。 */
export const IconEye: IconComponent = (props) => (
  <Svg {...props}>
    <path d="M1.6 8S4.1 3.6 8 3.6 14.4 8 14.4 8 11.9 12.4 8 12.4 1.6 8 1.6 8Z" />
    <circle cx="8" cy="8" r="2" />
  </Svg>
)

/**
 * 闭眼 —— 值当前是隐藏的，点一下会显示。
 *
 * 用「闭着的眼睛 + 睫毛」而不是「眼睛加一道斜杠」：斜杠那版在 16px 下容易被
 * 读成「禁止」，而这里表达的是状态不是禁用。
 */
export const IconEyeOff: IconComponent = (props) => (
  <Svg {...props}>
    <path d="M2 6.9c1.6 2.4 3.6 3.6 6 3.6s4.4-1.2 6-3.6" />
    <path d="M8 10.5v2.2" />
    <path d="M3.7 9.5 2.3 11.4" />
    <path d="M12.3 9.5l1.4 1.9" />
  </Svg>
)

/** 复制 —— 两个错开的圆角矩形，通用的「副本」语义。 */
export const IconCopy: IconComponent = (props) => (
  <Svg {...props}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
  </Svg>
)

/** 行内编辑。 */
export const IconPencil: IconComponent = (props) => (
  <Svg {...props}>
    <path d="M11.2 2.3a1.65 1.65 0 0 1 2.5 2.1L5.4 12.7l-3.1 1 1-3.1z" />
    <path d="M10.4 3.4l2.2 2.2" />
  </Svg>
)

/** 在弹窗里展开 —— 四角向外的箭头。 */
export const IconExpand: IconComponent = (props) => (
  <Svg {...props}>
    <path d="M9.5 2.5h4v4" />
    <path d="M6.5 13.5h-4v-4" />
    <path d="M13.5 2.5 9.2 6.8" />
    <path d="M2.5 13.5 6.8 9.2" />
  </Svg>
)

/** 删除。 */
export const IconTrash: IconComponent = (props) => (
  <Svg {...props}>
    <path d="M2.5 4.3h11" />
    <path d="M6.4 4.3V3a1 1 0 0 1 1-1h1.2a1 1 0 0 1 1 1v1.3" />
    <path d="M3.9 4.3 4.5 13a1 1 0 0 0 1 .9h5a1 1 0 0 0 1-.9l.6-8.7" />
    <path d="M6.8 6.9v4.3" />
    <path d="M9.2 6.9v4.3" />
  </Svg>
)

/** 保存 / 确认。 */
export const IconCheck: IconComponent = (props) => (
  <Svg {...props}>
    <path d="M3 8.4 6.4 11.9 13 4.6" />
  </Svg>
)

/** 取消 / 关闭。 */
export const IconX: IconComponent = (props) => (
  <Svg {...props}>
    <path d="M4 4l8 8" />
    <path d="M12 4l-8 8" />
  </Svg>
)

/** 更多操作 —— 三个点。实心，所以不走描边。 */
export const IconMore: IconComponent = ({ size = 16, className }) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="3.6" cy="8" r="1.25" />
    <circle cx="8" cy="8" r="1.25" />
    <circle cx="12.4" cy="8" r="1.25" />
  </svg>
)

// --- 主导航 -----------------------------------------------------------------

/** 配置总览。 */
export const IconGrid: IconComponent = (props) => (
  <Svg {...props}>
    <rect x="2.4" y="2.4" width="4.7" height="4.7" rx="1" />
    <rect x="8.9" y="2.4" width="4.7" height="4.7" rx="1" />
    <rect x="2.4" y="8.9" width="4.7" height="4.7" rx="1" />
    <rect x="8.9" y="8.9" width="4.7" height="4.7" rx="1" />
  </Svg>
)

/** 模型凭据。 */
export const IconKey: IconComponent = (props) => (
  <Svg {...props}>
    <circle cx="5.2" cy="10.8" r="2.7" />
    <path d="M7.1 8.9 13.2 2.8" />
    <path d="M10.8 5.2l1.8 1.8" />
  </Svg>
)

/** 安全检查。 */
export const IconShield: IconComponent = (props) => (
  <Svg {...props}>
    <path d="M8 2 13 4.1v3.6c0 3.1-2.1 5.4-5 6.3-2.9-.9-5-3.2-5-6.3V4.1z" />
  </Svg>
)

/** 操作记录 —— 回溯的时钟。 */
export const IconHistory: IconComponent = (props) => (
  <Svg {...props}>
    <path d="M2.9 8a5.1 5.1 0 1 0 1.6-3.7" />
    <path d="M2.4 2.6v3.2h3.2" />
    <path d="M8 5.6V8.2l2 1.2" />
  </Svg>
)

/** 设置。 */
export const IconSettings: IconComponent = (props) => (
  <Svg {...props}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.6v1.9" />
    <path d="M8 12.5v1.9" />
    <path d="M14.4 8h-1.9" />
    <path d="M3.5 8H1.6" />
    <path d="M12.5 3.5l-1.3 1.3" />
    <path d="M4.8 11.2l-1.3 1.3" />
    <path d="M12.5 12.5l-1.3-1.3" />
    <path d="M4.8 4.8 3.5 3.5" />
  </Svg>
)

// --- 顶栏与外壳 -------------------------------------------------------------

export const IconSearch: IconComponent = (props) => (
  <Svg {...props}>
    <circle cx="7" cy="7" r="4.4" />
    <path d="M10.3 10.3 13.9 13.9" />
  </Svg>
)

export const IconBell: IconComponent = (props) => (
  <Svg {...props}>
    <path d="M8 1.9a3.9 3.9 0 0 0-3.9 3.9c0 3-1.1 4.1-1.1 4.1h10s-1.1-1.1-1.1-4.1A3.9 3.9 0 0 0 8 1.9z" />
    <path d="M6.5 12.2a1.6 1.6 0 0 0 3 0" />
  </Svg>
)

/** 侧栏展开/收起。面板加一条竖线，是这个动作的通用图形。 */
export const IconSidebar: IconComponent = (props) => (
  <Svg {...props}>
    <rect x="2" y="3" width="12" height="10" rx="1.6" />
    <path d="M6.4 3v10" />
  </Svg>
)

// --- Vault 状态 -------------------------------------------------------------

/** 已锁上。 */
export const IconLock: IconComponent = (props) => (
  <Svg {...props}>
    <rect x="3.2" y="7" width="9.6" height="6.8" rx="1.6" />
    <path d="M5.4 7V4.9a2.6 2.6 0 0 1 5.2 0V7" />
  </Svg>
)

/** 已解锁 —— 锁梁向上翘开，和 IconLock 只差这一笔，状态一眼可辨。 */
export const IconUnlock: IconComponent = (props) => (
  <Svg {...props}>
    <rect x="3.2" y="7" width="9.6" height="6.8" rx="1.6" />
    <path d="M5.4 7V4.9a2.6 2.6 0 0 1 5.2 0" />
  </Svg>
)

// --- 分页 -------------------------------------------------------------------

export const IconChevronLeft: IconComponent = (props) => (
  <Svg {...props}>
    <path d="M10 3.4 5.4 8l4.6 4.6" />
  </Svg>
)

export const IconChevronRight: IconComponent = (props) => (
  <Svg {...props}>
    <path d="M6 3.4 10.6 8 6 12.6" />
  </Svg>
)

export const IconChevronDown: IconComponent = (props) => (
  <Svg {...props}>
    <path d="M3.4 6 8 10.6 12.6 6" />
  </Svg>
)

export const IconChevronUp: IconComponent = (props) => (
  <Svg {...props}>
    <path d="M3.4 10 8 5.4 12.6 10" />
  </Svg>
)

export const IconChevronsLeft: IconComponent = (props) => (
  <Svg {...props}>
    <path d="M7.4 3.4 2.8 8l4.6 4.6" />
    <path d="M13.2 3.4 8.6 8l4.6 4.6" />
  </Svg>
)

export const IconChevronsRight: IconComponent = (props) => (
  <Svg {...props}>
    <path d="M8.6 3.4 13.2 8 8.6 12.6" />
    <path d="M2.8 3.4 7.4 8l-4.6 4.6" />
  </Svg>
)

// --- 品牌标记 ---------------------------------------------------------------

/**
 * 应用标记：**锁体就是 `=`** 的一把挂锁。
 *
 * 🔴 坐标是从 `scripts/make-icon.mjs` 的归一化常量（0..1）乘 100 搬过来的，
 * 两边必须保持一致 —— 侧栏这个和任务栏那个是同一个标记，长得不一样就白做了。
 *
 *   SHACKLE_CY 0.345 → 34.5    SHACKLE_R 0.128 → 12.8    SHACKLE_W 0.058 → 5.8
 *   SHACKLE_LEG_END 0.45 → 45  BAR_X0/X1 → 25.5 / 74.5   BAR_W 0.078 → 7.8
 *   BAR_Y1 0.59 → 59           BAR_Y2 0.775 → 77.5
 *
 * 生成脚本头部记了两条「调过之后才立住」的比例，这里同样成立：
 *   - **锁梁的腿要短**（到 45 就停）。长过半径读出来是拱门，不是挂锁。
 *   - **锁梁和 `=` 之间要留白**。腿的底边 47.9、上面那条杠的顶边 55.1，
 *     留了 7 个单位。贴上去的话上面那条杠会被吸进锁的轮廓，`=` 塌成一条，
 *     整个图案变成「钟」。
 */
export const LogoMark: IconComponent = ({ size = 34, className }) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 100 100"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    aria-hidden="true"
    focusable="false"
  >
    {/* 锁梁：半径 12.8 的半圆 + 两条短腿 */}
    <path d="M37.2 45V34.5a12.8 12.8 0 0 1 25.6 0V45" strokeWidth={5.8} />
    {/* 锁体 —— 两条等长的横杠，就是那个 `=` */}
    <path d="M25.5 59h49" strokeWidth={7.8} />
    <path d="M25.5 77.5h49" strokeWidth={7.8} />
  </svg>
)
