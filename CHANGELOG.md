# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and semantic versioning.

## [Unreleased]

## [0.4.0] - 2026-08-26

### Added

- Added `ctxwise snapshot`, a one-command, local-only context health check that
  ranks known startup contributors, preserves unmeasured surfaces as unknown,
  and recommends safe next actions without changing Codex configuration.
- Added unit and process-level regression coverage for ranking, evidence labels,
  privacy-safe output, and the no-model-call workflow.

### Changed

- Updated the README and plugin starter prompt around immediate context
  visibility rather than asking new users to begin with a benchmark.
- Updated Vitest and its V8 coverage provider to 4.1.11.

## [0.3.2] - 2026-08-19

### Fixed

- CLI `--version`, app-server client metadata, and generated capability
  lockfiles now derive their version from the published `package.json` instead
  of duplicated constants that remained at 0.3.0 in v0.3.1.
- Added end-to-end and integration regression tests that fail whenever runtime
  version metadata drifts from the package version.

## [0.3.1] - 2026-08-19

### Fixed

- Regenerated the demo MP4, square cut, GIF, and poster from the CtxWise SVG
  sources so no stale CtxRay wordmark remains in current promotional assets.
- Added `CTXWISE_CODEX_BIN` as the preferred executable override while keeping
  `CTXRAY_CODEX_BIN` as a compatibility fallback.

### Changed

- Updated `smol-toml` to 1.8.0 and `tsx` to 4.23.12.
- Completed the public rebrand cleanup in current documentation, copyright,
  and release metadata.

## [0.3.0] - 2026-08-14

### Changed

- Renamed the product to **CtxWise** to leave the PyPI `ctxray` collision and
  keep the `ctx` prefix. Display name, CLI, npm package, plugin ID, skill,
  lockfile generator, and brand assets now use `ctxwise` /
  `@framy2/ctxwise`.
- New lockfiles write `generator.name: "ctxwise"`. Existing `ctxray`
  lockfiles still parse. The `ctxray` binary remains a compatibility alias
  for one release.
- GitHub links now point at `FramY2/ctxwise`. The repository has been renamed;
  do not recreate an empty `FramY2/ctxray` or the redirects will break.

## [0.2.3] - 2026-08-12

### Added

- `npm run benchmark:reproduce` for a fresh two-turn community ledger with an
  automatically generated ID and a printed full-matrix resume command.
- A bounded `share.md` report and deterministic `SHA256SUMS.txt` for community
  benchmark artifacts.
- TDD coverage for community planning, evidence labels, unsafe identifiers,
  bundled-ledger protection, and exact UTF-8 checksums.

### Fixed

- The documented preflight no longer reuses the committed v1 ledger and exits
  without performing a fresh reproduction.
- Bundled evidence IDs, traversal-like IDs, oversized IDs, ambiguous flags,
  and invalid turn limits now fail before Codex is invoked.

### Changed

- The first community run explicitly states that it may consume two Codex
  turns and never asserts that a locally generated report is independent.

## [0.2.2] - 2026-08-11

### Added

- Project-scope discovery that follows Codex root markers from the active
  working directory, including configured marker names.
- Regression coverage for nested guidance, configured fallback filenames,
  aggregate byte limits, global override fallback, and active lockfile scope.

### Fixed

- `audit`, `map`, and profile compilation now inventory the active guidance
  chain from the project root to the current working directory instead of
  treating the current directory as the root.
- Project guidance now honors `AGENTS.override.md`, configured fallback names,
  and `project_doc_max_bytes`, including truncation of the final active file.
- Empty global overrides now fall back to `AGENTS.md`, matching Codex.
- Capability locks include the active nested guidance chain and exclude
  unrelated sibling instructions.

## [0.2.1] - 2026-08-09

### Added

- A second 20-turn maintainer benchmark ledger with checksums, a conservative
  nine-pair report, and a transparent validator erratum.
- A regression test that keeps repository-backed benchmark fixtures aligned
  with current package metadata.

### Fixed

- Updated the benchmark's package-name fixture after the npm package became
  scoped as `@framy2/ctxray`.
- Replaced prompt-role aggregation through a plain object with a `Map`, so
  prototype-like role names remain ordinary data instead of mutating object
  behavior.

### Security

- Enabled GitHub CodeQL extended analysis for JavaScript/TypeScript with local
  and remote threat sources, fixed its actionable finding, and documented the
  CLI's local-operator trust boundary.

## [0.2.0] - 2026-08-09

### Added

- `ctxray drift` for deterministic, schema-validated comparison of redacted
  capability locks, with `--fail-on-drift` for CI.
- Reusable CtxRay mark, README hero, and GitHub social-preview artwork.
- A 20-second, 60 fps product demo with stationary scenes, brand-aligned
  diagonal transitions, a square social cut, and reproducible SVG sources.
- A measurable, evidence-first visibility plan and refreshed launch assets.

### Changed

- Reworked the README around the product problem, quick proof, and a shorter
  path from discovery to independent reproduction.

## [0.1.0] - 2026-08-09

### Added

- Resumable, quality-gated live benchmark harness and public machine-readable
  Luna/Terra/Sol results.
- A 48-second MP4/GIF evidence demo built from measured results (superseded by
  the shorter v0.2 product cut).
- Benchmark-result feedback issue form and launch kit.
- Public npm bootstrap package `@framy2/ctxray@0.1.0`; future releases use
  GitHub OIDC trusted publishing.

- Local Codex context, skill, plugin, agent, and MCP audit.
- Active-plugin filtering that excludes stale, backup, and uninstalled cache entries.
- Bounded local Mermaid context map.
- Privacy-safe prompt X-Ray.
- Opt-in pre-turn prompt estimate kept separate from aggregate usage.
- Strict YAML-to-native-Codex profile compiler with backups.
- Redacted capability lockfile.
- Exact `codex exec --json` usage parser.
- Subscription-safe credit/quota receipt and opt-in API equivalent.
- API-key price estimate using a dated official rate catalog.
- Local Codex app-server account/quota reader.
- Explicitly invoked Codex plugin and repository marketplace.
- Unit, integration, and process-level end-to-end test suite.
- GitHub issue/PR templates, CI matrix, Dependabot, and OIDC npm release gate.

### Fixed

- Windows now resolves the public npm Codex launcher before the protected
  desktop-app binary.
