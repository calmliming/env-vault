# 发布说明与发布前检查

对应 `DEVELOPMENT_PLAN.md` §10「发布前检查」。

> **这份文档的用处是如实标出哪些验过、哪些没验。**
> 一份把没做的事写成已完成的发布清单，比没有清单更糟 ——
> 后者至少不会让人以为已经检查过了。

## 打包

```powershell
pnpm run package        # typecheck → build → electron-builder
pnpm run package:dir    # 只出 win-unpacked，不做安装器，调试用
```

产物在 `release/`（已被 `.gitignore` 排除）：

| 文件 | 说明 |
| --- | --- |
| `EnvVault Setup <版本>.exe` | NSIS 安装器。装完会把安装目录写进当前用户 PATH |
| `EnvVault <版本>.exe` | 便携版，解压即用，不写注册表、不改 PATH |
| `win-unpacked/EnvVault.exe` | 未打包的可执行文件 |

## §10 发布前检查逐条状态

| 检查项 | 状态 |
| --- | --- |
| Windows 首发包**构建** | ✅ 真打过，产物见上表 |
| Windows 安装 / 升级 / 卸载 | ❌ **没跑过**，见下 |
| Electron 安全配置审计 | ✅ 由 `verify:ui` 逐条守着，见下 |
| 依赖漏洞扫描 | ✅ 跑过，结论见下 |
| 代码签名 | ❌ **没做**，见下 |
| 自动更新完整性 | ❌ **没做**，见下 |
| 不同分辨率与窄屏布局 | ✅ `verify:ui` 有断言，见下 |

### ✅ 构建：验到了什么

`EnvVault.exe run --help` 从 `release/win-unpacked/` 里跑起来了，退出码 0，
帮助文本完整。这顺带证实了 PHASE-5A 里那句原本**没验证过**的话
——「打包后是 `EnvVault.exe run -- <命令>`」—— 是对的。

### ❌ 安装 / 升级 / 卸载：没跑过

安装器**构建**出来了，但没有人运行过它。所以下面这些是**推断，不是结论**：

- 装完之后 PATH 里真的有了；
- 卸载之后那一项真的被移除了；
- 升级安装（装在已有版本之上）行为正常。

运行安装器会修改注册表和用户 PATH，是一次不可逆的系统改动 ——
要验它得有人真的装一遍。`build/installer.nsh` 里那段脚本能**编译**通过
（打包时 makensis 会编译它），但编译通过和行为正确是两回事。

> 卸载时的 PATH 清理是**保守实现**：只在「整条 PATH 就是安装目录」或
> 「安装目录在末尾」两种能安全判断的情形下移除，夹在中间时保持不动。
> 理由写在 `build/installer.nsh` 顶部 —— 留一条指向已删除目录的 PATH 项是无害的
> （Windows 找不到就跳过），而字符串替换写错一次就是把用户的开发环境弄坏。

### ❌ 代码签名：没做

包是**未签名**的。后果要说清楚：

- Windows SmartScreen 会拦下未签名的安装器，用户需要点「更多信息 → 仍要运行」；
- 这不是 bug，是未签名软件的正常表现。

有证书时不要把它写进 `electron-builder.yml`，走环境变量：

```powershell
$env:CSC_LINK = "path\to\cert.pfx"
$env:CSC_KEY_PASSWORD = "..."
pnpm run package
```

同时要把 `electron-builder.yml` 里那行 `signAndEditExecutable: false` 删掉 ——
它是环境妥协，不是设计选择，见下一节。

### ⚠️ `signAndEditExecutable: false` 是环境妥协

electron-builder 会下载并解压一个 `winCodeSign` 工具包，里面含 macOS 的
dylib **符号链接**。Windows 上创建符号链接需要管理员权限或开发者模式，
这台机器两样都没有，解压失败会让整个打包中止：

```
ERROR: Cannot create symbolic link : 客户端没有所需的特权 :
  ...\winCodeSign\<id>\darwin\10.12\lib\libcrypto.dylib
```

