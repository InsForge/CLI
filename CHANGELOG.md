# Changelog

All notable changes to `@insforge/cli` are documented here. This project
follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [0.1.94] - 2026-06-24

### Added

- **Billing management** — `billing upgrade <plan>` starts a Stripe checkout
  (opens the hosted URL in a browser) and `billing manage` opens the Stripe
  customer portal. Both print a JSON object with `--json` and skip the browser
  open, for headless/CI use.
- **Billing inspection** — `billing history` (past payments/invoices) and
  `billing cycles` (current and previous billing-cycle windows).
- **`projects transfer <targetOrgId>`** — move a project to another
  organization. Requires an explicit `--project` and is guarded for human
  approval, since billing and access move with it.

## [0.1.93] - 2026-06-23

### Added

- **Project lifecycle** — `projects get`, `update`, `restore`,
  `update-version` (updates to the latest InsForge version; `--wait` to block
  until done), `upgrade-instance <type>`, and `delete` (requires an explicit
  `--project`).
- **Billing & usage (read)** — `billing status`, `billing credits`, and
  `usage` (organization consumption for the current billing period).
- **Organizations & members** — `orgs create`/`update` and
  `orgs members list`/`invite`/`remove`/`role`.
- **Backups** — `backups list`/`latest`/`create` (`--wait`)/`rename`/
  `delete`/`restore`.
- **Secrets** — `secrets rotate <api-key|anon-key>` with an optional grace
  period.
- **Storage** — `storage s3-keys list`/`create`/`delete` for S3-compatible
  access keys.

### Changed

- The `orgs` and `projects` command groups are now shown in `--help`.

[0.1.94]: https://github.com/InsForge/CLI/releases/tag/v0.1.94
[0.1.93]: https://github.com/InsForge/CLI/releases/tag/v0.1.93
