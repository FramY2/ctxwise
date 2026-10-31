---
title: "How an 8MB MCP Tool Response Crashes Claude Code — And How to Put Your MCP Servers on a Diet"
published: true
description: "Why a single >= 8 MiB stdio MCP tool response kills the MCP server process in Claude Code (#105703), why MAX_MCP_OUTPUT_TOKENS can't save you, and how to fix both tool-schema bloat and oversized tool results with mcp-diet and CtxWise."
tags: claudecode, mcp, ai, opensource
canonical_url: https://framy2.github.io/ctxwise/
---

If you use **Claude Code**, **OpenAI Codex CLI**, or **Cursor** with Model Context Protocol (MCP) servers, your context window is being attacked from two directions:

1. **At session startup (`tools/list`):** Connecting just 3 common MCP servers (`github`, `postgres`, `playwright`) injects **60+ tool JSON schemas (~20,000+ tokens)** into every single turn — even when you only ask the agent to edit a local CSS file.
2. **At tool execution time (`tools/call`):** When a stdio MCP server returns a single payload of **~8 MiB (`8,388,608` bytes) or more**, Claude Code doesn't just reject the tool output — **it drops the stdio pipe (`Connection closed`) and kills the entire MCP server process** ([`anthropics/claude-code#105703`](https://github.com/anthropics/claude-code/issues/105703)).

Here is the exact wire-level breakdown of why both happen, why `MAX_MCP_OUTPUT_TOKENS` cannot save you from the 8 MiB crash, and how we solved both with three zero-telemetry open-source tools: **[`@framy2/mcp-diet`](https://github.com/FramY2/mcp-diet)**, **[`@framy2/ctxwise`](https://github.com/FramY2/ctxwise)**, and **[`@framy2/agent-wire-tap`](https://github.com/FramY2/agent-wire-tap)**.

---

## Part 1: Anatomy of the 8 MiB Stdio MCP Crash (`#105703`)

When a tool call returns a moderately large result (say, `100 KB` to `7.5 MB`), Claude Code handles it gracefully:

```text
Error: result (7,573,062 characters) exceeds maximum allowed tokens. Output has been saved to <file>
```

The MCP server stays alive, and the agent can inspect the saved file selectively with `Read` or `Grep`.

However, cross the **~8 MiB (`8,388,608` byte)** wire frame boundary and everything changes:

```text
<error>Connection closed</error>
```

The stdio child process terminates immediately. Every tool provided by that MCP server vanishes from your session (and from every running subagent sharing that server) until you manually run `/mcp` to reconnect.

### Why `MAX_MCP_OUTPUT_TOKENS` Doesn't Help

Many developers try lowering `MAX_MCP_OUTPUT_TOKENS` hoping to catch large outputs earlier. **It doesn't work.**

Why? Because the two limits live in completely different layers of the stack:

```text
[MCP Stdio Child Process]
       │
       │  Newline-delimited JSON-RPC frame over stdout pipe
       ▼
┌──────────────────────────────────────────────────────────┐
│ Layer 1: Stdio Transport Frame Reader (~8 MiB hard cap)  │ ◄── CRASH HAPPENS HERE
└──────────────────────────────────────────────────────────┘     Pipe closes before JSON.parse!
       │
       │  Parsed JSON-RPC result object
       ▼
┌──────────────────────────────────────────────────────────┐
│ Layer 2: Token Budget Check (MAX_MCP_OUTPUT_TOKENS)      │ ◄── Never reached for >= 8 MiB frames
└──────────────────────────────────────────────────────────┘
```

1. **Layer 1 (Transport Frame Assembly):** Newline-delimited JSON-RPC over stdio has no `Content-Length` header. The client's stream reader buffers bytes until `\n`. When a single frame exceeds ~8 MiB (which happens easily with Python `FastMCP`, because it serializes both `content[].text` and `structuredContent` into the same wire message), the transport reader aborts and closes the pipe.
2. **Layer 2 (Token Accounting):** `MAX_MCP_OUTPUT_TOKENS` only inspects a `tools/call` response _after_ the JSON-RPC frame has been completely received and parsed.

---

## Part 2: Putting a Runtime Firewall in Front of Stdio MCP Servers (`mcp-diet`)

What if you are using a third-party MCP server (or an internal FastMCP / database / log analysis server) that you don't want to fork just to add cursor pagination?

We built **[`FramY2/mcp-diet`](https://github.com/FramY2/mcp-diet)** (`@framy2/mcp-diet`) — a **zero-dependency Node.js stdio MCP proxy** that wraps any MCP server command in `.mcp.json`, `~/.claude.json`, or `.codex/config.toml`.

### What `mcp-diet` Does on the Wire

1. **Oversized `tools/call` Crash Guard (`--max-result-kb 512`):**
   `mcp-diet` reads the upstream MCP server's stdout without an 8 MiB pipe teardown. Whenever a `tools/call` response exceeds `--max-result-kb` (default `512` KiB), `mcp-diet`:
   - Writes the full raw JSON result to a local temp file (`mcp-diet-spill-<id>.json`).
   - Replaces the oversized wire payload with a compact `< 2 KB` `tools/call` response containing a preview and the spilled file path.
   - Keeps the MCP server connection alive and prevents 100k-token context window blowouts.

2. **Deterministic `tools/list` Tree-Shaking (`--read-only`, `--allow`, `--deny`, `--max-desc`):**
   - Filters out write/destructive tools (`--read-only` keeps only tools with `annotations.readOnlyHint === true` or safe `get_*`, `list_*`, `read_*`, `search_*` names).
   - Truncates verbose tool and property descriptions (`--max-desc 160`) without mutating JSON Schema types.
   - **Sorts tools deterministically by name** so your LLM prompt prefix cache never invalidates across turns.

3. **Live `tools/call` Secret Redaction (`--redact-secrets`):**
   - Automatically masks leaked Anthropic (`sk-ant-*`), OpenAI (`sk-proj-*`), GitHub (`ghp_*`), AWS (`AKIA*`), database URI passwords (`postgres://user:pass@...`), and private keys in tool outputs before they enter your model transcript.

### Drop-in `.mcp.json` Configuration

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": [
        "-y",
        "@framy2/mcp-diet",
        "--read-only",
        "--max-desc",
        "160",
        "--max-result-kb",
        "512",
        "--redact-secrets",
        "--",
        "npx",
        "-y",
        "@modelcontextprotocol/server-github"
      ]
    }
  }
}
```

---

## Part 3: Auditing & Locking Your Entire Agent Surface (`ctxwise` + `agent-wire-tap`)

Runtime proxying is half the battle. What about the static context files (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, `.claude/settings.json`) and CI verification?

### 1. Pre-Flight Context Audit & Secret Shield (`@framy2/ctxwise`)

Run **[`@framy2/ctxwise`](https://github.com/FramY2/ctxwise)** (`v1.1.0`) in any repository with `npx`:

```shell
# 1. Profile MCP tool schemas and find [BLOATED] tools
npx @framy2/ctxwise mcp-xray --probe-stdio

