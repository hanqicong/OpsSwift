# OpsSwift 长期支持版

简体中文 · [English](README.md)

**领益运维工作台**，基于 MIT 许可的 OpsMaxx，独立维护已经审查的网络设备与 Windows 管理扩展。

- 支持简体中文和英文，连接表单、全局设置与发布管理均可随语言切换。
- 采用领益橙色标识及中性深浅配色，保留 SSH/SFTP、跳板、隧道、数据库和本地加密保险库。
- 22 个候选网络 OS 档案，支持 SSH／Telnet 窗口终端，以及 MCP 的 NETCONF、HTTPS JSON-RPC、WinRM／Windows SSH PowerShell。
- 支持全局或单连接 SSH 旧算法兼容；现代算法先行、主机指纹始终核验，只有相应协商失败才有限回退。
- MCP 共 75 个工具，包含 14 个协议／网络扩展。候选档案不代表全部品牌、型号和固件已验收，真实配置仍保留审批边界。

## 发布与维护

从 [OpsSwift 发布页](https://github.com/hanqicong/OpsSwift/releases)下载。首个已验证安装包面向 **macOS Apple Silicon**；保留 Windows／Linux 源码与构建方案，本次不声明这些平台已完成安装验收。

`1.0.x` 为本产品的 LTS 维护线，以兼容、缺陷修复和安全修复为主。上游新版本先进入本仓库审查、合并、构建和验证，再发布 OpsSwift 安装包。未来版本兼容性需要逐版核验；不承诺任意官方安装包自动保留定制能力。详见[维护与升级规则](docs/MAINTENANCE.md)。

macOS 安装包当前使用本机临时签名及 hardened runtime，**未经 Apple 公证**；自动覆盖升级保持关闭。更新页面指向本仓库管理的发布页。

## 既有资料兼容

OpsSwift 使用独立的 `OpsSwift.app`、`com.lyitech.opsswift` 和 `OpsSwift` 数据目录。受控迁移先完整备份原应用与加密资料，再复制加密数据；保留旧系统密钥库身份及文件／通信标识以兼容既有数据，不导出明文凭据。

1.x 为保持现有 Agent 集成，MCP 配置继续使用 **`opsmaxx` 兼容标识**，实际启动程序和服务显示为 OpsSwift，默认端口 5177。不得同时启动两个客户端争用端口。个人连接、设备清单、Token、保险库及审计日志均不进入 Git 或发行制品。

## 开发与来源

Node 24，依次运行 `npm ci`、`npm run typecheck`、`npm test`、`npm run lint`、`npm run build`。Apple Silicon 打包脚本为 `scripts/opsswift-package.py`，网络引擎必须由固定源码构建并通过清单校验。原项目、MIT 许可与第三方组件说明见 [English README](README.md#attribution) 与 [LICENSE](LICENSE)。

按业务需求继续开发，请从[开发指南](docs/DEVELOPMENT.md)和[仓库协作入口](AGENTS.md)开始；可复用 [OpsSwift 开发技能](.agents/skills/opsswift-development/SKILL.md)。具体代码地图、隔离开发、兼容边界和验收选择均在指南中维护。

同事参与开发请使用各自的 GitHub 账号，通过 Fork／PR 贡献；写入和合并受仓库权限、审核与 CI 保护。见[开源协作与认证](docs/COLLABORATION.md)。
