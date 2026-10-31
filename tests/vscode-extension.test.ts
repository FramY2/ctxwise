import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeWorkspaceContext,
  computeContextGrade,
  countSecretsInContent,
  formatCompactTokens,
  formatStatusBarText,
  formatStatusBarTooltip,
  parseMcpServersFromJson,
  parseMcpServersFromToml,
} from "../editors/vscode/src/analyzer.js";

const tempDirs: string[] = [];

function makeTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ctxwise-vscode-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("ctxwise-vscode status-bar analyzer", () => {
  it("calculates tokens, Grade A, status bar pill, and rich Markdown tooltip on a clean workspace", () => {
    const ws = makeTempWorkspace();
    writeFileSync(
      join(ws, "CLAUDE.md"),
      "# Project Rules\n".repeat(25),
      "utf8",
    );
    writeFileSync(join(ws, "AGENTS.md"), "# Agent Rules\n".repeat(25), "utf8");
    writeFileSync(
      join(ws, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
          },
          disabledServer: {
            command: "node",
            args: ["server.js"],
            disabled: true,
          },
        },
      }),
      "utf8",
    );

    const summary = analyzeWorkspaceContext(ws);
    expect(summary.mcpServerCount).toBe(1);
    expect(summary.mcpServerNames).toEqual(["github"]);
    expect(summary.secretCount).toBe(0);
    expect(summary.grade).toBe("A");
    expect(summary.totalEstimatedTokens).toBe(summary.instructionTokens + 1200);

    const pill = formatStatusBarText(summary);
    expect(pill).toContain("$(shield) CtxWise:");
    expect(pill).toContain("Grade A");
    expect(pill).toContain("0 secrets");

    const tooltip = formatStatusBarTooltip(summary);
    expect(tooltip).toContain("CtxWise Context Firewall — Grade **A**");
    expect(tooltip).toContain("`github`");
    expect(tooltip).toContain("command:ctxwise.runFullAudit");
    expect(tooltip).toContain("command:ctxwise.scanSecrets");
    expect(tooltip).toContain("command:ctxwise.inspectMcpTax");
  });

  it("detects real leaked secrets while ignoring placeholders and downgrades to Grade F", () => {
    const ws = makeTempWorkspace();
    const fakeAnthropicKey = [
      "sk-ant-api03",
      "RealSecretTokenValue9988776655",
    ].join("-");
    writeFileSync(
      join(ws, "CLAUDE.md"),
      [
        "Example placeholder: sk-ant-api03-example_placeholder_key_000000",
        "Example URI: postgres://user:password@localhost:5432/db",
        `Live leaked key: ${fakeAnthropicKey}`,
        "Live DB URI: postgres://prod_admin:R9vK2mP8xQ4wL7nJ@db.internal:5432/app",
      ].join("\n"),
      "utf8",
    );

    const summary = analyzeWorkspaceContext(ws);
    expect(summary.secretCount).toBe(2);
    expect(summary.grade).toBe("F");

    const pill = formatStatusBarText(summary);
    expect(pill).toBe("$(warning) CtxWise: 64 tok · Grade F · 2 secrets");
  });

  it("flags Codex 32 KiB byte cap overflow and misplaced mcpServers in .claude/settings.json", () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "AGENTS.md"), "A".repeat(20_000), "utf8");
    writeFileSync(join(ws, "AGENTS.override.md"), "B".repeat(15_000), "utf8");
    mkdirSync(join(ws, ".claude"), { recursive: true });
    writeFileSync(
      join(ws, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { bad: { command: "node" } } }),
      "utf8",
    );

    const summary = analyzeWorkspaceContext(ws);
    expect(summary.codexInstructionBytes).toBe(35_000);
    expect(summary.codexByteCapPercent).toBeGreaterThan(100);
    expect(summary.misplacedMcpInSettings).toBe(true);
    expect(summary.grade).toBe("F");

    const tooltip = formatStatusBarTooltip(summary);
    expect(tooltip).toContain("Claude Settings Hygiene");
    expect(tooltip).toContain("#105885");
  });

  it("handles empty workspaces, TOML MCP servers, and malformed JSON gracefully", () => {
    const ws = makeTempWorkspace();
    const emptySummary = analyzeWorkspaceContext(ws);
    expect(emptySummary.files).toEqual([]);
    expect(emptySummary.grade).toBe("A");
    expect(formatStatusBarText(emptySummary)).toBe(
      "$(shield) CtxWise: 0 tok · Grade A · 0 secrets",
    );

    expect(parseMcpServersFromJson("{broken json")).toEqual([]);
    expect(
      parseMcpServersFromToml(`
[mcp_servers.postgres]
command = "npx"
[mcp_servers.playwright]
command = "npx"
`),
    ).toEqual(["postgres", "playwright"]);

    expect(formatCompactTokens(450)).toBe("450");
    expect(formatCompactTokens(2_400)).toBe("2.4k");
    expect(formatCompactTokens(12_000)).toBe("12k");
    expect(countSecretsInContent("clean text")).toBe(0);
    expect(
      computeContextGrade({
        totalEstimatedTokens: 4_500,
        codexByteCapPercent: 20,
        secretCount: 0,
        misplacedMcpInSettings: false,
      }),
    ).toBe("B");
    expect(
      computeContextGrade({
        totalEstimatedTokens: 9_500,
        codexByteCapPercent: 20,
        secretCount: 0,
        misplacedMcpInSettings: false,
      }),
    ).toBe("C");
    expect(
      computeContextGrade({
        totalEstimatedTokens: 1_500,
        codexByteCapPercent: 20,
        secretCount: 0,
        misplacedMcpInSettings: true,
      }),
    ).toBe("D");
  });
});
