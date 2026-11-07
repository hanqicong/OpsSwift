# OpsSwift LTS

[简体中文](README.zh-CN.md) · English

**LYiTECH infrastructure operations workspace**, based on OpsMaxx (MIT). OpsSwift maintains the reviewed network and Windows management extensions as a separately named desktop product.

- English and Simplified Chinese throughout the interface, including connection dialogs and managed-release settings.
- LYiTECH orange branding, light/dark themes, SSH/SFTP, tunnels, databases and encrypted local credentials.
- 22 candidate network OS profiles; SSH and Telnet terminal windows; NETCONF, HTTPS JSON-RPC and Windows WinRM/SSH PowerShell through MCP.
- Modern SSH algorithms first, optional per-connection or global legacy compatibility, host-key verification and bounded negotiation fallback.
- Source enhancements: streaming UTF-8/GBK/GB18030/Big5 CLI and bounded Huawei USG diagnostics/object/policy/NAT workflows. See [encoding and USG support](docs/CHINESE-AND-USG.md) for firmware and release boundaries.
- 75 MCP tools, including 14 network/protocol extensions. Candidate profiles require device/model/firmware qualification; real writes retain approvals.

## Releases

Download from [OpsSwift releases](https://github.com/hanqicong/OpsSwift/releases). The initial qualified installer targets **macOS Apple Silicon**. Windows/Linux build recipes remain in source; those installers are not qualified by this release.

This is the **1.0.x LTS line**. Changes to this line prioritize compatibility, defect fixes and security fixes. Upstream releases are reviewed and merged into this repository, rebuilt and tested before distribution. Official OpsMaxx updates never automatically replace OpsSwift. See [maintenance and upgrade policy](docs/MAINTENANCE.md).

The macOS package currently uses a local ad-hoc hardened-runtime signature, **not Apple notarization**. Automated unattended installation is disabled. The update screen links to the managed OpsSwift release page.

## Build

Use the locked dependency tree and Node 24:

```sh
npm ci
npm run typecheck
npm test
npm run lint
npm run build
```

For macOS ARM64, build the four engines from their pinned sources using the upstream `scripts/build-*.sh` recipes, verify `resources/bin/manifest.json`, then run `python3 scripts/opsswift-package.py`. Runtime binaries and installers are release assets, not Git source. Include the corresponding OpenVPN source archive with releases that distribute OpenVPN.

## Existing OpsMaxx installations

OpsSwift installs as `OpsSwift.app`, bundle ID `com.lyitech.opsswift`, and uses a separate `OpsSwift` user-data directory. The managed migration backs up the complete original profile and app before copying the encrypted data. The legacy macOS Safe Storage identity and on-disk/wire identifiers are retained as a compatibility ABI; this avoids plaintext credential exports.

The 1.x MCP client registration retains the **`opsmaxx` compatibility key** so existing agent tool prefixes continue to work, while the server declares itself as **OpsSwift** and the launcher points to `OpsSwift.app`. Default port is 5177. Do not run both desktop gateways against that port. Personal profiles, tokens, vaults, device inventories and local audit records must never be committed or included in release assets.

## Attribution

Original project: [OpsMaxx/OpsMaxx](https://github.com/OpsMaxx/OpsMaxx), baseline `v0.60.2` / `40c8f17bc09ea979d24428475eb8ac94a0c0930c`. Original MIT notice is retained in [LICENSE](LICENSE). Original documentation remains under `docs/upstream/`; bundled components and their licenses are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). OpsSwift changes are maintained in this repository and do not imply endorsement by upstream authors.

## Developing OpsSwift

Use your own GitHub identity to contribute through forks and pull requests. Read the [collaboration and authentication guide](docs/COLLABORATION.md) for access, review and CI rules.

Start with the [developer guide](docs/DEVELOPMENT.md) and [repository instructions](AGENTS.md). The versioned [OpsSwift development skill](.agents/skills/opsswift-development/SKILL.md) supports feature work, protocol adapters, bilingual UI, compatibility checks and release maintenance. It preserves the scope of your request; production changes require their own authorization.
