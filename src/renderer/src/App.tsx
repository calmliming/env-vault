import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { Sidebar } from './components/Sidebar'
import { Topbar } from './components/Topbar'
import { useAppHealth } from './hooks/useAppHealth'
import { useCredentials } from './hooks/useCredentials'
import { useWorkspace } from './hooks/useWorkspace'
import { bridge } from './lib/api'
import { BindCredentialModal } from './modals/BindCredentialModal'
import { CredentialModal } from './modals/CredentialModal'
import { CredentialSyncModal } from './modals/CredentialSyncModal'
import { DeleteEntryModal } from './modals/DeleteEntryModal'
import { DiffModal } from './modals/DiffModal'
import { NoticeModal } from './modals/NoticeModal'
import { ProjectModal } from './modals/ProjectModal'
import { SearchModal } from './modals/SearchModal'
import { SyncModal } from './modals/SyncModal'
import { ModalProvider, useModal } from './state/modal'
import { ToastProvider, useToast } from './state/toast'
import { CredentialsView } from './views/CredentialsView'
import { OverviewView } from './views/OverviewView'
import { SettingsView } from './views/SettingsView'
import { ActivityView, SecurityView } from './views/SimpleViews'
import type { ViewId } from './views/registry'
import type {
  ConfigEntryView,
  CredentialSuggestion,
  CredentialSummary,
  EnvFileView
} from '@shared/ipc'

export function App(): ReactNode {
  return (
    <ToastProvider>
      <ModalProvider>
        <Workspace />
      </ModalProvider>
    </ToastProvider>
  )
}

