# 中文编码与华为 USG / Chinese encoding and Huawei USG

本文说明源码中的增强能力；实际安装包包含哪些能力，以相应 Release 和安装版本为准。设备档案仍为候选适配，协议模拟不能替代真实型号、固件与业务验收。

## 中文终端与配置

在连接编辑窗口选择“终端文字编码”，保存后重新连接。默认 UTF-8；旧设备可选 GBK、GB18030 或 Big5。选择应与设备 CLI 一致，SSH 弱算法兼容是另一项独立设置。

- SSH、Telnet 窗口和 MCP 网络 CLI 使用同一份连接设置。SSH 的普通 exec／流式输出也使用所选解码器；stdout 和 stderr 分别保留未完成的字节序列。
- Telnet 的中文用户名、密码和中文登录提示符使用所选编码；SSH 认证、NETCONF／JSON-RPC、WinRM 和固定 UTF-8 的 Windows PowerShell 工具遵循各自协议。
- 不猜测编码，不自动改写乱码。设备输出包含无法解码的替换字符时，MCP 网络 CLI 拒绝将其当作完整配置；请修正编码再重连。
- 旧编码无法表示输入字符时拒绝发送，不以问号替换。网络计划在生成时检查全部命令，防止先执行一半才遇到无法编码的中文名称。
- 连接设置使用 `encoding:gbk`、`encoding:gb18030` 或 `encoding:big5` 标签，UTF-8 可省略；冲突／未知值会被拒绝。JSON 资料、解码后的加密备份及人工导出的 `.cfg` 统一使用 Unicode／UTF-8；不改变既有资料格式或密钥库身份。
- 接口描述和 VLAN 名可使用中文文字；换行、控制符、命令分隔符、引号及不可见方向控制符仍被拒绝。

GBK／Big5 的字符集合有限，GB18030 也必须与设备实际支持的编码匹配。UTF-8 分块问题修复不会恢复此前已经以乱码保存到设备上的内容。

## USG 查询、计划与写入

由人在连接窗口选择 Huawei USG 档案。首先调用 `network_get_capabilities`，再用 `network_get_state` 选择内建查询：版本、接口、路由、ARP、HA、CPU、内存、安全策略、NAT 策略、地址对象、IPsec SA。查询受命令权限、时限和输出限额约束；过大的状态结果报错，不静默截断。

`address_objects` 从完整配置提取地址对象／组、成员和描述，需读取配置权限，不返回 AAA 等无关配置。`network_backup_config` 保存经 OS 密钥库加密的完整配置，只返回制品 ID、摘要与大小。人工导出通过原生文件选择窗口完成。

配置必须由人勾选“允许受支持的网络配置变更”。此候选配置入口限定 **USG V500R005**、单虚拟系统、单机或主备模式的主机；备机、未知／异常 HA、双主模式及不匹配固件会在配置命令之前拒绝。每次应用重新查询版本和 HA，在命令之间还核对 HA 提示符；这不能提供设备侧的原子锁或阻止命令执行期间发生故障切换。

| 类型 | 支持范围 | 前置检查 |
|---|---|---|
| `usg_address_set` | 创建 IPv4 地址对象，1–16 个明确的 `/1`–`/32` 子网，可带中文描述 | 名称不重复、子网无主机位、不含重复成员 |
| `usg_security_rule` | 创建安全规则，指定源／目的域、源／目的地址对象，HTTP／HTTPS／DNS／SSH／ping，permit／deny | 两端均引用现有非空对象或本计划先创建的对象；禁止 Local 管理域 |
| `usg_nat_rule` | 创建 Easy-IP 或 No-NAT 规则，两端域及地址对象均明确 | 检查引用及 NAT 方言；已有旧 `action nat` 方言的 Easy-IP 另须明确现有出口接口 |

默认采用 V500R005 的 `source-nat` 方言；已有 NAT 配置明确使用旧 `nat` 方言时，沿用该证据并要求出口接口。混合方言拒绝生成计划。实际固件仍需先在实验设备验收。

计划示例使用文档测试网段；不是现网配置指令：

```json
{
  "serverName": "你已保存的 USG 连接名称",
  "changes": [
    { "kind": "usg_address_set", "target": "应用服务器", "addresses": ["198.51.100.8/32"], "description": "业务应用" },
    { "kind": "usg_security_rule", "target": "业务HTTPS", "sourceZone": "trust", "destinationZone": "untrust", "sourceAddressSet": "现有内网对象", "destinationAddressSet": "应用服务器", "service": "https", "action": "permit" },
    { "kind": "usg_nat_rule", "target": "业务NAT", "sourceZone": "trust", "destinationZone": "untrust", "sourceAddressSet": "现有内网对象", "destinationAddressSet": "应用服务器", "translation": "easy-ip" }
  ],
  "persist": false
}
```

