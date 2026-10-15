# CtxWise

<p align="center">
  <img src="assets/brand/ctxwise-hero.svg" alt="CtxWise: The AI Context Firewall, MCP Schema Tree-Shaker & Token Profiler" width="100%" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@framy2/ctxwise"><img alt="npm version" src="https://img.shields.io/npm/v/%40framy2%2Fctxwise?color=7657FF" /></a>
  <a href="https://github.com/FramY2/ctxwise/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/FramY2/ctxwise/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="Agents: Claude Code | OpenAI Codex | Cursor" src="https://img.shields.io/badge/agents-Claude%20Code%20%7C%20Codex%20%7C%20Cursor-7657FF" />
  <img alt="Node.js 20 or newer" src="https://img.shields.io/badge/node-%3E%3D20-339933" />
  <img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-2DE2E6" />
  <img alt="PRs Welcome" src="https://img.shields.io/badge/PRs-welcome%20(Hacktoberfest)-brightgreen" />
</p>

<p align="center">
  <strong>Stop burning 30,000+ startup tokens on idle MCP schemas, diverging <code>CLAUDE.md</code> / <code>AGENTS.md</code> files, and hidden prompt leaks.</strong><br />
  The local-first AI Context Firewall, MCP Schema Tree-Shaker, and Token Profiler for <strong>Claude Code</strong>, <strong>OpenAI Codex</strong>, and <strong>Cursor</strong>.
</p>

<p align="center">
  <a href="#30-second-quickstart"><strong>Quickstart</strong></a> ·
  <a href="#github-action-ci-guard"><strong>GitHub Action</strong></a> ·
  <a href="#mcp-schema-tree-shaking"><strong>MCP X-Ray</strong></a> ·
  <a href="#context-security-shield"><strong>Security Shield</strong></a> ·
  <a href="#contribute-a-stack-preset-in-5-minutes"><strong>Contribute a Preset</strong></a> ·
  <a href="#live-evidence"><strong>Benchmarks (-73.3% prompt)</strong></a>
</p>

---

## Why Developers Install CtxWise

Modern coding agents (**Claude Code**, **OpenAI Codex CLI**, **Cursor**) silently load `CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, skill catalogs, and **MCP server tool schemas** on every single turn:

1. **Idle MCP Schema Bloat:** Connecting 4–5 MCP servers (GitHub, Postgres, Playwright, Notion) can burn **15,000–40,000 tokens before you type a single word**.
2. **Multi-Agent Drift:** Teams using both **Claude Code** (`CLAUDE.md`) and **OpenAI Codex** (`AGENTS.md`) end up with out-of-sync rules and duplicated boilerplate.
3. **Silent Secret & Prompt-Injection Leaks:** Hardcoded API keys (`sk-ant-...`, `sk-proj-...`, `ghp_...`) or covert HTML/Unicode instructions inside third-party skills get injected directly into model prompts.

**CtxWise fixes all three locally in milliseconds — with zero model calls, zero API keys, and zero telemetry.**

---

## 30-Second Quickstart

Run directly with `npx` in any repository where you use **Claude Code**, **OpenAI Codex**, or **Cursor**:

```shell
# 1. Audit startup tokens & parity across Claude Code (CLAUDE.md), Codex (AGENTS.md), and Cursor
npx @framy2/ctxwise agents

# 2. Scan context files & skills for leaked API keys, prompt injection, and hidden Unicode
npx @framy2/ctxwise shield --fail-on-risk

# 3. Profile MCP servers & find bloated tool schemas eating your context window
npx @framy2/ctxwise mcp-xray --probe-stdio

