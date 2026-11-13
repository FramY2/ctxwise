# CtxWise for VS Code & Cursor (`ctxwise-vscode`)

Live status-bar AI context profiler, **Codex 32 KiB** truncation monitor, **MCP schema token tax** estimator, and **Secret Shield** for **VS Code** and **Cursor**.

## ✨ Features

- **Live Status-Bar Pill:** Displays `$(shield) CtxWise: 2.4k tok · Grade A · 0 secrets` in your status bar and updates automatically whenever `CLAUDE.md`, `AGENTS.md`, `AGENTS.override.md`, `.cursorrules`, `.claude/rules/**/*.md`, `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.codex/config.toml`, or `.claude/settings.json` changes.
- **Multi-Editor MCP Coverage:** Counts active MCP servers from Claude Code (`.mcp.json`), Cursor (`.cursor/mcp.json`), and VS Code / GitHub Copilot (`.vscode/mcp.json`, JSONC with the `"servers"` key), skipping disabled entries.
- **Rich Markdown Tooltip:** Hover to inspect per-file token & byte breakdowns, your **Codex 32 KiB (`32,768` byte)** truncation budget, active MCP servers, and Claude settings hygiene warnings (`anthropics/claude-code#105885`).
- **One-Click Quick Commands:**
  - `CtxWise: Run Full Audit` (`npx @framy2/ctxwise agents`)
  - `CtxWise: Scan Secrets (Shield)` (`npx @framy2/ctxwise shield --fail-on-risk`)
  - `CtxWise: Inspect MCP Token Tax` (`npx @framy2/ctxwise mcp-xray --probe-stdio`)
  - `CtxWise: Refresh Context Status`

## 🛠️ Build & Test Locally

```shell
cd editors/vscode
npm run build
npm test
```
