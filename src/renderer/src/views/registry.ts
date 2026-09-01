/**
 * 视图注册表：导航、面包屑和路由用的是同一份定义。
 *
 * 五个视图对应开发计划 §5.1 的主导航。原型只做了前四个，
 * 「设置」是阶段 0 补的 —— 它承载真实的系统状态，是这一阶段唯一能看见后端的地方。
 */

export const VIEWS = [
  { id: 'overview', label: '配置总览', icon: '▦' },
  { id: 'credentials', label: '模型凭据', icon: '⌁' },
  { id: 'security', label: '安全检查', icon: '◇' },
  { id: 'activity', label: '操作记录', icon: '↺' },
  { id: 'settings', label: '设置', icon: '⚙' }
] as const

export type ViewId = (typeof VIEWS)[number]['id']

export function viewLabel(id: ViewId): string {
  return VIEWS.find((view) => view.id === id)?.label ?? ''
}
