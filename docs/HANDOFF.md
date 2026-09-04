# EnvVault 交接说明

> **新会话请先读这一份，再读你要动的那部分对应的 PHASE 文档。**
> 规格书是 `DEVELOPMENT_PLAN.md`，它是需求的唯一真源；本文件只讲「现在到哪了、
> 有哪些坑、下一步做什么」。
>
> ⚠️ 规格书在**仓库根目录**，不在 `docs/`（`docs/` 下只有交接与阶段记录）。
> 根目录还有 `DEVELOPMENT_PLAN.baseline.md` / `.diff.txt` / `.ROLLBACK.sh` /
> `.VERIFICATION.txt` 四个同名附属文件 —— 那是早前改写规格书时留下的
> 基线、差异和回滚脚本，**已被 `.gitignore` 排除、不参与构建**。
> 只有 `DEVELOPMENT_PLAN.md` 进了版本库，读的时候别拿错。

## 0. 一句话

EnvVault 是本地优先的桌面工具，管理散落在各处的 `.env*` 配置和大模型调用凭据。
Electron + React + TypeScript，数据全部留在本机，敏感值加密存储。

## 1. 现在到哪了

| 阶段 | 状态 | 记录 |
| --- | --- | --- |
| 0 基础设施与产品骨架 | ✅ | [PHASE-0.md](PHASE-0.md) |
| 1 项目与 `.env*` 全量扫描 | ✅ | [PHASE-1.md](PHASE-1.md) |
| 2 通用配置工作台 | ✅ | [PHASE-2.md](PHASE-2.md) |
| 3 模型凭据库 | ✅ | [PHASE-3.md](PHASE-3.md) |
| 4a Git 风险检查 | ✅ | [PHASE-4A.md](PHASE-4A.md) |
| 4b 凭据版本与剪贴板 | ✅ | [PHASE-4B.md](PHASE-4B.md) |
| 5a CLI 注入 | ✅ | [PHASE-5A.md](PHASE-5A.md) |
| 5b `.env.example` 生成 | ✅ | [PHASE-5B.md](PHASE-5B.md) |
| 5c 加密导出与导入导出包 | ✅ | [PHASE-5C.md](PHASE-5C.md) |
| 6 一次纳管多个项目（正确性修复） | ✅ | [PHASE-6.md](PHASE-6.md) |
| 7 打包与发布前检查 | ✅ | [RELEASE.md](../RELEASE.md) |
| C1~C5 界面可用性 | ✅ | 没有单独的阶段文档，见下面 §1.1 |

阶段 4 的验收句本来就是两半，所以拆成了两刀：
「被 Git 跟踪的敏感文件必须显示风险」（4a）+
「轮换旧 Key 时能准确列出受影响的项目和环境」（4b）。两半都已完成。

**MVP 清单（计划 §11）到这里全部成立**；规格 §9「阶段 5」的四项里也只剩
最后一项 —— 外部 Secret Manager 适配，见 §7。

**能用的功能**：选目录 → 扫描预览 → 勾选文件导入 → 加密入库 → 分环境查看/搜索 →
点开显示敏感值（留痕）→ 文件被外部改动时自动提醒 → 逐变量看差异 →
选择「以磁盘为准」或「以中心记录为准」（原子写回 + 自动备份）→
就地编辑或删除单个变量 → 从变量识别并提取模型凭据 → 一个凭据绑定多个项目环境 →
改一次 Key 预览并同步到全部绑定（同样是原子写回 + 备份 + 并发校验）→
向厂商验证一把 Key 现在还能不能用 →
查每个 `.env*` 有没有被 Git 跟踪 / 被 .gitignore 覆盖，并给出风险等级和处置办法 →
看一条凭据换过几代 Key、停用它、轮换前先看清会波及哪些项目 →
复制到剪贴板并在 30 秒后自动清理 →
用 `envvault run -- <命令>` 把一个环境注入子进程，不落盘明文 →
按某份 `.env` 生成一份不含值的 `.env.example`（连注释里被注释掉的 Key 一起擦掉）→
把选中项目加密导出成一个口令保护的包，并在另一台机器上导回来 →
选一个装着多个仓库的目录，一次把它们各自纳管成独立项目 →
变量表按类型筛、按页翻，操作记录同样分页，侧栏收起后下次打开还是收着的 →
值太长时在弹窗里完整地看和改（值列只有三成宽，连接串在那儿读不了）。

**界面上没有任何"尚未接入"的占位了** —— MVP 清单的每一条都真的能用。
**没有任何地方假装完成了实际没做的事**，请保持这条。

### 1.1 C1~C5：界面可用性五刀

阶段 7 打完包之后，把界面上五处「能用但难用」的地方各修了一刀。它们不动数据
模型，也不碰 §6 的明文边界，所以**没有各自的阶段文档** —— 细节写在提交信息里
（那几条都写得比这里细），这张表只负责让你找得到它们。会被后来人顺手改坏的
那几条约定在 §5，不在这儿。

| 刀 | 提交 | 做了什么 |
| --- | --- | --- |
| C1 | `ae6209d` | 图标系统：全应用换成内联 SVG，logo 与打包图标对齐 |
| C2 | `6fe68c9` | 侧栏收起 + 界面偏好持久化（localStorage） |
| C3 | `dc9a00f` | 变量表：分页 + 类型筛选 |
| C4 | `7a1fde0` | 操作记录分页 —— 后端补 `offset` 与总数，两次查询钉在同一个读事务里 |
| C5 | `b975e38` | 值弹窗：长值的第二条查看/写盘入口，守卫抽进 `lib/entry-guards.ts` |