# 2. Check startup token tax & parity across Claude Code, OpenAI Codex (32 KiB limit), and Cursor
npx @framy2/ctxwise agents

# 3. Scan for leaked secrets, Trojan Unicode, and misplaced mcpServers in .claude/settings.json (#105885)
npx @framy2/ctxwise shield --fail-on-risk --sarif ctxwise.sarif
```

> **Bonus catch (`anthropics/claude-code#105885`):** Did you know that putting `"mcpServers"` inside `.claude/settings.json` instead of `.mcp.json` causes Claude Code's `update-config` skill to inject a 291 KB JSON schema twice in a validation retry loop (**+141,000 tokens in a single turn**)? `ctxwise shield` catches `claude-settings-misplaced-mcpservers` in `<20ms`.

### 2. Zero-Cost Wire Contract Testing in CI (`@framy2/agent-wire-tap`)

Want to prove in CI that your coding agent actually loads `AGENTS.md`, never leaks `sk-ant-`, and exposes `<= 12` MCP tools on the wire — **without spending a single cent on API tokens**?

Use **[`@framy2/agent-wire-tap`](https://github.com/FramY2/agent-wire-tap)**:

```shell
npx @framy2/agent-wire-tap \
  --assert-contains "AGENTS.md" \
  --assert-not-contains "sk-ant-" \
  --assert-max-bytes 32768 \
  --assert-max-tools 12 \
  -- codex exec "ping"
```

It spins up an ephemeral loopback server (`127.0.0.1:0`), intercepts the first outbound request from `codex` or `claude`, inspects the exact wire payload, returns a synthetic completion (`$0.00` cost), and fails CI if your context contract is violated.

---

## Try the Interactive Calculator & Star the Repos

You can test your own `.mcp.json` and `CLAUDE.md` / `AGENTS.md` right in your browser (100% client-side) using our live calculator:

👉 **[Interactive AI Context & MCP Token Tax Calculator (`https://framy2.github.io/ctxwise/`)](https://framy2.github.io/ctxwise/)**

And explore the open-source repositories on GitHub:

- 🛡️ **[`FramY2/ctxwise`](https://github.com/FramY2/ctxwise)** — AI Context Firewall, MCP Schema Tree-Shaker & Token Profiler (`Apache-2.0`)
- ⚡ **[`FramY2/mcp-diet`](https://github.com/FramY2/mcp-diet)** — Zero-Dependency Stdio MCP Proxy & 8 MiB Crash Guard (`MIT`)
- 🔌 **[`FramY2/agent-wire-tap`](https://github.com/FramY2/agent-wire-tap)** — Zero-Cost Local Loopback HTTP Wire Interceptor (`MIT`)
