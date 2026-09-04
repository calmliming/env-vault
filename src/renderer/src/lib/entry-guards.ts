/**
 * 「这一条现在能不能改」的判断。
 *
 * 从 OverviewView 抽出来，是因为阶段 7 之后有**两个**编辑入口：表格里的行内
 * 编辑，和值列那个弹窗。两处必须用同一套守卫 —— 各留一份的话，改了一边忘了
 * 另一边，就会出现「行内编辑按钮是灰的、弹窗里却能点保存」这种自相矛盾的界面，
 * 而用户只会看到主进程把保存拒了。
 *
 * 🔴 这些**不是**真正的守卫。真守卫在主进程：`requireEditableEntry` 会重新
 * 比对磁盘哈希，`updateEntryValue` 会拒掉归凭据管的条目。这里只负责别把用户
 * 引到一条注定被拒的路上，并且把「为什么不能改」说清楚。
 */

import type { ConfigEntryView, EnvFileView } from '@shared/ipc'

/** 文件 id → 文件记录。调用方用 useMemo 从 workspace.files 建。 */
export type FileIndex = ReadonlyMap<number, EnvFileView>

/**
 * 文件层面挡住写入的原因。编辑和删除都受它约束。
 *
 * 文件有未处理的外部改动时不给写入入口 —— 这时候写回去等于替用户默默选了
 * §6.4 的方向，把别人的修改覆盖掉。正确路径是先去差异面板选一个方向。
 *
 * 注意这和「状态」列的 drifted 是同一件事，但和「归凭据管」不是 ——
 * 三个概念混成一个布尔值的话，一个归凭据管的变量会在状态列里被显示成
 * 「有差异」，而它的文件其实好好的。
 */
export function fileBlockedReason(entry: ConfigEntryView, files: FileIndex): string | null {
  const file = files.get(entry.fileId)
  if (!file) return '找不到这个变量的来源文件记录'
  if (file.currentHash === null) return '来源文件已从磁盘消失'
  if (file.drifted) return '来源文件在外部被改过，请先在「文件健康度」里处理差异'
  return null
}

/**
 * 编辑还多一条限制：🔴 归凭据管的变量真源在凭据那边，就地改会造成两个真源。
 *
 * 删除**不受**这条限制 —— 变量真的要没了是合理的，那时绑定会跟着一起解除。
 */
export function editBlockedReason(entry: ConfigEntryView, files: FileIndex): string | null {
  if (entry.managedBy?.role === 'key') {
    return `由凭据「${entry.managedBy.credentialName}」管理，请到「模型凭据」页修改后同步`
  }
  return fileBlockedReason(entry, files)
}

/**
 * 用户看到这一行时文件的磁盘哈希，作为「我这个决定基于哪个版本」送给主进程。
 *
 * 为 null 表示文件已经不在磁盘上了。主进程要求 expectedHash 必须是 64 位
 * 十六进制，**不接受「缺省 = 跳过检查」**，所以调用方拿到 null 时要挡下来，
 * 而不是随便传个空串。
 */
export function expectedHashOf(entry: ConfigEntryView, files: FileIndex): string | null {
  return files.get(entry.fileId)?.currentHash ?? null
}