将这些参数交给 `network_plan_change`。它只读配置、版本与 HA，返回 10 分钟有效、绑定会话／目标／基线的计划及精确命令。确认目标、对象、方向、服务、规则位置和保存意图后，再以返回的 `planId`／`planHash` 调用 `network_apply_change`；每次实际应用均需在客户端进行内容审批。应用前检查漂移、权限和已加密备份，执行后逐字段读回；只有读回匹配才尝试获准的保存。

新规则追加到设备顺序，可能被既有规则遮蔽。当前不提供规则覆盖、修改／删除、重排、地址池、DNAT、IPv6、虚拟系统或管理域修改。中文对象名限制为明确的文字／数字和名称分隔符，不能带空格或引号。单次最多 16 项变更，需按引用顺序先创建对象。

`network_verify_change` 只验证配置读回。规则命中、转发、NAT 映射和应用连通性须独立验收；不自动清会话、回滚或重试部分执行的计划。发生超时／错误时保留加密备份，核对设备状态后再决定下一项操作。

## English quick reference and evidence

Choose the saved connection's **Terminal text encoding**, then reconnect. UTF-8 is the default; GBK, GB18030 and Big5 are explicit selections shared by native SSH/Telnet terminals and MCP CLI. Streaming decoders preserve split characters and separate stdout/stderr. Unrepresentable input is refused; malformed network CLI text cannot become a configuration baseline. Protocol-native XML/JSON and Windows PowerShell tools retain their protocol encoding.

Select the Huawei USG profile for built-in diagnostics and encrypted backups. The configuration candidate targets **USG V500R005**, one virtual system, standalone or active/standby master. It creates address objects, narrowly matched security rules and Easy-IP/No-NAT rules through the existing plan → fresh content approval → encrypted backup → apply → readback workflow. Explicit references, collision checks, firmware/HA checks, baseline drift and plan lifetime are enforced. Existing rules are never implicitly replaced. Appended rules can be shadowed; readback does not prove traffic health. Unsupported firmware remains eligible for individually qualified read queries.

Implementation: `src/shared/terminalEncoding.ts`, `src/main/services/terminalCodec.ts`, `src/shared/huaweiUsg.ts`, `src/main/services/networkCli.ts` and `mcpServer.ts`. Regression fixtures: `tests/terminalEncoding.test.ts`, `tests/huaweiUsg*.test.ts`, `tests/nativeNetworkTerminal.integration.test.ts`, `tests/networkEditor.test.tsx` and the existing network/RPC suites. Fixtures bind to loopback and use synthetic credentials; they are not hardware certification.

Primary technical references, checked 2026-11-05:

- [iconv-lite supported encodings](https://github.com/pillarjs/iconv-lite/wiki/Supported-Encodings) and [preserving byte buffers](https://github.com/pillarjs/iconv-lite/wiki/Use-Buffers-when-decoding).
- [Huawei security policy queries and examples](https://info.support.huawei.com/network/ptmngsys/Web/tsrev_security/en/content/security/07_edesk_web_login_failed/edesk_web_login_failed_edesk003.html).
- [Huawei NAT policy and legacy Easy-IP/egress syntax](https://info.support.huawei.com/network/ptmngsys/Web/tsrev_security/en/content/security/22_edesk_users_access_internet_failed/edesk_users_access_internet_failed_edesk002.html).
- [Huawei No-NAT and address references](https://info.support.huawei.com/network/ptmngsys/Web/tsrev_security/en/content/security/16_edesk_internet_access_failed/edesk_internet_access_failed_edesk005.html).
- [Huawei HA role diagnostics](https://info.support.huawei.com/network/ptmngsys/Web/tsrev_security/en/content/security/36_edesk_hot_standby_change_and_state_abnormal_V5R1/edesk_hot_standby_change_and_state_abnormal004.html).
- [Fortinet vendor interoperability example for USG6000V2 V500R005](https://support.fortinet.com.cn/vpn/ipsec_vpn/ipsec_vendor/ipsec_huawei_usg): address-object member grammar and the newer `source-nat` dialect. This example informs the candidate; it does not qualify other hardware or firmware.