## 2. 先跑一遍

```powershell
pnpm dev       # 开发模式，Vite HMR + Electron
pnpm verify    # 全套：235 单元测试 + 221 核心断言 + 141 界面断言，约 2 分钟
               # 单元测试是 234 通过 + 1 跳过：write.test.ts 的 POSIX 权限位，
               # Windows 上恒跳，skip 里写了理由。这是目前唯一一条跳过，多出来就要查。
               # ⚠️ 这三个数会随每一刀增长，改完记得回来改这里 —— 它们过期时
               # 没有任何东西会报错，而一个"数字对不上"的基线等于没有基线。

# CLI（阶段 5a）。打包后是 EnvVault.exe run --…
electron . run --project fixture --env local -- node -v
electron . run --help
```

> ⚠️ `verify:core` 会在沙箱里 `git init` 一个真仓库（安全检查那一层只有对着
> 真 git 才验得出东西）。**这台机器上必须有 git**，否则那一组会响亮地失败 ——
> 这是故意的，静默跳过的断言和通过的断言在报告上长得一模一样。

> ⚠️ **两条「验的其实是旧产物」的坑，形状完全一样，都在单独跑某一步时中招：**
>
> - `verify:ui` 跑的是 `out/verify/index.mjs` 这个**已构建**的产物，而它由
>   `verify:core` 那一步的 esbuild 生成。只改了 `verify-core.ts` 就直接跑
>   `verify:ui`，用的还是旧包 —— 会看到一堆莫名其妙对不上的失败。
> - CLI 的端到端走的是 `electron .` → package.json 的 main → `out/main/index.js`，
>   那是 `pnpm build` 的产物。**单独跑 `verify:core` 或 `verify:ui` 之前先 `pnpm build`。**
>
> `pnpm verify` 的顺序（test → build → verify:core → verify:ui）本来就是对的，
> 单独跑其中一步时要自己保证产物是新的。产物旧了不会报错，只会安静地验上一版代码。

`pnpm verify` 全绿是当前基线。**动任何代码前先跑一次**，确认起点是干净的。

其它命令：

```powershell
pnpm test         # 只跑单元测试（node --test 原生跑 .ts，无需构建）
pnpm build        # typecheck + 三端打包到 out/
pnpm verify:core  # 真实 Electron 运行时里验数据库、Vault、扫描、导入、差异、写回、凭据
pnpm verify:ui    # 播种真数据 → 启动真界面 → CDP 断言 → 截图到 out/
pnpm package      # electron-builder 出安装器 + 便携版到 release/。见 RELEASE.md
node scripts/make-icon.mjs   # 重新生成 build/icon.ico（改设计改脚本，别改二进制）
```

## 3. 🔴 环境上的坑（这台 Windows 机器）

这七条不是代码问题，但会让你卡住半小时以上：

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
5. **打包需要 Windows 开发者模式**（设置 → 系统 → 开发者选项，已打开）。
   electron-builder 要解压的 `winCodeSign` 工具包里含 macOS 的 dylib 符号链接，
   Windows 上建符号链接需要管理员权限或开发者模式，两样都没有时解压会报
   「客户端没有所需的特权」、整个打包中止。预先手动解压**不管用**
   （失败时它每次解压到新的随机目录）。
   曾经用 `signAndEditExecutable: false` 绕开，代价是 exe 的图标和版本信息写不进去；
   开发者模式打开后那行已删除。**再遇到这个错先查开发者模式，别把那行加回来** ——
   完整来龙去脉在 RELEASE.md「曾经的 `signAndEditExecutable: false`」一节，
   包括一个会误导人的假阴性测法。
6. **`pnpm audit` 要显式指定 `--registry=https://registry.npmjs.org/`**，
   npmmirror 没有 audit 端点。
7. **从编辑器内置终端跑 `verify:core` 会撞上 `ELECTRON_RUN_AS_NODE=1`。**
   VSCode / Cursor 这类编辑器本身就是 Electron 应用，它们给集成终端注入了这个
   环境变量，而它会让 `electron.exe` **退化成一个纯 Node**：
   ```text
   SyntaxError: The requested module 'electron' does not provide an export named 'app'
   ```
   报错指向 `import { app } from "electron"`，看起来像是打包或依赖坏了 ——
   其实一个字节都没问题，`electron` 只是解析到了 npm 那个返回路径字符串的
   CJS 垫片。跑之前先摘掉它（`unset ELECTRON_RUN_AS_NODE` /
   `Remove-Item Env:ELECTRON_RUN_AS_NODE`），或者换一个系统终端。
   ⚠️ 它只打得中 `verify:core`（那一步真的要 Electron 运行时）。
   `pnpm test` 和 `pnpm build` 照样绿，所以很容易误判成"验收脚本坏了"。

窗口起不来、终端卡在 `start electron app...` 时，先看 `node_modules/electron/dist/` 是不是空的。

## 4. 代码地图

