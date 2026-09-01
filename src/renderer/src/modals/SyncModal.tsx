import type { ReactNode } from 'react'
import type { EnvFileView } from '@shared/ipc'

interface SyncModalProps {
  close(): void
  files: EnvFileView[]
  onOpenDiff(file: EnvFileView): void
}

/**
 * 「待处理的文件差异」列表，对应开发计划 §6.3：先看差异，再确认范围，最后原子写入。
 *
 * 这里**不自己做写回**，只是把需要处理的文件列出来，点进去走 §6.4 的决策流程
 * （`DiffModal`）。理由是写回的方向必须逐文件选：同一次「同步」里，
 * 一个文件可能该以磁盘为准、另一个该以中心记录为准，
 * 一个总的「确认同步」按钮没法表达这件事，只能替用户猜一个方向。
 *
 * 文件已经从磁盘消失时不给差异入口 —— 无从对比，
 * 给一个点开就报错的按钮不如不给（和「文件健康度」那一列一致）。
 */
export function SyncModal({ close, files, onOpenDiff }: SyncModalProps): ReactNode {
  const drifted = files.filter((file) => file.drifted)

  if (drifted.length === 0) {
    return (
      <>
        <p className="modal-copy">
          所有纳管文件的哈希都与记录一致，没有需要处理的差异。
        </p>
        <div className="modal-actions">
          <button type="button" className="primary-btn" onClick={close}>
            关闭
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <p className="modal-copy">
        {drifted.length} 个文件与中心记录不一致。逐个打开可以看到变量级的前后对比，
        再选择用哪一边覆盖哪一边 —— 写入是原子的，动手前会自动备份原文件。
      </p>
      <div className="diff-list">
        {drifted.map((file) => (
          <div className="diff-row" key={file.id}>
            <span className="diff-state">{file.currentHash === null ? '已丢失' : '有改动'}</span>
            <div>
              <div className="diff-key">{file.relativePath}</div>
              <div className="diff-value">
                {file.currentHash === null
                  ? '文件已从磁盘消失，无从对比'
                  : `内容已变化 · 记录中 ${file.entryCount} 项`}
              </div>
            </div>
            {file.currentHash === null ? (
              <span className="diff-state">—</span>
            ) : (
              <button className="outline-btn tiny" onClick={() => onOpenDiff(file)}>
                查看差异
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" className="outline-btn" onClick={close}>
          稍后处理
        </button>
      </div>
    </>
  )
}
