# OpsSwift LTS maintenance / 长期维护

The 1.0.x line owns its version numbers and release channel. The upstream tag and commit are recorded in UPSTREAM.json. This repository contains source and tests; personal runtime data is never part of its history.

## Change and release gates

1. Use a task branch, review the narrow change and its compatibility boundaries.
2. Run types, relevant real-protocol fixtures, English/Chinese placeholder parity, UI contrast and the full suite. Compare environmental failures against a separately recorded baseline; never describe a failing suite as all green.
3. Build from the dependency lock and pinned engine sources. Preserve upstream notices. Check the actual packaged backend, renderer, engine hashes and native encryption before release.
4. Back up application, encrypted profile and MCP registration. Stop the old gateway, migrate to the independent OpsSwift data directory, then switch the launcher. Never silently fall back to an empty profile on a decryption failure.
5. Verify saved connection counts, credential ciphertexts, vault, permissions and MCP scope; verify SSH/Telnet using an authorized read-only target. Archive redacted acceptance evidence outside the source repository.
6. Create an immutable version tag and attach installer, source archive, SHA256SUMS, release notes and corresponding OpenVPN sources. Do not overwrite released assets with different bytes under the same version.

## Upstream intake

Fetch upstream tags into a separate branch/checkout. Review upstream security and dependency changes, merge with this fork, resolve conflicts, then run the same gates. Do not install an unmodified upstream bundle over OpsSwift. No future version is prequalified by an earlier patch replay.

macOS Safe Storage identity `OpsMaxx`, legacy `opsmaxx-*` data filenames and the `opsmaxx` MCP registration key are deliberate 1.x compatibility ABIs, while display name, bundle ID, installation directory and data directory belong to OpsSwift. Changing any ABI requires a separately verified migration. A real Developer ID signature/notarization is needed before enabling unattended updates.

## Retention and recovery

- Git: source, dependency locks, build recipes, notices and redacted technical docs only.
- Releases: versioned recoverable installers, source archives and checksums; retain the current version and rollback releases, with no automatic deletion.
- CI: disposable artifacts expire after 14 days. They are not backups or evidence of device qualification.
- Local migration backups: owner-only directories; contain encrypted user data and remain outside Git. Keep until the operator accepts a later recovery point; never silently overwrite an earlier backup.
- Personal runtime logs/caches continue to use their existing bounded retention rules. Release/build caches are reproducible and excluded from version control.

A rollback restores the previous app, data-directory choice and client binding. Restoring an old data snapshot can discard later user changes; preserve the newer profile first. Future maintenance ends only when an explicit end-of-support notice or replacement line is published; this is a maintenance process, not a guarantee of a fixed service period.
