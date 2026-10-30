import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { describe, expect, it } from "vitest";

import {
  analyzeMcpToolsPayload,
  buildMcpXrayReport,
  discoverMcpDeclarations,
  probeStdioMcpServer,
  pruneMcpServers,
  renderMcpPruneReport,
  renderMcpXrayReport,
} from "../../src/mcp-xray.js";
import { withTempDir } from "../support/temp.js";

describe("MCP Schema X-Ray and Tree-Shaker", () => {
  it("discovers MCP declarations across .mcp.json, .claude.json, and Codex config.toml", async () => {
    await withTempDir("ctxwise-mcp-xray-", async (root) => {
      const projectRoot = join(root, "project");
      const codexHome = join(root, "codex-home");
      const claudeHome = join(root, "claude-home");
      await mkdir(join(projectRoot, ".codex"), { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(claudeHome, { recursive: true });

      await writeFile(
        join(projectRoot, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            github: {
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-github"],
            },
            remoteApi: { url: "https://mcp.example.com/sse" },
          },
        }),
        "utf8",
      );

      await writeFile(
        join(projectRoot, ".codex", "config.toml"),
        [
          "[mcp_servers.postgres]",
          'command = "mcp-postgres"',
          'args = ["--readonly"]',
          "[mcp_servers.disabled_one]",
          "enabled = false",
          'command = "nope"',
        ].join("\n"),
        "utf8",
      );

      await writeFile(
        join(codexHome, "config.toml"),
        [
          "[mcp_servers.global_codex]",
          'url = "https://codex.example.com"',
        ].join("\n"),
        "utf8",
      );

      await writeFile(
        join(claudeHome, ".claude.json"),
        JSON.stringify({
          mcpServers: {
            claude_local: { command: "node", args: ["server.js"] },
          },
        }),
        "utf8",
      );

      const declarations = await discoverMcpDeclarations({
        projectRoot,
        codexHome,
        claudeHome,
      });

      const names = declarations.map((d) => d.name);
      expect(names).toEqual([
        "github",
        "remoteApi",
        "postgres",
        "global_codex",
        "claude_local",
      ]);
    });
  });

  it("analyzes MCP tool payloads, flags bloated schemas, and renders tree-shaking advice", () => {
    const payload = {
      servers: {
        heavyServer: {
          tools: [
            {
              name: "mega_tool",
              description: "A".repeat(900),
              inputSchema: {
                type: "object",
                properties: Object.fromEntries(
                  Array.from({ length: 15 }, (_, i) => [
                    `field_${i}`,
                    { type: "string", description: "param description text" },
                  ]),
                ),
              },
            },
            {
              name: "tiny_tool",
              description: "Fast ping",
              inputSchema: {
                type: "object",
                properties: { ping: { type: "boolean" } },
              },
            },
          ],
        },
      },
    };

    const tools = analyzeMcpToolsPayload(payload);
    expect(tools).toHaveLength(2);
    expect(tools[0]?.name).toBe("mega_tool");
    expect(tools[0]?.bloated).toBe(true);
    expect(tools[1]?.name).toBe("tiny_tool");
    expect(tools[1]?.bloated).toBe(false);

    const report = buildMcpXrayReport({
      declarations: [
        { name: "heavyServer", source: "project-mcp-json", transport: "stdio" },
      ],
      tools,
    });

    expect(report.bloatedTools).toHaveLength(1);
    expect(report.treeShakePotentialTokens).toBeGreaterThan(250);
    const rendered = renderMcpXrayReport(report);
    expect(rendered).toContain("[BLOATED]");
    expect(rendered).toContain("Tree-shaking potential");
  });

  it("probes a live stdio MCP server over JSON-RPC tools/list", async () => {
    await withTempDir("ctxwise-mcp-stdio-", async (root) => {
      const fakeServer = join(root, "fake-mcp-server.mjs");
      await writeFile(
        fakeServer,
        [
          'import readline from "node:readline";',
          "const rl = readline.createInterface({ input: process.stdin });",
          'rl.on("line", (line) => {',
          "  const msg = JSON.parse(line);",
          "  if (msg.id === 2) {",
          "    process.stdout.write(JSON.stringify({",
          '      jsonrpc: "2.0",',
          "      id: 2,",
          "      result: { tools: [{ name: 'probed_tool', description: 'Live tool', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }] }",
          '    }) + "\\n");',
          "    process.exit(0);",
          "  }",
          "});",
        ].join("\n"),
        "utf8",
      );

      const metrics = await probeStdioMcpServer({
        name: "live-test",
        source: "project-mcp-json",
        transport: "stdio",
        command: process.execPath,
        args: [fakeServer],
      });

      expect(metrics).toHaveLength(1);
      expect(metrics[0]?.name).toBe("probed_tool");
      expect(metrics[0]?.server).toBe("live-test");

      const skipped = await probeStdioMcpServer({
        name: "http-only",
        source: "project-mcp-json",
        transport: "http",
        url: "https://mcp.example.com",
      });
      expect(skipped).toEqual([]);
    });
  });

  it("supports flat array payloads and unmeasured declaration recommendations", () => {
    const flatMetrics = analyzeMcpToolsPayload([
      {
        name: "alpha",
        description: "Alpha tool",
        parameters: { type: "object", properties: { a: { type: "string" } } },
      },
    ]);
    expect(flatMetrics).toHaveLength(1);
    expect(flatMetrics[0]?.propertyCount).toBe(1);

    const emptyReport = buildMcpXrayReport({
      declarations: [
        { name: "unprobed", source: "codex-home", transport: "stdio" },
      ],
      tools: [],
    });
    expect(emptyReport.recommendations.join(" ")).toContain("--probe-stdio");
  });

  it("resolves .claude.json whether claudeHome points to ~ or ~/.claude", async () => {
    await withTempDir("ctxwise-mcp-claude-home-", async (root) => {
      const projectRoot = join(root, "project");
      const fakeUserHome = join(root, "user-home");
      const dotClaudeDir = join(fakeUserHome, ".claude");
      await mkdir(projectRoot, { recursive: true });
      await mkdir(dotClaudeDir, { recursive: true });

      await writeFile(
        join(fakeUserHome, ".claude.json"),
        JSON.stringify({
          mcpServers: {
            from_parent_home: { command: "npx", args: ["-y", "parent-mcp"] },
          },
        }),
        "utf8",
      );

      const fromDotClaude = await discoverMcpDeclarations({
        projectRoot,
        claudeHome: dotClaudeDir,
      });
      expect(fromDotClaude.map((d) => d.name)).toEqual(["from_parent_home"]);

      const fromUserHome = await discoverMcpDeclarations({
        projectRoot,
        claudeHome: fakeUserHome,
      });
      expect(fromUserHome.map((d) => d.name)).toEqual(["from_parent_home"]);
    });
  });

  it("prunes specified MCP servers in .mcp.json and .codex/config.toml with dry-run and .bak backups", async () => {
    await withTempDir("ctxwise-mcp-prune-", async (root) => {
      const projectRoot = join(root, "project");
      await mkdir(join(projectRoot, ".codex"), { recursive: true });

      const mcpJsonPath = join(projectRoot, ".mcp.json");
      const codexTomlPath = join(projectRoot, ".codex", "config.toml");

      await writeFile(
        mcpJsonPath,
        JSON.stringify(
          {
            mcpServers: {
              heavy_github: { command: "npx", args: ["-y", "github-mcp"] },
              keep_me: { command: "npx", args: ["-y", "keep-mcp"] },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      await writeFile(
        codexTomlPath,
        [
          "[mcp_servers.heavy_postgres]",
          'command = "mcp-postgres"',
          "[mcp_servers.keep_codex]",
          'command = "mcp-keep"',
        ].join("\n"),
        "utf8",
      );

      const inspectReport = await pruneMcpServers({ projectRoot });
      expect(inspectReport.mode).toBe("inspect");
      expect(inspectReport.candidateServers).toContain("heavy_github");
      expect(inspectReport.candidateServers).toContain("heavy_postgres");

      const dryRunReport = await pruneMcpServers({
        projectRoot,
        disableServers: ["heavy_github,heavy_postgres"],
        dryRun: true,
      });
      expect(dryRunReport.mode).toBe("prune");
      expect(dryRunReport.dryRun).toBe(true);
      expect(dryRunReport.disabledServers).toEqual([
        "heavy_github",
        "heavy_postgres",
      ]);
      expect(
        JSON.parse(await readFile(mcpJsonPath, "utf8")).mcpServers,
      ).toHaveProperty("heavy_github");

      const liveReport = await pruneMcpServers({
        projectRoot,
        disableServers: ["heavy_github", "heavy_postgres"],
        dryRun: false,
      });
      expect(liveReport.disabledServers).toEqual([
        "heavy_github",
        "heavy_postgres",
      ]);
      expect(liveReport.modifiedFiles).toHaveLength(2);
      expect(liveReport.modifiedFiles[0]?.backupPath).toBe(
        `${mcpJsonPath}.bak`,
      );
      expect(liveReport.modifiedFiles[1]?.backupPath).toBe(
        `${codexTomlPath}.bak`,
      );

      const updatedMcp = JSON.parse(await readFile(mcpJsonPath, "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(updatedMcp.mcpServers).not.toHaveProperty("heavy_github");
      expect(updatedMcp.mcpServers).toHaveProperty("keep_me");

      const updatedToml = await readFile(codexTomlPath, "utf8");
      expect(updatedToml).toContain(
        "[mcp_servers.heavy_postgres]\nenabled = false",
      );

      const rendered = renderMcpPruneReport(liveReport);
      expect(rendered).toContain("CtxWise mcp-prune · 2 servers disabled");

      const unknownReport = await pruneMcpServers({
        projectRoot,
        disableServers: ["nonexistent_server"],
      });
      expect(unknownReport.disabledServers).toEqual([]);
      expect(unknownReport.modifiedFiles).toEqual([]);
      expect(unknownReport.recommendations.join(" ")).toContain(
        "None of the requested servers",
      );
      expect(await readFile(codexTomlPath, "utf8")).not.toContain(
        "nonexistent_server",
      );
    });
  });

  it("quotes scoped TOML server names, handles commented headers, and suppresses codex-home servers overridden in project config", async () => {
    await withTempDir("ctxwise-mcp-prune-scoped-", async (root) => {
      const projectRoot = join(root, "project");
      const codexHome = join(root, "codex-home");
      await mkdir(join(projectRoot, ".codex"), { recursive: true });
      await mkdir(codexHome, { recursive: true });

      const codexTomlPath = join(projectRoot, ".codex", "config.toml");
      await writeFile(
        codexTomlPath,
        [
          "[mcp_servers.commented_srv] # production instance",
          'command = "mcp-commented"',
        ].join("\n"),
        "utf8",
      );

      await writeFile(
        join(codexHome, "config.toml"),
        [
          '[mcp_servers."@fainir/recall"]',
          'command = "npx"',
          'args = ["-y", "@fainir/recall"]',
        ].join("\n"),
        "utf8",
      );

      const pruneRes = await pruneMcpServers({
        projectRoot,
        codexHome,
        disableServers: ["@fainir/recall", "commented_srv"],
      });
      expect(pruneRes.disabledServers).toEqual([
        "@fainir/recall",
        "commented_srv",
      ]);

      const updatedToml = await readFile(codexTomlPath, "utf8");
      expect(updatedToml).toContain(
        '[mcp_servers."@fainir/recall"]\nenabled = false',
      );
      expect(updatedToml).toContain(
        "[mcp_servers.commented_srv] # production instance\nenabled = false",
      );

      const remaining = await discoverMcpDeclarations({
        projectRoot,
        codexHome,
      });
      expect(remaining).toEqual([]);
    });
  });
});
