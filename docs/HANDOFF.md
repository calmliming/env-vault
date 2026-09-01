# EnvVault 交接说明

> **新会话请先读这一份，再读你要动的那部分对应的 PHASE 文档。**
> 规格书是 `DEVELOPMENT_PLAN.md`，它是需求的唯一真源；本文件只讲「现在到哪了、
> 有哪些坑、下一步做什么」。

## 0. 一句话

EnvVault 是本地优先的桌面工具，管理散落在各处的 `.env*` 配置和大模型调用凭据。
Electron + React + TypeScript，数据全部留在本机，敏感值加密存储。

## 1. 现在到哪了

| 阶段 | 状态 | 记录 |
| --- | --- | --- |
| 0 基础设施与产品骨架 | ✅ | [PHASE-0.md](PHASE-0.md) |
| 1 项目与 `.env*` 全量扫描 | ✅ | [PHASE-1.md](PHASE-1.md) |
| 2 通用配置工作台 | 🚧 主体完成 | [PHASE-2.md](PHASE-2.md) |
| 3 模型凭据库 | ⬜ 未开始 | — |
| 4 安全中心与轮换 | ⬜ 未开始 | — |
| 5 CLI 与高级集成 | ⬜ 未开始 | — |

**能用的功能**：选目录 → 扫描预览 → 勾选文件导入 → 加密入库 → 分环境查看/搜索 →
点开显示敏感值（留痕）→ 文件被外部改动时自动提醒 → 逐变量看差异 →
选择「以磁盘为准」或「以中心记录为准」（原子写回 + 自动备份）。

**界面上诚实标注为"尚未接入"的**：模型凭据（阶段 3）、Git 风险扫描（阶段 4）、
剪贴板定时清理（阶段 4）。这些地方的表单/空态是有的，点了只会弹一条如实说明的 toast，
**没有任何地方假装完成了实际没做的事** —— 请保持这条。

## 2. 先跑一遍

```powershell
pnpm dev       # 开发模式，Vite HMR + Electron
pnpm verify    # 全套：73 单元测试 + 69 核心断言 + 46 界面断言，约 1 分钟
```

`pnpm verify` 全绿是当前基线。**动任何代码前先跑一次**，确认起点是干净的。

其它命令：

```powershell
pnpm test         # 只跑单元测试（node --test 原生跑 .ts，无需构建）
pnpm build        # typecheck + 三端打包到 out/
pnpm verify:core  # 真实 Electron 运行时里验数据库、Vault、扫描、导入、差异、写回
pnpm verify:ui    # 播种真数据 → 启动真界面 → CDP 断言 → 截图到 out/
```

## 3. 🔴 环境上的坑（这台 Windows 机器）

这四条不是代码问题，但会让你卡住半小时以上：

1. **没有 Visual Studio 构建工具**，任何要 node-gyp 编译的原生包都装不上。
   所以 SQLite 用的是 Electron 自带的 `node:sqlite` 而不是计划书写的 `better-sqlite3`
   （差异收敛在 `src/main/db/driver.ts` 一个文件，理由见 PHASE-0 §2.1）。
2. **直连 github.com 超时**。Electron / esbuild 的二进制不走 npm registry。
3. **pnpm 不读 `.npmrc` 里的 `electron_mirror`**，必须用环境变量。
   不传的表现是 `pnpm install` **静默卡住**、不报错，很容易误判成网络慢：
   ```powershell
   $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
   pnpm install
   ```
4. **pnpm 11 默认拦 install 脚本**，放行配置在 `pnpm-workspace.yaml` 的 `allowBuilds:`
   （不是旧版的 `pnpm.onlyBuiltDependencies`，写在 package.json 里会被忽略）。

窗口起不来、终端卡在 `start electron app...` 时，先看 `node_modules/electron/dist/` 是不是空的。

## 4. 代码地图

```
src/shared/          三个进程共用的类型
  ipc.ts             IPC 契约：通道名 + 载荷 + IpcResult 信封。唯一真源
  env-types.ts       ValueType / Sensitivity（领域枚举，不依赖 IPC）

src/main/
  index.ts           启动顺序：单实例锁 → ready → CSP → 建库迁移 → IPC → 开窗 → 监听
  window.ts          BrowserWindow + 导航封锁
  ipc/index.ts       通道注册、发送方校验、入参校验、异常转 IpcResult
  watch.ts           纯监听器（不认识数据库和窗口，可单独测）
  watch-service.ts   监听器与数据库/窗口的接线
  db/
    driver.ts        SQLite 适配层（换回 better-sqlite3 只改这一个文件）
    migrations.ts    迁移定义，append-only，当前 v3
    migrator.ts      PRAGMA user_version 做版本游标
    repositories.ts  全部数据访问 + 明文加解密边界
  env/               ⚠️ 这个目录有特殊约定，见 §5
    document.ts      保格式的 .env 解析/写回
    classify.ts      值类型与敏感等级
    scan.ts          目录遍历、哈希
    diff.ts          逐变量对比
    write.ts         原子写入 + 备份
    *.test.ts        单元测试，node --test 直接跑

src/preload/index.ts 白名单桥。没有通用 invoke
src/renderer/src/    React。hooks/useWorkspace.ts 是数据层
index.html           阶段 0 之前的 HTML 原型，留作视觉对照，不参与构建
```

