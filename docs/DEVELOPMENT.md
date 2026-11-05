# OpsSwift 开发与维护指南

Developer guide for the independent OpsSwift product. Start here for feature work; use [MAINTENANCE.md](MAINTENANCE.md) for releases and recovery. 本指南记录可复用的实现入口和约束，具体需求由产品所有者决定。

## 从需求确定改动范围

先明确用户要在什么对象上完成什么动作，以及如何确认成功。可按下面的简短模板补齐需求；已有信息直接复用，不要求每次重新填写表格。

```text
目标：用户在什么场景完成什么工作？
入口：桌面窗口、CLI、MCP，还是其中几个入口？
对象：保存的连接／设备档案／协议／工作区。
行为：读什么、改什么、需要什么权限和确认？
异常：拒绝、超时、部分成功、凭据锁定时怎样反馈？
验收：可观察的成功结果，需支持的平台／型号／固件。
数据：新增什么资料、保留多久、空间上限、回收与恢复方法？
交付：源码改动、候选包、GitHub 发布、本机安装分别是否在本次范围？
```

只实现本次选定的纵向流程。维护已有接口时优先兼容；当前授权不足的外部操作，在完成候选制品后明确剩余条件。设备实机验证和生产配置授权按当前工作区规则执行，不能从“开发一个功能”推导出对所有设备的写入权限。

事实入口如下：

| 需要知道什么 | 先读取什么 |
|---|---|
| 源码身份、命令、依赖 | [`package.json`](../package.json)、[`package-lock.json`](../package-lock.json) |
| 上游来源及增强版基线 | [`UPSTREAM.json`](../UPSTREAM.json)、Git 历史和实际差异 |
| 某个发布包含什么 | 该版本标签、GitHub Release、附件摘要；不能用当前 `main` 代替已发布版本 |
| 安装、资料迁移和实机结果 | 当次部署回执；在 SECOPS 工作区查部署状态、版本锁及相关交付目录 |
| 后续开发经验 | 本指南、[开发技能](../.agents/skills/opsswift-development/SKILL.md)、相关实现及测试 |

## 按功能找到代码

| 改动对象 | 主要入口 | 必须同时检查 |
|---|---|---|
| 桌面页面与状态 | `src/renderer/src/components/`、`src/renderer/src/store/app.ts` | loading／空态／错误／权限反馈；实际桥接方法 |
| 连接表单 | `src/renderer/src/components/connections/AddServerModal.tsx` | 保存后的协议／档案／兼容选项，而非仅表单显示 |
| 进程与 IPC | `src/main/index.ts`、`src/preload/index.ts`、`src/preload/index.d.ts` | 参数校验、主进程授权、事件归属和连接关闭 |
| 共享合同 | `src/shared/` | 类型、默认值、校验、旧数据读取及消费方 |
| MCP 工具 | `src/main/services/mcpServer.ts`、`mcpAuth.ts`、`policyStore.ts`、`approvals.ts` | 实际工具注册、有效权限、内容绑定审批、返回值脱敏 |
| CLI／客户端绑定 | `src/cli/`、`src/shared/mcpClientKeys.ts` | 兼容键、实际程序／脚本路径、默认端口及现有配置保留 |
| 网络设备档案 | `src/shared/networkDevice.ts` | 查询、翻页、提示符、备份、配置风格及型号资格 |
| 网络 CLI 事务 | `src/main/services/networkCli.ts`、`networkBackupExport.ts` | 有界输出、完整备份、不可变计划、执行一次和读回 |
| 窗口网络终端 | `src/main/services/nativeNetworkTerminal.ts` | `ssh:connect`／`ssh:test` 分派、会话归属、Telnet IAC 和关闭 |
| SSH 与跳板 | `src/main/services/ssh.ts`、`sshCompatibility.ts`、`sshPolicy.ts` | 默认策略、显式严格例外、每跳凭据与主机信任 |
| 远程协议 | `src/shared/remoteProtocol.ts`、`src/main/services/protocolWire.ts` | 保存的协议、路由、固定端点、边界和取消 |
| NETCONF／JSON-RPC／Windows | `protocolNetconf.ts`、`protocolJsonRpc.ts`、`protocolWindows.ts`，均在 `src/main/services/` | SSH 子系统／严格 HTTPS、消息对应、写入语义和不确定结果 |
| 资料及保险库 | `src/main/portable.ts`、`src/main/services/store.ts`、`secrets.ts`、`vault.ts` | 导入先后顺序、真实 userData、OS 密钥库及加密兼容 |
| 双语、品牌和主题 | `src/shared/locales/en.json`、`zh-CN.json`、`src/renderer/src/assets/`、`src/renderer/src/styles/` | 占位符、主题对比度、真实图标格式与原生菜单 |
| 更新与打包 | `src/main/services/updater.ts`、`electron-builder.yml`、`scripts/opsswift-package.py` | 自有发布源、原生绑定、引擎、签名及许可文件 |
| Go 引擎 | `sidecar/netd/`、`sidecar/addyd/`、`scripts/build-*.sh` | `go.mod`／`go.sum`、目标平台、清单和第三方许可 |

