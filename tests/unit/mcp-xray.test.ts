import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { describe, expect, it } from "vitest";

import {
  analyzeMcpToolsPayload,
  buildMcpXrayReport,
  discoverMcpDeclarations,
  generateMcpDietWrapperSnippet,
  probeStdioMcpServer,
  pruneMcpServers,
  renderMcpPruneReport,
  renderMcpXrayReport,
  type McpServerDeclaration,
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
          "  if (msg.id === 1) {",
          '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } }) + "\\n");',
          "  }",
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

describe("generateMcpDietWrapperSnippet", () => {
  it("wraps stdio servers with default @framy2/mcp-diet@0.2.0 flags and skips HTTP/already-wrapped servers", () => {
    const declarations: McpServerDeclaration[] = [
      {
        name: "github",
        source: "project-mcp-json",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github@2025.4.8"],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" },
        cwd: "/repo/tools",
      },
      {
        name: "postgres",
        source: "codex-project",
        transport: "stdio",
        command: "uvx",
        args: ["mcp-server-postgres"],
      },
      {
        name: "remote_sse",
        source: "project-mcp-json",
        transport: "http",
        url: "https://mcp.example.com/sse",
      },
      {
        name: "already_npx_diet",
        source: "project-mcp-json",
        transport: "stdio",
        command: "npx",
        args: [
          "-y",
          "@framy2/mcp-diet@0.2.0",
          "--max-desc",
          "120",
          "--",
          "node",
          "srv.js",
        ],
      },
      {
        name: "already_bin_diet",
        source: "project-mcp-json",
        transport: "stdio",
        command: "C:\\tools\\mcp-diet.cmd",
        args: ["--read-only", "--", "python", "srv.py"],
      },
      {
        name: "already_node_diet",
        source: "project-mcp-json",
        transport: "stdio",
        command: "node",
        args: ["/opt/node_modules/@framy2/mcp-diet/dist/cli.js", "--", "cat"],
      },
    ];

    const snippet = generateMcpDietWrapperSnippet(declarations);
    expect(snippet.containerKey).toBe("mcpServers");
    expect(snippet.wrappedServers).toEqual(["github", "postgres"]);
    expect(snippet.skippedServers).toEqual([
      { name: "remote_sse", reason: "http" },
      { name: "already_npx_diet", reason: "already-wrapped" },
      { name: "already_bin_diet", reason: "already-wrapped" },
      { name: "already_node_diet", reason: "already-wrapped" },
    ]);

    expect(snippet.mcpServers.github).toEqual({
      command: "npx",
      args: [
        "-y",
        "@framy2/mcp-diet@0.2.0",
        "--max-desc",
        "160",
        "--max-result-kb",
        "512",
        "--redact-secrets",
        "--",
        "npx",
        "-y",
        "@modelcontextprotocol/server-github@2025.4.8",
      ],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" },
      cwd: "/repo/tools",
    });

    expect(snippet.mcpServers.postgres).toEqual({
      command: "npx",
      args: [
        "-y",
        "@framy2/mcp-diet@0.2.0",
        "--max-desc",
        "160",
        "--max-result-kb",
        "512",
        "--redact-secrets",
        "--",
        "uvx",
        "mcp-server-postgres",
      ],
    });

    const parsedJson = JSON.parse(snippet.json) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(parsedJson.mcpServers)).toEqual(["github", "postgres"]);
  });

  it("supports --read-only, custom thresholds, redactSecrets=false, VS Code servers container, and serverNames filtering", () => {
    const declarations: McpServerDeclaration[] = [
      {
        name: "docs",
        source: "vscode-mcp-json",
        transport: "stdio",
        command: "python",
        args: ["-m", "docs_mcp"],
      },
      {
        name: "docs",
        source: "codex-home",
        transport: "stdio",
        command: "python",
        args: ["-m", "docs_mcp_dup"],
      },
      {
        name: "other",
        source: "project-mcp-json",
        transport: "stdio",
        command: "node",
        args: ["other.js"],
      },
      {
        name: "broken_unknown",
        source: "project-mcp-json",
        transport: "unknown",
      },
      {
        name: "broken_missing_cmd",
        source: "project-mcp-json",
        transport: "stdio",
        command: "   ",
      },
      {
        name: "unrelated_flag",
        source: "project-mcp-json",
        transport: "stdio",
        command: "my-custom-server",
        args: ["--label", "mcp-diet"],
      },
    ];

    const snippet = generateMcpDietWrapperSnippet(declarations, {
      maxDescChars: 90,
      maxResultKb: 256,
      redactSecrets: false,
      readOnly: true,
      mcpDietPackage: "@framy2/mcp-diet@0.2.0",
      containerKey: "servers",
      serverNames: [
        "docs",
        "broken_unknown",
        "broken_missing_cmd",
        "unrelated_flag",
      ],
    });

    expect(snippet.containerKey).toBe("servers");
    expect(snippet.wrappedServers).toEqual(["docs", "unrelated_flag"]);
    expect(snippet.skippedServers).toEqual([
      { name: "docs", reason: "duplicate" },
      { name: "other", reason: "excluded" },
      { name: "broken_unknown", reason: "unknown-transport" },
      { name: "broken_missing_cmd", reason: "missing-command" },
    ]);

    expect(snippet.mcpServers.docs).toEqual({
      type: "stdio",
      command: "npx",
      args: [
        "-y",
        "@framy2/mcp-diet@0.2.0",
        "--max-desc",
        "90",
        "--max-result-kb",
        "256",
        "--read-only",
        "--",
        "python",
        "-m",
        "docs_mcp",
      ],
    });

    expect(snippet.mcpServers.unrelated_flag?.args).toEqual([
      "-y",
      "@framy2/mcp-diet@0.2.0",
      "--max-desc",
      "90",
      "--max-result-kb",
      "256",
      "--read-only",
      "--",
      "my-custom-server",
      "--label",
      "mcp-diet",
    ]);

    const parsed = JSON.parse(snippet.json) as {
      servers: Record<string, unknown>;
    };
    expect(Object.keys(parsed)).toEqual(["servers"]);
    expect(Object.keys(parsed.servers)).toEqual(["docs", "unrelated_flag"]);
  });

  it("handles servers whose inner args contain mcp-diet after -- and validates options", () => {
    const wrapped = generateMcpDietWrapperSnippet([
      {
        name: "echo_args",
        source: "project-mcp-json",
        transport: "stdio",
        command: "npx",
        args: ["-y", "echo-mcp@1.0.0", "--", "mcp-diet"],
      },
      {
        name: "quoted_diet",
        source: "project-mcp-json",
        transport: "stdio",
        command: '"mcp-diet"',
        args: ["--", "node", "x.js"],
      },
      {
        name: "bare_no_args",
        source: "project-mcp-json",
        transport: "stdio",
        command: "docker",
      },
    ]);

    expect(wrapped.wrappedServers).toEqual(["echo_args", "bare_no_args"]);
    expect(wrapped.skippedServers).toEqual([
      { name: "quoted_diet", reason: "already-wrapped" },
    ]);
    expect(wrapped.mcpServers.bare_no_args?.args.slice(-2)).toEqual([
      "--",
      "docker",
    ]);

    expect(() =>
      generateMcpDietWrapperSnippet([], { maxDescChars: 0 }),
    ).toThrow(/maxDescChars/);
    expect(() =>
      generateMcpDietWrapperSnippet([], { maxDescChars: 12.5 }),
    ).toThrow(/maxDescChars/);
    expect(() =>
      generateMcpDietWrapperSnippet([], { maxResultKb: -1 }),
    ).toThrow(/maxResultKb/);
    expect(() =>
      generateMcpDietWrapperSnippet([], { mcpDietPackage: "   " }),
    ).toThrow(/mcpDietPackage/);
  });
});