```
src/shared/          三个进程共用的类型
  ipc.ts             IPC 契约：通道名 + 载荷 + IpcResult 信封。唯一真源
  env-types.ts       ValueType / Sensitivity（领域枚举，不依赖 IPC）
  provider-types.ts  ValidationOutcome（同上，被 providers/ 和 ipc.ts 共用）
  security-types.ts  RiskLevel + RISK_ORDER（同上，被 git/ 和 ipc.ts 共用）

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
    repositories.ts  项目 / 文件 / 配置项的数据访问 + 明文加解密边界
    credentials.ts   模型凭据与绑定；写盘复用 repositories 的 writeGuarded
    security.ts      安全检查：磁盘扫描 + 库里的敏感度计数 + git 状态 → 风险报告
                     🔴 全程不解密，所以 Vault 锁着也能用
    inject.ts        把一个环境解析成可注入的环境变量。
                     🔴 一次返回整个环境的明文 —— **绝不能上 IPC**，见 §5
    template.ts      `.env.example` 生成的接线（fileId → 读盘 → 写盘 → 留痕）。
                     🔴 全程不解密，锁着也能用；内容由主进程生成，渲染层送不进来
    transfer.ts      加密导出/导入的接线：从库里收集什么、把包里的写回库。
                     🔴 导出是最宽的一条明文出口；导入**只写中心记录不碰磁盘**
  cli/               ⚠️ args.ts 要能被 node --test 跑，约定见 §5
    args.ts          参数解析。🔴 `--` 之后原样交给子命令，不解析
    index.ts         注入并起子进程。🔴 值只经 env 传，不落盘
  clipboard/         ⚠️ index.ts 要能被 node --test 跑，约定见 §5
    index.ts         定时清理的判定。🔴 只清我们写进去的那一份，见 §5
    port.ts          🔴 全应用唯一 import Electron clipboard 的文件
  net/
    transport.ts     🔴 全应用唯一真的碰 socket 的文件。单独一个目录，
                     是为了让「谁会上网」有一个一句话的答案
  transfer/          ⚠️ 同样要能被 node --test 跑，约定见 §5
    package.ts       导出包的格式与口令加解密（scrypt + AES-256-GCM）。
                     🔴 不复用 vault 的 HKDF —— 口令是低熵输入，见 PHASE-5C §2
  git/               ⚠️ 同样要能被 node --test 跑，约定见 §5
    run.ts           🔴 全应用唯一执行外部程序的文件（起 git 子进程）。
                     execFile + 参数数组，固定带 -c core.fsmonitor= 见 §5
    inspect.ts       问 tracked / ignored，解析 -z 输出。runner 可注入
    risk.ts          风险判定表。🔴 unknown ≠ ok，理由见 PHASE-4A §4
  providers/         ⚠️ 同样要能被 node --test 跑，约定见 §5
    index.ts         厂商适配器。🔴 纯函数，不发网络请求
    validate.ts      发请求 + 把响应翻译成结论。传输层是注入的，所以这里
                     跑遍所有分支也不出网。🔴 结论分「有/没有」两类，见 §6
  env/               ⚠️ 这个目录有特殊约定，见 §5
    document.ts      保格式的 .env 解析/写回/删行 + 格式骨架
    discover.ts      从父目录发现多个仓库根（纯函数，只找 .git 不读文件）。
                     🔴 一个项目一个 gitRoot，理由见 PHASE-6 §2
    template.ts      由一份 .env 生成不含值的 .env.example（纯函数）。
                     🔴 注释里的赋值也要脱敏 + 高敏值兜底，见 §5
    classify.ts      值类型与敏感等级
    scan.ts          目录遍历、哈希
    diff.ts          逐变量对比
    write.ts         原子写入 + 备份
    *.test.ts        单元测试，node --test 直接跑

src/preload/index.ts 白名单桥。没有通用 invoke

src/renderer/src/
  App.tsx            视图切换 + 所有弹窗的入口都挂在这里
  hooks/
    useWorkspace.ts  项目、环境、配置项、文件的数据层
    useCredentials.ts 凭据与厂商列表的数据层
  views/             overview（配置表 + 识别建议）/ credentials / settings / SimpleViews
  modals/            差异、删除、凭据新增轮换、绑定、同步预览……
  state/             modal.tsx（单例弹窗宿主）+ toast.tsx
  styles/global.css  视觉系统。改滚动相关的四层链前先读里面那段注释

index.html           阶段 0 之前的 HTML 原型，留作视觉对照，不参与构建
```

## 5. 不明显的约定（改代码前必读）

**`src/main/env/`、`providers/`、`git/`、`transfer/`、`clipboard/index.ts` 和
`cli/args.ts` 里的 import 必须带 `.ts` 后缀，且不能用 `@shared/*` 别名。** 这些模块要能被 `node --test`
直接跑，而 Node 的 ESM 解析不会替你补扩展名。
其它目录保持无后缀。`tsconfig.node.json` 里为此开了 `allowImportingTsExtensions`。

**这几个地方也不能用构造函数参数属性**（`constructor(readonly x: T)`）。
Node 的类型剥离是 strip-only 的，会报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。
写成显式字段赋值。其它目录不受限制（`repositories.ts` 的 `RepositoryError` 就用了）。

**新增一条 IPC 能力必须同时改 `shared/ipc.ts` 和 `preload/index.ts`。**
这道「改两处」的摩擦是有意的：一个接受通道名当参数的通用 `invoke` 等于把白名单
交还给渲染层去自觉遵守，而渲染层是加载页面内容的地方。

**Preload 是 CommonJS，输出 `index.cjs`。** `sandbox: true` 的窗口不支持 ESM preload。
`window.ts` 里的扩展名不能改回 `.js`。

