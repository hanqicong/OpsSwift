# Security and support

OpsSwift 1.0.x is the current maintained LTS line. Report vulnerabilities privately to the repository owner; do not include credentials, private host inventories or unredacted runtime logs in an issue.

SSH legacy compatibility is a human-selected policy. Modern algorithms are tried first, host keys are verified, and authentication/host-trust failures do not trigger algorithm fallback. Telnet is plaintext. Custom RPC, remote scripts and supported network configuration writes retain their approval controls.

The initial macOS package uses local ad-hoc signing and is not Apple notarized. Automatic replacement updates are disabled. Review release notes, SHA256SUMS and source before upgrading. Source CI and synthetic protocol tests do not qualify every device model, firmware or Windows host.

Workspace records are **filtered by workspace, not separated by it**. Workspace locks gate the UI; they are **not a cryptographic boundary** between administrators running this application as the same operating-system user. See [the inherited security design](docs/upstream/SECURITY.md) for the unchanged storage, vault, audit and process boundaries; the OpsSwift data directory replaces OpsMaxx in that design.
