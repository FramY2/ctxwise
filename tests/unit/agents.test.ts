import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  auditMultiAgentSurface,
  compressMarkdownGuidance,
  renderMultiAgentReport,
  syncAgentGuidance,
} from "../../src/agents.js";
import { withTempDir } from "../support/temp.js";

describe("Multi-Agent Audit, Token Diet Compressor, and Sync", () => {
  it("compresses markdown guidance while preserving fenced code blocks", () => {
    const bloated = [
      "# Project Instructions",
      "<!-- This comment wastes startup tokens on every turn -->",
      "",
      "",
      "",
      "- Always run the full unit test suite before committing changes.",
      "- Always run the full unit test suite before committing changes.",
      "",
      "```ts",
      "// Comment inside code block stays untouched",
      "const x = 1;",
      "```",
    ].join("\n");

    const result = compressMarkdownGuidance(bloated);
    expect(result.savedTokens).toBeGreaterThan(10);
    expect(result.content).toContain(
      "// Comment inside code block stays untouched",
    );
    expect(result.content).not.toContain("wastes startup tokens");
  });

  it("audits Claude Code, OpenAI Codex, and Cursor surfaces and synchronizes them", async () => {
    await withTempDir("ctxwise-agents-", async (root) => {
      await mkdir(join(root, ".claude", "commands"), { recursive: true });
      await writeFile(
        join(root, "AGENTS.md"),
        [
          "# Engineering Rules",
          "<!-- draft comment -->",
          "- Keep functions pure and small across all modules.",
          "- Keep functions pure and small across all modules.",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        join(root, ".claude", "commands", "review.md"),
        "Review current diff carefully.\n",
        "utf8",
      );

      const initialReport = await auditMultiAgentSurface({
        projectRoot: root,
      });
      expect(initialReport.parityStatus).toBe("single-agent");
      expect(initialReport.agents.codex.files).toBe(1);
      expect(initialReport.agents.claude.files).toBe(1);
      expect(renderMultiAgentReport(initialReport)).toContain(
        "CtxWise multi-agent",
      );

      const syncResult = await syncAgentGuidance({
        projectRoot: root,
        from: "agents",
        targets: ["claude", "codex", "cursor"],
        compress: true,
      });

      expect(syncResult.writtenTargets).toHaveLength(3);
      const claudeContent = await readFile(join(root, "CLAUDE.md"), "utf8");
      const cursorContent = await readFile(
        join(root, ".cursor", "rules", "ctxwise.mdc"),
        "utf8",
      );
      expect(claudeContent).toContain("# Engineering Rules");
      expect(claudeContent).not.toContain("draft comment");
      expect(cursorContent).toContain("alwaysApply: true");

      const syncedReport = await auditMultiAgentSurface({
        projectRoot: root,
      });
      expect(syncedReport.parityStatus).toBe("synced");

      // Diverge CLAUDE.md and sync back from claude in dryRun mode
      await writeFile(
        join(root, "CLAUDE.md"),
        "# Diverged Claude Rules\n- Different rule here.\n",
        "utf8",
      );
      await writeFile(
        join(root, ".cursorrules"),
        "Cursor legacy rule\n",
        "utf8",
      );
      const divergedReport = await auditMultiAgentSurface({
        projectRoot: root,
        claudeHome: root,
        codexHome: root,
      });
      expect(divergedReport.parityStatus).toBe("diverged");

      const drySync = await syncAgentGuidance({
        projectRoot: root,
        from: "claude",
        dryRun: true,
      });
      expect(drySync.dryRun).toBe(true);

      const autoSync = await syncAgentGuidance({
        projectRoot: root,
        from: "auto",
      });
      expect(autoSync.sourcePath).toBe("AGENTS.md");
    });
  });

  it("handles empty projects and missing source files cleanly", async () => {
    await withTempDir("ctxwise-agents-empty-", async (root) => {
      const emptyReport = await auditMultiAgentSurface({ projectRoot: root });
      expect(emptyReport.parityStatus).toBe("missing");

      await expect(syncAgentGuidance({ projectRoot: root })).rejects.toThrow(
        /Neither AGENTS.md nor CLAUDE.md/,
      );

      await expect(
        syncAgentGuidance({ projectRoot: root, from: "claude" }),
      ).rejects.toThrow(/CLAUDE.md does not exist/);

      await expect(
        syncAgentGuidance({ projectRoot: root, from: "agents" }),
      ).rejects.toThrow(/AGENTS.md does not exist/);
    });
  });

  it("audits Claude settings.json hygiene, auto-memory files, and companion GEMINI.md / copilot-instructions.md", async () => {
    await withTempDir("ctxwise-agents-hygiene-", async (root) => {
      const projectDir = join(root, "my-app");
      const claudeHomeDir = join(root, "claude-home");
      await mkdir(join(projectDir, ".claude"), { recursive: true });
      await mkdir(join(projectDir, ".github"), { recursive: true });
      await mkdir(
        join(claudeHomeDir, "projects", "-workspace-my-app", "memory"),
        { recursive: true },
      );

      await writeFile(
        join(projectDir, ".claude", "settings.json"),
        JSON.stringify({
          mcpServers: { misplaced: { command: "npx", args: ["bad"] } },
          disableClaudeAiConnectors: true,
          deniedMcpServers: ["github", { serverName: "slack" }],
        }),
        "utf8",
      );
      await writeFile(
        join(claudeHomeDir, "settings.json"),
        JSON.stringify({
          mcpServers: { home_misplaced: { command: "node" } },
        }),
        "utf8",
      );
      await writeFile(
        join(
          claudeHomeDir,
          "projects",
          "-workspace-my-app",
          "memory",
          "MEMORY.md",
        ),
        "# Learned Project Memory\n- Use strict TypeScript.\n",
        "utf8",
      );
      await writeFile(
        join(projectDir, "GEMINI.md"),
        "# Gemini Guidance\n- Prefer pure functions.\n",
        "utf8",
      );
      await writeFile(
        join(projectDir, ".github", "copilot-instructions.md"),
        "# Copilot Instructions\n- Keep PRs small.\n",
        "utf8",
      );

      const report = await auditMultiAgentSurface({
        projectRoot: projectDir,
        claudeHome: claudeHomeDir,
      });

      expect(report.claudeHygiene.disableClaudeAiConnectors).toBe(true);
      expect(report.claudeHygiene.deniedMcpServers).toEqual([
        "github",
        "slack",
      ]);
      expect(report.claudeHygiene.misplacedMcpServersPaths).toEqual([
        "project/.claude/settings.json",
        "claude-home/settings.json",
      ]);
      expect(report.claudeHygiene.autoMemoryFiles).toEqual([
        "claude-home/projects/-workspace-my-app/memory/MEMORY.md",
      ]);
      expect(
        report.agents.claude.sources.some(
          (s) => s.kind === "memory" && s.path.endsWith("MEMORY.md"),
        ),
      ).toBe(true);
      expect(report.companionSources.map((s) => s.path)).toEqual([
        "project/GEMINI.md",
        "project/.github/copilot-instructions.md",
      ]);
      expect(
        report.recommendations.some((r) => r.includes('"mcpServers" found in')),
      ).toBe(true);

      const rendered = renderMultiAgentReport(report);
      expect(rendered).toContain(
        "Claude hygiene · disableClaudeAiConnectors: true",
      );
      expect(rendered).toContain("COMPANION active context files:");
      expect(rendered).toContain("project/GEMINI.md");
      expect(rendered).toContain("project/.github/copilot-instructions.md");

      // Disambiguate when two projects share the same folder basename (clientA/app vs clientB/app)
      const clientAApp = join(root, "clientA", "app");
      const clientBApp = join(root, "clientB", "app");
      await mkdir(clientAApp, { recursive: true });
      await mkdir(clientBApp, { recursive: true });
      await mkdir(
        join(claudeHomeDir, "projects", "-work-clientA-app", "memory"),
        { recursive: true },
      );
      await mkdir(
        join(claudeHomeDir, "projects", "-work-clientB-app", "memory"),
        { recursive: true },
      );
      await writeFile(
        join(
          claudeHomeDir,
          "projects",
          "-work-clientA-app",
          "memory",
          "MEMORY.md",
        ),
        "# Client A Memory\n",
        "utf8",
      );
      await writeFile(
        join(
          claudeHomeDir,
          "projects",
          "-work-clientB-app",
          "memory",
          "MEMORY.md",
        ),
        "# Client B Memory\n",
        "utf8",
      );

      const clientAReport = await auditMultiAgentSurface({
        projectRoot: clientAApp,
        claudeHome: claudeHomeDir,
      });
      expect(clientAReport.claudeHygiene.autoMemoryFiles).toEqual([
        "claude-home/projects/-work-clientA-app/memory/MEMORY.md",
      ]);

      // Verify disableAllHooks and PreToolUse MCP guard detection (#106225)
      await mkdir(join(clientAApp, ".claude"), { recursive: true });
      await writeFile(
        join(clientAApp, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: "^mcp__(?!github__|claude-code-remote__)",
                hooks: [{ type: "command", command: "exit 2" }],
              },
            ],
          },
        }),
        "utf8",
      );
      await writeFile(
        join(clientAApp, ".claude", "settings.local.json"),
        JSON.stringify({
          disableAllHooks: true,
        }),
        "utf8",
      );

      const hookBypassReport = await auditMultiAgentSurface({
        projectRoot: clientAApp,
      });
      expect(hookBypassReport.claudeHygiene.hasPreToolUseMcpGuard).toBe(true);
      expect(hookBypassReport.claudeHygiene.protectsClaudeSettingsInDeny).toBe(
        false,
      );
      expect(hookBypassReport.claudeHygiene.disableAllHooksPaths).toEqual([
        "project/.claude/settings.local.json",
      ]);
      expect(
        hookBypassReport.recommendations.some((r) =>
          r.includes('"disableAllHooks": true found in'),
        ),
      ).toBe(true);
      // Narrower rule (.claude/commands/**) must not satisfy protectsClaudeSettingsInDeny
      await writeFile(
        join(clientAApp, ".claude", "settings.local.json"),
        JSON.stringify({
          permissions: {
            deny: ["Edit(.claude/commands/**)", "Write(.claude/commands/**)"],
          },
        }),
        "utf8",
      );
      const narrowAgentReport = await auditMultiAgentSurface({
        projectRoot: clientAApp,
      });
      expect(narrowAgentReport.claudeHygiene.protectsClaudeSettingsInDeny).toBe(
        false,
      );

      // Split Edit/Write rules across settings.json and settings.local.json satisfy protectsClaudeSettingsInDeny
      await writeFile(
        join(clientAApp, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: "^mcp__(?!github__|claude-code-remote__)",
                hooks: [{ type: "command", command: "exit 2" }],
              },
            ],
          },
          permissions: {
            deny: ["Edit(.claude/**)"],
          },
        }),
        "utf8",
      );
      await writeFile(
        join(clientAApp, ".claude", "settings.local.json"),
        JSON.stringify({
          permissions: {
            deny: ["Write(.claude/**)"],
          },
        }),
        "utf8",
      );
      const splitHardenedReport = await auditMultiAgentSurface({
        projectRoot: clientAApp,
      });
      expect(
        splitHardenedReport.claudeHygiene.protectsClaudeSettingsInDeny,
      ).toBe(true);
    });
  });

  it('includes .claude/rules/**/*.md and attributes .cursor/mcp.json and .vscode/mcp.json ("servers") MCP configs', async () => {
    await withTempDir("ctxwise-agents-mcp-", async (root) => {
      await mkdir(join(root, ".claude", "rules", "frontend"), {
        recursive: true,
      });
      await mkdir(join(root, ".cursor"), { recursive: true });
      await mkdir(join(root, ".vscode"), { recursive: true });
      await mkdir(join(root, ".github"), { recursive: true });

      await writeFile(
        join(root, "CLAUDE.md"),
        "# Rules\n- Be terse.\n",
        "utf8",
      );
      await writeFile(
        join(root, ".claude", "rules", "testing.md"),
        "# Testing\n- Run vitest before pushing.\n",
        "utf8",
      );
      await writeFile(
        join(root, ".claude", "rules", "frontend", "react.md"),
        "---\npaths: src/**/*.tsx\n---\n# React\n- Prefer function components.\n",
        "utf8",
      );
      await writeFile(
        join(root, ".claude", "rules", "notes.txt"),
        "not a rule\n",
        "utf8",
      );
      await writeFile(
        join(root, ".mcp.json"),
        JSON.stringify({
          mcpServers: { github: { command: "npx", args: ["-y", "gh-mcp"] } },
        }),
        "utf8",
      );
      await writeFile(
        join(root, ".cursor", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            linear: { command: "npx", args: ["-y", "linear-mcp@1.0.0"] },
            off: { command: "node", args: ["x.js"], disabled: true },
          },
        }),
        "utf8",
      );
      await writeFile(
        join(root, ".vscode", "mcp.json"),
        [
          "{",
          '  // VS Code uses a top-level "servers" key',
          '  "servers": {',
          '    "fetch": { "type": "stdio", "command": "uvx", "args": ["mcp-server-fetch"] },',
          '    "docs": { "type": "http", "url": "https://example.com/mcp" },',
          "  },",
          "}",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        join(root, ".github", "copilot-instructions.md"),
        "# Copilot\n- Small PRs.\n",
        "utf8",
      );

      const report = await auditMultiAgentSurface({ projectRoot: root });

      const claudeRulePaths = report.agents.claude.sources
        .filter((s) => s.kind === "rule")
        .map((s) => s.path);
      expect(claudeRulePaths).toEqual([
        "project/.claude/rules/frontend/react.md",
        "project/.claude/rules/testing.md",
      ]);
      expect(report.agents.claude.files).toBe(4);
      const claudeMcp = report.agents.claude.sources.find(
        (s) => s.kind === "mcp-config",
      );
      expect(claudeMcp?.mcpServers).toEqual(["github"]);

      const cursorMcp = report.agents.cursor.sources.find(
        (s) => s.kind === "mcp-config",
      );
      expect(cursorMcp).toMatchObject({
        agent: "cursor",
        path: "project/.cursor/mcp.json",
        mcpServers: ["linear"],
      });

      const vscodeMcp = report.companionSources.find(
        (s) => s.path === "project/.vscode/mcp.json",
      );
      expect(vscodeMcp).toMatchObject({
        agent: "copilot",
        kind: "mcp-config",
        mcpServers: ["fetch", "docs"],
      });
      expect(
        report.companionSources.find((s) =>
          s.path.endsWith("copilot-instructions.md"),
        )?.agent,
      ).toBe("copilot");

      const rendered = renderMultiAgentReport(report);
      expect(rendered).toContain("project/.claude/rules/testing.md");
      expect(rendered).toContain(
        "project/.cursor/mcp.json (1 MCP server: linear)",
      );
      expect(rendered).toContain(
        "project/.vscode/mcp.json (2 MCP servers: fetch, docs)",
      );
    });
  });
});