**窗口级零滚动条是一条四层链**：`html/body overflow:hidden` → `.app-shell height:100dvh` →
`.main min-height:0` → `.main-scroll overflow-y:auto`。那两处 `min-height: 0` 最容易被
"顺手删掉"，删了滚动条就冒回窗口、顶栏跟着内容滚走。`global.css` 里注释成了一条，
`verify:ui` 有四条断言守着。

**变量表默认每页 25，别往下调。** `verify:ui` 有三条断言构成了这个数的下限：
解锁后 13 个 key 必须全在、清空搜索后行数回到 13、环境筛选后 0 < n < 12。
页大小小于 13 会让第一页装不下，那三条一起红 —— 而它们验的是数据不是分页，
红起来的样子和真 bug 一模一样。`OverviewView.tsx` 顶部注释成了一条。

**分页的总数和当前页必须在同一个读事务里查。**（C4，`listActivity`）
这个应用几乎每个动作都写一条审计，两次独立查询之间只要写进一条新记录，
用户就会看到「共 94 条」配着按 93 条切出来的数据，最后一页可能是空的。

**🔴 「能不能就地改」的判断只有一份，在 `renderer/lib/entry-guards.ts`。**
行内编辑和值弹窗是**两个**写盘入口，各留一份判断的话，改了一边忘了另一边就会
出现「行内是灰的、弹窗却能点保存」这种自相矛盾的界面，而用户只会看到主进程把
保存拒了。它们不是真守卫（真守卫是 `requireEditableEntry` + `updateEntryValue`），
只负责别把用户引到一条注定被拒的路上。`verify:ui` 有一条断言拿同一个变量
同时问两个入口，结论不一致就红。

**🔴 两个编辑入口保存成功后都要作废 `revealed` 里那份明文。**
值一改，手里那份就是过期的了 —— 留着的话表格会继续把一个磁盘上已经不存在的
旧值当成「已显示」铺出来，而用户没有任何办法看出它是旧的。
弹窗够不着那个 map，所以由 `OverviewView` 把作废动作作为回调交给它。

**值弹窗的按钮是 `data-action="edit-modal"`，不能并回 `"edit"`。**
`verify:ui` 靠 `[data-action="edit"]` 点行内编辑器，并回去会让那一批断言
点到弹窗上。另外这个按钮**故意不禁用**：不可写时也该能打开来看值，
弹窗自己变成只读并说明原因 —— 但来源文件已从磁盘消失时它不开，直接给回执
（`expectedHash` 不接受缺省，那个弹窗里的保存不可能成立）。

**十处操作会改变监听集合**（导入 / 移除 / 重扫 / 以磁盘为准 / 以记录为准 /
编辑变量 / 删除变量 / 凭据同步 / 生成 `.env.example` / 从导出包导入），
每一处都要调 `refreshWatchTargets()`。
漏掉的后果是静默的：监听器还活着，但拿旧哈希去比新文件。

**写盘的四条路径共用同一道并发关**（`filesRestore` / `entriesUpdate` /
`entriesDelete` / `credentialsSync`）：`expectedHash` 必须由**调用方**传入，
语义是「我这个决定是基于哪个版本做的」。IPC 层的 `asFileHash` 只接受
64 位十六进制串，不接受「没传就跳过校验」。理由见 PHASE-2 §5 ——
现算的哈希拿去和现算的哈希比，守卫永远不可能触发。
凭据同步是**每个目标各带一个哈希**：它们是不同的文件，共用一个没有意义。

**`template:write` 的 `expectedTargetHash` 可以是 `null`，那是唯一的例外，
而且它是断言不是旁路。** `null` 的意思是「我预览的时候这个文件不存在」，
主进程用 `openSync(path, 'wx')` **独占创建**来兑现它 —— 不是 `existsSync` 判一下，
后者到写入之间有一个竞态窗口。校验入口是单独的 `asFileHashOrAbsent`，
**没有**去放宽 `asFileHash`：那三条写盘路径的目标一定是已存在的文件，
它们没有「文件不存在」这种合法情形。
创建那条路上不传 expectedHash —— 文件刚由我们独占创建，拿现算的哈希比现算的
哈希永远不可能触发，写一个假守卫比不写更糟。

**凭据绑定按 (项目, 环境, 变量名) 配对，不按 `config_entries.id`。**
重扫和「以磁盘为准」会重建条目 id，按 id 绑的话用户点一次「以磁盘为准」
所有绑定就全失效了，而且不报任何错。

**生产 CSP 不含 `unsafe-inline`。** 渲染层不要写内联 `style` 字符串，
动态颜色用修饰类或 CSS 变量。

**起 git 时固定带 `-c core.fsmonitor=` 和 `--no-optional-locks`。**
仓库本地的 `.git/config` 里 `core.fsmonitor` 的值是一条**会被 git 执行的命令** ——
而这个应用是在用户选的任意目录里跑 git，这是有记录的 RCE 向量。
命令行上的 `-c` 压过仓库配置，堵掉它成本为零。另外一律 `execFile` + 参数数组，
永不 `exec`（路径是用户能控制的内容，交给 shell 解析等于把它当代码）。

**`git check-ignore` 必须带 `--no-index`，退出码 1 不算失败。**
默认它不把已跟踪的文件报成 ignored，于是「已在 .gitignore 里但仍被跟踪」——
整个安全检查最有价值的那条结论 —— 会永远检测不到。退出码 1 的意思是
「你问的这些一个都没被忽略」，当成失败的话，没有 .gitignore 的项目
（最该报警的那种）会整页显示「查不了」。两条都有断言守着，见 PHASE-4A §3、§5。