function Workspace(): ReactNode {
  const { showToast } = useToast()
  const { openModal } = useModal()
  const { health, error, loading, refresh } = useAppHealth()
  const workspace = useWorkspace(health?.vault ?? null)
  const credentials = useCredentials(health?.vault ?? null)

  const [activeView, setActiveView] = useState<ViewId>('overview')
  const [query, setQuery] = useState('')
  const [vaultBusy, setVaultBusy] = useState(false)

  /**
   * Vault 按钮按当前状态派发三种动作。
   * 每次动作后都重新拉一次 health，而不是拿返回值就地改本地 state ——
   * 状态的真源在主进程，本地缓存只会在失败路径上跟它分叉。
   * health 变化又会驱动 useWorkspace 重新拉数据，所以解锁后表格会自己填上。
   */
  const runVaultAction = useCallback(async () => {
    const state = health?.vault.state
    if (!state || vaultBusy) return

    setVaultBusy(true)
    const result =
      state === 'unlocked'
        ? await bridge.lockVault()
        : state === 'locked'
          ? await bridge.unlockVault()
          : await bridge.initializeVault()
    await refresh()
    setVaultBusy(false)

    if (!result.ok) {
      showToast(result.message)
      return
    }
    showToast(
      result.data.state === 'unlocked'
        ? state === 'uninitialized'
          ? '本地 Vault 已创建并解锁'
          : 'Vault 已解锁'
        : 'Vault 已锁定，内存中的主密钥已清除'
    )
  }, [health, vaultBusy, refresh, showToast])

  const openProject = useCallback(() => {
    openModal({
      kicker: '项目接入',
      title: '添加一个项目',
      render: ({ close }) => (
        <ProjectModal
          close={close}
          showToast={showToast}
          onImported={(projectId) => {
            void workspace.reloadProjects(projectId)
            setActiveView('overview')
          }}
        />
      )
    })
  }, [openModal, showToast, workspace])

  /**
   * 凭据相关的四个入口。
   *
   * 每一个在成功之后都要重拉**两处**：凭据列表（绑定数、指纹变了）和
   * 当前工作区（配置表里的「由凭据管理」标记跟着绑定走）。
   * 漏掉后者的后果是静默的 —— 表格里那一行还显示可编辑，点下去才被主进程拒绝。
   */
  const refreshAfterCredentialChange = useCallback(async () => {
    await credentials.reload()
    await workspace.reloadCurrent()
  }, [credentials, workspace])

  const openCredential = useCallback(
    (suggestion?: { projectId: number; suggestion: CredentialSuggestion }) => {
      openModal({
        kicker: '模型凭据',
        title: suggestion ? '从变量提取凭据' : '新增调用凭据',
        render: ({ close }) => (
          <CredentialModal
            close={close}
            showToast={showToast}
            providers={credentials.providers}
            {...(suggestion ? { suggestion } : {})}
            onSaved={() => void refreshAfterCredentialChange()}
          />
        )
      })
    },
    [openModal, showToast, credentials.providers, refreshAfterCredentialChange]
  )

  const openRotate = useCallback(
    (credential: CredentialSummary) => {
      openModal({
        kicker: '凭据轮换',
        title: `轮换 ${credential.credentialName} 的 Key`,
        render: ({ close }) => (
          <CredentialModal
            close={close}
            showToast={showToast}
            providers={credentials.providers}
            rotating={credential}
            onSaved={() => void refreshAfterCredentialChange()}
          />
        )
      })
    },
    [openModal, showToast, credentials.providers, refreshAfterCredentialChange]
  )

  const openBind = useCallback(
    (credential: CredentialSummary) => {
      openModal({
        kicker: '凭据绑定',
        title: `绑定 ${credential.credentialName}`,
        render: ({ close }) => (
          <BindCredentialModal
            close={close}
            showToast={showToast}
            credential={credential}
            projects={workspace.projects}
            onBound={() => void refreshAfterCredentialChange()}
          />
        )
      })
    },
    [openModal, showToast, workspace.projects, refreshAfterCredentialChange]
  )

  const openCredentialSync = useCallback(
    (credential: CredentialSummary) => {
      openModal({
        kicker: '一改多同步',
        title: `同步 ${credential.credentialName}`,
        render: ({ close }) => (
          <CredentialSyncModal
            close={close}
            showToast={showToast}
            credential={credential}
            onSynced={() => void refreshAfterCredentialChange()}
          />
        )
      })
    },
    [openModal, showToast, refreshAfterCredentialChange]
  )

  const deleteCredential = useCallback(
    async (credential: CredentialSummary) => {
      const result = await bridge.deleteCredential(credential.id)
      if (!result.ok) {
        showToast(result.message)
        return
      }
      await refreshAfterCredentialChange()
      showToast(`已删除凭据 ${credential.credentialName}；磁盘上的 .env 文件未改动`)
    },
    [showToast, refreshAfterCredentialChange]
  )

  const openDiff = useCallback(
    (file: EnvFileView) => {
      openModal({
        kicker: '外部修改',
        title: '选择处理方向',
        render: ({ close }) => (
          <DiffModal
            close={close}
            showToast={showToast}
            file={file}
            onResolved={() => {
              // 两个方向都会同时改动记录和/或磁盘，条目与文件都要重拉。
              void workspace.reloadCurrent()
              void workspace.reloadProjects(workspace.selectedProject?.id)
              workspace.acknowledgeChanges()
            }}
          />
        )
      })
    },
    [openModal, showToast, workspace]
  )

  const openDeleteEntry = useCallback(
    (entry: ConfigEntryView, expectedHash: string) => {
      openModal({
        kicker: '删除变量',
        title: `删除 ${entry.key}`,
        render: ({ close }) => (
          <DeleteEntryModal
            close={close}
            showToast={showToast}
            entry={entry}
            expectedHash={expectedHash}
            onDeleted={() => {
              // 条目没了、文件内容变了、项目的变量计数也变了，三样都要重拉。
              void workspace.reloadCurrent()
              void workspace.reloadProjects(workspace.selectedProject?.id)
            }}
          />
        )
      })
    },
    [openModal, showToast, workspace]
  )

  const openSync = useCallback(() => {
    openModal({
      kicker: '外部修改',
      title: '待处理的文件差异',
      render: ({ close }) => (
        // 点进某个文件就换成差异面板：写回方向必须逐文件选，
        // openModal 是单例状态，直接替换掉当前描述符即可。
        <SyncModal close={close} files={workspace.files} onOpenDiff={openDiff} />
      )
    })
  }, [openModal, workspace.files, openDiff])

  const openSearch = useCallback(() => {
    openModal({
      kicker: '快速定位',
      title: '搜索配置',
      render: ({ close }) => (
        <SearchModal
          close={close}
          showToast={showToast}
          applyQuery={(next) => {
            // 搜索永远落在配置总览：那是唯一有变量表格的视图。
            setActiveView('overview')
            setQuery(next)
          }}
        />
      )
    })
  }, [openModal, showToast])

  const openNotices = useCallback(() => {
    openModal({
      kicker: '通知中心',
      title: '最近提醒',
      render: ({ close }) => (
        <NoticeModal
          close={close}
          vault={health?.vault ?? null}
          project={workspace.selectedProject}
          files={workspace.files}
        />
      )
    })
  }, [openModal, health, workspace.selectedProject, workspace.files])

  return (
    <div className="app-shell">
      <Sidebar
        activeView={activeView}
        onSelectView={setActiveView}
        projects={workspace.projects}
        selectedProjectId={workspace.selectedProject?.id ?? null}
        onSelectProject={workspace.selectProject}
        vault={health?.vault ?? null}
        vaultBusy={vaultBusy}
        onVaultAction={() => void runVaultAction()}
      />

      <main className="main">
        <Topbar
          activeView={activeView}
          onOpenSearch={openSearch}
          onOpenNotices={openNotices}
          onAddProject={openProject}
        />

        {/*
          滚动必须发生在这一层，不能落到 document 上：
          桌面窗口出现整页滚动条时，顶栏会跟着内容一起滚走，
          而顶栏是常驻操作区。CSS 里 .app-shell → .main → .main-scroll
          三层的 min-height:0 / overflow 是一条链，改任意一层前先读那段注释。
        */}
        <div className="main-scroll">
          {activeView === 'overview' && (
            <OverviewView
              workspace={workspace}
              query={query}
              onQueryChange={setQuery}
              onAddProject={openProject}
              onOpenSync={openSync}
              onOpenDiff={openDiff}
              onDeleteEntry={openDeleteEntry}
              onExtractCredential={(suggestion) =>
                workspace.selectedProject &&
                openCredential({ projectId: workspace.selectedProject.id, suggestion })
              }
              onVaultAction={() => void runVaultAction()}
              showToast={showToast}
            />
          )}
          {activeView === 'credentials' && (
            <CredentialsView
              store={credentials}
              onAddCredential={() => openCredential()}
              onRotate={openRotate}
              onBind={openBind}
              onSync={openCredentialSync}
              onDelete={(credential) => void deleteCredential(credential)}
              onVaultAction={() => void runVaultAction()}
              showToast={showToast}
            />
          )}
          {activeView === 'security' && (
            <SecurityView project={workspace.selectedProject} files={workspace.files} />
          )}
          {activeView === 'activity' && <ActivityView />}
          {activeView === 'settings' && (
            <SettingsView
              health={health}
              error={error}
              loading={loading}
              vaultBusy={vaultBusy}
              onRefresh={() => void refresh()}
              onVaultAction={() => void runVaultAction()}
            />
          )}
        </div>
      </main>
    </div>
  )
}