预先手动解压不管用 —— 它每次解压到一个**新的随机目录**。

关掉 `signAndEditExecutable` 就不再走那条路。**代价**：exe 的图标和版本信息
不会被写入（rcedit 也在同一条路径上）。

**正确的解法是打开 Windows 开发者模式**（设置 → 系统 → 开发者选项），
然后把那一行删掉重新打包。这是一次系统设置改动，需要人来做。

### ✅ 依赖漏洞扫描

`registry.npmmirror.com` 没有 audit 端点，要显式指定公共 registry：

```powershell
pnpm audit --prod --registry=https://registry.npmjs.org/   # 生产依赖
pnpm audit --registry=https://registry.npmjs.org/          # 含构建工具链
```

结论**必须分开说**：

- **生产依赖：0 个已知漏洞。** 运行时依赖只有 `chokidar` 一个。
  这是**装到用户机器上的那部分**。
- **含 devDependencies：18 个**（6 moderate / 11 high / 1 critical），
  **全部**在 `electron-builder → @electron/rebuild → node-gyp → tar / cacache`
  这条链上，属于构建工具链，**不进包**。

把这两个数字混在一起说，无论说 0 还是说 18 都是误导。

### ✅ Electron 安全配置审计

不是一次性的人工过目，是 `verify:ui` 里持续跑的断言：

- `nodeIntegration: false` / `contextIsolation: true` / `sandbox: true`
  —— 断言「渲染进程拿不到 Node」（`require` / `process` / `module` 全是 undefined）；
- `ipcRenderer` 未被暴露；
- **没有通用 `invoke` 逃生口**；
- preload 只暴露白名单方法，**个数写死**（当前 47）——
  桥上多一个方法就红一次，逼人过一眼那是不是该暴露的东西；
- 生产 CSP 不含 `unsafe-inline`；
- 页面无控制台错误与未捕获异常。

另外主进程侧还有一层：IPC 校验发送方（拒绝非主框架的调用）、逐个校验入参。

### ✅ 窄屏与分辨率

`verify:ui` 有两组：

- **零滚动条**：视口压到 620px 高（`BrowserWindow` 的 `minHeight`），
  断言没有文档级滚动条、外壳高度等于视口、滚动发生在内容区内部、顶栏不跟着滚；
- **窄屏**：视口压到 900px 宽，逐个切过五个页面，断言**都不出现横向滚动条**。
  横向滚动在桌面应用里几乎总是布局出错的信号，不是设计。

## 跨平台

`electron-builder.yml` 里 mac / Linux 两段配置**写了但没验证过** ——
这台机器打不出那些包，也没有机器可以跑。同样地：

- macOS / Linux 的系统密钥库分支在代码里，但**一次都没执行过**；
- `write.ts` 那条 POSIX 权限位测试在 Windows 上**恒跳**，
  意味着 `mode 0o600` 那条路径在这里从未被验证。

一份没跑过的打包配置，和「只验过假实现的集成」是同一种东西。
它留在那里是为了让有 mac / Linux 的人能直接试，**不是**说它已经能用。

## 自动更新

**没做。** 需要一个发布源（GitHub Releases、S3 或自建）以及签名 ——
未签名的自动更新在 Windows 上装不上。

`electron-builder` 已经生成了 `latest.yml`（更新元数据），
接 `electron-updater` 时用得上，但目前没有任何代码读它。

## 发布前手动过一遍

自动验收覆盖不到的，只能人来：

1. 在一台**干净的** Windows 上装一遍安装器，确认能装上、能启动；
2. 开一个**新**终端，敲 `envvault run --help` —— 验 PATH 真的写进去了；
3. 装第二遍（升级路径），确认用户数据还在（`deleteAppDataOnUninstall: false`）；
4. 卸载，确认应用没了、而 `%APPDATA%` 下的数据**还在**（那是有意的：
   卸载一次就把用户全部配置和凭据删光是不可逆的破坏）；
5. 确认卸载后 PATH 里没留下无效项（或按上面的保守规则，留了也可接受）。
