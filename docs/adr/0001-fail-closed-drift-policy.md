# ADR 0001: Fail-Closed Drift Policy and Multi-Agent Lockfile Protection

- **Status:** Accepted
- **Date:** 2026-11-14
- **Tracking:** FramY2/ctxwise#4

## Context

CtxWise v0.2 introduced `ctxwise lock` and `ctxwise drift` to hash Codex configuration and instruction chains into a redacted capability lockfile (`ctxwise.lock.json`) and fail CI on unreviewed changes (`--fail-on-drift`). As documented in [v0.2-drift.tdd.md](../testing/v0.2-drift.tdd.md), every drift event previously caused an undifferentiated failure; reviewed path allowlists and numeric thresholds remained an open roadmap item (Issue #4).

At the same time, multi-agent repositories rely heavily on non-Codex startup surfaces whose silent mutation poses security and reliability risks:

- **Claude Code settings (`.claude/settings.json`, `.claude/settings.local.json`)**: Claude Code hot-reloads settings mid-session (`anthropics/claude-code#106225`), so tampering with `disableAllHooks`, `hooks.PreToolUse`, or `permissions.deny` can silently neutralize guardrails.
- **Project MCP configurations (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`)**: Unreviewed edits can introduce unpinned package runners or remote endpoints, while credential headers and `env` blocks must never leak into committed lockfiles.
- **Multi-agent guidance and rules (`CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/**/*.md`, `.cursorrules`)**: Teams iterate on modular `.claude/rules/**/*.md` files more frequently than security-critical settings, so CI policies need granular path rules without loosening security invariants.

## Decision

### 1. Fail-closed drift policy (`src/drift-policy.ts`)

1. **Strict schema**: Drift policies use a versioned YAML schema (`version: 1`) validated with Zod `.strict()` at both the top level and rule level so unknown keys fail closed.
2. **Path-pattern safety**: Rule `paths` patterns must be relative POSIX paths. Backslashes (`\`), leading `/`, empty segments (`//` or trailing `/`), drive prefixes, null bytes, and `.` / `..` traversal segments are rejected at parse and evaluation time.
3. **Deterministic ReDoS-free globbing**: `matchDriftGlob` implements a segment-level dynamic programming matcher and two-pointer single-segment matcher for `*`, `**`, and `?` without compiling untrusted strings into regular expressions. Dotfiles (such as `.claude/settings.json`) are matched explicitly like any other path segment.
4. **Fail-closed default and deterministic precedence**:
   - Any drift change not matched by a rule evaluates to `unmatched` (`blocking: true`).
   - When multiple rules match a single change, precedence is strictly **`deny` > `warn` > `allow` > `unmatched`**, independent of rule order in YAML.
   - `deny` always blocks (`blocking: true`), even if numeric thresholds are satisfied.
   - `warn` produces a non-blocking warning (`blocking: false`).
   - `allow` permits the change (`blocking: false`) unless a numeric threshold is exceeded.
5. **Symmetric numeric thresholds**: Optional `maxAdded`, `maxRemoved`, `maxChanged`, and `maxBytesDelta` limits provide defense in depth. `maxBytesDelta` bounds `Math.abs(bytesDelta)` symmetrically so large sudden truncations of safety instructions or rules are blocked just like large context additions.
6. **Backward compatibility**: When `--policy` is omitted, `ctxwise drift` preserves exact v0.2 JSON output, text rendering, and `--fail-on-drift` semantics.

### 2. Multi-agent lockfile protection (`src/lockfile.ts`)

1. **Opt-in multi-agent surface (`includeMultiAgent?: boolean`)**: Defaults to `false` so existing Codex-only lockfiles (such as `examples/ci-baseline.lock.json`) and Codex-only workflows remain unchanged.
2. **Covered multi-agent surfaces**: When `includeMultiAgent` is `true` (or `--all-agents` is passed to `ctxwise lock` / `ctxwise drift`), `buildCapabilityLock` deterministically discovers and hashes:
   - JSON/JSONC configs: `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`
   - Markdown/text guidance and rules: `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/**/*.md`, `.cursorrules`
3. **Secret-safe JSON canonicalization (`sanitizeJsonConfigForHash`)**:
   - Keys matching secret/token/password/cookie/credential/Authorization patterns, all values inside `env` objects, and `Bearer`/`Basic`/inline credential literals are redacted to `"<redacted>"` before hashing.
   - Security-critical structures—`hooks`, `disableAllHooks`, `permissions`, and MCP server definitions (`command`, `args`, `url`, `type`, `disabled`, `enabled`)—are preserved in canonical sorted-key JSON so tampering immediately changes the SHA-256 hash while secret rotation does not cause false drift or secret leaks.
4. **Persistent baseline metadata**: `CapabilityLock.includeMultiAgent` is persisted when `true` so `ctxwise drift <baseline>` automatically includes multi-agent surfaces during live comparisons without requiring the caller to remember `--all-agents`.

## Consequences

- Teams can adopt `ctxwise lock --all-agents` + `ctxwise drift --policy ctxwise.drift.yaml --fail-on-drift` (locally or in `action.yml`) to allow reviewed `.claude/rules/**/*.md` updates while blocking unreviewed mutations to `.claude/settings.json`, `.mcp.json`, or `permissions.deny`.
- Existing Codex-only lockfiles and scripts require zero migration when neither `--all-agents` nor `--policy` is supplied.
- Any newly added agent surface not explicitly listed in the drift policy fails closed in CI until reviewed and added to the policy or baseline lockfile.
