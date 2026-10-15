# CtxWise v1.0.0 — Multi-Agent Context Firewall, MCP Tree-Shaker & Token Profiler

CtxWise `v1.0.0` expands from a single-agent Codex profiler into a **universal, local-first Multi-Agent Context Firewall, MCP Schema Tree-Shaker, and Token Budget Guard** for **Claude Code (`CLAUDE.md`)**, **OpenAI Codex (`AGENTS.md`)**, and **Cursor (`.cursor/rules`)**.

## Highlights

- **Multi-Agent Context Profiler (`ctxwise agents`)** — Audit active startup context token weight across **Claude Code** (`CLAUDE.md`, `CLAUDE.local.md`, `.claude/commands/*.md`, `.claude/skills/**/SKILL.md`, `.mcp.json`), **OpenAI Codex** (`AGENTS.md`, `AGENTS.override.md`, `.codex/skills`, `.agents/skills`), and **Cursor** (`.cursorrules`, `.cursor/rules/*.mdc`) in a single command, with automatic cross-agent parity detection (`synced`, `diverged`, `single-agent`).
- **Cross-Agent Sync & Token Diet (`ctxwise sync [--compress]`)** — Keep `AGENTS.md`, `CLAUDE.md`, and `.cursor/rules/ctxwise.mdc` synchronized from a single canonical source, with optional deterministic `--compress` mode that strips HTML comments, duplicate bullet directives, and excessive padding while preserving fenced code blocks intact.
- **MCP Schema X-Ray & Tree-Shaker (`ctxwise mcp-xray`)** — Inspect MCP server declarations across `.mcp.json`, `~/.claude.json`, and `.codex/config.toml`. Rank MCP tool schemas by estimated token footprint (via `--schema-file` or live local stdio probing `--probe-stdio`), flag `[BLOATED]` tools (`>= 250` tokens or `>= 12` input properties), and compute exact tree-shaking savings per turn.
- **Context Security & Prompt-Injection Firewall (`ctxwise shield`)** — Scan `CLAUDE.md`, `AGENTS.md`, `.mcp.json`, skills, and rules for hardcoded API keys (`sk-ant-*`, `sk-proj-*`, `ghp_*`, `AKIA*`, private keys), covert HTML comment instructions (`<!-- ... -->`), prompt-injection overrides, and hidden Trojan Source bidirectional/zero-width Unicode characters (`--fail-on-risk` for CI/pre-commit).
- **Curated Stack Budget Presets (`ctxwise preset`)** — Apply battle-tested context budgets and lean guidance templates in one command (`nextjs-typescript`, `python-fastapi`, `rust-cargo`, `go-microservice`, `mcp-server-dev`, `monorepo-turbo`).
- **Official GitHub Composite Action (`FramY2/ctxwise@v1`)** — Zero-config CI integration (`action.yml`) running `shield`, `agents`, and `budget` on every pull request.

## Quickstart

```bash
# Multi-agent startup surface across Claude Code, OpenAI Codex, and Cursor
npx --yes @framy2/ctxwise agents

# Sync AGENTS.md <-> CLAUDE.md <-> Cursor rules with deterministic Token Diet compression
npx --yes @framy2/ctxwise sync --compress

# Scan context files for leaked API keys, prompt injection, and hidden Unicode
npx --yes @framy2/ctxwise shield --fail-on-risk

# Inspect MCP server & tool schema token overhead
npx --yes @framy2/ctxwise mcp-xray --probe-stdio

# List or apply curated stack budget presets
npx --yes @framy2/ctxwise preset
```
