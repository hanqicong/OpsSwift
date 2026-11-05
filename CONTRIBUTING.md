# Contributing to OpsSwift LTS

Use a task branch and a narrowly scoped pull request. Preserve the upstream MIT notice, third-party notices and the 1.x storage/wire compatibility ABIs documented in docs/MAINTENANCE.md.

Run `npm run typecheck`, relevant protocol/UI tests, `npm test`, `npm run lint` and `npm run build`. Document actual checks and environmental failures. Never include a personal data directory, credential, token, SSH private key, inventory or runtime log. Existing synthetic cryptographic fixtures are public test data and must never be used on real systems.

Keep English and Simplified Chinese keys and placeholders in sync. Verify dark/light contrast and keyboard interaction for changed UI. For release changes, review native encryption, migration, rollback and the actual signed package before publishing.