# 4. Sync CLAUDE.md <-> AGENTS.md <-> Cursor rules and apply lossless Token Diet compression
npx @framy2/ctxwise sync --compress --cursor
```

---

## Key Capabilities

### 1. Multi-Agent Context Audit & "Token Diet" Sync (`agents` & `sync`)

Keep **Claude Code** (`CLAUDE.md`, `.claude/skills`, `.claude/commands`, `.mcp.json`), **OpenAI Codex** (`AGENTS.md`, `.codex/skills`), and **Cursor** (`.cursor/rules/*.mdc`) 100% aligned while stripping markdown bloat (comments, duplicate bullet rules, blank padding) without touching code blocks:

```shell
npx @framy2/ctxwise agents
npx @framy2/ctxwise sync --compress --cursor
```

### 2. MCP Schema Tree-Shaking (`mcp-xray`)

Discover all MCP servers declared across `.mcp.json`, `~/.claude.json`, and `~/.codex/config.toml`. Measure exact token weights per tool schema (either from a saved `tools/list` JSON file or by probing local stdio servers live) and spot `[BLOATED]` tools:

```shell
npx @framy2/ctxwise mcp-xray --probe-stdio
```

```text
CtxWise mcp-xray · 3 MCP servers declared · 18 tool schemas analyzed · ~6,420 schema tokens (estimated)

Heaviest MCP tool schemas:
- ~890 tokens · github/create_or_update_pull_request (16 params, 3,560 chars) [BLOATED]
- ~640 tokens · postgres/execute_migration_plan (14 params, 2,560 chars) [BLOATED]

Tree-shaking potential: ~1,530 tokens/turn savable by pruning bloated tools.
```

### 3. Context Security Shield (`shield`)

Protect your repository before an agent reads your workspace or before a PR merges:

- **Secret Exposure Detection:** Catches hardcoded Anthropic (`sk-ant-...`), OpenAI (`sk-proj-...`), GitHub (`ghp_...`), AWS (`AKIA...`), and private key blocks inside `CLAUDE.md`, `AGENTS.md`, `.mcp.json`, and skills.
- **Prompt Injection & Trojan Unicode Guard:** Detects override directives (`ignore all previous instructions`), covert HTML comment payloads (`<!-- curl ... -->`), and hidden bidirectional/zero-width Unicode characters.

```shell
npx @framy2/ctxwise shield --fail-on-risk
```

### 4. Curated Stack Presets (`preset`)

Bootstrap a reviewable token budget (`ctxwise.budget.yaml`) and lean starter `AGENTS.md` + `CLAUDE.md` files tailored to your stack:

```shell
npx @framy2/ctxwise preset
npx @framy2/ctxwise preset nextjs-typescript --with-guidance
```

Built-in presets include:

- `nextjs-typescript` (Next.js + TypeScript + Tailwind)
- `python-fastapi` (Python 3.12 + FastAPI + Pydantic v2)
- `rust-cargo` (Rust + Cargo Workspace)
- `go-microservice` (Go 1.23+ Service)
- `mcp-server-dev` (Model Context Protocol Server)
- `monorepo-turbo` (Turborepo / pnpm Monorepo)

---

## GitHub Action (CI Guard)

Add **CtxWise** to `.github/workflows/ci.yml` in 5 lines to automatically block secret leaks, prompt injection, and context token bloat on every Pull Request:

```yaml
- name: AI Context Firewall & Token Budget Guard
  uses: FramY2/ctxwise@v1
  with:
    max-known-tokens: "4000"
    fail-on-secrets: "true"
    check-agent-parity: "true"
```

---

## See what Codex carries in one command (`snapshot` & `budget`)

![CtxWise snapshot showing ranked local Codex context contributors](assets/brand/ctxwise-snapshot.svg)

```shell
npx @framy2/ctxwise snapshot
npx @framy2/ctxwise budget --max-known-tokens 4000 --fail-on-exceed
```

[![CtxWise short product demo](benchmarks/demo/ctxwise-demo.gif)](benchmarks/demo/ctxwise-demo.mp4)

---

## Full CLI Reference

| Command            | What it does                                                                                   | Network / Model Call        |
| :----------------- | :--------------------------------------------------------------------------------------------- | :-------------------------- |
| `ctxwise agents`   | Audits startup tokens and parity across **Claude Code**, **OpenAI Codex**, and **Cursor**      | None                        |
| `ctxwise sync`     | Synchronizes `AGENTS.md` ↔ `CLAUDE.md` ↔ `.cursor/rules` with optional `--compress` Token Diet | None                        |
| `ctxwise mcp-xray` | Profiles MCP server tool-schema token weights and flags bloated tools for tree-shaking         | None (or local stdio probe) |
| `ctxwise shield`   | Scans agent context files & skills for leaked API keys, prompt injection, and hidden Unicode   | None                        |
| `ctxwise preset`   | Lists or applies curated stack budgets and `AGENTS.md` / `CLAUDE.md` templates                 | None                        |
| `ctxwise snapshot` | Ranks known Codex context contributors, coverage gaps, and safe next actions                   | None                        |
| `ctxwise budget`   | Checks estimated known context against CLI or YAML limits; exits `2` on violation in CI        | None                        |
| `ctxwise audit`    | Inventories config plus active root-to-CWD guidance, skills, plugins, agents, and MCPs         | None                        |
| `ctxwise map`      | Renders a bounded Mermaid map of context sources and discovery overhead                        | None                        |
| `ctxwise xray`     | Summarizes model-visible prompt JSON without echoing its text                                  | None                        |
| `ctxwise profile`  | Compiles YAML into native `~/.codex/<name>.config.toml`, with dry-run and backups              | None                        |
| `ctxwise lock`     | Hashes a redacted capability surface (`ctxwise.lock.json`) for reproducibility                 | None                        |
| `ctxwise drift`    | Compares a capability lock with a file or live setup; can fail CI on drift                     | None                        |
| `ctxwise quota`    | Reads the current plan and quota window through local Codex app-server                         | Codex account read only     |
| `ctxwise receipt`  | Calculates an honest receipt from saved `codex exec --json` usage                              | None                        |
| `ctxwise run`      | Runs Codex and appends exact usage plus an optional pre-turn prompt X-Ray                      | Requested Codex turn        |

---

## Contribute a Stack Preset in 5 Minutes

We welcome community contributions! Adding a new stack preset in [`presets/`](presets/) (e.g., `sveltekit`, `django`, `laravel`, `kotlin-spring`, `terraform-aws`, `flutter`) takes less than 5 minutes and is a great **Good First Issue / Hacktoberfest** PR:

1. Add `presets/<your-stack>.yaml` following [`CONTRIBUTING.md`](CONTRIBUTING.md).
2. Run `npm test` to validate your YAML schema automatically.
3. Open a Pull Request!

---

## Live Evidence

The public microbenchmark ran 10 paired tasks across requested GPT-5.6 Luna, Terra, and Sol profiles: **20/20 answers passed the same exact validator**. Removing irrelevant discovered context reduced the estimated model-visible prompt by **73.3%** and exact aggregate turn tokens by **29.1%** (with a second maintainer repeat measuring **28.5%** across nine comparable pairs).

Read the [method and limitations](benchmarks/results/2026-08-09-v1/report.md), inspect the [machine-readable summary](benchmarks/results/2026-08-09-v1/summary.json), or watch the [20-second MP4](benchmarks/demo/ctxwise-demo.mp4).

## Cost Honesty by Design

| Authentication                       | Default display                             | Dollar meaning                   |
| :----------------------------------- | :------------------------------------------ | :------------------------------- |
| OpenAI API key                       | Exact runtime tokens + dated API estimate   | Estimated billable API charge    |
| ChatGPT Plus/Pro/Business            | Tokens + credit equivalent + quota snapshot | No dollar amount                 |
| Subscription with `--api-equivalent` | Same data + API comparison                  | Comparison only; **not charged** |

See [Architecture](docs/architecture.md), [Cost semantics](docs/cost-semantics.md), and [Privacy and security](docs/privacy-security.md).

## Development

```shell
npm ci
npm run check
npm run build
npm run validate:plugin
npm pack --dry-run
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
