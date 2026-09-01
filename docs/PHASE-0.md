# 阶段 0 落地记录：基础设施与产品骨架

对应 `DEVELOPMENT_PLAN.md` §9「阶段 0」。这一节记录**实际做了什么、和计划哪里不一样、怎么复验**。

## 1. 交付对照

| 计划要求 | 状态 | 落在哪 |
| --- | --- | --- |
| Electron + React + TypeScript 工程 | ✅ | `electron.vite.config.ts`、`tsconfig.*.json` |
| 主进程 / Preload / 渲染进程目录与 IPC 约定 | ✅ | `src/main`、`src/preload`、`src/renderer`、`src/shared/ipc.ts` |
| 本地数据库迁移机制 | ✅ | `src/main/db/{driver,migrations,migrator,index}.ts` |
| 系统密钥库读写封装 | ✅ | `src/main/security/{keystore,vault}.ts` |
| 当前 HTML 原型转为组件和路由 | ✅ | `src/renderer/src/**`（原型 `index.html` 原样保留作对照） |

验收标准「应用可以启动、创建本地数据库、锁定/解锁 Vault，并通过最小 IPC 读写健康状态」
在界面上的落点是 **设置 · 系统状态**页：那一页每个数字都来自一次真实 IPC 调用，没有占位常量。

## 2. 与计划的两处偏差

### 2.1 SQLite 驱动：`node:sqlite` 而不是 `better-sqlite3`

计划 §3.1 写的是 `better-sqlite3`。本机装不上：

```
npm error gyp ERR! find VS
npm error gyp ERR! stack Error: Could not find any Visual Studio installation to use
```

Node 24 的 ABI 没有对应的预编译包，回落到源码编译又要求 Visual Studio 构建工具。
改用 Electron 自带的 `node:sqlite`：同样是同步 SQLite，零原生依赖、随 Electron 分发、
不需要 `electron-rebuild`。

差异全部收敛在 `src/main/db/driver.ts` 一个文件里（`exec` / `prepare` / `run` / `get` / `all`
两边形状一致），要换回 `better-sqlite3` 只需重写 `openDatabase`，migrator 和上层一行都不用动。

版本前提：Electron 44 带 Node 24.19，`node:sqlite` 在那里已经**稳定**、不打
`ExperimentalWarning`。在 Node 22（Electron 35~38）上它仍是实验特性，
所以降 Electron 大版本时要重新确认这个模块的状态 —— 适配层就是为那种情况留的。

### 2.2 Electron 二进制走镜像

安装时会从 GitHub Releases 拉 Electron 与 esbuild 的二进制，本机直连超时
（`RequestError: connect ETIMEDOUT 20.205.243.166:443`）。

两件事必须同时做对，否则 `pnpm install` 会**静默卡住**（不报错，只是长时间无输出）：

1. **放行 install 脚本** —— pnpm 11 默认拦截。配置项在 `pnpm-workspace.yaml` 的
   `allowBuilds`（注意不是旧版的 `pnpm.onlyBuiltDependencies`，pnpm 11 已经不读那个了）。
2. **传镜像地址** —— 🔴 **pnpm 不会把 `.npmrc` 里的 `electron_mirror` 传给 install 脚本**，
   必须用环境变量。`.npmrc` 里的那两行只对 npm / npx 生效，留着是为了不退化。

所以在一台干净机器上首次安装要这样跑：

```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/" \
pnpm install
```

装完之后的日常命令都不需要这两个变量。二进制掉了可以用同样的前缀跑 `pnpm rebuild` 补。

## 3. 架构约定

```
src/shared/ipc.ts        通道名、载荷类型、IpcResult 信封 —— 三个进程共用的唯一真源
src/preload/index.ts     只挂白名单方法，没有通用 invoke(channel, payload)
src/main/ipc/index.ts    校验发送方 + 校验入参，异常一律转成 IpcResult 而不跨进程抛
```

新增一条 IPC 能力必须同时改 `shared/ipc.ts` 和 `preload/index.ts`。这道「改两处」的摩擦是有意的：
一个接受通道名当参数的通用 `invoke` 等于把白名单交还给渲染层去自觉遵守，而渲染层是加载页面内容的地方。

安全基线（计划 §3.2）：`nodeIntegration: false` / `contextIsolation: true` / `sandbox: true`，
CSP 用响应头下发（生产策略不含 `unsafe-inline`，`connect-src` 为 `none`），
导航与 `window.open` 全部拦截，权限请求默认全拒。

> ⚠️ `sandbox: true` 要求 Preload 是 CommonJS，所以它被单独打包成 `out/preload/index.cjs`。
> `src/main/window.ts` 里的扩展名不能改回 `.js` / `.mjs`。

### Vault 三态

`uninitialized → unlocked → locked → unlocked`。32 字节随机主密钥经系统密钥库
（Windows DPAPI / macOS Keychain / Linux Secret Service）加密后写入 `vault.key`；
解锁即读回内存，锁定即 `fill(0)` 清零。配置值用 AES-256-GCM 加密，
GCM 的认证标签让手改过的密文直接解不开，而不是安静地吐出乱码。

首版**没有用户口令**，这是有意的：主密钥已由操作系统账户保护，
能读到 `vault.key` 的攻击者通常已经能读到用户目录下的 `.env*` 原文，
再加一层口令只会引入「忘记口令等于丢全部配置」的新失败模式。
密钥文件头预留了版本字段，阶段 4 要加口令时作为第二层包装即可。

🔴 Linux 上 `safeStorage` 无桌面环境会降级到 `basic_text`，那是硬编码密钥的混淆而非加密。
`keystore.isAvailable()` 会拒绝这个后端，界面上也不给创建入口 —— 别为了让 Linux 跑起来而删掉这条。

## 4. 命令

包管理器是 **pnpm**（`packageManager` 字段已锁到 pnpm 11）。

```bash
pnpm dev          # 开发模式，Vite HMR + Electron
pnpm build        # typecheck + 三端打包到 out/
pnpm verify       # build + 核心验收 + 界面/IPC 验收（共 47 条断言）
pnpm verify:core  # 在真实 Electron 运行时里验数据库迁移与 Vault 生命周期（21 条）
pnpm verify:ui    # 启动构建产物，用 CDP 在页面里断言（26 条）并截图到 out/
```

`verify:*` 都用临时 `userData` 目录，不会碰到本机真实的 `envvault.db` 和 `vault.key`。
`verify:ui` 会把 `out/verify-ui-overview.png` 和 `out/verify-ui-settings.png` 留下来供目视复核。

## 5. 这一阶段刻意没做的

- **`.env*` 扫描与解析**（阶段 1）。`src/renderer/src/data/prototype.ts` 里是原型占位数据，
  接入真实扫描后整个文件删掉，不要留一半真一半假。
- **写回文件、差异预览、凭据落库、Git 检查、剪贴板定时清理**（阶段 2~4）。
  相关弹窗的表单结构已经就位，但提交只弹一条如实说明「将在阶段 N 接入」的 toast ——
  没有任何地方假装完成了实际没做的事。
- **打包分发**。`electron-builder` 已装但还没写 `build` 配置，代码签名与自动更新属于发布前检查。

## 6. 一处顺手修的原型缺陷

配置表格的来源列原型给的是 14%，装不下 `.env.development`，标签会溢出去贴到状态列上。
改成 18%（从值列匀出），并给 `.source-tag` 加了省略号兜底 ——
阶段 1 接入真实扫描后来源名只会更长（`.env.test.local` 等）。
除此之外颜色、间距、字号、断点与原型逐条一致。