**🔴 `db/inject.ts` 的 `resolveEnvironment` 绝不能暴露成 IPC 通道。**
它一次返回一个环境里**所有**变量的明文。逐变量 reveal 的审计存在的全部意义，
就是不让这种批量读取悄悄发生。它对 CLI 进程是必要的（子进程要的就是这些值），
但一旦上了 IPC，渲染层就能一次性拿走整个环境，前面几刀在明文边界上的功夫全废。
它的调用方只有一个：`cli/index.ts`，跑在没有窗口也没注册任何 IPC 的进程里。

**CLI 分支必须走在 `requestSingleInstanceLock()` 之前。**
用户开着界面再跑 `envvault run` 是最正常的用法，被锁挡下来的表现是
「命令什么也没做就退出了，而且退出码是 0」—— 脚本里根本看不出出过事。
不取锁是安全的：CLI 只读库，WAL + `busy_timeout` 已经处理了并发。

**🔴 `.env.example` 是唯一一个设计上就要进 Git 的产物，注释也得脱敏。**
`# OPENAI_API_KEY=sk-…` 解析出来是 `comment` 节点，`raw` 里是整行原文，
而 `formatSkeleton` 只作用于 `entry` 节点 —— **够不着它**。行内注释
（`EntryNode.suffix`）走同一条路，只堵整行等于只堵了一半。
更麻烦的是现成的安全网接不住：安全检查页靠 `highCount`，而它只数 entry，
注释里的 Key 不是 entry，于是照样判 `ok`。
`env/template.ts` 里 `redactCommentText` 负责擦，`findLeaks` 负责兜底
（拿源文件的高敏值反查生成结果，命中就拒绝写盘）。详见 PHASE-5B §3、§4。

**🔴 一个项目只存一个 `git_root`，所以一个项目只能是一个仓库。**
`security.ts` 拿它做全部 Git 判断。把多个仓库塞进一个项目，子仓库里的文件会拿
**父仓库**去问跟踪状态 —— 在父仓库看来它们永远「未跟踪」，于是判定表把
「已提交又补进 .gitignore」判成 **ok**（不是报错，是判成安全的）。
`env/discover.ts` 负责发现，`scanProject` 的 `walk()` 负责**在嵌套仓库处停**，
两边缺一不可。详见 PHASE-6。

**🔴 导出是最宽的一条明文出口，导入则一个磁盘文件都不许碰。**
导出一次放走选中项目的**全部值**（勾了凭据还带走全部模型 Key），
所以它没有"不加密"这个选项，凭据默认不勾，口令要输两遍。
导入反过来是**只写中心记录**：要把值落到磁盘，走既有的「以记录为准写回」，
那条路自带备份、并发校验和逐变量确认。在 `applyImport` 里加写盘 =
开一条绕过 §6.4 的新写盘路径，**别为了省一步这么做**。
合并是只增不删，所以导入不等于"恢复到快照那一刻"，界面上直说了。详见 PHASE-5C §4。

**导出包的密码学不复用 vault 那一套。** `deriveSubkey` 是 HKDF，前提是输入已经是
高熵密钥；用户口令是低熵输入，必须走带 salt 和工作因子的 KDF（scrypt，
因为这台机器装不了 Argon2）。也不能拿主密钥派生 —— 那样的包只有本机能解，
而换机器/备份正是导出的用途。详见 PHASE-5C §2。

**模板生成不解密，别给它加 `requireUnlocked()`。** 源头是磁盘上的 `.env`
（中心记录里根本没存注释），所以锁着也能用 —— 和 `db/security.ts` 一个性质。
`verify:core` 有一条断言是在 `vault.lock()` **之后**跑的，专门守这个。

**起子进程时不许开 shell。** 开了的话 cmd.exe 会重新解析参数，
`node -e "if (a) …"` 里的引号和括号会被静默搅乱。Windows 上的 `.cmd`
（npm / pnpm）由 `resolveExecutable` 换成显式的 `cmd.exe /d /s /c`，
参数仍逐个传给 spawn。详见 PHASE-5A §6。

**剪贴板清理必须先比对哈希，不许无条件 `clear()`。**
用户很可能在这 30 秒里复制了别的东西，无条件清会**毁掉他的剪贴板** ——
一个安全功能顺手破坏用户数据，比不做这个功能更糟。读不到剪贴板时同样不清。
另外 Electron 44 的剪贴板 API **全是异步的**，所以退出时的清理要在
`before-quit` 里拦一下（带 300ms 上限），否则进程先没了，清理根本来不及跑。

**`credential_versions` 里连密文列都没有。** 轮换的全部意义是让旧的那把作废，
而一个能翻出所有历史 Key 的库会让「越勤于轮换、泄漏后果越严重」。
只存指纹和末四位。`revoked_at` 只在**轮换**时写 —— 用户按「停用」改的是
`model_credentials.status`，不动版本行。详见 PHASE-4B §2。

**验收进程里 `ENVVAULT_BLOCK_NETWORK=1`，真传输见到它就拒发。**
`verify-core.ts` 在脚本开头设上，`verify-ui.mjs` 给它 spawn 的进程也带上。
所有验证都注入了假传输，但「记得注入」是靠自觉的规矩 —— 忘一次的后果是
把测试 Key 发到真实厂商去，而且测试照样绿。这道拦让它变成一次响亮的失败。
`verify:core` 里有一条断言直接调真传输确认这道拦不是摆设，**别把它删了**。