## 5. 不明显的约定（改代码前必读）

**`src/main/env/` 里的 import 必须带 `.ts` 后缀，且不能用 `@shared/*` 别名。**
这些模块要能被 `node --test` 直接跑，而 Node 的 ESM 解析不会替你补扩展名。
其它目录保持无后缀。`tsconfig.node.json` 里为此开了 `allowImportingTsExtensions`。

**`src/main/env/` 里不能用构造函数参数属性**（`constructor(readonly x: T)`）。
Node 的类型剥离是 strip-only 的，会报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。
写成显式字段赋值。其它目录不受限制。

**新增一条 IPC 能力必须同时改 `shared/ipc.ts` 和 `preload/index.ts`。**
这道「改两处」的摩擦是有意的：一个接受通道名当参数的通用 `invoke` 等于把白名单
交还给渲染层去自觉遵守，而渲染层是加载页面内容的地方。

**Preload 是 CommonJS，输出 `index.cjs`。** `sandbox: true` 的窗口不支持 ESM preload。
`window.ts` 里的扩展名不能改回 `.js`。

**窗口级零滚动条是一条四层链**：`html/body overflow:hidden` → `.app-shell height:100dvh` →
`.main min-height:0` → `.main-scroll overflow-y:auto`。那两处 `min-height: 0` 最容易被
"顺手删掉"，删了滚动条就冒回窗口、顶栏跟着内容滚走。`global.css` 里注释成了一条，
`verify:ui` 有四条断言守着。

**五处操作会改变监听集合**（导入 / 移除 / 重扫 / 以磁盘为准 / 以记录为准），
每一处都要调 `refreshWatchTargets()`。漏掉的后果是静默的：监听器还活着，
但拿旧哈希去比新文件。

**生产 CSP 不含 `unsafe-inline`。** 渲染层不要写内联 `style` 字符串，
动态颜色用修饰类或 CSS 变量。

## 6. 🔴 敏感值的边界（改 repositories 或 IPC 时务必守住）

```
磁盘明文 → scan 解析 → vault.encryptValue → SQLite BLOB（只有密文）
        → listEntries 在主进程侧换成掩码占位符  ← 明文到这里止步
        → IPC → 渲染层拿到 ••••••••
```

明文过桥**只发生在 `entries:reveal` 一个通道**，且每次调用都写一条操作记录
（只记 key 名，不记值）。差异面板同样只给掩码 —— 它是一览视图，
把明文铺上去等于绕过了 reveal 的审计。

`verify:core` 有一条断言直接去数据库翻 BLOB 确认没有明文片段，
`verify:ui` 有三条断言搜整个页面文本确认没有那把假 Key。加功能时别把它们弄红。

## 7. 下一步：补上「编辑」和「删除」单个变量

计划 §9 阶段 2 的交付里，搜索/筛选/复制/掩码已经有了，**编辑和删除还没做**。

写回的机器全部就位了（`applyEdits` + 原子写入 + 备份 + 并发校验），
差的只是入口和 IPC。开工前需要先定几个决定：

- 改完是**立刻写盘**还是先只改中心记录、攒着等用户点「同步到文件」？
  （现有的 §6.4 流程是后者的形状，但那是为"外部改动"设计的。）
- 删除变量要不要**同时从文件里删掉那一行**？删行会破坏 `applyEdits` 的
  "只重建改动行"保证，需要给 document.ts 加一个 `removeEntry`。
- 编辑态怎么和掩码共存？点开编辑框是不是等于一次 reveal（要不要留痕）？

这几条会实质影响做法，建议先和用户确认再动手。

## 8. 两条来自踩坑的经验

**一条从来没红过的断言，要么是代码真的对，要么是断言根本够不着它 ——
这两种情况在测试报告上长得一模一样。**
阶段 2 的并发守卫就是这么被写成摆设的：写入前自己重新算一遍磁盘哈希再拿去校验，
那当然永远相等。详见 PHASE-2 §5。

**验收脚本抓到的失败，先判断是"我的期望写错了"还是"实现写错了"，别急着改期望。**
阶段 1 有两条失败，一条是我算错了数（改期望），另一条是重扫会推翻用户的取消勾选
（真 bug，加了迁移 003）。详见 PHASE-1 §4。

## 9. 提交与推送

仓库目前**还没有 git**（`git status` 报 not a repository）。
需要初始化时问过用户再做。用户没明说「推」就不要推。