表内未写目录前缀的服务文件，按同一单元格说明的服务目录查找。具体模块仍以现场源码为准，不把此表当作固定目录清单。

### 增加设备或协议

中文字节编码、USG 配置合同及候选固件边界见 [CHINESE-AND-USG.md](CHINESE-AND-USG.md)。CLI 始终先保留字节，再用每个独立流的解码器组装字符；Telnet IAC 协商先于文字解码，不能提前 `toString()`。新增编码须贯通表单、保存标签、原生连接和 MCP，RPC 的协议编码另行处理。

新增设备先选现有档案中最接近的命令风格，建立按型号／固件划分的资格记录。只有只读查询通过时就只声明只读资格；不要把相同品牌、相似 CLI 或一条版本命令等同于配置能力已验收。

网络 CLI 新功能沿用 `read → plan → apply → verify` 的边界：计划绑定会话、目标、基线和内容；实际写入前核对有效权限、过期和漂移，验证加密备份，再消费计划并执行。超时／部分执行作为未知或部分结果报告，不能自动重放或承诺业务转发健康。

当前 RPC 分为 NETCONF 和 HTTPS JSON-RPC；Windows 入口为 WinRM HTTPS 或 SSH 上的 PowerShell。设备协议由保存的连接决定，端口不能独立证明协议。自定义 RPC／脚本沿用写入审批，不能仅凭方法名把任意请求标为只读。当前实现不等同于 DCOM、Kerberos、CredSSP 或全部 Windows RPC。

窗口、MCP、后台和跳板是不同消费面。新增配置字段时逐个检查实际传递，避免 MCP 已支持、双击窗口却仍走旧连接入口。

### 调整产品身份与资料

1.x 的这些名称有意保留：

- `app.setName('OpsMaxx')`：维持既有 macOS Safe Storage 服务／账户身份。
- `opsmaxx-*` 资料文件、`window.opsmaxx` IPC、`opsmaxx` MCP 注册键及相关启动环境变量：兼容既有资料和调用方。
- 引擎文件及 Go 模块的历史名称：由实际清单／调用协议约束，不属于普通 UI 文案。

显示名、应用 ID、安装路径和默认资料目录则属于 OpsSwift。不要做不区分语义的全文替换。若确需修改兼容接口，应先设计读取旧记录、明确迁移失败、保留新旧资料与回滚路径，并通过原生加解密和客户端发现验证。

## 在隔离环境开发与验证

所有命令在仓库根执行。先检查 Git 差异；保留他人的修改，以 `codex/<task>` 任务分支开发。Node 与 Go 要求从项目文件读取，依赖安装遵守当前环境规则；`npm ci` 会应用 `patches/` 中的补丁。

普通 `npm run dev` 使用应用的默认资料位置。开发时显式设置隔离路径，例如：

```bash
mkdir -p .runtime/development
PORTABLE_EXECUTABLE_DIR="$PWD/.runtime/development" npm run dev
```

这会使该进程以 portable 模式使用 `.runtime/development/OpsSwift-data`。使用合成连接；启用开发 MCP 时选独立且未占用的端口。不要从日常资料复制 Token 或为测试接管已安装客户端。测试结束正常退出开发进程；仅清理确认属于本任务的可再生合成资料，个人资料及恢复备份另行保留。