## 6. 🔴 敏感值的边界（改 repositories / credentials / IPC 时务必守住）

```
配置项：
磁盘明文 → scan 解析 → vault.encryptValue → config_entries.encrypted_value（只有密文）
        → listEntries 在主进程侧换成掩码占位符  ← 明文到这里止步
        → IPC → 渲染层拿到 ••••••••

模型凭据：
用户粘贴 → vault.encryptValue → model_credentials.encrypted_api_key（只有密文）
        → listCredentials 只给 fingerprint + last_four  ← 明文到这里止步
        → 同步时在主进程内存里解密，直接交给写盘，不经过任何返回值
        → 验证时在主进程内存里解密，直接进请求头交给传输层，
          不进返回值、不进操作记录、不进任何日志
        → 复制时在主进程内存里解密，直接进系统剪贴板，
          返回值里只有「多久之后清」

版本历史：
credential_versions 只有 fingerprint + last_four + 时间  ← 从来没有过明文
        （连密文列都没有：留着旧密钥是纯粹的负债，见 PHASE-4B §2）

CLI 注入：
resolveEnvironment 在 CLI 进程内存里解密整个环境
        → 直接交给 spawn 的 env，**不落盘、不打印、不过 IPC**
        ⚠️ 但环境变量对同用户的其它进程可见 ——「不落盘」≠「隔离」

.env.example 生成：
磁盘上的 .env 明文 → buildTemplate 逐节点清值（注释里的赋值一并擦）
        → findLeaks 拿源文件的高敏值反查结果，命中就**拒绝写盘**
        → 写出的文件里没有任何值  ← 明文到这里止步
        🔴 全程不解密（源头是磁盘不是库），Vault 锁着也能跑
        🔴 这是唯一一个**要进 Git** 的产物：前面几条是"值离开本进程"，
           这一条是"文件离开本机"。默认一律取保守的那一边。

加密导出：
buildPayload 在主进程内存里解密选中项目的**全部**值（勾了还带凭据 Key）
        → 立刻交给 sealPackage（scrypt 派生 + AES-256-GCM）
        → 落盘的只有密文  ← 明文到这里止步
        🔴 最宽的一条出口。没有"不加密导出"这条路；口令输两遍；
           口令是渲染层→主进程方向的秘密，不进返回值/记录/日志
```

明文过桥**只发生在 `entries:reveal` 和 `credentials:reveal` 两个通道**，
且每次调用都写一条操作记录（只记 key 名 / 凭据名，不记值）。

**复制不在这两个通道里** —— 阶段 4b 把它整个挪进了主进程。
「显示」必须过桥（值要出现在屏幕上），复制不必，所以就别让它过。
`entry.copy` / `credential.copy` 是独立的记录动作，不复用 `*.reveal`：
复制出去的那一份**会离开本应用**，查看不会，审计时要分得开。
差异面板、凭据列表、同步预览同样只给掩码 —— 它们都是一览视图，
把明文铺上去等于绕过了 reveal 的审计。编辑框也守同一条：敏感项默认盲写，
点开编辑不等于看见值；已经点过「显示」的才预填（那次 reveal 已经留痕）。

**凭据的指纹是 `HMAC(从主密钥派生的子密钥, key)`，不是裸哈希。**
裸哈希会让拿到库文件的人能拿候选 Key 字典去比对；派生之后没有系统密钥库
就什么都验证不了。`vault.deriveSubkey` 做用途隔离，**不返回主密钥本身**。

**🔴 `config_entries` 里只有 `encrypted_value` 是加密的，别的列一个都不能放值。**
这条是踩出来的：`original_format` 从阶段 1 起存的是**完整原始行**，
于是每一把 Key 的明文都躺在库里，而验收那条「明文不落库」只翻了
`encrypted_value` 一列，够不着它。现在存的是「格式骨架」
（`document.formatSkeleton`，值换成 `<value>`），迁移 004 清了存量。详见 PHASE-2 §7。

`verify:core` 的明文断言现在扫**整行的每一列**外加数据库文件的字节（含 `-wal`），
`verify:ui` 有几条断言搜整个页面文本确认没有那些假 Key。加功能时别把它们弄红 ——
也别在给 `config_entries` 加列时忘了这一条。

**🔴 `runValidation` 的 `catch` 连 error 都不绑定，别"顺手"把它加回去。**
`ipc/index.ts` 的 `toFailure` 对没认出来的异常会走
`console.error('[ipc] 未处理的异常', error)` —— 那是全应用唯一一处会把原始异常
整个打印出来的地方，而验证这一层手里的 `request.headers` 装着完整的 Key。
拿不到 error 就不可能不小心把它传出去。
同理，`credential.validate` 的操作记录只记厂商名、凭据名、结论和状态码，
**连调用地址都不记** —— 自定义厂商的地址是用户填的，谁也不敢保证里面没有秘密。

## 7. 下一步：外部 Secret Manager 适配

MVP 清单（计划 §11）到 4b 就全成立了；5a 补上 CLI 注入、5b 模板生成、
5c 加密导出与导入。**规格 §9「阶段 5」的四项里只剩最后一项。**

- **1Password / Bitwarden / Doppler 适配。** 它们需要机器上装有各自的 CLI，
  验收里只能全程用假的 —— 而一个只验过假实现的集成等于没验。
  **先想清楚怎么验，再想怎么写。** 一个可能的路子：把"执行外部 CLI"这层
  抽成可注入的 runner（`git/run.ts` 已经是这个形状），真实现只在装了 CLI 的
  机器上手动跑一次并把输出记进 PHASE 文档 —— 但那也要在文档里**明说**
  哪些是自动验的、哪些不是。

