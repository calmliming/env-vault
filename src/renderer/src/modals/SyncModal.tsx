import type { FormEvent, ReactNode } from 'react'
import { ModalActions } from '../state/modal'
import type { EnvFileView } from '@shared/ipc'

interface SyncModalProps {
  close(): void
  showToast(message: string): void
  files: EnvFileView[]
}

/**
 * 「写回本地文件」确认框，对应开发计划 §6.3：先看差异，再确认范围，最后原子写入。
 *
 * 阶段 1 能真实给出的只有**文件级**差异（哈希对不上或文件消失）——
 * 变量级 diff 需要把磁盘文件重新解析后与中心记录逐项比对，那是阶段 2。
 * 所以这里列的是真实的文件清单，而不是一组编出来的变量名；
 * 提交按钮也如实说明写回尚未接入。
 */
export function SyncModal({ close, showToast, files }: SyncModalProps): ReactNode {
  const drifted = files.filter((file) => file.drifted)

  function onSubmit(event: FormEvent): void {
    event.preventDefault()
    close()
    showToast('差异确认流程已就绪，变量级 diff 与原子写回将在阶段 2 接入')
  }

  return (
    <form onSubmit={onSubmit}>
      {drifted.length === 0 ? (
        <p className="modal-copy">
          所有纳管文件的哈希都与入库时一致，没有需要处理的差异。
        </p>
      ) : (
        <>
          <p className="modal-copy">
            检测到 {drifted.length} 个文件与中心记录不一致。阶段 2 会在这里展示逐个变量的
            前后对比，并以原子方式写回。
          </p>
          <div className="diff-list">
            {drifted.map((file) => (
              <label className="diff-row" key={file.id}>
                <input type="checkbox" defaultChecked disabled />
                <div>
                  <div className="diff-key">{file.relativePath}</div>
                  <div className="diff-value">
                    {file.currentHash === null
                      ? '文件已从磁盘消失'
                      : `内容已变化 · 记录中 ${file.entryCount} 项`}
                  </div>
                </div>
                <span className="diff-state">
                  {file.currentHash === null ? '已丢失' : '有改动'}
                </span>
              </label>
            ))}
          </div>
          <div className="modal-divider" />
          <label className="check-row">
            <input type="checkbox" defaultChecked disabled />
            同步完成后创建一份可恢复备份
          </label>
        </>
      )}
      <ModalActions cancelText="关闭" submitText="确认同步" onCancel={close} />
    </form>
  )
}
