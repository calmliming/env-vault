/**
 * 列表分页条。变量表和操作记录共用一个。
 *
 * 两边的数据来源不一样（变量表全量在内存里切片，操作记录走后端 offset），
 * 但**呈现和交互完全一致**，所以这里只管展示：拿到当前页、总数、每页条数，
 * 回调给上层。它自己不知道数据从哪来，也不该知道。
 *
 * 「第 X–Y 条 / 共 N 条」比单纯的页码更有用：用户想知道的是「还有多少没看」，
 * 而不是「这是第几页」。总数为 0 时整个组件不渲染 —— 空列表下面挂一条
 * 「第 0–0 条 / 共 0 条」是噪音。
 */

import type { ReactNode } from 'react'
import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight
} from './icons'

interface PaginationProps {
  /** 1 起。 */
  page: number
  pageSize: number
  total: number
  pageSizeOptions: readonly number[]
  onPageChange(page: number): void
  onPageSizeChange(size: number): void
  /** 用于 aria-label 和 id，两个列表同页时不会串。 */
  label: string
}

export function Pagination({
  page,
  pageSize,
  total,
  pageSizeOptions,
  onPageChange,
  onPageSizeChange,
  label
}: PaginationProps): ReactNode {
  if (total === 0) return null

  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  // 上层理应把 page 钳制好，这里再夹一次：算区间的除法不能建立在越界的页码上。
  const current = Math.min(Math.max(page, 1), pageCount)
  const from = (current - 1) * pageSize + 1
  const to = Math.min(current * pageSize, total)

  const first = current <= 1
  const last = current >= pageCount

  return (
    <div className="pagination">
      <div className="pagination-range">
        第 {from}–{to} 条 · 共 {total} 条
      </div>

      <div className="pagination-controls">
        <label className="pagination-size">
          每页
          <select
            value={pageSize}
            aria-label={`${label}每页条数`}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>

        <div className="pagination-pager">
          <button
            className="mini-btn"
            data-action="page-first"
            disabled={first}
            title="第一页"
            aria-label={`${label}第一页`}
            onClick={() => onPageChange(1)}
          >
            <IconChevronsLeft />
          </button>
          <button
            className="mini-btn"
            data-action="page-prev"
            disabled={first}
            title="上一页"
            aria-label={`${label}上一页`}
            onClick={() => onPageChange(current - 1)}
          >
            <IconChevronLeft />
          </button>
          <span className="pagination-page" aria-live="polite">
            {current} / {pageCount}
          </span>
          <button
            className="mini-btn"
            data-action="page-next"
            disabled={last}
            title="下一页"
            aria-label={`${label}下一页`}
            onClick={() => onPageChange(current + 1)}
          >
            <IconChevronRight />
          </button>
          <button
            className="mini-btn"
            data-action="page-last"
            disabled={last}
            title="最后一页"
            aria-label={`${label}最后一页`}
            onClick={() => onPageChange(pageCount)}
          >
            <IconChevronsRight />
          </button>
        </div>
      </div>
    </div>
  )
}
