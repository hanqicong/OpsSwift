# Contributing to OpsSwift LTS

Use your own GitHub account and submit a pull request from a fork or an authorized topic branch. Public read access does not grant repository write access. See [collaboration and authentication](docs/COLLABORATION.md) for the Chinese guide, protected branches, reviews and external-fork CI approval. Do not share passwords, personal access tokens or SSH private keys.

Use a task branch and a narrowly scoped pull request. Preserve the upstream MIT notice, third-party notices and the 1.x storage/wire compatibility ABIs documented in docs/MAINTENANCE.md.

Run `npm run typecheck`, relevant protocol/UI tests, `npm test`, `npm run lint` and `npm run build`. Document actual checks and environmental failures. Never include a personal data directory, credential, token, SSH private key, inventory or runtime log. Existing synthetic cryptographic fixtures are public test data and must never be used on real systems.

Keep English and Simplified Chinese keys and placeholders in sync. Verify dark/light contrast and keyboard interaction for changed UI. For release changes, review native encryption, migration, rollback and the actual signed package before publishing.
