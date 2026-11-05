# OpsSwift 开源协作与认证

OpsSwift 使用 GitHub 账号认证协作身份。源码按 [MIT](../LICENSE) 开源，任何人可以读取和 Fork；写入本仓库、审核及合并由 GitHub 权限控制。本文件不增加 OpsSwift 应用登录，不分享设备账户或 MCP Token。

## 同事怎样参与

1. 使用各自的 GitHub 账号登录；建议开启通行密钥或双因素认证，不共用账号、密码、PAT 或 SSH 私钥。
2. Fork [hanqicong/OpsSwift](https://github.com/hanqicong/OpsSwift)，在自己的 Fork 创建 `feature/<topic>` 或 `fix/<topic>` 分支。
3. 按 [开发指南](DEVELOPMENT.md) 使用合成资料隔离开发；完成与改动匹配的检查。
4. 向 `main` 提交 PR，说明行为、实际测试、兼容影响和未验证范围。普通贡献者无需本仓库写权限。
5. 维护者先查看差异，再批准外部 Fork 的 CI 运行；CI 全绿不等于代码审核。`CODEOWNERS` 指向 `@hanqicong`，新提交使旧审批失效。
6. 审核、讨论解决和必需 CI 检查完成后合并。LTS 分支回移修复同样走 PR；源码合并不自动发布安装包。

命令行可以使用 GitHub CLI 的设备／浏览器登录或个人 SSH 密钥认证。登录凭据只在本人电脑的受保护存储中维护，不能提交进仓库。没有 GitHub CLI 也可直接在 GitHub 网页创建 Fork 和 PR。

```bash
gh auth login --hostname github.com --git-protocol https --web
gh repo fork hanqicong/OpsSwift --clone
cd OpsSwift
git switch -c feature/my-change
```

这是给参与者的操作示例，不由仓库自动替其登录。新增直接协作者需要维护者明确选定 GitHub 用户名及权限；公开仓库本身不会把访客变成有写权限的协作者。

## 保护与职责

仓库管理员按 `.github/rulesets/` 中可审查的定义配置服务器端规则；JSON 文件本身不启用保护，实际状态查 [GitHub Rules](https://github.com/hanqicong/OpsSwift/rules)。

| 范围 | 配置与责任 |
|---|---|
| `main` 与 `codex/lts-1.0` | PR、1 份批准、Code Owner 审核、新提交撤销旧批准、解决讨论 |
| 必需 CI | `check`、`Validate winget manifests`、`Pack windows-latest`、`Pack ubuntu-latest`、`Pack macos-latest`；来源绑定 GitHub Actions，基于最新目标分支验证 |
| 强推与删除 | 两个维护分支均拒绝，完整性规则不配置豁免 |
| 管理员应急 | 审核／CI 规则的管理员例外仅可通过 PR 使用；不能直接推受保护分支。需要使用时明确记录原因和实际验证，不能把例外当作常规贡献流程 |
| 外部 Fork CI | 外部贡献者的工作流需维护者批准运行；默认 Token 只读、工作流不能审批 PR；不为外部提交发送写 Token 或仓库秘密 |
| 发行 | 维护者审核实际制品后独立发布；不自动运行 `pull_request_target` 中的贡献者代码，不改已发布附件 |
| 2FA | 本仓库归个人账号所有。此处不宣称配置了组织级强制 2FA 或企业 SSO；若以后改用组织，再按实际成员、策略和权限设计 |

提交签名可用于核验提交来源，但 Git 作者姓名／邮箱不是 GitHub 写权限证明。维护者不要仅凭作者文本授予权限。个人账号的 2FA 由各人维护，本仓库不收集恢复码或验证密钥。

## 公开资料边界

仅使用合成或脱敏的例子，不提交真实连接、设备清单、备份、保险库、内部运行日志、访问令牌或私钥。测试目录内的合成密码、示例凭据和测试证书只用于本机模拟，不能用于真实设备。开源前检查 Git 历史及发行附件；扫描不等于不存在任何缺陷。

保留原 MIT 版权、第三方许可证与 `UPSTREAM.json` 来源。LYiTECH 标识和产品名称不表示第三方获授商标权，也不表示上游作者背书；MIT 许可适用于相应软件版权。

漏洞使用 [私密报告入口](https://github.com/hanqicong/OpsSwift/security/advisories/new)，普通缺陷使用 Issues。公开 Issue／PR 不包含敏感配置或设备输出。

GitHub 的规则和权限能力见[规则集说明](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets)、[Fork 工作流审批](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)及[组织 2FA](https://docs.github.com/en/organizations/keeping-your-organization-secure/managing-two-factor-authentication-for-your-organization/requiring-two-factor-authentication-in-your-organization)。实际启用情况应由维护者读取仓库设置核对。

## English quick start

Use your own GitHub account, preferably protected with a passkey or 2FA. Fork the repository, create a topic branch, develop with synthetic isolated data and open a pull request to `main`. No shared password or repository write permission is needed to propose a change.

Maintainers approve external-fork CI execution after inspecting the diff. Protected maintenance branches require review, resolved discussions and the required GitHub Actions checks; new commits dismiss stale approvals. Branch deletion and force pushes are blocked. Repository administrators have a documented PR-only exception to review/check requirements for maintenance; this does not allow a direct push or bypass the separate branch-integrity rules.

Direct collaborators are invited only by explicit GitHub username and permission. Repository visibility does not grant write access. Organization-wide mandatory 2FA/SSO is not claimed for this personal repository. See [CONTRIBUTING.md](../CONTRIBUTING.md) and [DEVELOPMENT.md](DEVELOPMENT.md) for implementation and test expectations. GitHub identity is separate from the application's vault, saved device credentials and MCP authorization.
