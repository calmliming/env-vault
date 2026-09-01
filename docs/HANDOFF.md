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
| 2 通用配置工作台 | ✅ | [PHASE-2.md](PHASE-2.md) |
| 3 模型凭据库 | ⬜ 未开始 | — |
| 4 安全中心与轮换 | ⬜ 未开始 | — |
| 5 CLI 与高级集成 | ⬜ 未开始 | — |

**能用的功能**：选目录 → 扫描预览 → 勾选文件导入 → 加密入库 → 分环境查看/搜索 →
点开显示敏感值（留痕）→ 文件被外部改动时自动提醒 → 逐变量看差异 →
选择「以磁盘为准」或「以中心记录为准」（原子写回 + 自动备份）→
就地编辑或删除单个变量（同样是原子写回 + 备份 + 并发校验）。

**界面上诚实标注为"尚未接入"的**：模型凭据（阶段 3）、Git 风险扫描（阶段 4）、
剪贴板定时清理（阶段 4）。这些地方的表单/空态是有的，点了只会弹一条如实说明的 toast，
**没有任何地方假装完成了实际没做的事** —— 请保持这条。

## 2. 先跑一遍

```powershell
pnpm dev       # 开发模式，Vite HMR + Electron
pnpm verify    # 全套：86 单元测试 + 94 核心断言 + 58 界面断言，约 1 分钟
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
    migrations.ts    迁移定义，append-only，当前 v4
    migrator.ts      PRAGMA user_version 做版本游标
    repositories.ts  全部数据访问 + 明文加解密边界
  env/               ⚠️ 这个目录有特殊约定，见 §5
    document.ts      保格式的 .env 解析/写回/删行 + 格式骨架
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

**七处操作会改变监听集合**（导入 / 移除 / 重扫 / 以磁盘为准 / 以记录为准 /
编辑变量 / 删除变量），每一处都要调 `refreshWatchTargets()`。
漏掉的后果是静默的：监听器还活着，但拿旧哈希去比新文件。

**写盘的三条路径共用同一道并发关**（`filesRestore` / `entriesUpdate` /
`entriesDelete`）：`expectedHash` 必须由**调用方**传入，语义是「我这个决定
是基于哪个版本做的」。IPC 层的 `asFileHash` 只接受 64 位十六进制串，
不接受「没传就跳过校验」。理由见 PHASE-2 §5 —— 现算的哈希拿去和现算的哈希比，
守卫永远不可能触发。

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
把明文铺上去等于绕过了 reveal 的审计。编辑框也守同一条：敏感项默认盲写，
点开编辑不等于看见值；已经点过「显示」的才预填（那次 reveal 已经留痕）。

**🔴 `config_entries` 里只有 `encrypted_value` 是加密的，别的列一个都不能放值。**
这条是踩出来的：`original_format` 从阶段 1 起存的是**完整原始行**，
于是每一把 Key 的明文都躺在库里，而验收那条「明文不落库」只翻了
`encrypted_value` 一列，够不着它。现在存的是「格式骨架」
（`document.formatSkeleton`，值换成 `<value>`），迁移 004 清了存量。详见 PHASE-2 §7。

`verify:core` 的明文断言现在扫**整行的每一列**外加数据库文件的字节（含 `-wal`），
`verify:ui` 有几条断言搜整个页面文本确认没有那些假 Key。加功能时别把它们弄红 ——
也别在给 `config_entries` 加列时忘了这一条。

## 7. 下一步：阶段 3 模型凭据库

阶段 2 的交付项已经全部做完（搜索、筛选、编辑、删除、复制、掩码显示）。
下一刀是计划 §9 阶段 3：把散在各个 `.env` 里的大模型凭据提成独立实体。

表已经在迁移 001 里建好了，一直空着：`model_credentials`（厂商、名称、
endpoint、`encrypted_api_key`、指纹、后四位）和 `credential_bindings`
（凭据 ↔ 项目/环境/变量名）。界面上「模型凭据」页和 `CredentialModal`
的表单也在，目前点了只会弹一条如实说明尚未接入的 toast。

开工前值得先定的几件事：

- **识别厂商靠什么**：值的形状（`sk-ant-`、`AKIA`…）已经在 `classify.ts`
  里有一套，还是另外按变量名（`OPENAI_API_KEY`）猜？两者冲突时听谁的？
- **`credential_bindings.key_variable` 和 `config_entries` 是什么关系**：
  一个变量被提成凭据之后，配置表里还显示它吗？改凭据要不要连带写回那些文件？
  （`UNIQUE (project_id, environment, key_variable)` 已经限定了一个环境里
  同名变量只能绑一次。）
- **`fingerprint` 怎么算**：它要能回答「这两个项目用的是不是同一把 Key」，
  又不能让人从指纹反推出 Key。

`config_entries.id` 在重扫、编辑、删除时都是**稳定的**（只 UPDATE 不重建），
绑定可以安全地指向它 —— 这条不变量是有意维护的，别在阶段 3 破坏它。

## 8. 三条来自踩坑的经验

**一条从来没红过的断言，要么是代码真的对，要么是断言根本够不着它 ——
这两种情况在测试报告上长得一模一样。** 这条在这个仓库里已经踩中两次：

- 阶段 2 的并发守卫写成了摆设：写入前自己重新算一遍磁盘哈希再拿去校验，
  那当然永远相等（PHASE-2 §5）；
- `original_format` 存了整行明文却一直没人发现，因为「明文不落库」那条断言
  只翻了 `encrypted_value` 一列（PHASE-2 §7）。

**判断一条断言有没有用的办法是把 bug 放回去跑一遍。** 两次都是这么确认的：
把泄漏改回原样，老断言依然 PASS，新断言才报出泄漏的列名。
写完一条 🔴 断言就顺手做一次这个动作，成本一分钟。

**验收脚本抓到的失败，先判断是"我的期望写错了"还是"实现写错了"，别急着改期望。**
阶段 1 有两条失败，一条是我算错了数（改期望），另一条是重扫会推翻用户的取消勾选
（真 bug，加了迁移 003）。详见 PHASE-1 §4。

## 9. 提交与推送

仓库已经有 git，当前在 `main`，有远端 `origin`。
用户没明说「推」就不要推。
