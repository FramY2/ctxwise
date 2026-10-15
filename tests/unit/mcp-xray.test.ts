import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { describe, expect, it } from "vitest";

import {
  analyzeMcpToolsPayload,
  buildMcpXrayReport,
  discoverMcpDeclarations,
  probeStdioMcpServer,
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
});