`OPSMAXX_DEMO_PROFILE` 的 demo 模式会播种合成记录，不能指向真实资料目录；打包应用不会启用这个 demo 分支。读取 `src/main/demoGuard.ts` 与 `scripts/demo.mjs` 后再使用它。

验证按改动选择：

| 改动 | 有价值的检查 |
|---|---|
| 文档／技能 | YAML、相对链接、代码路径、技能结构和差异；不因此重装客户端 |
| 英文／中文文案或主题 | `tests/opsswiftProduct.test.ts`、`tests/i18nLiterals.test.ts`、`tests/contrast.test.ts`，必要时原生界面切换 |
| 连接表单和协议分派 | `tests/networkEditor.test.tsx`、`tests/nativeNetworkTransport.test.ts`、`tests/nativeNetworkTerminal.integration.test.ts` |
| SSH 策略 | `tests/globalSshPolicy.test.ts`、`tests/globalSshSettings.test.tsx` 与相关握手／主机信任测试 |
| 网络／RPC／Windows | `tests/networkExtension.test.ts`、`tests/networkProtocol.integration.test.ts`、`tests/remoteProtocols.test.ts`、`tests/remoteProtocols.integration.test.ts` |
| 打包、品牌、更新、许可 | `tests/localPackaging.test.ts`、`tests/releaseWorkflow.test.ts`、`tests/opsswiftProduct.test.ts` 及实际包检查 |
| Go 引擎 | 对应模块 vet／test，相关原生协议模拟与受影响目标编译 |

常用命令：

```bash
npm run typecheck
npx vitest run tests/networkExtension.test.ts tests/remoteProtocols.integration.test.ts
npm run lint
npm run build
```

跨入口、安全策略、资料迁移和应用发布按 [维护门槛](MAINTENANCE.md) 执行相应完整检查。对失败先区分产品缺陷、测试替身缺项、环境权限或外部依赖；记录实际失败，不能用禁用安全检查让测试变绿。

## 已验证的工程经验

- **加密必须在原生 Electron 核验。** 测试替身可检验流程，不能证明 OS 密钥库可用；在安全加密不可用时应拒绝需要加密的备份／配置。
- **Linux 安全存储有独立路径。** 测试替身需要 `getSelectedStorageBackend()`；覆盖 keyring 可用及 `basic_text` 拒绝，避免只在 macOS 跑过就外推 Linux。
- **图标与本机绑定要查实物。** Windows 图标需要实际足够分辨率；PTY 的 sibling 绑定、`spawn-helper`、执行位和签名必须在打包布局验证。
- **签名后再核对引擎摘要。** 清单必须匹配包内字节；源目录摘要不能代替签名后清单。应用须包含产品许可和第三方声明。
- **常规 CI 和发行资格不同。** 原生引擎用于相应 CI 协议模拟；发布候选构建完整目标矩阵。三平台打包通过仍不代表所有安装流程和设备均已验收。
- **GitHub 草稿按状态管理。** CLI 按标签找不到草稿时，重新读取 release ID、`draft` 状态、资产 ID 和 digest；不猜 ID、不改已发布附件、不绕过权限拒绝。用结构化参数或文件提交长说明。
- **发布前再冻结。** 验证最终提交、标签、包、附件和 CI 对应关系。已经发布后，新字节使用新版本；旧制品和审计证据保留。历史单次交付脚本中的固定 ID／路径不是通用发布工具。

## 交付到持续维护

源码、依赖锁、构建配方、许可和开发技能进入仓库；个人资料和原始运行日志不进入仓库。文档更新不重写发布标签或安装包。

新功能交接写明：需求行为、入口、修改文件、实际验证、未验范围、数据影响与恢复位置。产品所有者按自己的需求决定下一项开发，不把候选方案登记成已部署功能，也不由本指南自动生成产品路线。

安装、发布、上游合入、资料兼容与保留规则继续使用 [MAINTENANCE.md](MAINTENANCE.md)。在 SECOPS 工作区，版本查 `versions.lock.yaml`，部署事实查知识库部署状态，活动任务查工作看板；这些实时事实不复制进技能或会话记忆。

可在后续请求中写：`使用 $opsswift-development，为 OpsSwift 增加……，验收条件是……`。仓库内技能随源码维护，个人安装仅指向该目录；移动开发目录后应更新技能链接。
