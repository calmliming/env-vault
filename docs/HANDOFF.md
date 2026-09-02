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
| 5 CLI 与高级集成 | ⬜ 未开始 | — |

阶段 4 的验收句本来就是两半，所以拆成了两刀：
「被 Git 跟踪的敏感文件必须显示风险」（4a）+
「轮换旧 Key 时能准确列出受影响的项目和环境」（4b）。两半都已完成。

**MVP 清单（计划 §11）到这里全部成立**，只剩阶段 5 的 CLI 与高级集成。

**能用的功能**：选目录 → 扫描预览 → 勾选文件导入 → 加密入库 → 分环境查看/搜索 →
点开显示敏感值（留痕）→ 文件被外部改动时自动提醒 → 逐变量看差异 →
选择「以磁盘为准」或「以中心记录为准」（原子写回 + 自动备份）→
就地编辑或删除单个变量 → 从变量识别并提取模型凭据 → 一个凭据绑定多个项目环境 →
改一次 Key 预览并同步到全部绑定（同样是原子写回 + 备份 + 并发校验）→
向厂商验证一把 Key 现在还能不能用 →
查每个 `.env*` 有没有被 Git 跟踪 / 被 .gitignore 覆盖，并给出风险等级和处置办法 →
看一条凭据换过几代 Key、停用它、轮换前先看清会波及哪些项目 →
复制到剪贴板并在 30 秒后自动清理。

**界面上没有任何"尚未接入"的占位了** —— MVP 清单的每一条都真的能用。
**没有任何地方假装完成了实际没做的事**，请保持这条。

## 2. 先跑一遍

```powershell
pnpm dev       # 开发模式，Vite HMR + Electron
pnpm verify    # 全套：161 单元测试 + 181 核心断言 + 107 界面断言，约 1 分钟
```

> ⚠️ `verify:core` 会在沙箱里 `git init` 一个真仓库（安全检查那一层只有对着
> 真 git 才验得出东西）。**这台机器上必须有 git**，否则那一组会响亮地失败 ——
> 这是故意的，静默跳过的断言和通过的断言在报告上长得一模一样。

`pnpm verify` 全绿是当前基线。**动任何代码前先跑一次**，确认起点是干净的。

> ⚠️ `verify:ui` 跑的是 `out/verify/index.mjs` 这个**已构建**的产物，
> 而它由 `verify:core` 那一步的 esbuild 生成。只改了 `verify-core.ts` 就直接跑
> `verify:ui`，用的还是旧包 —— 会看到一堆莫名其妙对不上的失败。

其它命令：

```powershell
pnpm test         # 只跑单元测试（node --test 原生跑 .ts，无需构建）
pnpm build        # typecheck + 三端打包到 out/
pnpm verify:core  # 真实 Electron 运行时里验数据库、Vault、扫描、导入、差异、写回、凭据
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
  clipboard/         ⚠️ index.ts 要能被 node --test 跑，约定见 §5
    index.ts         定时清理的判定。🔴 只清我们写进去的那一份，见 §5
    port.ts          🔴 全应用唯一 import Electron clipboard 的文件
  net/
    transport.ts     🔴 全应用唯一真的碰 socket 的文件。单独一个目录，
                     是为了让「谁会上网」有一个一句话的答案
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

**`src/main/env/`、`providers/`、`git/` 和 `clipboard/index.ts` 里的 import
必须带 `.ts` 后缀，且不能用 `@shared/*` 别名。** 这些模块要能被 `node --test`
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

**八处操作会改变监听集合**（导入 / 移除 / 重扫 / 以磁盘为准 / 以记录为准 /
编辑变量 / 删除变量 / 凭据同步），每一处都要调 `refreshWatchTargets()`。
漏掉的后果是静默的：监听器还活着，但拿旧哈希去比新文件。

**写盘的四条路径共用同一道并发关**（`filesRestore` / `entriesUpdate` /
`entriesDelete` / `credentialsSync`）：`expectedHash` 必须由**调用方**传入，
语义是「我这个决定是基于哪个版本做的」。IPC 层的 `asFileHash` 只接受
64 位十六进制串，不接受「没传就跳过校验」。理由见 PHASE-2 §5 ——
现算的哈希拿去和现算的哈希比，守卫永远不可能触发。
凭据同步是**每个目标各带一个哈希**：它们是不同的文件，共用一个没有意义。

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

## 7. 下一步：阶段 5，CLI 与高级集成

MVP 清单（计划 §11）到 4b 为止**每一条都成立了**。剩下的是计划 §9 阶段 5：

- `envvault run -- <command>` 进程注入。验收句是
  「CLI 注入模式可以在不落盘明文 Key 的情况下启动本地开发命令」——
  也就是 Key 只经环境变量进子进程，不写任何临时文件。
  ⚠️ 环境变量在多数系统上对同用户的其它进程可见，这个边界要在文档里说清楚，
  别声称成"完全隔离"。
- 从模板生成 `.env.example`（`document.formatSkeleton` 已经能产出不含值的骨架，
  那正是这件事要的东西，别重写）。
- 批量导入与**加密导出**（计划 §7：导出要二次确认，优先导出加密包）。
- 1Password / Bitwarden / Doppler 适配。

**CLI 是一个新的进程边界**，而且是这个应用第一次把 Key 交给别的程序。
按前三刀的节奏，它值得单独一刀。现有的三条边界（出站流量、执行外部程序、
系统剪贴板）各自只覆盖一条路，不要默认沿用它们的结论。

做之前先读 §5 和 §6：CLI 需要在**没有窗口**的情况下解锁 Vault，
而现在的解锁流程假定有一个渲染层在。那是这一刀真正的难点，不是参数解析。

## 8. 四条来自踩坑的经验

**一条从来没红过的断言，要么是代码真的对，要么是断言根本够不着它 ——
这两种情况在测试报告上长得一模一样。** 这条在这个仓库里已经踩中三次：

- 阶段 2 的并发守卫写成了摆设：写入前自己重新算一遍磁盘哈希再拿去校验，
  那当然永远相等（PHASE-2 §5）；
- `original_format` 存了整行明文却一直没人发现，因为「明文不落库」那条断言
  只翻了 `encrypted_value` 一列（PHASE-2 §7）；
- 阶段 3 收尾那条「没验出结论时不改状态」，四个用例里有一个够不着 ——
  它从 `invalid` 起步，而错误的写入正好也写 `invalid`，时间戳还落在
  同一毫秒里（PHASE-3 §7）。**断言的起点选错了，它就什么都守不住。**

**判断一条断言有没有用的办法是把 bug 放回去跑一遍。**
`original_format` 那条就是这么确认的：把泄漏改回原样，老断言依然 PASS，
新断言才报出 `泄漏的列: original_format`。写完一条 🔴 断言顺手做一次，成本一分钟。
上面第三条也是这么抓到的 —— 而且注意它**红了**（三个用例失败），
差一点就当成"断言有效"收工了。**看的不能只是红没红，还得看红得对不对。**

**会因为"新增"而变红的断言值得多写。** 它们把「加东西时顺手过一眼」
从自觉变成了机制。目前有两条，都拦住过真问题：

- 「操作记录里的动作都是中文」—— 加了新的 action 忘配标签就红（4a、4b 各拦一次）；
- `risk.test.ts` 的「判定入参里没有放值的字段」—— 加字段就红，
  强制有人确认新字段不是一个能装下配置值的口子。

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