**六条边界都开过了**：出站流量、执行外部程序、系统剪贴板、把 Key 交给子进程、
写一个要进 Git 的文件、把全部值封成一个包带出本机。
它们各自只覆盖一条路，**新开任何一条都不要默认沿用前面的结论**。

还没做但迟早要碰的：

- **明文导出**。规格 §7 允许（只说「优先导出加密包」），5c 有意没做，理由见 PHASE-5C §6。
- **导入时重建凭据绑定**。5c 没做：目标机器上的项目和环境可能对不上，
  猜错一次就是把一把 Key 绑到错的文件上，而下次同步会真的写下去。
- **🔴 把安装器真的跑一次，确认 `envvault` 写进了 PATH。**
  NSIS 的配置写了，阶段 7 也真打出了产物，但**安装器本身从没被运行过** ——
  「PATH 写进去了」到今天为止仍是一句推断，不是结论。见 RELEASE.md。
  （这条早前写作「把 `envvault` 装进 PATH 是发布时的事，现在打包后是
  `EnvVault.exe run`」，那是阶段 7 之前的状态，已被 PHASE-5A §7 的更新推翻。）

## 8. 来自踩坑的经验

**一条从来没红过的断言，要么是代码真的对，要么是断言根本够不着它 ——
这两种情况在测试报告上长得一模一样。** 这条在这个仓库里已经踩中八次：

- 阶段 2 的并发守卫写成了摆设：写入前自己重新算一遍磁盘哈希再拿去校验，
  那当然永远相等（PHASE-2 §5）；
- `original_format` 存了整行明文却一直没人发现，因为「明文不落库」那条断言
  只翻了 `encrypted_value` 一列（PHASE-2 §7）；
- 阶段 3 收尾那条「没验出结论时不改状态」，四个用例里有一个够不着 ——
  它从 `invalid` 起步，而错误的写入正好也写 `invalid`，时间戳还落在
  同一毫秒里（PHASE-3 §7）。**断言的起点选错了，它就什么都守不住。**
- 阶段 5a 的端到端第一版写在 `verify:core` 里，那儿的 userData 凑不齐
  数据库和 safeStorage 密钥，**CLI 根本没起来** —— 而「磁盘上搜不到 Key」
  那条照样 PASS：没跑过的注入当然不会往磁盘上写东西。挪到 `verify:ui`
  才真的验到（PHASE-5A §8）。**先确认被测的东西真的跑起来了，再信它的绿。**
- 阶段 5b 的界面验收里一口气差点空过两条：「界面写出的 `.env.example` 搜不到
  明文」—— 可 `verify:core` 早就用同一个底本生成过一份长得一模一样的，
  界面就算没写成功也照样绿（改成先涂一段哨兵再让界面写）；而弹窗默认挑的底本
  是 `.env`，**那份文件里本来就没有秘密**，拿它验「模板里没有明文」同样等于没验
  （改成在界面里切到 `.env.local`）。**验"某个东西不在结果里"之前，
  先确认它本来有机会在。**
- 阶段 5c 的「改包头就打不开，所以 AAD 生效了」——**把 `setAAD` 整个删掉，
  20 条用例照样全绿**。因为那条用例改的是 `log2N`，而它本来就参与密钥派生，
  改了密钥就变了，GCM 自然通不过，跟 AAD 一点关系没有。
  改成去动头里**不参与派生**的字段（version 往低改、翻一个保留字节）才验到
  （PHASE-5C §3）。**断言要盯住机制：先问"这个字节是通过哪条路影响结果的"。**
- 同一刀的「导入之后磁盘一个字节都没变」——它跟着一次**空操作**跑：
  包是从当前库导出的，原样导回去新增 0、更新 0，什么都没导磁盘当然不会变。
  先用裸 SQL 改掉一个值让导入真的有事可做，这条才立得住（PHASE-5C §5）。
- C5 的「弹窗保存后表格不该还铺着旧明文」——**把 bug 放回去，它照样 PASS**。
  表格那份明文缓存（`revealed`）只有用户在**表格里**点过「显示」才会有东西，
  而验收脚本从来没对那个变量点过，缓存里压根是空的 ——「旧明文不该还在」
  验的其实是「它本来就不在」。改成先点表格的「显示」再开弹窗，它才红出正确的
  信息，并另加一条起点断言钉住「保存前它确实在屏幕上」。
  **又一次是起点选错：断言够不着的不是分支，是状态。**

**判断一条断言有没有用的办法是把 bug 放回去跑一遍。**
`original_format` 那条就是这么确认的：把泄漏改回原样，老断言依然 PASS，
新断言才报出 `泄漏的列: original_format`。写完一条 🔴 断言顺手做一次，成本一分钟。
上面第三条也是这么抓到的 —— 而且注意它**红了**（三个用例失败），
差一点就当成"断言有效"收工了。**看的不能只是红没红，还得看红得对不对。**

阶段 5c 又撞了一次同样的形状：给 `applyImport` 注入一个"往磁盘写一行"的 bug，
结果那个路径的目录根本不存在，脚本直接 ENOENT 崩了 —— 报告上是「脚本未抛异常」
失败，而真正要验的那两条断言**压根没跑到**。改成先建目录再写，它们才各自
红出正确的信息。**注入的 bug 要落在被测的那条路径上，崩在半路不算验过。**

**会因为"新增"而变红的断言值得多写。** 它们把「加东西时顺手过一眼」
从自觉变成了机制。目前有两条，都拦住过真问题：

- 「操作记录里的动作都是中文」—— 加了新的 action 忘配标签就红（4a、4b 各拦一次）；
- `risk.test.ts` 的「判定入参里没有放值的字段」—— 加字段就红，
  强制有人确认新字段不是一个能装下配置值的口子；
- 「preload 只暴露白名单方法」按**个数**写死 —— 桥上多一个方法就红一次
  （5b 拦了一次：38 → 40）。

**但代理条件要盯住性质本身，别图省事写个更宽的。**
上面第一条原本用「标签里不含 `.`」当代理来判断"是不是漏出了原始标识"，
5b 的合法标签「生成 .env.example」直接把它撞红了 —— 里面有文件名而已。
断言的名字说的是「都是中文」，那就直接验这个：每个标签至少含一个汉字。
`template.generate` 依然会红，合法标签不再误伤。
**代理比它要守的性质宽，早晚会误伤一个合法的新写法；而被误伤时，
最省事的"修法"是去改那个合法的新写法 —— 那就把断言的意义改没了。**

**🔴 把 bug 放回去之后，先确认它真的进了被测的产物。**
阶段 5a 的三条实验里，第三条（吞掉子进程退出码）**是绿的** ——
差一点就当成"这条断言没用"记下来了。真正的原因是改动留下一个未使用的变量、
`pnpm build` 因此失败，而我把构建输出重定向掉了没看见 ——
被测的根本还是旧产物。换个改法并**确认构建成功**之后，那条断言立刻红了。

构建失败 + 旧产物 = 一次什么都没验到的实验，而它和「断言无效」在结果上
长得一模一样。**别把构建输出重定向到 `/dev/null`。**

**证明「没有多出东西」要用前后快照，不要用白名单排除。**
阶段 5a 的「不落盘」第一版是「扫出所有含这把 Key 的文件，再排掉 fixture 目录」，
当场误报 —— 写盘时自动建的备份目录里本来就有这把 Key。更糟的是白名单这条思路
会越加越长，每加一条都在扩大"看不见的地方"，迟早把真正的泄漏一起放过。
改成在一次**成功的**注入前后各扫一遍、比较集合有没有增长，这才直接回答了
要问的那个问题：这次运行有没有让磁盘上多出一份（PHASE-5A §8）。
**导出那一刀要回答同一个形状的问题（哪些文件是这次导出造成的），别退回白名单。**

**一条会随机变红的断言比没有断言更糟。** 阶段 3 留下的
`!fingerprint.includes('cdef')` 就是：指纹是 16 位十六进制，而 `cdef`
也是合法十六进制串，偶然出现的概率约 1/5000 —— 4b 这一刀实测撞上了。
而且那样测本来就没有意义（十六进制串里出现四个十六进制字符说明不了任何事）。
换成了确定性的「指纹 ≠ 裸 SHA-256」，那才是它真正该守的性质。

阶段 4a 又碰到一次同样的形状：摘掉 `git check-ignore` 的 `--no-index` 之后，
断言确实红了 —— 但**红的不是等级那条**。`.env.local` 里有高危值，
判定表的另一条照样把它兜成 critical，所以只断言 `level === 'critical'`
会让这个 bug 完整漏过去，而受害的是另一种文件：已跟踪 + 已忽略但暂时干净的
那种，它会从 warning 静默掉到 ok。真正抓住它的是 `ignored === true`
和「理由里有没有那句话」这几条子断言。**断言要盯住机制，不只盯住结论。**

（并发守卫那条是另一种发现方式 —— 补上一个**真正的**并发场景才暴露出来。
几种办法解决的是同一个问题：确认断言能到达它要守的那个分支。
阶段 2、3 的两道写盘守卫都因此是**分开**验的，先让其中一道必过再验另一道。）

**验收脚本抓到的失败，先判断是"我的期望写错了"还是"实现写错了"，别急着改期望。**
阶段 1 有两条失败，一条是我算错了数（改期望），另一条是重扫会推翻用户的取消勾选
（真 bug，加了迁移 003）。阶段 3 也有一条：厂商适配器的 Gemini 用例没通过，
查下来是我的样例 Key 少写了一位（真实格式是 `AIza` + 35 位），实现是对的。
详见 PHASE-1 §4。

**样例数据是共享的，一条断言改动它就可能弄红另一条。**
`verify-core` 留下的沙箱就是 `verify-ui` 的输入。阶段 3 一开始想复用
`OPENAI_API_KEY` 做同步目标，但同步会覆盖它的值，而界面验收还要靠那把 Key
验「没点显示就不给明文」—— 于是给阶段 3 单独加了一个 `ANTHROPIC_API_KEY`。
制造并发场景用的临时变量（`OUTSIDER`）也要在段落末尾删掉，
否则界面那条「变量集合」断言会多出一条。

## 9. 提交与推送

仓库在 `main`，远端 `origin` 是 GitHub。阶段 0~3 已经全部提交并推送，
工作树干净。**用户没明说「推」就不要推**，也不要自作主张开分支或改历史。

一条实际踩到的：本仓库的 Bash 工具是 Git Bash，**不认 PowerShell 的
here-string**（`@'…'@`）。写多行提交信息用 heredoc：

```bash
git commit -F - <<'EOF'
标题

正文
EOF
```

用错的表现是标题里多出一个孤零零的 `@`。
